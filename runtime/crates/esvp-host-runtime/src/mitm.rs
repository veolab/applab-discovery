use std::collections::HashMap;
use std::env;
use std::fs::{self, File};
use std::io::Write;
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};

use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::ServerConfig;
use serde::Serialize;
use tokio_rustls::TlsAcceptor;

#[derive(Clone)]
pub struct MitmEnvironment {
    root_cert_pem_path: PathBuf,
    root_key_pem_path: PathBuf,
    leaf_dir: PathBuf,
    leaf_paths: Arc<Mutex<HashMap<String, LeafCertificatePaths>>>,
}

#[derive(Clone)]
struct LeafCertificatePaths {
    cert_der_path: PathBuf,
    key_der_path: PathBuf,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct MitmSetupState {
    pub enabled: bool,
    pub root_cert_path: Option<String>,
    pub platform: Option<String>,
    pub device_id: Option<String>,
    pub certificate_installed: bool,
    pub certificate_install_method: Option<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

impl MitmEnvironment {
    pub fn ensure() -> Result<Self, String> {
        let root_dir = resolve_root_dir()?;
        let root_cert_pem_path = root_dir.join("applab-mitm-root-ca.pem");
        let root_key_pem_path = root_dir.join("applab-mitm-root-ca.key.pem");
        let leaf_dir = root_dir.join("leaf-certs");

        fs::create_dir_all(&leaf_dir)
            .map_err(|error| format!("Failed to create MITM leaf directory: {error}"))?;

        if !root_cert_pem_path.exists() || !root_key_pem_path.exists() {
            generate_root_ca(&root_cert_pem_path, &root_key_pem_path)?;
        }

        Ok(Self {
            root_cert_pem_path,
            root_key_pem_path,
            leaf_dir,
            leaf_paths: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    pub fn prepare_device_for_session(
        &self,
        platform: Option<&str>,
        device_id: Option<&str>,
    ) -> Result<MitmSetupState, String> {
        let normalized_platform = platform.map(|value| value.trim().to_lowercase());
        let normalized_device_id = device_id.map(|value| value.trim().to_string());

        match normalized_platform.as_deref() {
            Some("android") => {
                let device_id = normalized_device_id
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "external-mitm requires an Android emulator device id".to_string())?;
                if !device_id.starts_with("emulator-") {
                    return Err(
                        "external-mitm is currently limited to Android Emulator. Physical Android comes later.".to_string(),
                    );
                }
                install_android_emulator_root_cert(device_id, &self.root_cert_pem_path)
            }
            Some("ios") => {
                let device_id = normalized_device_id
                    .as_deref()
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| "external-mitm requires an iOS Simulator device id".to_string())?;
                install_ios_simulator_root_cert(device_id, &self.root_cert_pem_path)
            }
            Some(other) => Err(format!(
                "external-mitm is only supported for Android Emulator and iOS Simulator right now (got {other})."
            )),
            None => Err("external-mitm requires platform metadata so the runtime can install the root certificate.".to_string()),
        }
    }

    pub fn tls_acceptor_for_host(&self, hostname: &str) -> Result<TlsAcceptor, String> {
        let leaf_paths = self.ensure_leaf_certificate(hostname)?;
        let cert_der = fs::read(&leaf_paths.cert_der_path).map_err(|error| {
            format!(
                "Failed to read leaf certificate {}: {error}",
                leaf_paths.cert_der_path.display()
            )
        })?;
        let key_der = fs::read(&leaf_paths.key_der_path).map_err(|error| {
            format!(
                "Failed to read leaf private key {}: {error}",
                leaf_paths.key_der_path.display()
            )
        })?;

        let cert_chain = vec![CertificateDer::from(cert_der)];
        let private_key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key_der));
        let mut config = ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(cert_chain, private_key)
            .map_err(|error| format!("Failed to build rustls MITM config for {hostname}: {error}"))?;
        config.alpn_protocols = vec![b"http/1.1".to_vec()];

        Ok(TlsAcceptor::from(Arc::new(config)))
    }

    fn ensure_leaf_certificate(&self, hostname: &str) -> Result<LeafCertificatePaths, String> {
        if let Some(existing) = self.leaf_paths.lock().map_err(|_| "MITM leaf cache lock poisoned".to_string())?.get(hostname).cloned() {
            return Ok(existing);
        }

        let sanitized = sanitize_hostname(hostname);
        let leaf_base = self.leaf_dir.join(sanitized);
        let cert_pem_path = leaf_base.with_extension("crt.pem");
        let csr_pem_path = leaf_base.with_extension("csr.pem");
        let key_pem_path = leaf_base.with_extension("key.pem");
        let cert_der_path = leaf_base.with_extension("crt.der");
        let key_der_path = leaf_base.with_extension("key.der");
        let ext_path = leaf_base.with_extension("ext.cnf");

        if !cert_der_path.exists() || !key_der_path.exists() {
            generate_leaf_certificate(
                hostname,
                &self.root_cert_pem_path,
                &self.root_key_pem_path,
                &cert_pem_path,
                &csr_pem_path,
                &key_pem_path,
                &cert_der_path,
                &key_der_path,
                &ext_path,
            )?;
        }

        let paths = LeafCertificatePaths {
            cert_der_path,
            key_der_path,
        };
        self.leaf_paths
            .lock()
            .map_err(|_| "MITM leaf cache lock poisoned".to_string())?
            .insert(hostname.to_string(), paths.clone());
        Ok(paths)
    }
}

fn resolve_root_dir() -> Result<PathBuf, String> {
    let home = env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| "HOME is not set; unable to resolve MITM runtime directory".to_string())?;
    let root_dir = home
        .join(".discoverylab")
        .join("runtime")
        .join("esvp-host-runtime")
        .join("mitm");
    fs::create_dir_all(&root_dir)
        .map_err(|error| format!("Failed to create MITM runtime directory {}: {error}", root_dir.display()))?;
    Ok(root_dir)
}

