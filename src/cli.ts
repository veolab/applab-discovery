#!/usr/bin/env node
/**
 * DiscoveryLab CLI
 * Command-line interface for the DiscoveryLab plugin
 */

import { Command } from 'commander';
import chalk from 'chalk';
import open from 'open';

const program = new Command();

// ============================================================================
// CLI CONFIGURATION
// ============================================================================
program
  .name('discoverylab')
  .description('AI-powered app testing & evidence generator - Claude Code Plugin')
  .version('0.1.0');

// ============================================================================
// SERVE COMMAND
// ============================================================================
program
  .command('serve')
  .description('Start the DiscoveryLab web UI server')
  .option('-p, --port <number>', 'Port to listen on', '3847')
  .option('-o, --open', 'Open browser automatically', false)
  .action(async (options) => {
    const port = parseInt(options.port, 10);

    console.log(chalk.cyan('\n  DiscoveryLab'));
    console.log(chalk.gray('  AI-powered app testing & evidence generator\n'));

    try {
      // Import server dynamically to avoid loading everything at startup
      const { startServer } = await import('./web/server.js');
      await startServer(port);

      console.log(chalk.green(`  Server running at http://localhost:${port}`));
      console.log(chalk.gray('  Press Ctrl+C to stop\n'));

      if (options.open) {
        await open(`http://localhost:${port}`);
      }
    } catch (error) {
      console.error(chalk.red(`  Failed to start server: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// SETUP COMMAND
// ============================================================================
program
  .command('setup')
  .description('Check and configure DiscoveryLab dependencies')
  .action(async () => {
    console.log(chalk.cyan('\n  DiscoveryLab Setup\n'));

    try {
      const { setupStatusTool } = await import('./mcp/tools/setup.js');
      const result = await setupStatusTool.handler({});

      if (result.isError) {
        console.error(chalk.red('  Setup check failed'));
        return;
      }

      const data = JSON.parse(result.content[0].text!);

      // Show platform
      console.log(chalk.gray(`  Platform: ${data.platform}`));
      console.log(chalk.gray(`  Data directory: ${data.dataDirectory.path}`));
      console.log();

      // Show dependencies
      console.log(chalk.white('  Dependencies:'));
      for (const dep of data.dependencies) {
        const status = dep.installed
          ? chalk.green(`  ${dep.name} ${dep.version}`)
          : chalk.red(`  ${dep.name} (not installed)`);

        const required = dep.required ? chalk.yellow(' [required]') : chalk.gray(' [optional]');
        console.log(`${status}${required}`);

        if (!dep.installed && dep.installHint) {
          console.log(chalk.gray(`     Install: ${dep.installHint}`));
        }
      }

      console.log();

      // Summary
      if (data.ready) {
        console.log(chalk.green('  Ready to use!'));
        console.log(chalk.gray('  Run: discoverylab serve'));
      } else {
        console.log(chalk.yellow('  Some required dependencies are missing.'));
        console.log(chalk.gray('  Install them and run setup again.'));
      }

      console.log();
    } catch (error) {
      console.error(chalk.red(`  Setup failed: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// INIT COMMAND
// ============================================================================
program
  .command('init')
  .description('Initialize DiscoveryLab data directories')
  .action(async () => {
    console.log(chalk.cyan('\n  Initializing DiscoveryLab...\n'));

    try {
      const { getDatabase, DATA_DIR, PROJECTS_DIR, EXPORTS_DIR } = await import('./db/index.js');
      getDatabase(); // This creates directories and tables

      console.log(chalk.green('  Created directories:'));
      console.log(chalk.gray(`    ${DATA_DIR}`));
      console.log(chalk.gray(`    ${PROJECTS_DIR}`));
      console.log(chalk.gray(`    ${EXPORTS_DIR}`));
      console.log();
      console.log(chalk.green('  Database initialized successfully!'));
      console.log();
    } catch (error) {
      console.error(chalk.red(`  Initialization failed: ${error}`));
      process.exit(1);
    }
  });

// ============================================================================
// MCP COMMAND (for Claude Code integration)
// ============================================================================
program
  .command('mcp')
  .description('Run as MCP server (for Claude Code integration)')
  .action(async () => {
    try {
      // Initialize database first
      const { getDatabase } = await import('./db/index.js');
      getDatabase();

      // Import and start MCP server
      const { mcpServer } = await import('./mcp/server.js');
      const { uiTools, projectTools, setupTools, captureTools, analyzeTools, canvasTools, exportTools, testingTools, integrationTools } = await import('./mcp/tools/index.js');

      // Register all tools
      mcpServer.registerTools([
        ...uiTools,
        ...projectTools,
        ...setupTools,
        ...captureTools,
        ...analyzeTools,
        ...canvasTools,
        ...exportTools,
        ...testingTools,
        ...integrationTools,
      ]);

      // Start STDIO transport
      await mcpServer.runStdio();
    } catch (error) {
      console.error(`MCP server error: ${error}`);
      process.exit(1);
    }
  });

// ============================================================================
// VERSION INFO
// ============================================================================
program
  .command('info')
  .description('Show version and configuration info')
  .action(async () => {
    console.log(chalk.cyan('\n  DiscoveryLab v0.1.0\n'));
    console.log(chalk.gray('  AI-powered app testing & evidence generator'));
    console.log(chalk.gray('  Claude Code Plugin\n'));

    try {
      const { DATA_DIR, DB_PATH } = await import('./db/index.js');
      console.log(chalk.white('  Paths:'));
      console.log(chalk.gray(`    Data: ${DATA_DIR}`));
      console.log(chalk.gray(`    Database: ${DB_PATH}`));
      console.log();
    } catch {
      console.log(chalk.gray('  (Database not initialized)'));
      console.log();
    }
  });

// ============================================================================
// PARSE ARGS
// ============================================================================
program.parse();

// If no command provided, show help
if (!process.argv.slice(2).length) {
  program.outputHelp();
}
