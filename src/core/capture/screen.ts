/**
 * DiscoveryLab Screen Capture Module
 * Handles screen recording and screenshot capture across platforms
 */

import { spawn, execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { randomUUID } from 'node:crypto';
import { PROJECTS_DIR } from '../../db/index.js';

// ============================================================================
// TYPES
// ============================================================================
export interface CaptureOptions {
  projectId: string;
  type: 'screenshot' | 'video';
  duration?: number; // seconds, for video
  windowId?: number; // specific window
  displayId?: number; // specific display
  region?: { x: number; y: number; width: number; height: number };
}

export interface CaptureResult {
  success: boolean;
  filePath?: string;
  error?: string;
  duration?: number;
  resolution?: { width: number; height: number };
}

export interface RecordingSession {
  id: string;
  projectId: string;
  process: ReturnType<typeof spawn>;
  outputPath: string;
  startTime: Date;
}

// ============================================================================
// STATE
// ============================================================================
const activeRecordings: Map<string, RecordingSession> = new Map();

// ============================================================================
// HELPERS
// ============================================================================
function ensureProjectDir(projectId: string): string {
  const projectDir = join(PROJECTS_DIR, projectId);
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
  }
  return projectDir;
}

function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

// ============================================================================
// SCREENSHOT CAPTURE
// ============================================================================
export async function captureScreenshot(options: CaptureOptions): Promise<CaptureResult> {
  const projectDir = ensureProjectDir(options.projectId);
  const filename = `screenshot-${getTimestamp()}.png`;
  const outputPath = join(projectDir, filename);

  const os = platform();

  try {
    if (os === 'darwin') {
      return await captureMacScreenshot(outputPath, options);
    } else if (os === 'linux') {
      return await captureLinuxScreenshot(outputPath, options);
    } else if (os === 'win32') {
      return await captureWindowsScreenshot(outputPath, options);
    } else {
      return { success: false, error: `Unsupported platform: ${os}` };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Screenshot capture failed';
    return { success: false, error: message };
  }
}

async function captureMacScreenshot(outputPath: string, options: CaptureOptions): Promise<CaptureResult> {
  const args: string[] = [];

  // Window capture
  if (options.windowId) {
    args.push('-l', options.windowId.toString());
  }

  // Display selection
  if (options.displayId !== undefined) {
    args.push('-D', options.displayId.toString());
  }

  // Region capture
  if (options.region) {
    const { x, y, width, height } = options.region;
    args.push('-R', `${x},${y},${width},${height}`);
  }

  // Output file
  args.push(outputPath);

  return new Promise((resolve) => {
    const proc = spawn('screencapture', args);

    proc.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve({ success: true, filePath: outputPath });
      } else {
        resolve({ success: false, error: `screencapture exited with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

async function captureLinuxScreenshot(outputPath: string, options: CaptureOptions): Promise<CaptureResult> {
  // Use gnome-screenshot or scrot
  const args = ['-f', outputPath];

  if (options.windowId) {
    args.push('-w'); // active window
  }

  return new Promise((resolve) => {
    // Try gnome-screenshot first, fall back to scrot
    let proc = spawn('gnome-screenshot', args);

    proc.on('error', () => {
      // Fall back to scrot
      proc = spawn('scrot', [outputPath]);
    });

    proc.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve({ success: true, filePath: outputPath });
      } else {
        resolve({ success: false, error: `Screenshot failed with code ${code}` });
      }
    });
  });
}

async function captureWindowsScreenshot(outputPath: string, _options: CaptureOptions): Promise<CaptureResult> {
  // Use PowerShell for Windows screenshot
  const psScript = `
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.Screen]::PrimaryScreen | ForEach-Object {
      $bitmap = New-Object System.Drawing.Bitmap($_.Bounds.Width, $_.Bounds.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($_.Bounds.Location, [System.Drawing.Point]::Empty, $_.Bounds.Size)
      $bitmap.Save('${outputPath.replace(/\\/g, '\\\\')}')
    }
  `;

  return new Promise((resolve) => {
    const proc = spawn('powershell', ['-Command', psScript]);

    proc.on('close', (code) => {
      if (code === 0 && existsSync(outputPath)) {
        resolve({ success: true, filePath: outputPath });
      } else {
        resolve({ success: false, error: `PowerShell screenshot failed with code ${code}` });
      }
    });

    proc.on('error', (err) => {
      resolve({ success: false, error: err.message });
    });
  });
}

// ============================================================================
// VIDEO RECORDING
// ============================================================================
export async function startRecording(options: CaptureOptions): Promise<{ sessionId: string } | { error: string }> {
  const projectDir = ensureProjectDir(options.projectId);
  const sessionId = randomUUID();
  const filename = `recording-${getTimestamp()}.mp4`;
  const outputPath = join(projectDir, filename);

  const os = platform();

  try {
    let proc: ReturnType<typeof spawn>;

    if (os === 'darwin') {
      proc = startMacRecording(outputPath, options);
    } else if (os === 'linux') {
      proc = startLinuxRecording(outputPath, options);
    } else if (os === 'win32') {
      proc = startWindowsRecording(outputPath, options);
    } else {
      return { error: `Unsupported platform: ${os}` };
    }

    const session: RecordingSession = {
      id: sessionId,
      projectId: options.projectId,
      process: proc,
      outputPath,
      startTime: new Date(),
    };

    activeRecordings.set(sessionId, session);

    // Auto-stop after duration if specified
    if (options.duration) {
      setTimeout(() => {
        stopRecording(sessionId);
      }, options.duration * 1000);
    }

    return { sessionId };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to start recording';
    return { error: message };
  }
}

function startMacRecording(outputPath: string, options: CaptureOptions): ReturnType<typeof spawn> {
  const args: string[] = [
    '-f', 'avfoundation',
    '-framerate', '30',
  ];

  // Input source (display:audio)
  if (options.displayId !== undefined) {
    args.push('-i', `${options.displayId}:none`);
  } else {
    args.push('-i', '1:none'); // Default to main display
  }

  // Video codec
  args.push('-c:v', 'libx264');
  args.push('-preset', 'ultrafast');
  args.push('-crf', '23');

  // Pixel format for compatibility
  args.push('-pix_fmt', 'yuv420p');

  // Output
  args.push('-y', outputPath);

  return spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function startLinuxRecording(outputPath: string, options: CaptureOptions): ReturnType<typeof spawn> {
  const display = process.env.DISPLAY || ':0';

  const args: string[] = [
    '-f', 'x11grab',
    '-framerate', '30',
    '-i', display,
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-y', outputPath,
  ];

  return spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

function startWindowsRecording(outputPath: string, _options: CaptureOptions): ReturnType<typeof spawn> {
  const args: string[] = [
    '-f', 'gdigrab',
    '-framerate', '30',
    '-i', 'desktop',
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-y', outputPath,
  ];

  return spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
}

export async function stopRecording(sessionId: string): Promise<CaptureResult> {
  const session = activeRecordings.get(sessionId);

  if (!session) {
    return { success: false, error: `Recording session not found: ${sessionId}` };
  }

  return new Promise((resolve) => {
    // Send 'q' to FFmpeg to stop gracefully
    if (session.process.stdin) {
      session.process.stdin.write('q');
      session.process.stdin.end();
    }

    const timeout = setTimeout(() => {
      session.process.kill('SIGKILL');
    }, 5000);

    session.process.on('close', () => {
      clearTimeout(timeout);
      activeRecordings.delete(sessionId);

      const duration = (Date.now() - session.startTime.getTime()) / 1000;

      if (existsSync(session.outputPath)) {
        resolve({
          success: true,
          filePath: session.outputPath,
          duration,
        });
      } else {
        resolve({ success: false, error: 'Recording file not found' });
      }
    });
  });
}

export function getActiveRecordings(): string[] {
  return Array.from(activeRecordings.keys());
}

export function isRecording(sessionId: string): boolean {
  return activeRecordings.has(sessionId);
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================
export function checkFFmpeg(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function listDisplays(): string[] {
  const os = platform();

  if (os === 'darwin') {
    try {
      // List available capture devices on macOS
      const output = execSync('ffmpeg -f avfoundation -list_devices true -i "" 2>&1 || true', {
        encoding: 'utf-8',
      });
      const lines = output.split('\n');
      const displays: string[] = [];

      let inVideoDevices = false;
      for (const line of lines) {
        if (line.includes('AVFoundation video devices')) {
          inVideoDevices = true;
          continue;
        }
        if (line.includes('AVFoundation audio devices')) {
          break;
        }
        if (inVideoDevices && line.includes(']')) {
          const match = line.match(/\[(\d+)\]\s+(.+)/);
          if (match) {
            displays.push(`${match[1]}: ${match[2]}`);
          }
        }
      }

      return displays;
    } catch {
      return ['0: Default Display'];
    }
  }

  return ['0: Default Display'];
}

export function listWindows(): Array<{ id: number; name: string }> {
  const os = platform();

  if (os === 'darwin') {
    try {
      // Use AppleScript to list windows
      const script = `
        tell application "System Events"
          set windowList to {}
          repeat with proc in (every process whose background only is false)
            try
              repeat with win in (every window of proc)
                set end of windowList to (id of win as text) & ":" & (name of win)
              end repeat
            end try
          end repeat
          return windowList
        end tell
      `;

      const output = execSync(`osascript -e '${script}'`, { encoding: 'utf-8' });
      const windows = output.trim().split(', ').map((w) => {
        const [id, ...nameParts] = w.split(':');
        return { id: parseInt(id, 10), name: nameParts.join(':') };
      });

      return windows.filter((w) => !isNaN(w.id));
    } catch {
      return [];
    }
  }

  return [];
}
