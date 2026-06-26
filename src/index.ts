import { Command } from 'commander';
import { ChromactlError } from './lib/errors.js';

const program = new Command()
  .name('chromactl')
  .description('ChromaDB CLI management tool')
  .version('0.1.0')
  .option('--db <path>', 'Override database directory path')
  .option('-v, --verbose', 'Enable verbose output')
  .option('-q, --quiet', 'Suppress non-essential output')
  .option('--json', 'Output as JSON');

import { registerInitCommand } from './commands/init.js';
import { registerSchemaCommand } from './commands/schema.js';
import { registerCollectionCommand } from './commands/collection.js';
import { registerIndexCommand } from './commands/index-cmd.js';
import { registerSearchCommand } from './commands/search.js';
import { registerStatsCommand } from './commands/stats.js';
import { registerServerCommand } from './commands/server.js';

registerInitCommand(program);
registerSchemaCommand(program);
registerCollectionCommand(program);
registerIndexCommand(program);
registerSearchCommand(program);
registerStatsCommand(program);
registerServerCommand(program);

program.hook('preAction', () => {
  // Placeholder for global pre-action logic (e.g. telemetry)
});

process.on('uncaughtException', (err) => {
  if (err instanceof ChromactlError) {
    console.error(`Error: ${err.message}`);
    if (err.hint) {
      console.error(`Hint: ${err.hint}`);
    }
    process.exit(err.exitCode);
  }
  console.error(`Unexpected error: ${err.message}`);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  if (reason instanceof ChromactlError) {
    console.error(`Error: ${reason.message}`);
    if (reason.hint) {
      console.error(`Hint: ${reason.hint}`);
    }
    process.exit(reason.exitCode);
  }
  console.error(`Unexpected error: ${reason}`);
  process.exit(1);
});

program.parseAsync(process.argv).catch((err) => {
  if (err instanceof ChromactlError) {
    console.error(`Error: ${err.message}`);
    if (err.hint) {
      console.error(`Hint: ${err.hint}`);
    }
    process.exit(err.exitCode);
  }
  console.error(`Error: ${err.message || err}`);
  process.exit(1);
});
