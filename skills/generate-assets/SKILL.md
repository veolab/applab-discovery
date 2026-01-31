---
name: generate-assets
description: Generate marketing assets from app screenshots
context: fork
agent: general-purpose
---

# Generate Marketing Assets

Create professional marketing assets from captured app screenshots and recordings.

## Workflow

1. **Select Project**: Use `dlab.project.list` to find project with captures
2. **Review Frames**: Analyze available screenshots and extracted frames
3. **Generate Assets**: Create marketing materials:
   - App Store screenshots with device frames
   - Feature highlight images
   - Social media banners
   - Documentation screenshots
4. **Export**: Use `dlab.project.export` to save final assets

## Asset Types

### App Store Screenshots
- iPhone/iPad device frames
- Android device frames
- Custom backgrounds and captions

### Marketing Materials
- Feature spotlights
- Before/after comparisons
- UI walkthrough sequences

### Documentation
- User guide screenshots
- Help center images
- Release notes visuals

## Integration

- Export to Notion with `dlab.notion.export`
- Upload to Google Drive with `dlab.drive.upload`
- Attach to Jira tickets with `dlab.jira.attach`
