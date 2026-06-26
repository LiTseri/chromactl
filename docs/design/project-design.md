# Technical Design: chromactl CLI Tool

**Document ID:** DESIGN-001
**Created:** 2026-06-26
**Status:** Final
**Sources:**
- `docs/design/refined-request-chromactl.md`
- `docs/design/plan-001-chromactl-implementation.md`
- `docs/reference/investigation-chromactl.md`
- `docs/research/chromadb-server-lifecycle.md`
- `docs/research/chromadb-collection-api.md`
- `docs/research/chromadb-default-embed.md`

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [Module Design](#2-module-design)
3. [Data Models](#3-data-models)
4. [CLI Command Structure](#4-cli-command-structure)
5. [File Structure](#5-file-structure)
6. [Error Handling Strategy](#6-error-handling-strategy)
7. [Configuration Discovery](#7-configuration-discovery)
8. [Server Lifecycle](#8-server-lifecycle)
9. [Embedding Pipeline](#9-embedding-pipeline)
10. [Text Extraction Pipeline](#10-text-extraction-pipeline)

---

## 1. System Architecture

### 1.1 Component Diagram

```
+-------------------------------------------------------------------+
|                     chromactl CLI Process                          |
|                                                                   |
|  +------------------+    +------------------+    +---------------+ |
|  |   Commander.js   |    |   OutputFormatter|    |  ErrorHandler | |
|  |  (Routing +      |    |  (text/JSON/     |    |  (classes,    | |
|  |   Global Opts)   |    |   color/quiet/   |    |   exit codes, | |
|  +--------+---------+    |   verbose)       |    |   formatting) | |
|           |              +------------------+    +---------------+ |
|           |                                                       |
|  +--------v---------------------------------------------------+   |
|  |                    Command Handlers                         |   |
|  |  init | schema | collection | index | search | stats | svr |   |
|  +-----+------+--------+----------+--------+--------+--------+   |
|        |      |        |          |        |        |             |
|  +-----v------v--------v----------v--------v--------v--------+   |
|  |                   Shared Libraries                         |   |
|  |                                                            |   |
|  |  +----------+  +----------+  +-----------+  +-----------+ |   |
|  |  | config   |  | server   |  | embedding |  | extractor | |   |
|  |  | (R/W     |  | (start/  |  | (pipeline |  | (pdftotext| |   |
|  |  | chromactl|  |  stop/   |  |  singleton|  |  pandoc,  | |   |
|  |  | .json)   |  |  health) |  |  384-dim) |  |  fs.read) | |   |
|  |  +----------+  +----+-----+  +-----------+  +-----------+ |   |
|  |                     |                                      |   |
|  |  +----------+  +----+-----+  +-----------+                |   |
|  |  | chunker  |  | db       |  | schema-   |                |   |
|  |  | (overlap |  | (ChromaDB|  | validator |                |   |
|  |  |  split,  |  |  client  |  | (type +   |                |   |
|  |  |  IDs)    |  |  wrapper)|  |  required) |                |   |
|  |  +----------+  +----------+  +-----------+                |   |
|  +------------------------------------------------------------+   |
+-------------------------------------------------------------------+
         |                    |
         | spawn (detached)   | HTTP (localhost:8100)
         v                    v
+-------------------+  +--------------------------+
| ChromaDB Server   |  | @huggingface/transformers|
| (Rust binary via  |  | ONNX Runtime             |
|  chromadb npm)     |  | all-MiniLM-L6-v2 model   |
| Port 8100          |  | (384-dim embeddings)     |
| PID: server.json   |  | Cache: .chromactl/models/|
+-------------------+  +--------------------------+
         |
         v
+-------------------+
| .chromactl/       |
|   chroma-data/    |  <-- SQLite + HNSW index files
|   server.json     |  <-- PID file
|   models/         |  <-- ONNX model cache
| chromactl.json    |  <-- Project configuration
+-------------------+
```

### 1.2 Data Flow: Index Operation

```
User runs: chromactl index file report.pdf --collection papers --metadata '{"author":"Smith"}'

1. CLI Parsing (Commander.js)
   |-- Parse arguments: path=report.pdf, collection=papers, metadata={author:"Smith"}
   |-- preAction hook: resolve config, ensure server running
   v
2. Config Resolution
   |-- Walk up from cwd to find chromactl.json
   |-- Load config, resolve dbPath to absolute
   v
3. Server Lifecycle
   |-- Read .chromactl/server.json
   |-- If PID alive + heartbeat OK: reuse existing server
   |-- Else: spawn new server, poll until ready, write PID file
   v
4. Schema Validation (if collection has bound schema)
   |-- Load schema from config.schemas[config.collectionSchemas["papers"]]
   |-- Validate {author:"Smith"} against schema fields
   |-- Error if required fields missing or types mismatch
   v
5. Text Extraction
   |-- Detect extension: .pdf
   |-- Check pdftotext installed (execFile "which pdftotext")
   |-- Run: execFile("pdftotext", ["report.pdf", "-"])
   |-- Returns: extracted text string
   v
6. Chunking
   |-- chunkText(text, { chunkSize: 1000, chunkOverlap: 200 })
   |-- Returns: [{text, index: 0}, {text, index: 1}, ...]
   |-- Generate IDs: /abs/path/report.pdf::chunk-0, ::chunk-1, ...
   v
7. Auto-Metadata Generation
   |-- source_path: /absolute/path/to/report.pdf
   |-- file_type: "pdf"
   |-- indexed_at: "2026-06-26T12:00:00.000Z"
   |-- file_size_bytes: 524288
   |-- content_length: 15000
   v
8. Metadata Merge
   |-- Base: auto-metadata
   |-- Overlay: user metadata {author:"Smith"}
   |-- Per-chunk: add chunk_index: 0, 1, ...
   v
9. Embedding Generation
   |-- EmbeddingManager.generate([chunk0.text, chunk1.text, ...])
   |-- Singleton pipeline (loaded once, reused)
   |-- Returns: [[384 floats], [384 floats], ...]
   v
10. ChromaDB Upsert
    |-- collection.upsert({ ids, documents, embeddings, metadatas })
    |-- Upsert semantics: re-indexing same file overwrites
    v
11. Summary Output
    |-- "Indexed 1 file, created 3 chunks"
```

### 1.3 Data Flow: Search Operation

```
User runs: chromactl search "machine learning techniques" -n 10 --filter '{"author":"Smith"}'

1. CLI Parsing
   |-- query="machine learning techniques", nResults=10, filter={author:"Smith"}
   v
2. Config + Server (same as index)
   v
3. Embed Query
   |-- EmbeddingManager.generate(["machine learning techniques"])
   |-- Returns: [384-dim vector]
   v
4. ChromaDB Query
   |-- collection.query({
   |--   queryEmbeddings: [queryVector],
   |--   nResults: 10,
   |--   where: {author: "Smith"},
   |--   include: ["documents", "metadatas", "distances"]
   |-- })
   |-- Returns: MultiQueryResponse (nested arrays, one per query)
   v
5. Distance-to-Similarity Conversion
   |-- For each result: similarity = 1 / (1 + distance)  [L2 default]
   v
6. Score Filtering (if --min-score)
   |-- Filter out results where similarity < minScore
   v
7. Format Output
   |-- Text mode:
   |--   [1] (0.87) /path/to/report.pdf  chunk 2
   |--       First 200 characters of matching text...
   |--       author: "Smith"
   |-- JSON mode:
   |--   [{ rank: 1, similarity: 0.87, source_path: "...", ... }]
```

### 1.4 Key Architectural Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Embedding location | Client-side | ChromaDB server does not generate embeddings. The JS client must provide pre-computed vectors. |
| Embedding library | `@huggingface/transformers` directly | `@chroma-core/default-embed` has no pipeline caching -- reloads model on every `generate()` call (1-3s overhead). |
| Embedding function on collections | `null` (self-managed) | Avoids ChromaDB's default embedding function which has no caching. We pass explicit embeddings to `add/upsert/query`. |
| Server management | Hybrid pattern | Auto-start on first DB command, keep running between commands, explicit `server stop`. Balances UX and performance. |
| Default port | 8100 | Avoids conflict with standalone ChromaDB on port 8000. |
| CLI framework | Commander.js v15 | Zero dependencies, first-class TypeScript via `@commander-js/extra-typings`, lifecycle hooks for preAction server startup. |
| Config discovery | Walk up from cwd | Standard pattern (like `.git`, `.npmrc`). Also supports `--db` flag and `CHROMACTL_DB` env var. |
| Chunk ID format | `<absolute-path>::chunk-<n>` | Enables dedup on re-index. Absolute path ensures uniqueness. |
| Distance metric | L2 (ChromaDB default) | `1/(1+distance)` converts to intuitive 0-1 similarity. |
| Model dtype | Configurable, default `fp32` | `fp32` (91 MB) for best quality; `uint8` (24 MB) available for faster download. |
| Model cache | `.chromactl/models/` | Persists across `node_modules` rebuilds. Set via `env.cacheDir`. |

---

## 2. Module Design

### 2.1 Module: `config` (`src/lib/config.ts`)

Manages the `chromactl.json` configuration file -- discovery, reading, writing, and default generation.

#### Public Interface

```typescript
/**
 * Walk up directories from startDir looking for chromactl.json.
 * Returns the absolute path to the config file, or null if not found.
 */
export function findConfigFile(startDir: string): string | null;

/**
 * Load and parse chromactl.json from the given path.
 * Throws ConfigNotFoundError if file does not exist.
 * Throws ChromactlError if file is malformed JSON.
 */
export function loadConfig(configPath: string): ChromactlConfig;

/**
 * Write the config to disk atomically (write to .tmp, rename).
 * Creates parent directories if needed.
 */
export function saveConfig(configPath: string, config: ChromactlConfig): void;

/**
 * Resolve config from multiple sources in priority order:
 * 1. --db <path> CLI flag (options.db)
 * 2. CHROMACTL_DB environment variable
 * 3. Walk up from cwd to find chromactl.json
 * 4. Default: ./.chromactl in cwd
 *
 * Returns both the config and the resolved config file path.
 * Throws ConfigNotFoundError if no config found and requireExisting is true.
 */
export function resolveConfig(options: {
  db?: string;
  requireExisting?: boolean;
}): { configPath: string; config: ChromactlConfig };

/**
 * Return a ChromactlConfig populated with all default values.
 */
export function getDefaultConfig(): ChromactlConfig;

/**
 * Resolve the dbPath from config (which may be relative) to an absolute path
 * anchored at the directory containing chromactl.json.
 */
export function getDbPath(config: ChromactlConfig, configDir: string): string;

/**
 * Resolve the absolute path to the .chromactl directory
 * (the parent of chroma-data, server.json, models/).
 */
export function getProjectDir(configPath: string): string;
```

#### Internal Implementation

- `findConfigFile`: Iterative `path.dirname` loop from `startDir` to root, checking `fs.existsSync(path.join(dir, 'chromactl.json'))` at each level.
- `saveConfig`: Write to `<path>.tmp` then `fs.renameSync` for atomicity. Use `JSON.stringify(config, null, 2) + '\n'`.
- `resolveConfig`: Chain of checks. For `requireExisting: true` (used by all commands except `init`), throw `ConfigNotFoundError` if no config found.
- Config file path is always stored as an absolute path internally.

#### Dependencies

- `node:fs`, `node:path`
- `src/types/index.ts` (ChromactlConfig type)
- `src/lib/errors.ts` (ConfigNotFoundError)

---

### 2.2 Module: `server` (`src/lib/server.ts`)

Manages the ChromaDB server process lifecycle -- start, stop, health check, PID file management.

#### Public Interface

```typescript
export interface ServerManagerConfig {
  projectRoot: string;    // Directory containing .chromactl/
  persistPath: string;    // Absolute path to chroma-data directory
  port: number;           // Default: 8100
  host: string;           // Default: "localhost"
  startupTimeoutMs?: number;  // Default: 30000
  shutdownTimeoutMs?: number; // Default: 10000
}

export class ServerManager {
  constructor(config: ServerManagerConfig);

  /**
   * Ensure a server is running and return a connected ChromaClient.
   * If a server is already running (verified via PID + heartbeat), reuse it.
   * Otherwise, start a new one.
   */
  async ensureRunning(): Promise<ChromaClient>;

  /**
   * Start a new server. Throws if port is in use.
   * Writes PID file, unrefs the process so CLI can exit.
   * Returns a connected ChromaClient.
   */
  async start(): Promise<ChromaClient>;

  /**
   * Stop the managed server.
   * Sends SIGTERM, waits up to shutdownTimeoutMs, then SIGKILL.
   * Deletes the PID file.
   * Returns true if a server was stopped, false if none was running.
   */
  async stop(): Promise<boolean>;

  /**
   * Get info about the currently running server, or null if none.
   * Performs three-tier validation: PID alive -> heartbeat -> port match.
   * Cleans up stale PID files automatically.
   */
  async getRunningServer(): Promise<ServerInfo | null>;

  /**
   * Get the current server status.
   */
  async status(): Promise<{ running: boolean; info: ServerInfo | null }>;
}
```

#### Internal Implementation

- **Binary resolution**: `createRequire(import.meta.url).resolve('chromadb/package.json')` to find the chromadb package root, then join `dist/cli.mjs`.
- **Spawn**: `child_process.spawn(process.execPath, [cliBinary, 'run', '--path', persistPath, '--port', String(port), '--host', host], { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, CHROMADB_VERSION: '999.999.999' } })`.
- **Readiness polling**: Exponential backoff -- 100ms initial delay, 1.5x factor, 2s max delay, 30 max attempts. Uses `ChromaClient.heartbeat()`.
- **Early exit detection**: Race between readiness polling and a promise that rejects if the child process emits `'exit'`. Captures stderr for error messages.
- **PID file**: JSON at `.chromactl/server.json` containing `{ pid, port, host, startedAt, persistPath }`.
- **Stale PID detection**: `process.kill(pid, 0)` to check existence, then heartbeat check to verify it's actually a ChromaDB server on the expected port.
- **Port conflict**: `net.createServer().listen(port, host)` to test availability before spawning.
- **Unref**: After server is ready, call `proc.unref()`, `proc.stdout?.unref?.()`, `proc.stderr?.unref?.()` so the CLI can exit without waiting.

#### Dependencies

- `node:child_process`, `node:module`, `node:fs/promises`, `node:path`, `node:net`
- `chromadb` (ChromaClient)
- `src/types/index.ts` (ServerInfo)
- `src/lib/errors.ts` (ServerError)

---

### 2.3 Module: `db` (`src/lib/db.ts`)

ChromaDB client wrapper providing a simplified API for collection and document operations. Isolates all ChromaDB API interactions behind a stable interface so that changes to the chromadb npm package internals only affect this module.

#### Public Interface

```typescript
import type { ChromaClient, Collection } from 'chromadb';

/**
 * Get or create a collection without an embedding function.
 * Collections are always created with embeddingFunction: null
 * because chromactl manages embeddings via EmbeddingManager.
 */
export async function getOrCreateCollection(
  client: ChromaClient,
  name: string,
): Promise<Collection>;

/**
 * Get an existing collection. Throws if not found.
 */
export async function getCollection(
  client: ChromaClient,
  name: string,
): Promise<Collection>;

/**
 * Create a new collection. Throws if it already exists.
 */
export async function createCollection(
  client: ChromaClient,
  name: string,
): Promise<Collection>;

/**
 * List all collection names.
 */
export async function listCollections(
  client: ChromaClient,
): Promise<string[]>;

/**
 * Delete a collection by name.
 */
export async function deleteCollection(
  client: ChromaClient,
  name: string,
): Promise<void>;

/**
 * Upsert documents with pre-computed embeddings into a collection.
 */
export async function upsertDocuments(
  collection: Collection,
  params: {
    ids: string[];
    documents: string[];
    embeddings: number[][];
    metadatas: Record<string, string | number | boolean>[];
  },
): Promise<void>;

/**
 * Query a collection with a pre-computed embedding vector.
 * Returns results in a normalized format (flat array, not nested).
 */
export async function queryCollection(
  collection: Collection,
  params: {
    queryEmbedding: number[];
    nResults: number;
    where?: Record<string, unknown>;
  },
): Promise<{
  ids: string[];
  documents: (string | null)[];
  metadatas: (Record<string, string | number | boolean> | null)[];
  distances: number[];
}>;

/**
 * Get all documents from a collection (for stats computation).
 * Excludes embeddings to reduce memory usage.
 */
export async function getAllDocuments(
  collection: Collection,
  options?: { limit?: number; offset?: number },
): Promise<{
  ids: string[];
  metadatas: (Record<string, string | number | boolean> | null)[];
}>;

/**
 * Count documents in a collection.
 */
export async function countDocuments(
  collection: Collection,
): Promise<number>;
```

#### Internal Implementation

- All collection creation uses `embeddingFunction: null` to disable auto-embedding.
- `queryCollection` calls `collection.query()` with `queryEmbeddings: [queryEmbedding]` (singular query, returns `MultiQueryResponse` -- extract index `[0]` from each nested array).
- `getAllDocuments` calls `collection.get({ include: [IncludeEnum.Metadatas] })` -- deliberately excludes documents and embeddings for memory efficiency in stats operations.
- Wraps ChromaDB errors (`ChromaNotFoundError`, `ChromaConnectionError`, etc.) in chromactl error classes for consistent error handling.

#### Dependencies

- `chromadb` (ChromaClient, Collection, IncludeEnum, error classes)
- `src/types/index.ts`
- `src/lib/errors.ts`

---

### 2.4 Module: `extractor` (`src/lib/extractor.ts`)

Text extraction from files using system CLI tools or direct filesystem reads.

#### Public Interface

```typescript
/**
 * Supported file extensions for text extraction.
 */
export const SUPPORTED_EXTENSIONS: readonly string[] = ['.txt', '.md', '.pdf', '.docx', '.html'];

/**
 * Extract text content from a file based on its extension.
 * Dispatches to the appropriate extraction strategy.
 * Throws ExtractionError on failure.
 * Throws DependencyError if required tool is not installed.
 */
export async function extractText(filePath: string): Promise<string>;

/**
 * Check if a system tool is installed and available on PATH.
 * Returns the tool path if found, null otherwise.
 */
export async function checkDependency(toolName: string): Promise<string | null>;

/**
 * Given a list of file extensions that will be processed,
 * check that all required system tools are available.
 * Returns an array of missing tool descriptions.
 */
export async function validateDependencies(
  extensions: string[],
): Promise<MissingDependency[]>;

export interface MissingDependency {
  tool: string;
  requiredFor: string;      // e.g., ".pdf files"
  installHint: string;      // e.g., "apt install poppler-utils"
}

/**
 * Check if a file extension is supported for extraction.
 */
export function isSupportedExtension(ext: string): boolean;
```

#### Internal Implementation

- **Extension-to-tool mapping**:
  - `.txt`, `.md` -> `fs.readFile(path, 'utf-8')` (no external tool)
  - `.pdf` -> `execFile('pdftotext', [filePath, '-'])`
  - `.docx` -> `execFile('pandoc', [filePath, '-t', 'plain'])`
  - `.html` -> `execFile('pandoc', [filePath, '-t', 'plain'])`
- Uses `util.promisify(child_process.execFile)` -- no shell spawning (safer).
- `maxBuffer: 10 * 1024 * 1024` (10 MB) for large documents.
- `timeout: 30_000` (30 seconds) per extraction.
- `checkDependency` uses `execFile('which', [toolName])` and checks for non-zero exit code.
- **Extension-to-tool dependency map**:
  ```
  .pdf  -> pdftotext  (install: apt install poppler-utils)
  .docx -> pandoc     (install: apt install pandoc)
  .html -> pandoc     (install: apt install pandoc)
  ```

#### Dependencies

- `node:child_process`, `node:util`, `node:fs/promises`, `node:path`
- `src/lib/errors.ts` (ExtractionError, DependencyError)

---

### 2.5 Module: `chunker` (`src/lib/chunker.ts`)

Character-based text splitting with configurable overlap and intelligent boundary detection.

#### Public Interface

```typescript
export interface ChunkOptions {
  chunkSize?: number;       // Default: 1000
  chunkOverlap?: number;    // Default: 200
  noChunking?: boolean;     // Default: false
}

export interface TextChunk {
  text: string;
  index: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Split text into overlapping chunks with intelligent boundary detection.
 * 
 * If text.length <= chunkSize, returns a single chunk.
 * If noChunking is true, returns a single chunk regardless of length.
 * 
 * Boundary detection prefers (in order):
 * 1. Sentence boundary (. ! ? followed by whitespace) within the chunk
 * 2. Word boundary (whitespace) within the chunk
 * 3. Hard cut at chunkSize (fallback)
 */
export function chunkText(text: string, options?: ChunkOptions): TextChunk[];

/**
 * Generate a ChromaDB document ID for a specific chunk.
 * Format: <absolutePath>::chunk-<index>
 */
export function makeChunkId(filePath: string, chunkIndex: number): string;

/**
 * Generate a ChromaDB document ID for an unchunked document.
 * Format: <absolutePath>
 */
export function makeSingleDocId(filePath: string): string;
```

#### Internal Implementation

Chunking algorithm:

```
function chunkText(text, options):
  if noChunking or text.length <= chunkSize:
    return [{ text, index: 0, startOffset: 0, endOffset: text.length }]
  
  chunks = []
  offset = 0
  index = 0
  
  while offset < text.length:
    end = min(offset + chunkSize, text.length)
    
    if end < text.length:
      // Try to find a good break point
      candidateText = text.slice(offset, end)
      
      // Strategy 1: Last sentence boundary
      sentenceBreak = findLastSentenceBoundary(candidateText)
      if sentenceBreak > chunkSize * 0.5:   // Only if past halfway
        end = offset + sentenceBreak
      else:
        // Strategy 2: Last word boundary
        wordBreak = candidateText.lastIndexOf(' ')
        if wordBreak > chunkSize * 0.3:
          end = offset + wordBreak + 1        // Include the space
    
    chunks.push({
      text: text.slice(offset, end).trim(),
      index,
      startOffset: offset,
      endOffset: end,
    })
    
    index++
    offset = end - chunkOverlap
    if offset >= text.length: break
    // Ensure forward progress
    if offset <= chunks[chunks.length-1].startOffset:
      offset = end
  
  return chunks
```

Helper: `findLastSentenceBoundary(text)` scans backward from end of text looking for `.`, `!`, or `?` followed by whitespace or end-of-string. Returns the offset immediately after the whitespace, or -1.

#### Dependencies

- `node:path` (for path.resolve in makeChunkId)
- No external dependencies

---

### 2.6 Module: `embedding` (`src/lib/embedding.ts`)

Cached embedding pipeline using `@huggingface/transformers` with singleton pattern.

#### Public Interface

```typescript
import type { ProgressCallback } from '@huggingface/transformers';

export class EmbeddingManager {
  /**
   * Create an embedding manager.
   * @param cacheDir - Directory to cache ONNX model files.
   *                   Default: .chromactl/models/ relative to project root.
   */
  constructor(cacheDir?: string);

  /**
   * Ensure the ONNX model is downloaded and loaded.
   * Shows download progress on first run.
   * Safe to call multiple times -- loads only once.
   */
  async ensureModel(progressCallback?: ProgressCallback): Promise<void>;

  /**
   * Generate 384-dimensional embeddings for an array of texts.
   * Automatically calls ensureModel() if not yet loaded.
   * 
   * For best performance, pass all texts in a single call
   * to amortize model loading cost.
   * 
   * @param texts - Array of text strings to embed
   * @returns Array of 384-dimensional float arrays
   */
  async generate(texts: string[]): Promise<number[][]>;

  /**
   * Check if the ONNX model files are present in the cache directory.
   * Returns true if a cached model exists (offline operation possible).
   */
  isModelCached(): boolean;

  /**
   * The number of dimensions in the embedding vectors.
   */
  readonly dimensions: 384;
}
```

#### Internal Implementation

```typescript
import { pipeline, env, type ProgressCallback, type FeatureExtractionPipeline } from '@huggingface/transformers';

export class EmbeddingManager {
  private pipelineInstance: FeatureExtractionPipeline | null = null;
  private loadingPromise: Promise<FeatureExtractionPipeline> | null = null;
  readonly dimensions = 384 as const;

  private static readonly MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
  private static readonly DTYPE = 'fp32';  // or 'uint8' for smaller download

  constructor(cacheDir?: string) {
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  async ensureModel(progressCallback?: ProgressCallback): Promise<void> {
    if (this.pipelineInstance) return;

    if (!this.loadingPromise) {
      this.loadingPromise = pipeline('feature-extraction', EmbeddingManager.MODEL_NAME, {
        dtype: EmbeddingManager.DTYPE,
        progress_callback: progressCallback,
      });
    }

    this.pipelineInstance = await this.loadingPromise;
  }

  async generate(texts: string[]): Promise<number[][]> {
    await this.ensureModel();
    const output = await this.pipelineInstance!(texts, {
      pooling: 'mean',
      normalize: true,
    });
    return output.tolist();
  }

  isModelCached(): boolean {
    // Check for model files in cacheDir/Xenova/all-MiniLM-L6-v2/onnx/
    const modelDir = path.join(
      env.cacheDir,
      'Xenova',
      'all-MiniLM-L6-v2',
      'onnx',
    );
    try {
      return fs.existsSync(path.join(modelDir, 'model.onnx'));
    } catch {
      return false;
    }
  }
}
```

Key design decisions:

1. **Singleton pipeline**: The pipeline is loaded once and cached as an instance property. The `loadingPromise` pattern ensures that concurrent calls to `ensureModel()` don't trigger multiple pipeline loads.

2. **Cache directory**: Set to `.chromactl/models/` via `env.cacheDir` so model files persist across `node_modules` rebuilds.

3. **Batch embedding**: The `generate()` method accepts an array and passes it all to the pipeline in one call. This is critical -- calling `generate()` per-text with `DefaultEmbeddingFunction` would reload the model each time.

4. **No `DefaultEmbeddingFunction`**: We bypass ChromaDB's default embedding wrapper entirely because it calls `pipeline()` on every `generate()` invocation, with no caching. Direct use of `@huggingface/transformers` gives us full control.

#### Dependencies

- `@huggingface/transformers` (pipeline, env)
- `node:path`, `node:fs`
- No chromactl internal dependencies

---

### 2.7 Module: `schema-validator` (`src/lib/schema-validator.ts`)

Validates metadata against schema definitions. Also handles parsing schema input from CLI arguments.

#### Public Interface

```typescript
export interface ValidationError {
  field: string;
  message: string;
  expected?: string;
  actual?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validate a metadata object against a schema definition.
 * Checks:
 * - Required fields are present
 * - Field types match (string, number, boolean)
 * - No unknown fields (warning, not error -- metadata can have extra keys)
 */
export function validateMetadata(
  metadata: Record<string, unknown>,
  schema: SchemaDefinition,
): ValidationResult;

/**
 * Parse and validate a schema definition from a JSON string.
 * Throws SchemaValidationError if the JSON is invalid or does not
 * conform to the expected schema structure.
 */
export function parseSchemaInput(fieldsJson: string): SchemaDefinition;

/**
 * Load a schema definition from a JSON file.
 * Throws if file does not exist or contains invalid schema JSON.
 */
export async function loadSchemaFromFile(filePath: string): Promise<SchemaDefinition>;

/**
 * Validate that a schema definition is well-formed:
 * - At least one field defined
 * - All field types are "string", "number", or "boolean"
 * - All fields have a "required" property (boolean)
 */
export function validateSchemaDefinition(schema: SchemaDefinition): ValidationResult;
```

#### Internal Implementation

- `validateMetadata`:
  1. Iterate over schema fields. For each required field, check it exists in metadata.
  2. For each field present in metadata that also exists in schema, check `typeof value === schema.fields[key].type`.
  3. Extra keys in metadata (not in schema) are allowed -- metadata can contain auto-generated fields like `source_path`, `indexed_at`, etc.
- `parseSchemaInput`:
  1. `JSON.parse(fieldsJson)` -- catch SyntaxError and throw `SchemaValidationError` with position info.
  2. Wrap in `{ fields: parsed }` if the input is a flat object of field definitions.
  3. Call `validateSchemaDefinition()` on the result.
- `loadSchemaFromFile`:
  1. `fs.readFile(filePath, 'utf-8')` -- catch ENOENT.
  2. `JSON.parse` -- catch SyntaxError.
  3. Same wrapping and validation as `parseSchemaInput`.

#### Dependencies

- `node:fs/promises`
- `src/types/index.ts` (SchemaDefinition, FieldDefinition)
- `src/lib/errors.ts` (SchemaValidationError)

---

### 2.8 Module: `output` (`src/lib/output.ts`)

Output formatting supporting text tables, JSON, colored output, verbosity control, and `NO_COLOR` compliance.

#### Public Interface

```typescript
export interface FormatterOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

export class Formatter {
  constructor(options: FormatterOptions);

  /** Print a success message (green). */
  success(message: string): void;

  /** Print an error message (red) to stderr. */
  error(message: string): void;

  /** Print a warning message (yellow). */
  warn(message: string): void;

  /** Print an informational message. Suppressed in quiet mode. */
  info(message: string): void;

  /** Print a verbose/debug message. Only shown with --verbose. */
  verbose(message: string): void;

  /** Print a formatted table. Suppressed in quiet mode. */
  table(headers: string[], rows: (string | number)[][]): void;

  /** Print data as formatted JSON to stdout. */
  json(data: unknown): void;

  /** Print raw text to stdout (not suppressed by quiet). */
  raw(text: string): void;

  /** Whether JSON output mode is enabled. */
  get isJson(): boolean;

  /** Whether quiet mode is enabled. */
  get isQuiet(): boolean;

  /** Whether verbose mode is enabled. */
  get isVerbose(): boolean;
}

/**
 * Create a formatter instance from CLI options.
 */
export function createFormatter(options: FormatterOptions): Formatter;
```

#### Internal Implementation

- **Color**: Use `chalk` for coloring. Check `process.env.NO_COLOR` at construction time -- if set, use plain text (chalk auto-detects this).
- **Quiet mode**: `info()`, `success()`, `warn()`, `table()` become no-ops. Only `error()`, `raw()`, and `json()` produce output.
- **Verbose mode**: `verbose()` prints only when verbose is true. All other methods work normally.
- **Table formatting**: Simple column alignment using `String.padEnd()`. Headers get a separator line (`---`). Widths computed from max content length per column.
- **JSON mode**: `json()` calls `JSON.stringify(data, null, 2)` and writes to stdout. When `isJson` is true, commands should use `json()` instead of `table()`/`success()`.

#### Dependencies

- `chalk` (terminal colors)
- No internal dependencies

---

### 2.9 Module: `commands` (`src/commands/*.ts`)

Each command module exports a Commander.js `Command` instance that is registered on the main program. Commands share infrastructure through a context object set up by preAction hooks.

#### Command Context Pattern

```typescript
// Defined in src/types/index.ts
export interface CommandContext {
  config: ChromactlConfig;
  configPath: string;
  projectDir: string;    // .chromactl/ directory
  formatter: Formatter;
  client?: ChromaClient;  // Set by preAction for DB-requiring commands
  embeddingManager?: EmbeddingManager;  // Set lazily on first use
}
```

The `preAction` hook on the root program:
1. Creates a `Formatter` from global options.
2. If the command is NOT `init` or `server stop/status` (which don't need an existing DB):
   - Resolves config via `resolveConfig()`.
   - Ensures server running via `ServerManager.ensureRunning()`.
   - Stores `CommandContext` accessible to action handlers.

#### Command: `init` (`src/commands/init.ts`)

```typescript
export function createInitCommand(): Command;
```

**Options**: `--db <path>`, `--force`

**Implementation**:
1. Determine target directory: `options.db ?? path.join(process.cwd(), '.chromactl')`.
2. Check if `chromactl.json` already exists at or above the target directory.
3. If exists and not `--force`: print warning, exit with code 1.
4. Create the `.chromactl/` directory structure.
5. Write `chromactl.json` with `getDefaultConfig()`.
6. Print confirmation.

#### Command: `schema` (`src/commands/schema.ts`)

```typescript
export function createSchemaCommand(): Command;
```

**Subcommands**:
- `create <name>`: `--fields '<json>'`, `--from-file <path>`
- `list`
- `show <name>`
- `delete <name>`

**Implementation**: All operations modify `chromactl.json` only. No server interaction needed. Schema commands can work without the server running (they operate on the config file only), but for simplicity they use the same preAction hook. We optimize this by having the schema commands not require a server connection -- they skip the `ensureRunning` step.

#### Command: `collection` (`src/commands/collection.ts`)

```typescript
export function createCollectionCommand(): Command;
```

**Subcommands**:
- `create <name>`: `--schema <name>`
- `list`
- `delete <name>`: `--confirm`
- `info <name>`

**Implementation**: Uses `ChromaClient` for collection CRUD. The `create` subcommand also updates `chromactl.json` to store the schema binding in `collectionSchemas`.

#### Command: `index` (`src/commands/index-cmd.ts`)

```typescript
export function createIndexCommand(): Command;
```

The file is named `index-cmd.ts` to avoid conflict with `index.ts` (the entry point).

**Subcommands**:
- `file <path>`: Index a single file
- `dir <path>`: Recursively index a directory

**Shared Options**: `--collection <name>`, `--metadata '<json>'`, `--tag <value>`, `--chunk-size <n>`, `--chunk-overlap <n>`, `--no-chunking`, `--dry-run`

**Implementation** (`index file`):
1. Validate file exists and extension is supported.
2. Resolve collection name (default: "default").
3. Get or create collection via `getOrCreateCollection()`.
4. If collection has a bound schema, validate `--metadata` against it.
5. Extract text via `extractText(filePath)`.
6. Chunk text via `chunkText(text, options)`.
7. Generate auto-metadata (source_path, file_type, indexed_at, file_size_bytes, content_length).
8. Merge user metadata and auto-metadata. Add per-chunk `chunk_index`.
9. Generate embeddings: `embeddingManager.generate(chunks.map(c => c.text))`.
10. Upsert to collection: `upsertDocuments(collection, { ids, documents, embeddings, metadatas })`.
11. Print summary.

**Implementation** (`index dir`):
1. Recursively find files with supported extensions (`fs.readdir` recursive).
2. Call `validateDependencies()` with the set of extensions found.
3. For `--dry-run`: list files and exit.
4. Process files with concurrency limit of 5 (promise pool pattern):
   - Extract text (concurrent).
   - Chunk each file (sync, fast).
5. Batch embed all chunks: `embeddingManager.generate(allChunkTexts)` (or batch by 100 if > 100 chunks).
6. Upsert to collection (sequential -- one upsert call per file to avoid oversized payloads).
7. Print summary with progress (`[3/15] Indexing report.pdf...`).

#### Command: `search` (`src/commands/search.ts`)

```typescript
export function createSearchCommand(): Command;
```

**Arguments**: `<query>` (required)

**Options**: `--collection <name>`, `-n, --results <number>`, `--filter '<json>'`, `--min-score <number>`, `--snippet-length <number>`, `--full-text`, `--json`

**Implementation**:
1. Parse `--filter` JSON if provided.
2. Resolve collection, get collection reference.
3. Embed query: `embeddingManager.generate([query])` -> `queryEmbedding`.
4. Query: `queryCollection(collection, { queryEmbedding, nResults, where })`.
5. Convert distances: `similarity = 1 / (1 + distance)`.
6. Filter by `--min-score` if specified.
7. Format output using `Formatter`.

#### Command: `stats` (`src/commands/stats.ts`)

```typescript
export function createStatsCommand(): Command;
```

**Arguments**: `[collection]` (optional)

**Options**: `--json`

**Implementation**:
- **Database-level** (no collection argument):
  1. List all collections.
  2. Count documents in each.
  3. Calculate disk size of `.chromactl/` directory.
  4. Output: total collections, total documents, database size.
- **Collection-level** (collection argument provided):
  1. Get collection.
  2. Get all metadata (no embeddings) via `getAllDocuments()`.
  3. Compute: unique source_path values, chunk count, file_type breakdown, metadata field distribution.
  4. Output detailed stats.

#### Command: `server` (`src/commands/server.ts`)

```typescript
export function createServerCommand(): Command;
```

**Subcommands**:
- `start`: Explicitly start the server.
- `stop`: Stop the managed server.
- `status`: Show server PID, port, uptime.

These commands do NOT go through the standard preAction hook. `server stop` and `server status` must work even when the server is not running. `server start` only needs the config, not an existing server connection.

---

## 3. Data Models

### 3.1 Configuration (`chromactl.json`)

```typescript
/**
 * Shape of the chromactl.json configuration file.
 * Stored at the project root, alongside the .chromactl/ directory.
 */
export interface ChromactlConfig {
  /** Schema version of this config file. Currently "1.0". */
  version: string;

  /**
   * Path to the ChromaDB data directory, relative to the config file.
   * Default: ".chromactl/chroma-data"
   */
  dbPath: string;

  /** Default collection name for commands that don't specify --collection. Default: "default". */
  defaultCollection: string;

  /** Port for the ChromaDB server. Default: 8100. */
  port: number;

  /** Host for the ChromaDB server. Default: "localhost". */
  host: string;

  /** Default chunk size in characters. Default: 1000. */
  chunkSize: number;

  /** Default chunk overlap in characters. Default: 200. */
  chunkOverlap: number;

  /** Named schema definitions. Keys are schema names. */
  schemas: Record<string, SchemaDefinition>;

  /**
   * Mapping of collection names to schema names.
   * When a collection has a bound schema, metadata is validated on index.
   */
  collectionSchemas: Record<string, string>;
}
```

**Default config values:**

```json
{
  "version": "1.0",
  "dbPath": ".chromactl/chroma-data",
  "defaultCollection": "default",
  "port": 8100,
  "host": "localhost",
  "chunkSize": 1000,
  "chunkOverlap": 200,
  "schemas": {},
  "collectionSchemas": {}
}
```

### 3.2 Schema Definitions

```typescript
/**
 * A named schema that defines the structure of metadata
 * for documents in a collection.
 */
export interface SchemaDefinition {
  fields: Record<string, FieldDefinition>;
}

/**
 * A single field within a schema.
 */
export interface FieldDefinition {
  /** The expected JavaScript type of the field value. */
  type: 'string' | 'number' | 'boolean';

  /** Whether this field must be present in metadata during indexing. */
  required: boolean;
}
```

### 3.3 Server Info (PID File)

```typescript
/**
 * Contents of .chromactl/server.json.
 * Tracks the running ChromaDB server process.
 */
export interface ServerInfo {
  /** Process ID of the ChromaDB server. */
  pid: number;

  /** TCP port the server is listening on. */
  port: number;

  /** Host the server is bound to. */
  host: string;

  /** ISO 8601 timestamp of when the server was started. */
  startedAt: string;

  /** Absolute path to the ChromaDB persist directory. */
  persistPath: string;
}
```

### 3.4 Index Result

```typescript
/**
 * Summary of an indexing operation.
 */
export interface IndexResult {
  /** Number of files successfully processed. */
  filesProcessed: number;

  /** Total number of chunks created across all files. */
  chunksCreated: number;

  /** Files that were skipped (unsupported extension, extraction failure, etc.). */
  filesSkipped: Array<{
    path: string;
    reason: string;
  }>;

  /** Files that encountered errors during processing. */
  errors: Array<{
    path: string;
    error: string;
  }>;
}
```

### 3.5 Search Result

```typescript
/**
 * A single search result, normalized from ChromaDB's response format.
 */
export interface SearchResult {
  /** 1-based rank (1 = most similar). */
  rank: number;

  /** Similarity score (0.0 to 1.0, higher = more similar). */
  similarity: number;

  /** Absolute path to the source file (from source_path metadata). */
  sourcePath: string;

  /** Chunk index within the source file, if the document was chunked. */
  chunkIndex?: number;

  /** Truncated text preview (default: first 200 characters). */
  snippet: string;

  /** Full document/chunk text (included when --full-text is used). */
  fullText?: string;

  /**
   * All metadata for this result, excluding auto-generated fields
   * that are already represented as top-level properties.
   */
  metadata: Record<string, string | number | boolean>;
}
```

### 3.6 Stats Result

```typescript
/**
 * Database-level statistics.
 */
export interface DatabaseStats {
  collectionCount: number;
  totalDocuments: number;
  diskSizeBytes: number;
  diskSizeHuman: string;  // e.g., "12.3 MB"
  collections: Array<{
    name: string;
    documentCount: number;
  }>;
}

/**
 * Collection-level statistics.
 */
export interface CollectionStats {
  name: string;
  documentCount: number;
  chunkCount: number;
  uniqueSourceFiles: number;
  schema?: string;  // Bound schema name, if any
  fileTypeBreakdown: Record<string, number>;  // e.g., { pdf: 5, md: 3 }
  metadataFields: Record<string, number>;     // e.g., { author: 8, year: 5 }
}
```

### 3.7 Command Option Types

```typescript
/**
 * Global CLI options available on every command.
 */
export interface GlobalOptions {
  db?: string;
  verbose?: boolean;
  quiet?: boolean;
  json?: boolean;
}

/**
 * Options for the init command.
 */
export interface InitOptions extends GlobalOptions {
  force?: boolean;
}

/**
 * Options for schema create.
 */
export interface SchemaCreateOptions extends GlobalOptions {
  fields?: string;     // JSON string
  fromFile?: string;   // Path to JSON file
}

/**
 * Options for collection create.
 */
export interface CollectionCreateOptions extends GlobalOptions {
  schema?: string;
}

/**
 * Options for collection delete.
 */
export interface CollectionDeleteOptions extends GlobalOptions {
  confirm?: boolean;
}

/**
 * Options for index file/dir commands.
 */
export interface IndexOptions extends GlobalOptions {
  collection?: string;
  metadata?: string;     // JSON string
  tag?: string;
  chunkSize?: string;    // Parsed to number
  chunkOverlap?: string; // Parsed to number
  noChunking?: boolean;
  dryRun?: boolean;
}

/**
 * Options for the search command.
 */
export interface SearchOptions extends GlobalOptions {
  collection?: string;
  results?: string;        // Parsed to number, default 5
  filter?: string;         // JSON string
  minScore?: string;       // Parsed to number
  snippetLength?: string;  // Parsed to number, default 200
  fullText?: boolean;
}
```

### 3.8 Text Chunk

```typescript
/**
 * A chunk of text produced by the chunker.
 */
export interface TextChunk {
  /** The chunk text content. */
  text: string;

  /** 0-based chunk index within the source document. */
  index: number;

  /** Character offset where this chunk starts in the original text. */
  startOffset: number;

  /** Character offset where this chunk ends in the original text. */
  endOffset: number;
}
```

---

## 4. CLI Command Structure

### 4.1 Commander.js Program Tree

```typescript
// src/index.ts

import { Command } from '@commander-js/extra-typings';

const program = new Command()
  .name('chromactl')
  .description('ChromaDB CLI management tool')
  .version(VERSION)
  .option('--db <path>', 'Override database directory path')
  .option('-v, --verbose', 'Enable verbose output')
  .option('-q, --quiet', 'Suppress non-essential output')
  .option('--json', 'Output as JSON');

// --- init ---
program.addCommand(
  new Command('init')
    .description('Initialize a new chromactl database')
    .option('--db <path>', 'Database directory (default: ./.chromactl)')
    .option('--force', 'Reinitialize if database already exists')
    .addHelpText('after', `
Examples:
  $ chromactl init
  $ chromactl init --db /tmp/mydb
  $ chromactl init --force`)
    .action(initAction)
);

// --- schema ---
const schemaCmd = new Command('schema')
  .description('Manage metadata schemas');

schemaCmd.addCommand(
  new Command('create')
    .argument('<name>', 'Schema name')
    .description('Create a new metadata schema')
    .option('--fields <json>', 'Schema fields as inline JSON')
    .option('--from-file <path>', 'Read schema from a JSON file')
    .addHelpText('after', `
Examples:
  $ chromactl schema create article --fields '{"author":{"type":"string","required":true},"year":{"type":"number","required":false}}'
  $ chromactl schema create article --from-file schema.json`)
    .action(schemaCreateAction)
);

schemaCmd.addCommand(
  new Command('list')
    .description('List all defined schemas')
    .action(schemaListAction)
);

schemaCmd.addCommand(
  new Command('show')
    .argument('<name>', 'Schema name')
    .description('Show details of a schema')
    .action(schemaShowAction)
);

schemaCmd.addCommand(
  new Command('delete')
    .argument('<name>', 'Schema name')
    .description('Delete a schema (must not be bound to a collection)')
    .action(schemaDeleteAction)
);

program.addCommand(schemaCmd);

// --- collection ---
const collectionCmd = new Command('collection')
  .description('Manage ChromaDB collections');

collectionCmd.addCommand(
  new Command('create')
    .argument('<name>', 'Collection name')
    .description('Create a new collection')
    .option('--schema <name>', 'Associate a metadata schema')
    .addHelpText('after', `
Examples:
  $ chromactl collection create papers
  $ chromactl collection create papers --schema article`)
    .action(collectionCreateAction)
);

collectionCmd.addCommand(
  new Command('list')
    .description('List all collections with document counts')
    .action(collectionListAction)
);

collectionCmd.addCommand(
  new Command('delete')
    .argument('<name>', 'Collection name')
    .description('Delete a collection and all its documents')
    .option('--confirm', 'Confirm deletion (required)')
    .addHelpText('after', `
Examples:
  $ chromactl collection delete papers --confirm`)
    .action(collectionDeleteAction)
);

collectionCmd.addCommand(
  new Command('info')
    .argument('<name>', 'Collection name')
    .description('Show detailed collection information')
    .action(collectionInfoAction)
);

program.addCommand(collectionCmd);

// --- index ---
const indexCmd = new Command('index')
  .description('Index documents into a collection');

const indexSharedOptions = (cmd: Command) => cmd
  .option('--collection <name>', 'Target collection (default: "default")')
  .option('--metadata <json>', 'Metadata key-value pairs as JSON')
  .option('--tag <value>', 'Add a "tag" metadata field')
  .option('--chunk-size <n>', 'Chunk size in characters (default: 1000)')
  .option('--chunk-overlap <n>', 'Chunk overlap in characters (default: 200)')
  .option('--no-chunking', 'Disable chunking; store entire document')
  .option('--dry-run', 'Preview what would be indexed');

indexSharedOptions(
  indexCmd.command('file')
    .argument('<path>', 'Path to the file to index')
    .description('Index a single document file')
    .addHelpText('after', `
Examples:
  $ chromactl index file README.md
  $ chromactl index file paper.pdf --collection papers --metadata '{"author":"Smith","year":2024}'
  $ chromactl index file report.docx --tag research`)
).action(indexFileAction);

indexSharedOptions(
  indexCmd.command('dir')
    .argument('<path>', 'Path to the directory to index')
    .description('Recursively index all supported files in a directory')
    .addHelpText('after', `
Examples:
  $ chromactl index dir ./docs
  $ chromactl index dir ./papers --collection papers --dry-run
  $ chromactl index dir . --tag project-docs`)
).action(indexDirAction);

program.addCommand(indexCmd);

// --- search ---
program.addCommand(
  new Command('search')
    .argument('<query>', 'Search query text')
    .description('Search documents by semantic similarity')
    .option('--collection <name>', 'Target collection (default: "default")')
    .option('-n, --results <number>', 'Number of results (default: 5, max: 50)')
    .option('--filter <json>', 'Metadata filter as JSON (ChromaDB where clause)')
    .option('--min-score <number>', 'Minimum similarity score (0.0 to 1.0)')
    .option('--snippet-length <number>', 'Snippet length in characters (default: 200)')
    .option('--full-text', 'Show full document text instead of snippet')
    .addHelpText('after', `
Examples:
  $ chromactl search "machine learning techniques"
  $ chromactl search "neural networks" -n 10 --collection papers
  $ chromactl search "deep learning" --filter '{"author":"Smith"}'
  $ chromactl search "query" --json | jq .`)
    .action(searchAction)
);

// --- stats ---
program.addCommand(
  new Command('stats')
    .argument('[collection]', 'Collection name (omit for database overview)')
    .description('Show database or collection statistics')
    .addHelpText('after', `
Examples:
  $ chromactl stats
  $ chromactl stats papers
  $ chromactl stats --json`)
    .action(statsAction)
);

// --- server ---
const serverCmd = new Command('server')
  .description('Manage the ChromaDB server process');

serverCmd.addCommand(
  new Command('start')
    .description('Start the ChromaDB server')
    .action(serverStartAction)
);

serverCmd.addCommand(
  new Command('stop')
    .description('Stop the ChromaDB server')
    .action(serverStopAction)
);

serverCmd.addCommand(
  new Command('status')
    .description('Show ChromaDB server status')
    .action(serverStatusAction)
);

program.addCommand(serverCmd);
```

### 4.2 Option Conflict Rules

- `--quiet` and `--verbose` are mutually exclusive. Commander.js `conflicts()` enforces this:
  ```typescript
  .option('-v, --verbose', 'Enable verbose output')
  .option('-q, --quiet', 'Suppress non-essential output')
  // In Commander: program.getOptionValue('verbose') && program.getOptionValue('quiet') -> error
  ```
  Enforcement: In the preAction hook, check if both are set and throw `InvalidArgumentError`.

- `--fields` and `--from-file` on `schema create` are mutually exclusive.

- `--full-text` and `--snippet-length` on `search` are compatible (snippet-length is ignored when full-text is set).

- `--no-chunking` overrides `--chunk-size` and `--chunk-overlap`.

### 4.3 preAction Hook Architecture

```typescript
// Commands that need the server running
const DB_COMMANDS = ['collection', 'index', 'search', 'stats'];

// Commands that only need config (no server)
const CONFIG_ONLY_COMMANDS = ['schema'];

// Commands that need nothing
const STANDALONE_COMMANDS = ['init', 'server'];

program.hook('preSubcommand', async (thisCommand, subcommand) => {
  const formatter = createFormatter({
    json: thisCommand.opts().json,
    quiet: thisCommand.opts().quiet,
    verbose: thisCommand.opts().verbose,
  });

  const cmdName = subcommand.name();

  if (STANDALONE_COMMANDS.includes(cmdName)) {
    // init and server handle their own config resolution
    subcommand.setOptionValue('_formatter', formatter);
    return;
  }

  // Resolve config
  const { configPath, config } = resolveConfig({
    db: thisCommand.opts().db,
    requireExisting: true,  // Throws ConfigNotFoundError
  });

  const projectDir = getProjectDir(configPath);

  if (CONFIG_ONLY_COMMANDS.includes(cmdName)) {
    // Schema commands only need config, not the server
    subcommand.setOptionValue('_context', {
      config, configPath, projectDir, formatter,
    } satisfies CommandContext);
    return;
  }

  // DB commands: ensure server is running
  const serverManager = new ServerManager({
    projectRoot: path.dirname(configPath),
    persistPath: getDbPath(config, path.dirname(configPath)),
    port: config.port,
    host: config.host,
  });

  const client = await serverManager.ensureRunning();

  subcommand.setOptionValue('_context', {
    config, configPath, projectDir, formatter, client,
  } satisfies CommandContext);
});
```

---

## 5. File Structure

```
/home/biks/workspace/test-team/
  package.json                          # Project metadata, dependencies, bin entry, scripts
  tsconfig.json                         # TypeScript strict config, ES2022, NodeNext
  eslint.config.js                      # ESLint flat config for TypeScript
  tsup.config.ts                        # Build: entry src/index.ts, format esm, node22, shebang
  .gitignore                            # node_modules, dist, .chromactl
  
  src/
    index.ts                            # CLI entry point: Commander program, global options,
                                        #   preAction hooks, command registration, signal handlers,
                                        #   top-level error handler
    
    types/
      index.ts                          # All shared TypeScript interfaces:
                                        #   ChromactlConfig, SchemaDefinition, FieldDefinition,
                                        #   ServerInfo, IndexResult, SearchResult, TextChunk,
                                        #   DatabaseStats, CollectionStats, CommandContext,
                                        #   GlobalOptions, InitOptions, IndexOptions, SearchOptions,
                                        #   SchemaCreateOptions, CollectionCreateOptions,
                                        #   CollectionDeleteOptions, MissingDependency,
                                        #   ValidationError, ValidationResult, FormatterOptions
    
    commands/
      init.ts                           # chromactl init [--db <path>] [--force]
                                        #   Creates .chromactl/ dir and chromactl.json
      
      schema.ts                         # chromactl schema create|list|show|delete
                                        #   All operations modify chromactl.json only
      
      collection.ts                     # chromactl collection create|list|delete|info
                                        #   CRUD via ChromaDB API, schema binding in config
      
      index-cmd.ts                      # chromactl index file|dir
                                        #   Orchestrates: extract -> chunk -> embed -> upsert
                                        #   Named index-cmd.ts to avoid conflict with index.ts
      
      search.ts                         # chromactl search <query>
                                        #   Embed query -> collection.query -> format results
      
      stats.ts                          # chromactl stats [collection]
                                        #   Database-level or collection-level statistics
      
      server.ts                         # chromactl server start|stop|status
                                        #   Explicit server management commands
    
    lib/
      config.ts                         # Configuration file management:
                                        #   findConfigFile, loadConfig, saveConfig,
                                        #   resolveConfig, getDefaultConfig, getDbPath
      
      server.ts                         # ServerManager class:
                                        #   ensureRunning, start, stop, getRunningServer, status
                                        #   PID file management, health checking, port detection
      
      db.ts                             # ChromaDB client wrapper:
                                        #   getOrCreateCollection, getCollection, createCollection,
                                        #   listCollections, deleteCollection, upsertDocuments,
                                        #   queryCollection, getAllDocuments, countDocuments
      
      extractor.ts                      # Text extraction from files:
                                        #   extractText, checkDependency, validateDependencies
                                        #   Dispatches to pdftotext, pandoc, or fs.readFile
      
      chunker.ts                        # Text chunking with overlap:
                                        #   chunkText, makeChunkId, makeSingleDocId
                                        #   Sentence/word boundary detection
      
      embedding.ts                      # EmbeddingManager class:
                                        #   ensureModel, generate, isModelCached
                                        #   Singleton pipeline, cache dir management
      
      schema-validator.ts               # Metadata schema validation:
                                        #   validateMetadata, parseSchemaInput,
                                        #   loadSchemaFromFile, validateSchemaDefinition
      
      output.ts                         # Formatter class:
                                        #   success, error, warn, info, verbose,
                                        #   table, json, raw
                                        #   NO_COLOR support, quiet/verbose modes
      
      errors.ts                         # Error class hierarchy:
                                        #   ChromactlError, ConfigNotFoundError, ServerError,
                                        #   ExtractionError, SchemaValidationError,
                                        #   DependencyError
                                        #   handleError function, exit codes
  
  tests/
    unit/
      config.test.ts                    # Config parsing, directory walk, env var, defaults
      output.test.ts                    # JSON mode, quiet, verbose, NO_COLOR
      errors.test.ts                    # Error messages, exit codes
      extractor.test.ts                 # Extension dispatch, dependency check, error handling
      chunker.test.ts                   # Chunk sizing, overlap, boundaries, edge cases
      schema-validator.test.ts          # Type validation, required fields, invalid input
      embedding.test.ts                 # Pipeline caching (mock), batch, cache dir
    
    integration/
      server.test.ts                    # Full start/stop cycle, reuse, port conflict
      indexing.test.ts                  # Init -> create collection -> index -> verify
      workflow.test.ts                  # Full end-to-end: init -> schema -> collection ->
                                        #   index -> search -> stats -> cleanup
  
  docs/
    design/
      refined-request-chromactl.md
      plan-001-chromactl-implementation.md
      project-design.md                 # This document
      project-functions.md              # Functional requirements
    reference/
      investigation-chromactl.md
    research/
      chromadb-server-lifecycle.md
      chromadb-collection-api.md
      chromadb-default-embed.md
```

---

## 6. Error Handling Strategy

### 6.1 Error Class Hierarchy

```typescript
// src/lib/errors.ts

/**
 * Base error class for all chromactl errors.
 * Every error has an exit code and a user-facing message.
 */
export class ChromactlError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'ChromactlError';
  }
}

/**
 * No chromactl.json found in the directory tree.
 */
export class ConfigNotFoundError extends ChromactlError {
  constructor(searchedFrom?: string) {
    super(
      'No chromactl database found.' +
        (searchedFrom ? ` Searched from: ${searchedFrom}` : ''),
      1,
      "Run 'chromactl init' to create a new database.",
    );
    this.name = 'ConfigNotFoundError';
  }
}

/**
 * ChromaDB server management errors.
 */
export class ServerError extends ChromactlError {
  constructor(message: string, hint?: string) {
    super(message, 2, hint);
    this.name = 'ServerError';
  }
}

/**
 * Text extraction failures (corrupt file, timeout, encoding error).
 */
export class ExtractionError extends ChromactlError {
  constructor(
    public readonly filePath: string,
    message: string,
    hint?: string,
  ) {
    super(`Failed to extract text from ${filePath}: ${message}`, 3, hint);
    this.name = 'ExtractionError';
  }
}

/**
 * Missing system dependency (pdftotext, pandoc).
 */
export class DependencyError extends ChromactlError {
  constructor(
    public readonly tool: string,
    public readonly installHint: string,
  ) {
    super(
      `Required tool '${tool}' is not installed.`,
      4,
      `Install it with: ${installHint}`,
    );
    this.name = 'DependencyError';
  }
}

/**
 * Metadata does not conform to the schema.
 */
export class SchemaValidationError extends ChromactlError {
  constructor(
    public readonly validationErrors: Array<{ field: string; message: string }>,
  ) {
    const details = validationErrors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    super(`Schema validation failed:\n${details}`, 5);
    this.name = 'SchemaValidationError';
  }
}

/**
 * Invalid argument or JSON parsing error.
 */
export class InvalidArgumentError extends ChromactlError {
  constructor(message: string, hint?: string) {
    super(message, 6, hint);
    this.name = 'InvalidArgumentError';
  }
}

/**
 * Collection not found.
 */
export class CollectionNotFoundError extends ChromactlError {
  constructor(name: string) {
    super(
      `Collection '${name}' does not exist.`,
      7,
      `Run 'chromactl collection list' to see available collections.`,
    );
    this.name = 'CollectionNotFoundError';
  }
}

/**
 * Schema not found.
 */
export class SchemaNotFoundError extends ChromactlError {
  constructor(name: string) {
    super(
      `Schema '${name}' does not exist.`,
      7,
      `Run 'chromactl schema list' to see available schemas.`,
    );
    this.name = 'SchemaNotFoundError';
  }
}
```

### 6.2 Exit Code Map

| Code | Meaning | Error Class |
|------|---------|-------------|
| 0 | Success | - |
| 1 | Configuration error (no DB, malformed config, already exists) | `ConfigNotFoundError`, `ChromactlError` |
| 2 | Server error (start failure, port conflict, connection lost) | `ServerError` |
| 3 | Extraction error (corrupt file, timeout, encoding) | `ExtractionError` |
| 4 | Missing dependency (pdftotext, pandoc not installed) | `DependencyError` |
| 5 | Schema validation error (required fields missing, type mismatch) | `SchemaValidationError` |
| 6 | Invalid argument (bad JSON, out-of-range value) | `InvalidArgumentError` |
| 7 | Resource not found (collection, schema) | `CollectionNotFoundError`, `SchemaNotFoundError` |

### 6.3 Top-Level Error Handler

```typescript
// In src/index.ts

export function handleError(error: unknown, formatter: Formatter): never {
  if (error instanceof ChromactlError) {
    formatter.error(error.message);
    if (error.hint) {
      formatter.info(`Hint: ${error.hint}`);
    }
    process.exit(error.exitCode);
  }

  if (error instanceof Error) {
    // Wrap known ChromaDB errors
    if (error.constructor.name === 'ChromaConnectionError') {
      formatter.error(`ChromaDB server connection failed: ${error.message}`);
      formatter.info('Hint: Run \'chromactl server start\' or check if the server is running.');
      process.exit(2);
    }
    if (error.constructor.name === 'ChromaNotFoundError') {
      formatter.error(error.message);
      process.exit(7);
    }

    // Unknown error
    formatter.error(`Unexpected error: ${error.message}`);
    if (formatter.isVerbose) {
      console.error(error.stack);
    }
    process.exit(1);
  }

  // Non-Error thrown
  formatter.error(`Unexpected error: ${String(error)}`);
  process.exit(1);
}
```

### 6.4 Error Handling per Context

| Context | Strategy |
|---------|----------|
| Single file index | Throw error, print message, exit with appropriate code |
| Directory index (batch) | Catch per-file errors, add to `IndexResult.errors`, continue processing remaining files. Print summary at end. Exit 0 if any files succeeded, exit 3 if all failed. |
| Search with no results | Not an error. Print "No results found." and exit 0. |
| Server already running | `ensureRunning()` reuses the existing server -- not an error. |
| Server not running (for stop) | `server stop` prints "No server running." and exits 0. |
| Config already exists (init) | Exit 1 with warning unless `--force`. |

---

## 7. Configuration Discovery

### 7.1 Discovery Algorithm

```
resolveConfig(options):
  
  Priority 1: --db <path> CLI flag
    if options.db is set:
      configPath = path.resolve(options.db, 'chromactl.json')
      if file exists: return { configPath, config: loadConfig(configPath) }
      if requireExisting: throw ConfigNotFoundError
      return { configPath, config: getDefaultConfig() }
  
  Priority 2: CHROMACTL_DB environment variable
    if process.env.CHROMACTL_DB is set:
      configPath = path.resolve(process.env.CHROMACTL_DB, 'chromactl.json')
      if file exists: return { configPath, config: loadConfig(configPath) }
      if requireExisting: throw ConfigNotFoundError
      return { configPath, config: getDefaultConfig() }
  
  Priority 3: Walk up from cwd
    result = findConfigFile(process.cwd())
    if result is not null:
      return { configPath: result, config: loadConfig(result) }
  
  Priority 4: Default location
    configPath = path.resolve(process.cwd(), 'chromactl.json')
    if file exists: return { configPath, config: loadConfig(configPath) }
    if requireExisting: throw ConfigNotFoundError(process.cwd())
    return { configPath, config: getDefaultConfig() }
```

### 7.2 Directory Walk (`findConfigFile`)

```
findConfigFile(startDir):
  dir = path.resolve(startDir)
  
  loop:
    candidate = path.join(dir, 'chromactl.json')
    if fs.existsSync(candidate):
      return candidate
    
    parent = path.dirname(dir)
    if parent === dir:      // Reached filesystem root
      return null
    dir = parent
```

### 7.3 Path Resolution

All paths in `chromactl.json` are relative to the config file's directory. When the config is loaded, paths are resolved to absolute:

```typescript
function getDbPath(config: ChromactlConfig, configDir: string): string {
  return path.resolve(configDir, config.dbPath);
}
```

The `configDir` is always `path.dirname(configPath)`.

### 7.4 Project Directory Structure

After `chromactl init`, the directory structure is:

```
project-root/               # Where user runs chromactl init
  chromactl.json             # Configuration file
  .chromactl/                # Data directory (gitignored)
    chroma-data/             # ChromaDB persistence directory
    server.json              # PID file (runtime only)
    models/                  # ONNX model cache
      Xenova/
        all-MiniLM-L6-v2/
          onnx/
            model.onnx       # ~91 MB (fp32) or ~24 MB (uint8)
          config.json
          tokenizer.json
          ...
```

---

## 8. Server Lifecycle

### 8.1 State Machine

```
                            +-------------------+
                            |                   |
                            |    NOT RUNNING    |<---------+
                            |                   |          |
                            +--------+----------+          |
                                     |                     |
                           ensureRunning() or              |
                           server start                    |
                                     |                     |
                                     v                     |
                            +-------------------+          |
                            |                   |          |
                            |    STARTING       |          |
                            |  (spawning +      |          |
                            |   polling)        |          |
                            |                   |          |
                            +--------+----------+          |
                                     |                     |
                    +----------------+----------------+    |
                    |                                  |    |
              heartbeat OK                     early exit   |
              (ready)                          or timeout   |
                    |                                  |    |
                    v                                  v    |
           +-------------------+            +----------+---+
           |                   |            |              |
           |    RUNNING        |            |  START       |
           |  (PID file        |            |  FAILED      |
           |   written,        |            |  (throw      |
           |   server detached)|            |   ServerError|
           |                   |            +--------------+
           +--------+----------+
                    |
          server stop or
          SIGTERM/SIGKILL
                    |
                    v
           +-------------------+
           |                   |
           |    STOPPING       |
           |  (SIGTERM sent,   |
           |   waiting up to   |
           |   10s)            |
           |                   |
           +--------+----------+
                    |
         +----------+----------+
         |                     |
   process exits          timeout (10s)
   gracefully             |
         |                v
         |          SIGKILL sent
         |                |
         v                v
  +-------------------+
  |                   |
  |    STOPPED        |
  |  (PID file        |
  |   deleted)        |
  |                   |
  +-------------------+
```

### 8.2 Server Validation (Three-Tier)

When checking if a server is already running:

```
Tier 1: PID File Check
  - Read .chromactl/server.json
  - If file does not exist -> NOT RUNNING

Tier 2: Process Alive Check
  - process.kill(pid, 0)   // Signal 0 = existence check only
  - If ESRCH (no such process) -> STALE PID, delete file, NOT RUNNING
  - If EPERM (permission denied) -> process exists (owned by another user)

Tier 3: Heartbeat Check
  - HTTP GET http://{host}:{port}/api/v2/heartbeat
  - Timeout: 3 seconds
  - If response.ok -> RUNNING (return ServerInfo)
  - If connection refused -> PID collision (another process reused the PID)
      -> Delete stale PID file, NOT RUNNING
```

### 8.3 Server Spawn Sequence

```
1. Validate port availability
   - net.createServer().listen(port, host) test
   - If port in use:
     a. Check if a ChromaDB server is on that port (heartbeat)
     b. If yes: "A ChromaDB server is already running on {host}:{port} (not managed by chromactl)"
     c. If no: "Port {port} is in use by another process"

2. Resolve ChromaDB binary
   - createRequire(import.meta.url).resolve('chromadb/package.json')
   - Join path.dirname(pkgPath) + '/dist/cli.mjs'

3. Spawn server process
   - child_process.spawn(process.execPath, [cliBinary, 'run', ...args])
   - stdio: ['ignore', 'pipe', 'pipe']
   - detached: true
   - env: { ...process.env, CHROMADB_VERSION: '999.999.999' }

4. Race: readiness vs early exit
   - readiness: poll heartbeat with exponential backoff
   - early exit: listen for 'exit' event on child process
   - Capture stderr for error diagnosis

5. Write PID file
   - { pid, port, host, startedAt, persistPath }

6. Detach process
   - proc.unref(), proc.stdout?.unref?.(), proc.stderr?.unref?.()
   - Remove 'exit' and 'data' listeners
```

### 8.4 Commands That Use the Server

| Command | Needs Server | Notes |
|---------|-------------|-------|
| `init` | No | Creates config files only |
| `schema *` | No | Modifies chromactl.json only |
| `collection *` | Yes | CRUD via ChromaDB API |
| `index *` | Yes | Upsert documents |
| `search` | Yes | Query documents |
| `stats` | Yes | Count/get documents |
| `server start` | Starts it | Explicit start |
| `server stop` | Stops it | Explicit stop |
| `server status` | No | Reads PID file + heartbeat check |

---

## 9. Embedding Pipeline

### 9.1 Singleton Pattern

```
+--------------------------------------------------+
|            EmbeddingManager                       |
|                                                   |
|  State:                                           |
|    pipelineInstance: Pipeline | null               |
|    loadingPromise: Promise<Pipeline> | null        |
|                                                   |
|  Lifecycle:                                       |
|    1. First call to generate() or ensureModel()   |
|       -> loadingPromise = pipeline(...)            |
|       -> pipelineInstance = await loadingPromise   |
|    2. Subsequent calls                            |
|       -> Reuses pipelineInstance (no reload)       |
|    3. Process exit                                |
|       -> Pipeline GC'd (no explicit cleanup)      |
|                                                   |
|  Thread Safety:                                   |
|    - loadingPromise ensures single initialization |
|    - Multiple concurrent generate() calls share   |
|      the same promise during initialization       |
+--------------------------------------------------+
```

### 9.2 Cache Directory Management

```
Cache directory: .chromactl/models/
Set via: env.cacheDir = path.join(projectDir, 'models')

Must be set BEFORE first pipeline() call.

Contents after first download:
  .chromactl/models/
    Xenova/
      all-MiniLM-L6-v2/
        onnx/
          model.onnx          # 90.4 MB (fp32) or 22.8 MB (uint8)
        config.json
        tokenizer.json
        tokenizer_config.json
        special_tokens_map.json
        vocab.txt

Persistence:
  - Survives node_modules reinstalls (outside node_modules)
  - Survives chromactl version upgrades
  - Shared within a project (single .chromactl/models/ per project)
  - NOT shared across projects (each project has its own)
```

### 9.3 Batch Embedding Flow

```
index dir ./docs  (15 files, total 45 chunks)

Phase 1: Extract text (concurrent, up to 5 parallel)
  -> 15 text strings

Phase 2: Chunk all texts (synchronous, fast)
  -> 45 TextChunk objects

Phase 3: Batch embed (single call to EmbeddingManager)
  If chunks <= 100:
    embeddings = await manager.generate(allChunkTexts)
    // Single pipeline call, all 45 texts in one batch
  
  If chunks > 100:
    // Split into batches of 100 to avoid memory pressure
    for batch in chunks.splitEvery(100):
      batchEmbeddings = await manager.generate(batch.texts)
      embeddings.push(...batchEmbeddings)

Phase 4: Upsert to ChromaDB (sequential, per file)
  for each file:
    collection.upsert({
      ids: file.chunkIds,
      documents: file.chunkTexts,
      embeddings: file.chunkEmbeddings,
      metadatas: file.chunkMetadatas,
    })
```

### 9.4 First-Run Download Experience

```
$ chromactl index file README.md

Downloading embedding model (first run only)...
  Downloading model.onnx    [========>            ] 45% (41/91 MB)
  Downloading tokenizer.json [====================] 100%
  Downloading config.json    [====================] 100%

Model downloaded and cached at .chromactl/models/
Indexing README.md...
  Extracted 1,234 characters
  Created 2 chunks
  Generated embeddings (384 dimensions)
  Upserted to collection "default"

Indexed 1 file, created 2 chunks.
```

On subsequent runs, the model loads from disk cache (~1-3s, no download):

```
$ chromactl index file another.md
Indexing another.md...
  Extracted 567 characters
  Created 1 chunk
  Generated embeddings
  Upserted to collection "default"

Indexed 1 file, created 1 chunk.
```

---

## 10. Text Extraction Pipeline

### 10.1 Extension-to-Strategy Map

```typescript
const EXTRACTION_STRATEGIES: Record<string, ExtractionStrategy> = {
  '.txt':  { method: 'fs',      tool: null,        args: [] },
  '.md':   { method: 'fs',      tool: null,        args: [] },
  '.pdf':  { method: 'exec',    tool: 'pdftotext', args: (f) => [f, '-'] },
  '.docx': { method: 'exec',    tool: 'pandoc',    args: (f) => [f, '-t', 'plain'] },
  '.html': { method: 'exec',    tool: 'pandoc',    args: (f) => [f, '-t', 'plain'] },
};
```

### 10.2 Async Extraction Flow

```
extractText(filePath):
  ext = path.extname(filePath).toLowerCase()
  
  if ext not in EXTRACTION_STRATEGIES:
    throw ExtractionError(filePath, `Unsupported file type: ${ext}`)
  
  strategy = EXTRACTION_STRATEGIES[ext]
  
  if strategy.method === 'fs':
    return fs.readFile(filePath, 'utf-8')
  
  if strategy.method === 'exec':
    // Check tool is installed (cached per process)
    toolPath = await checkDependency(strategy.tool)
    if toolPath is null:
      throw DependencyError(strategy.tool, installHint)
    
    try:
      { stdout } = await execFile(strategy.tool, strategy.args(filePath), {
        maxBuffer: 10 * 1024 * 1024,  // 10 MB
        timeout: 30_000,               // 30 seconds
        encoding: 'utf-8',
      })
      return stdout
    catch (error):
      if error.killed (timeout):
        throw ExtractionError(filePath, 'Extraction timed out after 30 seconds')
      if error.code === 'ENOENT':
        throw ExtractionError(filePath, 'File not found')
      throw ExtractionError(filePath, error.message)
```

### 10.3 Tool Detection

```typescript
// Cache dependency checks per process (tool won't appear/disappear mid-run)
const dependencyCache = new Map<string, string | null>();

async function checkDependency(toolName: string): Promise<string | null> {
  if (dependencyCache.has(toolName)) {
    return dependencyCache.get(toolName)!;
  }

  try {
    const { stdout } = await execFile('which', [toolName]);
    const toolPath = stdout.trim();
    dependencyCache.set(toolName, toolPath);
    return toolPath;
  } catch {
    dependencyCache.set(toolName, null);
    return null;
  }
}
```

### 10.4 Error Handling per Format

| Format | Error Scenario | Handling |
|--------|---------------|----------|
| `.txt`/`.md` | File not found | `ENOENT` -> `ExtractionError` |
| `.txt`/`.md` | Encoding error | `fs.readFile` with `utf-8` -- binary files produce garbled text but don't throw. No explicit detection for v1. |
| `.pdf` | pdftotext not installed | `DependencyError('pdftotext', 'apt install poppler-utils')` |
| `.pdf` | Corrupt PDF | pdftotext returns non-zero exit code -> `ExtractionError` with the tool's stderr |
| `.pdf` | Scanned PDF (no text) | pdftotext returns empty string -> Not an error; produces empty document. Warning in verbose mode. |
| `.pdf` | File too large (> 10 MB output) | `maxBuffer` exceeded -> `ExtractionError('Output exceeds 10 MB limit')` |
| `.pdf` | Extraction timeout | `timeout: 30000` triggered -> `ExtractionError('Extraction timed out after 30 seconds')` |
| `.docx` | pandoc not installed | `DependencyError('pandoc', 'apt install pandoc')` |
| `.docx` | Corrupt DOCX | pandoc returns non-zero -> `ExtractionError` with stderr |
| `.html` | pandoc not installed | Same as DOCX |
| `.html` | Malformed HTML | pandoc handles gracefully (outputs whatever it can parse) |

### 10.5 Batch Dependency Validation

Before processing a directory, validate all needed tools upfront:

```typescript
async function validateDependencies(extensions: string[]): Promise<MissingDependency[]> {
  const needed = new Map<string, string[]>();  // tool -> extensions that need it

  for (const ext of extensions) {
    const strategy = EXTRACTION_STRATEGIES[ext];
    if (strategy?.tool) {
      const existing = needed.get(strategy.tool) || [];
      existing.push(ext);
      needed.set(strategy.tool, existing);
    }
  }

  const missing: MissingDependency[] = [];

  for (const [tool, exts] of needed) {
    const found = await checkDependency(tool);
    if (!found) {
      missing.push({
        tool,
        requiredFor: exts.join(', ') + ' files',
        installHint: INSTALL_HINTS[tool] || `Install '${tool}'`,
      });
    }
  }

  return missing;
}

const INSTALL_HINTS: Record<string, string> = {
  pdftotext: 'apt install poppler-utils',
  pandoc: 'apt install pandoc',
};
```

If `validateDependencies` returns non-empty, the `index dir` command prints all missing tools and exits before processing any files:

```
Error: Missing required tools:
  - pdftotext (needed for .pdf files)
    Install with: apt install poppler-utils
  - pandoc (needed for .docx, .html files)
    Install with: apt install pandoc
```

---

## Appendix A: Module Dependency Graph

```
src/index.ts (entry point)
  |-- src/commands/init.ts
  |     |-- src/lib/config.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/schema.ts
  |     |-- src/lib/config.ts
  |     |-- src/lib/schema-validator.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/collection.ts
  |     |-- src/lib/config.ts
  |     |-- src/lib/db.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/index-cmd.ts
  |     |-- src/lib/config.ts
  |     |-- src/lib/db.ts
  |     |-- src/lib/extractor.ts
  |     |-- src/lib/chunker.ts
  |     |-- src/lib/embedding.ts
  |     |-- src/lib/schema-validator.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/search.ts
  |     |-- src/lib/db.ts
  |     |-- src/lib/embedding.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/stats.ts
  |     |-- src/lib/db.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/commands/server.ts
  |     |-- src/lib/server.ts
  |     |-- src/lib/config.ts
  |     |-- src/lib/output.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/server.ts
  |     |-- chromadb (ChromaClient)
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/config.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/db.ts
  |     |-- chromadb (ChromaClient, Collection, IncludeEnum)
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/extractor.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/chunker.ts
  |     |-- (no internal deps)
  |
  |-- src/lib/embedding.ts
  |     |-- @huggingface/transformers
  |
  |-- src/lib/schema-validator.ts
  |     |-- src/lib/errors.ts
  |
  |-- src/lib/output.ts
  |     |-- chalk
  |
  |-- src/lib/errors.ts
  |     |-- (no internal deps)
  |
  |-- src/types/index.ts
        |-- (no deps, pure type definitions)
```

No circular dependencies exist. The dependency direction flows:
- `commands/*` -> `lib/*` -> `types/*`
- `lib/*` modules do not depend on `commands/*`
- `lib/*` modules may depend on other `lib/*` modules (e.g., `config` uses `errors`)
- `types/*` has no dependencies

---

## Appendix B: Concurrency Strategy for Directory Indexing

```typescript
/**
 * Process files with bounded concurrency.
 * 
 * @param files - Array of file paths to process
 * @param processor - Async function to process each file
 * @param concurrency - Maximum concurrent operations (default: 5)
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

  // Start `concurrency` workers
  const workers = Array.from({ length: Math.min(concurrency, files.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
```

Usage in `index dir`:

```typescript
// Phase 1: Extract text (concurrent)
const extractionResults = await processWithConcurrency(
  filePaths,
  async (filePath, index) => {
    formatter.info(`[${index + 1}/${filePaths.length}] Extracting ${path.basename(filePath)}...`);
    const text = await extractText(filePath);
    return text;
  },
  5,  // max 5 concurrent extractions
);

// Phase 2: Chunk (synchronous, fast)
const allChunks = extractionResults
  .filter(r => r.result !== undefined)
  .flatMap(r => {
    const chunks = chunkText(r.result!, chunkOptions);
    return chunks.map(chunk => ({
      ...chunk,
      filePath: r.file,
    }));
  });

// Phase 3: Embed (single batch or batches of 100)
const allTexts = allChunks.map(c => c.text);
const allEmbeddings = await embeddingManager.generate(allTexts);

// Phase 4: Upsert (sequential, grouped by file)
// Group chunks by file, upsert each file's chunks in one call
```

---

## Appendix C: Signal Handling

```typescript
// In src/index.ts, registered before program.parse()

function registerSignalHandlers(): void {
  // SIGINT (Ctrl+C): clean exit
  process.on('SIGINT', () => {
    // Note: we do NOT stop the server on Ctrl+C.
    // The server is designed to persist between commands.
    process.exit(130);  // 128 + signal number (2)
  });

  // SIGTERM: clean exit
  process.on('SIGTERM', () => {
    process.exit(143);  // 128 + signal number (15)
  });

  // Unhandled rejection: log and exit
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
    process.exit(1);
  });
}
```

Note: The ChromaDB server is NOT stopped when the CLI process exits. The server is intentionally left running (hybrid pattern) for fast subsequent commands. Only `chromactl server stop` explicitly stops it.
