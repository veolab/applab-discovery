mod mitm;

use std::collections::HashMap;
use std::convert::Infallible;
use std::env;
use std::io::Read;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use brotli::Decompressor;
use bytes::Bytes;
use chrono::Utc;
use flate2::read::{GzDecoder, ZlibDecoder};
use http::{Method, Request};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::upgrade;
use hyper_util::rt::TokioIo;
use reqwest::redirect::Policy;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncReadExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{watch, Mutex};
use tracing::{error, info};
use url::Url;
use uuid::Uuid;

use crate::mitm::{MitmEnvironment, MitmSetupState};

#[derive(Clone)]
struct AppState {
    auth_token: Arc<String>,
    client: reqwest::Client,
    sessions: Arc<Mutex<HashMap<String, Arc<ProxySession>>>>,
    mitm_env: Arc<Mutex<Option<Arc<MitmEnvironment>>>>,
    watchdog_max_duration_ms: u64,
}

struct ProxySession {
    session_id: String,
    runtime_session_id: String,
    advertise_host: String,
    bind_host: String,
    port: u16,
    started_at: String,
    entries: Mutex<Vec<TraceEntry>>,
    entry_count: AtomicUsize,
    active: AtomicBool,
    capture_mode: CaptureMode,
    mitm_env: Option<Arc<MitmEnvironment>>,
    mitm_setup: Option<MitmSetupState>,
    stop_tx: watch::Sender<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CaptureMode {
    ExternalProxy,
    ExternalMitm,
}

impl CaptureMode {
    fn from_request(value: Option<&str>) -> Self {
        match value.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
            "external-mitm" => Self::ExternalMitm,
            _ => Self::ExternalProxy,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::ExternalProxy => "external-proxy",
            Self::ExternalMitm => "external-mitm",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::ExternalProxy => "applab-external-proxy",
            Self::ExternalMitm => "applab-external-mitm",
        }
    }
}

impl ProxySession {
    fn capture_proxy_state(&self, active_override: Option<bool>) -> CaptureProxyState {
        let active = active_override.unwrap_or_else(|| self.active.load(Ordering::SeqCst));
        CaptureProxyState {
            id: self.runtime_session_id.clone(),
            session_id: self.session_id.clone(),
            active,
            bind_host: self.bind_host.clone(),
            host: self.advertise_host.clone(),
            port: Some(self.port),
            url: Some(format!("http://{}:{}", self.advertise_host, self.port)),
            started_at: Some(self.started_at.clone()),
            entry_count: self.entry_count.load(Ordering::SeqCst),
            capture_mode: self.capture_mode.as_str().to_string(),
            source: self.capture_mode.source().to_string(),
        }
    }

    fn next_entry_id(&self) -> String {
        let next = self.entry_count.fetch_add(1, Ordering::SeqCst) + 1;
        format!("{}-{:04}", self.runtime_session_id, next)
    }

    async fn push_entry(&self, entry: TraceEntry) {
        self.entries.lock().await.push(entry);
    }

    async fn trace_payload(&self) -> Option<TracePayload> {
        let entries = self.entries.lock().await.clone();
        if entries.is_empty() {
            return None;
        }

        Some(TracePayload {
            trace_kind: "http_trace".to_string(),
            label: self.capture_mode.source().to_string(),
            format: "json".to_string(),
            source: self.capture_mode.source().to_string(),
            payload: TracePayloadBody {
                session_id: self.session_id.clone(),
                proxy_id: self.runtime_session_id.clone(),
                generated_at: now_iso(),
                entries,
            },
            artifact_meta: TraceArtifactMeta {
                capture_mode: self.capture_mode.as_str().to_string(),
                proxy_id: self.runtime_session_id.clone(),
                entry_count: self.entry_count.load(Ordering::SeqCst),
            },
        })
    }

