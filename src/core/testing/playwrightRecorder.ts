/**
 * DiscoveryLab Playwright Recorder
 * Records browser sessions with automatic screenshot capture
 * Generates test code and integrates with project system
 */

import { chromium, Browser, Page, BrowserContext, type BrowserContextOptions } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { EventEmitter } from 'node:events';

// ============================================================================
// TYPES
// ============================================================================

export interface RecordingAction {
  id: string;
  type: 'navigate' | 'click' | 'fill' | 'select' | 'check' | 'press' | 'scroll' | 'wait';
  timestamp: number;
  selector?: string;
  value?: string;
  url?: string;
  description: string;
  screenshotPath?: string;
  x?: number;
  y?: number;
}

export interface RecordingSession {
  id: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  url: string;
  actions: RecordingAction[];
  screenshotsDir: string;
  specPath?: string;
  status: 'recording' | 'paused' | 'stopped' | 'error';
  viewport?: { width: number; height: number };
  viewportMode?: 'auto' | 'fixed';
  captureResolution?: { width: number; height: number };
  deviceScaleFactor?: number;
}

export interface RecorderEvents {
  'action': (action: RecordingAction) => void;
  'screenshot': (path: string, actionId: string) => void;
  'status': (status: RecordingSession['status']) => void;
  'error': (error: Error) => void;
  'stopped': (session: RecordingSession) => void;
}

// ============================================================================
// PLAYWRIGHT RECORDER
// ============================================================================

export class PlaywrightRecorder extends EventEmitter {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private session: RecordingSession | null = null;
  private actionCounter = 0;
  private nameHelperInjected = false;

  /**
   * TSX/esbuild injects `__name(...)` calls into nested functions. When we pass
   * functions to Playwright's addInitScript/evaluate, those calls run in the
   * browser context where `__name` is not defined, causing a ReferenceError.
   * This helper ensures a compatible global `__name` exists in the page.
   */
  private static readonly NAME_HELPER_SCRIPT = `
    var __name = globalThis.__name || function(fn, name) {
      try {
        Object.defineProperty(fn, 'name', { value: name, configurable: true });
      } catch {}
      return fn;
    };
    globalThis.__name = __name;
  `;

  constructor() {
    super();
  }

  private static readonly RESOLUTIONS: Record<string, { width: number; height: number }> = {
    '720': { width: 1280, height: 720 },
    '1080': { width: 1920, height: 1080 },
    '1440': { width: 2560, height: 1440 },
    '2160': { width: 3840, height: 2160 },
  };

