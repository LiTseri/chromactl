import { Command } from 'commander';
import { resolveConfig, getDbPath } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { createFormatter } from '../lib/output.js';
import type { GlobalOptions, ChromactlConfig } from '../types/index.js';
import path from 'node:path';

function makeServerManager(configPath: string, config: ChromactlConfig): ServerManager {
  const configDir = path.dirname(configPath);
  const dbPath = getDbPath(config, configDir);
  return new ServerManager({
    projectRoot: configDir,
    persistPath: dbPath,
    port: config.port,
    host: config.host,
  });
}

export function registerServerCommand(program: Command): void {
  const server = program
    .command('server')
    .description('Manage the ChromaDB server process');

  server
    .command('start')
    .description('Start the ChromaDB server')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOptions>();
      const fmt = createFormatter(opts);

      const { config, configPath } = resolveConfig({
        db: opts.db,
        requireExisting: true,
      });

      const manager = makeServerManager(configPath, config);
      await manager.ensureRunning();

      const { running, info } = await manager.status();
      if (running && info) {
        if (opts.json) {
          fmt.json({
            status: 'running',
            pid: info.pid,
            port: info.port,
            host: info.host,
          });
        } else {
          fmt.success(
            `ChromaDB server running (PID ${info.pid}, port ${info.port})`,
          );
        }
      }
    });

  server
    .command('stop')
    .description('Stop the ChromaDB server')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOptions>();
      const fmt = createFormatter(opts);

      const { config, configPath } = resolveConfig({
        db: opts.db,
        requireExisting: true,
      });

      const manager = makeServerManager(configPath, config);
      const { running } = await manager.status();

      if (!running) {
        fmt.warn('ChromaDB server is not running.');
        return;
      }

      await manager.stop();
      fmt.success('ChromaDB server stopped.');
    });

  server
    .command('status')
    .description('Show ChromaDB server status')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals<GlobalOptions>();
      const fmt = createFormatter(opts);

      const { config, configPath } = resolveConfig({
        db: opts.db,
        requireExisting: true,
      });

      const manager = makeServerManager(configPath, config);
      const { running, info } = await manager.status();

      if (opts.json) {
        fmt.json({
          running,
          ...(info
            ? {
                pid: info.pid,
                port: info.port,
                host: info.host,
                startedAt: info.startedAt,
              }
            : {}),
        });
      } else if (running && info) {
        fmt.info(`Status: running`);
        fmt.info(`PID: ${info.pid}`);
        fmt.info(`Port: ${info.port}`);
        fmt.info(`Host: ${info.host}`);
        fmt.info(`Started: ${info.startedAt}`);
      } else {
        fmt.info('Status: stopped');
      }
    });
}