fn generate_root_ca(cert_path: &Path, key_path: &Path) -> Result<(), String> {
    run_command(
        "openssl",
        &[
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-sha256",
            "-days",
            "3650",
            "-nodes",
            "-keyout",
            &key_path.to_string_lossy(),
            "-out",
            &cert_path.to_string_lossy(),
            "-subj",
            "/CN=AppLab Discovery MITM Root CA/O=AppLab Discovery",
            "-addext",
            "basicConstraints=critical,CA:TRUE,pathlen:0",
            "-addext",
            "keyUsage=critical,keyCertSign,cRLSign",
            "-addext",
            "subjectKeyIdentifier=hash",
        ],
    )
    .map(|_| ())
}

fn generate_leaf_certificate(
    hostname: &str,
    root_cert_path: &Path,
    root_key_path: &Path,
    cert_pem_path: &Path,
    csr_pem_path: &Path,
    key_pem_path: &Path,
    cert_der_path: &Path,
    key_der_path: &Path,
    ext_path: &Path,
) -> Result<(), String> {
    let mut ext_file = File::create(ext_path)
        .map_err(|error| format!("Failed to create MITM extension file {}: {error}", ext_path.display()))?;
    let san_prefix = if hostname.parse::<IpAddr>().is_ok() { "IP" } else { "DNS" };
    let ext_contents = format!(
        "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName={san_prefix}:{hostname}\n"
    );
    ext_file
        .write_all(ext_contents.as_bytes())
        .map_err(|error| format!("Failed to write MITM extension file {}: {error}", ext_path.display()))?;

    run_command(
        "openssl",
        &[
            "req",
            "-new",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            &key_pem_path.to_string_lossy(),
            "-out",
            &csr_pem_path.to_string_lossy(),
            "-subj",
            &format!("/CN={hostname}"),
        ],
    )?;

    run_command(
        "openssl",
        &[
            "x509",
            "-req",
            "-sha256",
            "-days",
            "14",
            "-in",
            &csr_pem_path.to_string_lossy(),
            "-CA",
            &root_cert_path.to_string_lossy(),
            "-CAkey",
            &root_key_path.to_string_lossy(),
            "-CAcreateserial",
            "-out",
            &cert_pem_path.to_string_lossy(),
            "-extfile",
            &ext_path.to_string_lossy(),
        ],
    )?;

    run_command(
        "openssl",
        &[
            "x509",
            "-in",
            &cert_pem_path.to_string_lossy(),
            "-outform",
            "DER",
            "-out",
            &cert_der_path.to_string_lossy(),
        ],
    )?;

    run_command(
        "openssl",
        &[
            "pkcs8",
            "-topk8",
            "-inform",
            "PEM",
            "-outform",
            "DER",
            "-in",
            &key_pem_path.to_string_lossy(),
            "-nocrypt",
            "-out",
            &key_der_path.to_string_lossy(),
        ],
    )?;

    Ok(())
}