  /**
   * Start a new recording session
   */
  async startRecording(
    name: string,
    startUrl: string,
    options?: {
      // Legacy option: treated as capture resolution
      resolution?: string;
      // Resolution used for screenshots/video output
      captureResolution?: string;
      // How to size the browser viewport
      viewportMode?: 'auto' | 'fixed';
      // Resolution used when viewportMode === 'fixed'
      viewportResolution?: string;
    }
  ): Promise<RecordingSession> {
    if (this.session?.status === 'recording') {
      throw new Error('Recording already in progress');
    }

    // Generate session ID and paths
    const sessionId = `rec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const baseDir = join(homedir(), '.discoverylab', 'recordings', sessionId);
    const screenshotsDir = join(baseDir, 'screenshots');

    // Create directories
    mkdirSync(screenshotsDir, { recursive: true });

    // Initialize session
    this.session = {
      id: sessionId,
      name,
      startedAt: Date.now(),
      url: startUrl,
      actions: [],
      screenshotsDir,
      status: 'recording',
    };

    this.actionCounter = 0;

    try {
      // Launch browser
      this.browser = await chromium.launch({
        headless: false,
        args: ['--start-maximized'],
      });

      // Capture resolution controls output quality and is independent from viewport mode.
      const captureResolutionKey = options?.captureResolution || options?.resolution || '1080';
      const captureResolution =
        PlaywrightRecorder.RESOLUTIONS[captureResolutionKey] || PlaywrightRecorder.RESOLUTIONS['1080'];

      const viewportMode: 'auto' | 'fixed' = options?.viewportMode === 'fixed' ? 'fixed' : 'auto';
      const viewportResolutionKey = options?.viewportResolution || captureResolutionKey;
      const viewportResolution =
        PlaywrightRecorder.RESOLUTIONS[viewportResolutionKey] || captureResolution;

      // Store capture info for downstream consumers (grid/canvas, replay, etc).
      this.session.captureResolution = captureResolution;
      this.session.viewportMode = viewportMode;

      const contextOptions: BrowserContextOptions = {
        recordVideo: {
          dir: join(baseDir, 'video'),
          size: captureResolution,
        },
      };

      if (viewportMode === 'fixed') {
        const deviceScaleFactor = this.computeDeviceScaleFactor(captureResolution, viewportResolution);
        contextOptions.viewport = viewportResolution;
        contextOptions.deviceScaleFactor = deviceScaleFactor;

        // Store viewport info early for replay scaling.
        this.session.viewport = viewportResolution;
        this.session.deviceScaleFactor = deviceScaleFactor;
      } else {
        // Auto viewport uses the native window size and system DPR.
        contextOptions.viewport = null;
      }

      this.context = await this.browser.newContext(contextOptions);

      this.page = await this.context.newPage();
      this.nameHelperInjected = false;

      // Setup action listeners - MUST be awaited before navigation
      await this.setupPageListeners();

      // Navigate to start URL
      await this.navigateTo(startUrl);

      this.emit('status', 'recording');
      return this.session;

    } catch (error) {
      this.session.status = 'error';
      this.emit('error', error as Error);
      throw error;
    }
  }

  /**
   * Setup page event listeners to capture actions
   */
  private async setupPageListeners(): Promise<void> {
    if (!this.page) return;

    // Track navigation
    this.page.on('framenavigated', async (frame) => {
      if (frame === this.page?.mainFrame()) {
        const url = frame.url();
        if (url && url !== 'about:blank') {
          await this.recordAction({
            type: 'navigate',
            url,
            description: `Navigate to ${new URL(url).hostname}${new URL(url).pathname}`,
          });
        }
      }
    });

    // Track console for debugging
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.log('[Page Error]', msg.text());
      }
    });

    // Expose function for UI to call actions - MUST be awaited before addInitScript
    try {
      await this.page.exposeFunction('__discoverylab_action', async (actionData: any) => {
        console.log('[Recorder] Action captured:', actionData.type, actionData.description);
        await this.recordAction(actionData);
      });
    } catch (err) {
      // Function might already be exposed
      console.log('[Recorder] exposeFunction error (may be ok if already exposed):', err);
    }

    // Inject action tracking script
    await this.injectTrackingScript();
  }

  /**
   * Inject JavaScript to track user interactions
   */
  private async injectTrackingScript(): Promise<void> {
    if (!this.page) return;

    await this.ensureNameHelperInjected();

    await this.page.addInitScript(() => {
      // Track clicks with coordinates
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const selector = getSelector(target);
        const text = target.textContent?.trim().slice(0, 50) || '';

        (window as any).__discoverylab_action?.({
          type: 'click',
          selector,
          description: `Click on ${target.tagName.toLowerCase()}${text ? `: "${text}"` : ''}`,
          x: e.clientX,
          y: e.clientY,
        });
      }, true);

      // Track input changes
      document.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          const selector = getSelector(target);
          const value = target.type === 'password' ? '***' : target.value;

          (window as any).__discoverylab_action?.({
            type: target.tagName === 'SELECT' ? 'select' : 'fill',
            selector,
            value,
            description: `${target.tagName === 'SELECT' ? 'Select' : 'Fill'} ${target.name || target.id || 'input'}: "${value.slice(0, 30)}"`,
          });
        }
      }, true);

      // Track checkbox/radio
      document.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.type === 'checkbox' || target.type === 'radio') {
          const selector = getSelector(target);
          (window as any).__discoverylab_action?.({
            type: 'check',
            selector,
            value: target.checked.toString(),
            description: `${target.checked ? 'Check' : 'Uncheck'} ${target.name || target.id || 'checkbox'}`,
          });
        }
      }, true);

      // Track key presses (Enter, Escape, etc)
      document.addEventListener('keydown', (e) => {
        if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
          const target = e.target as HTMLElement;
          const selector = getSelector(target);
          (window as any).__discoverylab_action?.({
            type: 'press',
            selector,
            value: e.key,
            description: `Press ${e.key}`,
          });
        }
      }, true);

      // Helper to generate selector
      function getSelector(el: HTMLElement): string {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
        if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;

        // Try to find unique text content for buttons/links
        if ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.textContent?.trim()) {
          const text = el.textContent.trim();
          if (text.length < 50) {
            return `text="${text}"`;
          }
        }

        // Fallback to tag + classes
        let selector = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ').filter(c => c && !c.includes(':'));
          if (classes.length > 0) {
            selector += '.' + classes.slice(0, 2).join('.');
          }
        }
        return selector;
      }
    });
  }

  /**
   * Inject tracking script immediately into the current page.
   * Uses page.evaluate() instead of addInitScript() to execute in current context.
   */
  private async injectTrackingScriptNow(): Promise<void> {
    if (!this.page) return;

    await this.ensureNameHelperInjected();

    await this.page.evaluate(() => {
      // Prevent double injection
      if ((window as any).__discoverylab_tracking_injected) return;
      (window as any).__discoverylab_tracking_injected = true;

      // Track clicks with coordinates
      document.addEventListener('click', (e) => {
        const target = e.target as HTMLElement;
        const selector = getSelector(target);
        const text = target.textContent?.trim().slice(0, 50) || '';

        (window as any).__discoverylab_action?.({
          type: 'click',
          selector,
          description: `Click on ${target.tagName.toLowerCase()}${text ? `: "${text}"` : ''}`,
          x: e.clientX,
          y: e.clientY,
        });
      }, true);

      // Track input changes
      document.addEventListener('change', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
          const selector = getSelector(target);
          const value = target.type === 'password' ? '***' : target.value;

          (window as any).__discoverylab_action?.({
            type: target.tagName === 'SELECT' ? 'select' : 'fill',
            selector,
            value,
            description: `${target.tagName === 'SELECT' ? 'Select' : 'Fill'} ${target.name || target.id || 'input'}: "${value.slice(0, 30)}"`,
          });
        }
      }, true);

      // Track checkbox/radio
      document.addEventListener('input', (e) => {
        const target = e.target as HTMLInputElement;
        if (target.type === 'checkbox' || target.type === 'radio') {
          const selector = getSelector(target);
          (window as any).__discoverylab_action?.({
            type: 'check',
            selector,
            value: target.checked.toString(),
            description: `${target.checked ? 'Check' : 'Uncheck'} ${target.name || target.id || 'checkbox'}`,
          });
        }
      }, true);

      // Track key presses (Enter, Escape, etc)
      document.addEventListener('keydown', (e) => {
        if (['Enter', 'Escape', 'Tab'].includes(e.key)) {
          const target = e.target as HTMLElement;
          const selector = getSelector(target);
          (window as any).__discoverylab_action?.({
            type: 'press',
            selector,
            value: e.key,
            description: `Press ${e.key}`,
          });
        }
      }, true);

      // Helper to generate selector
      function getSelector(el: HTMLElement): string {
        if (el.id) return `#${el.id}`;
        if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
        if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;

        // Try to find unique text content for buttons/links
        if ((el.tagName === 'BUTTON' || el.tagName === 'A') && el.textContent?.trim()) {
          const text = el.textContent.trim();
          if (text.length < 50) {
            return `text="${text}"`;
          }
        }

        // Fallback to tag + classes
        let selector = el.tagName.toLowerCase();
        if (el.className && typeof el.className === 'string') {
          const classes = el.className.split(' ').filter(c => c && !c.includes(':'));
          if (classes.length > 0) {
            selector += '.' + classes.slice(0, 2).join('.');
          }
        }
        return selector;
      }
    });
  }

  /**
   * Compute a deviceScaleFactor that increases capture resolution without
   * changing the CSS layout size of the page.
   */
  private computeDeviceScaleFactor(
    capture: { width: number; height: number },
    viewport: { width: number; height: number }
  ): number {
    const widthScale = capture.width / viewport.width;
    const heightScale = capture.height / viewport.height;
    const desiredScale = Math.max(widthScale, heightScale);

    // Clamp to a reasonable range to avoid extreme memory usage.
    return Math.min(Math.max(desiredScale, 1), 3);
  }

  /**
   * Ensure a global `__name` helper exists in the browser context.
   */
  private async ensureNameHelperInjected(): Promise<void> {
    if (!this.page || this.nameHelperInjected) return;

    const helperScript = PlaywrightRecorder.NAME_HELPER_SCRIPT;

    // Ensure the helper exists for future navigations.
    await this.page.addInitScript({ content: helperScript });

    // Also inject it into the current page context (best effort).
    try {
      await this.page.evaluate(helperScript);
    } catch {
      // Page might not be ready yet; the init script will still run on navigation.
    }

    this.nameHelperInjected = true;
  }

  /**
   * Update the session viewport to match the current page's actual size.
   * This is particularly important when viewportMode === 'auto'.
   */
  private async updateSessionViewportFromPage(): Promise<void> {
    if (!this.page || !this.session) return;

    const viewportSize = this.page.viewportSize();
    if (viewportSize) {
      this.session.viewport = viewportSize;
      if (!this.session.deviceScaleFactor) {
        this.session.deviceScaleFactor = 1;
      }
      return;
    }

    try {
      const metrics = await this.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
      }));

      if (metrics.width > 0 && metrics.height > 0) {
        this.session.viewport = { width: metrics.width, height: metrics.height };
      }
      if (!this.session.deviceScaleFactor) {
        this.session.deviceScaleFactor = metrics.dpr;
      }
    } catch {
      // Best effort only; avoid breaking recording if metrics cannot be read.
    }
  }

  /**
   * Record an action and capture screenshot
   */
  private async recordAction(actionData: Partial<RecordingAction>): Promise<void> {
    if (!this.session || this.session.status !== 'recording' || !this.page) return;

    this.actionCounter++;
    const actionId = `action_${this.actionCounter.toString().padStart(3, '0')}`;

    // Capture screenshot
    const screenshotName = `${actionId}_${actionData.type}.png`;
    const screenshotPath = join(this.session.screenshotsDir, screenshotName);

    try {
      await this.page.screenshot({
        path: screenshotPath,
        fullPage: false,
        // Capture device pixels for maximum fidelity.
        scale: 'device',
      });
    } catch (error) {
      console.error('Screenshot failed:', error);
    }

    const action: RecordingAction = {
      id: actionId,
      type: actionData.type || 'click',
      timestamp: Date.now(),
      selector: actionData.selector,
      value: actionData.value,
      url: actionData.url,
      description: actionData.description || actionData.type || 'Action',
      screenshotPath,
    };

    this.session.actions.push(action);

    this.emit('action', action);
    this.emit('screenshot', screenshotPath, actionId);
  }

  /**
   * Navigate to a URL
   */
  async navigateTo(url: string): Promise<void> {
    if (!this.page) throw new Error('No page available');

    await this.page.goto(url, { waitUntil: 'domcontentloaded' });

    // Inject tracking script immediately into current page
    // Uses page.evaluate() to run in current context (addInitScript only works for future pages)
    await this.injectTrackingScriptNow();

    // Refresh the viewport metrics after navigation.
    await this.updateSessionViewportFromPage();
  }

  /**
   * Pause recording
   */
  pause(): void {
    if (this.session) {
      this.session.status = 'paused';
      this.emit('status', 'paused');
    }
  }

  /**
   * Resume recording
   */
  resume(): void {
    if (this.session && this.session.status === 'paused') {
      this.session.status = 'recording';
      this.emit('status', 'recording');
    }
  }

  /**
   * Stop recording and generate outputs
   */
  async stopRecording(): Promise<RecordingSession> {
    if (!this.session) throw new Error('No recording session');

    this.session.status = 'stopped';
    this.session.endedAt = Date.now();

    // Generate spec file
    const specCode = this.generateSpecCode();
    const specPath = join(this.session.screenshotsDir, '..', 'test.spec.ts');
    writeFileSync(specPath, specCode);
    this.session.specPath = specPath;

    // Save session metadata
    const metadataPath = join(this.session.screenshotsDir, '..', 'session.json');
    writeFileSync(metadataPath, JSON.stringify(this.session, null, 2));

    // Close browser
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch {}

    this.browser = null;
    this.context = null;
    this.page = null;

    this.emit('status', 'stopped');
    this.emit('stopped', this.session);

    const result = this.session;
    this.session = null;

    return result;
  }

  /**
   * Generate Playwright test code from recorded actions
   */
  private generateSpecCode(): string {
    if (!this.session) return '';

    const lines: string[] = [
      `import { test, expect } from '@playwright/test';`,
      ``,
      `/**`,
      ` * Test: ${this.session.name}`,
      ` * Recorded: ${new Date(this.session.startedAt).toISOString()}`,
      ` * Generated by DiscoveryLab`,
      ` */`,
      ``,
      `test('${this.session.name}', async ({ page }) => {`,
    ];

    for (const action of this.session.actions) {
      const indent = '  ';
      let code = '';

      switch (action.type) {
        case 'navigate':
          code = `await page.goto('${action.url}');`;
          break;
        case 'click':
          code = `await page.locator('${action.selector}').click();`;
          break;
        case 'fill':
          code = `await page.locator('${action.selector}').fill('${action.value}');`;
          break;
        case 'select':
          code = `await page.locator('${action.selector}').selectOption('${action.value}');`;
          break;
        case 'check':
          code = action.value === 'true'
            ? `await page.locator('${action.selector}').check();`
            : `await page.locator('${action.selector}').uncheck();`;
          break;
        case 'press':
          code = `await page.locator('${action.selector}').press('${action.value}');`;
          break;
        default:
          code = `// ${action.description}`;
      }

      lines.push(`${indent}// ${action.description}`);
      lines.push(`${indent}${code}`);
      lines.push(``);
    }

    lines.push(`});`);
    lines.push(``);

    return lines.join('\n');
  }

  /**
   * Get current session
   */
  getSession(): RecordingSession | null {
    return this.session;
  }

  /**
   * Check if recording is active
   */
  isRecording(): boolean {
    return this.session?.status === 'recording';
  }

  /**
   * Take manual screenshot
   */
  async captureScreenshot(name?: string): Promise<string | null> {
    if (!this.page || !this.session) return null;

    this.actionCounter++;
    const screenshotName = name || `manual_${this.actionCounter.toString().padStart(3, '0')}.png`;
    const screenshotPath = join(this.session.screenshotsDir, screenshotName);

    await this.page.screenshot({ path: screenshotPath });
    this.emit('screenshot', screenshotPath, `manual_${this.actionCounter}`);

    return screenshotPath;
  }
}

// Singleton instance
let recorderInstance: PlaywrightRecorder | null = null;

export function getRecorder(): PlaywrightRecorder {
  if (!recorderInstance) {
    recorderInstance = new PlaywrightRecorder();
  }
  return recorderInstance;
}

export default PlaywrightRecorder;
