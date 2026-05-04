/**
 * Physical device network capture (no-decrypt).
 *
 * Provides two capture paths that work on production app installs (store-installed,
 * with biometric & cert pinning) without rooting/jailbreaking the device:
 *
 *   - iOS: Apple's `rvictl` creates a virtual interface (`rvi0`) on macOS that
 *     mirrors all network traffic from a USB-tethered iPhone. We pipe the
 *     interface into `tcpdump` writing a pcap file.
 *
 *   - Android: PCAPdroid (no-root, VPN-service based) is driven via `adb shell
 *     am start` intent broadcasts. PCAPdroid writes a pcap into the device's
 *     storage; we pull it on stop.
 *
 * Because we never decrypt TLS, the parser only extracts:
 *   - TCP SYN  → connection opens (count + dst host:port)
 *   - TLS Client Hello → SNI (server name) + dst host:port + timestamp
 *   - QUIC Initial → SNI (best-effort) for HTTP/3 traffic
 *
 * The output is shaped like `normalizeSimpleRequest` consumes in the entropy
 * web-console (`web-console/views/session-devtools/index.js`), so the existing
 * Network panel renders it without changes.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type PhysicalPlatform = 'ios' | 'android';

export type PhysicalCaptureRequest = {
  sessionId: string;
  platform: PhysicalPlatform;
  /** iOS: device UDID. Android: adb device id (must NOT start with `emulator-`). */
  deviceId: string;
  /** Output directory for pcap files. Defaults to ~/.discoverylab/runtime/physical-capture/. */
  outputDir?: string;
  /** PCAPdroid-only: comma-separated package names to filter. */
  packageFilter?: string;
};

export type PhysicalCaptureHandle = {
  sessionId: string;
  platform: PhysicalPlatform;
  deviceId: string;
  pcapPath: string;
  startedAt: string;
  startedAtMs: number;
  /** Native subprocess (tcpdump on iOS). Null for Android (capture lives on the device). */
  child: ChildProcess | null;
  cleanup: () => Promise<void>;
};

export type PhysicalCaptureStopResult = {
  pcapPath: string;
  bytesCaptured: number;
  durationMs: number;
};

export type ParsedNetworkEntry = {
  url: string;
  method: string;
  status: number | null;
  t_start: number;
  duration_ms: number | null;
  source: 'rvictl-pcap' | 'pcapdroid-pcap';
  capture_mode: 'external-capture';
  protocol: 'tls' | 'quic' | 'tcp';
  request: { url: string; method: string; headers: [] };
  response: { status: number | null; headers: []; body: '' };
};

export type ParsedNetworkTrace = {
  entries: ParsedNetworkEntry[];
  meta: {
    pcap_path: string;
    packet_count: number;
    capture_started_at_ms: number;
    parsed_at: string;
    link_type: number;
    truncated: boolean;
  };
};

const DEFAULT_OUTPUT_DIR = join(homedir(), '.discoverylab', 'runtime', 'physical-capture');

/** Public entry point: starts capture appropriate to the platform. */
export async function startPhysicalCapture(
  request: PhysicalCaptureRequest
): Promise<PhysicalCaptureHandle> {
  if (!request.sessionId) throw new Error('sessionId is required');
  if (!request.deviceId) throw new Error('deviceId is required');

  const outputDir = request.outputDir || DEFAULT_OUTPUT_DIR;
  await mkdir(outputDir, { recursive: true });
  const pcapPath = join(
    outputDir,
    `${sanitize(request.sessionId)}-${request.platform}-${Date.now()}.pcap`
  );

  if (request.platform === 'ios') {
    return startIosCapture(request, pcapPath);
  }
  if (request.platform === 'android') {
    if (request.deviceId.startsWith('emulator-')) {
      throw new Error(
        'physical-capture targets physical Android devices. Use external-mitm for emulator instead.'
      );
    }
    return startAndroidCapture(request, pcapPath);
  }
  throw new Error(`unsupported platform: ${request.platform as string}`);
}

