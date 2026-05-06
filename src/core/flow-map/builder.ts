import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export type FlowMapOwnerType = 'project' | 'mobile-recording' | 'web-recording' | 'esvp-session';

export interface FlowMapOwner {
  type: FlowMapOwnerType;
  id: string;
  sourceId?: string | null;
}

export interface FlowMapActionInput {
  id?: string;
  type?: string;
  timestamp?: number;
  description?: string;
  screenshotPath?: string;
  selector?: string;
  text?: string;
  value?: string;
  url?: string;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  direction?: string;
}

export interface FlowMapFrameInput {
  id?: string;
  frameNumber?: number;
  timestamp?: number;
  imagePath: string;
  ocrText?: string | null;
}

export interface FlowMapSessionInput {
  id?: string;
  name?: string;
  platform?: string;
  startedAt?: number;
  endedAt?: number;
  status?: string;
  actions?: FlowMapActionInput[];
  screenshotsDir?: string;
  videoPath?: string | null;
  viewport?: { width?: number; height?: number } | null;
  networkEntries?: unknown[];
}

export interface FlowMapNode {
  id: string;
  index: number;
  title: string;
  subtitle: string;
  imagePath: string | null;
  imageName: string | null;
  screenHash: string | null;
  startMs: number;
  endMs: number;
  durationMs: number;
  actionIds: string[];
  occurrenceCount: number;
  aspectRatio: number | null;
  ocrText?: string | null;
}

export interface FlowMapEdge {
  id: string;
  index: number;
  from: string;
  to: string;
  actionId: string | null;
  label: string;
  type: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  status: 'captured' | 'inferred';
}

export interface FlowMapPath {
  id: string;
  title: string;
  nodeIds: string[];
  edgeIds: string[];
  status: string;
}

export interface FlowMapArtifactRefs {
  recordingDir?: string | null;
  sessionPath?: string | null;
  flowCodePath?: string | null;
  flowMapPath?: string | null;
}

export interface FlowMap {
  version: 1;
  generatedAt: string;
  owner: FlowMapOwner;
  title: string;
  platform: string;
  media: {
    videoPath: string | null;
    durationMs: number;
    startedAt: number | null;
    endedAt: number | null;
  };
  viewport: { width?: number; height?: number } | null;
  nodes: FlowMapNode[];
  edges: FlowMapEdge[];
  paths: FlowMapPath[];
  stats: {
    actionCount: number;
    screenshotCount: number;
    nodeCount: number;
    edgeCount: number;
    dedupedScreenCount: number;
    networkEntryCount: number;
  };
  artifacts: FlowMapArtifactRefs;
}

export interface BuildFlowMapInput {
  owner: FlowMapOwner;
  title?: string | null;
  platform?: string | null;
  session?: FlowMapSessionInput | null;
  frames?: FlowMapFrameInput[];
  screenshotsDir?: string | null;
  videoPath?: string | null;
  durationMs?: number | null;
  recordingDir?: string | null;
  sessionPath?: string | null;
  flowCodePath?: string | null;
}

type FlowStep = {
  id: string;
  index: number;
  action: FlowMapActionInput | null;
  imagePath: string | null;
  title: string;
  subtitle: string;
  startMs: number;
  ocrText?: string | null;
};

const IMAGE_FILE_RE = /\.(png|jpg|jpeg|webp)$/i;

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function compactLabel(value: unknown, fallback: string): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 72 ? `${text.slice(0, 69).trim()}...` : text;
}

function listScreenshotPaths(dir: string | null | undefined): string[] {
  if (!dir || !existsSync(dir)) return [];
  try {
    if (!statSync(dir).isDirectory()) return [];
    return readdirSync(dir)
      .filter((file) => IMAGE_FILE_RE.test(file))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
      .map((file) => join(dir, file));
  } catch {
    return [];
  }
}

function resolveScreenshotPath(pathValue: unknown, screenshotsDir: string | null | undefined): string | null {
  if (typeof pathValue !== 'string' || !pathValue.trim()) return null;
  const direct = pathValue.trim();
  if (existsSync(direct)) return direct;

  if (screenshotsDir) {
    const candidate = join(screenshotsDir, basename(direct));
    if (existsSync(candidate)) return candidate;
  }

  return direct;
}

function hashFile(filePath: string | null): string | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    return createHash('sha1').update(readFileSync(filePath)).digest('hex');
  } catch {
    return null;
  }
}

function getImageAspectRatio(filePath: string | null): number | null {
  if (!filePath || !existsSync(filePath)) return null;
  try {
    const buffer = readFileSync(filePath);
    const isPng = buffer.length > 24
      && buffer[0] === 0x89
      && buffer[1] === 0x50
      && buffer[2] === 0x4e
      && buffer[3] === 0x47;
    if (isPng) {
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      return width > 0 && height > 0 ? width / height : null;
    }
  } catch {
    return null;
  }
  return null;
}

