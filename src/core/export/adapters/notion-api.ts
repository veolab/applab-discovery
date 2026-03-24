/**
 * Notion API Adapter
 * Creates rich Notion pages using the REST API for structure
 * and Playwright for file uploads (hybrid approach).
 *
 * Notion API requires externally accessible URLs for images,
 * but our server is localhost. So we:
 * 1. Create page structure via REST API (headings, text, callouts, dividers)
 * 2. Upload images/files via Playwright to the created page
 */

import type { ExportDocument, DocumentSection } from '../document.js';

export interface NotionApiConfig {
  token: string;
  parentPageId: string;
}

export interface NotionPageResult {
  success: boolean;
  pageId?: string;
  pageUrl?: string;
  error?: string;
}

// ============================================================================
// NOTION BLOCK BUILDERS
// ============================================================================

function richText(text: string): Array<{ type: 'text'; text: { content: string } }> {
  // Notion has 2000 char limit per rich text element
  const chunks: Array<{ type: 'text'; text: { content: string } }> = [];
  for (let i = 0; i < text.length; i += 2000) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + 2000) } });
  }
  return chunks.length ? chunks : [{ type: 'text', text: { content: '' } }];
}

function linkRichText(label: string, url: string): { type: 'text'; text: { content: string; link: { url: string } } } {
  return { type: 'text', text: { content: label, link: { url } } };
}

/**
 * Convert a DocumentSection to Notion API block(s).
 * Returns array since some sections map to multiple blocks.
 * Image/video/file sections return placeholder blocks - actual files
 * are uploaded via Playwright in a second pass.
 */
function sectionToNotionBlocks(section: DocumentSection): object[] {
  switch (section.type) {
    case 'heading':
      const headingType = section.level === 1 ? 'heading_1' : section.level === 2 ? 'heading_2' : 'heading_3';
      return [{ object: 'block', type: headingType, [headingType]: { rich_text: richText(section.text) } }];

    case 'paragraph':
      return [{ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(section.text) } }];

    case 'divider':
      return [{ object: 'block', type: 'divider', divider: {} }];

    case 'callout':
      return [{
        object: 'block',
        type: 'callout',
        callout: {
          rich_text: richText(section.text),
          color: (section.color || 'purple') + '_background',
          icon: { type: 'emoji', emoji: '📱' },
        },
      }];

    case 'links': {
      // Render links as a bulleted list with hyperlinks
      return section.items.map(link => ({
        object: 'block',
        type: 'bulleted_list_item',
        bulleted_list_item: {
          rich_text: [linkRichText(`${link.label}`, link.url)],
        },
      }));
    }

    case 'image-gallery': {
      // Each selected image becomes a separate image block
      // Notion auto-groups consecutive images visually
      // Actual upload happens via Playwright - add paragraph placeholders
      const selectedImages = section.images.filter(img => img.selected !== false);
      return selectedImages.map((img, i) => ({
        object: 'block',
        type: 'paragraph',
        paragraph: {
          rich_text: richText(`[Image: ${img.caption || `Screen ${i + 1}`}]`),
        },
        _fileUpload: { path: img.path, type: 'image' },
      }));
    }

    case 'image':
      return [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richText(`[Image: ${section.caption || 'image'}]`) },
        _fileUpload: { path: section.path, type: 'image' },
      }];

    case 'video':
      return [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richText('[Video]') },
        _fileUpload: { path: section.path, type: 'video' },
      }];

    case 'gif':
      return [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richText(`[Interactive: ${section.caption || section.templateId || 'animation'}]`) },
        _fileUpload: { path: section.path, type: 'image' },
      }];

    case 'grid':
      return [{
        object: 'block',
        type: 'paragraph',
        paragraph: { rich_text: richText('[Grid composition]') },
        _fileUpload: { path: section.path, type: 'image' },
      }];

    case 'markdown': {
      // Convert markdown to paragraphs (simplified)
      const blocks: object[] = [];

      if (section.collapsible && section.label) {
        // Use toggle block for collapsible content
        const lines = section.content.split('\n').filter(l => l.trim());
        const children = lines.slice(0, 20).map(line => {
          if (line.startsWith('## ')) {
            return { object: 'block', type: 'heading_3', heading_3: { rich_text: richText(line.replace(/^##\s+/, '')) } };
          }
          if (line.startsWith('- ')) {
            return { object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(line.replace(/^-\s+/, '')) } };
          }
          return { object: 'block', type: 'paragraph', paragraph: { rich_text: richText(line) } };
        });

        blocks.push({
          object: 'block',
          type: 'toggle',
          toggle: {
            rich_text: richText(section.label),
            children: children.slice(0, 100), // Notion limit
          },
        });
      } else {
        // Flat paragraphs
        const lines = section.content.split('\n').filter(l => l.trim());
        for (const line of lines.slice(0, 50)) {
          if (line.startsWith('## ')) {
            blocks.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: richText(line.replace(/^##\s+/, '')) } });
          } else if (line.startsWith('### ')) {
            blocks.push({ object: 'block', type: 'heading_3', heading_3: { rich_text: richText(line.replace(/^###\s+/, '')) } });
          } else if (line.startsWith('- ')) {
            blocks.push({ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: richText(line.replace(/^-\s+/, '')) } });
          } else {
            blocks.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: richText(line) } });
          }
        }
      }

      return blocks;
    }

    default:
      return [];
  }
}

// ============================================================================
// PAGE CREATION
// ============================================================================

/**
 * Create a Notion page with rich content using the REST API.
 * Returns the page ID and URL. File uploads are handled separately.
 */
export async function createNotionPageViaApi(
  document: ExportDocument,
  config: NotionApiConfig,
): Promise<NotionPageResult> {
  try {
    // Build all blocks from document sections
    const allBlocks: object[] = [];
    const fileUploads: Array<{ blockIndex: number; path: string; type: string }> = [];

    for (const section of document.sections) {
      const blocks = sectionToNotionBlocks(section);
      for (const block of blocks) {
        const idx = allBlocks.length;
        if ((block as any)._fileUpload) {
          fileUploads.push({ blockIndex: idx, ...(block as any)._fileUpload });
          delete (block as any)._fileUpload;
        }
        allBlocks.push(block);
      }
    }

    // Notion API limits children to 100 blocks per request
    const firstBatch = allBlocks.slice(0, 100);

    // Create page
    const createResponse = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { page_id: config.parentPageId },
        properties: {
          title: {
            title: [{ type: 'text', text: { content: document.title } }],
          },
        },
        children: firstBatch,
      }),
    });

    if (!createResponse.ok) {
      const err = await createResponse.text();
      return { success: false, error: `Notion API error (${createResponse.status}): ${err.slice(0, 300)}` };
    }

    const pageData = await createResponse.json() as { id: string; url: string };

    // Append remaining blocks if more than 100
    if (allBlocks.length > 100) {
      for (let i = 100; i < allBlocks.length; i += 100) {
        const batch = allBlocks.slice(i, i + 100);
        await fetch(`https://api.notion.com/v1/blocks/${pageData.id}/children`, {
          method: 'PATCH',
          headers: {
            'Authorization': `Bearer ${config.token}`,
            'Notion-Version': '2022-06-28',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ children: batch }),
        });
      }
    }

    return {
      success: true,
      pageId: pageData.id,
      pageUrl: pageData.url,
      _fileUploads: fileUploads,
    } as NotionPageResult & { _fileUploads: typeof fileUploads };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
