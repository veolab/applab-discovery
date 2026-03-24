/**
 * Export Document Model
 * Destination-agnostic intermediate format for rich document export.
 * Each destination adapter (Notion, Linear, Craft, Google Docs) converts
 * this to its native block/element format.
 */

// ============================================================================
// SECTION TYPES
// ============================================================================

export interface HeadingSection {
  type: 'heading';
  level: 1 | 2 | 3;
  text: string;
}

export interface ParagraphSection {
  type: 'paragraph';
  text: string;
}

export interface DividerSection {
  type: 'divider';
}

export interface CalloutSection {
  type: 'callout';
  text: string;
  color?: string;
}

export interface LinksSection {
  type: 'links';
  items: Array<{
    label: string;
    url: string;
    linkType: string; // 'jira' | 'figma' | 'notion' | 'github' | 'other'
  }>;
}

export interface ImageGallerySection {
  type: 'image-gallery';
  images: Array<{
    path: string;
    caption?: string;
    selected?: boolean;
  }>;
}

export interface ImageSection {
  type: 'image';
  path: string;
  caption?: string;
}

export interface VideoSection {
  type: 'video';
  path: string;
  duration?: number;
}

export interface GifSection {
  type: 'gif';
  path: string;
  caption?: string;
  templateId?: string; // 'flow-diagram' | 'device-showcase' | 'metrics-dashboard'
}

export interface GridSection {
  type: 'grid';
  path: string; // pre-composed grid PNG
}

export interface MarkdownSection {
  type: 'markdown';
  content: string;
  collapsible?: boolean;
  label?: string;
}

export type DocumentSection =
  | HeadingSection
  | ParagraphSection
  | DividerSection
  | CalloutSection
  | LinksSection
  | ImageGallerySection
  | ImageSection
  | VideoSection
  | GifSection
  | GridSection
  | MarkdownSection;

// ============================================================================
// DOCUMENT
// ============================================================================

export interface ExportDocument {
  title: string;
  subtitle?: string;
  sections: DocumentSection[];
  metadata?: {
    projectId?: string;
    platform?: string;
    createdAt?: string;
  };
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Build a default document from project data.
 * Includes all available sections; UI allows toggling/reordering.
 */
export function buildDefaultDocument(project: {
  id: string;
  name: string;
  marketingTitle?: string | null;
  marketingDescription?: string | null;
  platform?: string | null;
  aiSummary?: string | null;
  videoPath?: string | null;
  thumbnailPath?: string | null;
  taskHubLinks?: string | null;
  frames?: Array<{ imagePath: string; ocrText?: string | null }>;
  duration?: number | null;
  templateRenderPath?: string | null; // cached template render video
}): ExportDocument {
  const sections: DocumentSection[] = [];
  const title = project.marketingTitle || project.name;

  // Header callout
  sections.push({
    type: 'callout',
    text: title,
    color: 'purple',
  });

  // Description
  if (project.marketingDescription) {
    sections.push({
      type: 'paragraph',
      text: project.marketingDescription,
    });
  }

  // Links (Jira, Figma, etc.)
  let links: Array<{ label: string; url: string; linkType: string }> = [];
  if (project.taskHubLinks) {
    try {
      const parsed = JSON.parse(project.taskHubLinks) as Array<{
        type: string; url: string; title?: string;
      }>;
      links = parsed.map(l => ({
        label: l.title || l.url,
        url: l.url,
        linkType: l.type || 'other',
      }));
    } catch { /* ignore */ }
  }
  if (links.length > 0) {
    sections.push({ type: 'links', items: links });
  }

  sections.push({ type: 'divider' });

  // Screenshots gallery
  if (project.frames && project.frames.length > 0) {
    sections.push({
      type: 'image-gallery',
      images: project.frames.map((f, i) => ({
        path: f.imagePath,
        caption: f.ocrText?.slice(0, 40) || `Screen ${i + 1}`,
        selected: true,
      })),
    });
  }

  // Video - prefer template render if available, keep original as source
  if (project.templateRenderPath) {
    sections.push({
      type: 'video',
      path: project.templateRenderPath,
      duration: project.duration || undefined,
    });
  } else if (project.videoPath) {
    sections.push({
      type: 'video',
      path: project.videoPath,
      duration: project.duration || undefined,
    });
  }

  // Interactive visualization (GIF)
  if (project.frames && project.frames.length > 0) {
    sections.push({
      type: 'gif',
      path: '', // generated on export
      caption: 'Flow Diagram',
      templateId: 'flow-diagram',
    });
  }

  // Analysis
  if (project.aiSummary) {
    sections.push({ type: 'divider' });
    sections.push({
      type: 'markdown',
      content: project.aiSummary,
      collapsible: true,
      label: 'App Intelligence',
    });
  }

  return {
    title,
    subtitle: project.marketingDescription || undefined,
    sections,
    metadata: {
      projectId: project.id,
      platform: project.platform || undefined,
    },
  };
}

/**
 * Get section type display info for UI
 */
export function getSectionTypeInfo(type: DocumentSection['type']): { label: string; description: string } {
  const info: Record<string, { label: string; description: string }> = {
    'heading': { label: 'Heading', description: 'Section title' },
    'paragraph': { label: 'Description', description: 'Text content' },
    'divider': { label: 'Divider', description: 'Horizontal line' },
    'callout': { label: 'Header', description: 'Highlighted title block' },
    'links': { label: 'Links', description: 'External references' },
    'image-gallery': { label: 'Screenshots', description: 'Select frames to include' },
    'image': { label: 'Image', description: 'Single image' },
    'video': { label: 'Video', description: 'Recording file' },
    'gif': { label: 'Interactive', description: 'Animated visualization' },
    'grid': { label: 'Grid', description: 'Composed screenshot grid' },
    'markdown': { label: 'Analysis', description: 'App Intelligence report' },
  };
  return info[type] || { label: type, description: '' };
}
