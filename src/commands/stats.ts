import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { ChromaClient, IncludeEnum } from 'chromadb';

import type {
  GlobalOptions,
  DatabaseStats,
  CollectionStats,
  ChromactlConfig,
} from '../types/index.js';
import { Formatter, createFormatter } from '../lib/output.js';
import { resolveConfig, getDbPath, getProjectDir } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { CollectionNotFoundError } from '../lib/errors.js';
import { noopEmbeddingFunction } from '../lib/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve command context: config, server, formatter.
 */
async function resolveCommandContext(
  cmd: Command,
): Promise<{
  formatter: Formatter;
  client: ChromaClient;
  config: ChromactlConfig;
  configPath: string;
  projectDir: string;
}> {
  const opts = cmd.optsWithGlobals<GlobalOptions>();
  const formatter = createFormatter({
    json: opts.json,
    quiet: opts.quiet,
    verbose: opts.verbose,
  });

  const { configPath, config } = resolveConfig({
    db: opts.db,
    requireExisting: true,
  });

  const configDir = path.dirname(configPath);
  const projectDir = getProjectDir(configPath);

  const serverManager = new ServerManager({
    projectRoot: configDir,
    persistPath: getDbPath(config, configDir),
    port: config.port,
    host: config.host,
  });

  const client = await serverManager.ensureRunning();

  return { formatter, client, config, configPath, projectDir };
}

/**
 * Calculate the total size of a directory recursively.
 */
function getDirectorySizeSync(dirPath: string): number {
  let totalSize = 0;

  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          totalSize += stat.size;
        } catch {
          // Skip unreadable files
        }
      } else if (entry.isDirectory()) {
        totalSize += getDirectorySizeSync(fullPath);
      }
    }
  } catch {
    // Directory may not exist or not be readable
  }

  return totalSize;
}