    fn stop(&self) {
        self.active.store(false, Ordering::SeqCst);
        let _ = self.stop_tx.send(true);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartSessionRequest {
    session_id: String,
    advertise_host: String,
    bind_host: String,
    capture_mode: Option<String>,
    max_duration_ms: Option<u64>,
    max_body_capture_bytes: Option<usize>,
    meta: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct StopRequest {
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    ok: bool,
    service: String,
    version: String,
    api_version: String,
    platform: String,
    arch: String,
    active_sessions: usize,
    watchdog: WatchdogInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WatchdogInfo {
    enabled: bool,
    default_max_duration_ms: u64,
}

#[derive(Serialize)]
struct SessionsResponse {
    sessions: Vec<CaptureProxyState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartSessionResponse {
    session_id: String,
    runtime_session_id: String,
    capture_proxy: CaptureProxyState,
    mitm: Option<MitmSetupState>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DrainSessionResponse {
    session_id: String,
    capture_proxy: Option<CaptureProxyState>,
    trace: Option<TracePayload>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StopSessionResponse {
    session_id: String,
    stopped: bool,
    capture_proxy: Option<CaptureProxyState>,
}

#[derive(Serialize)]
struct PanicStopResponse {
    stopped: usize,
    sessions: Vec<PanicStopItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PanicStopItem {
    session_id: String,
    stopped: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct CaptureProxyState {
    id: String,
    session_id: String,
    active: bool,
    bind_host: String,
    host: String,
    port: Option<u16>,
    url: Option<String>,
    started_at: Option<String>,
    entry_count: usize,
    capture_mode: String,
    source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TracePayload {
    trace_kind: String,
    label: String,
    format: String,
    source: String,
    payload: TracePayloadBody,
    artifact_meta: TraceArtifactMeta,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TracePayloadBody {
    session_id: String,
    proxy_id: String,
    generated_at: String,
    entries: Vec<TraceEntry>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TraceArtifactMeta {
    capture_mode: String,
    proxy_id: String,
    entry_count: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TraceEntry {
    id: String,
    kind: String,
    resource_type: String,
    method: String,
    url: String,
    started_at: i64,
    session_id: String,
    proxy_id: String,
    status: Option<u16>,
    ok: Option<bool>,
    finished_at: Option<i64>,
    duration_ms: Option<i64>,
    request: Option<TraceRequestMeta>,
    response: Option<TraceResponseMeta>,
    failure_text: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TraceRequestMeta {
    url: String,
    method: String,
    headers: HashMap<String, Option<String>>,
    started_at: i64,
    body_preview: Option<String>,
    body_bytes: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TraceResponseMeta {
    status: Option<u16>,
    headers: Option<HashMap<String, Option<String>>>,
    duration_ms: Option<i64>,
    size: Option<usize>,
    content_type: Option<String>,
    body_preview: Option<String>,
    error: Option<String>,
}

#[tokio::main]
async fn main() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt().with_env_filter("info").init();

    let args = parse_args();
    let client = reqwest::Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .expect("failed to build reqwest client");
    let state = AppState {
        auth_token: Arc::new(args.token),
        client,
        sessions: Arc::new(Mutex::new(HashMap::new())),
        mitm_env: Arc::new(Mutex::new(None)),
        watchdog_max_duration_ms: 15 * 60 * 1000,
    };

    tokio::spawn(watch_parent_stdin(state.clone()));

    let app = Router::new()
        .route("/health", get(health))
        .route("/sessions", get(list_sessions))
        .route("/sessions/start", post(start_session))
        .route("/sessions/:id/drain", post(drain_session))
        .route("/sessions/:id/stop", post(stop_session))
        .route("/panic-stop", post(panic_stop))
        .with_state(state);

    let addr: SocketAddr = format!("{}:{}", args.host, args.port)
        .parse()
        .expect("invalid runtime bind address");
    let listener = TcpListener::bind(addr)
        .await
        .expect("failed to bind control listener");
    info!("esvp-host-runtime listening on {}", listener.local_addr().unwrap());
    axum::serve(listener, app).await.expect("control server failed");
}

async fn health(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    let sessions = state.sessions.lock().await;
    Json(HealthResponse {
        ok: true,
        service: "esvp-host-runtime".to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        api_version: "v1".to_string(),
        platform: env::consts::OS.to_string(),
        arch: env::consts::ARCH.to_string(),
        active_sessions: sessions.len(),
        watchdog: WatchdogInfo {
            enabled: true,
            default_max_duration_ms: state.watchdog_max_duration_ms,
        },
    })
    .into_response()
}

async fn list_sessions(State(state): State<AppState>, headers: HeaderMap) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    let sessions = state.sessions.lock().await;
    let items = sessions
        .values()
        .map(|session| session.capture_proxy_state(None))
        .collect::<Vec<_>>();
    Json(SessionsResponse { sessions: items }).into_response()
}

async fn start_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StartSessionRequest>,
) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    if payload.session_id.trim().is_empty() {
        return error_response(StatusCode::BAD_REQUEST, "sessionId is required");
    }

    if let Some(existing) = state.sessions.lock().await.get(&payload.session_id).cloned() {
        return Json(StartSessionResponse {
            session_id: existing.session_id.clone(),
            runtime_session_id: existing.runtime_session_id.clone(),
            capture_proxy: existing.capture_proxy_state(None),
            mitm: existing.mitm_setup.clone(),
        })
        .into_response();
    }

    let capture_mode = CaptureMode::from_request(payload.capture_mode.as_deref());
    let meta_platform = extract_meta_string(payload.meta.as_ref(), "platform");
    let meta_device_id = extract_meta_string(payload.meta.as_ref(), "deviceId");
    let (mitm_env, mitm_setup) = if capture_mode == CaptureMode::ExternalMitm {
        let mitm_env = match ensure_mitm_environment(&state).await {
            Ok(value) => value,
            Err(message) => return error_response(StatusCode::BAD_GATEWAY, message),
        };
        let mitm_setup = match mitm_env.prepare_device_for_session(meta_platform.as_deref(), meta_device_id.as_deref()) {
            Ok(value) => value,
            Err(message) => return error_response(StatusCode::BAD_REQUEST, message),
        };
        (Some(mitm_env), Some(mitm_setup))
    } else {
        (None, None)
    };

    let bind_addr = format!("{}:0", payload.bind_host);
    let listener = match TcpListener::bind(bind_addr).await {
        Ok(listener) => listener,
        Err(error) => return error_response(StatusCode::BAD_GATEWAY, format!("Failed to bind proxy listener: {error}")),
    };
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(error) => return error_response(StatusCode::BAD_GATEWAY, format!("Failed to read proxy listener port: {error}")),
    };

    let (stop_tx, stop_rx) = watch::channel(false);
    let session = Arc::new(ProxySession {
        session_id: payload.session_id.clone(),
        runtime_session_id: format!("runtime-{}", Uuid::new_v4()),
        advertise_host: payload.advertise_host.clone(),
        bind_host: payload.bind_host.clone(),
        port,
        started_at: now_iso(),
        entries: Mutex::new(Vec::new()),
        entry_count: AtomicUsize::new(0),
        active: AtomicBool::new(true),
        capture_mode,
        mitm_env,
        mitm_setup: mitm_setup.clone(),
        stop_tx,
    });

    state
        .sessions
        .lock()
        .await
        .insert(payload.session_id.clone(), session.clone());
    info!(
        session_id = %session.session_id,
        runtime_session_id = %session.runtime_session_id,
        port = session.port,
        "proxy session started"
    );

    tokio::spawn(run_proxy_listener(
        state.client.clone(),
        session.clone(),
        listener,
        stop_rx,
        payload.max_body_capture_bytes.unwrap_or(16_384),
        payload.meta.clone(),
    ));

    let max_duration_ms = payload
        .max_duration_ms
        .unwrap_or(state.watchdog_max_duration_ms)
        .max(30_000);
    tokio::spawn(schedule_session_timeout(
        state.clone(),
        payload.session_id.clone(),
        max_duration_ms,
    ));

    Json(StartSessionResponse {
        session_id: session.session_id.clone(),
        runtime_session_id: session.runtime_session_id.clone(),
        capture_proxy: session.capture_proxy_state(None),
        mitm: mitm_setup,
    })
    .into_response()
}

async fn drain_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(payload): Json<StopRequest>,
) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    match stop_session_internal(&state, &id, payload.reason.as_deref().unwrap_or("manual-stop"), true).await {
        Ok(response) => Json(response).into_response(),
        Err(message) => error_response(StatusCode::NOT_FOUND, message),
    }
}

async fn stop_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Json(payload): Json<StopRequest>,
) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    match stop_session_internal(&state, &id, payload.reason.as_deref().unwrap_or("manual-stop"), false).await {
        Ok(response) => Json(StopSessionResponse {
            session_id: response.session_id,
            stopped: true,
            capture_proxy: response.capture_proxy,
        })
        .into_response(),
        Err(message) => error_response(StatusCode::NOT_FOUND, message),
    }
}

async fn panic_stop(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<StopRequest>,
) -> Response {
    if let Err(response) = authorize(&state, &headers) {
        return response;
    }

    let reason = payload.reason.unwrap_or_else(|| "manual-emergency-stop".to_string());
    let session_ids = state
        .sessions
        .lock()
        .await
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    let mut items = Vec::new();
    for session_id in session_ids.iter() {
        let stopped = stop_session_internal(&state, session_id, &reason, false).await.is_ok();
        items.push(PanicStopItem {
            session_id: session_id.clone(),
            stopped,
        });
    }

    Json(PanicStopResponse {
        stopped: items.iter().filter(|item| item.stopped).count(),
        sessions: items,
    })
    .into_response()
}

async fn stop_session_internal(
    state: &AppState,
    session_id: &str,
    reason: &str,
    include_trace: bool,
) -> Result<DrainSessionResponse, String> {
    let session = state
        .sessions
        .lock()
        .await
        .remove(session_id)
        .ok_or_else(|| format!("Runtime session not found: {session_id}"))?;
    info!(
        session_id = %session.session_id,
        runtime_session_id = %session.runtime_session_id,
        reason = %reason,
        include_trace,
        "proxy session stopping"
    );
    session.stop();
    tokio::time::sleep(Duration::from_millis(150)).await;

    Ok(DrainSessionResponse {
        session_id: session.session_id.clone(),
        capture_proxy: Some(session.capture_proxy_state(Some(false))),
        trace: if include_trace {
            session.trace_payload().await
        } else {
            None
        },
    })
}

async fn schedule_session_timeout(state: AppState, session_id: String, duration_ms: u64) {
    tokio::time::sleep(Duration::from_millis(duration_ms)).await;
    let _ = stop_session_internal(&state, &session_id, "max-duration-timeout", false).await;
}

async fn watch_parent_stdin(state: AppState) {
    let mut stdin = tokio::io::stdin();
    let mut buffer = [0_u8; 1];
    loop {
        match stdin.read(&mut buffer).await {
            Ok(0) => {
                let session_ids = state
                    .sessions
                    .lock()
                    .await
                    .keys()
                    .cloned()
                    .collect::<Vec<_>>();
                for session_id in session_ids {
                    let _ = stop_session_internal(&state, &session_id, "parent-exit", false).await;
                }
                std::process::exit(0);
            }
            Ok(_) => {}
            Err(error) => {
                error!("stdin watchdog error: {}", error);
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

async fn run_proxy_listener(
    client: reqwest::Client,
    session: Arc<ProxySession>,
    listener: TcpListener,
    mut stop_rx: watch::Receiver<bool>,
    max_body_capture_bytes: usize,
    _meta: Option<serde_json::Value>,
) {
    loop {
        if *stop_rx.borrow() {
            break;
        }
        tokio::select! {
            changed = stop_rx.changed() => {
                if changed.is_err() || *stop_rx.borrow() {
                    break;
                }
            }
            accept_result = listener.accept() => {
                let (stream, _) = match accept_result {
                    Ok(value) => value,
                    Err(error) => {
                        error!("proxy accept error: {}", error);
                        continue;
                    }
                };
                let session_clone = session.clone();
                let client_clone = client.clone();
                tokio::spawn(async move {
                    let service = service_fn(move |request| {
                        handle_proxy_request(
                            session_clone.clone(),
                            client_clone.clone(),
                            request,
                            max_body_capture_bytes,
                        )
                    });
                    if let Err(error) = http1::Builder::new()
                        .keep_alive(false)
                        .serve_connection(TokioIo::new(stream), service)
                        .with_upgrades()
                        .await
                    {
                        error!("proxy connection error: {}", error);
                    }
                });
            }
        }
    }
}

async fn handle_proxy_request(
    session: Arc<ProxySession>,
    client: reqwest::Client,
    request: Request<Incoming>,
    max_body_capture_bytes: usize,
) -> Result<http::Response<Full<Bytes>>, Infallible> {
    let response = if request.method() == Method::CONNECT {
        if session.capture_mode == CaptureMode::ExternalMitm {
            handle_connect_mitm(session, client, request, max_body_capture_bytes).await
        } else {
            handle_connect(session, request).await
        }
    } else {
        handle_forward(session, client, request, max_body_capture_bytes).await
    };
    Ok(response)
}

async fn handle_connect_mitm(
    session: Arc<ProxySession>,
    client: reqwest::Client,
    request: Request<Incoming>,
    max_body_capture_bytes: usize,
) -> http::Response<Full<Bytes>> {
    let authority = request
        .uri()
        .authority()
        .map(|value| value.as_str().to_string())
        .or_else(|| {
            let raw = request.uri().to_string();
            if raw.contains(':') {
                Some(raw)
            } else {
                None
            }
        });
    let authority = match authority {
        Some(value) => value,
        None => return text_response(StatusCode::BAD_REQUEST, "CONNECT target authority is required"),
    };
    let (authority_host, authority_port) = match parse_authority_parts(&authority) {
        Ok(parts) => parts,
        Err(message) => return text_response(StatusCode::BAD_REQUEST, &message),
    };

    let started_at = now_ms();
    let request_headers = redact_headers(request.headers().iter().map(|(name, value)| (name.as_str(), value)));
    let session_clone = session.clone();
    let client_clone = client.clone();
    tokio::spawn(async move {
        let mut entry = TraceEntry {
            id: session_clone.next_entry_id(),
            kind: "connect".to_string(),
            resource_type: "connect_tunnel".to_string(),
            method: "CONNECT".to_string(),
            url: format!("https://{authority}"),
            started_at,
            session_id: session_clone.session_id.clone(),
            proxy_id: session_clone.runtime_session_id.clone(),
            status: Some(200),
            ok: Some(true),
            finished_at: None,
            duration_ms: None,
            request: Some(TraceRequestMeta {
                url: format!("https://{authority}"),
                method: "CONNECT".to_string(),
                headers: request_headers,
                started_at,
                body_preview: None,
                body_bytes: 0,
            }),
            response: Some(TraceResponseMeta {
                status: Some(200),
                headers: None,
                duration_ms: None,
                size: None,
                content_type: None,
                body_preview: None,
                error: None,
            }),
            failure_text: None,
        };

        match upgrade::on(request).await {
            Ok(upgraded) => {
                let mitm_env = match session_clone.mitm_env.clone() {
                    Some(value) => value,
                    None => {
                        mark_connect_failure(&mut entry, "MITM mode is missing the certificate environment");
                        let finished_at = now_ms();
                        entry.finished_at = Some(finished_at);
                        entry.duration_ms = Some(finished_at.saturating_sub(started_at));
                        session_clone.push_entry(entry).await;
                        return;
                    }
                };

                match mitm_env.tls_acceptor_for_host(&authority_host) {
                    Ok(acceptor) => match acceptor.accept(TokioIo::new(upgraded)).await {
                        Ok(tls_stream) => {
                            let authority_host_for_service = authority_host.clone();
                            let session_for_service = session_clone.clone();
                            let client_for_service = client_clone.clone();
                            let service = service_fn(move |inner_request| {
                                handle_intercepted_https_request(
                                    session_for_service.clone(),
                                    client_for_service.clone(),
                                    inner_request,
                                    max_body_capture_bytes,
                                    authority_host_for_service.clone(),
                                    authority_port,
                                )
                            });
                            if let Err(error) = http1::Builder::new()
                                .keep_alive(false)
                                .serve_connection(TokioIo::new(tls_stream), service)
                                .await
                            {
                                mark_connect_failure(&mut entry, error.to_string());
                            }
                        }
                        Err(error) => {
                            mark_connect_failure(&mut entry, error.to_string());
                        }
                    },
                    Err(error) => {
                        mark_connect_failure(&mut entry, error);
                    }
                }
            }
            Err(error) => {
                mark_connect_failure(&mut entry, error.to_string());
            }
        }

        let finished_at = now_ms();
        entry.finished_at = Some(finished_at);
        entry.duration_ms = Some(finished_at.saturating_sub(started_at));
        session_clone.push_entry(entry).await;
    });

    http::Response::builder()
        .status(StatusCode::OK)
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| text_response(StatusCode::OK, ""))
}

async fn handle_intercepted_https_request(
    session: Arc<ProxySession>,
    client: reqwest::Client,
    request: Request<Incoming>,
    max_body_capture_bytes: usize,
    authority_host: String,
    authority_port: u16,
) -> Result<http::Response<Full<Bytes>>, Infallible> {
    let started_at = now_ms();
    let (parts, body) = request.into_parts();
    let target_url = match derive_https_target_url(&parts, &authority_host, authority_port) {
        Ok(url) => url,
        Err(message) => return Ok(text_response(StatusCode::BAD_REQUEST, &message)),
    };
    let request_headers = redact_headers(parts.headers.iter().map(|(name, value)| (name.as_str(), value)));
    let request_content_type = header_to_string(parts.headers.get("content-type"));
    let request_content_encoding = header_to_string(parts.headers.get("content-encoding"));
    let body_bytes = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            return Ok(text_response(
                StatusCode::BAD_GATEWAY,
                &format!("failed to read intercepted request body: {error}"),
            ));
        }
    };

    let mut upstream = client.request(parts.method.clone(), target_url.clone());
    for (name, value) in parts.headers.iter() {
        if is_outbound_request_blocked(name.as_str()) {
            continue;
        }
        upstream = upstream.header(name, value);
    }
    if let Some(host) = target_url.host_str() {
        let host_header = match target_url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        upstream = upstream.header("host", host_header);
    }
    upstream = upstream.header("connection", "close");

    let request_preview = preview_from_http_body(
        &body_bytes,
        request_content_type.as_deref(),
        request_content_encoding.as_deref(),
        max_body_capture_bytes,
    );
    let request_body_bytes = body_bytes.len();
    let response_result = upstream.body(body_bytes.to_vec()).send().await;

    match response_result {
        Ok(response) => {
            let status = response.status();
            let upstream_headers = response.headers().clone();
            let response_headers = redact_response_headers(&upstream_headers);
            let content_type = upstream_headers
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            let content_encoding = header_to_string(upstream_headers.get("content-encoding"));
            let response_bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    return Ok(text_response(
                        StatusCode::BAD_GATEWAY,
                        &format!("failed to read intercepted response body: {error}"),
                    ));
                }
            };
            let finished_at = now_ms();
            let duration_ms = finished_at.saturating_sub(started_at);
            let status_u16 = status.as_u16();
            session
                .push_entry(TraceEntry {
                    id: session.next_entry_id(),
                    kind: "request".to_string(),
                    resource_type: "https_request".to_string(),
                    method: parts.method.as_str().to_uppercase(),
                    url: target_url.to_string(),
                    started_at,
                    session_id: session.session_id.clone(),
                    proxy_id: session.runtime_session_id.clone(),
                    status: Some(status_u16),
                    ok: Some(status_u16 < 400),
                    finished_at: Some(finished_at),
                    duration_ms: Some(duration_ms),
                    request: Some(TraceRequestMeta {
                        url: target_url.to_string(),
                        method: parts.method.as_str().to_uppercase(),
                        headers: request_headers,
                        started_at,
                        body_preview: request_preview,
                        body_bytes: request_body_bytes,
                    }),
                    response: Some(TraceResponseMeta {
                        status: Some(status_u16),
                        headers: Some(response_headers.clone()),
                        duration_ms: Some(duration_ms),
                        size: Some(response_bytes.len()),
                        content_type: content_type.clone(),
                        body_preview: preview_from_http_body(
                            &response_bytes,
                            content_type.as_deref(),
                            content_encoding.as_deref(),
                            max_body_capture_bytes,
                        ),
                        error: None,
                    }),
                    failure_text: None,
                })
                .await;

            let mut builder = http::Response::builder().status(status);
            for (name, value) in upstream_headers.iter() {
                if is_downstream_response_blocked(name.as_str()) {
                    continue;
                }
                builder = builder.header(name, value);
            }
            Ok(builder
                .body(Full::new(response_bytes))
                .unwrap_or_else(|_| text_response(StatusCode::BAD_GATEWAY, "failed to build MITM response")))
        }
        Err(error) => {
            let finished_at = now_ms();
            let duration_ms = finished_at.saturating_sub(started_at);
            session
                .push_entry(TraceEntry {
                    id: session.next_entry_id(),
                    kind: "request".to_string(),
                    resource_type: "https_request".to_string(),
                    method: parts.method.as_str().to_uppercase(),
                    url: target_url.to_string(),
                    started_at,
                    session_id: session.session_id.clone(),
                    proxy_id: session.runtime_session_id.clone(),
                    status: None,
                    ok: None,
                    finished_at: Some(finished_at),
                    duration_ms: Some(duration_ms),
                    request: Some(TraceRequestMeta {
                        url: target_url.to_string(),
                        method: parts.method.as_str().to_uppercase(),
                        headers: request_headers,
                        started_at,
                        body_preview: request_preview,
                        body_bytes: request_body_bytes,
                    }),
                    response: Some(TraceResponseMeta {
                        status: None,
                        headers: None,
                        duration_ms: Some(duration_ms),
                        size: None,
                        content_type: None,
                        body_preview: None,
                        error: Some(error.to_string()),
                    }),
                    failure_text: Some(error.to_string()),
                })
                .await;
            Ok(text_response(StatusCode::BAD_GATEWAY, &format!("MITM upstream error: {error}")))
        }
    }
}

async fn handle_forward(
    session: Arc<ProxySession>,
    client: reqwest::Client,
    request: Request<Incoming>,
    max_body_capture_bytes: usize,
) -> http::Response<Full<Bytes>> {
    let started_at = now_ms();
    let (parts, body) = request.into_parts();
    let target_url = match derive_target_url(&parts) {
        Ok(url) => url,
        Err(message) => {
            return text_response(StatusCode::BAD_REQUEST, &message);
        }
    };
    let request_headers = redact_headers(parts.headers.iter().map(|(name, value)| (name.as_str(), value)));
    let request_content_type = header_to_string(parts.headers.get("content-type"));
    let request_content_encoding = header_to_string(parts.headers.get("content-encoding"));
    let body_bytes = match body.collect().await {
        Ok(collected) => collected.to_bytes(),
        Err(error) => {
            return text_response(StatusCode::BAD_GATEWAY, &format!("failed to read proxy request body: {error}"));
        }
    };

    let mut upstream = client.request(parts.method.clone(), target_url.clone());
    for (name, value) in parts.headers.iter() {
        if is_outbound_request_blocked(name.as_str()) {
            continue;
        }
        upstream = upstream.header(name, value);
    }
    if let Some(host) = target_url.host_str() {
        let host_header = match target_url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host.to_string(),
        };
        upstream = upstream.header("host", host_header);
    }
    upstream = upstream.header("connection", "close");

    let request_preview = preview_from_http_body(
        &body_bytes,
        request_content_type.as_deref(),
        request_content_encoding.as_deref(),
        max_body_capture_bytes,
    );
    let request_body_bytes = body_bytes.len();
    let response_result = upstream.body(body_bytes.to_vec()).send().await;

    match response_result {
        Ok(response) => {
            let status = response.status();
            let upstream_headers = response.headers().clone();
            let response_headers = redact_response_headers(&upstream_headers);
            let content_type = upstream_headers
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .map(|value| value.to_string());
            let content_encoding = header_to_string(upstream_headers.get("content-encoding"));
            let response_bytes = match response.bytes().await {
                Ok(bytes) => bytes,
                Err(error) => {
                    return text_response(StatusCode::BAD_GATEWAY, &format!("failed to read proxy response body: {error}"));
                }
            };
            let finished_at = now_ms();
            let duration_ms = finished_at.saturating_sub(started_at);
            let status_u16 = status.as_u16();
            session
                .push_entry(TraceEntry {
                    id: session.next_entry_id(),
                    kind: "request".to_string(),
                    resource_type: if target_url.scheme() == "https" {
                        "https_request".to_string()
                    } else {
                        "http_request".to_string()
                    },
                    method: parts.method.as_str().to_uppercase(),
                    url: target_url.to_string(),
                    started_at,
                    session_id: session.session_id.clone(),
                    proxy_id: session.runtime_session_id.clone(),
                    status: Some(status_u16),
                    ok: Some(status_u16 < 400),
                    finished_at: Some(finished_at),
                    duration_ms: Some(duration_ms),
                    request: Some(TraceRequestMeta {
                        url: target_url.to_string(),
                        method: parts.method.as_str().to_uppercase(),
                        headers: request_headers,
                        started_at,
                        body_preview: request_preview,
                        body_bytes: request_body_bytes,
                    }),
                    response: Some(TraceResponseMeta {
                        status: Some(status_u16),
                        headers: Some(response_headers.clone()),
                        duration_ms: Some(duration_ms),
                        size: Some(response_bytes.len()),
                        content_type: content_type.clone(),
                        body_preview: preview_from_http_body(
                            &response_bytes,
                            content_type.as_deref(),
                            content_encoding.as_deref(),
                            max_body_capture_bytes,
                        ),
                        error: None,
                    }),
                    failure_text: None,
                })
                .await;

            let mut builder = http::Response::builder().status(status);
            for (name, value) in upstream_headers.iter() {
                if is_downstream_response_blocked(name.as_str()) {
                    continue;
                }
                builder = builder.header(name, value);
            }
            builder
                .body(Full::new(response_bytes))
                .unwrap_or_else(|_| text_response(StatusCode::BAD_GATEWAY, "failed to build proxy response"))
        }
        Err(error) => {
            let finished_at = now_ms();
            let duration_ms = finished_at.saturating_sub(started_at);
            session
                .push_entry(TraceEntry {
                    id: session.next_entry_id(),
                    kind: "request".to_string(),
                    resource_type: if target_url.scheme() == "https" {
                        "https_request".to_string()
                    } else {
                        "http_request".to_string()
                    },
                    method: parts.method.as_str().to_uppercase(),
                    url: target_url.to_string(),
                    started_at,
                    session_id: session.session_id.clone(),
                    proxy_id: session.runtime_session_id.clone(),
                    status: None,
                    ok: None,
                    finished_at: Some(finished_at),
                    duration_ms: Some(duration_ms),
                    request: Some(TraceRequestMeta {
                        url: target_url.to_string(),
                        method: parts.method.as_str().to_uppercase(),
                        headers: request_headers,
                        started_at,
                        body_preview: request_preview,
                        body_bytes: request_body_bytes,
                    }),
                    response: Some(TraceResponseMeta {
                        status: None,
                        headers: None,
                        duration_ms: Some(duration_ms),
                        size: None,
                        content_type: None,
                        body_preview: None,
                        error: Some(error.to_string()),
                    }),
                    failure_text: Some(error.to_string()),
                })
                .await;
            text_response(StatusCode::BAD_GATEWAY, &format!("proxy upstream error: {error}"))
        }
    }
}

async fn handle_connect(
    session: Arc<ProxySession>,
    request: Request<Incoming>,
) -> http::Response<Full<Bytes>> {
    let authority = request
        .uri()
        .authority()
        .map(|value| value.as_str().to_string())
        .or_else(|| {
            let raw = request.uri().to_string();
            if raw.contains(':') {
                Some(raw)
            } else {
                None
            }
        });
    let authority = match authority {
        Some(value) => value,
        None => return text_response(StatusCode::BAD_REQUEST, "CONNECT target authority is required"),
    };

    let started_at = now_ms();
    let request_headers = redact_headers(request.headers().iter().map(|(name, value)| (name.as_str(), value)));
    let session_clone = session.clone();
    tokio::spawn(async move {
        let mut entry = TraceEntry {
            id: session_clone.next_entry_id(),
            kind: "connect".to_string(),
            resource_type: "connect_tunnel".to_string(),
            method: "CONNECT".to_string(),
            url: format!("https://{authority}"),
            started_at,
            session_id: session_clone.session_id.clone(),
            proxy_id: session_clone.runtime_session_id.clone(),
            status: Some(200),
            ok: Some(true),
            finished_at: None,
            duration_ms: None,
            request: Some(TraceRequestMeta {
                url: format!("https://{authority}"),
                method: "CONNECT".to_string(),
                headers: request_headers,
                started_at,
                body_preview: None,
                body_bytes: 0,
            }),
            response: Some(TraceResponseMeta {
                status: Some(200),
                headers: None,
                duration_ms: None,
                size: None,
                content_type: None,
                body_preview: None,
                error: None,
            }),
            failure_text: None,
        };

        match upgrade::on(request).await {
            Ok(upgraded) => match TcpStream::connect(&authority).await {
                Ok(mut server_stream) => {
                    let mut upgraded = TokioIo::new(upgraded);
                    if let Err(error) = tokio::io::copy_bidirectional(&mut upgraded, &mut server_stream).await {
                        entry.failure_text = Some(error.to_string());
                        entry.response = Some(TraceResponseMeta {
                            status: Some(200),
                            headers: None,
                            duration_ms: None,
                            size: None,
                            content_type: None,
                            body_preview: None,
                            error: Some(error.to_string()),
                        });
                    }
                }
                Err(error) => {
                    entry.ok = Some(false);
                    entry.status = None;
                    entry.failure_text = Some(error.to_string());
                    entry.response = Some(TraceResponseMeta {
                        status: None,
                        headers: None,
                        duration_ms: None,
                        size: None,
                        content_type: None,
                        body_preview: None,
                        error: Some(error.to_string()),
                    });
                }
            },
            Err(error) => {
                entry.ok = Some(false);
                entry.status = None;
                entry.failure_text = Some(error.to_string());
                entry.response = Some(TraceResponseMeta {
                    status: None,
                    headers: None,
                    duration_ms: None,
                    size: None,
                    content_type: None,
                    body_preview: None,
                    error: Some(error.to_string()),
                });
            }
        }

        let finished_at = now_ms();
        entry.finished_at = Some(finished_at);
        entry.duration_ms = Some(finished_at.saturating_sub(started_at));
        session_clone.push_entry(entry).await;
    });

    http::Response::builder()
        .status(StatusCode::OK)
        .body(Full::new(Bytes::new()))
        .unwrap_or_else(|_| text_response(StatusCode::OK, ""))
}

fn derive_target_url(parts: &http::request::Parts) -> Result<Url, String> {
    let raw = parts.uri.to_string();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Url::parse(&raw).map_err(|error| format!("invalid proxy URL: {error}"));
    }

    let host = parts
        .headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .ok_or_else(|| "host header is required for relative proxy request".to_string())?;
    let path = if raw.starts_with('/') { raw } else { format!("/{raw}") };
    Url::parse(&format!("http://{host}{path}")).map_err(|error| format!("invalid relative proxy URL: {error}"))
}

fn derive_https_target_url(
    parts: &http::request::Parts,
    authority_host: &str,
    authority_port: u16,
) -> Result<Url, String> {
    let raw = parts.uri.to_string();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return Url::parse(&raw).map_err(|error| format!("invalid MITM URL: {error}"));
    }

    let host_header = parts
        .headers
        .get("host")
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let authority = host_header.unwrap_or_else(|| match authority_port {
        443 => authority_host.to_string(),
        port => format!("{authority_host}:{port}"),
    });
    let path = if raw.starts_with('/') { raw } else { format!("/{raw}") };
    Url::parse(&format!("https://{authority}{path}"))
        .map_err(|error| format!("invalid relative MITM URL: {error}"))
}

fn parse_authority_parts(authority: &str) -> Result<(String, u16), String> {
    let parsed = Url::parse(&format!("https://{authority}"))
        .map_err(|error| format!("invalid CONNECT authority {authority}: {error}"))?;
    let host = parsed
        .host_str()
        .map(|value| value.to_string())
        .ok_or_else(|| format!("CONNECT authority is missing a host: {authority}"))?;
    Ok((host, parsed.port().unwrap_or(443)))
}

async fn ensure_mitm_environment(state: &AppState) -> Result<Arc<MitmEnvironment>, String> {
    let mut guard = state.mitm_env.lock().await;
    if let Some(existing) = guard.as_ref() {
        return Ok(existing.clone());
    }
    let env = Arc::new(MitmEnvironment::ensure()?);
    *guard = Some(env.clone());
    Ok(env)
}

fn extract_meta_string(meta: Option<&serde_json::Value>, key: &str) -> Option<String> {
    meta.and_then(|value| value.get(key))
        .and_then(|value| value.as_str())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn authorize(state: &AppState, headers: &HeaderMap) -> Result<(), Response> {
    let expected = format!("Bearer {}", state.auth_token.as_str());
    let actual = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    if actual == expected {
        Ok(())
    } else {
        Err(error_response(StatusCode::UNAUTHORIZED, "unauthorized"))
    }
}

fn error_response(status: StatusCode, message: impl ToString) -> Response {
    let payload = Json(serde_json::json!({
        "error": message.to_string(),
    }));
    (status, payload).into_response()
}

fn text_response(status: StatusCode, message: &str) -> http::Response<Full<Bytes>> {
    http::Response::builder()
        .status(status)
        .header("content-type", HeaderValue::from_static("text/plain; charset=utf-8"))
        .body(Full::new(Bytes::from(message.to_string())))
        .unwrap()
}

fn redact_headers<'a, I>(headers: I) -> HashMap<String, Option<String>>
where
    I: Iterator<Item = (&'a str, &'a HeaderValue)>,
{
    headers
        .map(|(name, value)| {
            let lower = name.to_ascii_lowercase();
            let rendered = if lower == "authorization"
                || lower == "proxy-authorization"
                || lower == "cookie"
                || lower == "set-cookie"
            {
                Some("[redacted]".to_string())
            } else {
                value.to_str().ok().map(|value| value.to_string())
            };
            (name.to_string(), rendered)
        })
        .collect()
}

fn redact_response_headers(headers: &HeaderMap) -> HashMap<String, Option<String>> {
    redact_headers(
        headers
            .iter()
            .filter(|(name, _)| !is_downstream_response_blocked(name.as_str()))
            .map(|(name, value)| (name.as_str(), value)),
    )
}

fn header_to_string(value: Option<&HeaderValue>) -> Option<String> {
    value
        .and_then(|value| value.to_str().ok())
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn preview_from_http_body(
    bytes: &[u8],
    content_type: Option<&str>,
    content_encoding: Option<&str>,
    max_body_capture_bytes: usize,
) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }

    let decoded = match decode_body_bytes(bytes, content_encoding) {
        Some(value) => value,
        None if content_encoding.is_some() => return None,
        None => bytes.to_vec(),
    };
    if decoded.is_empty() || is_binary_content_type(content_type) || !bytes_look_textual(&decoded) {
        return None;
    }
    preview_from_bytes(&decoded, max_body_capture_bytes)
}

fn decode_body_bytes(bytes: &[u8], content_encoding: Option<&str>) -> Option<Vec<u8>> {
    let mut encodings = content_encoding
        .unwrap_or_default()
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value != "identity")
        .collect::<Vec<_>>();

    if encodings.is_empty() {
        return None;
    }

    let mut decoded = bytes.to_vec();
    for encoding in encodings.drain(..).rev() {
        decoded = match encoding.as_str() {
            "br" => {
                let mut decoder = Decompressor::new(decoded.as_slice(), 4096);
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            "gzip" | "x-gzip" => {
                let mut decoder = GzDecoder::new(decoded.as_slice());
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            "deflate" => {
                let mut decoder = ZlibDecoder::new(decoded.as_slice());
                let mut output = Vec::new();
                decoder.read_to_end(&mut output).ok()?;
                output
            }
            _ => return None,
        };
    }

    Some(decoded)
}

fn is_binary_content_type(content_type: Option<&str>) -> bool {
    let normalized = content_type
        .unwrap_or_default()
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if normalized.is_empty() {
        return false;
    }
    if normalized.starts_with("text/")
        || normalized.contains("json")
        || normalized.contains("xml")
        || normalized.contains("javascript")
        || normalized.contains("graphql")
        || normalized.contains("x-www-form-urlencoded")
        || normalized.contains("yaml")
        || normalized.contains("csv")
        || normalized.ends_with("+json")
        || normalized.ends_with("+xml")
    {
        return false;
    }

    normalized.starts_with("image/")
        || normalized.starts_with("audio/")
        || normalized.starts_with("video/")
        || normalized.contains("protobuf")
        || normalized.contains("octet-stream")
        || normalized.contains("grpc")
        || normalized.contains("zip")
        || normalized.contains("pdf")
        || normalized.contains("font")
}

fn bytes_look_textual(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }

    let preview_len = bytes.len().min(4096);
    let rendered = String::from_utf8_lossy(&bytes[..preview_len]);
    let mut total = 0usize;
    let mut printable = 0usize;
    let mut replacement = 0usize;

    for ch in rendered.chars() {
        total += 1;
        if ch == '\u{fffd}' {
            replacement += 1;
            continue;
        }
        if !ch.is_control() || matches!(ch, '\n' | '\r' | '\t') {
            printable += 1;
        }
    }

    total > 0 && printable.saturating_mul(100) / total >= 85 && replacement.saturating_mul(100) / total <= 10
}

fn preview_from_bytes(bytes: &[u8], max_body_capture_bytes: usize) -> Option<String> {
    if bytes.is_empty() {
        return None;
    }
    let preview_len = bytes.len().min(max_body_capture_bytes).min(1024);
    Some(String::from_utf8_lossy(&bytes[..preview_len]).to_string())
}

fn is_outbound_request_blocked(name: &str) -> bool {
    is_hop_by_hop(name)
        || name.eq_ignore_ascii_case("host")
        || name.eq_ignore_ascii_case("alt-used")
}

fn is_downstream_response_blocked(name: &str) -> bool {
    is_hop_by_hop(name)
        || name.eq_ignore_ascii_case("alt-svc")
        || name.eq_ignore_ascii_case("http3-settings")
}

fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "proxy-connection"
            | "connection"
            | "keep-alive"
            | "transfer-encoding"
            | "te"
            | "trailer"
            | "upgrade"
            | "proxy-authorization"
    )
}