function resolveDurationMs(session: FlowMapSessionInput | null | undefined, fallback?: number | null): number {
  const startedAt = Number(session?.startedAt || 0);
  const endedAt = Number(session?.endedAt || 0);
  if (startedAt > 0 && endedAt > startedAt) {
    return endedAt - startedAt;
  }
  if (Number.isFinite(fallback || NaN) && Number(fallback) > 0) {
    return Number(fallback);
  }

  const actions = Array.isArray(session?.actions) ? session.actions : [];
  if (startedAt > 0 && actions.length > 0) {
    const maxActionMs = Math.max(
      ...actions
        .map((action) => Number(action.timestamp || 0))
        .filter((timestamp) => timestamp > startedAt)
        .map((timestamp) => timestamp - startedAt)
    );
    if (Number.isFinite(maxActionMs) && maxActionMs > 0) {
      return maxActionMs + 1500;
    }
  }

  return Math.max(actions.length * 1500, 1000);
}

function actionTimestampToMs(
  action: FlowMapActionInput,
  index: number,
  actionCount: number,
  startedAt: number | null,
  durationMs: number
): number {
  const timestamp = Number(action.timestamp || 0);
  if (startedAt && timestamp > startedAt - 5000) {
    return clamp(timestamp - startedAt, 0, durationMs);
  }
  if (timestamp > 0 && timestamp <= durationMs + 1000) {
    return clamp(timestamp, 0, durationMs);
  }
  if (actionCount <= 1) return 0;
  return Math.round((index / Math.max(actionCount - 1, 1)) * durationMs);
}

function frameTimestampToMs(frame: FlowMapFrameInput, index: number, count: number, durationMs: number): number {
  const timestamp = Number(frame.timestamp || 0);
  if (timestamp > 0) {
    return clamp(timestamp * 1000, 0, durationMs);
  }
  if (count <= 1) return 0;
  return Math.round((index / Math.max(count - 1, 1)) * durationMs);
}

function actionLabel(action: FlowMapActionInput | null, fallback: string): string {
  if (!action) return fallback;
  return compactLabel(
    action.description ||
      action.text ||
      action.selector ||
      action.value ||
      action.url ||
      action.type,
    fallback
  );
}

function buildSteps(input: BuildFlowMapInput, durationMs: number): FlowStep[] {
  const session = input.session || null;
  const actions = Array.isArray(session?.actions) ? session.actions : [];
  const screenshotsDir = input.screenshotsDir || session?.screenshotsDir || null;
  const screenshotPaths = listScreenshotPaths(screenshotsDir);
  const startedAt = Number(session?.startedAt || 0) > 0 ? Number(session?.startedAt) : null;

  if (actions.length > 0) {
    return actions.map((action, index) => {
      const fallbackImagePath = screenshotPaths[index] || screenshotPaths[Math.min(index, screenshotPaths.length - 1)] || null;
      const imagePath = resolveScreenshotPath(action.screenshotPath, screenshotsDir) || fallbackImagePath;
      const label = actionLabel(action, `Step ${index + 1}`);
      return {
        id: action.id || `action_${String(index + 1).padStart(3, '0')}`,
        index,
        action,
        imagePath,
        title: `Step ${index + 1}`,
        subtitle: label,
        startMs: actionTimestampToMs(action, index, actions.length, startedAt, durationMs),
      };
    });
  }

  const frameSteps = (input.frames || [])
    .filter((frame) => frame.imagePath)
    .map((frame, index) => ({
      id: frame.id || `frame_${String(index + 1).padStart(3, '0')}`,
      index,
      action: null,
      imagePath: frame.imagePath,
      title: `Screen ${index + 1}`,
      subtitle: frame.ocrText ? compactLabel(frame.ocrText, `Frame ${index + 1}`) : `Frame ${index + 1}`,
      startMs: frameTimestampToMs(frame, index, input.frames?.length || 0, durationMs),
      ocrText: frame.ocrText || null,
    }));

  if (frameSteps.length > 0) return frameSteps;

  return screenshotPaths.map((imagePath, index) => ({
    id: `screenshot_${String(index + 1).padStart(3, '0')}`,
    index,
    action: null,
    imagePath,
    title: `Screen ${index + 1}`,
    subtitle: basename(imagePath),
    startMs: screenshotPaths.length <= 1 ? 0 : Math.round((index / Math.max(screenshotPaths.length - 1, 1)) * durationMs),
  }));
}

