/**
 * DiscoveryLab WebSocket Protocol Types
 *
 * Inspired by Clawdbot's typed WebSocket protocol pattern.
 * Three message types:
 * - Request: client → server (expects response)
 * - Response: server → client (reply to request)
 * - Event: server → client (push notification)
 */

// ============================================================================
// BASE MESSAGE TYPES
// ============================================================================

/** Request message: client → server */
export interface WSRequest<T = unknown> {
  type: 'req';
  id: string;
  method: string;
  params: T;
}

/** Response message: server → client */
export interface WSResponse<T = unknown> {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: T;
  error?: string;
}

/** Event message: server → client (push) */
export interface WSEvent<T = unknown> {
  type: 'event';
  event: string;
  payload: T;
  seq?: number;
  timestamp?: number;
}

/** Union of all message types */
export type WSMessage = WSRequest | WSResponse | WSEvent;

// ============================================================================
// REQUEST METHODS
// ============================================================================

/** Available request methods */
export type WSMethod =
  | 'ping'
  | 'recorder.start'
  | 'recorder.stop'
  | 'recorder.status'
  | 'liveStream.start'
  | 'liveStream.stop'
  | 'liveStream.tap'
  | 'project.list'
  | 'project.get'
  | 'project.create'
  | 'project.delete';

// ============================================================================
// EVENT TYPES
// ============================================================================

/** Available event types */
export type WSEventType =
  | 'action'
  | 'screenshot'
  | 'status'
  | 'stopped'
  | 'session'
  | 'liveFrame'
  | 'error'
  | 'connected';

// ============================================================================
// REQUEST PARAMS
// ============================================================================

export interface PingParams {}

export interface RecorderStartParams {
  name: string;
  url: string;
  resolution?: { width: number; height: number };
}

export interface RecorderStopParams {}

export interface RecorderStatusParams {}

export interface LiveStreamStartParams {
  platform: 'ios' | 'android';
  deviceId?: string;
  interactive?: boolean;
}

export interface LiveStreamStopParams {}

export interface LiveStreamTapParams {
  x: number;
  y: number;
}

export interface ProjectListParams {}

export interface ProjectGetParams {
  id: string;
}

export interface ProjectCreateParams {
  name: string;
  packageName?: string;
}

export interface ProjectDeleteParams {
  id: string;
}

// ============================================================================
// RESPONSE PAYLOADS
// ============================================================================

export interface PingResponse {
  pong: true;
}

export interface RecorderStartResponse {
  id: string;
  name: string;
  url: string;
  status: string;
  screenshotsDir: string;
}

export interface RecorderStopResponse {
  id: string;
  name: string;
  actions: any[];
  screenshots: string[];
}

export interface LiveStreamStartResponse {
  platform: 'ios' | 'android';
  deviceId?: string;
  interactive: boolean;
}

export interface LiveStreamStopResponse {
  stopped: true;
}

// ============================================================================
// EVENT PAYLOADS
// ============================================================================

export interface ActionEventPayload {
  id: string;
  type: string;
  timestamp: number;
  selector?: string;
  text?: string;
  url?: string;
  screenshotPath?: string;
}

export interface ScreenshotEventPayload {
  path: string;
  actionId: string;
}

export interface StatusEventPayload {
  status: string;
}

export interface SessionEventPayload {
  id: string;
  name: string;
  url: string;
  status: string;
  actions: any[];
  screenshotsDir: string;
}

export interface LiveFrameEventPayload {
  image: string; // base64
  platform: 'ios' | 'android';
  timestamp: number;
}

export interface ErrorEventPayload {
  message: string;
  code?: string;
}

export interface ConnectedEventPayload {
  timestamp: number;
  serverVersion: string;
}

// ============================================================================
// METHOD → PARAMS/RESPONSE MAPPING
// ============================================================================

export interface WSMethodMap {
  'ping': { params: PingParams; response: PingResponse };
  'recorder.start': { params: RecorderStartParams; response: RecorderStartResponse };
  'recorder.stop': { params: RecorderStopParams; response: RecorderStopResponse };
  'recorder.status': { params: RecorderStatusParams; response: SessionEventPayload | null };
  'liveStream.start': { params: LiveStreamStartParams; response: LiveStreamStartResponse };
  'liveStream.stop': { params: LiveStreamStopParams; response: LiveStreamStopResponse };
  'liveStream.tap': { params: LiveStreamTapParams; response: { success: boolean } };
  'project.list': { params: ProjectListParams; response: any[] };
  'project.get': { params: ProjectGetParams; response: any };
  'project.create': { params: ProjectCreateParams; response: any };
  'project.delete': { params: ProjectDeleteParams; response: { deleted: boolean } };
}

// ============================================================================
// EVENT → PAYLOAD MAPPING
// ============================================================================

export interface WSEventMap {
  'action': ActionEventPayload;
  'screenshot': ScreenshotEventPayload;
  'status': StatusEventPayload;
  'stopped': RecorderStopResponse;
  'session': SessionEventPayload;
  'liveFrame': LiveFrameEventPayload;
  'error': ErrorEventPayload;
  'connected': ConnectedEventPayload;
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isWSRequest(msg: unknown): msg is WSRequest {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as any).type === 'req' &&
    typeof (msg as any).id === 'string' &&
    typeof (msg as any).method === 'string'
  );
}

export function isWSResponse(msg: unknown): msg is WSResponse {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as any).type === 'res' &&
    typeof (msg as any).id === 'string' &&
    typeof (msg as any).ok === 'boolean'
  );
}

export function isWSEvent(msg: unknown): msg is WSEvent {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    (msg as any).type === 'event' &&
    typeof (msg as any).event === 'string'
  );
}

export function isWSMessage(msg: unknown): msg is WSMessage {
  return isWSRequest(msg) || isWSResponse(msg) || isWSEvent(msg);
}