fn mark_connect_failure(entry: &mut TraceEntry, error: impl ToString) {
    let rendered = classify_mitm_failure_message(&error.to_string());
    entry.ok = Some(false);
    entry.status = None;
    entry.failure_text = Some(rendered.clone());
    entry.response = Some(TraceResponseMeta {
        status: None,
        headers: None,
        duration_ms: None,
        size: None,
        content_type: None,
        body_preview: None,
        error: Some(rendered),
    });
}

fn classify_mitm_failure_message(message: &str) -> String {
    if looks_like_tls_pinning_failure(message) {
        format!("Probable TLS pinning or untrusted App Lab CA: {message}")
    } else {
        message.to_string()
    }
}

fn looks_like_tls_pinning_failure(message: &str) -> bool {
    let normalized = message.trim().to_ascii_lowercase();
    normalized.contains("tls handshake eof")
        || normalized.contains("certificateunknown")
        || normalized.contains("certificate unknown")
        || normalized.contains("unknown ca")
        || normalized.contains("unknown issuer")
        || normalized.contains("bad certificate")
        || normalized.contains("certificate verify failed")
        || normalized.contains("peer sent no certificates")
        || normalized.contains("handshake failure")
}

fn now_ms() -> i64 {
    Utc::now().timestamp_millis()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

struct RuntimeArgs {
    host: String,
    port: u16,
    token: String,
}

fn parse_args() -> RuntimeArgs {
    let mut host = "127.0.0.1".to_string();
    let mut port: u16 = 0;
    let mut token = String::new();
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--host" => {
                if let Some(value) = args.next() {
                    host = value;
                }
            }
            "--port" => {
                if let Some(value) = args.next() {
                    port = value.parse::<u16>().unwrap_or(0);
                }
            }
            "--token" => {
                if let Some(value) = args.next() {
                    token = value;
                }
            }
            _ => {}
        }
    }

    if token.trim().is_empty() {
        panic!("--token is required");
    }

    RuntimeArgs { host, port, token }
}
