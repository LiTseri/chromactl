import { Command } from 'commander';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { ChromaClient } from 'chromadb';

import type {
  GlobalOptions,
  IndexOptions,
  IndexResult,
  TextChunk,
  ChromactlConfig,
  SchemaDefinition,
} from '../types/index.js';
import { Formatter, createFormatter } from '../lib/output.js';
import { resolveConfig, getDbPath, getProjectDir } from '../lib/config.js';
import { ServerManager } from '../lib/server.js';
import { extractText, isSupported, getSupportedExtensions, validateDependencies } from '../lib/extractor.js';
import { chunkText, makeChunkId, makeSingleDocId } from '../lib/chunker.js';
import { EmbeddingManager } from '../lib/embedding.js';
import {
  InvalidArgumentError,
  SchemaValidationError,
  ChromactlError,
} from '../lib/errors.js';
import { validateMetadata } from '../lib/schema-validator.js';
import { getOrCreateCollection } from '../lib/db.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validate metadata against a schema definition.
 * Throws SchemaValidationError if validation fails.
 */
function validateMetadataAgainstSchema(
  metadata: Record<string, unknown>,
  schema: SchemaDefinition,
): void {
  const result = validateMetadata(metadata, schema);
  if (!result.valid) {
    throw new SchemaValidationError(result.errors);
  }
}

/**
 * Parse user-supplied JSON metadata string.
 */
function parseMetadataJson(jsonStr: string): Record<string, string | number | boolean> {
  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new InvalidArgumentError(
        'Metadata must be a JSON object.',
        'Example: --metadata \'{"key": "value"}\'',
      );
    }
    return parsed as Record<string, string | number | boolean>;
  } catch (err) {
    if (err instanceof InvalidArgumentError) throw err;
    throw new InvalidArgumentError(
      `Invalid metadata JSON: ${(err as Error).message}`,
      'Ensure valid JSON syntax. Example: --metadata \'{"key": "value"}\'',
    );
  }
}

/**
 * Build auto-generated metadata for a file.
 */
function buildAutoMetadata(
  filePath: string,
  contentLength: number,
): Record<string, string | number | boolean> {
  const absPath = path.resolve(filePath);
  const ext = path.extname(absPath).toLowerCase().replace('.', '');
  let fileSizeBytes = 0;
  try {
    const stat = fs.statSync(absPath);
    fileSizeBytes = stat.size;
  } catch {
    // File may have been deleted after extraction, use 0
  }

  return {
    source_path: absPath,
    file_type: ext,
    indexed_at: new Date().toISOString(),
    file_size_bytes: fileSizeBytes,
    content_length: contentLength,
  };
}

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
 * Process files with bounded concurrency.
 */
async function processWithConcurrency<T>(
  files: string[],
  processor: (file: string, index: number) => Promise<T>,
  concurrency: number = 5,
): Promise<Array<{ file: string; result?: T; error?: Error }>> {
  const results: Array<{ file: string; result?: T; error?: Error }> = [];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      try {
        const result = await processor(file, index);
        results[index] = { file, result };
      } catch (error) {
        results[index] = { file, error: error as Error };
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, files.length) },
    () => worker(),
  );
  await Promise.all(workers);

  return results;
}

/**
 * Recursively find all files in a directory.
 */
async function findFilesRecursive(dirPath: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(currentDir: string): Promise<void> {
    const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          await walk(fullPath);
        }
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(path.resolve(dirPath));
  return results;
}

// ---------------------------------------------------------------------------
// Index File Action
// ---------------------------------------------------------------------------

