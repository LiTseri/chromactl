import { Command } from 'commander';
import type {
  GlobalOptions,
  SchemaCreateOptions,
  SchemaDefinition,
} from '../types/index.js';
import { resolveConfig, saveConfig } from '../lib/config.js';
import { Formatter } from '../lib/output.js';
import {
  ChromactlError,
  SchemaNotFoundError,
  InvalidArgumentError,
} from '../lib/errors.js';
import { parseSchemaInput } from '../lib/schema-validator.js';

// ---------------------------------------------------------------------------
// Register schema command group
// ---------------------------------------------------------------------------

/**
 * Register the `schema` subcommand group on the top-level program.
 *
 * Subcommands:
 *   schema create <name>  - Create a new metadata schema
 *   schema list           - List all defined schemas
 *   schema show <name>    - Show full schema definition
 *   schema delete <name>  - Delete a schema (if not bound to a collection)
 */
export function registerSchemaCommand(program: Command): void {
  const schemaCmd = program
    .command('schema')
    .description('Manage metadata schemas');

  // --- schema create <name> ---
  schemaCmd
    .command('create')
    .description('Create a new metadata schema')
    .argument('<name>', 'Schema name')
    .option('--fields <json>', 'Schema fields as inline JSON')
    .option('--from-file <path>', 'Read schema from a JSON file')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl schema create article --fields '{"author":{"type":"string","required":true},"year":{"type":"number","required":false}}'
  $ chromactl schema create article --from-file schema.json`,
    )
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<SchemaCreateOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        // Validate mutually exclusive options
        if (opts.fields && opts.fromFile) {
          throw new InvalidArgumentError(
            'Cannot specify both --fields and --from-file.',
            'Use one or the other.',
          );
        }

        if (!opts.fields && !opts.fromFile) {
          throw new InvalidArgumentError(
            'Must specify either --fields or --from-file.',
            "Example: --fields '{\"name\":{\"type\":\"string\",\"required\":true}}'",
          );
        }

        // Parse the schema definition
        const schema: SchemaDefinition = parseSchemaInput({
          fields: opts.fields,
          fromFile: opts.fromFile,
        });

        // Load existing config
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });

        // Check if schema already exists
        if (config.schemas[name]) {
          throw new ChromactlError(
            `Schema '${name}' already exists.`,
            1,
            'Use a different name or delete the existing schema first.',
          );
        }

        // Save the schema
        config.schemas[name] = schema;
        saveConfig(configPath, config);

        const fieldCount = Object.keys(schema.fields).length;
        const requiredCount = Object.values(schema.fields).filter(
          (f) => f.required,
        ).length;

        fmt.verbose(`Config file: ${configPath}`);

        if (fmt.isJson) {
          fmt.json({ name, schema, message: 'Schema created' });
        } else {
          fmt.success(
            `Created schema '${name}' with ${fieldCount} field(s) (${requiredCount} required).`,
          );
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

  // --- schema list ---
  schemaCmd
    .command('list')
    .description('List all defined schemas')
    .action(async (_actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        const { config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });

        const schemaNames = Object.keys(config.schemas);

        if (fmt.isJson) {
          fmt.json(
            schemaNames.map((name) => {
              const schema = config.schemas[name];
              const fieldNames = Object.keys(schema.fields);
              const requiredCount = Object.values(schema.fields).filter(
                (f) => f.required,
              ).length;
              return { name, fields: fieldNames, requiredCount };
            }),
          );
          return;
        }

        if (schemaNames.length === 0) {
          fmt.info('No schemas defined.');
          return;
        }

        const rows: (string | number)[][] = schemaNames.map((name) => {
          const schema = config.schemas[name];
          const fieldNames = Object.keys(schema.fields);
          const requiredCount = Object.values(schema.fields).filter(
            (f) => f.required,
          ).length;
          return [name, fieldNames.join(', '), requiredCount];
        });

        fmt.table(['Name', 'Fields', 'Required Fields'], rows);
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

  // --- schema show <name> ---
  schemaCmd
    .command('show')
    .description('Show details of a schema')
    .argument('<name>', 'Schema name')
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        const { config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });

        const schema = config.schemas[name];
        if (!schema) {
          throw new SchemaNotFoundError(name);
        }

        if (fmt.isJson) {
          fmt.json({ name, ...schema });
        } else {
          fmt.raw(JSON.stringify({ name, ...schema }, null, 2));
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

  // --- schema delete <name> ---
  schemaCmd
    .command('delete')
    .description('Delete a schema (must not be bound to a collection)')
    .argument('<name>', 'Schema name')
    .action(async (name: string, _actionOpts: Record<string, unknown>, cmd: Command) => {
      const opts = cmd.optsWithGlobals<GlobalOptions>();
      const fmt = new Formatter({
        json: opts.json,
        quiet: opts.quiet,
        verbose: opts.verbose,
      });

      try {
        const { configPath, config } = resolveConfig({
          db: opts.db,
          requireExisting: true,
        });

        // Check schema exists
        if (!config.schemas[name]) {
          throw new SchemaNotFoundError(name);
        }

        // Check if schema is bound to any collections
        const boundCollections = Object.entries(config.collectionSchemas)
          .filter(([, schemaName]) => schemaName === name)
          .map(([collectionName]) => collectionName);

        if (boundCollections.length > 0) {
          throw new ChromactlError(
            `Cannot delete schema '${name}': it is bound to collection(s): ${boundCollections.join(', ')}.`,
            1,
            'Remove the schema binding from the collection(s) first.',
          );
        }

        // Delete the schema
        delete config.schemas[name];
        saveConfig(configPath, config);

        if (fmt.isJson) {
          fmt.json({ name, message: 'Schema deleted' });
        } else {
          fmt.success(`Deleted schema '${name}'.`);
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
