/**
 * DiscoveryLab Playwright Integration Module
 * Web application testing and browser automation
 */

import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR } from '../../db/index.js';

const execAsync = promisify(exec);

// ============================================================================
// TYPES
// ============================================================================
export interface PlaywrightConfig {
  browser?: 'chromium' | 'firefox' | 'webkit';
  headless?: boolean;
  viewport?: { width: number; height: number };
  deviceName?: string; // e.g., 'iPhone 12', 'Pixel 5'
  baseURL?: string;
  timeout?: number;
  video?: 'on' | 'off' | 'retain-on-failure';
  screenshot?: 'on' | 'off' | 'only-on-failure';
  trace?: 'on' | 'off' | 'retain-on-failure';
}

export interface PlaywrightRunOptions {
  testPath?: string; // Path to test file or directory
  testPattern?: string; // Test name pattern to run
  config?: PlaywrightConfig;
  outputDir?: string;
  project?: string; // Playwright project name
  workers?: number;
  retries?: number;
  reporter?: 'list' | 'html' | 'json' | 'line';
}

export interface PlaywrightTestResult {
  success: boolean;
  error?: string;
  duration?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  output?: string;
  reportPath?: string;
  videos?: string[];
  screenshots?: string[];
  traces?: string[];
}

export interface PlaywrightAction {
  type: string;
  selector?: string;
  value?: string;
  url?: string;
  key?: string;
  options?: Record<string, any>;
}

export interface PlaywrightScript {
  name?: string;
  baseURL?: string;
  viewport?: { width: number; height: number };
  actions: PlaywrightAction[];
}

export interface BrowserDevice {
  name: string;
  viewport: { width: number; height: number };
  userAgent: string;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
}

// ============================================================================
// PLAYWRIGHT CLI HELPERS
// ============================================================================
export async function isPlaywrightInstalled(): Promise<boolean> {
  try {
    await execAsync('npx playwright --version');
    return true;
  } catch {
    return false;
  }
}

