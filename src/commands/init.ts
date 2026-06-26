import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { InitOptions } from '../types/index.js';
import {
  getDefaultConfig,
  saveConfig,
  getDbPath,
} from '../lib/config.js';
import { Formatter } from '../lib/output.js';

/**
 * Register the `init` subcommand on the top-level program.
 *
 * `chromactl init [path]`
 *   - Creates .chromactl directory and chromactl.json at the specified path (or cwd)
 *   - Default dbPath: .chromactl/chroma-data
 *   - Creates the data directory structure
 *   - If config already exists: warn and exit with code 1 (unless --force)
 *   - --force: reinitialize (overwrite existing config)
 *   - Print success message with the database path
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Initialize a new chromactl database')
    .argument('[path]', 'Directory to initialize (default: current directory)')
    .option('--force', 'Reinitialize if database already exists')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl init
  $ chromactl init /tmp/mydb
  $ chromactl init --force`,
    )
    .action(async (targetPath: string | undefined, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<InitOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Determine the target directory.
        // Priority: positional arg > --db flag > cwd
        const baseDir = targetPath
          ? path.resolve(targetPath)
          : opts.db
            ? path.resolve(opts.db)
            : process.cwd();

        const configPath = path.join(baseDir, 'chromactl.json');

        // Check if config already exists
        const exactConfigExists = fs.existsSync(configPath);

        if (exactConfigExists && !opts.force) {
          fmt.warn(`A chromactl database already exists at ${configPath}`);
          fmt.info('Use --force to reinitialize.');
          process.exit(1);
        }

        // Create the default config
        const config = getDefaultConfig();

        // Resolve the database path (relative to config directory)
        const configDir = path.dirname(configPath);
        const dbPath = getDbPath(config, configDir);

        // Create directory structure
        // .chromactl/chroma-data/
        // .chromactl/models/
        fs.mkdirSync(dbPath, { recursive: true });
        fs.mkdirSync(path.join(configDir, '.chromactl', 'models'), {
          recursive: true,
        });

        // Write the config file
        saveConfig(configPath, config);

        fmt.verbose(`Config file: ${configPath}`);
        fmt.verbose(`Database path: ${dbPath}`);

        if (fmt.isJson) {
          fmt.json({
            configPath,
            dbPath,
            message: 'Initialized chromactl database',
          });
        } else {
          fmt.success(`Initialized chromactl database at ${configPath}`);
          fmt.info(`Database path: ${dbPath}`);
        }
      } catch (error) {
        if (error instanceof Error) {
          fmt.error(error.message);
        } else {
          fmt.error(String(error));
        }
        process.exit(1);
      }
    });
}