async function indexFileAction(
  filePath: string,
  options: IndexOptions,
  cmd: Command,
): Promise<void> {
  const { formatter, client, config, projectDir } = await resolveCommandContext(cmd);

  const absPath = path.resolve(filePath);

  // Validate file exists
  if (!fs.existsSync(absPath)) {
    throw new InvalidArgumentError(`File not found: ${absPath}`);
  }

  // Validate file extension
  if (!isSupported(absPath)) {
    const supported = getSupportedExtensions().join(', ');
    throw new InvalidArgumentError(
      `Unsupported file type: ${path.extname(absPath)}`,
      `Supported extensions: ${supported}`,
    );
  }

  // Resolve collection name
  const collectionName = options.collection ?? config.defaultCollection;
  const collection = await getOrCreateCollection(client, collectionName);

  // Parse user metadata
  let userMetadata: Record<string, string | number | boolean> = {};
  if (options.metadata) {
    userMetadata = parseMetadataJson(options.metadata);
  }
  if (options.tag) {
    userMetadata['tag'] = options.tag;
  }

  // Schema validation if collection has a bound schema
  const schemaName = config.collectionSchemas[collectionName];
  if (schemaName) {
    const schema = config.schemas[schemaName];
    if (schema) {
      validateMetadataAgainstSchema(userMetadata, schema);
    }
  }

  // Dry run: show what would be indexed
  if (options.dryRun) {
    formatter.info(`Dry run: would index ${absPath}`);
    formatter.info(`  Collection: ${collectionName}`);
    formatter.info(`  Metadata: ${JSON.stringify(userMetadata)}`);
    return;
  }

  // Extract text
  formatter.verbose(`Extracting text from ${path.basename(absPath)}...`);
  const text = await extractText(absPath);

  if (text.trim().length === 0) {
    formatter.warn(`Warning: No text content extracted from ${absPath}`);
  }

  // Chunk text
  const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : config.chunkSize;
  const chunkOverlap = options.chunkOverlap ? parseInt(options.chunkOverlap, 10) : config.chunkOverlap;
  // Commander's --no-chunking flag sets options.chunking = false
  const noChunking = options.chunking === false;

  const chunks = chunkText(text, { chunkSize, chunkOverlap, noChunking });

  formatter.verbose(`  Extracted ${text.length} characters, created ${chunks.length} chunk(s)`);

  // Build auto-metadata
  const autoMetadata = buildAutoMetadata(absPath, text.length);

  // Prepare IDs, documents, embeddings, and metadatas
  const ids: string[] = [];
  const documents: string[] = [];
  const metadatas: Record<string, string | number | boolean>[] = [];

  if (chunks.length === 1 && !noChunking) {
    // Single chunk -- use the file path as the document ID
    ids.push(makeSingleDocId(absPath));
    documents.push(chunks[0].text);
    metadatas.push({
      ...autoMetadata,
      ...userMetadata,
    });
  } else {
    for (const chunk of chunks) {
      ids.push(makeChunkId(absPath, chunk.index));
      documents.push(chunk.text);
      metadatas.push({
        ...autoMetadata,
        ...userMetadata,
        chunk_index: chunk.index,
      });
    }
  }

  // Generate embeddings
  formatter.verbose('  Generating embeddings...');
  const embeddingManager = EmbeddingManager.getInstance();
  embeddingManager.setCacheDir(path.join(projectDir, 'models'));
  const embeddings = await embeddingManager.embed(documents);

  // Upsert to collection
  formatter.verbose(`  Upserting ${ids.length} document(s) to collection "${collectionName}"...`);
  await collection.upsert({
    ids,
    documents,
    embeddings,
    metadatas,
  });

  // Print summary
  if (formatter.isJson) {
    const result: IndexResult = {
      filesProcessed: 1,
      chunksCreated: chunks.length,
      filesSkipped: [],
      errors: [],
    };
    formatter.json(result);
  } else {
    formatter.success(
      `Indexed 1 file, created ${chunks.length} chunk(s) in collection "${collectionName}".`,
    );
  }
}

// ---------------------------------------------------------------------------
// Index Dir Action
// ---------------------------------------------------------------------------

