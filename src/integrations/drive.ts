/**
 * DiscoveryLab Google Drive Integration
 * Browser-based automation for Google Drive folder creation and file upload
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
export interface DriveConfig {
  folderId?: string; // Parent folder ID
  browserPath?: string;
  headless?: boolean;
  timeout?: number;
}

export interface DriveUploadOptions {
  files: string[]; // Local file paths
  folderName?: string; // Create new folder with this name
  parentFolderId?: string; // Upload to existing folder
  description?: string;
}

export interface DriveExportResult {
  success: boolean;
  error?: string;
  folderUrl?: string;
  folderId?: string;
  uploadedFiles?: Array<{
    name: string;
    url: string;
    id: string;
  }>;
}

export interface DriveAuthState {
  authenticated: boolean;
  email?: string;
  sessionPath?: string;
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================
const SESSION_DIR = path.join(DATA_DIR, 'sessions', 'drive');

export async function getDriveSessionPath(): Promise<string> {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  return SESSION_DIR;
}

export async function checkDriveAuth(): Promise<DriveAuthState> {
  const sessionPath = await getDriveSessionPath();
  const cookiesPath = path.join(sessionPath, 'cookies.json');

  if (!fs.existsSync(cookiesPath)) {
    return { authenticated: false, sessionPath };
  }

  try {
    const cookies = JSON.parse(await fs.promises.readFile(cookiesPath, 'utf-8'));
    const googleCookies = cookies.filter((c: any) =>
      c.domain?.includes('google.com') || c.domain?.includes('drive.google.com')
    );

    if (googleCookies.length > 0) {
      return {
        authenticated: true,
        sessionPath,
      };
    }
  } catch {
    // Invalid cookies file
  }

  return { authenticated: false, sessionPath };
}

// ============================================================================
// PLAYWRIGHT SCRIPT GENERATION
// ============================================================================
export function generateDriveLoginScript(): string {
  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';

async function login() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();

  // Navigate to Google Drive
  await page.goto('https://drive.google.com');

  console.log('Please log in to Google in the browser window...');
  console.log('The browser will close automatically once logged in.');

  // Wait for successful login (redirect to Drive main page)
  await page.waitForURL(/drive\\.google\\.com\\/drive/, { timeout: 300000 });

  // Save cookies
  const cookies = await browser.cookies();
  await fs.promises.writeFile(
    path.join(SESSION_DIR, 'cookies.json'),
    JSON.stringify(cookies, null, 2)
  );

  console.log('Login successful! Session saved.');
  await browser.close();
}

login().catch(console.error);
`;
}

export function generateDriveUploadScript(options: {
  files: string[];
  folderName?: string;
  parentFolderId?: string;
}): string {
  const { files, folderName, parentFolderId } = options;

  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';
const FILES = ${JSON.stringify(files)};
const FOLDER_NAME = ${JSON.stringify(folderName || null)};
const PARENT_FOLDER_ID = ${JSON.stringify(parentFolderId || null)};

async function upload() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();
  const uploadedFiles = [];

  try {
    // Navigate to parent folder or My Drive
    if (PARENT_FOLDER_ID) {
      await page.goto(\`https://drive.google.com/drive/folders/\${PARENT_FOLDER_ID}\`);
    } else {
      await page.goto('https://drive.google.com/drive/my-drive');
    }

    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(2000);

    let folderId = PARENT_FOLDER_ID;
    let folderUrl = page.url();

    // Create new folder if specified
    if (FOLDER_NAME) {
      // Click "New" button
      await page.click('[aria-label="New"]');
      await page.waitForTimeout(500);

      // Click "New folder"
      await page.click('text=New folder');
      await page.waitForTimeout(500);

      // Type folder name
      await page.fill('input[type="text"]', FOLDER_NAME);
      await page.click('text=Create');
      await page.waitForTimeout(2000);

      // Open the new folder
      await page.dblclick(\`text="\${FOLDER_NAME}"\`);
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1000);

      folderUrl = page.url();
      const match = folderUrl.match(/folders\\/([a-zA-Z0-9_-]+)/);
      if (match) {
        folderId = match[1];
      }
    }

    // Upload files
    for (const filePath of FILES) {
      if (!fs.existsSync(filePath)) {
        console.error(\`File not found: \${filePath}\`);
        continue;
      }

      // Click "New" button
      await page.click('[aria-label="New"]');
      await page.waitForTimeout(500);

      // Click "File upload"
      const fileInput = await page.waitForSelector('input[type="file"]', { state: 'attached' });
      await page.click('text=File upload');

      // Upload file
      await fileInput.setInputFiles(filePath);
      await page.waitForTimeout(3000);

      // Wait for upload to complete
      await page.waitForSelector('text=Upload complete', { timeout: 60000 }).catch(() => {});

      const fileName = path.basename(filePath);
      uploadedFiles.push({
        name: fileName,
        url: folderUrl,
        id: folderId || 'unknown',
      });

      await page.waitForTimeout(1000);
    }

    console.log(JSON.stringify({
      success: true,
      folderUrl,
      folderId,
      uploadedFiles,
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

upload().catch(console.error);
`;
}

// ============================================================================
// DRIVE OPERATIONS
// ============================================================================
export async function loginToDrive(): Promise<DriveExportResult> {
  const script = generateDriveLoginScript();
  const scriptPath = path.join(SESSION_DIR, 'login.mjs');

  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  await fs.promises.writeFile(scriptPath, script);

  try {
    await execAsync(`npx playwright install chromium`);
    await execAsync(`node "${scriptPath}"`, { timeout: 300000 });

    const auth = await checkDriveAuth();
    if (auth.authenticated) {
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

export async function uploadToDrive(options: DriveUploadOptions): Promise<DriveExportResult> {
  const auth = await checkDriveAuth();
  if (!auth.authenticated) {
    return { success: false, error: 'Not authenticated. Run dlab.drive.login first.' };
  }

  // Validate files exist
  const existingFiles = options.files.filter(f => fs.existsSync(f));
  if (existingFiles.length === 0) {
    return { success: false, error: 'No valid files to upload' };
  }

  const script = generateDriveUploadScript({
    files: existingFiles,
    folderName: options.folderName,
    parentFolderId: options.parentFolderId,
  });

  const scriptPath = path.join(SESSION_DIR, 'upload.mjs');
  await fs.promises.writeFile(scriptPath, script);

  try {
    const { stdout } = await execAsync(`node "${scriptPath}"`, { timeout: 180000 });

    // Parse result from script output
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

// ============================================================================
// FOLDER OPERATIONS
// ============================================================================
export async function createDriveFolder(
  folderName: string,
  parentFolderId?: string
): Promise<DriveExportResult> {
  return uploadToDrive({
    files: [],
    folderName,
    parentFolderId,
  });
}

// ============================================================================
// QUICK EXPORT
// ============================================================================
export async function quickExportToDrive(
  files: string[],
  folderName?: string
): Promise<DriveExportResult> {
  const defaultFolderName = folderName || `DiscoveryLab Export ${new Date().toISOString().split('T')[0]}`;

  return uploadToDrive({
    files,
    folderName: defaultFolderName,
  });
}

// ============================================================================
// SHARE LINK GENERATION
// ============================================================================
export function generateShareableLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;
}

export function generateDownloadLink(fileId: string): string {
  return `https://drive.google.com/uc?export=download&id=${fileId}`;
}

export function generateEmbedLink(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/preview`;
}
