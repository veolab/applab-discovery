/**
 * DiscoveryLab MCP Tools Index
 * Exports all available tools for registration
 */

export { uiTools } from './ui.js';
export { projectTools } from './project.js';
export { setupTools } from './setup.js';
export { captureTools } from './capture.js';
export { analyzeTools } from './analyze.js';
export { canvasTools } from './canvas.js';
export { exportTools } from './export.js';
export { testingTools } from './testing.js';
export { integrationTools } from './integrations.js';
export { taskHubTools } from './taskhub.js';

// Re-export individual tools if needed
export { uiOpenTool, uiStatusTool } from './ui.js';
export { projectListTool, projectCreateTool, projectGetTool, projectSaveTool, projectDeleteTool } from './project.js';
export { setupStatusTool, setupCheckTool, setupInitTool } from './setup.js';
export {
  captureScreenTool,
  startRecordingTool,
  stopRecordingTool,
  captureEmulatorTool,
  listEmulatorsTool,
} from './capture.js';
export {
  analyzeVideoTool,
  analyzeScreenshotTool,
  extractFramesTool,
  videoInfoTool,
} from './analyze.js';
export {
  canvasDevicesTool,
  canvasPresetsTool,
  canvasCreateTool,
  canvasCompareTool,
  canvasSvgTool,
  canvasHtmlTool,
} from './canvas.js';
export {
  exportVideoTool,
  exportGifTool,
  exportThumbnailTool,
  exportTrimTool,
  exportConcatTool,
  exportImageTool,
  exportBatchTool,
  exportMockupsTool,
  exportInfoTool,
  exportClipboardTool,
  exportRevealTool,
  exportSequenceTool,
} from './export.js';
export {
  maestroStatusTool,
  maestroRunTool,
  maestroStudioTool,
  maestroGenerateTool,
  playwrightStatusTool,
  playwrightRunTool,
  playwrightCodegenTool,
  playwrightGenerateTool,
  playwrightReportTool,
  playwrightInstallTool,
  playwrightDevicesTool,
  testDevicesTool,
} from './testing.js';
export {
  notionStatusTool,
  notionLoginTool,
  notionExportTool,
  notionQuickExportTool,
  driveStatusTool,
  driveLoginTool,
  driveUploadTool,
  driveQuickExportTool,
  driveFolderTool,
  jiraStatusTool,
  jiraLoginTool,
  jiraAttachTool,
  jiraCreateTool,
  jiraCommentTool,
  jiraQuickExportTool,
  exportToTool,
} from './integrations.js';
export {
  taskHubLinksListTool,
  taskHubLinksAddTool,
  taskHubLinksRemoveTool,
  taskHubMetadataFetchTool,
  taskHubGenerateTool,
  taskHubRequirementsGetTool,
  taskHubTestMapGetTool,
  taskHubTestMapToggleTool,
} from './taskhub.js';