async function indexDirAction(
  dirPath: string,
  options: IndexOptions,
  cmd: Command,
): Promise<void> {
  const { formatter, client, config, projectDir } = await resolveCommandContext(cmd);

  const absDirPath = path.resolve(dirPath);

  // Validate directory exists
  if (!fs.existsSync(absDirPath)) {
    throw new InvalidArgumentError(`Directory not found: ${absDirPath}`);
  }

  const stat = fs.statSync(absDirPath);
  if (!stat.isDirectory()) {
    throw new InvalidArgumentError(`Not a directory: ${absDirPath}`);
  }

  // Find all files recursively
  const allFiles = await findFilesRecursive(absDirPath);

  // Partition into supported and unsupported
  const supportedFiles: string[] = [];
  const skippedFiles: Array<{ path: string; reason: string }> = [];

  for (const file of allFiles) {
    if (isSupported(file)) {
      supportedFiles.push(file);
    } else {
      skippedFiles.push({
        path: file,
        reason: `Unsupported file type: ${path.extname(file)}`,
      });
    }
  }

  if (supportedFiles.length === 0) {
    formatter.warn('No supported files found in the directory.');
    if (formatter.isJson) {
      const result: IndexResult = {
        filesProcessed: 0,
        chunksCreated: 0,
        filesSkipped: skippedFiles,
        errors: [],
      };
      formatter.json(result);
    }
    return;
  }

  // Validate dependencies for the set of extensions found
  const extensions = [...new Set(supportedFiles.map((f) => path.extname(f).toLowerCase()))];
  const missingDeps = await validateDependencies(extensions);
  if (missingDeps.length > 0) {
    const details = missingDeps
      .map((d) => `  - ${d.tool} (needed for ${d.requiredFor})\n    Install with: ${d.installHint}`)
      .join('\n');
    throw new ChromactlError(
      `Missing required tools:\n${details}`,
      4,
    );
  }

  // Parse user metadata
  let userMetadata: Record<string, string | number | boolean> = {};
  if (options.metadata) {
    userMetadata = parseMetadataJson(options.metadata);
  }
  if (options.tag) {
    userMetadata['tag'] = options.tag;
  }

  // Resolve collection name
  const collectionName = options.collection ?? config.defaultCollection;

  // Schema validation if collection has a bound schema
  const schemaName = config.collectionSchemas[collectionName];
  if (schemaName) {
    const schema = config.schemas[schemaName];
    if (schema) {
      validateMetadataAgainstSchema(userMetadata, schema);
    }
  }

  // Dry run
  if (options.dryRun) {
    formatter.info(`Dry run: would index ${supportedFiles.length} file(s) from ${absDirPath}`);
    formatter.info(`  Collection: ${collectionName}`);
    for (const file of supportedFiles) {
      formatter.info(`  - ${file}`);
    }
    if (skippedFiles.length > 0) {
      formatter.info(`\nSkipped ${skippedFiles.length} unsupported file(s):`);
      for (const s of skippedFiles) {
        formatter.info(`  - ${s.path} (${s.reason})`);
      }
    }
    return;
  }

  const collection = await getOrCreateCollection(client, collectionName);

  // Chunk options
  const chunkSize = options.chunkSize ? parseInt(options.chunkSize, 10) : config.chunkSize;
  const chunkOverlap = options.chunkOverlap ? parseInt(options.chunkOverlap, 10) : config.chunkOverlap;
  const noChunking = options.chunking === false;

  // Set up embedding manager
  const embeddingManager = EmbeddingManager.getInstance();
  embeddingManager.setCacheDir(path.join(projectDir, 'models'));

  // Phase 1: Extract text (concurrent, up to 5 parallel)
  const extractionResults = await processWithConcurrency(
    supportedFiles,
    async (file, index) => {
      formatter.info(
        `[${index + 1}/${supportedFiles.length}] Indexing ${path.basename(file)}...`,
      );
      const text = await extractText(file);
      return text;
    },
    5,
  );

  // Phase 2: Chunk all texts (synchronous, fast)
  interface FileChunks {
    filePath: string;
    chunks: TextChunk[];
    text: string;
  }

  const fileChunksList: FileChunks[] = [];
  const errorFiles: Array<{ path: string; error: string }> = [];

  for (const result of extractionResults) {
    if (result.error) {
      errorFiles.push({
        path: result.file,
        error: result.error.message,
      });
      continue;
    }

    const text = result.result!;
    if (text.trim().length === 0) {
      formatter.verbose(`  Skipping ${result.file} (empty content)`);
      skippedFiles.push({
        path: result.file,
        reason: 'No text content extracted',
      });
      continue;
    }

    const chunks = chunkText(text, { chunkSize, chunkOverlap, noChunking });
    fileChunksList.push({
      filePath: result.file,
      chunks,
      text,
    });
  }

  // Phase 3: Embed all chunks (batch, split into batches of 100 if needed)
  const allChunkTexts: string[] = [];

  for (const fc of fileChunksList) {
    for (const chunk of fc.chunks) {
      allChunkTexts.push(chunk.text);
    }
  }

  let allEmbeddings: number[][] = [];
  if (allChunkTexts.length > 0) {
    formatter.verbose(`  Generating embeddings for ${allChunkTexts.length} chunks...`);

    const BATCH_SIZE = 100;
    if (allChunkTexts.length <= BATCH_SIZE) {
      allEmbeddings = await embeddingManager.embed(allChunkTexts);
    } else {
      // Split into batches of 100
      for (let i = 0; i < allChunkTexts.length; i += BATCH_SIZE) {
        const batch = allChunkTexts.slice(i, i + BATCH_SIZE);
        const batchEmbeddings = await embeddingManager.embed(batch);
        allEmbeddings.push(...batchEmbeddings);
      }
    }
  }

  // Phase 4: Upsert to ChromaDB (sequential, per file)
  let embeddingOffset = 0;
  let totalChunks = 0;
  let filesProcessed = 0;

  for (const fc of fileChunksList) {
    const absPath = path.resolve(fc.filePath);
    const autoMetadata = buildAutoMetadata(absPath, fc.text.length);

    const ids: string[] = [];
    const documents: string[] = [];
    const metadatas: Record<string, string | number | boolean>[] = [];
    const embeddings: number[][] = [];

    if (fc.chunks.length === 1 && !noChunking) {
      ids.push(makeSingleDocId(absPath));
      documents.push(fc.chunks[0].text);
      metadatas.push({ ...autoMetadata, ...userMetadata });
      embeddings.push(allEmbeddings[embeddingOffset]);
      embeddingOffset++;
    } else {
      for (const chunk of fc.chunks) {
        ids.push(makeChunkId(absPath, chunk.index));
        documents.push(chunk.text);
        metadatas.push({
          ...autoMetadata,
          ...userMetadata,
          chunk_index: chunk.index,
        });
        embeddings.push(allEmbeddings[embeddingOffset]);
        embeddingOffset++;
      }
    }

    try {
      await collection.upsert({
        ids,
        documents,
        embeddings,
        metadatas,
      });
      filesProcessed++;
      totalChunks += fc.chunks.length;
    } catch (err) {
      errorFiles.push({
        path: fc.filePath,
        error: (err as Error).message,
      });
    }
  }

  // Print summary
  const result: IndexResult = {
    filesProcessed,
    chunksCreated: totalChunks,
    filesSkipped: skippedFiles,
    errors: errorFiles,
  };

  if (formatter.isJson) {
    formatter.json(result);
  } else {
    formatter.success(
      `Indexed ${filesProcessed} file(s), created ${totalChunks} chunk(s) in collection "${collectionName}".`,
    );

    if (skippedFiles.length > 0) {
      formatter.warn(`Skipped ${skippedFiles.length} file(s):`);
      for (const s of skippedFiles) {
        formatter.info(`  - ${path.basename(s.path)}: ${s.reason}`);
      }
    }

    if (errorFiles.length > 0) {
      formatter.warn(`Errors in ${errorFiles.length} file(s):`);
      for (const e of errorFiles) {
        formatter.info(`  - ${path.basename(e.path)}: ${e.error}`);
      }
    }
  }

  // Exit with error code if ALL files failed
  if (filesProcessed === 0 && fileChunksList.length > 0) {
    process.exitCode = 3;
  }
}

