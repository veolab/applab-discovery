/**
 * DiscoveryLab Testing Tools
 * MCP tools for Maestro and Playwright test automation
 */

import { z } from 'zod';
import * as path from 'path';
import * as fs from 'fs';
import type { MCPTool } from '../server.js';
import { createTextResult, createErrorResult } from '../server.js';
import { PROJECTS_DIR } from '../../db/index.js';
import {
  isMaestroInstalled,
  getMaestroVersion,
  listMaestroDevices,
  runMaestroTest,
  runMaestroWithCapture,
  saveMaestroFlow,
  startMaestroStudio,
  generateMaestroFlow,
  MaestroActions,
  createLoginFlow,
  createOnboardingFlow,
  createNavigationTestFlow,
} from '../../core/testing/maestro.js';
import {
  isPlaywrightInstalled,
  getPlaywrightVersion,
  installPlaywrightBrowsers,
  runPlaywrightTest,
  runPlaywrightScript,
  savePlaywrightScript,
  startPlaywrightCodegen,
  showPlaywrightReport,
  listBrowserDevices,
  getBrowserDevice,
  PlaywrightActions,
  createLoginScript,
  createNavigationScript,
  createFormSubmissionScript,
} from '../../core/testing/playwright.js';

// ============================================================================
// dlab.maestro.status
// ============================================================================
export const maestroStatusTool: MCPTool = {
  name: 'dlab.maestro.status',
  description: 'Check Maestro CLI installation status and list connected devices.',
  inputSchema: z.object({}),
  handler: async () => {
    const installed = await isMaestroInstalled();
    const version = installed ? await getMaestroVersion() : null;
    const devices = installed ? await listMaestroDevices() : [];

    return createTextResult(JSON.stringify({
      installed,
      version,
      devices,
      installHint: !installed ? 'curl -Ls "https://get.maestro.mobile.dev" | bash' : null,
    }, null, 2));
  },
};

// ============================================================================
// dlab.maestro.run
// ============================================================================
export const maestroRunTool: MCPTool = {
  name: 'dlab.maestro.run',
  description: 'Run a Maestro test flow on a mobile device/emulator.',
  inputSchema: z.object({
    flowPath: z.string().describe('Path to the Maestro YAML flow file'),
    device: z.string().optional().describe('Device ID or name to run on'),
    appId: z.string().optional().describe('App bundle/package ID'),
    env: z.record(z.string()).optional().describe('Environment variables'),
    timeout: z.number().optional().describe('Timeout in milliseconds (default: 300000)'),
    captureVideo: z.boolean().optional().describe('Capture video during test (default: false)'),
  }),
  handler: async (params) => {
    const { flowPath, device, appId, env, timeout, captureVideo } = params;

    if (!fs.existsSync(flowPath)) {
      return createErrorResult(`Flow file not found: ${flowPath}`);
    }

    const installed = await isMaestroInstalled();
    if (!installed) {
      return createErrorResult('Maestro CLI is not installed. Install with: curl -Ls "https://get.maestro.mobile.dev" | bash');
    }

    const result = captureVideo
      ? await runMaestroWithCapture({ flowPath, device, appId, env, timeout })
      : await runMaestroTest({ flowPath, device, appId, env, timeout });

    return createTextResult(JSON.stringify(result, null, 2));
  },
};

// ============================================================================
// dlab.maestro.studio
// ============================================================================
export const maestroStudioTool: MCPTool = {
  name: 'dlab.maestro.studio',
  description: 'Start Maestro Studio for interactive flow building.',
  inputSchema: z.object({
    appId: z.string().optional().describe('App bundle/package ID'),
  }),
  handler: async (params) => {
    const { appId } = params;

    const installed = await isMaestroInstalled();
    if (!installed) {
      return createErrorResult('Maestro CLI is not installed');
    }

    const result = await startMaestroStudio(appId);

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to start Maestro Studio');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Maestro Studio started. A new window should open.',
    }, null, 2));
  },
};

