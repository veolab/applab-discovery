/**
 * DiscoveryLab HTTP Server
 * Hono-based server for serving the web UI and API endpoints
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { readFileSync, existsSync } from 'node:fs';
import { exec, execSync, spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, desc } from 'drizzle-orm';
import { getDatabase, getSqlite, projects, projectExports, frames, DATA_DIR, PROJECTS_DIR } from '../db/index.js';
import { getMaestroRecorder, isMaestroInstalled, runMaestroTest, isIdbInstalled, tapViaIdb, killZombieMaestroProcesses } from '../core/testing/maestro.js';
import type { MaestroRecordingSession } from '../core/testing/maestro.js';
import { analyzeScreenshotsForActions, generateMaestroYaml } from '../core/analyze/aiActionDetector.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================================
// ANDROID SDK DETECTION (like VS Code does it)
// ============================================================================

import { homedir, tmpdir } from 'node:os';

/**
 * Find Android SDK path - checks environment variables and common locations
 */
function findAndroidSdkPath(): string | null {
  // Check environment variables first
  const envPaths = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_SDK,
  ].filter(Boolean);

  for (const envPath of envPaths) {
    if (envPath && existsSync(join(envPath, 'platform-tools', 'adb'))) {
      return envPath;
    }
  }

  // Common SDK locations on macOS
  const home = homedir();
  const commonPaths = [
    join(home, 'Library', 'Android', 'sdk'),
    join(home, 'Android', 'Sdk'),
    '/opt/android-sdk',
    '/usr/local/android-sdk',
  ];

  for (const sdkPath of commonPaths) {
    if (existsSync(join(sdkPath, 'platform-tools', 'adb'))) {
      return sdkPath;
    }
  }

  return null;
}

/**
 * Get ADB path - returns full path to adb executable
 */
function getAdbPath(): string | null {
  const sdkPath = findAndroidSdkPath();
  if (sdkPath) {
    return join(sdkPath, 'platform-tools', 'adb');
  }
  return null;
}

/**
 * Get emulator path - returns full path to emulator executable
 */
function getEmulatorPath(): string | null {
  const sdkPath = findAndroidSdkPath();
  if (sdkPath) {
    return join(sdkPath, 'emulator', 'emulator');
  }
  return null;
}

// Cache the paths
const ADB_PATH = getAdbPath();
const EMULATOR_PATH = getEmulatorPath();

// ============================================================================
// AI-POWERED PROJECT NAMING
// ============================================================================

/**
 * Generate a meaningful project name from OCR text
 * Analyzes extracted text to identify app names, screen names, and key content
 */
function generateSmartProjectName(ocrText: string, fallbackName: string): string {
  if (!ocrText || ocrText.trim().length < 3) {
    return fallbackName;
  }

  // Common UI patterns to detect
  const patterns = {
    // App names often appear in headers/titles
    appName: /^([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?)\s*$/m,
    // Screen titles like "Settings", "Profile", "Home"
    screenTitle: /^(Settings|Profile|Home|Dashboard|Login|Sign\s*[Ii]n|Sign\s*[Uu]p|Cart|Checkout|Search|Messages|Notifications|Account|Orders|Products|Menu|About|Contact|Help)$/im,
    // Navigation items
    navItem: /(Home|Back|Next|Done|Cancel|Save|Edit|Delete|Add|Create|New|View|Share|Send)/i,
    // Form labels
    formLabel: /(Email|Password|Username|Name|Phone|Address|Date|Time|Amount|Price)/i,
  };

  const lines = ocrText.split('\n').map(l => l.trim()).filter(l => l.length > 2 && l.length < 50);
  const words = ocrText.split(/\s+/).filter(w => w.length > 2);

  // Try to find app/screen name in first few lines
  const firstLines = lines.slice(0, 5);
  for (const line of firstLines) {
    // Check for capitalized title-like text
    if (/^[A-Z][a-zA-Z\s]{2,30}$/.test(line) && !/^\d/.test(line)) {
      // Avoid generic words
      const generic = ['loading', 'please', 'wait', 'error', 'success', 'welcome', 'hello'];
      if (!generic.some(g => line.toLowerCase().includes(g))) {
        return line.slice(0, 40);
      }
    }
  }

  // Look for screen type patterns
  for (const line of lines) {
    const screenMatch = line.match(patterns.screenTitle);
    if (screenMatch) {
      return `${screenMatch[1]} Screen`;
    }
  }

  // Extract most frequent meaningful words
  const wordFreq = new Map<string, number>();
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'up',
    'about', 'into', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'under', 'again', 'further', 'then', 'once',
    'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just', 'now',
    'it', 'its', 'this', 'that', 'these', 'those', 'i', 'you', 'he',
    'she', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your',
    'tap', 'click', 'press', 'swipe', 'scroll', 'ok', 'yes', 'no',
  ]);

  for (const word of words) {
    const cleanWord = word.toLowerCase().replace(/[^\w]/g, '');
    if (cleanWord.length > 2 && !stopWords.has(cleanWord) && !/^\d+$/.test(cleanWord)) {
      wordFreq.set(cleanWord, (wordFreq.get(cleanWord) || 0) + 1);
    }
  }

  // Get top 3 keywords
  const topWords = Array.from(wordFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([word]) => word.charAt(0).toUpperCase() + word.slice(1));

  if (topWords.length > 0) {
    return topWords.join(' ');
  }

  return fallbackName;
}

/**
 * Analyze frames and select the best one for thumbnail
 * Best = frame with most text content (indicates meaningful screen)
 */
interface FrameAnalysis {
  path: string;
  textLength: number;
  text: string;
}

async function selectBestFrame(framePaths: string[]): Promise<{ bestFrame: string | null; analyses: FrameAnalysis[] }> {
  if (framePaths.length === 0) {
    return { bestFrame: null, analyses: [] };
  }

  const { recognizeText } = await import('../core/analyze/ocr.js');
  const analyses: FrameAnalysis[] = [];

  for (const framePath of framePaths.slice(0, 10)) { // Analyze max 10 frames
    try {
      const result = await recognizeText(framePath);
      analyses.push({
        path: framePath,
        textLength: result.success && result.text ? result.text.length : 0,
        text: result.success && result.text ? result.text : '',
      });
    } catch {
      analyses.push({ path: framePath, textLength: 0, text: '' });
    }
  }

  // Sort by text length descending
  analyses.sort((a, b) => b.textLength - a.textLength);

  // Select frame with most text, or middle frame if no text found
  const bestFrame = analyses[0]?.textLength > 50
    ? analyses[0].path
    : framePaths[Math.floor(framePaths.length / 2)] || framePaths[0];

  return { bestFrame, analyses };
}

// ============================================================================
// APP SETUP
// ============================================================================
const app = new Hono();

// CORS for development
app.use('*', cors());

// ============================================================================
// SETUP WIZARD PAGE
// ============================================================================
app.get('/setup', async (c) => {
  return c.html(`
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>DiscoveryLab Setup</title>
    <style>
        :root {
            --bg-primary: #0a0a0a;
            --bg-surface: #111111;
            --bg-elevated: #1a1a1a;
            --text-primary: #ffffff;
            --text-secondary: #888888;
            --accent: #0A84FF;
            --success: #30D158;
            --warning: #FF9F0A;
            --error: #FF453A;
            --border: #333333;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'SF Mono', 'Menlo', monospace;
            background: var(--bg-primary);
            color: var(--text-primary);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 24px;
        }
        .setup-container {
            max-width: 700px;
            width: 100%;
        }
        .header {
            text-align: center;
            margin-bottom: 48px;
        }
        .logo {
            font-size: 32px;
            font-weight: bold;
            margin-bottom: 8px;
        }
        .logo span { color: var(--accent); }
        .subtitle {
            color: var(--text-secondary);
            font-size: 14px;
        }
        .terminal {
            background: var(--bg-surface);
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
        }
        .terminal-header {
            background: var(--bg-elevated);
            padding: 12px 16px;
            display: flex;
            align-items: center;
            gap: 8px;
            border-bottom: 1px solid var(--border);
        }
        .terminal-dot {
            width: 12px;
            height: 12px;
            border-radius: 50%;
        }
        .terminal-dot.red { background: #FF5F56; }
        .terminal-dot.yellow { background: #FFBD2E; }
        .terminal-dot.green { background: #27CA40; }
        .terminal-title {
            margin-left: auto;
            color: var(--text-secondary);
            font-size: 12px;
        }
        .terminal-body {
            padding: 24px;
            font-size: 14px;
            line-height: 1.8;
        }
        .line {
            display: flex;
            align-items: center;
            gap: 12px;
            padding: 8px 0;
            border-bottom: 1px solid var(--border);
        }
        .line:last-child { border-bottom: none; }
        .status-icon {
            width: 24px;
            height: 24px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 14px;
            flex-shrink: 0;
        }
        .status-icon.ok { background: rgba(48, 209, 88, 0.2); color: var(--success); }
        .status-icon.missing { background: rgba(255, 69, 58, 0.2); color: var(--error); }
        .status-icon.optional { background: rgba(255, 159, 10, 0.2); color: var(--warning); }
        .status-icon.loading { background: rgba(10, 132, 255, 0.2); color: var(--accent); animation: pulse 1s infinite; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
        .dep-info {
            flex: 1;
        }
        .dep-name {
            font-weight: 500;
        }
        .dep-version {
            color: var(--text-secondary);
            font-size: 12px;
        }
        .dep-action {
            font-size: 12px;
        }
        .dep-action a {
            color: var(--accent);
            text-decoration: none;
        }
        .dep-action a:hover { text-decoration: underline; }
        .install-cmd {
            background: var(--bg-primary);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 12px;
            color: var(--text-secondary);
            cursor: pointer;
            border: 1px solid var(--border);
            transition: all 0.2s;
        }
        .install-cmd:hover {
            border-color: var(--accent);
            color: var(--text-primary);
        }
        .progress-section {
            margin-top: 32px;
            padding-top: 24px;
            border-top: 1px solid var(--border);
        }
        .progress-bar {
            height: 4px;
            background: var(--bg-elevated);
            border-radius: 2px;
            overflow: hidden;
            margin-bottom: 16px;
        }
        .progress-fill {
            height: 100%;
            background: var(--accent);
            border-radius: 2px;
            transition: width 0.5s ease;
        }
        .progress-text {
            display: flex;
            justify-content: space-between;
            font-size: 12px;
            color: var(--text-secondary);
        }
        .btn-primary {
            display: block;
            width: 100%;
            padding: 16px;
            border: none;
            border-radius: 10px;
            background: var(--accent);
            color: white;
            font-size: 16px;
            font-weight: 500;
            cursor: pointer;
            margin-top: 24px;
            font-family: inherit;
            transition: all 0.2s;
        }
        .btn-primary:hover { background: #409CFF; }
        .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; }
        .footer-note {
            text-align: center;
            margin-top: 24px;
            font-size: 12px;
            color: var(--text-secondary);
        }
        .footer-note a { color: var(--accent); text-decoration: none; }
    </style>
</head>
<body>
    <div class="setup-container">
        <div class="header">
            <div class="logo">Discovery<span>Lab</span></div>
            <div class="subtitle">AI-Powered App Testing & Evidence Generator</div>
        </div>

        <div class="terminal">
            <div class="terminal-header">
                <div class="terminal-dot red"></div>
                <div class="terminal-dot yellow"></div>
                <div class="terminal-dot green"></div>
                <span class="terminal-title">Setup Wizard</span>
            </div>
            <div class="terminal-body" id="setupContent">
                <div style="text-align: center; padding: 40px;">
                    <div class="status-icon loading" style="margin: 0 auto 16px; width: 40px; height: 40px; font-size: 20px;">...</div>
                    <div>Checking dependencies...</div>
                </div>
            </div>
        </div>

        <button class="btn-primary" id="continueBtn" disabled onclick="window.location.href='/'">
            Continue to DiscoveryLab
        </button>

        <div class="footer-note">
            Need help? Check the <a href="https://github.com/yourusername/discoverylab" target="_blank">documentation</a>
        </div>
    </div>

    <script>
        async function checkDependencies() {
            try {
                const response = await fetch('/api/setup/status');
                const data = await response.json();
                renderStatus(data);
            } catch (error) {
                document.getElementById('setupContent').innerHTML = \`
                    <div style="color: var(--error); text-align: center; padding: 24px;">
                        Failed to check dependencies. Is the server running?
                    </div>
                \`;
            }
        }

        function renderStatus(data) {
            const container = document.getElementById('setupContent');
            const deps = data.dependencies || [];
            const required = deps.filter(d => d.required);
            const optional = deps.filter(d => !d.required);
            const installedRequired = required.filter(d => d.installed).length;
            const totalRequired = required.length;
            const progress = totalRequired > 0 ? (installedRequired / totalRequired) * 100 : 100;

            let html = '';

            // Required dependencies
            html += '<div style="margin-bottom: 24px;"><div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px;">REQUIRED</div>';
            for (const dep of required) {
                html += renderDep(dep);
            }
            html += '</div>';

            // Optional dependencies
            if (optional.length > 0) {
                html += '<div><div style="color: var(--text-secondary); font-size: 12px; margin-bottom: 12px;">OPTIONAL</div>';
                for (const dep of optional) {
                    html += renderDep(dep);
                }
                html += '</div>';
            }

            // Progress section
            html += \`
                <div class="progress-section">
                    <div class="progress-bar">
                        <div class="progress-fill" style="width: \${progress}%"></div>
                    </div>
                    <div class="progress-text">
                        <span>\${installedRequired}/\${totalRequired} required dependencies</span>
                        <span>\${data.ready ? 'Ready!' : 'Install missing dependencies'}</span>
                    </div>
                </div>
            \`;

            container.innerHTML = html;

            // Enable continue button if ready
            const btn = document.getElementById('continueBtn');
            if (data.ready) {
                btn.disabled = false;
                btn.textContent = 'Continue to DiscoveryLab';
            } else {
                btn.disabled = false;
                btn.textContent = 'Continue Anyway (some features may not work)';
            }
        }

        function renderDep(dep) {
            const statusClass = dep.installed ? 'ok' : (dep.required ? 'missing' : 'optional');
            const statusIcon = dep.installed ? '✓' : (dep.required ? '✗' : '○');
            const version = dep.installed ? dep.version : 'not installed';

            let actionHtml = '';
            if (!dep.installed && dep.installHint) {
                actionHtml = \`
                    <div class="dep-action">
                        <code class="install-cmd" onclick="copyCommand(this)" title="Click to copy">\${dep.installHint}</code>
                    </div>
                \`;
            } else if (dep.installed) {
                actionHtml = '<div class="dep-action" style="color: var(--success);">Installed</div>';
            }

            return \`
                <div class="line">
                    <div class="status-icon \${statusClass}">\${statusIcon}</div>
                    <div class="dep-info">
                        <div class="dep-name">\${dep.name}</div>
                        <div class="dep-version">\${version}</div>
                    </div>
                    \${actionHtml}
                </div>
            \`;
        }

        function copyCommand(el) {
            navigator.clipboard.writeText(el.textContent);
            const original = el.textContent;
            el.textContent = 'Copied!';
            el.style.color = 'var(--success)';
            setTimeout(() => {
                el.textContent = original;
                el.style.color = '';
            }, 1500);
        }

        // Start checking
        checkDependencies();

        // Refresh every 5 seconds
        setInterval(checkDependencies, 5000);
    </script>
</body>
</html>
  `);
});

