/**
 * DiscoveryLab Notion Integration
 * Browser-based automation for Notion page creation and evidence upload
 */

import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECTS_DIR, DATA_DIR } from '../db/index.js';

const execAsync = promisify(exec);

// ============================================================================
// TYPES
// ============================================================================
export interface NotionConfig {
  workspaceUrl?: string; // e.g., https://www.notion.so/myworkspace
  parentPageId?: string; // ID of parent page to create under
  browserPath?: string; // Custom browser path
  headless?: boolean;
  timeout?: number;
}

export interface NotionPageContent {
  title: string;
  icon?: string; // Emoji or URL
  cover?: string; // URL to cover image
  content: NotionBlock[];
}

export interface NotionBlock {
  type: 'heading1' | 'heading2' | 'heading3' | 'paragraph' | 'bulletList' | 'numberedList' | 'toggle' | 'quote' | 'callout' | 'divider' | 'image' | 'video' | 'file' | 'code' | 'gallery';
  content?: string;
  items?: string[]; // For lists
  children?: NotionBlock[]; // For toggle
  url?: string; // For media
  paths?: string[]; // For gallery (local file paths)
  language?: string; // For code blocks
  color?: string; // For callouts
}

export interface NotionExportOptions {
  projectId: string;
  title: string;
  description?: string;
  screenshots?: string[];
  videos?: string[];
  notes?: string;
  tags?: string[];
  parentPageId?: string;
  template?: 'evidence' | 'testReport' | 'gallery' | 'custom';
}

export interface NotionExportResult {
  success: boolean;
  error?: string;
  pageUrl?: string;
  pageId?: string;
}

export interface NotionAuthState {
  authenticated: boolean;
  workspace?: string;
  email?: string;
  sessionPath?: string;
}

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================
const SESSION_DIR = path.join(DATA_DIR, 'sessions', 'notion');

export async function getNotionSessionPath(): Promise<string> {
  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  return SESSION_DIR;
}