export async function getPlaywrightVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync('npx playwright --version');
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function installPlaywrightBrowsers(): Promise<{ success: boolean; error?: string }> {
  try {
    await execAsync('npx playwright install');
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// COMMON BROWSER DEVICES
// ============================================================================
export const BrowserDevices: Record<string, BrowserDevice> = {
  'Desktop Chrome': {
    name: 'Desktop Chrome',
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'Desktop Safari': {
    name: 'Desktop Safari',
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'iPhone 15 Pro': {
    name: 'iPhone 15 Pro',
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iPhone 14': {
    name: 'iPhone 14',
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'Pixel 8': {
    name: 'Pixel 8',
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
  'iPad Pro 12.9': {
    name: 'iPad Pro 12.9',
    viewport: { width: 1024, height: 1366 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
};

export function listBrowserDevices(): BrowserDevice[] {
  return Object.values(BrowserDevices);
}

export function getBrowserDevice(name: string): BrowserDevice | null {
  return BrowserDevices[name] || null;
}

// ============================================================================
// SCRIPT GENERATION
// ============================================================================
export function generatePlaywrightScript(script: PlaywrightScript): string {
  const { name, baseURL, viewport, actions } = script;

  const lines: string[] = [
    "import { test, expect } from '@playwright/test';",
    '',
  ];

  // Test block
  lines.push(`test('${name || 'Generated Test'}', async ({ page }) => {`);

  // Set viewport if specified
  if (viewport) {
    lines.push(`  await page.setViewportSize({ width: ${viewport.width}, height: ${viewport.height} });`);
  }

  // Navigate to base URL if specified
  if (baseURL) {
    lines.push(`  await page.goto('${baseURL}');`);
  }

  // Generate actions
  for (const action of actions) {
    const code = generateActionCode(action);
    if (code) {
      lines.push(`  ${code}`);
    }
  }

  lines.push('});');
  lines.push('');

  return lines.join('\n');
}

function generateActionCode(action: PlaywrightAction): string | null {
  const { type, selector, value, url, key, options } = action;

  switch (type) {
    case 'goto':
      return `await page.goto('${url || ''}');`;

    case 'click':
      if (!selector) return null;
      return `await page.click('${selector}');`;

    case 'fill':
      if (!selector) return null;
      return `await page.fill('${selector}', '${value || ''}');`;

    case 'type':
      if (!selector) return null;
      return `await page.type('${selector}', '${value || ''}');`;

    case 'press':
      if (!selector) return null;
      return `await page.press('${selector}', '${key || 'Enter'}');`;

    case 'check':
      if (!selector) return null;
      return `await page.check('${selector}');`;

    case 'uncheck':
      if (!selector) return null;
      return `await page.uncheck('${selector}');`;

    case 'selectOption':
      if (!selector) return null;
      return `await page.selectOption('${selector}', '${value || ''}');`;

    case 'hover':
      if (!selector) return null;
      return `await page.hover('${selector}');`;

    case 'focus':
      if (!selector) return null;
      return `await page.focus('${selector}');`;

    case 'screenshot':
      return `await page.screenshot({ path: '${value || 'screenshot.png'}' });`;

    case 'wait':
      return `await page.waitForTimeout(${value || 1000});`;

    case 'waitForSelector':
      if (!selector) return null;
      return `await page.waitForSelector('${selector}');`;

    case 'waitForURL':
      return `await page.waitForURL('${url || ''}');`;

    case 'expectVisible':
      if (!selector) return null;
      return `await expect(page.locator('${selector}')).toBeVisible();`;

    case 'expectHidden':
      if (!selector) return null;
      return `await expect(page.locator('${selector}')).toBeHidden();`;

    case 'expectText':
      if (!selector) return null;
      return `await expect(page.locator('${selector}')).toHaveText('${value || ''}');`;

    case 'expectURL':
      return `await expect(page).toHaveURL('${url || ''}');`;

    case 'expectTitle':
      return `await expect(page).toHaveTitle('${value || ''}');`;

    case 'scroll':
      if (selector) {
        return `await page.locator('${selector}').scrollIntoViewIfNeeded();`;
      }
      return `await page.evaluate(() => window.scrollBy(0, ${value || 500}));`;

    case 'evaluate':
      return `await page.evaluate(() => { ${value || ''} });`;

    default:
      return null;
  }
}

// ============================================================================
// PLAYWRIGHT ACTIONS HELPER
// ============================================================================
export const PlaywrightActions = {
  // Navigation
  goto: (url: string): PlaywrightAction => ({ type: 'goto', url }),
  goBack: (): PlaywrightAction => ({ type: 'evaluate', value: 'history.back()' }),
  goForward: (): PlaywrightAction => ({ type: 'evaluate', value: 'history.forward()' }),
  reload: (): PlaywrightAction => ({ type: 'evaluate', value: 'location.reload()' }),

  // Interactions
  click: (selector: string): PlaywrightAction => ({ type: 'click', selector }),
  fill: (selector: string, value: string): PlaywrightAction => ({ type: 'fill', selector, value }),
  type: (selector: string, value: string): PlaywrightAction => ({ type: 'type', selector, value }),
  press: (selector: string, key: string): PlaywrightAction => ({ type: 'press', selector, key }),
  check: (selector: string): PlaywrightAction => ({ type: 'check', selector }),
  uncheck: (selector: string): PlaywrightAction => ({ type: 'uncheck', selector }),
  selectOption: (selector: string, value: string): PlaywrightAction => ({ type: 'selectOption', selector, value }),
  hover: (selector: string): PlaywrightAction => ({ type: 'hover', selector }),
  focus: (selector: string): PlaywrightAction => ({ type: 'focus', selector }),

  // Waiting
  wait: (ms: number): PlaywrightAction => ({ type: 'wait', value: String(ms) }),
  waitForSelector: (selector: string): PlaywrightAction => ({ type: 'waitForSelector', selector }),
  waitForURL: (url: string): PlaywrightAction => ({ type: 'waitForURL', url }),

  // Screenshots
  screenshot: (path: string): PlaywrightAction => ({ type: 'screenshot', value: path }),

  // Scrolling
  scroll: (pixels?: number): PlaywrightAction => ({ type: 'scroll', value: String(pixels || 500) }),
  scrollToElement: (selector: string): PlaywrightAction => ({ type: 'scroll', selector }),

  // Assertions
  expectVisible: (selector: string): PlaywrightAction => ({ type: 'expectVisible', selector }),
  expectHidden: (selector: string): PlaywrightAction => ({ type: 'expectHidden', selector }),
  expectText: (selector: string, text: string): PlaywrightAction => ({ type: 'expectText', selector, value: text }),
  expectURL: (url: string): PlaywrightAction => ({ type: 'expectURL', url }),
  expectTitle: (title: string): PlaywrightAction => ({ type: 'expectTitle', value: title }),

  // Custom
  evaluate: (code: string): PlaywrightAction => ({ type: 'evaluate', value: code }),
};

// ============================================================================
// RUN PLAYWRIGHT TEST
// ============================================================================
export async function runPlaywrightTest(options: PlaywrightRunOptions): Promise<PlaywrightTestResult> {
  const installed = await isPlaywrightInstalled();
  if (!installed) {
    return {
      success: false,
      error: 'Playwright is not installed. Install with: npm install -D @playwright/test && npx playwright install',
    };
  }

  const {
    testPath,
    testPattern,
    config = {},
    outputDir = path.join(PROJECTS_DIR, 'playwright-output', Date.now().toString()),
    project,
    workers = 1,
    retries = 0,
    reporter = 'json',
  } = options;

  // Create output directory
  await fs.promises.mkdir(outputDir, { recursive: true });

  const startTime = Date.now();
  const args: string[] = ['playwright', 'test'];

  // Test file or directory
  if (testPath) {
    args.push(testPath);
  }

  // Test pattern
  if (testPattern) {
    args.push('-g', testPattern);
  }

  // Project
  if (project) {
    args.push('--project', project);
  }

  // Workers
  args.push('--workers', workers.toString());

  // Retries
  if (retries > 0) {
    args.push('--retries', retries.toString());
  }

  // Reporter
  args.push('--reporter', reporter);

  // Output
  args.push('--output', outputDir);

  // Browser options
  if (config.browser) {
    args.push('--browser', config.browser);
  }

  if (config.headless === false) {
    args.push('--headed');
  }

  try {
    const { stdout, stderr } = await execAsync(`npx ${args.join(' ')}`, {
      timeout: config.timeout || 300000,
      cwd: process.cwd(),
    });

    const duration = Date.now() - startTime;

    // Parse results
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const passedMatch = stdout.match(/(\d+) passed/);
    const failedMatch = stdout.match(/(\d+) failed/);
    const skippedMatch = stdout.match(/(\d+) skipped/);

    if (passedMatch) passed = parseInt(passedMatch[1], 10);
    if (failedMatch) failed = parseInt(failedMatch[1], 10);
    if (skippedMatch) skipped = parseInt(skippedMatch[1], 10);

    // Collect artifacts
    const videos: string[] = [];
    const screenshots: string[] = [];
    const traces: string[] = [];

    if (fs.existsSync(outputDir)) {
      const collectArtifacts = async (dir: string) => {
        const files = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const file of files) {
          const filePath = path.join(dir, file.name);
          if (file.isDirectory()) {
            await collectArtifacts(filePath);
          } else if (file.name.endsWith('.webm') || file.name.endsWith('.mp4')) {
            videos.push(filePath);
          } else if (file.name.endsWith('.png')) {
            screenshots.push(filePath);
          } else if (file.name.endsWith('.zip') && file.name.includes('trace')) {
            traces.push(filePath);
          }
        }
      };
      await collectArtifacts(outputDir);
    }

    return {
      success: failed === 0,
      duration,
      passed,
      failed,
      skipped,
      output: stdout + stderr,
      reportPath: path.join(outputDir, 'report.json'),
      videos,
      screenshots,
      traces,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const message = error instanceof Error ? error.message : String(error);

    // Even on failure, try to parse results
    let passed = 0;
    let failed = 0;
    let skipped = 0;

    const passedMatch = message.match(/(\d+) passed/);
    const failedMatch = message.match(/(\d+) failed/);
    const skippedMatch = message.match(/(\d+) skipped/);

    if (passedMatch) passed = parseInt(passedMatch[1], 10);
    if (failedMatch) failed = parseInt(failedMatch[1], 10);
    if (skippedMatch) skipped = parseInt(skippedMatch[1], 10);

    return {
      success: false,
      error: message,
      duration,
      passed,
      failed,
      skipped,
      output: message,
    };
  }
}

// ============================================================================
// RUN SCRIPT DIRECTLY
// ============================================================================
export async function runPlaywrightScript(
  script: PlaywrightScript,
  options: Omit<PlaywrightRunOptions, 'testPath'> = {}
): Promise<PlaywrightTestResult> {
  const outputDir = options.outputDir || path.join(PROJECTS_DIR, 'playwright-output', Date.now().toString());
  await fs.promises.mkdir(outputDir, { recursive: true });

  // Generate and save script
  const scriptContent = generatePlaywrightScript(script);
  const scriptPath = path.join(outputDir, 'test.spec.ts');
  await fs.promises.writeFile(scriptPath, scriptContent);

  // Create minimal playwright config
  const configContent = `
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: ${options.config?.timeout || 30000},
  use: {
    headless: ${options.config?.headless !== false},
    video: '${options.config?.video || 'off'}',
    screenshot: '${options.config?.screenshot || 'off'}',
    trace: '${options.config?.trace || 'off'}',
    ${script.baseURL ? `baseURL: '${script.baseURL}',` : ''}
    ${script.viewport ? `viewport: { width: ${script.viewport.width}, height: ${script.viewport.height} },` : ''}
  },
  reporter: [['json', { outputFile: 'report.json' }]],
  outputDir: './results',
});
`;

  const configPath = path.join(outputDir, 'playwright.config.ts');
  await fs.promises.writeFile(configPath, configContent);

  // Run test
  return runPlaywrightTest({
    ...options,
    testPath: scriptPath,
    outputDir,
  });
}

// ============================================================================
// SAVE SCRIPT FILE
// ============================================================================
export async function savePlaywrightScript(
  script: PlaywrightScript,
  outputPath?: string
): Promise<string> {
  const content = generatePlaywrightScript(script);
  const filePath = outputPath || path.join(
    PROJECTS_DIR,
    'scripts',
    `${script.name?.replace(/\s+/g, '_') || 'test'}_${Date.now()}.spec.ts`
  );

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, content);

  return filePath;
}

// ============================================================================
// CODEGEN MODE
// ============================================================================
export async function startPlaywrightCodegen(
  url?: string,
  options: {
    browser?: 'chromium' | 'firefox' | 'webkit';
    device?: string;
    outputPath?: string;
  } = {}
): Promise<{ success: boolean; error?: string }> {
  const installed = await isPlaywrightInstalled();
  if (!installed) {
    return {
      success: false,
      error: 'Playwright is not installed',
    };
  }

  try {
    const args = ['playwright', 'codegen'];

    if (options.browser) {
      args.push('--browser', options.browser);
    }

    if (options.device) {
      args.push('--device', `"${options.device}"`);
    }

    if (options.outputPath) {
      args.push('-o', options.outputPath);
    }

    if (url) {
      args.push(url);
    }

    // Start codegen in background (non-blocking)
    spawn('npx', args, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// SHOW REPORT
// ============================================================================
export async function showPlaywrightReport(reportDir?: string): Promise<{ success: boolean; error?: string }> {
  const installed = await isPlaywrightInstalled();
  if (!installed) {
    return {
      success: false,
      error: 'Playwright is not installed',
    };
  }

  try {
    const args = ['playwright', 'show-report'];

    if (reportDir) {
      args.push(reportDir);
    }

    // Start report viewer in background
    spawn('npx', args, {
      detached: true,
      stdio: 'ignore',
      shell: true,
    }).unref();

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// PREDEFINED SCRIPTS
// ============================================================================
export function createLoginScript(
  baseURL: string,
  usernameSelector: string,
  passwordSelector: string,
  submitSelector: string,
  successURL: string
): PlaywrightScript {
  return {
    name: 'Login Test',
    baseURL,
    actions: [
      PlaywrightActions.goto(baseURL),
      PlaywrightActions.fill(usernameSelector, '${USERNAME}'),
      PlaywrightActions.fill(passwordSelector, '${PASSWORD}'),
      PlaywrightActions.click(submitSelector),
      PlaywrightActions.waitForURL(successURL),
      PlaywrightActions.expectURL(successURL),
      PlaywrightActions.screenshot('login-success.png'),
    ],
  };
}

export function createNavigationScript(
  baseURL: string,
  links: Array<{ selector: string; expectedURL: string; name: string }>
): PlaywrightScript {
  const actions: PlaywrightAction[] = [PlaywrightActions.goto(baseURL)];

  for (const link of links) {
    actions.push(PlaywrightActions.click(link.selector));
    actions.push(PlaywrightActions.waitForURL(link.expectedURL));
    actions.push(PlaywrightActions.screenshot(`${link.name}.png`));
    actions.push(PlaywrightActions.goBack());
  }

  return {
    name: 'Navigation Test',
    baseURL,
    actions,
  };
}

export function createFormSubmissionScript(
  baseURL: string,
  formFields: Array<{ selector: string; value: string }>,
  submitSelector: string,
  successIndicator: string
): PlaywrightScript {
  const actions: PlaywrightAction[] = [PlaywrightActions.goto(baseURL)];

  for (const field of formFields) {
    actions.push(PlaywrightActions.fill(field.selector, field.value));
  }

  actions.push(PlaywrightActions.click(submitSelector));
  actions.push(PlaywrightActions.waitForSelector(successIndicator));
  actions.push(PlaywrightActions.expectVisible(successIndicator));
  actions.push(PlaywrightActions.screenshot('form-success.png'));

  return {
    name: 'Form Submission Test',
    baseURL,
    actions,
  };
}