// ============================================================================
// STATIC FILES
// ============================================================================
app.get('/', (c) => {
  const cwd = process.cwd();

  // Check multiple possible locations for the HTML file
  // Prioritize __dirname (absolute) over process.cwd() (relative) for npm-installed packages
  const possiblePaths = [
    join(__dirname, 'index.html'),                 // Production: bundled (dist/index.html alongside server)
    join(__dirname, '..', 'web', 'index.html'),   // Parent/web
    join(__dirname, '..', '..', 'src', 'web', 'index.html'), // Two levels up/src/web
    join(cwd, 'src', 'web', 'index.html'),        // Development: running from project root
    join(cwd, 'dist', 'index.html'),              // Production: running from project root
  ];

  for (const path of possiblePaths) {
    if (existsSync(path)) {
      const html = readFileSync(path, 'utf-8');
      return c.html(html);
    }
  }

  return c.html(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>DiscoveryLab</title>
      <style>
        body { font-family: system-ui; background: #000; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
        .container { text-align: center; }
        h1 { color: #0A84FF; }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>DiscoveryLab</h1>
        <p>UI files not found. Run from project root.</p>
      </div>
    </body>
    </html>
  `);
});

// ============================================================================
// HEALTH CHECK
// ============================================================================
app.get('/api/health', (c) => {
  return c.json({
    status: 'ok',
    version: '0.1.0',
    timestamp: new Date().toISOString(),
  });
});

// ============================================================================
// PROJECTS API
// ============================================================================

function parseJsonField<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

type ProjectRecord = typeof projects.$inferSelect;
type NormalizedProjectRecord = ProjectRecord & {
  tags: string[];
  taskHubLinks: unknown[];
  taskRequirements: unknown[];
  taskTestMap: unknown[];
};

function normalizeProjectRecord(project: ProjectRecord): NormalizedProjectRecord {
  const normalized = {
    ...project,
    tags: parseJsonField(project.tags, [] as string[]),
    taskHubLinks: parseJsonField(project.taskHubLinks, [] as unknown[]),
    taskRequirements: parseJsonField(project.taskRequirements, [] as unknown[]),
    taskTestMap: parseJsonField(project.taskTestMap, [] as unknown[]),
  } as NormalizedProjectRecord;

  return normalized;
}

// List projects
app.get('/api/projects', async (c) => {
  try {
    const db = getDatabase();
    const status = c.req.query('status');
    const platform = c.req.query('platform');
    const limit = parseInt(c.req.query('limit') || '20', 10);

    let results = await db.select().from(projects).orderBy(desc(projects.updatedAt)).limit(limit);

    // Filter if needed
    if (status) {
      results = results.filter((p) => p.status === status);
    }
    if (platform) {
      results = results.filter((p) => p.platform === platform);
    }

    return c.json({
      count: results.length,
      projects: results.map((p) => normalizeProjectRecord(p as ProjectRecord)),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const statusCode = message === 'Recording already in progress' ? 409 : 500;
    return c.json({ error: message }, statusCode);
  }
});

// Delete all projects
app.delete('/api/projects/all', async (c) => {
  try {
    const db = getDatabase();
    const { rmSync, existsSync } = await import('node:fs');

    // Get all projects to delete their files
    const allProjects = await db.select().from(projects);

    // Delete project files
    for (const project of allProjects) {
      if (project.videoPath && existsSync(project.videoPath)) {
        try {
          const projectDir = project.videoPath.substring(0, project.videoPath.lastIndexOf('/'));
          rmSync(projectDir, { recursive: true, force: true });
        } catch {}
      }
    }

    // Delete from database
    await db.delete(frames);
    await db.delete(projectExports);
    await db.delete(projects);

    return c.json({ success: true, deleted: allProjects.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get single project
app.get('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const { existsSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = normalizeProjectRecord(result[0] as ProjectRecord);

    // Get exports
    const exports = await db
      .select()
      .from(projectExports)
      .where(eq(projectExports.projectId, id))
      .orderBy(desc(projectExports.createdAt));

    // Get frames
    const projectFrames = await db
      .select()
      .from(frames)
      .where(eq(frames.projectId, id))
      .orderBy(frames.frameNumber);

    // Try to load actions and viewport from session.json if project has videoPath (recording directory)
    let actions: any[] = [];
    let viewport: { width: number; height: number } | undefined;
    let actualVideoPath: string | null = project.videoPath;

    if (project.videoPath && existsSync(project.videoPath)) {
      const { readdirSync, statSync } = await import('node:fs');

      // Check if videoPath is a directory
      if (statSync(project.videoPath).isDirectory()) {
        // Look for video file in the video subdirectory
        const videoDir = join(project.videoPath, 'video');
        if (existsSync(videoDir) && statSync(videoDir).isDirectory()) {
          const videoFiles = readdirSync(videoDir).filter(f =>
            /\.(mp4|mov|webm)$/i.test(f)
          );
          if (videoFiles.length > 0) {
            actualVideoPath = join(videoDir, videoFiles[0]);
          }
        }

        // Also check for video directly in the recording directory
        if (actualVideoPath === project.videoPath) {
          const directFiles = readdirSync(project.videoPath).filter(f =>
            /\.(mp4|mov|webm)$/i.test(f)
          );
          if (directFiles.length > 0) {
            actualVideoPath = join(project.videoPath, directFiles[0]);
          }
        }
      }

      const sessionPath = join(project.videoPath, 'session.json');
      if (existsSync(sessionPath)) {
        try {
          const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
          if (sessionData.actions && Array.isArray(sessionData.actions)) {
            actions = sessionData.actions;
          }
          if (sessionData.viewport) {
            viewport = sessionData.viewport;
          }
        } catch (e) {
          // Ignore parsing errors
        }
      }
    }

    return c.json({
      ...project,
      videoPath: actualVideoPath, // Return the actual video file path
      exports,
      frames: projectFrames,
      actions,
      viewport,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Create project
app.post('/api/projects', async (c) => {
  try {
    const db = getDatabase();
    const body = await c.req.json();

    const id = crypto.randomUUID();
    const now = new Date();

    await db.insert(projects).values({
      id,
      name: body.name || 'Untitled Project',
      platform: body.platform || null,
      linkedTicket: body.linkedTicket || null,
      tags: body.tags ? JSON.stringify(body.tags) : null,
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    return c.json({ id, message: 'Project created' }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Sync orphan project directories to database
app.post('/api/projects/sync-orphans', async (c) => {
  try {
    const db = getDatabase();
    const { readdirSync, statSync, existsSync } = await import('node:fs');

    // Ensure PROJECTS_DIR exists
    if (!existsSync(PROJECTS_DIR)) {
      return c.json({ synced: 0, projects: [], message: 'Projects directory does not exist' });
    }

    // List all directories in PROJECTS_DIR
    const dirs = readdirSync(PROJECTS_DIR)
      .filter(d => {
        const p = join(PROJECTS_DIR, d);
        return statSync(p).isDirectory() && !d.startsWith('.');
      });

    // Get existing project IDs from DB
    const existing = await db.select({ id: projects.id }).from(projects);
    const existingIds = new Set(existing.map(p => p.id));

    // Find orphans (exclude special directories)
    const specialDirs = new Set(['maestro-recordings', 'web-recordings', 'frames']);
    const orphans = dirs.filter(d => !existingIds.has(d) && !specialDirs.has(d));

    // Create DB entries for orphans
    const created: string[] = [];
    for (const id of orphans) {
      const dirPath = join(PROJECTS_DIR, id);
      const platform = id.includes('_web_') ? 'web' : 'mobile';
      const now = new Date();

      await db.insert(projects).values({
        id,
        name: `Imported - ${id}`,
        videoPath: dirPath,
        platform,
        status: 'ready',
        createdAt: now,
        updatedAt: now
      });
      created.push(id);
    }

    return c.json({ synced: created.length, projects: created });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update project
app.patch('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const body = await c.req.json();

    // Check exists
    const existing = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (existing.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const updates: any = { updatedAt: new Date() };

    if (body.name !== undefined) updates.name = body.name;
    if (body.manualNotes !== undefined) updates.manualNotes = body.manualNotes;
    if (body.tags !== undefined) updates.tags = JSON.stringify(body.tags);
    if (body.linkedTicket !== undefined) updates.linkedTicket = body.linkedTicket;
    if (body.status !== undefined) updates.status = body.status;
    if (body.aiSummary !== undefined) updates.aiSummary = body.aiSummary;

    await db.update(projects).set(updates).where(eq(projects.id, id));

    return c.json({ message: 'Project updated' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Update project external links (Jira, Notion, Figma)
app.put('/api/projects/:id/links', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const body = await c.req.json();

    // Check exists
    const existing = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (existing.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const updates: any = { updatedAt: new Date() };

    // Legacy single URL fields (backwards compatibility)
    if (body.linkedJiraUrl !== undefined) updates.linkedJiraUrl = body.linkedJiraUrl;
    if (body.linkedNotionUrl !== undefined) updates.linkedNotionUrl = body.linkedNotionUrl;
    if (body.linkedFigmaUrl !== undefined) updates.linkedFigmaUrl = body.linkedFigmaUrl;

    // Task Hub - Multiple links with metadata
    if (body.taskHubLinks !== undefined) {
      updates.taskHubLinks = typeof body.taskHubLinks === 'string'
        ? body.taskHubLinks
        : JSON.stringify(body.taskHubLinks);
    }
    if (body.taskRequirements !== undefined) {
      updates.taskRequirements = typeof body.taskRequirements === 'string'
        ? body.taskRequirements
        : JSON.stringify(body.taskRequirements);
    }
    if (body.taskTestMap !== undefined) {
      updates.taskTestMap = typeof body.taskTestMap === 'string'
        ? body.taskTestMap
        : JSON.stringify(body.taskTestMap);
    }

    await db.update(projects).set(updates).where(eq(projects.id, id));

    return c.json({
      message: 'Links updated',
      linkedJiraUrl: body.linkedJiraUrl || null,
      linkedNotionUrl: body.linkedNotionUrl || null,
      linkedFigmaUrl: body.linkedFigmaUrl || null,
      taskHubLinks: body.taskHubLinks || null,
      taskRequirements: body.taskRequirements || null,
      taskTestMap: body.taskTestMap || null
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// MCP INTEGRATION ENDPOINTS - Fetch metadata from Jira, Notion, Figma
// ============================================================================

function extractJiraIssueKey(url: string): string | null {
  const ticketMatch = url.match(/([A-Z][A-Z0-9]+-\d+)/);
  return ticketMatch ? ticketMatch[1] : null;
}

function jiraAdfToPlainText(node: unknown): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(jiraAdfToPlainText).join('');
  if (typeof node !== 'object') return '';

  const record = node as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : '';
  const content = jiraAdfToPlainText(record.content);

  switch (type) {
    case 'text':
      return typeof record.text === 'string' ? record.text : '';
    case 'paragraph':
      return `${content}\n`;
    case 'hardBreak':
      return '\n';
    case 'bulletList':
    case 'orderedList':
      return `${content}\n`;
    case 'listItem':
      return content ? `• ${content}` : '';
    default:
      return content;
  }
}

function sanitizeJiraText(text: string, maxLength = 600): string {
  const trimmed = text.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}…`;
}

async function fetchJiraIssueDetails(
  baseUrl: string,
  issueKey: string
): Promise<{
  summary: string;
  status: string | null;
  description: string | null;
  assigneeName: string | null;
  priority: string | null;
  issueType: string | null;
  reporterName: string | null;
} | null> {
  const jiraEmail = process.env.JIRA_EMAIL;
  const jiraToken = process.env.JIRA_API_TOKEN;
  if (!jiraEmail || !jiraToken) return null;

  try {
    const authHeader = `Basic ${Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64')}`;
    const url = `${baseUrl}/rest/api/3/issue/${issueKey}?fields=summary,status,assignee,description,priority,issuetype,reporter`;
    const response = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: authHeader,
      },
    });
    if (!response.ok) return null;

    const data = await response.json() as { fields?: Record<string, unknown> };
    const fields = data.fields || {};

    const summary = typeof fields.summary === 'string' ? fields.summary : issueKey;
    const statusName = (fields.status as { name?: string } | undefined)?.name || null;
    const assigneeName = (fields.assignee as { displayName?: string } | undefined)?.displayName || null;
    const priorityName = (fields.priority as { name?: string } | undefined)?.name || null;
    const issueType = (fields.issuetype as { name?: string } | undefined)?.name || null;
    const reporterName = (fields.reporter as { displayName?: string } | undefined)?.displayName || null;

    let descriptionText: string | null = null;
    if (typeof fields.description === 'string') {
      descriptionText = fields.description;
    } else if (fields.description) {
      descriptionText = jiraAdfToPlainText(fields.description);
    }

    const description = descriptionText ? sanitizeJiraText(descriptionText) : null;

    return {
      summary,
      status: statusName,
      description,
      assigneeName,
      priority: priorityName,
      issueType,
      reporterName,
    };
  } catch (error) {
    console.warn('[Jira] Failed to fetch issue details:', error instanceof Error ? error.message : error);
    return null;
  }
}

// Helper function to extract metadata from URL
async function extractLinkMetadata(
  url: string,
  type: string
): Promise<{ success: boolean; metadata: any; error?: string }> {
  try {
    const parsedUrl = new URL(url);

    switch (type) {
      case 'jira': {
        const ticketKey = extractJiraIssueKey(url);
        const baseUrl = process.env.JIRA_BASE_URL || parsedUrl.origin;
        const metadata: Record<string, unknown> = {
          ticketKey,
          domain: parsedUrl.hostname,
          baseUrl,
          type: 'jira',
          title: ticketKey ? `Jira Issue ${ticketKey}` : 'Jira Issue',
          status: null,
          description: null,
          assignee: null,
          assigneeName: null,
          priority: null,
          issueType: null,
          reporterName: null,
          mcpAvailable: false,
          fetchedAt: new Date().toISOString()
        };

        if (ticketKey) {
          const details = await fetchJiraIssueDetails(baseUrl, ticketKey);
          if (details) {
            metadata.title = `${ticketKey} — ${details.summary}`;
            metadata.status = details.status;
            metadata.description = details.description;
            metadata.assigneeName = details.assigneeName;
            metadata.priority = details.priority;
            metadata.issueType = details.issueType;
            metadata.reporterName = details.reporterName;
            metadata.mcpAvailable = true;
            metadata.fetchedAt = new Date().toISOString();
          }
        }

        return { success: true, metadata };
      }

      case 'notion': {
        const pageIdMatch = url.match(/([a-f0-9]{32}|[a-f0-9-]{36})/i);
        const pageId = pageIdMatch ? pageIdMatch[1] : null;

        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const pageName = pathParts[pathParts.length - 1]?.replace(/-[a-f0-9]{32}$/i, '').replace(/-/g, ' ');

        return {
          success: true,
          metadata: {
            pageId,
            domain: parsedUrl.hostname,
            type: 'notion',
            title: pageName || 'Notion Page',
            workspace: pathParts[0] || null,
            content: null,
            lastEdited: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'figma': {
        const fileMatch = url.match(/file\/([a-zA-Z0-9]+)/);
        const nodeMatch = url.match(/node-id=([^&]+)/);
        const fileKey = fileMatch ? fileMatch[1] : null;
        const nodeId = nodeMatch ? decodeURIComponent(nodeMatch[1]) : null;

        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const fileName = pathParts[2]?.replace(/-/g, ' ') || 'Figma Design';

        return {
          success: true,
          metadata: {
            fileKey,
            nodeId,
            domain: parsedUrl.hostname,
            type: 'figma',
            title: fileName,
            thumbnailUrl: null,
            lastModified: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      case 'github': {
        const pathParts = parsedUrl.pathname.split('/').filter(Boolean);
        const owner = pathParts[0];
        const repo = pathParts[1];
        const itemType = pathParts[2];
        const itemNumber = pathParts[3];

        return {
          success: true,
          metadata: {
            owner,
            repo,
            itemType: itemType === 'pull' ? 'pull_request' : itemType,
            itemNumber: itemNumber ? parseInt(itemNumber) : null,
            domain: parsedUrl.hostname,
            type: 'github',
            title: itemNumber ? `${owner}/${repo}#${itemNumber}` : `${owner}/${repo}`,
            state: null,
            labels: null,
            mcpAvailable: false,
            fetchedAt: new Date().toISOString()
          }
        };
      }

      default:
        return { success: false, metadata: null, error: `Unsupported link type: ${type}` };
    }
  } catch (err) {
    return { success: false, metadata: null, error: err instanceof Error ? err.message : 'Invalid URL' };
  }
}

// Fetch metadata from external link via MCP or web fetch
app.post('/api/mcp/fetch', async (c) => {
  try {
    const body = await c.req.json();
    const { url, type } = body;

    if (!url || !type) {
      return c.json({ error: 'URL and type are required' }, 400);
    }

    const result = await extractLinkMetadata(url, type);

    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      success: true,
      metadata: result.metadata,
      message: 'Basic metadata extracted. Full MCP integration pending.'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Batch fetch metadata for multiple links
app.post('/api/mcp/fetch-batch', async (c) => {
  try {
    const body = await c.req.json();
    const { links } = body;

    if (!Array.isArray(links)) {
      return c.json({ error: 'Links array is required' }, 400);
    }

    const results = await Promise.all(
      links.map(async (link: { id: string; url: string; type: string }) => {
        const result = await extractLinkMetadata(link.url, link.type);
        return {
          id: link.id,
          success: result.success,
          metadata: result.metadata,
          error: result.error || null
        };
      })
    );

    return c.json({
      success: true,
      results
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// AI PROCESSING ENDPOINT - Generate requirements and test map from links
// ============================================================================

// Generate requirements and test map from linked content
app.post('/api/ai/generate-task-info', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, links } = body;

    if (!projectId) {
      return c.json({ error: 'Project ID is required' }, 400);
    }

    if (!links || !Array.isArray(links) || links.length === 0) {
      return c.json({ error: 'At least one link is required' }, 400);
    }

    // Analyze links and generate requirements based on link types and metadata
    const requirements: { id: string; text: string; source: string; priority: string }[] = [];
    const testMap: { id: string; description: string; type: string; completed: boolean }[] = [];

    // Process each link to generate requirements
    for (const link of links) {
      const { type, title, url, metadata } = link;

      switch (type) {
        case 'jira': {
          const ticketKey = metadata?.ticketKey || title || 'Jira Issue';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Implement functionality as specified in ${ticketKey}`,
            source: ticketKey,
            priority: metadata?.priority || 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Verify ${ticketKey} acceptance criteria are met`,
            type: 'functional',
            completed: false
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Test edge cases for ${ticketKey}`,
            type: 'edge-case',
            completed: false
          });
          break;
        }

        case 'notion': {
          const pageName = metadata?.title || title || 'Notion Page';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Follow specifications from "${pageName}"`,
            source: pageName,
            priority: 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Validate against "${pageName}" documentation`,
            type: 'documentation',
            completed: false
          });
          break;
        }

        case 'figma': {
          const designName = metadata?.title || title || 'Figma Design';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Match UI/UX specifications from "${designName}"`,
            source: designName,
            priority: 'high'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Visual regression test against "${designName}"`,
            type: 'visual',
            completed: false
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Responsive design verification for "${designName}"`,
            type: 'responsive',
            completed: false
          });
          break;
        }

        case 'github': {
          const repoInfo = metadata?.title || title || 'GitHub';
          requirements.push({
            id: `req_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            text: `Address issue/PR: ${repoInfo}`,
            source: repoInfo,
            priority: 'medium'
          });
          testMap.push({
            id: `test_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
            description: `Verify fix for ${repoInfo}`,
            type: 'regression',
            completed: false
          });
          break;
        }
      }
    }

    // Add general test cases
    testMap.push({
      id: `test_${Date.now()}_general`,
      description: 'Cross-browser compatibility check',
      type: 'compatibility',
      completed: false
    });
    testMap.push({
      id: `test_${Date.now()}_perf`,
      description: 'Performance validation',
      type: 'performance',
      completed: false
    });

    // Update project with generated data
    const db = getDatabase();
    await db.update(projects).set({
      taskRequirements: JSON.stringify(requirements),
      taskTestMap: JSON.stringify(testMap),
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    return c.json({
      success: true,
      requirements,
      testMap,
      message: 'Task info generated successfully'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete project
app.delete('/api/projects/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    // Delete from database
    await db.delete(frames).where(eq(frames.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));

    // Also delete associated recording directories if they exist
    const mobileRecordingDir = join(PROJECTS_DIR, 'maestro-recordings', id);
    const webRecordingDir = join(PROJECTS_DIR, 'web-recordings', id);
    const projectDir = join(PROJECTS_DIR, id);

    // Try to delete mobile recording dir
    if (existsSync(mobileRecordingDir)) {
      rmSync(mobileRecordingDir, { recursive: true, force: true });
      console.log(`[Delete] Removed mobile recording: ${id}`);
    }

    // Try to delete web recording dir
    if (existsSync(webRecordingDir)) {
      rmSync(webRecordingDir, { recursive: true, force: true });
      console.log(`[Delete] Removed web recording: ${id}`);
    }

    // Try to delete project dir (for uploads and other captures)
    if (existsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
      console.log(`[Delete] Removed project directory: ${id}`);
    }

    return c.json({ message: 'Project deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// FILE UPLOAD API (with AI-powered naming and thumbnail selection)
// ============================================================================
app.post('/api/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return c.json({ error: 'No file provided' }, 400);
    }

    const db = getDatabase();
    const { mkdirSync, writeFileSync, existsSync: fsExists, readdirSync } = await import('node:fs');
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { PROJECTS_DIR, FRAMES_DIR } = await import('../db/index.js');

    // Create project
    const id = crypto.randomUUID();
    const now = new Date();

    // Create project directory
    const projectDir = join(PROJECTS_DIR, id);
    if (!fsExists(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    // Save file
    const fileName = file.name;
    const filePath = join(projectDir, fileName);
    const arrayBuffer = await file.arrayBuffer();
    writeFileSync(filePath, Buffer.from(arrayBuffer));

    // Detect platform from filename
    let platform: string | null = null;
    const lowerName = fileName.toLowerCase();
    if (lowerName.includes('ios') || lowerName.includes('iphone') || lowerName.includes('ipad')) {
      platform = 'ios';
    } else if (lowerName.includes('android') || lowerName.includes('pixel')) {
      platform = 'android';
    } else if (lowerName.includes('web') || lowerName.includes('browser')) {
      platform = 'web';
    }

    // Determine file type
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext);
    const isVideo = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext);

    // AI-powered analysis
    let smartName = fileName.replace(/\.[^/.]+$/, ''); // Default: filename without extension
    let thumbnailPath: string | null = null;
    let ocrText = '';
    let framePaths: string[] = [];

    try {
      if (isVideo) {
        // Create frames directory for this project
        const projectFramesDir = join(FRAMES_DIR, id);
        if (!fsExists(projectFramesDir)) {
          mkdirSync(projectFramesDir, { recursive: true });
        }

        // Extract key frames using FFmpeg (1 frame per second, max 15 frames)
        const framePattern = join(projectFramesDir, 'frame_%04d.png');
        try {
          await execAsync(`ffmpeg -i "${filePath}" -vf "fps=1" -frames:v 15 "${framePattern}" -y 2>/dev/null`);
        } catch {
          // FFmpeg might not be installed, continue without frames
        }

        // Get extracted frame paths
        if (fsExists(projectFramesDir)) {
          framePaths = readdirSync(projectFramesDir)
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => join(projectFramesDir, f));
        }

        if (framePaths.length > 0) {
          // Run OCR and select best frame
          const { bestFrame, analyses } = await selectBestFrame(framePaths);
          thumbnailPath = bestFrame;

          // Combine all OCR text for smart naming
          ocrText = analyses.map(a => a.text).join('\n');

          // Generate smart name from OCR content
          smartName = generateSmartProjectName(ocrText, smartName);
        }
      } else if (isImage) {
        // Single image - run OCR directly
        const { recognizeText } = await import('../core/analyze/ocr.js');
        const ocrResult = await recognizeText(filePath);

        if (ocrResult.success && ocrResult.text) {
          ocrText = ocrResult.text;
          smartName = generateSmartProjectName(ocrText, smartName);
        }

        // Use the image itself as thumbnail
        thumbnailPath = filePath;
      }
    } catch (analysisError) {
      // AI analysis failed, continue with defaults
      console.warn('AI analysis failed:', analysisError);
    }

    // Insert project with AI-generated data
    await db.insert(projects).values({
      id,
      name: smartName,
      videoPath: filePath,
      thumbnailPath: thumbnailPath,
      ocrText: ocrText || null,
      platform,
      status: 'draft',
      frameCount: framePaths.length || (isImage ? 1 : 0),
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      id,
      message: 'File uploaded and analyzed',
      fileName,
      filePath,
      platform,
      smartName,
      thumbnailPath,
      framesExtracted: framePaths.length,
      ocrDetected: ocrText.length > 0
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CAPTURE API
// ============================================================================
app.post('/api/capture/start', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const { mkdirSync, existsSync: fsExists } = await import('node:fs');
    const { PROJECTS_DIR } = await import('../db/index.js');
    const db = getDatabase();

    // Create project
    const id = crypto.randomUUID();
    const now = new Date();
    const projectDir = join(PROJECTS_DIR, id);

    if (!fsExists(projectDir)) {
      mkdirSync(projectDir, { recursive: true });
    }

    const screenshotPath = join(projectDir, 'capture.png');
    const captureType = body.type || 'screen';

    // Detect platform
    const osPlatform = process.platform === 'darwin' ? 'macos' : process.platform;

    if (osPlatform === 'macos') {
      try {
        if (captureType === 'simulator') {
          // Capture iOS Simulator
          await execAsync(`xcrun simctl io booted screenshot "${screenshotPath}"`);
        } else {
          // Capture screen - try interactive mode if silent fails
          try {
            await execAsync(`screencapture -x "${screenshotPath}"`);
          } catch (captureErr) {
            // Permission error - try interactive capture or give instructions
            const errMsg = captureErr instanceof Error ? captureErr.message : '';
            if (errMsg.includes('could not create image')) {
              return c.json({
                error: 'Screen Recording permission required',
                details: 'Go to System Settings > Privacy & Security > Screen Recording and enable permission for Terminal or your IDE.',
                hint: 'After enabling, restart your terminal and try again.'
              }, 403);
            }
            throw captureErr;
          }
        }
      } catch (cmdErr) {
        const errMsg = cmdErr instanceof Error ? cmdErr.message : 'Capture failed';
        if (errMsg.includes('No booted device') || errMsg.includes('No devices are booted')) {
          return c.json({
            error: 'No iOS Simulator running',
            hint: 'Open Xcode > Simulator to start an iOS simulator, or use "Full Screen" capture instead.'
          }, 400);
        }
        throw cmdErr;
      }
    } else {
      return c.json({ error: 'Screen capture only supported on macOS' }, 400);
    }

    // Check if capture was successful
    if (!fsExists(screenshotPath)) {
      return c.json({ error: 'Capture failed - no file was created' }, 500);
    }

    // Insert project
    await db.insert(projects).values({
      id,
      name: `Capture ${now.toLocaleString()}`,
      videoPath: screenshotPath,
      platform: captureType === 'simulator' ? 'ios' : 'macos',
      status: 'draft',
      createdAt: now,
      updatedAt: now,
    });

    return c.json({
      id,
      message: 'Capture completed',
      path: screenshotPath,
      type: captureType
    }, 201);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get available capture sources
app.get('/api/capture/sources', async (c) => {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);
    const platform = process.platform;

    const sources: Array<{id: string, name: string, type: string}> = [];

    if (platform === 'darwin') {
      sources.push({ id: 'screen', name: 'Full Screen', type: 'screen' });
      sources.push({ id: 'window', name: 'Window', type: 'window' });

      // Check for iOS Simulator
      try {
        const { stdout } = await execAsync('xcrun simctl list devices booted -j');
        const data = JSON.parse(stdout);
        for (const runtime of Object.values(data.devices) as any[]) {
          for (const device of runtime) {
            if (device.state === 'Booted') {
              sources.push({
                id: `simulator:${device.udid}`,
                name: `iOS: ${device.name}`,
                type: 'simulator'
              });
            }
          }
        }
      } catch {
        // No simulators running
      }

      // Check for Android emulator (using detected SDK path)
      if (ADB_PATH) {
        try {
          const { stdout } = await execAsync(`"${ADB_PATH}" devices`);
          const lines = stdout.trim().split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') || line.includes('emulator')) {
              const deviceId = line.split('\t')[0];
              sources.push({
                id: `android:${deviceId}`,
                name: `Android: ${deviceId}`,
                type: 'android'
              });
            }
          }
        } catch {
          // No Android devices
        }
      }
    }

    return c.json({ sources });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CAPTURE RECORDING API (Mobile & Web screen recording)
// ============================================================================

// State for capture recording sessions
let captureSession: {
  type: 'mobile' | 'web';
  deviceId?: string;
  platform?: string;
  deviceName?: string;
  url?: string;
  startTime: number;
  videoPath?: string;
  screenshotsDir?: string;
  process?: any;
  browser?: any;
  page?: any;
  projectId?: string;
} | null = null;

// Get current capture session status
app.get('/api/capture/status', (c) => {
  if (!captureSession) {
    return c.json({ active: false });
  }
  return c.json({
    active: true,
    type: captureSession.type,
    startTime: captureSession.startTime,
    projectId: captureSession.projectId,
    url: captureSession.url,
    deviceName: captureSession.deviceName,
    platform: captureSession.platform
  });
});

// Start mobile screen recording
app.post('/api/capture/mobile/start', async (c) => {
  try {
    if (captureSession) {
      return c.json({ error: 'A recording session is already active' }, 400);
    }

    const body = await c.req.json();
    const { deviceId, platform, deviceName } = body;

    if (!deviceId || !platform) {
      return c.json({ error: 'Device ID and platform required' }, 400);
    }

    const { exec, spawn } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdirSync } = await import('node:fs');
    const execAsync = promisify(exec);

    // Create project directory
    const projectId = `capture_${Date.now()}`;
    const projectDir = join(PROJECTS_DIR, projectId);
    const screenshotsDir = join(projectDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    const videoPath = join(projectDir, 'recording.mp4');

    // Start video recording based on platform
    let recordProcess: any = null;

    if (platform === 'ios') {
      // iOS Simulator video recording
      recordProcess = spawn('xcrun', ['simctl', 'io', deviceId, 'recordVideo', videoPath], {
        stdio: 'pipe'
      });
    } else if (platform === 'android') {
      // Android screen recording via adb
      const adbPath = ADB_PATH || 'adb';
      recordProcess = spawn(adbPath, ['-s', deviceId, 'shell', 'screenrecord', '/sdcard/recording.mp4'], {
        stdio: 'pipe'
      });
    }

    captureSession = {
      type: 'mobile',
      deviceId,
      platform,
      deviceName,
      startTime: Date.now(),
      videoPath,
      screenshotsDir,
      process: recordProcess,
      projectId
    };

    // Create project in database with "processing" status
    const db = getDatabase();
    await db.insert(projects).values({
      id: projectId,
      name: `${deviceName || platform.toUpperCase()} Recording - ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
      videoPath: projectDir,
      platform,
      status: 'processing',
      createdAt: new Date(),
      updatedAt: new Date()
    });

    return c.json({
      success: true,
      projectId,
      message: 'Mobile recording started'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop mobile screen recording
app.post('/api/capture/mobile/stop', async (c) => {
  try {
    if (!captureSession || captureSession.type !== 'mobile') {
      return c.json({ error: 'No active mobile recording session' }, 400);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    const session = captureSession;
    const projectId = session.projectId!;

    // Stop recording process
    if (session.process) {
      session.process.kill('SIGINT');
      // Wait a bit for the process to finish writing
      await new Promise(resolve => setTimeout(resolve, 1500));
    }

    // For Android, pull the video file
    if (session.platform === 'android' && session.deviceId) {
      const adbPath = ADB_PATH || 'adb';
      try {
        await execAsync(`"${adbPath}" -s ${session.deviceId} pull /sdcard/recording.mp4 "${session.videoPath}"`);
        await execAsync(`"${adbPath}" -s ${session.deviceId} shell rm /sdcard/recording.mp4`);
      } catch (err) {
        console.error('Failed to pull Android recording:', err);
      }
    }

    captureSession = null;

    // Update project status to trigger OCR analysis
    const db = getDatabase();
    await db.update(projects)
      .set({
        status: 'processing',
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    // Trigger OCR analysis in background
    analyzeProjectInBackground(projectId).catch(err => {
      console.error('Background OCR analysis failed:', err);
    });

    return c.json({
      success: true,
      projectId,
      videoPath: session.videoPath,
      message: 'Recording stopped, analyzing...'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    captureSession = null;
    return c.json({ error: message }, 500);
  }
});

// Start web browser recording
app.post('/api/capture/web/start', async (c) => {
  try {
    if (captureSession) {
      return c.json({ error: 'A recording session is already active' }, 400);
    }

    const body = await c.req.json();
    const { url } = body;
    const startUrl = url || 'about:blank';

    const { mkdirSync } = await import('node:fs');

    // Create project directory
    const projectId = `capture_web_${Date.now()}`;
    const projectDir = join(PROJECTS_DIR, projectId);
    const screenshotsDir = join(projectDir, 'screenshots');
    mkdirSync(screenshotsDir, { recursive: true });

    // Launch Playwright browser with video recording
    let browser: any = null;
    let page: any = null;

    try {
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: false,
        channel: 'chrome'  // Use user's installed Chrome instead of Playwright's Chromium
      });

      const context = await browser.newContext({
        recordVideo: {
          dir: projectDir,
          size: { width: 1280, height: 720 }
        },
        viewport: { width: 1280, height: 720 }
      });

      page = await context.newPage();
      await page.goto(startUrl);

      captureSession = {
        type: 'web',
        url: startUrl,
        startTime: Date.now(),
        screenshotsDir,
        browser,
        page,
        projectId
      };

      // Create project in database
      const db = getDatabase();
      await db.insert(projects).values({
        id: projectId,
        name: `Web Recording - ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
        videoPath: projectDir,
        platform: 'web',
        status: 'processing',
        createdAt: new Date(),
        updatedAt: new Date()
      });

      return c.json({
        success: true,
        projectId,
        message: 'Browser recording started'
      });

    } catch (err) {
      if (browser) await browser.close();
      throw err;
    }

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('playwright') || message.includes('Cannot find module')) {
      return c.json({
        error: 'Playwright not installed',
        hint: 'Run: npm install playwright && npx playwright install chromium'
      }, 400);
    }
    return c.json({ error: message }, 500);
  }
});

// Stop web browser recording
app.post('/api/capture/web/stop', async (c) => {
  try {
    if (!captureSession || captureSession.type !== 'web') {
      return c.json({ error: 'No active web recording session' }, 400);
    }

    const session = captureSession;
    const projectId = session.projectId!;

    // Close browser to finalize video
    if (session.page) {
      await session.page.close();
    }
    if (session.browser) {
      await session.browser.close();
    }

    // Wait for video file to be written
    await new Promise(resolve => setTimeout(resolve, 1000));

    captureSession = null;

    // Update project status
    const db = getDatabase();
    await db.update(projects)
      .set({
        status: 'processing',
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    // Trigger OCR analysis in background
    analyzeProjectInBackground(projectId).catch(err => {
      console.error('Background OCR analysis failed:', err);
    });

    return c.json({
      success: true,
      projectId,
      message: 'Recording stopped, analyzing...'
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    captureSession = null;
    return c.json({ error: message }, 500);
  }
});

// Background OCR analysis function
async function analyzeProjectInBackground(projectId: string) {
  const db = getDatabase();

  try {
    // Get project
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
    if (result.length === 0) return;

    const project = result[0];
    const projectDir = project.videoPath;

    if (!projectDir || !existsSync(projectDir)) {
      await db.update(projects)
        .set({ status: 'failed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'failed' }
      });
      return;
    }

    // Find video file in project directory
    const { readdirSync } = await import('node:fs');
    const files = readdirSync(projectDir);
    const videoFile = files.find(f => f.endsWith('.mp4') || f.endsWith('.webm') || f.endsWith('.mov'));

    if (!videoFile) {
      await db.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'completed' }
      });
      return;
    }

    const videoPath = join(projectDir, videoFile);

    // Extract frames from video
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const { mkdirSync } = await import('node:fs');
    const execAsync = promisify(exec);

    const framesDir = join(projectDir, 'frames');
    mkdirSync(framesDir, { recursive: true });

    // Extract 1 frame per second
    await execAsync(`ffmpeg -i "${videoPath}" -vf "fps=1" -q:v 2 "${framesDir}/frame_%04d.jpg" -y`);

    // Get frame files
    const frameFiles = readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();

    if (frameFiles.length === 0) {
      await db.update(projects)
        .set({ status: 'completed', updatedAt: new Date() })
        .where(eq(projects.id, projectId));
      broadcastToClients({
        type: 'projectAnalysisUpdated',
        data: { projectId, status: 'completed' }
      });
      return;
    }

    // Run OCR on frames
    let allOcrText = '';
    let bestFrame = frameFiles[0];
    const ocrEngines = new Set<string>();
    const ocrConfidences: number[] = [];

    try {
      const { recognizeText } = await import('../core/analyze/ocr.js');

      for (const frameFile of frameFiles.slice(0, 10)) { // Limit to first 10 frames
        const framePath = join(framesDir, frameFile);
        const ocrResult = await recognizeText(framePath);
        if (ocrResult.success && ocrResult.text) {
          allOcrText += ocrResult.text + '\n\n';
          if (ocrResult.engine) {
            ocrEngines.add(ocrResult.engine);
          }
          if (typeof ocrResult.confidence === 'number') {
            ocrConfidences.push(ocrResult.confidence);
          }
        }
      }
    } catch (err) {
      console.error('OCR analysis error:', err);
    }

    let aiSummary = allOcrText
      ? `Analyzed ${frameFiles.length} frame(s). Text detected via OCR.`
      : `Analyzed ${frameFiles.length} frame(s). No text detected via OCR.`;

    if (allOcrText) {
      try {
        const provider = await getLLMProvider();
        if (provider) {
          console.log(`[BackgroundOCR] Generating web App Intelligence summary with ${provider.name}...`);
          aiSummary = await generateAppIntelligenceSummary(provider, allOcrText, 'web');
        }
      } catch (summaryError) {
        console.warn('[BackgroundOCR] Web summary generation failed:', summaryError);
      }
    }

    // Update project with results
    const thumbnailPath = join(framesDir, bestFrame);
    const ocrEngine = ocrEngines.has('vision')
      ? 'vision'
      : ocrEngines.has('tesseract')
        ? 'tesseract'
        : null;
    const ocrConfidence = ocrConfidences.length > 0
      ? ocrConfidences.reduce((sum, value) => sum + value, 0) / ocrConfidences.length
      : null;

    await db.update(projects)
      .set({
        status: 'analyzed',
        ocrText: allOcrText || null,
        ocrEngine,
        ocrConfidence,
        thumbnailPath: existsSync(thumbnailPath) ? thumbnailPath : null,
        aiSummary,
        updatedAt: new Date()
      })
      .where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });

  } catch (error) {
    console.error('Background analysis error:', error);
    await db.update(projects)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'failed' }
    });
  }
}

// ============================================================================
// ANALYZE API
// ============================================================================
app.post('/api/analyze/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');

    // Get project
    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    let ocrText = '';
    let aiSummary = '';
    let frameCount = 0;

    // Check if it's an image or video
    const filePath = project.videoPath;
    if (filePath && existsSync(filePath)) {
      const ext = filePath.toLowerCase().split('.').pop();
      const isImage = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext || '');
      const isVideo = ['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext || '');

      if (isImage) {
        // Run OCR on the image
        try {
          const { recognizeText } = await import('../core/analyze/ocr.js');
          const ocrResult = await recognizeText(filePath);
          if (ocrResult.success && ocrResult.text) {
            ocrText = ocrResult.text;
            frameCount = 1;
          }
        } catch (err) {
          console.error('OCR error:', err);
        }
      } else if (isVideo) {
        // Extract frames and run OCR
        try {
          const { exec } = await import('node:child_process');
          const { promisify } = await import('node:util');
          const { mkdirSync, readdirSync } = await import('node:fs');
          const execAsync = promisify(exec);
          const { FRAMES_DIR } = await import('../db/index.js');

          // Create frames directory for this project
          const projectFramesDir = join(FRAMES_DIR, id);
          if (!existsSync(projectFramesDir)) {
            mkdirSync(projectFramesDir, { recursive: true });
          }

          // Extract key frames using FFmpeg (1 frame per second)
          const framePattern = join(projectFramesDir, 'frame_%04d.png');
          try {
            const { stderr } = await execAsync(`ffmpeg -i "${filePath}" -vf "fps=1" -frames:v 10 "${framePattern}" -y 2>&1`);
            if (stderr) console.log('[FFmpeg] Output:', stderr.slice(0, 500));
          } catch (ffmpegError) {
            console.error('[FFmpeg] Frame extraction failed:', ffmpegError);
            // Try fallback: extract keyframes only (I-frames)
            try {
              console.log('[FFmpeg] Trying keyframe fallback...');
              await execAsync(`ffmpeg -i "${filePath}" -vf "select='eq(pict_type,I)'" -frames:v 10 "${framePattern}" -y 2>&1`);
            } catch (fallbackError) {
              console.error('[FFmpeg] Keyframe fallback also failed:', fallbackError);
            }
          }

          // Get extracted frames
          const frameFiles = readdirSync(projectFramesDir)
            .filter(f => f.endsWith('.png'))
            .sort()
            .map(f => join(projectFramesDir, f));

          frameCount = frameFiles.length;
          console.log(`[FFmpeg] Extracted ${frameCount} frames from video`);

          // Run OCR on frames
          if (frameFiles.length > 0) {
            const { recognizeTextBatch } = await import('../core/analyze/ocr.js');
            const batchResult = await recognizeTextBatch(frameFiles.slice(0, 5)); // OCR first 5 frames
            if (batchResult.success && batchResult.totalText) {
              ocrText = batchResult.totalText;
            }
          }
        } catch (err) {
          console.error('Video analysis error:', err);
        }
      }

      // Generate simple AI summary from OCR text
      if (ocrText) {
        const words = ocrText.split(/\s+/).filter(w => w.length > 2);
        const uniqueWords = [...new Set(words.map(w => w.toLowerCase()))];
        const topWords = uniqueWords.slice(0, 20).join(', ');

        aiSummary = `Analyzed ${frameCount} frame(s). Found ${words.length} words. Key terms: ${topWords || 'none detected'}.`;
      } else {
        aiSummary = `Analyzed ${frameCount} frame(s). No text detected via OCR.`;
      }
    } else {
      aiSummary = 'No media file found for analysis.';
    }

    // Update project with analysis results
    await db.update(projects).set({
      status: 'analyzed',
      ocrText: ocrText || null,
      aiSummary,
      frameCount,
      updatedAt: new Date()
    }).where(eq(projects.id, id));

    return c.json({
      message: 'Analysis complete',
      projectId: id,
      status: 'analyzed',
      frameCount,
      ocrTextLength: ocrText.length,
      aiSummary
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// CANVAS API
// ============================================================================
app.post('/api/canvas/mockup', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, deviceId, imagePath } = body;

    if (!imagePath || !existsSync(imagePath)) {
      return c.json({ error: 'Image file not found' }, 400);
    }

    // For now, return the image path as preview (real mockup generation would use canvas)
    return c.json({
      success: true,
      projectId,
      deviceId,
      previewUrl: `/api/file?path=${encodeURIComponent(imagePath)}`,
      outputPath: imagePath
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/canvas/export', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, deviceId, format } = body;

    const db = getDatabase();
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    if (!project.videoPath) {
      return c.json({ error: 'No media file in project' }, 400);
    }

    return c.json({
      success: true,
      downloadUrl: `/api/file?path=${encodeURIComponent(project.videoPath)}`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// GRID API - Static image grid composition
// ============================================================================

// Get available grid layouts
app.get('/api/grid/layouts', async (c) => {
  try {
    const { getAllLayouts, getLayoutInfo } = await import('../core/canvas/gridCompositor.js');
    const layouts = getAllLayouts().map(layout => ({
      id: layout,
      ...getLayoutInfo(layout),
    }));
    return c.json({ layouts });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get available backgrounds
app.get('/api/grid/backgrounds', async (c) => {
  try {
    const { getAvailableBackgrounds, PRESET_GRADIENTS, PRESET_SOLID_COLORS } = await import('../core/canvas/gridCompositor.js');

    // Get backgrounds from assets folder
    const backgroundsDir = join(process.cwd(), 'assets', 'backgrounds');
    const imageBackgrounds = getAvailableBackgrounds(backgroundsDir);

    return c.json({
      images: imageBackgrounds.map(bg => ({
        ...bg,
        previewUrl: `/api/file?path=${encodeURIComponent(bg.path)}`,
      })),
      gradients: PRESET_GRADIENTS,
      solidColors: PRESET_SOLID_COLORS,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Generate grid preview
app.post('/api/grid/preview', async (c) => {
  try {
    const body = await c.req.json();
    const { images, config } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return c.json({ error: 'No images provided' }, 400);
    }

    const { composeGrid, recommendLayout } = await import('../core/canvas/gridCompositor.js');
    const { EXPORTS_DIR } = await import('../db/index.js');
    const { mkdirSync } = await import('node:fs');

    // Create preview directory
    const previewDir = join(EXPORTS_DIR, 'grid-previews');
    if (!existsSync(previewDir)) {
      mkdirSync(previewDir, { recursive: true });
    }

    // Generate preview filename
    const previewId = crypto.randomUUID();
    const outputPath = join(previewDir, `preview-${previewId}.png`);

    // Auto-recommend layout if not specified
    const gridConfig = {
      ...config,
      layout: config?.layout || recommendLayout(images.length, config?.aspectRatio || '9:16'),
    };

    // Resolve background image path if using image background
    if (gridConfig.background?.type === 'image' && gridConfig.background?.imageId) {
      const backgroundsDir = join(process.cwd(), 'assets', 'backgrounds');
      const { getAvailableBackgrounds } = await import('../core/canvas/gridCompositor.js');
      const bgs = getAvailableBackgrounds(backgroundsDir);
      const bg = bgs.find(b => b.id === gridConfig.background.imageId);
      if (bg) {
        gridConfig.background.imagePath = bg.path;
      }
    }

    // Map image paths to GridCell format
    const gridImages = images.map((img: { path: string; label?: string }) => ({
      imagePath: img.path,
      label: img.label,
    }));

    const result = await composeGrid(gridImages, gridConfig, outputPath);

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      previewId,
      previewUrl: `/api/file?path=${encodeURIComponent(outputPath)}`,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Export final grid as PNG
app.post('/api/grid/export', async (c) => {
  try {
    const body = await c.req.json();
    const { images, config, projectId, filename } = body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return c.json({ error: 'No images provided' }, 400);
    }

    const { composeGrid, recommendLayout } = await import('../core/canvas/gridCompositor.js');
    const { EXPORTS_DIR } = await import('../db/index.js');
    const { mkdirSync } = await import('node:fs');

    // Create export directory
    const exportDir = projectId ? join(EXPORTS_DIR, projectId) : join(EXPORTS_DIR, 'grids');
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    // Generate export filename
    const timestamp = Date.now();
    const exportFilename = filename || `grid-${timestamp}.png`;
    const outputPath = join(exportDir, exportFilename);

    // Auto-recommend layout if not specified
    const gridConfig = {
      ...config,
      layout: config?.layout || recommendLayout(images.length, config?.aspectRatio || '9:16'),
      outputWidth: config?.outputWidth || 1080, // Default to 1080px width
    };

    // Resolve background image path
    if (gridConfig.background?.type === 'image' && gridConfig.background?.imageId) {
      const backgroundsDir = join(process.cwd(), 'assets', 'backgrounds');
      const { getAvailableBackgrounds } = await import('../core/canvas/gridCompositor.js');
      const bgs = getAvailableBackgrounds(backgroundsDir);
      const bg = bgs.find(b => b.id === gridConfig.background.imageId);
      if (bg) {
        gridConfig.background.imagePath = bg.path;
      }
    }

    // Map image paths to GridCell format
    const gridImages = images.map((img: { path: string; label?: string }) => ({
      imagePath: img.path,
      label: img.label,
    }));

    const result = await composeGrid(gridImages, gridConfig, outputPath);

    if (!result.success) {
      return c.json({ error: result.error }, 500);
    }

    return c.json({
      success: true,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
      width: result.width,
      height: result.height,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get project frames for grid selection
app.get('/api/grid/project-frames/:id', async (c) => {
  try {
    const db = getDatabase();
    const id = c.req.param('id');

    const result = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    const { FRAMES_DIR } = await import('../db/index.js');
    const { readdirSync } = await import('node:fs');

    const availableFrames: Array<{ path: string; previewUrl: string; name: string }> = [];

    // Check for extracted frames in global FRAMES_DIR
    const projectFramesDir = join(FRAMES_DIR, id);
    if (existsSync(projectFramesDir)) {
      const frameFiles = readdirSync(projectFramesDir)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();

      for (const f of frameFiles) {
        const framePath = join(projectFramesDir, f);
        availableFrames.push({
          path: framePath,
          previewUrl: `/api/file?path=${encodeURIComponent(framePath)}`,
          name: f,
        });
      }
    }

    // Also check for frames in project-specific directory (mobile recordings)
    const projectFramesDir2 = join(PROJECTS_DIR, id, 'frames');
    if (existsSync(projectFramesDir2)) {
      const frameFiles = readdirSync(projectFramesDir2)
        .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
        .sort();

      for (const f of frameFiles) {
        const framePath = join(projectFramesDir2, f);
        // Avoid duplicates
        if (!availableFrames.some(frame => frame.path === framePath)) {
          availableFrames.push({
            path: framePath,
            previewUrl: `/api/file?path=${encodeURIComponent(framePath)}`,
            name: f,
          });
        }
      }
    }

    // Also include the main project file if it's an image
    if (project.videoPath) {
      const ext = project.videoPath.toLowerCase().split('.').pop();
      if (['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext || '')) {
        availableFrames.unshift({
          path: project.videoPath,
          previewUrl: `/api/file?path=${encodeURIComponent(project.videoPath)}`,
          name: project.name || 'Main Image',
        });
      }
    }

    // Include thumbnail if different from videoPath
    if (project.thumbnailPath && project.thumbnailPath !== project.videoPath) {
      availableFrames.unshift({
        path: project.thumbnailPath,
        previewUrl: `/api/file?path=${encodeURIComponent(project.thumbnailPath)}`,
        name: 'Thumbnail',
      });
    }

    // Also check for screenshots in recording session directory (web testing projects)
    if (project.videoPath && existsSync(project.videoPath)) {
      const { statSync } = await import('node:fs');
      const stats = statSync(project.videoPath);
      if (stats.isDirectory()) {
        // This is a recording session directory, check for screenshots subdirectory
        const screenshotsDir = join(project.videoPath, 'screenshots');
        if (existsSync(screenshotsDir)) {
          const screenshotFiles = readdirSync(screenshotsDir)
            .filter(f => /\.(png|jpg|jpeg)$/i.test(f))
            .sort();

          for (const f of screenshotFiles) {
            const screenshotPath = join(screenshotsDir, f);
            // Check if this path is already in availableFrames
            if (!availableFrames.some(frame => frame.path === screenshotPath)) {
              availableFrames.push({
                path: screenshotPath,
                previewUrl: `/api/file?path=${encodeURIComponent(screenshotPath)}`,
                name: f,
              });
            }
          }
        }
      }
    }

    return c.json({
      projectId: id,
      projectName: project.name,
      frames: availableFrames,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// EXPORT API
// ============================================================================
app.post('/api/export', async (c) => {
  try {
    const body = await c.req.json();
    const { projectId, format, destination, includeOcr, includeSummary } = body;

    const db = getDatabase();
    const result = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    if (!project.videoPath) {
      return c.json({ error: 'No media file in project' }, 400);
    }

    const { EXPORTS_DIR } = await import('../db/index.js');
    const { mkdirSync, copyFileSync, writeFileSync, statSync, cpSync } = await import('node:fs');
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    // Create export directory
    const exportDir = join(EXPORTS_DIR, projectId);
    if (!existsSync(exportDir)) {
      mkdirSync(exportDir, { recursive: true });
    }

    const timestamp = Date.now();
    let outputPath = '';
    let mimeType = 'image/png';

    // Check if videoPath is a directory (e.g., Maestro recordings)
    const isVideoPathDirectory = existsSync(project.videoPath) && statSync(project.videoPath).isDirectory();

    if (isVideoPathDirectory && format === 'gif') {
      // Maestro recording: create animated GIF from screenshots
      outputPath = join(exportDir, `export-${timestamp}.gif`);
      mimeType = 'image/gif';

      // Find screenshots directory
      const screenshotsDir = join(project.videoPath, 'screenshots');
      const screenshotsDirExists = existsSync(screenshotsDir) && statSync(screenshotsDir).isDirectory();
      const sourceDir = screenshotsDirExists ? screenshotsDir : project.videoPath;

      // Get all PNG files sorted by name (timestamp order)
      const { readdirSync } = await import('node:fs');
      const pngFiles = readdirSync(sourceDir)
        .filter((f: string) => f.endsWith('.png'))
        .sort()
        .map((f: string) => join(sourceDir, f));

      if (pngFiles.length === 0) {
        return c.json({ error: 'No screenshots found in recording' }, 400);
      }

      // Create concat file for ffmpeg
      const concatPath = join(exportDir, `concat-${timestamp}.txt`);
      const concatContent = pngFiles.map((f: string) => `file '${f}'\nduration 0.5`).join('\n');
      writeFileSync(concatPath, concatContent);

      try {
        // Use ffmpeg concat demuxer to create animated GIF
        await execAsync(`ffmpeg -f concat -safe 0 -i "${concatPath}" -vf "fps=2,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" "${outputPath}" -y`);
        // Clean up concat file
        const { unlinkSync } = await import('node:fs');
        unlinkSync(concatPath);
      } catch (err) {
        // Clean up concat file on error
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(concatPath);
        } catch {}
        return c.json({ error: 'GIF creation failed - FFmpeg required. Install with: brew install ffmpeg' }, 400);
      }
    } else if (isVideoPathDirectory && format === 'mp4') {
      // Maestro recording: create video from screenshots
      outputPath = join(exportDir, `export-${timestamp}.mp4`);
      mimeType = 'video/mp4';

      // Find screenshots directory
      const screenshotsDir = join(project.videoPath, 'screenshots');
      const screenshotsDirExists = existsSync(screenshotsDir) && statSync(screenshotsDir).isDirectory();
      const sourceDir = screenshotsDirExists ? screenshotsDir : project.videoPath;

      // Get all PNG files sorted by name (timestamp order)
      const { readdirSync } = await import('node:fs');
      const pngFiles = readdirSync(sourceDir)
        .filter((f: string) => f.endsWith('.png'))
        .sort()
        .map((f: string) => join(sourceDir, f));

      if (pngFiles.length === 0) {
        return c.json({ error: 'No screenshots found in recording' }, 400);
      }

      // Create concat file for ffmpeg
      const concatPath = join(exportDir, `concat-${timestamp}.txt`);
      const concatContent = pngFiles.map((f: string) => `file '${f}'\nduration 0.5`).join('\n');
      writeFileSync(concatPath, concatContent);

      try {
        // Use ffmpeg concat demuxer to create MP4
        await execAsync(`ffmpeg -f concat -safe 0 -i "${concatPath}" -vf "scale=480:-2" -c:v libx264 -pix_fmt yuv420p "${outputPath}" -y`);
        // Clean up concat file
        const { unlinkSync } = await import('node:fs');
        unlinkSync(concatPath);
      } catch (err) {
        // Clean up concat file on error
        try {
          const { unlinkSync } = await import('node:fs');
          unlinkSync(concatPath);
        } catch {}
        return c.json({ error: 'Video creation failed - FFmpeg required. Install with: brew install ffmpeg' }, 400);
      }
    } else if (isVideoPathDirectory) {
      // Maestro recording: copy entire directory for other formats
      outputPath = join(exportDir, `export-${timestamp}`);
      cpSync(project.videoPath, outputPath, { recursive: true });
      mimeType = 'application/octet-stream';
    } else if (format === 'png' || format === 'jpg' || format === 'jpeg') {
      // Handle different formats for single files
      const ext = format === 'jpg' ? 'jpeg' : format;
      outputPath = join(exportDir, `export-${timestamp}.${format}`);
      mimeType = `image/${ext}`;

      // Convert if needed or just copy
      if (project.videoPath.endsWith(`.${format}`)) {
        copyFileSync(project.videoPath, outputPath);
      } else {
        // Use sips for conversion on macOS
        try {
          await execAsync(`sips -s format ${format} "${project.videoPath}" --out "${outputPath}"`);
        } catch {
          // If conversion fails, just copy
          copyFileSync(project.videoPath, outputPath);
          outputPath = join(exportDir, `export-${timestamp}${project.videoPath.substring(project.videoPath.lastIndexOf('.'))}`);
        }
      }
    } else if (format === 'gif') {
      outputPath = join(exportDir, `export-${timestamp}.gif`);
      mimeType = 'image/gif';

      // Create GIF from single image
      try {
        await execAsync(`ffmpeg -i "${project.videoPath}" -vf "fps=10,scale=320:-1:flags=lanczos" "${outputPath}" -y`);
      } catch {
        copyFileSync(project.videoPath, outputPath.replace('.gif', '.png'));
        outputPath = outputPath.replace('.gif', '.png');
        mimeType = 'image/png';
      }
    } else if (format === 'mp4') {
      outputPath = join(exportDir, `export-${timestamp}.mp4`);
      mimeType = 'video/mp4';

      if (project.videoPath.endsWith('.mp4')) {
        copyFileSync(project.videoPath, outputPath);
      } else {
        // Create video from image
        try {
          await execAsync(`ffmpeg -loop 1 -i "${project.videoPath}" -c:v libx264 -t 3 -pix_fmt yuv420p "${outputPath}" -y`);
        } catch {
          return c.json({ error: 'Video conversion failed - FFmpeg required' }, 400);
        }
      }
    } else {
      // Default: copy original
      const ext = project.videoPath.substring(project.videoPath.lastIndexOf('.'));
      outputPath = join(exportDir, `export-${timestamp}${ext}`);
      copyFileSync(project.videoPath, outputPath);
    }

    // Create text file with OCR and summary if requested
    if (includeOcr || includeSummary) {
      let textContent = `# ${project.name}\n\n`;
      textContent += `Exported: ${new Date().toISOString()}\n\n`;

      if (includeSummary && project.aiSummary) {
        textContent += `## Summary\n${project.aiSummary}\n\n`;
      }

      if (includeOcr && project.ocrText) {
        textContent += `## OCR Text\n${project.ocrText}\n`;
      }

      const textPath = join(exportDir, `export-${timestamp}.txt`);
      writeFileSync(textPath, textContent);
    }

    // Handle different destinations
    if (destination === 'local' || destination === 'clipboard') {
      return c.json({
        success: true,
        path: outputPath,
        downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`
      });
    } else if (destination === 'notion' || destination === 'drive') {
      // For cloud destinations, return info about what would be uploaded
      return c.json({
        success: true,
        path: outputPath,
        downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`,
        message: `File ready for ${destination}. Use the download link or MCP tools for cloud upload.`
      });
    }

    return c.json({
      success: true,
      path: outputPath,
      downloadUrl: `/api/file?path=${encodeURIComponent(outputPath)}&download=true`
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// STATIC ASSETS
// ============================================================================
app.get('/assets/*', async (c) => {
  try {
    const assetPath = c.req.path.replace('/assets/', '');
    const cwd = process.cwd();

    // Check multiple possible locations for assets
    // Prioritize __dirname (absolute) over process.cwd() for npm-installed packages
    const possiblePaths = [
      join(__dirname, '..', 'assets', assetPath),    // Production: dist/../assets
      join(__dirname, '..', '..', 'assets', assetPath), // Alternative structure
      join(cwd, 'assets', assetPath),                // Development: running from project root
      join(cwd, 'src', 'assets', assetPath),         // Development: src/assets
    ];

    for (const path of possiblePaths) {
      if (existsSync(path)) {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(path);

        // Determine content type
        const ext = path.split('.').pop()?.toLowerCase() || '';
        const contentTypes: Record<string, string> = {
          'png': 'image/png',
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'gif': 'image/gif',
          'svg': 'image/svg+xml',
          'webp': 'image/webp',
          'ico': 'image/x-icon',
        };

        return new Response(content, {
          headers: {
            'Content-Type': contentTypes[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=31536000',
          }
        });
      }
    }

    return c.json({ error: 'Asset not found' }, 404);
  } catch (error) {
    return c.json({ error: 'Failed to serve asset' }, 500);
  }
});

// ============================================================================
// FILE SERVING API
// ============================================================================
app.get('/api/file', async (c) => {
  try {
    const filePath = c.req.query('path');
    const download = c.req.query('download') === 'true';

    if (!filePath) {
      return c.json({ error: 'Path required' }, 400);
    }

    const decodedPath = decodeURIComponent(filePath);

    if (!existsSync(decodedPath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const { readFileSync, statSync } = await import('node:fs');
    const { basename, extname } = await import('node:path');

    const stat = statSync(decodedPath);
    const content = readFileSync(decodedPath);
    const fileName = basename(decodedPath);
    const ext = extname(decodedPath).toLowerCase();

    // Determine content type
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.webm': 'video/webm',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };

    const contentType = mimeTypes[ext] || 'application/octet-stream';

    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': stat.size.toString(),
    };

    if (download) {
      headers['Content-Disposition'] = `attachment; filename="${fileName}"`;
    }

    return new Response(content, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.get('/api/files', async (c) => {
  try {
    const dirPath = c.req.query('dir');
    if (!dirPath) {
      return c.json({ error: 'dir required' }, 400);
    }

    const decodedPath = decodeURIComponent(dirPath);
    if (!existsSync(decodedPath)) {
      return c.json({ error: 'Directory not found' }, 404);
    }

    const { readdirSync, statSync } = await import('node:fs');
    const files = readdirSync(decodedPath)
      .filter(name => {
        try {
          return statSync(join(decodedPath, name)).isFile();
        } catch {
          return false;
        }
      })
      .sort();

    return c.json({ files });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// REVEAL IN FINDER API
// ============================================================================
app.post('/api/reveal', async (c) => {
  try {
    const body = await c.req.json();
    const { path: filePath } = body;

    if (!filePath || !existsSync(filePath)) {
      return c.json({ error: 'File not found' }, 404);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    if (process.platform === 'darwin') {
      await execAsync(`open -R "${filePath}"`);
    } else if (process.platform === 'win32') {
      await execAsync(`explorer /select,"${filePath}"`);
    } else {
      await execAsync(`xdg-open "${filePath}"`);
    }

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// OPEN SYSTEM SETTINGS API
// ============================================================================
app.post('/api/open-settings', async (c) => {
  try {
    const body = await c.req.json();
    const { settings } = body;

    if (process.platform !== 'darwin') {
      return c.json({ error: 'Only available on macOS' }, 400);
    }

    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    let url = '';
    switch (settings) {
      case 'screen-recording':
        url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';
        break;
      case 'accessibility':
        url = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';
        break;
      case 'privacy':
        url = 'x-apple.systempreferences:com.apple.preference.security';
        break;
      default:
        return c.json({ error: 'Unknown settings type' }, 400);
    }

    await execAsync(`open "${url}"`);
    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// TESTING API
// ============================================================================
app.get('/api/testing/status', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const { existsSync } = await import('node:fs');
    const { homedir } = await import('node:os');

    let maestroInstalled = false;
    let playwrightInstalled = false;
    let xcrunAvailable = false;
    let adbAvailable = false;

    // Check for Maestro - it installs to ~/.maestro/bin
    const maestroPath = `${homedir()}/.maestro/bin/maestro`;
    try {
      if (existsSync(maestroPath)) {
        maestroInstalled = true;
      } else {
        execSync('which maestro', { stdio: 'pipe' });
        maestroInstalled = true;
      }
    } catch {}

    // Check for Playwright
    try {
      execSync('npx playwright --version', { stdio: 'pipe', timeout: 5000 });
      playwrightInstalled = true;
    } catch {}

    // Check for xcrun (iOS Simulator support)
    try {
      execSync('xcrun simctl help', { stdio: 'pipe', timeout: 3000 });
      xcrunAvailable = true;
    } catch {}

    // Check for adb (Android Emulator support)
    try {
      if (ADB_PATH && existsSync(ADB_PATH)) {
        adbAvailable = true;
      } else {
        execSync('which adb', { stdio: 'pipe' });
        adbAvailable = true;
      }
    } catch {}

    return c.json({
      maestro: maestroInstalled,
      playwright: playwrightInstalled,
      xcrun: xcrunAvailable,
      adb: adbAvailable
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// INTEGRATIONS API
// ============================================================================
app.get('/api/integrations/jira-mcp/status', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const { existsSync, readFileSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const { join } = await import('node:path');

    const claudeCliAvailable = isClaudeCliAvailable();
    let configured = false;
    let available = false;
    let serverName: string | null = null;
    let source: 'cli' | 'settings' | 'none' = 'none';
    let cliError: string | null = null;

    const keywordMatch = (value: string) => {
      const lowered = value.toLowerCase();
      return lowered.includes('atlassian') || lowered.includes('jira') || lowered.includes('rovo');
    };

    const detectFromSettings = (settings: any) => {
      const servers = settings?.mcpServers;
      if (!servers || typeof servers !== 'object') return null;

      for (const [name, config] of Object.entries<any>(servers)) {
        const configString = [
          name,
          config?.command || '',
          ...(Array.isArray(config?.args) ? config.args : []),
          config?.url || '',
        ].join(' ');

        if (keywordMatch(configString)) {
          return name;
        }
      }
      return null;
    };

    if (claudeCliAvailable) {
      try {
        const output = execSync('claude mcp list', {
          encoding: 'utf8',
          timeout: 4000,
          stdio: 'pipe',
          shell: '/bin/bash'
        }).trim();

        const lines = output.split('\n');
        const matchedLine = lines.find((line) => keywordMatch(line));
        if (matchedLine) {
          serverName = matchedLine.trim().split(/\s+/)[0] || 'atlassian-mcp';
          configured = true;
          available = true;
          source = 'cli';
        }
      } catch (error) {
        cliError = error instanceof Error ? error.message : 'Failed to run claude mcp list';
      }
    }

    if (!configured) {
      const settingsPaths = [
        join(homedir(), '.claude', 'settings.json'),
        join(homedir(), '.claude', 'settings.local.json')
      ];

      for (const filePath of settingsPaths) {
        if (!existsSync(filePath)) continue;
        try {
          const raw = readFileSync(filePath, 'utf8');
          const parsed = JSON.parse(raw);
          const detected = detectFromSettings(parsed);
          if (detected) {
            serverName = detected;
            configured = true;
            source = 'settings';
            break;
          }
        } catch {
          // Ignore invalid settings files
        }
      }
    }

    if (!available) {
      available = configured && claudeCliAvailable;
    }

    return c.json({
      available,
      configured,
      claudeCliAvailable,
      serverName,
      source,
      cliError
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/maestro/studio', async (c) => {
  try {
    const { exec, execSync } = await import('node:child_process');
    const { homedir } = await import('node:os');
    const { createConnection } = await import('node:net');

    const maestroPath = `${homedir()}/.maestro/bin/maestro`;
    const javaPath = '/opt/homebrew/opt/openjdk@17/bin';
    const env = { ...process.env, PATH: `${javaPath}:${process.env.PATH}` };
    const studioUrl = 'http://localhost:9999';

    // Check if Maestro Studio is already running (port 9999)
    const isPortInUse = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port: 9999, host: 'localhost' });
      socket.on('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.on('error', () => {
        resolve(false);
      });
    });

    if (isPortInUse) {
      // Already running, just open browser
      exec(`open ${studioUrl}`);
      return c.json({
        success: true,
        message: 'Maestro Studio already running',
        url: studioUrl,
        alreadyRunning: true
      });
    }

    // Check if a device is running
    let hasDevice = false;
    let deviceType = '';
    try {
      // Check for iOS Simulator
      const simResult = execSync('xcrun simctl list devices booted 2>/dev/null | grep -c "Booted"', { encoding: 'utf8', stdio: 'pipe' });
      if (parseInt(simResult.trim()) > 0) {
        hasDevice = true;
        deviceType = 'ios';
      }
    } catch {}

    if (!hasDevice && ADB_PATH) {
      try {
        // Check for Android Emulator (using detected SDK path)
        const adbResult = execSync(`"${ADB_PATH}" devices 2>/dev/null | grep -v "List" | grep -c "device$"`, { encoding: 'utf8', stdio: 'pipe' });
        if (parseInt(adbResult.trim()) > 0) {
          hasDevice = true;
          deviceType = 'android';
        }
      } catch {}
    }

    if (!hasDevice) {
      return c.json({
        success: false,
        message: 'No device running. Start iOS Simulator or Android Emulator first.',
        fallbackUrl: 'https://maestro.dev?utm_source=discoverylab#maestro-studio'
      }, 400);
    }

    // Run maestro studio in background
    exec(`${maestroPath} studio`, { env }, (error) => {
      if (error) console.error('Maestro studio error:', error);
    });

    // Wait a bit then open browser
    setTimeout(() => {
      exec(`open ${studioUrl}`);
    }, 2000);

    return c.json({
      success: true,
      message: 'Starting Maestro Studio...',
      url: studioUrl,
      deviceType
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/ios-simulator', async (c) => {
  try {
    const { exec, execSync } = await import('node:child_process');
    const body = await c.req.json().catch(() => ({}));
    const requestedUdid = body.udid; // Optional: specific simulator UDID to boot

    if (requestedUdid) {
      // Boot specific simulator
      try {
        execSync(`xcrun simctl boot ${requestedUdid}`, { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        // Might already be booted, that's OK
      }
      // Open Simulator app to show the booted device
      exec('open -a Simulator', () => {});

      // Get device name for message
      try {
        const listOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8' });
        const simData = JSON.parse(listOutput);
        for (const [runtime, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.udid === requestedUdid) {
              return c.json({ success: true, message: `Booting ${device.name}...` });
            }
          }
        }
      } catch {}
      return c.json({ success: true, message: 'Booting iOS Simulator...' });
    }

    // No specific UDID - just open Simulator app
    exec('open -a Simulator', (error) => {
      if (error) console.error('Failed to open Simulator:', error);
    });

    return c.json({ success: true, message: 'Opening iOS Simulator...' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/android-emulator', async (c) => {
  try {
    const { exec, execSync } = await import('node:child_process');
    const body = await c.req.json().catch(() => ({}));
    const requestedAvd = body.avd; // Optional: specific AVD to launch

    // Check if SDK is available
    if (!EMULATOR_PATH) {
      return c.json({
        success: false,
        message: 'Android SDK not found. Looking in: ~/Library/Android/sdk',
        hint: 'Install Android Studio or set ANDROID_HOME environment variable'
      }, 400);
    }

    try {
      const emulatorList = execSync(`"${EMULATOR_PATH}" -list-avds 2>/dev/null`, { encoding: 'utf8' });
      const avds = emulatorList.trim().split('\n').filter(Boolean);

      if (avds.length > 0) {
        const avdToLaunch = requestedAvd || avds[0];
        if (!avds.includes(avdToLaunch)) {
          return c.json({
            success: false,
            message: `AVD "${avdToLaunch}" not found`,
            availableAvds: avds
          }, 400);
        }

        // Start the emulator
        exec(`"${EMULATOR_PATH}" -avd ${avdToLaunch} &`, (error) => {
          if (error) console.error('Failed to start emulator:', error);
        });
        return c.json({ success: true, message: `Starting Android Emulator: ${avdToLaunch}`, availableAvds: avds });
      } else {
        return c.json({
          success: false,
          message: 'No Android Virtual Devices found. Create one in Android Studio first.',
          hint: 'Open Android Studio > Device Manager > Create Device'
        }, 400);
      }
    } catch (error) {
      return c.json({
        success: false,
        message: 'Failed to list Android emulators',
        error: error instanceof Error ? error.message : 'Unknown error'
      }, 400);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// DEVICES API - List all available iOS/Android devices (like VS Code does)
// ============================================================================
app.get('/api/devices', async (c) => {
  try {
    const { execSync } = await import('node:child_process');
    const devices: Array<{
      id: string;
      name: string;
      platform: 'ios' | 'android';
      status: 'booted' | 'shutdown' | 'connected' | 'offline';
      type: 'simulator' | 'emulator' | 'physical';
    }> = [];

    // Get iOS Simulators (all, not just booted)
    try {
      const simOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8' });
      const simData = JSON.parse(simOutput);
      for (const [runtime, runtimeDevices] of Object.entries(simData.devices) as any) {
        // Only include iOS runtimes (skip watchOS, tvOS)
        if (!runtime.includes('iOS')) continue;
        const iosVersion = runtime.match(/iOS[- ](\d+[.-]\d+)/)?.[1]?.replace('-', '.') || '';
        for (const device of runtimeDevices) {
          devices.push({
            id: device.udid,
            name: `${device.name} (iOS ${iosVersion})`,
            platform: 'ios',
            status: device.state === 'Booted' ? 'booted' : 'shutdown',
            type: 'simulator'
          });
        }
      }
    } catch {}

    // Get Android Emulators (AVDs)
    if (EMULATOR_PATH) {
      try {
        const avdOutput = execSync(`"${EMULATOR_PATH}" -list-avds`, { encoding: 'utf8' });
        const avds = avdOutput.trim().split('\n').filter(Boolean);

        // Check which ones are running
        let runningDevices: string[] = [];
        if (ADB_PATH) {
          try {
            const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
            runningDevices = adbOutput.split('\n')
              .filter(line => line.includes('device') && !line.includes('offline'))
              .map(line => line.split('\t')[0]);
          } catch {}
        }

        for (const avd of avds) {
          // Check if this AVD is currently running
          const isRunning = runningDevices.some(d => d.includes('emulator'));
          devices.push({
            id: avd,
            name: avd.replace(/_/g, ' '),
            platform: 'android',
            status: isRunning ? 'booted' : 'shutdown',
            type: 'emulator'
          });
        }
      } catch {}
    }

    // Get physical Android devices
    if (ADB_PATH) {
      try {
        const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
        const lines = adbOutput.split('\n').slice(1);
        for (const line of lines) {
          if (line.trim() && !line.includes('emulator')) {
            const parts = line.split(/\s+/);
            const deviceId = parts[0];
            if (!deviceId) continue;

            const isOffline = line.includes('offline');
            const modelMatch = line.match(/model:(\S+)/);
            const deviceMatch = line.match(/device:(\S+)/);
            const name = modelMatch?.[1] || deviceMatch?.[1] || deviceId;

            devices.push({
              id: deviceId,
              name: name.replace(/_/g, ' '),
              platform: 'android',
              status: isOffline ? 'offline' : 'connected',
              type: 'physical'
            });
          }
        }
      } catch {}
    }

    return c.json({
      devices,
      sdkStatus: {
        ios: true, // Xcode is generally available on macOS
        android: !!ADB_PATH,
        androidSdkPath: findAndroidSdkPath()
      }
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Mobile Recording using MaestroRecorder (captures touch events + generates YAML)
app.post('/api/testing/mobile/record/start', async (c) => {
  try {
    const { execSync } = await import('node:child_process');

    // Parse request body for user-selected device
    const body = await c.req.json().catch(() => ({}));
    const { deviceId: requestedDeviceId, platform: requestedPlatform } = body;

    // Detect running device
    let platform: 'ios' | 'android' | null = null;
    let deviceId = '';
    let deviceName = '';

    // If user explicitly selected a device, use it
    if (requestedDeviceId && requestedPlatform) {
      platform = requestedPlatform as 'ios' | 'android';
      deviceId = requestedDeviceId;

      // Get device name for the selected device
      if (platform === 'ios') {
        try {
          const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
          const simData = JSON.parse(simOutput);
          for (const [runtime, devices] of Object.entries(simData.devices) as any) {
            for (const device of devices) {
              if (device.udid === deviceId) {
                deviceName = device.name;
                break;
              }
            }
            if (deviceName) break;
          }
        } catch {}
        deviceName = deviceName || deviceId;
      } else if (platform === 'android' && ADB_PATH) {
        try {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.startsWith(deviceId)) {
              const modelMatch = line.match(/model:(\S+)/);
              deviceName = modelMatch?.[1] || deviceId;
              break;
            }
          }
        } catch {}
        deviceName = deviceName || deviceId;
      }
    } else {
      // Fallback: Auto-detect device (original logic)

      // Check iOS Simulator
      try {
        const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
        const simData = JSON.parse(simOutput);
        for (const [runtime, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.state === 'Booted') {
              platform = 'ios';
              deviceId = device.udid;
              deviceName = device.name;
              break;
            }
          }
          if (platform) break;
        }
      } catch {}

      // Check Android if no iOS (using detected SDK path)
      if (!platform && ADB_PATH) {
        try {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') && !line.includes('offline')) {
              const parts = line.split(/\s+/);
              deviceId = parts[0];
              const modelMatch = line.match(/model:(\S+)/);
              deviceName = modelMatch?.[1] || deviceId;
              platform = 'android';
              break;
            }
          }
        } catch {}
      }
    }

    if (!platform || !deviceId) {
      return c.json({
        error: 'No running device found. Start iOS Simulator or Android Emulator first.'
      }, 400);
    }

    // Bring device to foreground for better testing experience
    try {
      if (platform === 'ios') {
        execSync('osascript -e \'tell application "Simulator" to activate\'', { encoding: 'utf8' });
        console.log('[Focus] iOS Simulator brought to foreground');
      } else if (platform === 'android') {
        execSync('osascript -e \'tell application "qemu-system-aarch64" to activate\' 2>/dev/null || osascript -e \'tell application "Android Emulator" to activate\' 2>/dev/null || true', { encoding: 'utf8' });
        console.log('[Focus] Android Emulator brought to foreground');
      }
    } catch {
      // Silently ignore focus errors
    }

    // Start recording with MaestroRecorder (captures touch events + video)
    const recorder = getMaestroRecorder();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const sessionName = `Mobile Test - ${timestamp}`;

    const session = await recorder.startRecording(
      sessionName,
      deviceId,
      deviceName,
      platform
    );

    return c.json({
      success: true,
      sessionId: session.id,
      platform,
      deviceId,
      deviceName,
      captureMode: session.captureMode || 'manual',
      message: `Recording ${deviceName} (capturing touch events)...`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Add tap action during recording (captured from UI click on mirrored display)
app.post('/api/testing/mobile/record/tap', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    const body = await c.req.json();
    const { x, y, description } = body;

    if (x === undefined || y === undefined) {
      return c.json({ error: 'x and y coordinates are required' }, 400);
    }

    // Add the tap action to the recording
    void recorder
      .addManualAction('tap', description || `Tap at (${x}, ${y})`, { x, y })
      .catch(error => console.warn('[MobileRecord] Failed to record tap:', error));

    return c.json({
      success: true,
      message: `Tap recorded at (${x}, ${y})`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Send tap to device (and optionally record it)
app.post('/api/testing/mobile/device/tap', async (c) => {
  let tapPlatform: 'ios' | 'android' | null = null;
  let tapDeviceId: string | null = null;
  let tapCoords = { x: 0, y: 0 };

  try {
    const recorder = getMaestroRecorder();
    const session = recorder.getSession();
    const body = await c.req.json();
    const { x, y, platform, deviceId, appId } = body || {};
    tapCoords = { x: x ?? 0, y: y ?? 0 };
    tapPlatform = platform || session?.platform || liveStreamPlatform;
    tapDeviceId = deviceId || session?.deviceId || liveStreamDeviceId;

    if (x === undefined || y === undefined) {
      return c.json({ error: 'x and y coordinates are required' }, 400);
    }

    const tapX = Number(x);
    const tapY = Number(y);

    if (!Number.isFinite(tapX) || !Number.isFinite(tapY)) {
      return c.json({ error: 'x and y must be numbers' }, 400);
    }

    if (!tapPlatform) {
      return c.json({ error: 'No target platform available' }, 400);
    }

    if (!tapDeviceId) {
      try {
        if (tapPlatform === 'android' && ADB_PATH) {
          const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8' });
          const lines = adbOutput.split('\n').slice(1);
          for (const line of lines) {
            if (line.includes('device') && !line.includes('offline')) {
              const parts = line.split(/\s+/);
              tapDeviceId = parts[0];
              break;
            }
          }
        }
      } catch {}

      if (tapPlatform === 'ios' && !tapDeviceId) {
        try {
          const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
          const simData = JSON.parse(simOutput);
          for (const [, devices] of Object.entries(simData.devices) as any) {
            for (const device of devices) {
              if (device.state === 'Booted') {
                tapDeviceId = device.udid;
                break;
              }
            }
            if (tapDeviceId) break;
          }
        } catch {}
      }
    }

    if (!tapDeviceId) {
      return c.json({ error: 'No target device found' }, 400);
    }

    if (tapPlatform === 'android') {
      // Android: ADB tap with retry logic and increased timeout
      const adbPath = ADB_PATH || 'adb';
      let attempts = 0;
      const maxAttempts = 2;
      let lastError: Error | null = null;

      while (attempts < maxAttempts) {
        try {
          execSync(`"${adbPath}" -s ${tapDeviceId} shell input tap ${Math.round(tapX)} ${Math.round(tapY)}`, {
            timeout: 5000,
          });
          lastError = null;
          break;
        } catch (e) {
          lastError = e instanceof Error ? e : new Error(String(e));
          attempts++;
          if (attempts < maxAttempts) {
            await new Promise(r => setTimeout(r, 100));
          }
        }
      }

      if (lastError) {
        console.error('[ADB TAP FAILED]', { attempts, error: lastError.message, device: tapDeviceId });
        throw lastError;
      }
    } else {
      // iOS: Try idb first (optional optimization), then Maestro
      let tapSuccess = false;

      // Method 1: Try idb if available (optional - faster taps)
      const idbAvailable = await isIdbInstalled();
      if (idbAvailable) {
        tapSuccess = await tapViaIdb(tapDeviceId, tapX, tapY);
        if (tapSuccess) {
          console.log('[iOS TAP] via idb');
        }
      }

      // Method 2: Maestro (primary method)
      if (!tapSuccess) {
        const maestroAvailable = await isMaestroInstalled();
        if (!maestroAvailable) {
          return c.json({
            error: 'Maestro CLI not installed. Install with: curl -Ls "https://get.maestro.mobile.dev" | bash',
          }, 424);
        }

        // Acquire lock to prevent concurrent Maestro executions (causes log file conflicts)
        const lock = acquireMaestroTapLock();
        await lock.acquired;

        try {
          const { mkdir, writeFile, rm } = await import('node:fs/promises');
          const { join } = await import('node:path');
          const tempBase = join(tmpdir(), 'discoverylab-maestro-live');
          const flowPath = join(tempBase, `tap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yaml`);
          const outputDir = join(tempBase, `out-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

          await mkdir(tempBase, { recursive: true });

          // Also ensure Maestro log directory exists to prevent race conditions
          const maestroLogDir = join(homedir(), 'Library', 'Logs', 'maestro');
          await mkdir(maestroLogDir, { recursive: true });

          const flowLines: string[] = [];
          let resolvedAppId = appId || session?.appId;

          // If no appId, try to get it from the foreground app on iOS
          if (!resolvedAppId && tapPlatform === 'ios' && tapDeviceId) {
            resolvedAppId = getIOSForegroundAppId(tapDeviceId);
          }

          // Maestro requires appId - fallback to springboard (always present on iOS)
          const finalAppId = resolvedAppId || 'com.apple.springboard';
          flowLines.push(`appId: ${finalAppId}`, '');
          flowLines.push('---', '- tapOn:', `    point: "${Math.round(tapX)},${Math.round(tapY)}"`);
          await writeFile(flowPath, flowLines.join('\n'));

          const result = await runMaestroTest({
            flowPath,
            device: tapDeviceId,
            timeout: 15000, // Reduced from 30s to 15s
            outputDir,
          });

          await rm(flowPath, { force: true });
          await rm(outputDir, { recursive: true, force: true });

          // Clean up any zombie maestro processes after tap
          await killZombieMaestroProcesses();

          if (!result.success) {
            const errorMessage = result.error || 'Failed to send tap via Maestro';
            const dependencyError = /maestro cli is not installed|java runtime|command not found|not runnable/i.test(errorMessage);
            console.error('[iOS TAP MAESTRO FAILED]', { error: errorMessage, device: tapDeviceId, x: tapX, y: tapY });
            return c.json({ error: errorMessage }, dependencyError ? 424 : 500);
          }
        } finally {
          lock.release();
        }
      }
    }

    let recorded = false;
    if (recorder.isRecording()) {
      void recorder
        .addManualAction('tap', `Tap at (${Math.round(tapX)}, ${Math.round(tapY)})`, {
          x: Math.round(tapX),
          y: Math.round(tapY),
        })
        .catch(error => console.warn('[MobileTap] Failed to record tap:', error));
      recorded = true;
    }

    return c.json({
      success: true,
      platform: tapPlatform,
      deviceId: tapDeviceId,
      recorded,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const stack = error instanceof Error ? error.stack : '';
    console.error('[TAP ERROR]', {
      message,
      stack,
      x: tapCoords.x,
      y: tapCoords.y,
      platform: tapPlatform,
      deviceId: tapDeviceId
    });
    return c.json({
      error: message,
      platform: tapPlatform,
      device: tapDeviceId
    }, 500);
  }
});

// Add swipe action during recording
app.post('/api/testing/mobile/record/swipe', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    const body = await c.req.json();
    const { startX, startY, endX, endY, description } = body;

    if (startX === undefined || startY === undefined || endX === undefined || endY === undefined) {
      return c.json({ error: 'startX, startY, endX, endY coordinates are required' }, 400);
    }

    // Add the swipe action to the recording
    void recorder
      .addManualAction('swipe', description || `Swipe from (${startX}, ${startY}) to (${endX}, ${endY})`, {
        x: startX,
        y: startY,
        endX,
        endY
      })
      .catch(error => console.warn('[MobileRecord] Failed to record swipe:', error));

    return c.json({
      success: true,
      message: `Swipe recorded`
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/mobile/record/stop', async (c) => {
  try {
    const recorder = getMaestroRecorder();

    if (!recorder.isRecording()) {
      return c.json({ error: 'No active recording session' }, 400);
    }

    // Get autoAnalyze setting from request body (default: true)
    let autoAnalyze = true;
    try {
      const body = await c.req.json();
      autoAnalyze = body?.autoAnalyze !== false;
    } catch {
      // No body or invalid JSON, use default
    }

    // Stop recording and get session with generated YAML
    const session = await recorder.stopRecording();

    // Use session ID as project ID for consistency
    const projectId = session.id;
    const { dirname, join } = await import('node:path');
    const { readdirSync, writeFileSync, existsSync, readFileSync } = await import('node:fs');
    const outputDir = dirname(session.flowPath || session.screenshotsDir);

    // Find first screenshot for thumbnail
    let thumbnailPath: string | null = null;
    let screenshotCount = 0;
    let screenshotFiles: string[] = [];
    try {
      screenshotFiles = readdirSync(session.screenshotsDir)
        .filter(f => f.endsWith('.png'))
        .sort();
      screenshotCount = screenshotFiles.length;
      if (screenshotFiles.length > 0) {
        thumbnailPath = join(session.screenshotsDir, screenshotFiles[0]);
      }
    } catch {
      // No screenshots found
    }

    // Track if we'll run background analysis
    let actions = session.actions;
    const willAnalyze = autoAnalyze && screenshotCount >= 1;

    // Generate a better project name
    const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const actionsCount = actions.length;
    const deviceShort = session.deviceName?.split(' ')[0] || session.platform?.toUpperCase() || 'Mobile';
    const projectName = actionsCount > 0
      ? `${deviceShort} Test - ${actionsCount} actions - ${dateStr}`
      : `${deviceShort} Recording - ${dateStr}`;

    // Ensure YAML file exists
    const flowPath = join(outputDir, 'test.yaml');
    let flowContent = '';
    if (existsSync(flowPath)) {
      try {
        flowContent = readFileSync(flowPath, 'utf-8');
      } catch {}
    }

    const isPlaceholderYaml = flowContent.includes('# Auto-generated Maestro test flow') &&
      flowContent.includes('# Add your test steps here');

    if (actionsCount === 0 && screenshotFiles.length > 0 && (!flowContent || isPlaceholderYaml)) {
      const escapedFiles = screenshotFiles.map(file => file.replace(/"/g, '\\"'));
      const manualYaml = `# Auto-generated Maestro test flow
# Generated by DiscoveryLab (manual capture fallback)
# ${new Date().toISOString()}
# Note: manual mode cannot capture taps automatically

appId: ${session.appId || 'com.example.app # TODO: Set your app ID'}

---

- launchApp

${escapedFiles.map((file, index) => `# Screenshot ${index + 1}\n- takeScreenshot:\n    path: "${file}"\n`).join('\n')}
`;
      writeFileSync(flowPath, manualYaml, 'utf-8');
      session.flowPath = flowPath;
      flowContent = manualYaml;
      console.log(`[MobileRecording] Created screenshot fallback YAML at ${flowPath}`);
    }

    if (!flowContent) {
      const basicYaml = `# Auto-generated Maestro test flow
# Generated by DiscoveryLab
# ${new Date().toISOString()}
# OCR: ${willAnalyze ? 'Analysis running in background' : 'disabled'}

appId: com.example.app # TODO: Set your app ID

---

# Add your test steps here
# - launchApp
# - tapOn:
#     text: "Button"

`;
      writeFileSync(flowPath, basicYaml, 'utf-8');
      session.flowPath = flowPath;
      console.log(`[MobileRecording] Created placeholder YAML at ${flowPath}`);
    }

    // Save project to database using drizzle ORM
    // Status is 'analyzing' if we'll run background OCR, otherwise 'completed'
    const db = getDatabase();
    await db.insert(projects).values({
      id: projectId,
      name: projectName,
      videoPath: outputDir,
      thumbnailPath: thumbnailPath,
      platform: session.platform,
      status: willAnalyze ? 'analyzing' : 'completed',
      frameCount: actionsCount,
      ocrText: null, // Will be filled by background analysis
      createdAt: new Date(),
      updatedAt: new Date()
    });

    // Fire and forget: run OCR in background if enabled
    if (willAnalyze) {
      console.log(`[MobileRecording] Starting background OCR analysis for ${screenshotCount} screenshots...`);
      // Don't await - let it run in background
      runOCRInBackground(projectId, session.screenshotsDir, screenshotFiles).catch(err => {
        console.error('[MobileRecording] Background OCR error:', err);
      });
    }

    return c.json({
      success: true,
      projectId,
      sessionId: session.id,
      flowPath: session.flowPath,
      flowCode: flowContent,
      videoPath: session.videoPath,
      screenshotsDir: session.screenshotsDir,
      thumbnailPath,
      actionsCount: actionsCount,
      aiAnalysisUsed: willAnalyze, // Renamed but kept for frontend compatibility
      ocrAnalysisUsed: willAnalyze,
      ocrInProgress: willAnalyze, // New flag for frontend polling
      platform: session.platform,
      deviceName: session.deviceName,
      captureMode: session.captureMode || 'manual',
      duration: session.endedAt ? Math.floor((session.endedAt - session.startedAt) / 1000) : 0
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get mobile recording session info
app.get('/api/testing/mobile/record/status', async (c) => {
  const recorder = getMaestroRecorder();
  const session = recorder.getSession();

  if (!session) {
    return c.json({ active: false });
  }

  return c.json({
    active: true,
    sessionId: session.id,
    platform: session.platform,
    deviceName: session.deviceName,
    captureMode: session.captureMode || 'manual',
    actionsCount: session.actions.length,
    duration: Math.floor((Date.now() - session.startedAt) / 1000)
  });
});

// Polling endpoint for project analysis status
app.get('/api/projects/:id/analysis-status', async (c) => {
  try {
    const projectId = c.req.param('id');
    const db = getDatabase();
    const result = await db.select({
      status: projects.status,
      ocrText: projects.ocrText,
      aiSummary: projects.aiSummary,
      ocrEngine: projects.ocrEngine,
      ocrConfidence: projects.ocrConfidence
    }).from(projects).where(eq(projects.id, projectId)).limit(1);

    if (result.length === 0) {
      return c.json({ error: 'Project not found' }, 404);
    }

    const project = result[0];
    const analyzingStatuses = new Set(['analyzing', 'processing', 'pending', 'in_progress']);
    const statusValue = typeof project.status === 'string' ? project.status : '';
    return c.json({
      isAnalyzing: analyzingStatuses.has(statusValue),
      status: statusValue,
      hasOCR: !!project.ocrText,
      hasSummary: !!project.aiSummary,
      ocrEngine: project.ocrEngine || null,
      ocrConfidence: project.ocrConfidence ?? null,
      ocrTextLength: project.ocrText?.length || 0,
      aiSummaryLength: project.aiSummary?.length || 0
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Re-analyze a mobile recording with AI to detect actions
app.post('/api/testing/mobile/recordings/:id/analyze', async (c) => {
  try {
    const recordingId = c.req.param('id');
    const { readdirSync, writeFileSync, existsSync: fsExistsSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingDir = join(PROJECTS_DIR, 'maestro-recordings', recordingId);
    const screenshotsDir = join(recordingDir, 'screenshots');

    if (!fsExistsSync(screenshotsDir)) {
      return c.json({ error: 'Screenshots directory not found' }, 404);
    }

    const screenshotFiles = readdirSync(screenshotsDir)
      .filter(f => f.endsWith('.png'))
      .sort();

    if (screenshotFiles.length < 2) {
      return c.json({ error: 'Not enough screenshots for analysis (need at least 2)' }, 400);
    }

    console.log(`[MobileRecording] Re-analyzing recording ${recordingId} with ${screenshotFiles.length} screenshots...`);

    // Run AI analysis
    const analysisResult = await analyzeScreenshotsForActions(screenshotsDir);

    if (analysisResult.actions.length === 0) {
      return c.json({
        success: true,
        message: 'AI analysis completed but no actions detected',
        actionsCount: 0,
        summary: analysisResult.summary
      });
    }

    // Generate and save Maestro YAML
    const maestroYaml = generateMaestroYaml(
      analysisResult.actions,
      undefined,
      analysisResult.appName
    );

    const flowPath = join(recordingDir, 'test.yaml');
    writeFileSync(flowPath, maestroYaml, 'utf-8');

    console.log(`[MobileRecording] AI detected ${analysisResult.actions.length} actions, YAML saved to ${flowPath}`);

    return c.json({
      success: true,
      message: `AI detected ${analysisResult.actions.length} actions`,
      actionsCount: analysisResult.actions.length,
      actions: analysisResult.actions,
      summary: analysisResult.summary,
      flowPath
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MobileRecording] AI re-analysis failed:', error);
    return c.json({ error: message }, 500);
  }
});

app.post('/api/testing/playwright/codegen', async (c) => {
  try {
    const { exec } = await import('node:child_process');
    exec('npx playwright codegen', (error) => {
      if (error) console.error('Playwright codegen error:', error);
    });
    return c.json({ success: true, message: 'Playwright Codegen starting...' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List mobile recordings
app.get('/api/testing/mobile/recordings', async (c) => {
  try {
    const { readdirSync, readFileSync, statSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingsDir = join(PROJECTS_DIR, 'maestro-recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ recordings: [] });
    }

    const recordings: any[] = [];
    const dirs = readdirSync(recordingsDir);

    for (const dir of dirs) {
      const sessionPath = join(recordingsDir, dir, 'session.json');
      if (existsSync(sessionPath)) {
        try {
          const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
          recordings.push({
            id: session.id,
            name: session.name,
            platform: session.platform,
            deviceName: session.deviceName,
            actionsCount: session.actions?.length || 0,
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            flowPath: session.flowPath,
            videoPath: session.videoPath,
            screenshotsDir: session.screenshotsDir
          });
        } catch (e) {
          console.error('Error reading session:', dir, e);
        }
      }
    }

    // Sort by date descending
    recordings.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));

    return c.json({ recordings });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get mobile recording details with flow code
app.get('/api/testing/mobile/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const sessionPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'session.json');
    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const session = JSON.parse(readFileSync(sessionPath, 'utf-8'));
    let flowCode = '';

    if (existsSync(flowPath)) {
      flowCode = readFileSync(flowPath, 'utf-8');
    }

    return c.json({
      session,
      flowCode
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Save edited flow code
app.put('/api/testing/mobile/recordings/:id/flow', async (c) => {
  try {
    const { id } = c.req.param();
    const body = await c.req.json();
    const { flowCode } = body;
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    writeFileSync(flowPath, flowCode, 'utf-8');

    return c.json({ success: true });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete mobile recording
app.delete('/api/testing/mobile/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { rmSync } = await import('node:fs');
    const { join } = await import('node:path');

    const recordingDir = join(PROJECTS_DIR, 'maestro-recordings', id);

    if (!existsSync(recordingDir)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    // Delete the recording directory
    rmSync(recordingDir, { recursive: true, force: true });

    // Also delete associated project from database (same ID is used)
    const db = getDatabase();
    await db.delete(projects).where(eq(projects.id, id));
    await db.delete(frames).where(eq(frames.projectId, id));

    console.log(`[Delete] Removed mobile recording and project: ${id}`);

    return c.json({ success: true });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Replay mobile recording with Maestro
app.post('/api/testing/mobile/recordings/:id/replay', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync, existsSync: fsExistsSync } = await import('node:fs');
    const { exec, execSync } = await import('node:child_process');
    const { join } = await import('node:path');

    const flowPath = join(PROJECTS_DIR, 'maestro-recordings', id, 'test.yaml');

    if (!existsSync(flowPath)) {
      return c.json({ error: 'Flow file not found' }, 404);
    }

    // NOTE: Device focus removed from replay - the device is mirrored in the UI
    // so the user can see it there. Focus is only needed for initial recording.

    // Run Maestro test in background
    const maestroPath = join(process.env.HOME || '', '.maestro', 'bin', 'maestro');
    const cmd = existsSync(maestroPath) ? maestroPath : 'maestro';

    exec(`"${cmd}" test "${flowPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('Maestro replay error:', error);
      } else {
        console.log('Maestro replay completed:', stdout);
      }
    });

    return c.json({
      success: true,
      message: 'Maestro test started',
      flowPath
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// AUTO-CAPTURE API - Automatic screenshot capture during test execution
// ============================================================================

// State for auto-capture
let autoCaptureInterval: NodeJS.Timeout | null = null;
let autoCaptureRecordingId: string | null = null;
let autoCaptureScreenshotCount = 0;

// Start auto-capture for a test run
app.post('/api/testing/mobile/auto-capture/start', async (c) => {
  try {
    const { recordingId, platform } = await c.req.json();
    const { join } = await import('node:path');
    const { mkdirSync, existsSync: fsExistsSync, writeFileSync } = await import('node:fs');

    if (!recordingId) {
      return c.json({ error: 'recordingId required' }, 400);
    }

    // Stop any existing auto-capture
    if (autoCaptureInterval) {
      clearInterval(autoCaptureInterval);
      autoCaptureInterval = null;
    }

    autoCaptureRecordingId = recordingId;
    autoCaptureScreenshotCount = 0;

    // Ensure screenshots directory exists
    const screenshotsDir = join(PROJECTS_DIR, 'maestro-recordings', recordingId, 'screenshots');
    if (!fsExistsSync(screenshotsDir)) {
      mkdirSync(screenshotsDir, { recursive: true });
    }

    // Capture screenshots every 2 seconds during test execution
    const { promisify } = await import('node:util');
    const execCaptureAsync = promisify(exec);

    autoCaptureInterval = setInterval(async () => {
      try {
        const screenshotPath = join(screenshotsDir, `auto_${Date.now()}_${autoCaptureScreenshotCount}.png`);
        autoCaptureScreenshotCount++;

        if (platform === 'ios') {
          await execCaptureAsync(`xcrun simctl io booted screenshot "${screenshotPath}"`, { timeout: 5000 });
        } else {
          const adbPath = ADB_PATH || 'adb';
          // For Android, capture to device then pull
          await execCaptureAsync(`"${adbPath}" shell screencap -p /sdcard/auto_capture.png && "${adbPath}" pull /sdcard/auto_capture.png "${screenshotPath}"`, { timeout: 5000 });
        }

        console.log(`[AutoCapture] Screenshot ${autoCaptureScreenshotCount}: ${screenshotPath}`);
      } catch (err) {
        console.log('[AutoCapture] Screenshot capture failed:', err);
      }
    }, 2000);

    // Auto-stop after 60 seconds max
    setTimeout(() => {
      if (autoCaptureInterval && autoCaptureRecordingId === recordingId) {
        clearInterval(autoCaptureInterval);
        autoCaptureInterval = null;
        console.log(`[AutoCapture] Auto-stopped after 60s for ${recordingId}`);
      }
    }, 60000);

    return c.json({
      success: true,
      message: 'Auto-capture started',
      recordingId,
      screenshotsDir
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop auto-capture
app.post('/api/testing/mobile/auto-capture/stop', async (c) => {
  try {
    const { recordingId } = await c.req.json();
    const { join } = await import('node:path');
    const { readdirSync, existsSync: fsExistsSync } = await import('node:fs');

    if (autoCaptureInterval) {
      clearInterval(autoCaptureInterval);
      autoCaptureInterval = null;
    }

    const stoppedId = autoCaptureRecordingId;
    const screenshotsCaptured = autoCaptureScreenshotCount;
    autoCaptureRecordingId = null;
    autoCaptureScreenshotCount = 0;

    // Count actual screenshots saved
    let savedScreenshots = 0;
    if (stoppedId) {
      const screenshotsDir = join(PROJECTS_DIR, 'maestro-recordings', stoppedId, 'screenshots');
      if (fsExistsSync(screenshotsDir)) {
        savedScreenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).length;
      }
    }

    console.log(`[AutoCapture] Stopped for ${stoppedId || recordingId}, ${savedScreenshots} screenshots saved`);

    return c.json({
      success: true,
      message: 'Auto-capture stopped',
      recordingId: stoppedId || recordingId,
      screenshotsCaptured,
      savedScreenshots
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// MOBILE CHAT API - AI-powered device navigation
// ============================================================================

// Simple LLM provider interface
interface LLMProvider {
  name: string;
  sendMessage: (prompt: string) => Promise<string>;
}

const CLAUDE_CLI_TIMEOUT_MS = 90_000;
const MOBILE_CHAT_LLM_TIMEOUT_MS = 45_000;
let claudeCliAvailableCache: boolean | null = null;

function isClaudeCliAvailable(): boolean {
  if (claudeCliAvailableCache === true) {
    return claudeCliAvailableCache;
  }
  try {
    execSync('claude --version', { stdio: 'pipe', timeout: 3000 });
    claudeCliAvailableCache = true;
    return true;
  } catch {
    // Don't cache negative results - PATH and auth can change at runtime
    claudeCliAvailableCache = null;
    return false;
  }
  return false;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function runClaudeCliWithArgs(
  prompt: string,
  args: string[],
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  const { mkdtemp, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const tempDir = await mkdtemp(join(tmpdir(), 'claude-cli-'));
  const promptPath = join(tempDir, 'prompt.txt');
  const stdoutPath = join(tempDir, 'stdout.txt');
  const stderrPath = join(tempDir, 'stderr.txt');

  await writeFile(promptPath, prompt, 'utf8');

  const quotedArgs = args.map(arg => shellQuote(arg)).join(' ');
  const shellScript = [
    'set -euo pipefail',
    `prompt=$(cat ${shellQuote(promptPath)})`,
    `claude ${quotedArgs} "$prompt" > ${shellQuote(stdoutPath)} 2> ${shellQuote(stderrPath)}`
  ].join('\n');

  let didTimeout = false;
  let timeoutHandle: NodeJS.Timeout | null = null;
  const child = spawn('bash', ['-lc', shellScript], {
    stdio: 'inherit',
    env: { ...process.env },
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        didTimeout = true;
        try {
          child.kill('SIGTERM');
        } catch {}
      }, timeoutMs);

      child.on('error', reject);
      child.on('close', (code) => resolve(code));
    });

    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    const [stdoutTextRaw, stderrTextRaw] = await Promise.all([
      readFile(stdoutPath, 'utf8').catch(() => ''),
      readFile(stderrPath, 'utf8').catch(() => ''),
    ]);
    return {
      stdout: stdoutTextRaw.trim(),
      stderr: stderrTextRaw.trim(),
      exitCode,
      timedOut: didTimeout,
    };
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

async function runClaudeCli(prompt: string): Promise<string> {
  const args = [
    '-p',
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
  ];

  const result = await runClaudeCliWithArgs(prompt, args, CLAUDE_CLI_TIMEOUT_MS);

  if (result.timedOut) {
    throw new Error(`Claude CLI timeout (${Math.round(CLAUDE_CLI_TIMEOUT_MS / 1000)}s).`);
  }

  if (result.stderr) {
    const truncated = result.stderr.length > 400 ? `${result.stderr.slice(0, 400)}...` : result.stderr;
    console.log('[Claude CLI stderr]', truncated);
  }

  if (result.exitCode !== 0 && !result.stdout) {
    const detail = result.stderr || `exit code ${result.exitCode ?? 'unknown'}`;
    const truncated = detail.length > 400 ? `${detail.slice(0, 400)}...` : detail;
    throw new Error(`Claude CLI error: ${truncated}`);
  }

  return result.stdout || result.stderr;
}

// Get configured LLM provider (prioritize API keys over CLI for speed)
async function getLLMProvider(): Promise<LLMProvider | null> {
  try {
    // 1. Check for Anthropic API key first (fastest, most reliable)
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      const anthropicModel = llmSettings.anthropicModel || 'claude-sonnet-4-20250514';
      return {
        name: `anthropic-api (${anthropicModel})`,
        sendMessage: async (prompt: string) => {
          const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': anthropicKey,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
              model: anthropicModel,
              max_tokens: 1024,
              messages: [{ role: 'user', content: prompt }]
            })
          });
          const data = await response.json() as { content?: Array<{ text?: string }> };
          return data.content?.[0]?.text || '';
        }
      };
    }

    // Check for OpenAI API key
    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      const openaiModel = llmSettings.openaiModel || 'gpt-5.2';
      return {
        name: `openai-api (${openaiModel})`,
        sendMessage: async (prompt: string) => {
          const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${openaiKey}`
            },
            body: JSON.stringify({
              model: openaiModel,
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 1024
            })
          });
          const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
          return data.choices?.[0]?.message?.content || '';
        }
      };
    }

    // 3. Claude CLI (local) - default when installed and no API keys configured
    if (isClaudeCliAvailable()) {
      return {
        name: 'claude-cli (local)',
        sendMessage: runClaudeCli,
      };
    }

    // 4. Check for Ollama (local - uses settings or defaults)
    try {
      const ollamaUrl = llmSettings.ollamaUrl || 'http://localhost:11434';
      const ollamaModel = llmSettings.ollamaModel || 'llama3.2';
      const response = await fetch(`${ollamaUrl}/api/tags`, { method: 'GET' });
      if (response.ok) {
        return {
          name: `ollama (${ollamaModel})`,
          sendMessage: async (prompt: string) => {
            const resp = await fetch(`${ollamaUrl}/api/generate`, {
              method: 'POST',
              body: JSON.stringify({
                model: ollamaModel,
                prompt,
                stream: false
              })
            });
            const data = await resp.json() as { response?: string };
            return data.response || '';
          }
        };
      }
    } catch {
      // Ollama not available
    }

    return null;
  } catch {
    return null;
  }
}

// ============================================================================
// BACKGROUND OCR & APP INTELLIGENCE ANALYSIS
// ============================================================================

type AppIntelligenceContext = 'mobile' | 'web';

function buildAppIntelligencePrompt(context: AppIntelligenceContext, ocrText: string): string {
  const truncatedText = ocrText.slice(0, 8000);

  if (context === 'web') {
    return `Analyze the following OCR text extracted from web application screenshots/pages. Provide a structured analysis in Markdown format focused on QA and product review.

OCR TEXT:
${truncatedText}

Please provide your analysis in the following format:

## Page / App Overview
Brief 2-3 sentence description of what this web experience appears to be.

## Key UI Elements
- List important buttons, labels, forms, tables, menus, and navigation items
- Focus on actionable and testable elements

## Likely User Flow
1. Describe the apparent user journey through the pages
2. Number each step clearly

## Content Summary
| Category | Examples |
|----------|----------|
| Navigation | menus, tabs, breadcrumbs |
| Actions | primary buttons and CTAs |
| Forms & Inputs | fields, filters, search |
| Data & Views | tables, cards, lists, charts |

## QA Observations
- Potential edge cases
- Areas that deserve deeper testing

Keep your analysis concise and actionable for QA testing purposes.`;
  }

  return `Analyze the following OCR text extracted from mobile app screenshots. Provide a structured analysis in Markdown format.

OCR TEXT:
${truncatedText}

Please provide your analysis in the following format:

## App Overview
Brief 2-3 sentence description of what this app appears to be.

## UI Elements Found
- List key buttons, labels, and navigation items
- Focus on actionable elements

## User Flow
1. Describe the apparent user journey
2. Number each step

## Content Summary
| Category | Examples |
|----------|----------|
| Labels | key labels found |
| Actions | buttons/actions available |
| Navigation | menu items, tabs |

## Observations
- Any notable UX patterns
- Potential areas of interest for testing

Keep your analysis concise and actionable for QA testing purposes.`;
}

// Generate App Intelligence summary using LLM with markdown formatting
async function generateAppIntelligenceSummary(
  provider: LLMProvider,
  ocrText: string,
  context: AppIntelligenceContext
): Promise<string> {
  const prompt = buildAppIntelligencePrompt(context, ocrText);

  try {
    const response = await provider.sendMessage(prompt);
    return response || 'Unable to generate summary';
  } catch (error) {
    console.error('[AppIntelligence] LLM summary generation failed:', error);
    return 'Summary generation failed';
  }
}

// Background OCR processing - runs asynchronously after recording stops
async function runOCRInBackground(
  projectId: string,
  screenshotsDir: string,
  screenshotFiles: string[]
): Promise<void> {
  console.log(`[BackgroundOCR] Starting analysis for project ${projectId} with ${screenshotFiles.length} screenshots`);

  try {
    const { recognizeTextBatch } = await import('../core/analyze/ocr.js');
    const { join } = await import('node:path');

    // Build full paths for screenshots
    const fullPaths = screenshotFiles.map(f => join(screenshotsDir, f));

    // Run OCR on all screenshots
    const ocrResult = await recognizeTextBatch(fullPaths, { recognitionLevel: 'accurate' });

    let ocrText = '';
    let aiSummary = '';

    const ocrEngines = new Set<string>();
    const ocrConfidences: number[] = [];
    for (const result of ocrResult.results || []) {
      if (result.ocr?.engine) {
        ocrEngines.add(result.ocr.engine);
      }
      if (typeof result.ocr?.confidence === 'number') {
        ocrConfidences.push(result.ocr.confidence);
      }
    }

    const ocrEngine = ocrEngines.has('vision')
      ? 'vision'
      : ocrEngines.has('tesseract')
        ? 'tesseract'
        : null;
    const ocrConfidence = ocrConfidences.length > 0
      ? ocrConfidences.reduce((sum, value) => sum + value, 0) / ocrConfidences.length
      : null;

    if (ocrResult.success && ocrResult.totalText) {
      ocrText = ocrResult.totalText;
      console.log(`[BackgroundOCR] Extracted ${ocrText.length} characters from ${fullPaths.length} screenshots`);

      // Try to generate AI summary with LLM
      const provider = await getLLMProvider();
      if (provider) {
        console.log(`[BackgroundOCR] Generating App Intelligence summary with ${provider.name}...`);
        aiSummary = await generateAppIntelligenceSummary(provider, ocrText, 'mobile');
        console.log(`[BackgroundOCR] Generated ${aiSummary.length} character summary`);
      } else {
        // Fallback to simple word frequency analysis
        const words = ocrText.split(/\s+/).filter(w => w.length > 2);
        const uniqueWords = [...new Set(words.map(w => w.toLowerCase()))];
        const topWords = uniqueWords.slice(0, 20).join(', ');
        aiSummary = `Analyzed ${fullPaths.length} screenshots. Found ${words.length} words.\n\n**Key terms:** ${topWords || 'none detected'}\n\n*Note: Configure ANTHROPIC_API_KEY or OPENAI_API_KEY for enhanced AI analysis.*`;
      }
    } else {
      aiSummary = `Analyzed ${fullPaths.length} screenshots. No text detected via OCR.`;
      console.log('[BackgroundOCR] No text found in screenshots');
    }

    // Update project with analysis results
    const db = getDatabase();
    await db.update(projects).set({
      status: 'analyzed',
      ocrText: ocrText || null,
      ocrEngine,
      ocrConfidence,
      aiSummary,
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    console.log(`[BackgroundOCR] Analysis complete for project ${projectId}`);
    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });
  } catch (error) {
    console.error(`[BackgroundOCR] Analysis failed for project ${projectId}:`, error);

    // Update project status to indicate failure
    const db = getDatabase();
    await db.update(projects).set({
      status: 'analyzed',
      aiSummary: 'Analysis failed. Try re-analyzing from the project view.',
      ocrEngine: null,
      ocrConfidence: null,
      updatedAt: new Date()
    }).where(eq(projects.id, projectId));

    broadcastToClients({
      type: 'projectAnalysisUpdated',
      data: { projectId, status: 'analyzed' }
    });
  }
}

type MobileChatCommand = { type: string; description: string; params: Record<string, unknown> };

// Parse Maestro commands from LLM response
function parseMaestroCommands(response: string): MobileChatCommand[] {
  const commands: MobileChatCommand[] = [];

  // Look for YAML-like commands in the response
  const commandPatterns = [
    { regex: /tap(?:On)?\s*(?:on\s+)?["']([^"']+)["']/gi, type: 'tapOn', paramKey: 'text' },
    { regex: /click\s*(?:on\s+)?["']([^"']+)["']/gi, type: 'tapOn', paramKey: 'text' },
    { regex: /type\s*["']([^"']+)["']/gi, type: 'inputText', paramKey: 'text' },
    { regex: /input\s*["']([^"']+)["']/gi, type: 'inputText', paramKey: 'text' },
    { regex: /swipe\s*(up|down|left|right)/gi, type: 'swipe', paramKey: 'direction' },
    { regex: /scroll\s*(up|down)/gi, type: 'scroll', paramKey: 'direction' },
    { regex: /assert\s*(?:visible\s+)?["']([^"']+)["']/gi, type: 'assertVisible', paramKey: 'text' },
    { regex: /wait\s*(\d+)/gi, type: 'wait', paramKey: 'seconds' },
    { regex: /launch\s*(?:app)?\s*["']?([a-zA-Z.]+)["']?/gi, type: 'launchApp', paramKey: 'appId' },
  ];

  for (const pattern of commandPatterns) {
    let match;
    while ((match = pattern.regex.exec(response)) !== null) {
      commands.push({
        type: pattern.type,
        description: `${pattern.type}: ${match[1]}`,
        params: { [pattern.paramKey]: match[1] }
      });
    }
  }

  return commands;
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}…`;
}

function sanitizeChatHistory(
  history: unknown,
  limit = 6,
  maxCharsPerMessage = 400
): Array<{ role: string; content: string }> {
  if (!Array.isArray(history)) return [];
  const recent = history
    .filter((item): item is { role: string; content: string } => {
      return typeof item?.role === 'string' && typeof item?.content === 'string';
    })
    .slice(-limit);

  return recent.map(item => ({
    role: item.role,
    content: truncateForPrompt(item.content, maxCharsPerMessage),
  }));
}

function tryParseClaudeJsonOutput(output: string): Record<string, unknown> | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {}

  const candidates = trimmed.split('\n').map(line => line.trim()).filter(Boolean).reverse();
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }

  return null;
}

function looksLikeClaudeCliError(output: string): boolean {
  const lowered = output.toLowerCase();
  return (
    lowered.includes('error_during_execution') ||
    lowered.includes('permission_denials') ||
    lowered.includes('enoent') ||
    lowered.includes('no such file or directory') ||
    lowered.includes('traceback') ||
    lowered.includes('claude cli timeout') ||
    lowered.includes('command failed: claude') ||
    lowered.includes('failed to run claude')
  );
}

function sanitizeChatCommands(commands: MobileChatCommand[]): MobileChatCommand[] {
  return commands.filter(cmd => {
    switch (cmd.type) {
      case 'tapOn':
      case 'inputText':
      case 'assertVisible': {
        const value = typeof cmd.params.text === 'string' ? cmd.params.text.trim() : '';
        if (!value) return false;
        cmd.params.text = value;
        return true;
      }
      case 'swipe':
      case 'scroll': {
        const direction = typeof cmd.params.direction === 'string' ? cmd.params.direction.trim() : '';
        if (!direction) return false;
        cmd.params.direction = direction;
        return true;
      }
      case 'wait': {
        const seconds = Number.parseFloat(String(cmd.params.seconds || 0));
        if (!Number.isFinite(seconds) || seconds <= 0) return false;
        cmd.params.seconds = seconds;
        return true;
      }
      case 'launchApp':
        return true;
      default:
        return false;
    }
  });
}

function normalizeStructuredCommand(input: unknown): MobileChatCommand | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  const type = typeof obj.type === 'string' ? obj.type : null;
  if (!type) return null;

  const params = obj.params && typeof obj.params === 'object'
    ? (obj.params as Record<string, unknown>)
    : {};
  const description = typeof obj.description === 'string' && obj.description.trim().length > 0
    ? obj.description
    : `${type}`;

  return { type, params, description };
}

function detectSimpleCommandsFromMessage(message: string): { response: string; commands: MobileChatCommand[] } | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const greetingMatch = /^(oi|olá|ola|hello|hi|eai|e aí|bom dia|boa tarde|boa noite)\b/i;
  if (greetingMatch.test(trimmed)) {
    return {
      response: 'Hi! Tell me what action you want to test in the app (e.g., "tap on Create Project").',
      commands: []
    };
  }

  // If the user describes a multi-step flow, defer to the LLM.
  const complexityMarkers = /\b(depois|then|em seguida|and|ap[oó]s|apos|seguinte)\b/i;
  if (complexityMarkers.test(trimmed) || trimmed.includes('\n')) {
    return null;
  }

  const quotedTapMatch = trimmed.match(
    /(?:tap|click|clique|toque|tocar|pressione|aperte)\s+(?:no|na|em)?\s*(?:bot[aã]o|button)?\s*["“”']([^"“”']+)["“”']/i
  );
  if (quotedTapMatch?.[1]) {
    const target = quotedTapMatch[1].trim();
    if (target) {
      return {
        response: `Vou tocar em "${target}".`,
        commands: [{ type: 'tapOn', description: `tapOn: ${target}`, params: { text: target } }],
      };
    }
  }

  const unquotedTapMatch = trimmed.match(
    /(?:tap|click|clique|toque|tocar|pressione|aperte)\s+(?:no|na|em)?\s*(?:bot[aã]o|button)?\s+([^\n.,;:]{1,60})/i
  );
  if (unquotedTapMatch?.[1]) {
    const target = unquotedTapMatch[1].trim();
    if (target) {
      return {
        response: `Vou tocar em "${target}".`,
        commands: [{ type: 'tapOn', description: `tapOn: ${target}`, params: { text: target } }],
      };
    }
  }

  const inputMatch = trimmed.match(/(?:digite|type|input|escreva|preencha)\s+["“”']([^"“”']+)["“”']/i);
  if (inputMatch?.[1]) {
    const text = inputMatch[1].trim();
    if (text) {
      return {
        response: `Vou digitar "${text}".`,
        commands: [{ type: 'inputText', description: `inputText: ${text}`, params: { text } }],
      };
    }
  }

  const swipeMatch = trimmed.match(/(?:swipe|deslize|arraste)\s+(up|down|left|right|cima|baixo|esquerda|direita)/i);
  if (swipeMatch?.[1]) {
    const directionMap: Record<string, string> = {
      cima: 'up',
      baixo: 'down',
      esquerda: 'left',
      direita: 'right',
      up: 'up',
      down: 'down',
      left: 'left',
      right: 'right',
    };
    const directionKey = swipeMatch[1].toLowerCase();
    const direction = directionMap[directionKey];
    if (direction) {
      return {
        response: `Vou deslizar para ${direction}.`,
        commands: [{ type: 'swipe', description: `swipe: ${direction}`, params: { direction } }],
      };
    }
  }

  const scrollMatch = trimmed.match(/(?:scroll|role)\s+(up|down|cima|baixo)/i);
  if (scrollMatch?.[1]) {
    const normalized = scrollMatch[1].toLowerCase();
    const direction = normalized === 'up' || normalized.startsWith('c') ? 'up' : 'down';
    return {
      response: `Vou rolar para ${direction}.`,
      commands: [{ type: 'scroll', description: `scroll: ${direction}`, params: { direction } }],
    };
  }

  const waitMatch = trimmed.match(/(?:wait|espere|aguarde)\s*(\d+(?:[.,]\d+)?)?/i);
  if (waitMatch) {
    const seconds = waitMatch[1] ? Number.parseFloat(waitMatch[1].replace(',', '.')) : 1;
    if (!Number.isNaN(seconds) && seconds > 0) {
      return {
        response: `Vou aguardar ${seconds} segundo(s).`,
        commands: [{ type: 'wait', description: `wait: ${seconds}`, params: { seconds } }],
      };
    }
  }

  return null;
}

async function runClaudeCliMobileChat(
  message: string,
  platform: MobilePlatform | null,
  history: Array<{ role: string; content: string }>
): Promise<{ responseText: string; commands: MobileChatCommand[]; rawOutput: string; model: string }> {
  const claudeCliModel = llmSettings.claudeCliModel || process.env.CLAUDE_CLI_MODEL || 'haiku';

  const mobileChatSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['response', 'commands'],
    properties: {
      response: { type: 'string' },
      commands: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type', 'params'],
          additionalProperties: true,
          properties: {
            type: {
              type: 'string',
              enum: ['tapOn', 'inputText', 'swipe', 'scroll', 'assertVisible', 'wait', 'launchApp']
            },
            description: { type: 'string' },
            params: { type: 'object' }
          }
        }
      }
    }
  } as const;

  const systemPrompt = [
    'You are a mobile testing agent focused on Maestro.',
    'Respond quickly with few steps (max 4).',
    'Use only simple and direct actions.',
    'For simple commands, assume the element exists and generate the steps.',
    'Avoid asking for clarification; only do so if there\'s no clear action.',
    'Don\'t claim you already executed or succeeded; describe what you will do.',
    'Follow the JSON schema strictly.',
  ].join(' ');

  const historyText = history.length > 0
    ? history.map(item => `${item.role}: ${item.content}`).join('\n')
    : '';
  const platformLabel = platform ? platform.toUpperCase() : 'MOBILE';

  const promptParts = [
    `Platform: ${platformLabel}`,
    historyText ? `Recent history:\n${historyText}` : '',
    `User request: ${truncateForPrompt(message, 800)}`,
  ].filter(Boolean);
  const prompt = promptParts.join('\n\n');

  const args = [
    '-p',
    '--model',
    claudeCliModel,
    '--tools',
    '',
    '--permission-mode',
    'dontAsk',
    '--no-session-persistence',
    '--output-format',
    'json',
    '--json-schema',
    JSON.stringify(mobileChatSchema),
    '--system-prompt',
    systemPrompt,
  ];

  const result = await runClaudeCliWithArgs(prompt, args, MOBILE_CHAT_LLM_TIMEOUT_MS);
  if (result.timedOut) {
    throw new Error(`Claude CLI timeout (${Math.round(MOBILE_CHAT_LLM_TIMEOUT_MS / 1000)}s).`);
  }

  const rawOutput = (result.stdout && result.stdout.trim().length > 0)
    ? result.stdout
    : result.stderr || '';

  if (looksLikeClaudeCliError(rawOutput)) {
    return {
      responseText: 'Couldn\'t access Claude CLI now. Try again or describe a simple step.',
      commands: [],
      rawOutput,
      model: claudeCliModel,
    };
  }

  const envelope = tryParseClaudeJsonOutput(rawOutput);
  const structured = envelope?.structured_output as Record<string, unknown> | undefined;

  let responseText = structured && typeof structured.response === 'string'
    ? structured.response.trim()
    : '';

  const structuredCommands = structured?.commands;
  const commands = Array.isArray(structuredCommands)
    ? structuredCommands.map(normalizeStructuredCommand).filter((cmd): cmd is MobileChatCommand => !!cmd)
    : [];

  if (!responseText) {
    responseText = truncateForPrompt(rawOutput || 'Ok.', 1200);
  }

  const fallbackCommands = commands.length > 0 ? commands : parseMaestroCommands(responseText);
  return {
    responseText,
    commands: sanitizeChatCommands(fallbackCommands),
    rawOutput,
    model: claudeCliModel,
  };
}

// Generate Maestro YAML from chat commands
function generateChatMaestroYaml(commands: Array<{ type: string; params: Record<string, unknown> }>, appId?: string): string {
  const escapeYaml = (value: string) => value.replace(/"/g, '\\"');
  const lines: string[] = [];

  const launchCommandAppId = commands.find(cmd => cmd.type === 'launchApp')?.params?.appId;
  const resolvedAppId = appId || (typeof launchCommandAppId === 'string' ? launchCommandAppId : undefined);

  if (resolvedAppId) {
    lines.push(`appId: ${resolvedAppId}`);
  }
  lines.push('---');

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'launchApp':
        if (resolvedAppId) {
          lines.push('- launchApp');
        } else if (typeof cmd.params.appId === 'string') {
          lines.push(`- launchApp: "${escapeYaml(cmd.params.appId)}"`);
        } else {
          lines.push('- launchApp');
        }
        break;
      case 'tapOn':
        lines.push('- tapOn:');
        lines.push(`    text: "${escapeYaml(String(cmd.params.text))}"`);
        break;
      case 'inputText':
        lines.push('- inputText:');
        lines.push(`    text: "${escapeYaml(String(cmd.params.text))}"`);
        break;
      case 'swipe':
      case 'scroll':
        const dir = String(cmd.params.direction).toLowerCase();
        if (dir === 'up') lines.push('- scroll');
        else if (dir === 'down') lines.push('- scrollUntilVisible:\n    element: ".*"\n    direction: "DOWN"');
        else lines.push(`- swipe:\n    direction: "${dir.toUpperCase()}"`);
        break;
      case 'assertVisible':
        lines.push('- assertVisible:');
        lines.push(`    text: "${escapeYaml(String(cmd.params.text))}"`);
        break;
      case 'wait':
        const seconds = Math.max(1, parseInt(String(cmd.params.seconds || 3), 10) || 3);
        lines.push(`- extendedWaitUntil:\n    visible: ".*"\n    timeout: ${seconds * 1000}`);
        break;
    }
  }

  return lines.join('\n');
}

type MobilePlatform = 'ios' | 'android';

function normalizeMobilePlatform(value: unknown): MobilePlatform | null {
  return value === 'ios' || value === 'android' ? value : null;
}

function extractAppIdFromCommands(commands: Array<{ type: string; params: Record<string, unknown> }>): string | undefined {
  const launchAppId = commands.find(cmd => cmd.type === 'launchApp')?.params?.appId;
  return typeof launchAppId === 'string' && launchAppId.trim().length > 0 ? launchAppId.trim() : undefined;
}

async function resolveDeviceNameForChat(deviceId: string, platform: MobilePlatform): Promise<string> {
  if (!deviceId) return platform;

  if (platform === 'ios') {
    try {
      const simOutput = execSync('xcrun simctl list devices -j', { encoding: 'utf8', timeout: 4000 });
      const simData = JSON.parse(simOutput) as { devices?: Record<string, Array<{ udid: string; name: string }>> };
      const runtimes = Object.values(simData.devices || {});
      for (const devices of runtimes) {
        const match = devices.find(device => device.udid === deviceId);
        if (match?.name) {
          return match.name;
        }
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to resolve iOS device name:', error);
    }
    return deviceId;
  }

  if (ADB_PATH) {
    try {
      const adbOutput = execSync(`"${ADB_PATH}" devices -l`, { encoding: 'utf8', timeout: 4000 });
      const matchLine = adbOutput
        .split('\n')
        .find(line => line.trim().startsWith(deviceId));
      if (matchLine) {
        const modelMatch = matchLine.match(/model:(\S+)/);
        return modelMatch?.[1]?.replace(/_/g, ' ') || deviceId;
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to resolve Android device name:', error);
    }
  }

  return deviceId;
}

async function ensureChatRecordingSession(
  deviceId: string,
  platform: MobilePlatform,
  appId?: string
): Promise<MaestroRecordingSession | null> {
  const recorder = getMaestroRecorder();
  const existing = recorder.getSession();

  if (existing?.status === 'recording') {
    if (existing.deviceId === deviceId && existing.platform === platform) {
      if (appId && !existing.appId) {
        existing.appId = appId;
      }
      console.log('[MobileChat] Reusing active recording session:', existing.id);
      return existing;
    }
    try {
      await recorder.stopRecording();
    } catch (error) {
      console.warn('[MobileChat] Failed to stop previous recording session:', error);
    }
  }

  const deviceName = await resolveDeviceNameForChat(deviceId, platform);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sessionName = `Mobile Chat - ${timestamp}`;

  try {
    const session = await recorder.startRecording(
      sessionName,
      deviceId,
      deviceName,
      platform,
      appId,
      { preferNativeRecord: false }
    );
    console.log('[MobileChat] Chat recording started:', session.id);
    return session;
  } catch (error) {
    console.error('[MobileChat] Failed to start chat recording session:', error);
    return null;
  }
}

async function recordChatCommands(
  commands: Array<{ type: string; params: Record<string, unknown> }>,
  session: MaestroRecordingSession | null
): Promise<void> {
  if (!session || session.status !== 'recording' || commands.length === 0) {
    return;
  }

  const recorder = getMaestroRecorder();

  for (const cmd of commands) {
    try {
      switch (cmd.type) {
        case 'launchApp': {
          const appId = typeof cmd.params.appId === 'string' ? cmd.params.appId : session.appId;
          if (appId && !session.appId) {
            session.appId = appId;
          }
          await recorder.addManualAction('launch', appId ? `Launch app ${appId}` : 'Launch app', {
            appId,
            text: appId,
          });
          break;
        }
        case 'tapOn': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('tap', `Tap on "${text}"`, { text });
          }
          break;
        }
        case 'inputText': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('input', `Input "${text}"`, { text });
          }
          break;
        }
        case 'swipe': {
          const direction = typeof cmd.params.direction === 'string'
            ? cmd.params.direction.toLowerCase()
            : 'up';
          await recorder.addManualAction('swipe', `Swipe ${direction}`, { direction });
          break;
        }
        case 'scroll': {
          const direction = typeof cmd.params.direction === 'string'
            ? cmd.params.direction.toLowerCase()
            : 'down';
          await recorder.addManualAction('scroll', `Scroll ${direction}`, { direction });
          break;
        }
        case 'assertVisible': {
          const text = typeof cmd.params.text === 'string' ? cmd.params.text : String(cmd.params.text ?? '');
          if (text) {
            await recorder.addManualAction('assert', `Assert visible "${text}"`, { text });
          }
          break;
        }
        case 'wait': {
          const seconds = Math.max(1, parseInt(String(cmd.params.seconds || 3), 10) || 3);
          await recorder.addManualAction('wait', `Wait ${seconds}s`, { seconds });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      console.warn('[MobileChat] Failed to record command:', cmd, error);
    }
  }
}

app.post('/api/mobile-chat/message', async (c) => {
  try {
    const body = await c.req.json();
    const { message, deviceId, platform, history } = body;

    if (!message) {
      return c.json({ error: 'Message is required' }, 400);
    }

    const recorder = getMaestroRecorder();
    const resolvedPlatformForPrompt =
      normalizeMobilePlatform(platform) || recorder.getSession()?.platform || liveStreamPlatform || null;
    const sanitizedHistory = sanitizeChatHistory(history);
    const simpleDetection = detectSimpleCommandsFromMessage(message);

    let llmResponse = '';
    let commands: MobileChatCommand[] = [];
    let llmModelUsed: string | undefined;
    let providerName = 'rule-based';

    const llmStart = Date.now();
    if (simpleDetection) {
      llmResponse = simpleDetection.response;
      commands = simpleDetection.commands;
      llmModelUsed = 'rule-based';
    } else {
      const provider = await getLLMProvider();
      if (!provider) {
        return c.json({
          error: 'No LLM provider available. Configure Claude CLI, ANTHROPIC_API_KEY, OPENAI_API_KEY, or run Ollama locally.',
          response: '⚠️ Chat not available\n\nTo use chat, configure one of these options in Settings:\n\n• **Local Claude CLI (default)** - verify `claude` is installed and authenticated (`claude login`)\n• **ANTHROPIC_API_KEY** - faster\n• **OPENAI_API_KEY** - alternative\n• **Local Ollama** - free (requires installation)'
        }, 424);
      }

      providerName = provider.name;

      if (provider.name.startsWith('claude-cli')) {
        const structured = await runClaudeCliMobileChat(message, resolvedPlatformForPrompt, sanitizedHistory);
        llmResponse = structured.responseText;
        commands = structured.commands;
        llmModelUsed = structured.model;
      } else {
        const systemContext = `You are a mobile testing assistant. The user wants to test a mobile app on ${resolvedPlatformForPrompt || 'a device'}.
Your job is to understand what the user wants to do and respond with:
1. A brief confirmation of what you'll do
2. The specific UI actions needed (tap on "X", type "Y", etc.)

When describing actions, use these exact formats that I can parse:
- tap "Button Text" or click "Menu Item"
- type "some text" or input "search query"
- swipe up/down/left/right
- scroll up/down
- assert visible "Expected Text"
- wait 3 (seconds)
- launch app "com.example.app"

Keep responses concise and action-oriented.`;

        const conversationContext = sanitizedHistory.length > 0
          ? '\n\nPrevious conversation:\n' + sanitizedHistory.map(m => `${m.role}: ${m.content}`).join('\n')
          : '';
        const prompt = `${systemContext}${conversationContext}\n\nUser: ${truncateForPrompt(message, 800)}`;

        llmResponse = await provider.sendMessage(prompt);
        commands = parseMaestroCommands(llmResponse);
      }
    }
    const llmDurationMs = Date.now() - llmStart;
    console.log(
      `[MobileChat] ${providerName}${llmModelUsed ? ` (${llmModelUsed})` : ''} in ${llmDurationMs}ms, commands=${commands.length}`
    );

    commands = sanitizeChatCommands(commands);
    if (!llmResponse && commands.length === 0) {
      llmResponse = 'Describe the step you want to execute in the app, for example: "tap on Create Project".';
    }

    const resolvedDeviceId = deviceId || recorder.getSession()?.deviceId || liveStreamDeviceId || undefined;
    const resolvedPlatform = resolvedPlatformForPrompt;
    const commandsAppId = extractAppIdFromCommands(commands);
    let resolvedAppId = commandsAppId || recorder.getSession()?.appId;

    if (!resolvedAppId && resolvedDeviceId && resolvedPlatform === 'ios') {
      resolvedAppId = getIOSForegroundAppId(resolvedDeviceId) || 'com.apple.springboard';
    } else if (!resolvedAppId && resolvedDeviceId && resolvedPlatform === 'android') {
      resolvedAppId = getAndroidForegroundAppId(resolvedDeviceId) || undefined;
    }

    if (resolvedAppId) {
      console.log(`[MobileChat] Resolved appId: ${resolvedAppId}`);
    }

    let recordingSession: MaestroRecordingSession | null = null;
    if (commands.length > 0 && resolvedDeviceId && resolvedPlatform) {
      recordingSession = await ensureChatRecordingSession(resolvedDeviceId, resolvedPlatform, resolvedAppId);
      if (resolvedAppId && recordingSession && !recordingSession.appId) {
        recordingSession.appId = resolvedAppId;
      }
      await recordChatCommands(commands, recordingSession);
    } else if (commands.length > 0 && recorder.getSession()?.status === 'recording') {
      recordingSession = recorder.getSession();
      if (resolvedAppId && recordingSession && !recordingSession.appId) {
        recordingSession.appId = resolvedAppId;
      }
      await recordChatCommands(commands, recordingSession);
    }

    const deviceForExecution = resolvedDeviceId || recordingSession?.deviceId;
    let appIdForFlow = recordingSession?.appId || resolvedAppId;

    if (!appIdForFlow && resolvedPlatform === 'ios') {
      appIdForFlow = 'com.apple.springboard';
    }

    // Execute commands if we have a device
    let executedActions: Array<{ type: string; description: string }> = commands.map(cmd => ({
      type: cmd.type,
      description: cmd.description,
    }));
    let executionStarted = false;
    const executionTimeoutMs = 15000;

    if (commands.length > 0 && (!deviceForExecution || !resolvedPlatform)) {
      llmResponse = llmResponse
        ? `${llmResponse}\n\n⚠️ No active device found to execute. Start the simulator/emulator and try again.`
        : '⚠️ No active device found to execute. Start the simulator/emulator and try again.';
    }

    if (commands.length > 0 && deviceForExecution) {
      executionStarted = true;

      // Generate and execute Maestro flow without blocking the chat response
      const flowYaml = generateChatMaestroYaml(commands, appIdForFlow);
      const { writeFile, rm } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const flowPath = join(
        PROJECTS_DIR,
        `temp-chat-flow-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.yaml`
      );

      await writeFile(flowPath, flowYaml);

      const runStartedAt = Date.now();
      void runMaestroTest({
        flowPath,
        device: deviceForExecution,
        timeout: executionTimeoutMs,
      })
        .then(result => {
          const runDurationMs = Date.now() - runStartedAt;
          if (!result.success) {
            console.warn(`[MobileChat] Maestro finished with error in ${runDurationMs}ms:`, result.error);
            const errorMessage = result.error || 'Maestro execution failed';
            const errorShort = errorMessage.length > 320 ? `${errorMessage.slice(0, 320)}...` : errorMessage;
            broadcastToClients({
              type: 'mobileChatExecutionResult',
              data: {
                success: false,
                durationMs: runDurationMs,
                deviceId: deviceForExecution,
                appId: appIdForFlow || null,
                error: errorShort,
              }
            });
            return;
          }
          console.log(`[MobileChat] Maestro finished in ${runDurationMs}ms`);
          broadcastToClients({
            type: 'mobileChatExecutionResult',
            data: {
              success: true,
              durationMs: runDurationMs,
              deviceId: deviceForExecution,
              appId: appIdForFlow || null,
            }
          });
        })
        .catch(execError => {
          console.error('[MobileChat] Maestro execution error:', execError);
          const errorMessage = execError instanceof Error ? execError.message : String(execError);
          const errorShort = errorMessage.length > 320 ? `${errorMessage.slice(0, 320)}...` : errorMessage;
          broadcastToClients({
            type: 'mobileChatExecutionResult',
            data: {
              success: false,
              durationMs: Date.now() - runStartedAt,
              deviceId: deviceForExecution,
              appId: appIdForFlow || null,
              error: errorShort,
            }
          });
        })
        .finally(async () => {
          try {
            await rm(flowPath, { force: true });
          } catch (cleanupError) {
            console.warn('[MobileChat] Failed to clean up temp flow:', cleanupError);
          }
          // Force a fresh live-stream frame after Maestro run so the UI updates quickly
          void captureAndBroadcastScreen();
        });
    }

    const activeSession = recorder.getSession();

    return c.json({
      response: llmResponse,
      actions: executedActions,
      provider: providerName,
      commandsDetected: commands.length,
      executionStarted,
      executionTimeoutMs,
      llmDurationMs,
      llmModelUsed,
      recordingSessionId: activeSession?.id,
      recordingActive: recorder.isRecording(),
      recordingDeviceName: activeSession?.deviceName,
      recordingAppId: activeSession?.appId,
      recordingFlowPath: activeSession?.flowPath
    });

  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error('[MOBILE CHAT ERROR]', error);
    return c.json({ error: message }, 500);
  }
});

// Get available LLM providers status
app.get('/api/mobile-chat/providers', async (c) => {
  const providers: Array<{ name: string; available: boolean; configured: boolean }> = [];

  const claudeAvailable = isClaudeCliAvailable();
  providers.push({
    name: 'Claude CLI (local)',
    available: claudeAvailable,
    configured: claudeAvailable
  });

  // Check Anthropic API
  providers.push({
    name: 'Anthropic API',
    available: !!process.env.ANTHROPIC_API_KEY,
    configured: !!process.env.ANTHROPIC_API_KEY
  });

  // Check OpenAI API
  providers.push({
    name: 'OpenAI API',
    available: !!process.env.OPENAI_API_KEY,
    configured: !!process.env.OPENAI_API_KEY
  });

  // Check Ollama
  try {
    const response = await fetch('http://localhost:11434/api/tags', { method: 'GET' });
    providers.push({ name: 'Ollama', available: response.ok, configured: response.ok });
  } catch {
    providers.push({ name: 'Ollama', available: false, configured: false });
  }

  return c.json({ providers });
});

// ============================================================================
// SETUP API
// ============================================================================
app.get('/api/setup/status', async (c) => {
  try {
    const { setupStatusTool } = await import('../mcp/tools/setup.js');
    const result = await setupStatusTool.handler({});
    const data = JSON.parse(result.content[0].text!);
    return c.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// ============================================================================
// DATA DIRECTORY INFO
// ============================================================================
app.get('/api/info', (c) => {
  return c.json({
    version: '0.1.0',
    dataDir: DATA_DIR,
  });
});

// ============================================================================
// LLM SETTINGS API
// ============================================================================

// In-memory storage for LLM settings (persisted to file)
let llmSettings: {
  anthropicApiKey?: string;
  anthropicModel?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  ollamaUrl?: string;
  ollamaModel?: string;
  claudeCliModel?: string;
} = {};

// Load LLM settings from file on startup
(async () => {
  try {
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const settingsPath = join(DATA_DIR, 'llm-settings.json');
    if (existsSync(settingsPath)) {
      llmSettings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      // Set env vars from saved settings
      if (llmSettings.anthropicApiKey) process.env.ANTHROPIC_API_KEY = llmSettings.anthropicApiKey;
      if (llmSettings.openaiApiKey) process.env.OPENAI_API_KEY = llmSettings.openaiApiKey;
      console.log('[LLM Settings] Loaded from file');
    }
  } catch (e) {
    console.log('[LLM Settings] No saved settings found');
  }
})();

// Get LLM settings
app.get('/api/settings/llm', async (c) => {
  // Return masked API keys for display
  return c.json({
    anthropicApiKey: llmSettings.anthropicApiKey ? '••••••••' + llmSettings.anthropicApiKey.slice(-4) : '',
    anthropicModel: llmSettings.anthropicModel || 'claude-sonnet-4-20250514',
    openaiApiKey: llmSettings.openaiApiKey ? '••••••••' + llmSettings.openaiApiKey.slice(-4) : '',
    openaiModel: llmSettings.openaiModel || 'gpt-5.2',
    ollamaUrl: llmSettings.ollamaUrl || 'http://localhost:11434',
    ollamaModel: llmSettings.ollamaModel || 'llama3.2',
    claudeCliModel: llmSettings.claudeCliModel || process.env.CLAUDE_CLI_MODEL || 'haiku'
  });
});

// Save LLM settings
app.put('/api/settings/llm', async (c) => {
  try {
    const { writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const body = await c.req.json();

    // Only update if new value is provided (not masked)
    if (body.anthropicApiKey && !body.anthropicApiKey.startsWith('••')) {
      llmSettings.anthropicApiKey = body.anthropicApiKey;
      process.env.ANTHROPIC_API_KEY = body.anthropicApiKey;
    }
    if (body.anthropicModel) {
      llmSettings.anthropicModel = body.anthropicModel;
    }
    if (body.openaiApiKey && !body.openaiApiKey.startsWith('••')) {
      llmSettings.openaiApiKey = body.openaiApiKey;
      process.env.OPENAI_API_KEY = body.openaiApiKey;
    }
    if (body.openaiModel) {
      llmSettings.openaiModel = body.openaiModel;
    }
    if (body.ollamaUrl) {
      llmSettings.ollamaUrl = body.ollamaUrl;
    }
    if (body.ollamaModel) {
      llmSettings.ollamaModel = body.ollamaModel;
    }
    if (body.claudeCliModel) {
      llmSettings.claudeCliModel = body.claudeCliModel;
    }

    // Persist to file
    const settingsPath = join(DATA_DIR, 'llm-settings.json');
    writeFileSync(settingsPath, JSON.stringify(llmSettings, null, 2));

    return c.json({ success: true, message: 'LLM settings saved' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get Ollama status and available models
app.get('/api/ollama/status', async (c) => {
  const ollamaUrl = llmSettings.ollamaUrl || 'http://localhost:11434';

  try {
    // Check if Ollama is running by fetching tags (list of models)
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000); // 3s timeout

    const response = await fetch(`${ollamaUrl}/api/tags`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return c.json({
        running: false,
        models: [],
        error: 'Ollama not responding'
      });
    }

    const data = await response.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
    const models = (data.models || []).map(m => ({
      name: m.name,
      size: m.size,
      modified: m.modified_at
    }));

    return c.json({
      running: true,
      models,
      currentModel: llmSettings.ollamaModel || 'llama3.2',
      ollamaUrl
    });
  } catch (error) {
    // Ollama not running or not installed
    return c.json({
      running: false,
      models: [],
      error: error instanceof Error ? error.message : 'Ollama not available'
    });
  }
});

// ============================================================================
// PLAYWRIGHT RECORDER API
// ============================================================================

import { getRecorder, type RecordingSession, type RecordingAction } from '../core/testing/playwrightRecorder.js';
import { WebSocketServer, WebSocket } from 'ws';

// Store connected WebSocket clients
const wsClients = new Set<WebSocket>();

// Start a new recording
app.post('/api/recorder/start', async (c) => {
  try {
    const body = await c.req.json();
    const { name, url, resolution, captureResolution, viewportMode, viewportResolution } = body;

    if (!name || !url) {
      return c.json({ error: 'Name and URL are required' }, 400);
    }

    // Backward compatibility: legacy `resolution` maps to capture resolution.
    const captureResolutionKey: string | undefined = captureResolution || resolution;
    const viewportModeFinal: 'auto' | 'fixed' = viewportMode === 'fixed' ? 'fixed' : 'auto';
    const viewportResolutionKey: string | undefined = viewportResolution || captureResolutionKey;

    const recorder = getRecorder();

    // Setup event listeners for WebSocket broadcast
    recorder.on('action', (action: RecordingAction) => {
      broadcastToClients({
        type: 'action',
        data: action,
      });
    });

    recorder.on('screenshot', (path: string, actionId: string) => {
      broadcastToClients({
        type: 'screenshot',
        data: { path, actionId },
      });
    });

    recorder.on('status', (status: string) => {
      broadcastToClients({
        type: 'status',
        data: { status },
      });
    });

    const session = await recorder.startRecording(name, url, {
      resolution: captureResolutionKey,
      captureResolution: captureResolutionKey,
      viewportMode: viewportModeFinal,
      viewportResolution: viewportModeFinal === 'fixed' ? viewportResolutionKey : undefined,
    });

    // Helpful for debugging when the UI appears zoomed or fixed-size
    console.log('[Recorder] start:', {
      name,
      url,
      requestedCaptureResolution: captureResolutionKey,
      viewportMode: viewportModeFinal,
      requestedViewportResolution: viewportResolutionKey,
      viewport: session.viewport,
      captureResolution: session.captureResolution,
      deviceScaleFactor: session.deviceScaleFactor,
    });

    return c.json({
      success: true,
      session: {
        id: session.id,
        name: session.name,
        url: session.url,
        status: session.status,
        screenshotsDir: session.screenshotsDir,
        viewport: session.viewport,
        viewportMode: session.viewportMode,
        captureResolution: session.captureResolution,
        deviceScaleFactor: session.deviceScaleFactor,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop recording
app.post('/api/recorder/stop', async (c) => {
  try {
    const recorder = getRecorder();
    const session = await recorder.stopRecording();

    // Broadcast stop event
    broadcastToClients({
      type: 'stopped',
      data: session,
    });

    // Auto-create project from recording
    let projectId: string | null = null;
    let ocrInProgress = false;

    try {
      const { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } = await import('node:fs');
      const { join } = await import('node:path');
      const { homedir } = await import('node:os');

      const recordingId = session?.id;
      if (recordingId) {
        const recordingDir = join(homedir(), '.discoverylab', 'recordings', recordingId);
        const sessionPath = join(recordingDir, 'session.json');

        if (existsSync(sessionPath)) {
          const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
          const sessionName = sessionData?.name || sessionData?.session?.name || `Recording ${recordingId}`;

          const sqlite = getSqlite();
          projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const now = Date.now();

          sqlite.prepare(`
            INSERT INTO projects (id, name, video_path, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(projectId, sessionName, recordingDir, 'ready', now, now);

          // Copy screenshots to project frames directory
          const framesDir = join(DATA_DIR, 'projects', projectId, 'frames');
          mkdirSync(framesDir, { recursive: true });

          const screenshotsDir = join(recordingDir, 'screenshots');
          let thumbnailPath: string | null = null;
          let frameCount = 0;
          const screenshotFiles: string[] = [];

          if (existsSync(screenshotsDir)) {
            const screenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
            frameCount = screenshots.length;
            screenshotFiles.push(...screenshots);

            screenshots.forEach((file, index) => {
              const src = join(screenshotsDir, file);
              const dest = join(framesDir, `frame_${(index + 1).toString().padStart(4, '0')}.png`);
              copyFileSync(src, dest);

              if (index === 0) {
                thumbnailPath = dest;
              }

              const frameId = `frame_${projectId}_${(index + 1).toString().padStart(4, '0')}`;
              sqlite.prepare(`
                INSERT INTO frames (id, project_id, frame_number, timestamp, image_path, is_key_frame, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
              `).run(frameId, projectId, index + 1, index * 1.0, dest, index === 0 ? 1 : 0, now);
            });

            sqlite.prepare(`
              UPDATE projects SET thumbnail_path = ?, frame_count = ?, updated_at = ? WHERE id = ?
            `).run(thumbnailPath, frameCount, now, projectId);
          }

          // Trigger OCR if we have screenshots
          if (frameCount > 0) {
            sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('analyzing', Date.now(), projectId);
            ocrInProgress = true;
            // Fire-and-forget OCR
            runOCRInBackground(projectId, screenshotsDir, screenshotFiles).catch(err => {
              console.error(`[RecorderStop] OCR failed for project ${projectId}:`, err);
            });
          } else {
            sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('completed', Date.now(), projectId);
          }

          console.log(`[RecorderStop] Auto-created project ${projectId} with ${frameCount} frames`);
        }
      }
    } catch (autoSaveError) {
      console.error('[RecorderStop] Auto-save project failed:', autoSaveError);
      // Non-fatal: recording was still saved, just project creation failed
    }

    return c.json({
      success: true,
      session,
      projectId,
      ocrInProgress,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Pause recording
app.post('/api/recorder/pause', async (c) => {
  try {
    const recorder = getRecorder();
    recorder.pause();
    return c.json({ success: true, status: 'paused' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Resume recording
app.post('/api/recorder/resume', async (c) => {
  try {
    const recorder = getRecorder();
    recorder.resume();
    return c.json({ success: true, status: 'recording' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get current session
app.get('/api/recorder/session', async (c) => {
  try {
    const recorder = getRecorder();
    const session = recorder.getSession();

    if (!session) {
      return c.json({ session: null });
    }

    return c.json({ session });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Take manual screenshot
app.post('/api/recorder/screenshot', async (c) => {
  try {
    const recorder = getRecorder();
    const path = await recorder.captureScreenshot();

    if (!path) {
      return c.json({ error: 'No active recording' }, 400);
    }

    return c.json({ success: true, path });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// List all recordings
app.get('/api/recorder/recordings', async (c) => {
  try {
    const { readdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ recordings: [] });
    }

    const recordings = readdirSync(recordingsDir)
      .filter(dir => dir.startsWith('rec_'))
      .map(dir => {
        const sessionPath = join(recordingsDir, dir, 'session.json');
        if (existsSync(sessionPath)) {
          try {
            const session = JSON.parse(readFileSync(sessionPath, 'utf8'));
            return session;
          } catch {
            return null;
          }
        }
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt);

    return c.json({ recordings });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get recording by ID
app.get('/api/recorder/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    const sessionPath = join(recordingDir, 'session.json');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const session = JSON.parse(readFileSync(sessionPath, 'utf8'));

    // Get list of screenshots
    const screenshotsDir = join(recordingDir, 'screenshots');
    const screenshots = existsSync(screenshotsDir)
      ? readdirSync(screenshotsDir).filter(f => f.endsWith('.png'))
      : [];

    // Get spec file content
    const specPath = join(recordingDir, 'test.spec.ts');
    const specContent = existsSync(specPath)
      ? readFileSync(specPath, 'utf8')
      : null;

    return c.json({
      session,
      screenshots,
      specCode: specContent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete recording by ID
app.delete('/api/recorder/recordings/:id', async (c) => {
  try {
    const { id } = c.req.param();
    const { rmSync, existsSync: fsExistsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);

    if (!fsExistsSync(recordingDir)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    // Delete the recording directory
    rmSync(recordingDir, { recursive: true, force: true });

    // Also delete associated project from database
    const db = getDatabase();
    await db.delete(frames).where(eq(frames.projectId, id));
    await db.delete(projects).where(eq(projects.id, id));

    // Delete project directory if it exists
    const projectDir = join(PROJECTS_DIR, id);
    if (fsExistsSync(projectDir)) {
      rmSync(projectDir, { recursive: true, force: true });
    }

    console.log(`[Delete] Removed web recording and project: ${id}`);

    return c.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Delete all recordings (web and mobile)
app.delete('/api/recorder/recordings', async (c) => {
  try {
    const { rmSync, existsSync: fsExistsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const deletedIds: string[] = [];

    // Delete web recordings
    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');
    if (fsExistsSync(recordingsDir)) {
      const dirs = readdirSync(recordingsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        rmSync(join(recordingsDir, dir), { recursive: true, force: true });
        deletedIds.push(dir);
      }
    }

    // Delete mobile recordings
    const mobileRecordingsDir = join(PROJECTS_DIR, 'maestro-recordings');
    if (fsExistsSync(mobileRecordingsDir)) {
      const dirs = readdirSync(mobileRecordingsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);

      for (const dir of dirs) {
        rmSync(join(mobileRecordingsDir, dir), { recursive: true, force: true });
        deletedIds.push(dir);
      }
    }

    // Delete associated projects from database
    if (deletedIds.length > 0) {
      const db = getDatabase();
      for (const id of deletedIds) {
        await db.delete(frames).where(eq(frames.projectId, id));
        await db.delete(projects).where(eq(projects.id, id));

        // Also delete project directory if it exists
        const projectDir = join(PROJECTS_DIR, id);
        if (fsExistsSync(projectDir)) {
          rmSync(projectDir, { recursive: true, force: true });
        }
      }
    }

    console.log(`[Delete] Removed ${deletedIds.length} recordings and associated projects`);

    return c.json({ success: true, deleted: deletedIds.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Serve recording screenshots by sessionId
app.get('/api/recorder/screenshots/:sessionId/:filename', async (c) => {
  try {
    const { sessionId, filename } = c.req.param();
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const filePath = join(homedir(), '.discoverylab', 'recordings', sessionId, 'screenshots', filename);

    if (!existsSync(filePath)) {
      return c.json({ error: 'Screenshot not found' }, 404);
    }

    const buffer = readFileSync(filePath);
    return new Response(buffer, {
      headers: { 'Content-Type': 'image/png' },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Serve screenshot by filename (searches all recordings)
app.get('/api/recorder/screenshot/:filename', async (c) => {
  try {
    const { filename } = c.req.param();
    const { readFileSync, existsSync, readdirSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingsDir = join(homedir(), '.discoverylab', 'recordings');

    if (!existsSync(recordingsDir)) {
      return c.json({ error: 'No recordings directory' }, 404);
    }

    // Search through all recording directories for the screenshot
    const sessions = readdirSync(recordingsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);

    for (const sessionId of sessions) {
      const filePath = join(recordingsDir, sessionId, 'screenshots', filename);
      if (existsSync(filePath)) {
        const buffer = readFileSync(filePath);
        return new Response(buffer, {
          headers: {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=3600',
          },
        });
      }
    }

    return c.json({ error: 'Screenshot not found' }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Create project from recording
app.post('/api/recorder/recordings/:id/create-project', async (c) => {
  try {
    const { id } = c.req.param();
    const { readFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } = await import('node:fs');
    const { join, basename } = await import('node:path');
    const { homedir } = await import('node:os');

    const recordingDir = join(homedir(), '.discoverylab', 'recordings', id);
    const sessionPath = join(recordingDir, 'session.json');

    if (!existsSync(sessionPath)) {
      return c.json({ error: 'Recording not found' }, 404);
    }

    const sessionData = JSON.parse(readFileSync(sessionPath, 'utf8'));
    const sessionName = sessionData?.name || sessionData?.session?.name || `Recording ${id}`;

    // Create project in database
    const sqlite = getSqlite();
    const projectId = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    sqlite.prepare(`
      INSERT INTO projects (id, name, video_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      projectId,
      sessionName,
      recordingDir,
      'ready',
      now,
      now
    );

    // Copy screenshots to project frames directory
    const framesDir = join(DATA_DIR, 'projects', projectId, 'frames');
    mkdirSync(framesDir, { recursive: true });

    const screenshotsDir = join(recordingDir, 'screenshots');
    let thumbnailPath: string | null = null;
    let frameCount = 0;

    if (existsSync(screenshotsDir)) {
      const screenshots = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
      frameCount = screenshots.length;

      screenshots.forEach((file, index) => {
        const src = join(screenshotsDir, file);
        const dest = join(framesDir, `frame_${(index + 1).toString().padStart(4, '0')}.png`);
        copyFileSync(src, dest);

        // Use first screenshot as thumbnail
        if (index === 0) {
          thumbnailPath = dest;
        }

        // Insert frame record
        const frameId = `frame_${projectId}_${(index + 1).toString().padStart(4, '0')}`;
        sqlite.prepare(`
          INSERT INTO frames (id, project_id, frame_number, timestamp, image_path, is_key_frame, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          frameId,
          projectId,
          index + 1,
          index * 1.0, // timestamp placeholder
          dest,
          index === 0 ? 1 : 0, // first frame is key frame
          now
        );
      });

      // Update project with thumbnail and frame count
      sqlite.prepare(`
        UPDATE projects SET thumbnail_path = ?, frame_count = ?, updated_at = ? WHERE id = ?
      `).run(thumbnailPath, frameCount, now, projectId);
    }

    // Trigger OCR analysis if we have screenshots
    let ocrInProgress = false;
    if (frameCount > 0 && existsSync(screenshotsDir)) {
      const screenshotFiles = readdirSync(screenshotsDir).filter(f => f.endsWith('.png')).sort();
      if (screenshotFiles.length > 0) {
        sqlite.prepare(`UPDATE projects SET status = ?, updated_at = ? WHERE id = ?`).run('analyzing', Date.now(), projectId);
        ocrInProgress = true;
        runOCRInBackground(projectId, screenshotsDir, screenshotFiles).catch(err => {
          console.error(`[CreateProject] OCR failed for project ${projectId}:`, err);
        });
      }
    }

    return c.json({
      success: true,
      projectId,
      frameCount,
      ocrInProgress,
      message: 'Project created from recording',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Broadcast message to all WebSocket clients
function broadcastToClients(message: any): void {
  const data = JSON.stringify(message);
  wsClients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

// ============================================================================
// LIVE SCREEN STREAMING
// ============================================================================

let liveStreamInterval: NodeJS.Timeout | null = null;
let liveStreamPlatform: 'ios' | 'android' | null = null;
let liveStreamDeviceId: string | null = null;
let liveStreamInteractiveMode: boolean = false; // When true, tap events have visual feedback

// Maestro tap mutex - prevents concurrent Maestro executions that cause log file conflicts
let maestroTapLock: Promise<void> = Promise.resolve();
function acquireMaestroTapLock(): { release: () => void; acquired: Promise<void> } {
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve) => {
    maestroTapLock = maestroTapLock.then(() => {
      resolve();
      return new Promise<void>((r) => { release = r; });
    });
  });
  return { release, acquired };
}

async function captureAndBroadcastScreen(): Promise<void> {
  if (!liveStreamPlatform) return;

  try {
    let base64Image: string;

    if (liveStreamPlatform === 'ios') {
      // iOS: capture to stdout as PNG
      const target = liveStreamDeviceId || 'booted';
      const buffer = execSync(`xcrun simctl io "${target}" screenshot --type=png --display=internal -`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000,
      });
      base64Image = buffer.toString('base64');
    } else {
      // Android: capture to stdout
      const deviceArg = liveStreamDeviceId ? `-s ${liveStreamDeviceId}` : '';
      const adbPath = ADB_PATH || 'adb';
      const buffer = execSync(`"${adbPath}" ${deviceArg} exec-out screencap -p`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 3000,
      });
      base64Image = buffer.toString('base64');
    }

    broadcastToClients({
      type: 'liveFrame',
      data: {
        image: base64Image,
        platform: liveStreamPlatform,
        timestamp: Date.now(),
      },
    });
  } catch (error) {
    // Silently ignore capture errors (device might be busy)
  }
}

/**
 * Get the bundle ID of the foreground app on iOS Simulator
 */
function getIOSForegroundAppId(deviceId: string): string | null {
  try {
    // Try to get the foreground app via launchctl list
    const output = execSync(
      `xcrun simctl spawn "${deviceId}" launchctl list 2>/dev/null | grep UIKitApplication | head -1`,
      { encoding: 'utf8', timeout: 3000 }
    );
    // Parse bundle ID from output like: "12345  0  UIKitApplication:com.apple.mobilesafari[0x123]"
    const match = output.match(/UIKitApplication:([^\[\s]+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Get the package name of the foreground app on Android
 */
function getAndroidForegroundAppId(deviceId: string): string | null {
  if (!ADB_PATH) return null;
  try {
    const adbPath = ADB_PATH || 'adb';
    const output = execSync(
      `"${adbPath}" -s "${deviceId}" shell dumpsys window windows 2>/dev/null | grep -E "mCurrentFocus|mFocusedApp" | head -1`,
      { encoding: 'utf8', timeout: 3000 }
    );

    // Example outputs:
    // mCurrentFocus=Window{... u0 com.example/.MainActivity}
    // mFocusedApp=AppWindowToken{... ActivityRecord{... com.example/.MainActivity}}
    const match = output.match(/([a-zA-Z0-9_.]+)\/[a-zA-Z0-9_.]+/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Bring the device emulator/simulator to foreground for faster testing
 */
async function bringDeviceToForeground(platform: 'ios' | 'android'): Promise<void> {
  try {
    const { exec } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execAsync = promisify(exec);

    if (platform === 'ios') {
      // Bring iOS Simulator to front using AppleScript
      await execAsync('osascript -e \'tell application "Simulator" to activate\'');
      console.log('[Focus] iOS Simulator brought to foreground');
    } else if (platform === 'android') {
      // For Android, try to focus the emulator window
      // First try using AppleScript on macOS
      try {
        await execAsync('osascript -e \'tell application "qemu-system-aarch64" to activate\' 2>/dev/null || osascript -e \'tell application "qemu-system-x86_64" to activate\' 2>/dev/null || true');
        console.log('[Focus] Android Emulator brought to foreground');
      } catch {
        // Fallback: try generic "Android Emulator" or "Emulator" app names
        try {
          await execAsync('osascript -e \'tell application "Android Emulator" to activate\' 2>/dev/null || true');
        } catch {
          // Silently ignore if we can't focus Android emulator
        }
      }
    }
  } catch (error) {
    // Silently ignore focus errors - not critical
    console.log(`[Focus] Could not bring ${platform} to foreground:`, error);
  }
}

function startLiveStream(platform: 'ios' | 'android', deviceId?: string): void {
  stopLiveStream(); // Stop any existing stream

  liveStreamPlatform = platform;
  liveStreamDeviceId = deviceId || null;

  // Note: Emulator stays in background during live stream
  // Foreground is only brought during screenshot capture

  // Wake/unlock Android screen to avoid black frames
  if (platform === 'android' && liveStreamDeviceId) {
    try {
      const adbPath = ADB_PATH || 'adb';
      execSync(`"${adbPath}" -s ${liveStreamDeviceId} shell input keyevent 224`, { timeout: 2000 });
      execSync(`"${adbPath}" -s ${liveStreamDeviceId} shell input keyevent 82`, { timeout: 2000 });
    } catch {}
  }

  // Capture at ~2 FPS (every 500ms) - balanced between smoothness and CPU usage
  liveStreamInterval = setInterval(captureAndBroadcastScreen, 500);

  broadcastToClients({
    type: 'liveStreamStarted',
    data: { platform, deviceId },
  });

  console.log(`[LiveStream] Started for ${platform}${deviceId ? ` (${deviceId})` : ''}`);
}

function stopLiveStream(): void {
  if (liveStreamInterval) {
    clearInterval(liveStreamInterval);
    liveStreamInterval = null;
  }
  liveStreamPlatform = null;
  liveStreamDeviceId = null;

  broadcastToClients({
    type: 'liveStreamStopped',
    data: {},
  });
}

// Start live stream endpoint
app.post('/api/live-stream/start', async (c) => {
  try {
    const body = await c.req.json();
    let { platform, deviceId } = body;

    if (!platform || !['ios', 'android'].includes(platform)) {
      return c.json({ error: 'Invalid platform. Must be "ios" or "android"' }, 400);
    }

    if (platform === 'android' && !deviceId) {
      try {
        const adbPath = ADB_PATH || 'adb';
        const adbOutput = execSync(`"${adbPath}" devices -l`, { encoding: 'utf8' });
        const lines = adbOutput.split('\n').slice(1);
        for (const line of lines) {
          if (line.includes('device') && !line.includes('offline')) {
            const parts = line.split(/\s+/);
            deviceId = parts[0];
            break;
          }
        }
      } catch {}
    }

    if (platform === 'ios' && !deviceId) {
      try {
        const simOutput = execSync('xcrun simctl list devices booted -j', { encoding: 'utf8' });
        const simData = JSON.parse(simOutput);
        for (const [, devices] of Object.entries(simData.devices) as any) {
          for (const device of devices) {
            if (device.state === 'Booted') {
              deviceId = device.udid;
              break;
            }
          }
          if (deviceId) break;
        }
      } catch {}
    }

    if (platform === 'android' && !deviceId) {
      return c.json({ error: 'No Android device connected' }, 400);
    }

    if (platform === 'ios' && !deviceId) {
      return c.json({ error: 'No iOS simulator booted' }, 400);
    }

    startLiveStream(platform, deviceId);

    return c.json({ success: true, message: 'Live stream started' });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Stop live stream endpoint
app.post('/api/live-stream/stop', async (c) => {
  stopLiveStream();
  liveStreamInteractiveMode = false;
  return c.json({ success: true, message: 'Live stream stopped' });
});

// Toggle interactive mode for live stream (enables tap feedback)
app.post('/api/live-stream/interactive', async (c) => {
  try {
    const body = await c.req.json();
    const { enable } = body;

    liveStreamInteractiveMode = Boolean(enable);

    // Broadcast mode change to clients
    broadcastToClients({
      type: 'interactiveModeChanged',
      data: {
        enabled: liveStreamInteractiveMode,
        platform: liveStreamPlatform,
        deviceId: liveStreamDeviceId
      }
    });

    return c.json({
      success: true,
      interactiveMode: liveStreamInteractiveMode,
      message: liveStreamInteractiveMode ? 'Interactive mode enabled - taps will have visual feedback' : 'Interactive mode disabled'
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return c.json({ error: message }, 500);
  }
});

// Get live stream status
app.get('/api/live-stream/status', async (c) => {
  const recorder = getMaestroRecorder();
  const isRecording = recorder.isRecording();

  return c.json({
    active: liveStreamPlatform !== null,
    platform: liveStreamPlatform,
    deviceId: liveStreamDeviceId,
    interactiveMode: liveStreamInteractiveMode,
    recording: isRecording,
    mode: isRecording ? 'recording' : (liveStreamInteractiveMode ? 'interactive' : 'view')
  });
});

// ============================================================================
// SERVER START
// ============================================================================
let serverInstance: any = null;
let wss: WebSocketServer | null = null;

export async function startServer(port: number = 3847): Promise<void> {
  // Initialize database
  getDatabase();

  return new Promise((resolve) => {
    serverInstance = serve({
      fetch: app.fetch,
      port,
    }, () => {
      // Setup WebSocket server on a different port
      wss = new WebSocketServer({ port: port + 1 });

      wss.on('connection', (ws) => {
        wsClients.add(ws);
        console.log('WebSocket client connected');

        ws.on('close', () => {
          wsClients.delete(ws);
          console.log('WebSocket client disconnected');

          // Auto-stop live stream when all clients disconnect
          if (wsClients.size === 0 && liveStreamInterval) {
            console.log('[LiveStream] All clients disconnected, auto-stopping live stream');
            stopLiveStream();
          }
        });

        // Send current recorder status on connect
        const recorder = getRecorder();
        const session = recorder.getSession();
        if (session) {
          ws.send(JSON.stringify({
            type: 'session',
            data: session,
          }));
        }
      });

      resolve();
    });
  });
}

export function stopServer(): void {
  // Stop live stream and auto-capture intervals before closing
  stopLiveStream();
  if (autoCaptureInterval) {
    clearInterval(autoCaptureInterval);
    autoCaptureInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }
  if (serverInstance) {
    serverInstance.close();
    serverInstance = null;
  }
}

export { app };
