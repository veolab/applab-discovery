/**
 * AppLab Project Import
 * Imports .applab ZIP bundles to recreate projects from shared files.
 * Enables sharing between team members:
 * Person A exports → sends .applab file → Person B imports → project appears with full context.
 */

import { existsSync, mkdirSync, readFileSync, cpSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface ImportResult {
  success: boolean;
  projectId?: string;
  projectName?: string;
  frameCount?: number;
  error?: string;
}

/**
 * Extract a ZIP file to a target directory
 */
function extractZip(zipPath: string, targetDir: string): void {
  mkdirSync(targetDir, { recursive: true });
  if (process.platform === 'darwin') {
    try {
      execSync(`ditto -xk "${zipPath}" "${targetDir}"`, { stdio: 'pipe' });
      return;
    } catch { /* fallback to unzip */ }
  }
  execSync(`unzip -qo "${zipPath}" -d "${targetDir}"`, { stdio: 'pipe' });
}

/**
 * Find the root directory inside extracted ZIP (may have a wrapper dir)
 */
function findBundleRoot(extractDir: string): string {
  const entries = readdirSync(extractDir);
  // If there's a single directory, it's the bundle root
  if (entries.length === 1) {
    const candidate = join(extractDir, entries[0]);
    if (statSync(candidate).isDirectory()) return candidate;
  }
  // If manifest.json is at root level
  if (entries.includes('manifest.json')) return extractDir;
  // Check one level deep
  for (const entry of entries) {
    const dir = join(extractDir, entry);
    if (statSync(dir).isDirectory() && existsSync(join(dir, 'manifest.json'))) {
      return dir;
    }
  }
  return extractDir;
}

/**
 * Import a .applab ZIP bundle into the local DiscoveryLab database.
 */
export async function importApplabBundle(
  zipPath: string,
  db: any,
  schema: { projects: any; frames: any },
  paths: { dataDir: string; framesDir: string; projectsDir: string },
): Promise<ImportResult> {
  if (!existsSync(zipPath)) {
    return { success: false, error: `File not found: ${zipPath}` };
  }

  const tempDir = join(paths.dataDir, '.import-temp-' + Date.now());

  try {
    // 1. Extract ZIP
    extractZip(zipPath, tempDir);
    const bundleRoot = findBundleRoot(tempDir);

    // 2. Read manifest
    const manifestPath = join(bundleRoot, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return { success: false, error: 'Invalid .applab file: manifest.json not found' };
    }

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

    // 3. Read project metadata
    let projectData: Record<string, any> = {};
    const projectJsonPath = join(bundleRoot, 'metadata', 'project.json');
    if (existsSync(projectJsonPath)) {
      projectData = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
    }

    // Generate new ID or reuse original
    const projectId = manifest.id || projectData.id || randomUUID();
    const projectName = manifest.name || projectData.name || basename(zipPath, '.applab');

    // Check if project already exists
    const { eq } = await import('drizzle-orm');
    const existing = await db.select().from(schema.projects).where(eq(schema.projects.id, projectId)).limit(1);
    if (existing.length > 0) {
      return { success: false, error: `Project already exists: ${projectName} (${projectId}). Delete it first to re-import.` };
    }

    // 4. Copy frames
    let frameCount = 0;
    const framesSourceDir = join(bundleRoot, 'frames');
    const framesTargetDir = join(paths.framesDir, projectId);
    if (existsSync(framesSourceDir)) {
      mkdirSync(framesTargetDir, { recursive: true });
      cpSync(framesSourceDir, framesTargetDir, { recursive: true });
      frameCount = readdirSync(framesTargetDir).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)).length;
    }

    // 5. Copy media (video, screenshots, recording)
    const projectTargetDir = join(paths.projectsDir, projectId);
    mkdirSync(projectTargetDir, { recursive: true });

    const mediaDir = join(bundleRoot, 'media');
    if (existsSync(mediaDir)) {
      cpSync(mediaDir, projectTargetDir, { recursive: true });
    }

    const recordingDir = join(bundleRoot, 'recording');
    if (existsSync(recordingDir)) {
      cpSync(recordingDir, projectTargetDir, { recursive: true });
    }

    // 6. Read analysis data
    let aiSummary: string | null = null;
    let ocrText: string | null = null;
    const aiPath = join(bundleRoot, 'analysis', 'app-intelligence.md');
    const ocrPath = join(bundleRoot, 'analysis', 'ocr.txt');
    if (existsSync(aiPath)) aiSummary = readFileSync(aiPath, 'utf-8');
    if (existsSync(ocrPath)) ocrText = readFileSync(ocrPath, 'utf-8');

    // 7. Read task hub links
    let taskHubLinks: string | null = null;
    const linksPath = join(bundleRoot, 'taskhub', 'links.json');
    if (existsSync(linksPath)) {
      taskHubLinks = readFileSync(linksPath, 'utf-8');
    }

    // 8. Find video path
    let videoPath: string | null = null;
    const videoExts = ['.mp4', '.mov', '.webm'];
    for (const ext of videoExts) {
      const files = readdirSync(projectTargetDir).filter(f => f.endsWith(ext));
      if (files.length > 0) {
        videoPath = join(projectTargetDir, files[0]);
        break;
      }
    }
    if (!videoPath) videoPath = projectTargetDir; // Directory-based recording

    // 9. Find thumbnail
    let thumbnailPath: string | null = null;
    if (frameCount > 0) {
      const firstFrame = readdirSync(framesTargetDir).filter(f => /\.(png|jpg|jpeg|webp)$/i.test(f)).sort()[0];
      if (firstFrame) thumbnailPath = join(framesTargetDir, firstFrame);
    }

    // 10. Create project record in DB
    const now = new Date();
    await db.insert(schema.projects).values({
      id: projectId,
      name: projectName,
      marketingTitle: projectData.marketingTitle || projectName,
      marketingDescription: projectData.marketingDescription || null,
      videoPath,
      thumbnailPath,
      platform: manifest.platform || projectData.platform || null,
      aiSummary,
      ocrText,
      ocrEngine: projectData.ocrEngine || null,
      ocrConfidence: projectData.ocrConfidence || null,
      frameCount,
      duration: projectData.duration || null,
      manualNotes: projectData.manualNotes || null,
      tags: projectData.tags || null,
      linkedTicket: projectData.linkedTicket || null,
      linkedJiraUrl: projectData.linkedJiraUrl || null,
      linkedNotionUrl: projectData.linkedNotionUrl || null,
      linkedFigmaUrl: projectData.linkedFigmaUrl || null,
      taskHubLinks,
      taskRequirements: projectData.taskRequirements || null,
      taskTestMap: projectData.taskTestMap || null,
      status: aiSummary ? 'analyzed' : 'draft',
      createdAt: projectData.createdAt ? new Date(projectData.createdAt) : now,
      updatedAt: now,
    });

    // 11. Create frame records in DB
    if (frameCount > 0) {
      const frameFiles = readdirSync(framesTargetDir)
        .filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f))
        .sort();

      // Read per-frame analysis if available
      let frameAnalysis: Record<string, { ocrText?: string }> = {};
      const framesJsonPath = join(bundleRoot, 'analysis', 'frames.json');
      if (existsSync(framesJsonPath)) {
        try { frameAnalysis = JSON.parse(readFileSync(framesJsonPath, 'utf-8')); } catch { /* ignore */ }
      }

      for (let i = 0; i < frameFiles.length; i++) {
        const frameId = `${projectId}-frame-${i}`;
        const framePath = join(framesTargetDir, frameFiles[i]);
        const frameOcr = frameAnalysis[`frame-${i}`]?.ocrText || null;

        await db.insert(schema.frames).values({
          id: frameId,
          projectId,
          frameNumber: i,
          timestamp: i, // approximate
          imagePath: framePath,
          ocrText: frameOcr,
          isKeyFrame: i === 0,
          createdAt: now,
        });
      }
    }

    return {
      success: true,
      projectId,
      projectName,
      frameCount,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Cleanup temp dir
    if (existsSync(tempDir)) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}
