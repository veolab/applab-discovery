/**
 * DiscoveryLab Jira Integration
 * Browser-based automation for Jira issue attachment and comment creation
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../db/index.js';

const execAsync = promisify(exec);

// ============================================================================
// TYPES
// ============================================================================
export interface JiraConfig {
  baseUrl?: string; // e.g., https://mycompany.atlassian.net
  projectKey?: string;
  browserPath?: string;
  headless?: boolean;
  timeout?: number;
}

export interface JiraAttachmentOptions {
  issueKey: string; // e.g., PROJ-123
  files: string[]; // Local file paths
  comment?: string; // Optional comment to add with attachments
}

export interface JiraCommentOptions {
  issueKey: string;
  comment: string;
  attachments?: string[]; // Files to attach with the comment
}

export interface JiraIssueOptions {
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: 'Bug' | 'Story' | 'Task' | 'Epic';
  priority?: 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest';
  labels?: string[];
  attachments?: string[];
}

export interface JiraExportResult {
  success: boolean;
  error?: string;
  issueKey?: string;
  issueUrl?: string;
  attachmentUrls?: string[];
}

export interface JiraAuthState {
  authenticated: boolean;
  baseUrl?: string;
  sessionPath?: string;
}

export interface JiraSearchResult {
  issues: Array<{
    key: string;
    summary: string;
    status: string;
    assignee?: string;
    url: string;
  }>;
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================
const SESSION_DIR = path.join(DATA_DIR, 'sessions', 'jira');

export async function getJiraSessionPath(): Promise<string> {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  return SESSION_DIR;
}

export async function checkJiraAuth(): Promise<JiraAuthState> {
  const sessionPath = await getJiraSessionPath();
  const configPath = path.join(sessionPath, 'config.json');
  const cookiesPath = path.join(sessionPath, 'cookies.json');

  let baseUrl: string | undefined;

  // Read saved config
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(await fs.promises.readFile(configPath, 'utf-8'));
      baseUrl = config.baseUrl;
    } catch {
      // Invalid config
    }
  }

  if (!fs.existsSync(cookiesPath)) {
    return { authenticated: false, sessionPath, baseUrl };
  }

  try {
    const cookies = JSON.parse(await fs.promises.readFile(cookiesPath, 'utf-8'));
    const jiraCookies = cookies.filter((c: any) =>
      c.domain?.includes('atlassian.net') || c.domain?.includes('jira')
    );

    if (jiraCookies.length > 0) {
      return {
        authenticated: true,
        baseUrl,
        sessionPath,
      };
    }
  } catch {
    // Invalid cookies file
  }

  return { authenticated: false, sessionPath, baseUrl };
}

export async function saveJiraConfig(baseUrl: string): Promise<void> {
  const sessionPath = await getJiraSessionPath();
  const configPath = path.join(sessionPath, 'config.json');
  await fs.promises.writeFile(configPath, JSON.stringify({ baseUrl }, null, 2));
}

// ============================================================================
// PLAYWRIGHT SCRIPT GENERATION
// ============================================================================
export function generateJiraLoginScript(baseUrl: string): string {
  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';
const BASE_URL = '${baseUrl}';

async function login() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();

  // Navigate to Jira
  await page.goto(BASE_URL);

  console.log('Please log in to Jira in the browser window...');
  console.log('The browser will close automatically once logged in.');

  // Wait for successful login (should see project board or dashboard)
  await page.waitForSelector('[data-testid="global-navigation"]', { timeout: 300000 });

  // Save cookies
  const cookies = await browser.cookies();
  await fs.promises.writeFile(
    path.join(SESSION_DIR, 'cookies.json'),
    JSON.stringify(cookies, null, 2)
  );

  // Save config
  await fs.promises.writeFile(
    path.join(SESSION_DIR, 'config.json'),
    JSON.stringify({ baseUrl: BASE_URL }, null, 2)
  );

  console.log('Login successful! Session saved.');
  await browser.close();
}

login().catch(console.error);
`;
}

export function generateJiraAttachScript(options: {
  baseUrl: string;
  issueKey: string;
  files: string[];
  comment?: string;
}): string {
  const { baseUrl, issueKey, files, comment } = options;

  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';
const BASE_URL = '${baseUrl}';
const ISSUE_KEY = '${issueKey}';
const FILES = ${JSON.stringify(files)};
const COMMENT = ${JSON.stringify(comment || null)};

async function attach() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  const attachmentUrls = [];

  try {
    // Navigate to issue
    await page.goto(\`\${BASE_URL}/browse/\${ISSUE_KEY}\`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Upload attachments
    if (FILES.length > 0) {
      // Find attach button
      const attachButton = await page.waitForSelector('[data-testid="issue.views.issue-base.foundation.attachment.attachment-panel.attach-file"]', { timeout: 5000 }).catch(() => null);

      if (attachButton) {
        await attachButton.click();
      } else {
        // Try alternative method - drag and drop area
        const dropZone = await page.waitForSelector('[data-testid="issue.views.issue-base.foundation.attachment.drop-zone"]', { timeout: 5000 }).catch(() => null);

        if (!dropZone) {
          // Click on "Attach" in the issue actions
          await page.click('text=Attach');
        }
      }

      await page.waitForTimeout(500);

      // Find file input
      const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 });

      // Upload files
      for (const filePath of FILES) {
        if (fs.existsSync(filePath)) {
          await fileInput.setInputFiles(filePath);
          await page.waitForTimeout(2000);
        }
      }

      // Wait for upload to complete
      await page.waitForTimeout(3000);
    }

    // Add comment if specified
    if (COMMENT) {
      // Click on comment field
      const commentField = await page.waitForSelector('[data-testid="issue.activity.comments-section"]', { timeout: 5000 }).catch(() => null);

      if (commentField) {
        await commentField.click();
        await page.waitForTimeout(500);

        // Find the comment input
        const commentInput = await page.waitForSelector('[data-testid="issue.activity.comment.create.editor-container"] [contenteditable="true"]', { timeout: 5000 }).catch(() => null);

        if (commentInput) {
          await commentInput.click();
          await page.keyboard.type(COMMENT);

          // Submit comment
          await page.click('text=Save');
          await page.waitForTimeout(2000);
        }
      }
    }

    const issueUrl = page.url();

    console.log(JSON.stringify({
      success: true,
      issueKey: ISSUE_KEY,
      issueUrl,
      attachmentUrls,
    }));

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
  } finally {
    await browser.close();
  }
}

attach().catch(console.error);
`;
}

export function generateJiraCreateIssueScript(options: {
  baseUrl: string;
  projectKey: string;
  summary: string;
  description?: string;
  issueType?: string;
  priority?: string;
  labels?: string[];
  attachments?: string[];
}): string {
  const {
    baseUrl,
    projectKey,
    summary,
    description,
    issueType = 'Task',
    priority,
    labels = [],
    attachments = [],
  } = options;

  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';
const BASE_URL = '${baseUrl}';
const PROJECT_KEY = '${projectKey}';
const SUMMARY = ${JSON.stringify(summary)};
const DESCRIPTION = ${JSON.stringify(description || '')};
const ISSUE_TYPE = '${issueType}';
const PRIORITY = ${JSON.stringify(priority || null)};
const LABELS = ${JSON.stringify(labels)};
const ATTACHMENTS = ${JSON.stringify(attachments)};

async function createIssue() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    // Navigate to project
    await page.goto(\`\${BASE_URL}/jira/software/projects/\${PROJECT_KEY}/boards\`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    // Click create button
    await page.click('[data-testid="navigation-apps-sidebar-software.global-create-button"]');
    await page.waitForTimeout(1000);

    // Wait for create dialog
    await page.waitForSelector('[data-testid="create-issue-dialog"]', { timeout: 10000 });

    // Select issue type
    await page.click(\`text=\${ISSUE_TYPE}\`).catch(() => {});
    await page.waitForTimeout(500);

    // Fill summary
    const summaryInput = await page.waitForSelector('[data-testid="create-issue-dialog.ui.summary-field.summary-field.input"]', { timeout: 5000 });
    await summaryInput.fill(SUMMARY);

    // Fill description if provided
    if (DESCRIPTION) {
      const descField = await page.waitForSelector('[data-testid="create-issue-dialog.ui.description-field.description-field.description-field"] [contenteditable="true"]', { timeout: 5000 }).catch(() => null);
      if (descField) {
        await descField.click();
        await page.keyboard.type(DESCRIPTION);
      }
    }

    // Set priority if provided
    if (PRIORITY) {
      await page.click('text=Priority').catch(() => {});
      await page.waitForTimeout(300);
      await page.click(\`text=\${PRIORITY}\`).catch(() => {});
    }

    // Add labels
    for (const label of LABELS) {
      await page.click('text=Labels').catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.type(label);
      await page.keyboard.press('Enter');
    }

    // Create the issue
    await page.click('text=Create');
    await page.waitForTimeout(3000);

    // Get the created issue key from the notification or URL
    const notification = await page.waitForSelector('[data-testid="issue-created-notification"]', { timeout: 10000 }).catch(() => null);

    let issueKey = '';
    let issueUrl = '';

    if (notification) {
      const link = await notification.$('a');
      if (link) {
        issueKey = await link.textContent() || '';
        issueUrl = await link.getAttribute('href') || '';
        if (issueUrl && !issueUrl.startsWith('http')) {
          issueUrl = \`\${BASE_URL}\${issueUrl}\`;
        }
      }
    }

    // Upload attachments if any
    if (ATTACHMENTS.length > 0 && issueKey) {
      await page.goto(\`\${BASE_URL}/browse/\${issueKey}\`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(2000);

      const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(() => null);
      if (fileInput) {
        for (const filePath of ATTACHMENTS) {
          if (fs.existsSync(filePath)) {
            await fileInput.setInputFiles(filePath);
            await page.waitForTimeout(2000);
          }
        }
      }
    }

    console.log(JSON.stringify({
      success: true,
      issueKey,
      issueUrl,
    }));

  } catch (error) {
    console.log(JSON.stringify({
      success: false,
      error: error.message,
    }));
  } finally {
    await browser.close();
  }
}

createIssue().catch(console.error);
`;
}

// ============================================================================
// JIRA OPERATIONS
// ============================================================================
export async function loginToJira(baseUrl: string): Promise<JiraExportResult> {
  const script = generateJiraLoginScript(baseUrl);
  const scriptPath = path.join(SESSION_DIR, 'login.mjs');

  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  await fs.promises.writeFile(scriptPath, script);

  try {
    await execAsync(`npx playwright install chromium`);
    await execAsync(`node "${scriptPath}"`, { timeout: 300000 });

    const auth = await checkJiraAuth();
    if (auth.authenticated) {
      await saveJiraConfig(baseUrl);
      return { success: true };
    }

    return { success: false, error: 'Login was not completed' };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function attachToJiraIssue(options: JiraAttachmentOptions): Promise<JiraExportResult> {
  const auth = await checkJiraAuth();
  if (!auth.authenticated) {
    return { success: false, error: 'Not authenticated. Run dlab.jira.login first.' };
  }

  if (!auth.baseUrl) {
    return { success: false, error: 'Jira base URL not configured.' };
  }

  // Validate files exist
  const existingFiles = options.files.filter(f => fs.existsSync(f));
  if (existingFiles.length === 0 && !options.comment) {
    return { success: false, error: 'No valid files to attach and no comment provided' };
  }

  const script = generateJiraAttachScript({
    baseUrl: auth.baseUrl,
    issueKey: options.issueKey,
    files: existingFiles,
    comment: options.comment,
  });

  const scriptPath = path.join(SESSION_DIR, 'attach.mjs');
  await fs.promises.writeFile(scriptPath, script);

  try {
    const { stdout } = await execAsync(`node "${scriptPath}"`, { timeout: 120000 });

    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine);

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createJiraIssue(options: JiraIssueOptions): Promise<JiraExportResult> {
  const auth = await checkJiraAuth();
  if (!auth.authenticated) {
    return { success: false, error: 'Not authenticated. Run dlab.jira.login first.' };
  }

  if (!auth.baseUrl) {
    return { success: false, error: 'Jira base URL not configured.' };
  }

  const script = generateJiraCreateIssueScript({
    baseUrl: auth.baseUrl,
    projectKey: options.projectKey,
    summary: options.summary,
    description: options.description,
    issueType: options.issueType,
    priority: options.priority,
    labels: options.labels,
    attachments: options.attachments,
  });

  const scriptPath = path.join(SESSION_DIR, 'create.mjs');
  await fs.promises.writeFile(scriptPath, script);

  try {
    const { stdout } = await execAsync(`node "${scriptPath}"`, { timeout: 120000 });

    const lines = stdout.trim().split('\n');
    const lastLine = lines[lines.length - 1];
    const result = JSON.parse(lastLine);

    return result;
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function addJiraComment(options: JiraCommentOptions): Promise<JiraExportResult> {
  return attachToJiraIssue({
    issueKey: options.issueKey,
    files: options.attachments || [],
    comment: options.comment,
  });
}

// ============================================================================
// QUICK EXPORT
// ============================================================================
export async function quickExportToJira(
  issueKey: string,
  files: string[],
  comment?: string
): Promise<JiraExportResult> {
  return attachToJiraIssue({
    issueKey,
    files,
    comment: comment || `Evidence attached via DiscoveryLab at ${new Date().toISOString()}`,
  });
}

// ============================================================================
// ISSUE URL HELPERS
// ============================================================================
export function getJiraIssueUrl(baseUrl: string, issueKey: string): string {
  return `${baseUrl}/browse/${issueKey}`;
}

export function parseJiraIssueKey(input: string): string | null {
  // Match patterns like PROJ-123, ABC-1, etc.
  const match = input.match(/([A-Z][A-Z0-9]*-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}