/** Public entry point: stops the capture and returns the pcap path + size. */
export async function stopPhysicalCapture(
  handle: PhysicalCaptureHandle
): Promise<PhysicalCaptureStopResult> {
  await handle.cleanup();
  let bytesCaptured = 0;
  try {
    const stats = await stat(handle.pcapPath);
    bytesCaptured = stats.size;
  } catch {
    bytesCaptured = 0;
  }
  return {
    pcapPath: handle.pcapPath,
    bytesCaptured,
    durationMs: Date.now() - handle.startedAtMs,
  };
}

// ---------------------------------------------------------------------------
// iOS via rvictl + tcpdump
// ---------------------------------------------------------------------------

async function startIosCapture(
  request: PhysicalCaptureRequest,
  pcapPath: string
): Promise<PhysicalCaptureHandle> {
  await ensureRvictlAttached(request.deviceId);

  const tcpdump = spawn(
    'tcpdump',
    ['-i', 'rvi0', '-w', pcapPath, '-U', '-s', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderr = '';
  tcpdump.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });

  // tcpdump writes the pcap header almost immediately; wait briefly to surface
  // permission errors (it usually requires sudo or BPF group membership).
  await sleep(400);
  if (tcpdump.exitCode !== null && tcpdump.exitCode !== 0) {
    throw new Error(
      `tcpdump on rvi0 failed (exit ${tcpdump.exitCode}). stderr: ${stderr.trim() || '(empty)'}`
    );
  }
  if (!existsSync(pcapPath)) {
    // pcap may take a fraction longer; do one more wait.
    await sleep(500);
    if (!existsSync(pcapPath)) {
      throw new Error('tcpdump did not produce a pcap file. Check sudoers/BPF permissions.');
    }
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  return {
    sessionId: request.sessionId,
    platform: 'ios',
    deviceId: request.deviceId,
    pcapPath,
    startedAt,
    startedAtMs,
    child: tcpdump,
    cleanup: async () => {
      if (tcpdump.exitCode === null) {
        tcpdump.kill('SIGINT');
        await waitForExit(tcpdump, 3000);
      }
      // Leave rvi0 attached: subsequent sessions can reuse it. The TS layer
      // owns rvictl lifecycle elsewhere if explicit detach is needed.
    },
  };
}

async function ensureRvictlAttached(udid: string): Promise<void> {
  if (!/^[0-9A-Fa-f-]{20,40}$/.test(udid)) {
    throw new Error(`UDID looks malformed: ${udid}`);
  }
  // Attach (idempotent: errors with "already exists" if running).
  const out = await runCmd('rvictl', ['-s', udid]);
  const failed = /failed|error/i.test(out.stderr) && !/already/i.test(out.stderr);
  if (out.exitCode !== 0 && failed) {
    throw new Error(
      `rvictl -s ${udid} failed (exit ${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`
    );
  }
  // Poll for rvi0.
  for (let i = 0; i < 25; i += 1) {
    const ifc = await runCmd('ifconfig', ['rvi0']);
    if (ifc.exitCode === 0) return;
    await sleep(200);
  }
  throw new Error('rvi0 did not come up within 5s after rvictl -s');
}

// ---------------------------------------------------------------------------
// Android via PCAPdroid (no-root, VPN-service based)
// ---------------------------------------------------------------------------

const PCAPDROID_CTL_ACTION = 'com.emanuelef.remote_capture.CaptureCtrl';
const PCAPDROID_DEFAULT_PCAP_NAME = 'applab-capture.pcap';
const PCAPDROID_REMOTE_DIR = '/storage/emulated/0/Android/data/com.emanuelef.remote_capture/files';

async function startAndroidCapture(
  request: PhysicalCaptureRequest,
  pcapPath: string
): Promise<PhysicalCaptureHandle> {
  const remoteName = `${sanitize(request.sessionId)}-${Date.now()}.pcap`;
  const remotePath = `${PCAPDROID_REMOTE_DIR}/${remoteName}`;

  const args = [
    '-s',
    request.deviceId,
    'shell',
    'am',
    'start',
    '-e',
    'action',
    'start',
    '-e',
    'pcap_dump_mode',
    'pcap_file',
    '-e',
    'pcap_name',
    remoteName,
  ];
  if (request.packageFilter) {
    args.push('-e', 'app_filter', request.packageFilter);
  }
  args.push('-a', PCAPDROID_CTL_ACTION);

  const startResult = await runCmd('adb', args);
  if (startResult.exitCode !== 0) {
    throw new Error(
      `adb start PCAPdroid failed (exit ${startResult.exitCode}). Make sure PCAPdroid is installed on the device. stderr: ${startResult.stderr.trim()}`
    );
  }
  // PCAPdroid asks for VPN consent on first run — surface this with a hint.
  if (/permission|consent|vpn/i.test(startResult.stdout)) {
    // Not fatal; user must accept on device.
  }

  const startedAt = new Date().toISOString();
  const startedAtMs = Date.now();
  return {
    sessionId: request.sessionId,
    platform: 'android',
    deviceId: request.deviceId,
    pcapPath,
    startedAt,
    startedAtMs,
    child: null,
    cleanup: async () => {
      await runCmd('adb', [
        '-s',
        request.deviceId,
        'shell',
        'am',
        'start',
        '-e',
        'action',
        'stop',
        '-a',
        PCAPDROID_CTL_ACTION,
      ]);
      // Pull the pcap from the device. Best-effort: if pull fails, leave the
      // handle's pcapPath empty and let parsePcapToHarLikeTrace return [].
      const pull = await runCmd('adb', ['-s', request.deviceId, 'pull', remotePath, pcapPath]);
      if (pull.exitCode !== 0) {
        // Try the legacy default name as a fallback.
        const fallback = `${PCAPDROID_REMOTE_DIR}/${PCAPDROID_DEFAULT_PCAP_NAME}`;
        await runCmd('adb', ['-s', request.deviceId, 'pull', fallback, pcapPath]);
      }
      // Clean up remote file (ignore failure).
      await runCmd('adb', ['-s', request.deviceId, 'shell', 'rm', '-f', remotePath]).catch(
        () => undefined
      );
    },
  };
}

// ---------------------------------------------------------------------------
// pcap → HAR-like JSON parser
// ---------------------------------------------------------------------------

const PCAP_MAGIC_LE = 0xa1b2c3d4;
const PCAP_MAGIC_BE = 0xd4c3b2a1;
const PCAP_MAGIC_NS_LE = 0xa1b23c4d;
const PCAP_MAGIC_NS_BE = 0x4d3cb2a1;

const DLT_NULL = 0;
const DLT_EN10MB = 1;
const DLT_RAW = 12;
const DLT_LINUX_SLL = 113;
const DLT_RAW_ALT = 101; // some platforms

const ETHERTYPE_IPV4 = 0x0800;
const ETHERTYPE_IPV6 = 0x86dd;

type RawPacket = {
  ts_ms: number;
  src_ip: string;
  dst_ip: string;
  ip_proto: number;
  src_port: number;
  dst_port: number;
  tcp_flags: number;
  payload: Buffer;
};

export async function parsePcapToHarLikeTrace(
  pcapPath: string,
  opts: { source: 'rvictl-pcap' | 'pcapdroid-pcap'; maxEntries?: number } = {
    source: 'rvictl-pcap',
  }
): Promise<ParsedNetworkTrace> {
  const maxEntries = opts.maxEntries ?? 5000;
  const buffer = await readFile(pcapPath);
  if (buffer.length < 24) {
    return emptyTrace(pcapPath, 0);
  }

  const magic = buffer.readUInt32LE(0);
  let littleEndian = true;
  let nanoTimestamps = false;
  if (magic === PCAP_MAGIC_LE) {
    littleEndian = true;
  } else if (magic === PCAP_MAGIC_BE) {
    littleEndian = false;
  } else if (magic === PCAP_MAGIC_NS_LE) {
    littleEndian = true;
    nanoTimestamps = true;
  } else if (magic === PCAP_MAGIC_NS_BE) {
    littleEndian = false;
    nanoTimestamps = true;
  } else {
    throw new Error(`unrecognized pcap magic 0x${magic.toString(16)}`);
  }

  const linkType = read32(buffer, 20, littleEndian);
  const entries: ParsedNetworkEntry[] = [];
  const captureStartedAtMs = 0; // we don't capture this in pcap; consumer fills it
  let cursor = 24;
  let packetCount = 0;
  let truncated = false;

  while (cursor + 16 <= buffer.length && entries.length < maxEntries) {
    const ts_sec = read32(buffer, cursor, littleEndian);
    const ts_usec = read32(buffer, cursor + 4, littleEndian);
    const incl_len = read32(buffer, cursor + 8, littleEndian);
    cursor += 16;
    if (cursor + incl_len > buffer.length) break;
    const packetSlice = buffer.subarray(cursor, cursor + incl_len);
    cursor += incl_len;
    packetCount += 1;

    const ts_ms = ts_sec * 1000 + (nanoTimestamps ? ts_usec / 1_000_000 : ts_usec / 1000);
    const parsed = parseRawPacket(packetSlice, linkType, ts_ms);
    if (!parsed) continue;

    const entry = packetToEntry(parsed, opts.source);
    if (entry) entries.push(entry);
  }

  if (entries.length >= maxEntries) truncated = true;

  return {
    entries,
    meta: {
      pcap_path: pcapPath,
      packet_count: packetCount,
      capture_started_at_ms: captureStartedAtMs,
      parsed_at: new Date().toISOString(),
      link_type: linkType,
      truncated,
    },
  };
}

function emptyTrace(pcapPath: string, linkType: number): ParsedNetworkTrace {
  return {
    entries: [],
    meta: {
      pcap_path: pcapPath,
      packet_count: 0,
      capture_started_at_ms: 0,
      parsed_at: new Date().toISOString(),
      link_type: linkType,
      truncated: false,
    },
  };
}

function parseRawPacket(packet: Buffer, linkType: number, ts_ms: number): RawPacket | null {
  let ipOffset = 0;
  let etherType: number | null = null;

  switch (linkType) {
    case DLT_NULL: {
      if (packet.length < 4) return null;
      const af = packet.readUInt32LE(0);
      etherType = af === 2 ? ETHERTYPE_IPV4 : af === 24 || af === 28 || af === 30 ? ETHERTYPE_IPV6 : null;
      ipOffset = 4;
      break;
    }
    case DLT_EN10MB: {
      if (packet.length < 14) return null;
      etherType = packet.readUInt16BE(12);
      ipOffset = 14;
      // VLAN tag: 0x8100 means a 4-byte 802.1Q tag follows; skip it.
      if (etherType === 0x8100) {
        if (packet.length < 18) return null;
        etherType = packet.readUInt16BE(16);
        ipOffset = 18;
      }
      break;
    }
    case DLT_RAW:
    case DLT_RAW_ALT: {
      etherType = (packet[0] >> 4) === 6 ? ETHERTYPE_IPV6 : ETHERTYPE_IPV4;
      ipOffset = 0;
      break;
    }
    case DLT_LINUX_SLL: {
      if (packet.length < 16) return null;
      etherType = packet.readUInt16BE(14);
      ipOffset = 16;
      break;
    }
    default:
      return null;
  }

  if (etherType !== ETHERTYPE_IPV4 && etherType !== ETHERTYPE_IPV6) return null;

  if (etherType === ETHERTYPE_IPV4) {
    return parseIpv4(packet, ipOffset, ts_ms);
  }
  return parseIpv6(packet, ipOffset, ts_ms);
}

function parseIpv4(packet: Buffer, ipOffset: number, ts_ms: number): RawPacket | null {
  if (packet.length < ipOffset + 20) return null;
  const versionIhl = packet[ipOffset];
  const version = versionIhl >> 4;
  if (version !== 4) return null;
  const ihl = (versionIhl & 0x0f) * 4;
  if (packet.length < ipOffset + ihl) return null;
  const proto = packet[ipOffset + 9];
  const src_ip = `${packet[ipOffset + 12]}.${packet[ipOffset + 13]}.${packet[ipOffset + 14]}.${packet[ipOffset + 15]}`;
  const dst_ip = `${packet[ipOffset + 16]}.${packet[ipOffset + 17]}.${packet[ipOffset + 18]}.${packet[ipOffset + 19]}`;
  const transportOffset = ipOffset + ihl;
  return parseTransport(packet, transportOffset, proto, src_ip, dst_ip, ts_ms);
}

function parseIpv6(packet: Buffer, ipOffset: number, ts_ms: number): RawPacket | null {
  if (packet.length < ipOffset + 40) return null;
  const version = packet[ipOffset] >> 4;
  if (version !== 6) return null;
  const proto = packet[ipOffset + 6]; // next header (we ignore extension headers)
  const src_ip = formatIpv6(packet, ipOffset + 8);
  const dst_ip = formatIpv6(packet, ipOffset + 24);
  return parseTransport(packet, ipOffset + 40, proto, src_ip, dst_ip, ts_ms);
}

function parseTransport(
  packet: Buffer,
  transportOffset: number,
  proto: number,
  src_ip: string,
  dst_ip: string,
  ts_ms: number
): RawPacket | null {
  if (proto === 6) {
    // TCP
    if (packet.length < transportOffset + 20) return null;
    const src_port = packet.readUInt16BE(transportOffset);
    const dst_port = packet.readUInt16BE(transportOffset + 2);
    const dataOffset = (packet[transportOffset + 12] >> 4) * 4;
    const tcp_flags = packet[transportOffset + 13];
    const payloadOffset = transportOffset + dataOffset;
    const payload =
      payloadOffset < packet.length
        ? packet.subarray(payloadOffset)
        : Buffer.alloc(0);
    return { ts_ms, src_ip, dst_ip, ip_proto: 6, src_port, dst_port, tcp_flags, payload };
  }
  if (proto === 17) {
    // UDP — used for QUIC
    if (packet.length < transportOffset + 8) return null;
    const src_port = packet.readUInt16BE(transportOffset);
    const dst_port = packet.readUInt16BE(transportOffset + 2);
    const payload = packet.subarray(transportOffset + 8);
    return { ts_ms, src_ip, dst_ip, ip_proto: 17, src_port, dst_port, tcp_flags: 0, payload };
  }
  return null;
}

function packetToEntry(
  packet: RawPacket,
  source: 'rvictl-pcap' | 'pcapdroid-pcap'
): ParsedNetworkEntry | null {
  // TLS Client Hello → SNI
  if (packet.ip_proto === 6 && packet.payload.length >= 5) {
    const sni = extractTlsSni(packet.payload);
    if (sni) {
      return buildEntry({
        host: sni,
        port: packet.dst_port,
        ts_ms: packet.ts_ms,
        protocol: 'tls',
        source,
      });
    }
    // TCP SYN-only (no payload, SYN flag set, ACK clear): connection open.
    const isSyn = (packet.tcp_flags & 0x02) !== 0 && (packet.tcp_flags & 0x10) === 0;
    if (isSyn && packet.payload.length === 0 && packet.dst_port === 443) {
      // Don't emit an entry for plain SYNs to 443 — we wait for the Client Hello
      // to know the SNI. SYNs to other ports do get emitted.
      return null;
    }
    if (isSyn && packet.payload.length === 0 && packet.dst_port !== 443 && packet.dst_port !== 80) {
      return buildEntry({
        host: packet.dst_ip,
        port: packet.dst_port,
        ts_ms: packet.ts_ms,
        protocol: 'tcp',
        source,
      });
    }
  }

  // QUIC Initial → SNI (best-effort; QUIC Initial packets carry the TLS
  // ClientHello in CRYPTO frames inside an encrypted Initial, but the SNI is
  // recoverable because the Initial-protection key is derived from the DCID
  // which is in plaintext. Implementing that fully is beyond scope for round 1.)
  if (packet.ip_proto === 17 && packet.dst_port === 443 && packet.payload.length > 0) {
    // For round 1 we just record the dst host for QUIC traffic. Counts are
    // sufficient to flag duplicate request storms.
    return buildEntry({
      host: packet.dst_ip,
      port: packet.dst_port,
      ts_ms: packet.ts_ms,
      protocol: 'quic',
      source,
    });
  }
  return null;
}

function buildEntry(input: {
  host: string;
  port: number;
  ts_ms: number;
  protocol: 'tls' | 'quic' | 'tcp';
  source: 'rvictl-pcap' | 'pcapdroid-pcap';
}): ParsedNetworkEntry {
  const scheme = input.protocol === 'tls' || input.protocol === 'quic' ? 'https' : 'tcp';
  const portSuffix = input.port === 443 || input.port === 80 ? '' : `:${input.port}`;
  const url = `${scheme}://${input.host}${portSuffix}`;
  return {
    url,
    method: 'CONNECT',
    status: null,
    t_start: input.ts_ms,
    duration_ms: null,
    source: input.source,
    capture_mode: 'external-capture',
    protocol: input.protocol,
    request: { url, method: 'CONNECT', headers: [] },
    response: { status: null, headers: [], body: '' },
  };
}

/**
 * Parse SNI extension out of a TLS Client Hello.
 * Returns the server name (lowercased) or null if not present/parseable.
 */
function extractTlsSni(payload: Buffer): string | null {
  // TLS record header: ContentType(1) + Version(2) + Length(2)
  if (payload.length < 5) return null;
  if (payload[0] !== 0x16) return null; // not handshake
  // Handshake header: HandshakeType(1) + Length(3)
  if (payload.length < 9) return null;
  if (payload[5] !== 0x01) return null; // not Client Hello
  // ClientHello body: Version(2) + Random(32) + SessionIdLen(1) + SessionId
  let pos = 5 + 4; // skip handshake header
  if (payload.length < pos + 34) return null;
  pos += 2 + 32; // version + random
  const sidLen = payload[pos];
  pos += 1 + sidLen;
  if (payload.length < pos + 2) return null;
  const csLen = payload.readUInt16BE(pos);
  pos += 2 + csLen;
  if (payload.length < pos + 1) return null;
  const cmLen = payload[pos];
  pos += 1 + cmLen;
  if (payload.length < pos + 2) return null;
  const extTotal = payload.readUInt16BE(pos);
  pos += 2;
  const extEnd = pos + extTotal;
  if (extEnd > payload.length) return null;
  while (pos + 4 <= extEnd) {
    const extType = payload.readUInt16BE(pos);
    const extLen = payload.readUInt16BE(pos + 2);
    pos += 4;
    if (extType === 0x0000) {
      // SNI extension. ServerNameList: list_len(2) + entries.
      // Each entry: NameType(1) + Length(2) + name.
      if (extLen < 2) return null;
      const listLen = payload.readUInt16BE(pos);
      let lp = pos + 2;
      const lpEnd = pos + 2 + listLen;
      while (lp + 3 <= lpEnd) {
        const nameType = payload[lp];
        const nameLen = payload.readUInt16BE(lp + 1);
        lp += 3;
        if (nameType === 0x00 && lp + nameLen <= lpEnd) {
          return payload.subarray(lp, lp + nameLen).toString('ascii').toLowerCase();
        }
        lp += nameLen;
      }
      return null;
    }
    pos += extLen;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function read32(buf: Buffer, offset: number, le: boolean): number {
  return le ? buf.readUInt32LE(offset) : buf.readUInt32BE(offset);
}

function formatIpv6(buf: Buffer, offset: number): string {
  const parts: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    parts.push(buf.readUInt16BE(offset + i * 2).toString(16));
  }
  return parts.join(':');
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    let done = false;
    const onExit = () => {
      if (done) return;
      done = true;
      resolve();
    };
    child.once('exit', onExit);
    setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, timeoutMs);
  });
}

function runCmd(
  cmd: string,
  args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', () => {
      resolve({ exitCode: -1, stdout, stderr: stderr || 'spawn error' });
    });
    child.on('close', (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/** Detach rvi0 (call this when the entire app session ends, not per capture). */
export async function detachRvictl(udid: string): Promise<void> {
  await runCmd('rvictl', ['-x', udid]);
}

/** Best-effort cleanup of pcap files older than `maxAgeMs`. */
export async function pruneOldPcaps(dir: string = DEFAULT_OUTPUT_DIR, maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  const { readdir } = await import('node:fs/promises');
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  await Promise.all(
    names
      .filter((n) => n.endsWith('.pcap'))
      .map(async (name) => {
        const path = join(dir, name);
        try {
          const s = await stat(path);
          if (s.mtimeMs < cutoff) await unlink(path);
        } catch {
          // ignore
        }
      })
  );
}