export async function checkNotionAuth(): Promise<NotionAuthState> {
  const sessionPath = await getNotionSessionPath();
  const cookiesPath = path.join(sessionPath, 'cookies.json');

  if (!fs.existsSync(cookiesPath)) {
    return { authenticated: false, sessionPath };
  }

  try {
    const cookies = JSON.parse(await fs.promises.readFile(cookiesPath, 'utf-8'));
    const notionCookies = cookies.filter((c: any) => c.domain?.includes('notion'));

    if (notionCookies.length > 0) {
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
export function generateNotionLoginScript(): string {
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

  // Navigate to Notion login
  await page.goto('https://www.notion.so/login');

  console.log('Please log in to Notion in the browser window...');
  console.log('The browser will close automatically once logged in.');

  // Wait for successful login (redirect to workspace)
  await page.waitForURL(/notion\\.so\\/[^login]/, { timeout: 300000 });

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

export function generateNotionUploadScript(options: {
  title: string;
  content: NotionBlock[];
  parentPageId?: string;
  files?: string[];
}): string {
  const { title, content, parentPageId, files = [] } = options;

  return `
import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SESSION_DIR = '${SESSION_DIR}';
const TITLE = ${JSON.stringify(title)};
const CONTENT = ${JSON.stringify(content)};
const FILES = ${JSON.stringify(files)};
const PARENT_PAGE_ID = ${JSON.stringify(parentPageId || null)};

async function createPage() {
  const browser = await chromium.launchPersistentContext(SESSION_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
  });

  const page = browser.pages()[0] || await browser.newPage();

  try {
    // Navigate to parent page or workspace
    if (PARENT_PAGE_ID) {
      await page.goto(\`https://www.notion.so/\${PARENT_PAGE_ID}\`);
    } else {
      await page.goto('https://www.notion.so');
    }

    await page.waitForLoadState('networkidle');

    // Create new page
    await page.keyboard.press('Control+N');
    await page.waitForTimeout(1000);

    // Set title
    await page.keyboard.type(TITLE);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);

    // Add content blocks
    for (const block of CONTENT) {
      await addBlock(page, block);
    }

    // Upload files
    for (const filePath of FILES) {
      if (fs.existsSync(filePath)) {
        await uploadFile(page, filePath);
      }
    }

    // Get page URL
    const url = page.url();
    console.log(JSON.stringify({ success: true, pageUrl: url }));

  } catch (error) {
    console.log(JSON.stringify({ success: false, error: error.message }));
  } finally {
    await browser.close();
  }
}

async function addBlock(page, block) {
  switch (block.type) {
    case 'heading1':
      await page.keyboard.type('/h1');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'heading2':
      await page.keyboard.type('/h2');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'heading3':
      await page.keyboard.type('/h3');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'paragraph':
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'bulletList':
      for (const item of block.items || []) {
        await page.keyboard.type('/bullet');
        await page.keyboard.press('Enter');
        await page.keyboard.type(item);
        await page.keyboard.press('Enter');
      }
      break;

    case 'numberedList':
      for (const item of block.items || []) {
        await page.keyboard.type('/numbered');
        await page.keyboard.press('Enter');
        await page.keyboard.type(item);
        await page.keyboard.press('Enter');
      }
      break;

    case 'quote':
      await page.keyboard.type('/quote');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'callout':
      await page.keyboard.type('/callout');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      break;

    case 'divider':
      await page.keyboard.type('/divider');
      await page.keyboard.press('Enter');
      break;

    case 'code':
      await page.keyboard.type('/code');
      await page.keyboard.press('Enter');
      await page.keyboard.type(block.content || '');
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape');
      break;

    case 'image':
      if (block.url) {
        await page.keyboard.type('/image');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(500);
        // Click "Embed link"
        await page.click('text=Embed link');
        await page.keyboard.type(block.url);
        await page.keyboard.press('Enter');
      }
      break;

    case 'gallery':
      await page.keyboard.type('/gallery');
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      // Upload images to gallery
      for (const imagePath of block.paths || []) {
        if (fs.existsSync(imagePath)) {
          await uploadFile(page, imagePath);
        }
      }
      break;
  }

  await page.waitForTimeout(300);
}

async function uploadFile(page, filePath) {
  await page.keyboard.type('/file');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  const fileInput = await page.waitForSelector('input[type="file"]', { timeout: 5000 });
  await fileInput.setInputFiles(filePath);
  await page.waitForTimeout(2000);
}

createPage().catch(console.error);
`;
}

// ============================================================================
// NOTION OPERATIONS
// ============================================================================
export async function loginToNotion(): Promise<NotionExportResult> {
  const script = generateNotionLoginScript();
  const scriptPath = path.join(SESSION_DIR, 'login.mjs');

  await fs.promises.mkdir(SESSION_DIR, { recursive: true });
  await fs.promises.writeFile(scriptPath, script);

  try {
    await execAsync(`npx playwright install chromium`);
    await execAsync(`node "${scriptPath}"`, { timeout: 300000 });

    const auth = await checkNotionAuth();
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

export async function createNotionPage(options: NotionExportOptions): Promise<NotionExportResult> {
  const auth = await checkNotionAuth();
  if (!auth.authenticated) {
    return { success: false, error: 'Not authenticated. Run dlab.notion.login first.' };
  }

  // Build content based on template
  const content = buildPageContent(options);
  const files = [...(options.screenshots || []), ...(options.videos || [])];

  const script = generateNotionUploadScript({
    title: options.title,
    content,
    parentPageId: options.parentPageId,
    files,
  });

  const scriptPath = path.join(SESSION_DIR, 'upload.mjs');
  await fs.promises.writeFile(scriptPath, script);

  try {
    const { stdout } = await execAsync(`node "${scriptPath}"`, { timeout: 120000 });

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

function buildPageContent(options: NotionExportOptions): NotionBlock[] {
  const { template = 'evidence', description, notes, tags, screenshots, videos } = options;

  const blocks: NotionBlock[] = [];

  switch (template) {
    case 'evidence':
      // Description
      if (description) {
        blocks.push({ type: 'paragraph', content: description });
      }

      // Tags
      if (tags && tags.length > 0) {
        blocks.push({ type: 'paragraph', content: `Tags: ${tags.join(', ')}` });
      }

      blocks.push({ type: 'divider' });

      // Screenshots gallery
      if (screenshots && screenshots.length > 0) {
        blocks.push({ type: 'heading2', content: 'Screenshots' });
        blocks.push({ type: 'gallery', paths: screenshots });
      }

      // Videos
      if (videos && videos.length > 0) {
        blocks.push({ type: 'heading2', content: 'Videos' });
        for (const video of videos) {
          blocks.push({ type: 'file', url: video });
        }
      }

      // Notes
      if (notes) {
        blocks.push({ type: 'heading2', content: 'Notes' });
        blocks.push({ type: 'paragraph', content: notes });
      }
      break;

    case 'testReport':
      blocks.push({ type: 'callout', content: 'Test Report', color: 'blue' });

      if (description) {
        blocks.push({ type: 'heading2', content: 'Summary' });
        blocks.push({ type: 'paragraph', content: description });
      }

      if (screenshots && screenshots.length > 0) {
        blocks.push({ type: 'heading2', content: 'Evidence' });
        blocks.push({ type: 'gallery', paths: screenshots });
      }

      if (notes) {
        blocks.push({ type: 'heading2', content: 'Details' });
        blocks.push({ type: 'paragraph', content: notes });
      }
      break;

    case 'gallery':
      if (description) {
        blocks.push({ type: 'paragraph', content: description });
      }

      if (screenshots && screenshots.length > 0) {
        blocks.push({ type: 'gallery', paths: screenshots });
      }
      break;

    case 'custom':
    default:
      if (description) {
        blocks.push({ type: 'paragraph', content: description });
      }

      if (screenshots && screenshots.length > 0) {
        for (const img of screenshots) {
          blocks.push({ type: 'image', url: img });
        }
      }

      if (notes) {
        blocks.push({ type: 'paragraph', content: notes });
      }
      break;
  }

  return blocks;
}

// ============================================================================
// MARKDOWN TO NOTION CONVERSION
// ============================================================================
export function markdownToNotionBlocks(markdown: string): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const lines = markdown.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Headings
    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading3', content: line.slice(4) });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'heading2', content: line.slice(3) });
    } else if (line.startsWith('# ')) {
      blocks.push({ type: 'heading1', content: line.slice(2) });
    }
    // Bullet list
    else if (line.match(/^[-*]\s/)) {
      const items: string[] = [line.slice(2)];
      while (i + 1 < lines.length && lines[i + 1].match(/^[-*]\s/)) {
        i++;
        items.push(lines[i].slice(2));
      }
      blocks.push({ type: 'bulletList', items });
    }
    // Numbered list
    else if (line.match(/^\d+\.\s/)) {
      const items: string[] = [line.replace(/^\d+\.\s/, '')];
      while (i + 1 < lines.length && lines[i + 1].match(/^\d+\.\s/)) {
        i++;
        items.push(lines[i].replace(/^\d+\.\s/, ''));
      }
      blocks.push({ type: 'numberedList', items });
    }
    // Quote
    else if (line.startsWith('> ')) {
      blocks.push({ type: 'quote', content: line.slice(2) });
    }
    // Horizontal rule
    else if (line.match(/^(-{3,}|_{3,}|\*{3,})$/)) {
      blocks.push({ type: 'divider' });
    }
    // Code block
    else if (line.startsWith('```')) {
      const language = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'code', content: codeLines.join('\n'), language });
    }
    // Image
    else if (line.match(/^!\[.*\]\(.*\)$/)) {
      const match = line.match(/^!\[.*\]\((.*)\)$/);
      if (match) {
        blocks.push({ type: 'image', url: match[1] });
      }
    }
    // Paragraph
    else if (line.trim()) {
      blocks.push({ type: 'paragraph', content: line });
    }

    i++;
  }

  return blocks;
}

// ============================================================================
// QUICK EXPORT
// ============================================================================
export async function quickExportToNotion(
  title: string,
  files: string[],
  notes?: string
): Promise<NotionExportResult> {
  const screenshots = files.filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
  const videos = files.filter(f => /\.(mp4|mov|webm|gif)$/i.test(f));

  return createNotionPage({
    projectId: 'quick-export',
    title,
    screenshots,
    videos,
    notes,
    template: screenshots.length > 3 ? 'gallery' : 'evidence',
  });
}