// ---------------------------------------------------------------------------
// Register Command
// ---------------------------------------------------------------------------

export function registerIndexCommand(program: Command): void {
  const indexCmd = program
    .command('index')
    .description('Index documents into a collection');

  const addSharedOptions = (cmd: Command): Command =>
    cmd
      .option('--collection <name>', 'Target collection (default: from config)')
      .option('--metadata <json>', 'Metadata key-value pairs as JSON')
      .option('--tag <value>', 'Add a "tag" metadata field')
      .option('--chunk-size <n>', 'Chunk size in characters')
      .option('--chunk-overlap <n>', 'Chunk overlap in characters')
      .option('--no-chunking', 'Disable chunking; store entire document')
      .option('--dry-run', 'Preview what would be indexed');

  addSharedOptions(
    indexCmd
      .command('file')
      .argument('<path>', 'Path to the file to index')
      .description('Index a single document file')
      .addHelpText(
        'after',
        `
Examples:
  $ chromactl index file README.md
  $ chromactl index file paper.pdf --collection papers --metadata '{"author":"Smith","year":2024}'
  $ chromactl index file report.docx --tag research`,
      ),
  ).action(indexFileAction);

  addSharedOptions(
    indexCmd
      .command('dir')
      .argument('<path>', 'Path to the directory to index')
      .description('Recursively index all supported files in a directory')
      .addHelpText(
        'after',
        `
Examples:
  $ chromactl index dir ./docs
  $ chromactl index dir ./papers --collection papers --dry-run
  $ chromactl index dir . --tag project-docs`,
      ),
  ).action(indexDirAction);
}