/**
 * Format bytes into a human-readable string.
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const k = 1024;
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);

  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ---------------------------------------------------------------------------
// Stats Action
// ---------------------------------------------------------------------------

async function statsAction(
  collectionName: string | undefined,
  _options: GlobalOptions,
  cmd: Command,
): Promise<void> {
  const { formatter, client, config, projectDir } = await resolveCommandContext(cmd);

  if (collectionName) {
    await showCollectionStats(formatter, client, config, collectionName);
  } else {
    await showDatabaseStats(formatter, client, projectDir);
  }
}

// ---------------------------------------------------------------------------
// Database-Level Stats
// ---------------------------------------------------------------------------

async function showDatabaseStats(
  formatter: Formatter,
  client: ChromaClient,
  projectDir: string,
): Promise<void> {
  formatter.verbose('Fetching database statistics...');

  // List all collections (returns string[] of collection names)
  const collectionNames = await client.listCollections();

  // Count documents in each collection
  const collectionStats: Array<{ name: string; documentCount: number }> = [];
  let totalDocuments = 0;

  for (const name of collectionNames) {
    const collection = await client.getCollection({
      name,
      embeddingFunction: noopEmbeddingFunction,
    });
    const count = await collection.count();
    collectionStats.push({ name, documentCount: count });
    totalDocuments += count;
  }

  // Calculate disk size of .chromactl directory
  const diskSizeBytes = getDirectorySizeSync(projectDir);
  const diskSizeHuman = formatBytes(diskSizeBytes);

  const stats: DatabaseStats = {
    collectionCount: collectionNames.length,
    totalDocuments,
    diskSizeBytes,
    diskSizeHuman,
    collections: collectionStats,
  };

  if (formatter.isJson) {
    formatter.json(stats);
    return;
  }

  // Display text output
  formatter.info('Database Statistics');
  formatter.info('==================');
  formatter.info(`Collections: ${stats.collectionCount}`);
  formatter.info(`Total documents: ${stats.totalDocuments}`);
  formatter.info(`Database size: ${stats.diskSizeHuman}`);

  if (collectionStats.length > 0) {
    formatter.info('');
    formatter.table(
      ['Collection', 'Documents'],
      collectionStats.map((c) => [c.name, c.documentCount]),
    );
  }
}

// ---------------------------------------------------------------------------
// Collection-Level Stats
// ---------------------------------------------------------------------------

async function showCollectionStats(
  formatter: Formatter,
  client: ChromaClient,
  config: ChromactlConfig,
  collectionName: string,
): Promise<void> {
  formatter.verbose(`Fetching statistics for collection "${collectionName}"...`);

  // Get the collection
  let collection;
  try {
    collection = await client.getCollection({
      name: collectionName,
      embeddingFunction: noopEmbeddingFunction,
    });
  } catch {
    throw new CollectionNotFoundError(collectionName);
  }

  // Get document count
  const documentCount = await collection.count();

  // Get all metadata (no embeddings, no documents -- just IDs and metadatas)
  // Fetch in pages to handle large collections
  const allMetadatas: (Record<string, string | number | boolean> | null)[] = [];

  const PAGE_SIZE = 1000;
  let offset = 0;
  let fetched = 0;

  do {
    const page = await collection.get({
      include: [IncludeEnum.Metadatas],
      limit: PAGE_SIZE,
      offset,
    });

    allMetadatas.push(
      ...(page.metadatas as (Record<string, string | number | boolean> | null)[]),
    );

    fetched = page.ids.length;
    offset += fetched;
  } while (fetched === PAGE_SIZE);

  // Compute unique source files
  const sourceFiles = new Set<string>();
  const fileTypes: Record<string, number> = {};
  const metadataFieldCounts: Record<string, number> = {};
  let chunkCount = 0;

  for (const metadata of allMetadatas) {
    if (!metadata) continue;

    // Source path
    const sourcePath = metadata['source_path'] as string | undefined;
    if (sourcePath) {
      sourceFiles.add(sourcePath);
    }

    // File type
    const fileType = metadata['file_type'] as string | undefined;
    if (fileType) {
      fileTypes[fileType] = (fileTypes[fileType] ?? 0) + 1;
    }

    // Chunk index -- count documents that have chunk_index as chunks
    if ('chunk_index' in metadata) {
      chunkCount++;
    }

    // Metadata field distribution (count all user-defined fields)
    const autoFields = new Set([
      'source_path',
      'file_type',
      'indexed_at',
      'file_size_bytes',
      'content_length',
      'chunk_index',
    ]);

    for (const key of Object.keys(metadata)) {
      if (!autoFields.has(key)) {
        metadataFieldCounts[key] = (metadataFieldCounts[key] ?? 0) + 1;
      }
    }
  }

  // If no chunks were found, all documents are un-chunked
  // chunkCount counts documents WITH chunk_index metadata
  // Documents without chunk_index are whole-file entries
  if (chunkCount === 0) {
    chunkCount = documentCount;
  }

  // Find bound schema
  const schemaName = config.collectionSchemas[collectionName];

  const stats: CollectionStats = {
    name: collectionName,
    documentCount,
    chunkCount,
    uniqueSourceFiles: sourceFiles.size,
    schema: schemaName,
    fileTypeBreakdown: fileTypes,
    metadataFields: metadataFieldCounts,
  };

  if (formatter.isJson) {
    formatter.json(stats);
    return;
  }

  // Display text output
  formatter.info(`Collection Statistics: ${collectionName}`);
  formatter.info('='.repeat(25 + collectionName.length));
  formatter.info(`Documents: ${stats.documentCount}`);
  formatter.info(`Chunks: ${stats.chunkCount}`);
  formatter.info(`Unique source files: ${stats.uniqueSourceFiles}`);

  if (stats.schema) {
    formatter.info(`Schema: ${stats.schema}`);
  }

  // File type breakdown
  const ftEntries = Object.entries(stats.fileTypeBreakdown);
  if (ftEntries.length > 0) {
    formatter.info('');
    formatter.info('File type breakdown:');
    formatter.table(
      ['Type', 'Count'],
      ftEntries.map(([type, count]) => [type, count]),
    );
  }

  // Metadata field distribution
  const mfEntries = Object.entries(stats.metadataFields);
  if (mfEntries.length > 0) {
    formatter.info('');
    formatter.info('Metadata fields:');
    formatter.table(
      ['Field', 'Documents'],
      mfEntries.map(([field, count]) => [field, count]),
    );
  }
}

// ---------------------------------------------------------------------------
// Register Command
// ---------------------------------------------------------------------------

export function registerStatsCommand(program: Command): void {
  program
    .command('stats')
    .argument('[collection]', 'Collection name (omit for database overview)')
    .description('Show database or collection statistics')
    .addHelpText(
      'after',
      `
Examples:
  $ chromactl stats
  $ chromactl stats papers
  $ chromactl stats --json`,
    )
    .action(statsAction);
}
