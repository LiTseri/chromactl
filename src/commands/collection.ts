import { Command } from 'commander';
import path from 'node:path';
import type {
  GlobalOptions,
  CollectionCreateOptions,
  CollectionDeleteOptions,
} from '../types/index.js';
import { resolveConfig, saveConfig, getDbPath } from '../lib/config.js';
import { Formatter } from '../lib/output.js';
import {
  ChromactlError,
  SchemaNotFoundError,
  CollectionNotFoundError,
  InvalidArgumentError,
} from '../lib/errors.js';
import { ServerManager } from '../lib/server.js';
import { noopEmbeddingFunction } from '../lib/db.js';

// ---------------------------------------------------------------------------
// Register collection command group
// ---------------------------------------------------------------------------

/**
 * Register the `collection` subcommand group on the top-level program.
 *
 * Subcommands:
 *   collection create <name>  - Create a new ChromaDB collection
 *   collection list           - List all collections with document counts
 *   collection delete <name>  - Delete a collection (requires --confirm)
 *   collection info <name>    - Show detailed collection information
 */
export function registerCollectionCommand(program: Command): void {
  const collectionCmd = program
    .command('collection')
    .description('Manage ChromaDB collections');

  // --- collection create <name> ---
  collectionCmd
    .command('create')
    .description('Create a new collection')
    .argument('<name>', 'Collection name')
    .option('--schema <name>', 'Associate a metadata schema')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl collection create papers
  $ chromactl collection create papers --schema article`,
    )
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<CollectionCreateOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Load config
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });
        const configDir = path.dirname(configPath);

        // If --schema is specified, validate it exists
        if (opts.schema) {
          if (!config.schemas[opts.schema]) {
            throw new SchemaNotFoundError(opts.schema);
          }
        }

        // Start server and get client
        const dbPath = getDbPath(config, configDir);
        const serverManager = new ServerManager({
          projectRoot: configDir,
          persistPath: dbPath,
          port: config.port,
          host: config.host,
        });

        fmt.verbose('Ensuring ChromaDB server is running...');
        const client = await serverManager.ensureRunning();

        // Create the collection
        fmt.verbose(`Creating collection '${name}'...`);
        try {
          await client.createCollection({ name });
        } catch (error) {
          // Check if it's a "collection already exists" error
          const msg = error instanceof Error ? error.message : String(error);
          if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('unique constraint')) {
            throw new ChromactlError(
              `Collection '${name}' already exists.`,
              1,
              'Use a different name or delete the existing collection first.',
            );
          }
          throw error;
        }

        // If --schema, save the binding to config
        if (opts.schema) {
          config.collectionSchemas[name] = opts.schema;
          saveConfig(configPath, config);
          fmt.verbose(`Bound schema '${opts.schema}' to collection '${name}'.`);
        }

        if (fmt.isJson) {
          fmt.json({
            name,
            schema: opts.schema ?? null,
            message: 'Collection created',
          });
        } else {
          const schemaInfo = opts.schema
            ? ` with schema '${opts.schema}'`
            : '';
          fmt.success(`Created collection '${name}'${schemaInfo}.`);
        }
      } catch (error) {
        if (error instanceof ChromactlError) {
          fmt.error(error.message);
          if (error.hint) {
            fmt.info(`Hint: ${error.hint}`);
          }
          process.exit(error.exitCode);
        }
        if (error instanceof Error) {
          fmt.error(error.message);
        } else {
          fmt.error(String(error));
        }
        process.exit(1);
      }
    });

  // --- collection list ---
  collectionCmd
    .command('list')
    .description('List all collections with document counts')
    .action(async (_actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Load config
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });
        const configDir = path.dirname(configPath);

        // Start server and get client
        const dbPath = getDbPath(config, configDir);
        const serverManager = new ServerManager({
          projectRoot: configDir,
          persistPath: dbPath,
          port: config.port,
          host: config.host,
        });

        fmt.verbose('Ensuring ChromaDB server is running...');
        const client = await serverManager.ensureRunning();

        // List collections
        const collectionNames = await client.listCollections();

        if (fmt.isJson) {
          const results: Array<{ name: string; documents: number; schema: string | null }> = [];
          for (const collName of collectionNames) {
            const coll = await client.getCollection({ name: collName, embeddingFunction: noopEmbeddingFunction });
            const count = await coll.count();
            const schema = config.collectionSchemas[collName] ?? null;
            results.push({ name: collName, documents: count, schema });
          }
          fmt.json(results);
          return;
        }

        if (collectionNames.length === 0) {
          fmt.info('No collections found.');
          return;
        }

        const rows: (string | number)[][] = [];
        for (const collName of collectionNames) {
          const coll = await client.getCollection({ name: collName, embeddingFunction: noopEmbeddingFunction });
          const count = await coll.count();
          const schema = config.collectionSchemas[collName] ?? '-';
          rows.push([collName, count, schema]);
        }

        fmt.table(['Name', 'Documents', 'Schema'], rows);
      } catch (error) {
        if (error instanceof ChromactlError) {
          fmt.error(error.message);
          if (error.hint) {
            fmt.info(`Hint: ${error.hint}`);
          }
          process.exit(error.exitCode);
        }
        if (error instanceof Error) {
          fmt.error(error.message);
        } else {
          fmt.error(String(error));
        }
        process.exit(1);
      }
    });

  // --- collection delete <name> ---
  collectionCmd
    .command('delete')
    .description('Delete a collection and all its documents')
    .argument('<name>', 'Collection name')
    .option('--confirm', 'Confirm deletion (required)')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl collection delete papers --confirm`,
    )
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<CollectionDeleteOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Require --confirm flag
        if (!opts.confirm) {
          throw new InvalidArgumentError(
            'Deletion requires the --confirm flag.',
            `Run: chromactl collection delete ${name} --confirm`,
          );
        }

        // Load config
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });
        const configDir = path.dirname(configPath);

        // Start server and get client
        const dbPath = getDbPath(config, configDir);
        const serverManager = new ServerManager({
          projectRoot: configDir,
          persistPath: dbPath,
          port: config.port,
          host: config.host,
        });

        fmt.verbose('Ensuring ChromaDB server is running...');
        const client = await serverManager.ensureRunning();

        // Delete the collection
        fmt.verbose(`Deleting collection '${name}'...`);
        try {
          await client.deleteCollection({ name });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            msg.toLowerCase().includes('not found') ||
            msg.toLowerCase().includes('does not exist')
          ) {
            throw new CollectionNotFoundError(name);
          }
          throw error;
        }

        // Remove schema binding from config if exists
        if (config.collectionSchemas[name]) {
          fmt.verbose(
            `Removing schema binding '${config.collectionSchemas[name]}' from collection '${name}'.`,
          );
          delete config.collectionSchemas[name];
          saveConfig(configPath, config);
        }

        if (fmt.isJson) {
          fmt.json({ name, message: 'Collection deleted' });
        } else {
          fmt.success(`Deleted collection '${name}'.`);
        }
      } catch (error) {
        if (error instanceof ChromactlError) {
          fmt.error(error.message);
          if (error.hint) {
            fmt.info(`Hint: ${error.hint}`);
          }
          process.exit(error.exitCode);
        }
        if (error instanceof Error) {
          fmt.error(error.message);
        } else {
          fmt.error(String(error));
        }
        process.exit(1);
      }
    });

  // --- collection info <name> ---
  collectionCmd
    .command('info')
    .description('Show detailed collection information')
    .argument('<name>', 'Collection name')
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Load config
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });
        const configDir = path.dirname(configPath);

        // Start server and get client
        const dbPath = getDbPath(config, configDir);
        const serverManager = new ServerManager({
          projectRoot: configDir,
          persistPath: dbPath,
          port: config.port,
          host: config.host,
        });

        fmt.verbose('Ensuring ChromaDB server is running...');
        const client = await serverManager.ensureRunning();

        // Get collection
        let collection;
        try {
          collection = await client.getCollection({ name, embeddingFunction: noopEmbeddingFunction });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          if (
            msg.toLowerCase().includes('not found') ||
            msg.toLowerCase().includes('does not exist')
          ) {
            throw new CollectionNotFoundError(name);
          }
          throw error;
        }

        const count = await collection.count();
        const schema = config.collectionSchemas[name] ?? null;
        const metadata = collection.metadata ?? {};

        if (fmt.isJson) {
          fmt.json({
            name: collection.name,
            id: collection.id,
            documents: count,
            schema,
            metadata,
          });
        } else {
          fmt.info(`Collection: ${collection.name}`);
          fmt.info(`ID:         ${collection.id}`);
          fmt.info(`Documents:  ${count}`);
          fmt.info(`Schema:     ${schema ?? 'none'}`);
          fmt.info(`Metadata:   ${Object.keys(metadata).length > 0 ? JSON.stringify(metadata, null, 2) : 'none'}`);
        }
      } catch (error) {
        if (error instanceof ChromactlError) {
          fmt.error(error.message);
          if (error.hint) {
            fmt.info(`Hint: ${error.hint}`);
          }
          process.exit(error.exitCode);
        }
        if (error instanceof Error) {
          fmt.error(error.message);
        } else {
          fmt.error(String(error));
        }
        process.exit(1);
      }
    });
}