// ============================================================================
// dlab.maestro.generate
// ============================================================================
export const maestroGenerateTool: MCPTool = {
  name: 'dlab.maestro.generate',
  description: 'Generate a Maestro flow from a template (login, onboarding, navigation).',
  inputSchema: z.object({
    template: z.enum(['login', 'onboarding', 'navigation']).describe('Flow template type'),
    appId: z.string().describe('App bundle/package ID'),
    params: z.record(z.any()).optional().describe('Template-specific parameters'),
    output: z.string().optional().describe('Output file path'),
  }),
  handler: async (params) => {
    const { template, appId, params: templateParams = {}, output } = params;

    let flow;

    switch (template) {
      case 'login':
        flow = createLoginFlow(
          appId,
          templateParams.usernameField || 'Username',
          templateParams.passwordField || 'Password',
          templateParams.loginButton || 'Login',
          templateParams.successIndicator || 'Welcome'
        );
        break;

      case 'onboarding':
        flow = createOnboardingFlow(
          appId,
          templateParams.screens || [
            { nextButton: 'Next' },
            { nextButton: 'Next' },
            { nextButton: 'Get Started' },
          ]
        );
        break;

      case 'navigation':
        flow = createNavigationTestFlow(
          appId,
          templateParams.tabs || ['Home', 'Search', 'Profile']
        );
        break;

      default:
        return createErrorResult(`Unknown template: ${template}`);
    }

    const yaml = generateMaestroFlow(flow);
    const outputPath = output || path.join(PROJECTS_DIR, 'flows', `${template}_${Date.now()}.yaml`);

    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, yaml);

    return createTextResult(JSON.stringify({
      success: true,
      output: outputPath,
      yaml,
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.status
// ============================================================================
export const playwrightStatusTool: MCPTool = {
  name: 'dlab.playwright.status',
  description: 'Check Playwright installation status and list available devices.',
  inputSchema: z.object({}),
  handler: async () => {
    const installed = await isPlaywrightInstalled();
    const version = installed ? await getPlaywrightVersion() : null;
    const devices = listBrowserDevices();

    return createTextResult(JSON.stringify({
      installed,
      version,
      devices: devices.map(d => ({
        name: d.name,
        viewport: d.viewport,
        isMobile: d.isMobile,
      })),
      installHint: !installed ? 'npm install -D @playwright/test && npx playwright install' : null,
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.run
// ============================================================================
export const playwrightRunTool: MCPTool = {
  name: 'dlab.playwright.run',
  description: 'Run Playwright tests.',
  inputSchema: z.object({
    testPath: z.string().optional().describe('Path to test file or directory'),
    testPattern: z.string().optional().describe('Test name pattern to run'),
    browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser to use'),
    headless: z.boolean().optional().describe('Run in headless mode (default: true)'),
    workers: z.number().optional().describe('Number of parallel workers'),
    retries: z.number().optional().describe('Number of retries on failure'),
    timeout: z.number().optional().describe('Test timeout in milliseconds'),
    video: z.enum(['on', 'off', 'retain-on-failure']).optional().describe('Video recording'),
    screenshot: z.enum(['on', 'off', 'only-on-failure']).optional().describe('Screenshot capture'),
  }),
  handler: async (params) => {
    const {
      testPath,
      testPattern,
      browser,
      headless,
      workers,
      retries,
      timeout,
      video,
      screenshot,
    } = params;

    const installed = await isPlaywrightInstalled();
    if (!installed) {
      return createErrorResult('Playwright is not installed. Install with: npm install -D @playwright/test && npx playwright install');
    }

    const result = await runPlaywrightTest({
      testPath,
      testPattern,
      config: {
        browser,
        headless,
        timeout,
        video,
        screenshot,
      },
      workers,
      retries,
    });

    return createTextResult(JSON.stringify(result, null, 2));
  },
};

// ============================================================================
// dlab.playwright.codegen
// ============================================================================
export const playwrightCodegenTool: MCPTool = {
  name: 'dlab.playwright.codegen',
  description: 'Start Playwright Codegen for interactive test recording.',
  inputSchema: z.object({
    url: z.string().optional().describe('Starting URL'),
    browser: z.enum(['chromium', 'firefox', 'webkit']).optional().describe('Browser to use'),
    device: z.string().optional().describe('Device emulation (e.g., "iPhone 14")'),
    output: z.string().optional().describe('Output file path for generated code'),
  }),
  handler: async (params) => {
    const { url, browser, device, output } = params;

    const installed = await isPlaywrightInstalled();
    if (!installed) {
      return createErrorResult('Playwright is not installed');
    }

    const result = await startPlaywrightCodegen(url, {
      browser,
      device,
      outputPath: output,
    });

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to start Playwright Codegen');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Playwright Codegen started. A browser window should open.',
      url,
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.generate
// ============================================================================
export const playwrightGenerateTool: MCPTool = {
  name: 'dlab.playwright.generate',
  description: 'Generate a Playwright test script from a template (login, navigation, form).',
  inputSchema: z.object({
    template: z.enum(['login', 'navigation', 'form']).describe('Script template type'),
    baseURL: z.string().describe('Base URL for the test'),
    params: z.record(z.any()).optional().describe('Template-specific parameters'),
    output: z.string().optional().describe('Output file path'),
  }),
  handler: async (params) => {
    const { template, baseURL, params: templateParams = {}, output } = params;

    let script;

    switch (template) {
      case 'login':
        script = createLoginScript(
          baseURL,
          templateParams.usernameSelector || '#username',
          templateParams.passwordSelector || '#password',
          templateParams.submitSelector || 'button[type="submit"]',
          templateParams.successURL || '/dashboard'
        );
        break;

      case 'navigation':
        script = createNavigationScript(
          baseURL,
          templateParams.links || [
            { selector: 'a[href="/about"]', expectedURL: '/about', name: 'about' },
            { selector: 'a[href="/contact"]', expectedURL: '/contact', name: 'contact' },
          ]
        );
        break;

      case 'form':
        script = createFormSubmissionScript(
          baseURL,
          templateParams.fields || [
            { selector: '#name', value: 'Test User' },
            { selector: '#email', value: 'test@example.com' },
          ],
          templateParams.submitSelector || 'button[type="submit"]',
          templateParams.successIndicator || '.success-message'
        );
        break;

      default:
        return createErrorResult(`Unknown template: ${template}`);
    }

    const outputPath = await savePlaywrightScript(script, output);

    return createTextResult(JSON.stringify({
      success: true,
      output: outputPath,
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.report
// ============================================================================
export const playwrightReportTool: MCPTool = {
  name: 'dlab.playwright.report',
  description: 'Open Playwright HTML report viewer.',
  inputSchema: z.object({
    reportDir: z.string().optional().describe('Report directory path'),
  }),
  handler: async (params) => {
    const { reportDir } = params;

    const installed = await isPlaywrightInstalled();
    if (!installed) {
      return createErrorResult('Playwright is not installed');
    }

    const result = await showPlaywrightReport(reportDir);

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to open report');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Playwright report viewer opened.',
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.install
// ============================================================================
export const playwrightInstallTool: MCPTool = {
  name: 'dlab.playwright.install',
  description: 'Install Playwright browsers.',
  inputSchema: z.object({}),
  handler: async () => {
    const installed = await isPlaywrightInstalled();
    if (!installed) {
      return createErrorResult('Playwright is not installed. First run: npm install -D @playwright/test');
    }

    const result = await installPlaywrightBrowsers();

    if (!result.success) {
      return createErrorResult(result.error || 'Failed to install browsers');
    }

    return createTextResult(JSON.stringify({
      success: true,
      message: 'Playwright browsers installed successfully.',
    }, null, 2));
  },
};

// ============================================================================
// dlab.playwright.devices
// ============================================================================
export const playwrightDevicesTool: MCPTool = {
  name: 'dlab.playwright.devices',
  description: 'List available device emulation profiles for Playwright.',
  inputSchema: z.object({}),
  handler: async () => {
    const devices = listBrowserDevices();

    return createTextResult(JSON.stringify(devices, null, 2));
  },
};

// ============================================================================
// dlab.test.devices
// ============================================================================
export const testDevicesTool: MCPTool = {
  name: 'dlab.test.devices',
  description: 'List all available test devices (Maestro mobile + Playwright browser).',
  inputSchema: z.object({}),
  handler: async () => {
    const maestroInstalled = await isMaestroInstalled();
    const playwrightInstalled = await isPlaywrightInstalled();

    const mobileDevices = maestroInstalled ? await listMaestroDevices() : [];
    const browserDevices = listBrowserDevices();

    return createTextResult(JSON.stringify({
      mobile: {
        available: maestroInstalled,
        devices: mobileDevices,
      },
      browser: {
        available: playwrightInstalled,
        devices: browserDevices.map(d => ({
          name: d.name,
          viewport: d.viewport,
          isMobile: d.isMobile,
        })),
      },
    }, null, 2));
  },
};

// ============================================================================
// EXPORTS
// ============================================================================
export const testingTools: MCPTool[] = [
  // Maestro tools
  maestroStatusTool,
  maestroRunTool,
  maestroStudioTool,
  maestroGenerateTool,

  // Playwright tools
  playwrightStatusTool,
  playwrightRunTool,
  playwrightCodegenTool,
  playwrightGenerateTool,
  playwrightReportTool,
  playwrightInstallTool,
  playwrightDevicesTool,

  // Combined
  testDevicesTool,
];