function makeNodeId(index: number): string {
  return `screen_${String(index + 1).padStart(3, '0')}`;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function buildFlowMap(input: BuildFlowMapInput): FlowMap {
  const session = input.session || null;
  const actions = Array.isArray(session?.actions) ? session.actions : [];
  const durationMs = resolveDurationMs(session, input.durationMs);
  const steps = buildSteps(input, durationMs)
    .filter((step) => step.imagePath || step.action)
    .sort((a, b) => a.startMs - b.startMs || a.index - b.index);

  const nodes: FlowMapNode[] = [];
  const nodeByHash = new Map<string, FlowMapNode>();
  const nodeSequence: string[] = [];

  for (const step of steps) {
    const screenHash = hashFile(step.imagePath);
    const hashKey = screenHash || `${step.imagePath || step.id}`;
    let node = nodeByHash.get(hashKey);

    if (!node) {
      node = {
        id: makeNodeId(nodes.length),
        index: nodes.length,
        title: step.title,
        subtitle: step.subtitle,
        imagePath: step.imagePath,
        imageName: step.imagePath ? basename(step.imagePath) : null,
        screenHash,
        startMs: step.startMs,
        endMs: step.startMs,
        durationMs: 0,
        actionIds: [],
        occurrenceCount: 0,
        aspectRatio: getImageAspectRatio(step.imagePath),
        ocrText: step.ocrText || null,
      };
      nodes.push(node);
      nodeByHash.set(hashKey, node);
    }

    node.startMs = Math.min(node.startMs, step.startMs);
    node.endMs = Math.max(node.endMs, step.startMs);
    node.durationMs = Math.max(0, node.endMs - node.startMs);
    node.occurrenceCount += 1;
    if (step.action?.id) node.actionIds.push(step.action.id);
    nodeSequence.push(node.id);
  }

  const edges: FlowMapEdge[] = [];
  for (let index = 0; index < nodeSequence.length - 1; index += 1) {
    const from = nodeSequence[index];
    const to = nodeSequence[index + 1];
    if (!from || !to || from === to) continue;

    const step = steps[index + 1] || steps[index];
    const action = step?.action || null;
    const fromNode = nodes.find((node) => node.id === from);
    const toNode = nodes.find((node) => node.id === to);
    const startMs = fromNode?.endMs ?? step?.startMs ?? 0;
    const endMs = toNode?.startMs ?? startMs;

    edges.push({
      id: `edge_${String(edges.length + 1).padStart(3, '0')}`,
      index: edges.length,
      from,
      to,
      actionId: action?.id || null,
      label: actionLabel(action, `Transition ${edges.length + 1}`),
      type: action?.type || 'transition',
      startMs: clamp(Math.min(startMs, endMs), 0, durationMs),
      endMs: clamp(Math.max(startMs, endMs), 0, durationMs),
      durationMs: Math.max(0, endMs - startMs),
      status: action ? 'captured' : 'inferred',
    });
  }

  const title = compactLabel(input.title || session?.name || input.owner.id, 'Captured Flow');
  const pathNodeIds = uniqueInOrder(nodeSequence);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    owner: input.owner,
    title,
    platform: String(input.platform || session?.platform || 'unknown'),
    media: {
      videoPath: input.videoPath || session?.videoPath || null,
      durationMs,
      startedAt: Number(session?.startedAt || 0) > 0 ? Number(session?.startedAt) : null,
      endedAt: Number(session?.endedAt || 0) > 0 ? Number(session?.endedAt) : null,
    },
    viewport: session?.viewport || null,
    nodes,
    edges,
    paths: [
      {
        id: 'path_main',
        title,
        nodeIds: pathNodeIds,
        edgeIds: edges.map((edge) => edge.id),
        status: String(session?.status || 'captured'),
      },
    ],
    stats: {
      actionCount: actions.length,
      screenshotCount: steps.filter((step) => !!step.imagePath).length,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      dedupedScreenCount: nodes.length,
      networkEntryCount: Array.isArray(session?.networkEntries) ? session.networkEntries.length : 0,
    },
    artifacts: {
      recordingDir: input.recordingDir || null,
      sessionPath: input.sessionPath || null,
      flowCodePath: input.flowCodePath || null,
      flowMapPath: input.recordingDir ? join(input.recordingDir, 'flow-map.json') : null,
    },
  };
}

export function persistFlowMap(flowMap: FlowMap, recordingDir: string | null | undefined): string | null {
  if (!recordingDir) return null;
  try {
    mkdirSync(recordingDir, { recursive: true });
    const flowMapPath = join(recordingDir, 'flow-map.json');
    const payload: FlowMap = {
      ...flowMap,
      artifacts: {
        ...flowMap.artifacts,
        flowMapPath,
      },
    };
    writeFileSync(flowMapPath, JSON.stringify(payload, null, 2), 'utf8');
    return flowMapPath;
  } catch {
    return null;
  }
}