fn install_android_emulator_root_cert(device_id: &str, cert_path: &Path) -> Result<MitmSetupState, String> {
    let cert_hash = compute_android_subject_hash(cert_path)?;
    let remote_path = format!("/system/etc/security/cacerts/{cert_hash}.0");

    run_command("adb", &["-s", device_id, "root"])?;
    run_command("adb", &["-s", device_id, "wait-for-device"])?;
    run_command("adb", &["-s", device_id, "remount"])?;
    run_command(
        "adb",
        &[
            "-s",
            device_id,
            "push",
            &cert_path.to_string_lossy(),
            &remote_path,
        ],
    )?;
    run_command("adb", &["-s", device_id, "shell", "chmod", "644", &remote_path])?;

    Ok(MitmSetupState {
        enabled: true,
        root_cert_path: Some(cert_path.to_string_lossy().to_string()),
        platform: Some("android".to_string()),
        device_id: Some(device_id.to_string()),
        certificate_installed: true,
        certificate_install_method: Some("adb-system-cacerts".to_string()),
        warnings: vec![
            "The Android emulator root CA stays installed for reuse. Clear or replace it manually if you rotate the CA.".to_string(),
            "Pinned apps may still reject MITM traffic even with the root CA installed.".to_string(),
            "App Lab strips alt-svc/http3-settings on proxied responses to reduce QUIC/HTTP3 upgrades, but direct UDP/HTTP3 traffic can still bypass capture.".to_string(),
        ],
        errors: Vec::new(),
    })
}

fn install_ios_simulator_root_cert(device_id: &str, cert_path: &Path) -> Result<MitmSetupState, String> {
    run_command(
        "xcrun",
        &[
            "simctl",
            "keychain",
            device_id,
            "add-root-cert",
            &cert_path.to_string_lossy(),
        ],
    )?;

    Ok(MitmSetupState {
        enabled: true,
        root_cert_path: Some(cert_path.to_string_lossy().to_string()),
        platform: Some("ios".to_string()),
        device_id: Some(device_id.to_string()),
        certificate_installed: true,
        certificate_install_method: Some("simctl-keychain".to_string()),
        warnings: vec![
            "Pinned apps may still reject MITM traffic even with the root CA installed.".to_string(),
            "App Lab strips alt-svc/http3-settings on proxied responses to reduce QUIC/HTTP3 upgrades, but direct UDP/HTTP3 traffic can still bypass capture.".to_string(),
        ],
        errors: Vec::new(),
    })
}

fn compute_android_subject_hash(cert_path: &Path) -> Result<String, String> {
    let output = run_command(
        "openssl",
        &[
            "x509",
            "-inform",
            "PEM",
            "-subject_hash_old",
            "-in",
            &cert_path.to_string_lossy(),
            "-noout",
        ],
    )?;
    output
        .lines()
        .next()
        .map(|line| line.trim().to_string())
        .filter(|line| !line.is_empty())
        .ok_or_else(|| "openssl did not return an Android subject hash for the MITM root certificate".to_string())
}

fn sanitize_hostname(hostname: &str) -> String {
    let mut sanitized = hostname
        .chars()
        .map(|ch| match ch {
            'a'..='z' | 'A'..='Z' | '0'..='9' => ch,
            _ => '_',
        })
        .collect::<String>();
    if sanitized.is_empty() {
        sanitized.push_str("host");
    }
    sanitized
}

fn run_command(command: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(command)
        .args(args)
        .output()
        .map_err(|error| format!("Failed to spawn {command}: {error}"))?;
    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(stdout);
    }

    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let rendered = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("command exited with status {}", output.status)
    };
    Err(format!(
        "{command} {} failed: {rendered}",
        args.join(" ")
    ))
}
