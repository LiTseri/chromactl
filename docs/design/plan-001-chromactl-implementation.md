# Implementation Plan: chromactl CLI Tool

**Plan ID:** PLAN-001
**Created:** 2026-06-26
**Status:** Draft
**Source:** `docs/design/refined-request-chromactl.md`, `docs/reference/investigation-chromactl.md`, research documents

---

## Open Questions Requiring User Decision

Before implementation begins, the following ambiguities need resolution:

1. **Embedding dtype: `fp32` vs `uint8`?**
   The default `fp32` model is 91 MB; `uint8` (quantized) is 24 MB with minimal quality loss. Recommendation: use `uint8` for faster first-run download. Does the user agree, or is `fp32` quality preferred?

2. **`CHROMACTL_DB` environment variable?**
   The spec mentions `--db` flag and config file discovery by walking up directories. Should we also support a `CHROMACTL_DB` environment variable override? Recommendation: yes, as a low-effort convenience.

3. **Interactive schema input?**
   FR-2.6 specifies interactive prompts for schema creation when no `--fields` or `--from-file` is provided. Interactive prompts add complexity (readline, TTY detection). Recommendation: defer interactive prompts to a future phase, require `--fields` or `--from-file` in v1.

4. **Collection delete interactive confirmation?**
   FR-3.4 specifies interactive confirmation when `--confirm` is absent. Same concern as above. Recommendation: require `--confirm` flag for v1, add interactive prompt later.

5. **Custom embedding cache directory?**
   The ONNX model cache defaults to inside `node_modules`. Should we relocate it to `.chromactl/models/` for persistence across `node_modules` rebuilds? Recommendation: yes, set `env.cacheDir` to the project's `.chromactl/models/`.

6. **Should `chromactl init` auto-start the server and download the model?**
   Starting the server during init validates the setup immediately. Downloading the model means the first `index` command is faster. Recommendation: no -- keep init lightweight (just config file creation). Server starts on first use; model downloads on first embedding.

---

## Architecture Overview

```
chromactl CLI (Node.js process)
  |
  |-- Commander.js (command routing, option parsing)
  |-- ServerManager (start/stop/health-check ChromaDB server)
  |     |-- spawns: node <chromadb>/dist/cli.mjs run --path <dir> --port 8100
  |     |-- PID file: .chromactl/server.json
  |
  |-- ChromaClient (HTTP to localhost:8100)
  |     |-- collection CRUD
  |     |-- document add/upsert/query/get
  |
  |-- EmbeddingManager (client-side embedding via @huggingface/transformers)
  |     |-- pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2")
  |     |-- singleton pattern (pipeline cached in memory)
  |     |-- cache dir: .chromactl/models/ (persists across npm installs)
  |
  |-- TextExtractor (shells out to pdftotext, pandoc, or reads fs)
  |-- Chunker (character-based text splitting with overlap)
  |-- SchemaValidator (validates metadata against schemas in chromactl.json)
  |-- ConfigManager (reads/writes chromactl.json, walks up to discover)
  |-- OutputFormatter (text/JSON output, color via chalk, NO_COLOR support)
```

### Key Architectural Insight: Client-Side Embeddings

Embeddings run in the chromactl Node.js process, NOT on the ChromaDB server. This means:
- `@chroma-core/default-embed` must be a direct dependency of chromactl
- The ONNX model (~24-91 MB) is downloaded on first use
- Pipeline caching is critical (the upstream `DefaultEmbeddingFunction` re-loads the model on every call)
- Batch embedding calls to amortize model loading cost

### Key Architectural Insight: Managed Server

The ChromaDB JS client requires a running server. chromactl uses the **hybrid pattern**:
- Auto-start the server on first DB command (if not already running)
- Keep the server running between commands (PID file at `.chromactl/server.json`)
- Provide `chromactl server stop` and `chromactl server status` for explicit control
- Default port 8100 (to avoid conflicts with standalone ChromaDB on 8000)

---

## Phase Overview

| Phase | Name | Dependencies | Parallelizable With | Estimated Effort |
|-------|------|-------------|---------------------|-----------------|
| 0 | Project Scaffold | None | None | Small |
| 1 | Core Infrastructure | Phase 0 | None | Medium |
| 2 | Server Lifecycle | Phase 0 | Phase 1 (partially) | Medium |
| 3 | Init + Config | Phases 1, 2 | None | Small |
| 4 | Schema Management | Phase 3 | Phase 5 | Small |
| 5 | Collection Management | Phase 3 | Phase 4 | Small |
| 6 | Text Extraction + Chunking | Phase 0 | Phases 1-5 | Medium |
| 7 | Embedding Manager | Phase 0 | Phases 1-6 | Small |
| 8 | Document Indexing | Phases 3, 5, 6, 7 | None | Large |
| 9 | Search | Phases 3, 5, 7 | Phase 8 | Medium |
| 10 | Statistics | Phases 3, 5 | Phases 8, 9 | Small |
| 11 | Polish + Integration Tests | All prior phases | None | Medium |

### Parallelization Strategy

```
Phase 0 (scaffold)
  |
  +---> Phase 1 (core infra) ----+
  |                               |
  +---> Phase 2 (server) --------+--> Phase 3 (init/config)
  |                                     |
  +---> Phase 6 (extraction/chunk) --+  +--> Phase 4 (schema)  --+
  |                                  |  |                         |
  +---> Phase 7 (embedding mgr) ----+  +--> Phase 5 (collection)-+--> Phase 8 (indexing)
                                                                  |
                                                                  +--> Phase 9 (search)
                                                                  |
                                                                  +--> Phase 10 (stats)
                                                                  |
                                                                  +--> Phase 11 (polish)
```

Phases 1, 2, 6, and 7 can proceed in parallel after Phase 0.
Phases 4 and 5 can proceed in parallel after Phase 3.
Phases 9 and 10 can proceed in parallel after Phase 5.

---

## Phase 0: Project Scaffold

### Objective
Set up the project directory structure, package.json, TypeScript config, ESLint config, and build tooling.

### Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Project metadata, dependencies, scripts, bin entry |
| `tsconfig.json` | TypeScript configuration (strict, ES2022, Node22) |
| `eslint.config.js` | ESLint flat config for TypeScript |
| `tsup.config.ts` | Build configuration for tsup |
| `.gitignore` | Ignore node_modules, dist, .chromactl |
| `src/index.ts` | CLI entry point (stub) |
| `src/types/index.ts` | Shared type definitions (stub) |

### Dependencies to Install

**Runtime:**
- `chromadb` ^3.4.3
- `@chroma-core/default-embed` ^0.1.9
- `commander` ^15.0.0
- `@commander-js/extra-typings` (matching commander version)
- `chalk` ^5.6.2
- `ora` (latest)

**Dev:**
- `typescript` ^5.x
- `tsup` ^8.5.1
- `tsx` ^4.22.4
- `eslint` ^9.x
- `@typescript-eslint/eslint-plugin`
- `@typescript-eslint/parser`
- `vitest` (latest, for unit/integration tests)

### package.json Key Fields

```json
{
  "name": "chromactl",
  "type": "module",
  "bin": { "chromactl": "./dist/index.js" },
  "scripts": {
    "build": "tsup",
    "dev": "tsx src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src/",
    "typecheck": "tsc --noEmit"
  }
}
```

### tsconfig.json Key Settings

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

### tsup.config.ts Key Settings

```typescript
{
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false,
  shims: true,
  banner: { js: '#!/usr/bin/env node' }
}
```

### Acceptance Criteria
- [ ] `pnpm install` completes without errors
- [ ] `pnpm run build` produces `dist/index.js` with shebang
- [ ] `pnpm run dev` executes `src/index.ts` without errors
- [ ] `pnpm run typecheck` passes
- [ ] `pnpm run lint` passes
- [ ] `node dist/index.js --version` prints a version number

### Verification Commands
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run lint
node dist/index.js --version
```

---

## Phase 1: Core Infrastructure

### Objective
Build the foundational modules that all commands depend on: configuration management, output formatting, type definitions.

### Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/types/index.ts` | All shared TypeScript types (ChromactlConfig, SchemaDefinition, etc.) |
| `src/lib/config.ts` | Configuration file discovery, reading, writing |
| `src/lib/output.ts` | Output formatting (text tables, JSON, colors, verbosity) |
| `src/lib/errors.ts` | Custom error classes, error formatting, exit codes |

### Detailed Design

#### `src/types/index.ts`

```typescript
// Configuration file shape (chromactl.json)
export interface ChromactlConfig {
  version: string;                    // "1.0"
  dbPath: string;                     // relative path to chroma data
  defaultCollection: string;          // "default"
  port: number;                       // 8100
  host: string;                       // "localhost"
  chunkSize: number;                  // 1000
  chunkOverlap: number;              // 200
  schemas: Record<string, SchemaDefinition>;
  collectionSchemas: Record<string, string>; // collection name -> schema name
}

export interface SchemaDefinition {
  fields: Record<string, FieldDefinition>;
}

export interface FieldDefinition {
  type: 'string' | 'number' | 'boolean';
  required: boolean;
}

export interface IndexResult {
  filesProcessed: number;
  chunksCreated: number;
  filesSkipped: { path: string; reason: string }[];
  errors: { path: string; error: string }[];
}

export interface SearchResult {
  rank: number;
  similarity: number;
  sourcePath: string;
  chunkIndex?: number;
  snippet: string;
  fullText?: string;
  metadata: Record<string, string | number | boolean>;
}
```

#### `src/lib/config.ts`

- `findConfigFile(startDir: string): string | null` -- walk up directories looking for `chromactl.json`
- `loadConfig(configPath: string): ChromactlConfig` -- read and parse
- `saveConfig(configPath: string, config: ChromactlConfig): void` -- write atomically
- `resolveConfig(options: { db?: string }): { configPath: string; config: ChromactlConfig }` -- resolve from --db flag, `CHROMACTL_DB` env var, or directory walk
- `getDefaultConfig(): ChromactlConfig` -- returns defaults
- `getDbPath(config: ChromactlConfig, configDir: string): string` -- resolves relative dbPath to absolute

#### `src/lib/output.ts`

- `createFormatter(options: { json?: boolean; quiet?: boolean; verbose?: boolean }): Formatter`
- `Formatter.success(message: string): void`
- `Formatter.error(message: string): void`
- `Formatter.warn(message: string): void`
- `Formatter.info(message: string): void`
- `Formatter.verbose(message: string): void`
- `Formatter.table(headers: string[], rows: string[][]): void`
- `Formatter.json(data: unknown): void`
- Respects `NO_COLOR` env var and `--quiet` / `--verbose` flags

#### `src/lib/errors.ts`

- `ChromactlError` -- base error class with exit code
- `ConfigNotFoundError` -- "No chromactl database found. Run 'chromactl init' first."
- `ServerError` -- server start/stop failures
- `ExtractionError` -- text extraction failures
- `SchemaValidationError` -- metadata schema violations
- `DependencyError` -- missing system tools (pdftotext, pandoc)
- `handleError(error: unknown, formatter: Formatter): never` -- top-level error handler

### Acceptance Criteria
- [ ] `loadConfig` correctly parses a valid `chromactl.json`
- [ ] `findConfigFile` walks up directories and returns null when not found
- [ ] `resolveConfig` respects `--db` > `CHROMACTL_DB` env > directory walk > default
- [ ] Formatter produces colored output when terminal supports it
- [ ] Formatter suppresses output when `--quiet` is set
- [ ] Formatter produces JSON when `--json` is set
- [ ] All error classes have meaningful messages and non-zero exit codes
- [ ] `NO_COLOR=1` disables color output

### Verification Commands
```bash
pnpm run typecheck
pnpm run test -- --grep "config|output|error"
```

### Unit Tests

| Test File | Tests |
|-----------|-------|
| `tests/unit/config.test.ts` | Config parsing, directory walk, default values, env var resolution |
| `tests/unit/output.test.ts` | JSON mode, quiet mode, verbose mode, NO_COLOR |
| `tests/unit/errors.test.ts` | Error messages, exit codes |

---

## Phase 2: Server Lifecycle Management

### Objective
Build the `ServerManager` module that transparently manages the ChromaDB server process.

### Files to Create

| File | Purpose |
|------|---------|
| `src/lib/server.ts` | ServerManager class -- start, stop, health check, PID management |
| `src/commands/server.ts` | `chromactl server start`, `chromactl server stop`, `chromactl server status` commands |

### Detailed Design

#### `src/lib/server.ts` -- `ServerManager` Class

Based on the research document (`docs/research/chromadb-server-lifecycle.md`), Section 8 provides a production-ready reference implementation. Key methods:

- `constructor(config: { projectRoot: string; persistPath: string; port: number; host: string })`
- `ensureRunning(): Promise<ChromaClient>` -- start if not running, return connected client
- `start(): Promise<ChromaClient>` -- start new server, write PID file, unref process
- `stop(): Promise<boolean>` -- send SIGTERM, wait, force SIGKILL, delete PID file
- `getRunningServer(): Promise<ServerInfo | null>` -- read PID, validate process alive + heartbeat
- `status(): Promise<{ running: boolean; info: ServerInfo | null }>`

Key implementation details:
- Resolve chroma binary via `createRequire(import.meta.url).resolve('chromadb/package.json')`
- Spawn with `process.execPath` (Node binary) to avoid npx overhead
- Set `CHROMADB_VERSION=999.999.999` to suppress update notices
- `detached: true` + `unref()` to let CLI exit while server continues
- Exponential backoff for readiness polling: 100ms initial, 1.5x factor, 2s max, 30 attempts
- Three-tier server validation: PID alive -> heartbeat check -> port match
- SIGTERM with 10s timeout, fallback to SIGKILL

#### `src/commands/server.ts`

These are convenience commands not in the original spec but needed for the hybrid server pattern:

- `chromactl server start` -- explicitly start the server
- `chromactl server stop` -- stop the managed server
- `chromactl server status` -- show server PID, port, uptime

### Acceptance Criteria
- [ ] `ServerManager.start()` spawns a ChromaDB server process and returns a connected `ChromaClient`
- [ ] `ServerManager.ensureRunning()` reuses an existing server (verifies via PID + heartbeat)
- [ ] `ServerManager.stop()` gracefully shuts down the server (SIGTERM, verified via PID check)
- [ ] Stale PID files are detected and cleaned up
- [ ] Port conflicts produce clear error messages
- [ ] Server process survives CLI exit (detached + unref)
- [ ] `chromactl server status` reports running/stopped with PID and port

### Verification Commands
```bash
pnpm run typecheck
pnpm run test -- --grep "server"
# Manual verification:
pnpm run dev -- server start
pnpm run dev -- server status
pnpm run dev -- server stop
```

### Unit/Integration Tests

| Test File | Tests |
|-----------|-------|
| `tests/unit/server.test.ts` | PID file read/write, stale PID detection, port availability check |
| `tests/integration/server.test.ts` | Full start/stop cycle, reuse existing server, port conflict handling |

### Risks
- **Server startup may take longer than expected**: Mitigated by 30-second timeout with clear error message
- **Port 8100 may already be in use**: Detected before spawn attempt; clear error message with suggestion to configure different port
- **Orphaned server processes**: PID file cleanup on start detects stale processes; `server stop` always cleans up

---

## Phase 3: Init + Config Commands

### Objective
Implement `chromactl init` and wire up the global options (`--db`, `--verbose`, `--quiet`, `--json`).

### Files to Create/Modify

| File | Purpose |
|------|---------|
| `src/commands/init.ts` | `chromactl init` command |
| `src/index.ts` | Wire up Commander.js program with global options, preAction hooks |

### Detailed Design

#### `src/index.ts` -- Program Setup

```typescript
import { Command } from '@commander-js/extra-typings';

const program = new Command()
  .name('chromactl')
  .description('ChromaDB CLI management tool')
  .version(VERSION)
  .option('--db <path>', 'Database directory path')
  .option('-v, --verbose', 'Enable verbose output')
  .option('-q, --quiet', 'Suppress non-essential output')
  .option('--json', 'Output as JSON');

// Register commands
program.addCommand(initCommand);
program.addCommand(schemaCommand);
program.addCommand(collectionCommand);
program.addCommand(indexCommand);
program.addCommand(searchCommand);
program.addCommand(statsCommand);
program.addCommand(serverCommand);

// preAction hook: resolve config and ensure server for commands that need DB
```

The `preAction` hook on DB-requiring commands will:
1. Resolve config (via `resolveConfig`)
2. Ensure server is running (via `ServerManager.ensureRunning()`)
3. Store `ChromaClient` on command context for action handlers

#### `src/commands/init.ts`

- Create `.chromactl/` directory
- Write `chromactl.json` with defaults
- Validate directory doesn't already contain a database (unless `--force`)
- Print confirmation with database path

Options:
- `--db <path>`: Custom database directory
- `--force`: Reinitialize if database already exists

### Acceptance Criteria
- [ ] `chromactl init` creates `.chromactl/` and `chromactl.json` in cwd
- [ ] `chromactl init --db /tmp/mydb` creates at specified path
- [ ] `chromactl init` on existing DB exits with code 1 and warning message
- [ ] `chromactl init --force` reinitializes existing DB
- [ ] `chromactl --version` prints version
- [ ] `chromactl --help` shows all commands
- [ ] `chromactl init --help` shows init-specific help with examples
- [ ] `--verbose` flag is passed through to all commands
- [ ] `--quiet` flag suppresses non-essential output
- [ ] `--json` flag switches all output to JSON format

### Verification Commands
```bash
pnpm run build
# Test init:
cd /tmp && mkdir test-init && cd test-init
node /home/biks/workspace/test-team/dist/index.js init
cat chromactl.json
node /home/biks/workspace/test-team/dist/index.js init  # Should fail (already exists)
node /home/biks/workspace/test-team/dist/index.js init --force  # Should succeed
rm -rf /tmp/test-init
```

---

## Phase 4: Schema Management

### Objective
Implement `chromactl schema create|list|show|delete`.

### Files to Create

| File | Purpose |
|------|---------|
| `src/commands/schema.ts` | Schema subcommands |
| `src/lib/schema-validator.ts` | Schema validation logic |

### Detailed Design

#### `src/commands/schema.ts`

- `chromactl schema create <name> --fields '<json>'` -- add schema to chromactl.json
- `chromactl schema create <name> --from-file <path>` -- read schema from JSON file
- `chromactl schema list` -- show all schemas (table format or JSON)
- `chromactl schema show <name>` -- display one schema's full definition
- `chromactl schema delete <name>` -- remove schema if not bound to a collection

All operations are local (modify `chromactl.json`), no server interaction needed.

#### `src/lib/schema-validator.ts`

- `validateMetadata(metadata: Record<string, unknown>, schema: SchemaDefinition): ValidationResult`
  - Check required fields are present
  - Check field types match (`string`, `number`, `boolean`)
  - Return errors array with field names and expected vs actual types
- `parseSchemaInput(fieldsJson: string): SchemaDefinition` -- parse and validate schema JSON input
- `loadSchemaFromFile(filePath: string): SchemaDefinition` -- read and parse schema from file

### Acceptance Criteria
- [ ] `chromactl schema create article --fields '{"author":{"type":"string","required":true}}'` adds schema
- [ ] `chromactl schema list` shows all schemas with field summaries
- [ ] `chromactl schema show article` prints full schema definition
- [ ] `chromactl schema delete article` removes unbound schema
- [ ] `chromactl schema delete article` fails when schema is bound to a collection
- [ ] Invalid `--fields` JSON produces clear parse error
- [ ] `--from-file` reads schema from external JSON file

### Verification Commands
```bash
pnpm run test -- --grep "schema"
pnpm run build
# Manual test (after init):
node dist/index.js schema create article --fields '{"author":{"type":"string","required":true},"year":{"type":"number","required":false}}'
node dist/index.js schema list
node dist/index.js schema show article
node dist/index.js schema delete article
```

### Unit Tests

| Test File | Tests |
|-----------|-------|
| `tests/unit/schema-validator.test.ts` | Type validation, required field check, invalid input handling |

---

## Phase 5: Collection Management

### Objective
Implement `chromactl collection create|list|delete|info`.

### Files to Create

| File | Purpose |
|------|---------|
| `src/commands/collection.ts` | Collection subcommands |

### Detailed Design

#### `src/commands/collection.ts`

- `chromactl collection create <name>` -- create collection via ChromaDB API
  - `--schema <name>`: bind a schema (stores mapping in `chromactl.json` under `collectionSchemas`)
- `chromactl collection list` -- list all collections with document counts
  - Uses `client.listCollections()` (returns `string[]`) + `collection.count()` for each
- `chromactl collection delete <name> --confirm` -- delete collection
  - Without `--confirm`: exit with error message asking for flag (v1; interactive later)
  - With `--confirm`: delete via `client.deleteCollection({ name })`
  - Also remove schema binding from `chromactl.json`
- `chromactl collection info <name>` -- show collection details
  - Document count, associated schema, collection metadata

**Important API note:** `listCollections()` in v3.x returns `string[]`. To get doc counts, iterate and call `collection.count()` for each. For metadata, use `listCollectionsAndMetadata()`.

**Embedding function handling:** Collections must be created with the default embedding function so that documents can be added with auto-embedding. However, since we will manage embeddings ourselves (see Phase 7), collections should be created WITHOUT an embedding function (`embeddingFunction: null`), and we will pass pre-computed embeddings when adding documents.

**Decision: self-managed embeddings vs default embedding function.**
Using `DefaultEmbeddingFunction` directly means the ChromaDB client calls `generate()` on every `add`/`upsert`/`query` -- but that function has no pipeline caching, so model reloads happen on every call. Instead, we should:
1. Create collections with `embeddingFunction: null` (no auto-embedding)
2. Use our own `EmbeddingManager` (Phase 7) with pipeline caching
3. Pass pre-computed embeddings to `collection.add()`/`collection.upsert()`
4. Embed query text ourselves before calling `collection.query({ queryEmbeddings: [...] })`

### Acceptance Criteria
- [ ] `chromactl collection create papers --schema article` creates collection and stores schema binding
- [ ] `chromactl collection list` displays all collections with document counts
- [ ] `chromactl collection delete papers --confirm` removes collection and schema binding
- [ ] `chromactl collection delete papers` (without --confirm) exits with error and instructions
- [ ] `chromactl collection info papers` shows document count and associated schema
- [ ] Default collection named `default` is auto-created on first use (by index/search commands)

### Verification Commands
```bash
pnpm run build
# Manual test (after init):
node dist/index.js collection create test-col
node dist/index.js collection list
node dist/index.js collection info test-col
node dist/index.js collection delete test-col --confirm
```

---

## Phase 6: Text Extraction + Chunking

### Objective
Build the text extraction pipeline (pdftotext, pandoc, direct fs read) and the text chunking logic.

### Files to Create

| File | Purpose |
|------|---------|
| `src/lib/extractor.ts` | Text extraction from files by type |
| `src/lib/chunker.ts` | Character-based text chunking with overlap |

### Detailed Design

#### `src/lib/extractor.ts`

- `extractText(filePath: string): Promise<string>` -- dispatch to appropriate extractor by extension
- `extractTxt(filePath: string): Promise<string>` -- read UTF-8 file directly
- `extractPdf(filePath: string): Promise<string>` -- `pdftotext <file> -`
- `extractDocx(filePath: string): Promise<string>` -- `pandoc <file> -t plain`
- `extractHtml(filePath: string): Promise<string>` -- `pandoc <file> -t plain`
- `checkDependency(command: string): Promise<boolean>` -- verify tool is installed via `which`
- `validateDependencies(extensions: string[]): Promise<string[]>` -- check all needed tools for given file extensions

Implementation details:
- Use `util.promisify(child_process.execFile)` -- no shell spawning
- Set `maxBuffer: 10 * 1024 * 1024` (10 MB) for large documents
- Set `timeout: 30_000` (30 seconds) per extraction
- `.txt` and `.md` read via `fs.readFile` with `'utf-8'` encoding
- Supported extensions: `.txt`, `.md`, `.pdf`, `.docx`, `.html`

#### `src/lib/chunker.ts`

- `chunkText(text: string, options?: ChunkOptions): TextChunk[]`
  - `ChunkOptions`: `{ chunkSize?: number; chunkOverlap?: number; noChunking?: boolean }`
  - Defaults: 1000 chars, 200 char overlap
  - Returns array of `{ text: string; index: number; startOffset: number; endOffset: number }`
  - If text length <= chunkSize, return single chunk
  - If `noChunking` is true, return single chunk regardless of length
- `makeChunkId(filePath: string, chunkIndex: number): string` -- `<absolute-path>::chunk-<index>`
- `makeSingleDocId(filePath: string): string` -- `<absolute-path>` (for unchunked docs)

Chunking algorithm:
1. Start at offset 0
2. Take `chunkSize` characters
3. If not at end of text, try to break at last sentence boundary (`.`, `!`, `?` followed by whitespace) or last word boundary (whitespace) within the chunk
4. Next chunk starts at `end - chunkOverlap`
5. Repeat until end of text

### Acceptance Criteria
- [ ] `.txt` and `.md` files are read correctly (UTF-8)
- [ ] `.pdf` files are extracted via `pdftotext`
- [ ] `.docx` files are extracted via `pandoc`
- [ ] `.html` files are extracted via `pandoc`
- [ ] Missing `pdftotext` produces clear error with install instructions
- [ ] Missing `pandoc` produces clear error with install instructions
- [ ] `maxBuffer` handles files up to 10 MB of extracted text
- [ ] Extraction timeout (30s) produces clear error
- [ ] Chunking splits text at word/sentence boundaries
- [ ] Chunk overlap is correct (200 chars by default)
- [ ] Single-chunk documents (below threshold) produce exactly one chunk
- [ ] `--no-chunking` produces a single chunk regardless of size
- [ ] Chunk IDs follow the `<path>::chunk-<n>` format

### Verification Commands
```bash
pnpm run test -- --grep "extractor|chunker"
```

### Unit Tests

| Test File | Tests |
|-----------|-------|
| `tests/unit/extractor.test.ts` | Extension dispatch, txt/md reading, dependency checking, error handling |
| `tests/unit/chunker.test.ts` | Chunk sizing, overlap, boundary detection, edge cases (empty, tiny, huge text) |

---

## Phase 7: Embedding Manager

### Objective
Build a cached embedding pipeline wrapper that avoids the `DefaultEmbeddingFunction` re-load-on-every-call problem.

### Files to Create

| File | Purpose |
|------|---------|
| `src/lib/embedding.ts` | EmbeddingManager class with singleton pipeline |

### Detailed Design

#### `src/lib/embedding.ts` -- `EmbeddingManager` Class

```typescript
import { pipeline, env, type ProgressCallback } from '@huggingface/transformers';

export class EmbeddingManager {
  private pipelineInstance: any = null;
  private loadingPromise: Promise<any> | null = null;

  constructor(cacheDir?: string) {
    if (cacheDir) {
      env.cacheDir = cacheDir;
    }
  }

  async ensureModel(progressCallback?: ProgressCallback): Promise<void>;
  async generate(texts: string[]): Promise<number[][]>;
  isModelCached(): boolean;
}
```

Key decisions:
- Use `@huggingface/transformers` `pipeline()` directly (NOT `DefaultEmbeddingFunction`)
- Cache the pipeline instance as a singleton (loaded once per process lifetime)
- Set `env.cacheDir` to `.chromactl/models/` for persistence across npm installs
- Show progress during first-time model download
- Support batch embedding (all texts in single call)

Model configuration:
- Model: `Xenova/all-MiniLM-L6-v2`
- dtype: `fp32` (or `uint8` if user chooses smaller download)
- Pooling: `mean`
- Normalize: `true`
- Produces 384-dimensional embeddings

### Acceptance Criteria
- [ ] First call downloads model and shows progress
- [ ] Subsequent calls reuse cached pipeline (no re-download, no re-load)
- [ ] Batch embedding of multiple texts works correctly
- [ ] Embeddings have 384 dimensions
- [ ] Model cache persists across process restarts
- [ ] Offline operation works after initial download
- [ ] Clear error message when offline and model not cached

### Verification Commands
```bash
pnpm run test -- --grep "embedding"
# Manual test:
pnpm run dev -- index file README.md  # Should download model on first run
pnpm run dev -- search "test"          # Should reuse cached model
```

### Unit Tests

| Test File | Tests |
|-----------|-------|
| `tests/unit/embedding.test.ts` | Pipeline caching (mock), batch generation, cache directory configuration |

### Risks
- **Model download may fail**: Handle fetch errors, show clear retry instructions
- **ONNX Runtime compatibility**: onnxruntime-node may have issues on some platforms; test on target Linux x64

---

## Phase 8: Document Indexing

### Objective
Implement `chromactl index file` and `chromactl index dir` with full metadata, chunking, and schema validation support.

### Files to Create

| File | Purpose |
|------|---------|
| `src/commands/index-cmd.ts` | Index command (named `index-cmd.ts` to avoid conflict with `index.ts` entry point) |

Note: The command is registered as `index` in Commander, but the file is `index-cmd.ts` since `index.ts` is the entry point.

### Detailed Design

#### `src/commands/index-cmd.ts`

**`chromactl index file <path>`:**
1. Validate file exists and has supported extension
2. Resolve collection (--collection or default)
3. Ensure collection exists (getOrCreate)
4. If collection has schema, validate --metadata against schema
5. Extract text from file
6. Chunk text (respecting --chunk-size, --chunk-overlap, --no-chunking)
7. Generate auto-metadata: `source_path`, `file_type`, `indexed_at`, `file_size_bytes`, `content_length`
8. Merge user metadata (--metadata, --tag)
9. Generate embeddings for all chunks in single batch
10. Upsert chunks to ChromaDB (with chunk IDs)
11. Print summary

**`chromactl index dir <path>`:**
1. Recursively find all supported files (`.txt`, `.md`, `.pdf`, `.docx`, `.html`)
2. Check dependencies for all file types present
3. Process files with progress indication (`[3/15] Indexing report.pdf...`)
4. Extract text concurrently (limit: 5 concurrent extractions via promise pool)
5. Chunk and embed each file
6. Upsert to ChromaDB (sequential writes to avoid race conditions)
7. Print summary: files processed, chunks created, skipped files with reasons

**Options:**
- `--collection <name>`: Target collection (default: "default")
- `--metadata '<json>'`: Metadata key-value pairs
- `--tag <value>`: Shorthand for `{ tag: "<value>" }`
- `--chunk-size <n>`: Override chunk size (default: 1000)
- `--chunk-overlap <n>`: Override chunk overlap (default: 200)
- `--no-chunking`: Store entire document as single entry
- `--dry-run`: Show what would be indexed without writing

**Document ID strategy:**
- Single-chunk: absolute file path (e.g., `/home/user/docs/file.txt`)
- Multi-chunk: `<absolute-path>::chunk-<n>` (e.g., `/home/user/docs/file.pdf::chunk-0`)

**Upsert behavior:**
- Uses `collection.upsert()` so re-indexing the same file updates rather than duplicates
- When re-indexing, old chunks that no longer exist (e.g., file got shorter) will remain as orphans. This is an acceptable trade-off for v1.

**Embedding flow:**
1. Extract text for all files
2. Chunk all texts
3. Batch all chunk texts into a single `EmbeddingManager.generate()` call (or batch by 100 if too many)
4. Upsert to ChromaDB: `collection.upsert({ ids, documents, embeddings, metadatas })`

Since we manage embeddings ourselves, we call `collection.upsert()` with explicit `embeddings` parameter, bypassing the collection's embedding function.

### Acceptance Criteria
- [ ] `chromactl index file README.md` indexes a markdown file into the default collection
- [ ] `chromactl index dir ./docs` recursively indexes all supported files
- [ ] `chromactl index file paper.pdf --collection papers --metadata '{"author":"Smith","year":2024}'` works with metadata
- [ ] Schema validation rejects documents with missing required fields
- [ ] Re-indexing the same file upserts (no duplicates)
- [ ] Large documents are split into chunks with correct chunk_index metadata
- [ ] `--dry-run` lists files without modifying the database
- [ ] Unsupported file types in directory are skipped and reported
- [ ] Missing pdftotext/pandoc produces clear error before starting
- [ ] Progress indication during directory indexing
- [ ] Summary shows files processed, chunks created, skipped files

### Verification Commands
```bash
pnpm run build
# After init:
echo "Hello world" > /tmp/test.txt
node dist/index.js index file /tmp/test.txt
node dist/index.js index file /tmp/test.txt  # Upsert test (should succeed silently)
node dist/index.js collection info default   # Should show 1 document
```

### Integration Tests

| Test File | Tests |
|-----------|-------|
| `tests/integration/indexing.test.ts` | Full index flow: init -> create collection -> index file -> verify in DB |

---

## Phase 9: Search

### Objective
Implement `chromactl search <query>` with similarity scoring, metadata filtering, and output formatting.

### Files to Create

| File | Purpose |
|------|---------|
| `src/commands/search.ts` | Search command |

### Detailed Design

#### `src/commands/search.ts`

**`chromactl search <query>`:**
1. Resolve collection (--collection or default)
2. Get collection (error if not found)
3. Generate embedding for query text via `EmbeddingManager.generate([query])`
4. Execute query: `collection.query({ queryEmbeddings: [embedding], nResults, where, include: ['documents', 'metadatas', 'distances'] })`
5. Convert distances to similarity scores: `1 / (1 + distance)` for L2 (default)
6. Filter by `--min-score` if provided
7. Format and display results

**Options:**
- `--collection <name>`: Target collection (default: "default")
- `-n, --results <n>`: Number of results (default: 5, max: 50)
- `--filter '<json>'`: ChromaDB where clause
- `--min-score <n>`: Minimum similarity score (0.0-1.0)
- `--snippet-length <n>`: Snippet length in characters (default: 200)
- `--full-text`: Print full document/chunk text
- `--json`: Output as JSON array

**Output format (text):**
```
[1] (0.87) docs/report.pdf  chunk 2
    First 200 characters of the matching chunk text...
    author: "Smith"  year: 2024  tag: "research"

[2] (0.73) docs/notes.md
    First 200 characters of the document text...
    tag: "notes"
```

**Output format (JSON):**
```json
[
  {
    "rank": 1,
    "similarity": 0.87,
    "source_path": "docs/report.pdf",
    "chunk_index": 2,
    "snippet": "First 200 characters...",
    "metadata": { "author": "Smith", "year": 2024 }
  }
]
```

**Distance-to-similarity conversion:**
- L2 (default): `similarity = 1 / (1 + distance)`
- If cosine space is used in future: `similarity = 1 - distance`

### Acceptance Criteria
- [ ] `chromactl search "machine learning"` returns top 5 results from default collection
- [ ] `chromactl search "query" -n 10 --collection papers` returns 10 results from papers
- [ ] `chromactl search "query" --filter '{"author":"Smith"}'` filters by metadata
- [ ] `--min-score 0.5` filters out low-similarity results
- [ ] Each result shows rank, similarity, source path, snippet, metadata
- [ ] `--full-text` shows complete text instead of snippet
- [ ] `--json` outputs valid JSON parseable by `jq`
- [ ] `--snippet-length` controls snippet truncation

### Verification Commands
```bash
pnpm run build
# After indexing some documents:
node dist/index.js search "test query"
node dist/index.js search "test query" --json | jq .
node dist/index.js search "test query" -n 3 --full-text
```

---

## Phase 10: Statistics

### Objective
Implement `chromactl stats` for database-level and collection-level statistics.

### Files to Create

| File | Purpose |
|------|---------|
| `src/commands/stats.ts` | Stats command |

### Detailed Design

#### `src/commands/stats.ts`

**`chromactl stats` (database-level):**
1. List all collections
2. Count documents in each collection
3. Calculate total disk size of the `.chromactl/` data directory
4. Display: total collections, total documents, database size on disk

**`chromactl stats <collection>` (collection-level):**
1. Get collection
2. Count documents
3. Get all documents (with metadata, without embeddings) to compute:
   - Unique source files (distinct `source_path` values)
   - Chunk count (documents with `chunk_index` metadata)
   - File type breakdown (count by `file_type` metadata)
   - Metadata field distribution (which fields exist and how many documents have each)
4. Display detailed stats

**Options:**
- `--json`: Output as JSON

**Note on performance:** For large collections, `collection.get()` without filters returns all documents. This may be slow for collections with >10,000 documents. For v1, this is acceptable. Future optimization: paginate with `limit` + `offset`.

### Acceptance Criteria
- [ ] `chromactl stats` shows database-level overview
- [ ] `chromactl stats papers` shows collection-level details
- [ ] File type breakdown is correct
- [ ] Metadata field distribution is correct
- [ ] Unique source file count is correct
- [ ] `--json` outputs valid JSON
- [ ] Database size on disk is calculated correctly

### Verification Commands
```bash
pnpm run build
node dist/index.js stats
node dist/index.js stats default
node dist/index.js stats --json | jq .
```

---

## Phase 11: Polish + Integration Tests

### Objective
Add help text examples, end-to-end integration tests, error handling edge cases, and final polish.

### Tasks

1. **Help text examples**: Add usage examples to every command's help text using Commander's `.addHelpText('after', ...)` or description strings
2. **Integration test suite**: Full workflow test: init -> schema create -> collection create -> index files -> search -> stats -> cleanup
3. **Error edge cases**:
   - Non-existent file in `index file`
   - Empty directory in `index dir`
   - Invalid JSON in `--metadata` and `--filter` and `--fields`
   - Collection not found in search/stats/info/delete
   - Running commands without init
4. **Process signal handling**: Register cleanup handlers for SIGINT/SIGTERM in the CLI entry point
5. **`--verbose` detail**: Add timing info, extraction commands, ChromaDB operations when verbose
6. **Progress indicators**: Spinner (via ora) for long operations (server start, model download, indexing)

### Files to Modify

| File | Purpose |
|------|---------|
| `src/index.ts` | Signal handlers, top-level error handler |
| `src/commands/*.ts` | Help text examples |
| All command files | Verbose logging |

### Files to Create

| File | Purpose |
|------|---------|
| `tests/integration/workflow.test.ts` | Full end-to-end workflow test |

### Integration Test Workflow

```
1. chromactl init --db /tmp/test-chromactl-<random>
2. chromactl schema create article --fields '{"author":{"type":"string","required":true}}'
3. chromactl collection create papers --schema article
4. Create test .txt and .md files in a temp directory
5. chromactl index dir <tempdir> --collection papers --metadata '{"author":"Test"}'
6. chromactl search "test content" --collection papers -n 3
7. Verify search returns results with correct metadata
8. chromactl stats papers
9. chromactl collection delete papers --confirm
10. chromactl server stop
11. Cleanup temp directories
```

### Acceptance Criteria
- [ ] All commands have help text with at least one usage example
- [ ] Integration test passes: full init -> index -> search -> stats workflow
- [ ] Error messages are helpful and suggest corrective actions
- [ ] Ctrl+C during long operations (indexing) cleans up gracefully
- [ ] `--verbose` shows timing and operation details
- [ ] All exit codes are non-zero for error conditions
- [ ] `chromactl <command> --help` works for all commands

### Verification Commands
```bash
pnpm run test           # All unit + integration tests
pnpm run typecheck      # TypeScript strict mode
pnpm run lint           # ESLint
pnpm run build          # Production build
node dist/index.js --help
```

---

## Complete File Manifest

```
src/
  index.ts                      # CLI entry point, Commander setup, global hooks
  types/
    index.ts                    # All shared TypeScript types
  commands/
    init.ts                     # chromactl init
    schema.ts                   # chromactl schema create|list|show|delete
    collection.ts               # chromactl collection create|list|delete|info
    index-cmd.ts                # chromactl index file|dir
    search.ts                   # chromactl search
    stats.ts                    # chromactl stats
    server.ts                   # chromactl server start|stop|status
  lib/
    config.ts                   # Configuration file management
    server.ts                   # ServerManager (ChromaDB server lifecycle)
    extractor.ts                # Text extraction (pdftotext, pandoc, fs)
    chunker.ts                  # Text chunking with overlap
    embedding.ts                # EmbeddingManager (cached pipeline)
    schema-validator.ts         # Metadata schema validation
    output.ts                   # Output formatting (text/JSON, colors)
    errors.ts                   # Custom error classes

tests/
  unit/
    config.test.ts
    output.test.ts
    errors.test.ts
    extractor.test.ts
    chunker.test.ts
    schema-validator.test.ts
    embedding.test.ts
  integration/
    server.test.ts
    indexing.test.ts
    workflow.test.ts

package.json
tsconfig.json
eslint.config.js
tsup.config.ts
.gitignore
```

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| ChromaDB server fails to start | Low | High | Validate native bindings availability at init time; clear error messages with platform support matrix |
| First-run model download fails (network) | Medium | Medium | Show progress during download; clear error message; suggest retry; consider `chromactl download-model` command |
| Model download adds 24-91 MB on first use | Certain | Low | Use `uint8` dtype (24 MB); inform user; cache in `.chromactl/models/` |
| `DefaultEmbeddingFunction` performance (no pipeline cache) | Certain | High | Use `@huggingface/transformers` `pipeline()` directly with singleton pattern; batch all texts |
| Port 8100 conflict | Low | Low | Detect before spawn; clear error message; configurable in chromactl.json |
| Orphaned server processes | Low | Low | PID file + stale detection + cleanup handlers |
| Large PDF extraction exceeds maxBuffer | Low | Medium | Set 10 MB maxBuffer; timeout at 30s; clear error for oversized files |
| `chromadb` npm package breaking changes | Low | High | Pin to ^3.4.3; test against specific version; monitor changelog |
| Orphaned chunks on re-index (file got shorter) | Medium | Low | Acceptable for v1; document limitation; future: delete old chunks before upsert |
| ONNX model cache inside node_modules wiped on reinstall | Medium | Medium | Set `env.cacheDir` to `.chromactl/models/` outside `node_modules` |

---

## Deferred Features (Not in v1)

These features are mentioned in the spec but deferred for implementation simplicity:

1. **Interactive schema input prompts** (FR-2.6) -- require `--fields` or `--from-file`
2. **Interactive collection delete confirmation** (FR-3.3) -- require `--confirm` flag
3. **Orphan chunk cleanup on re-index** -- accept orphans in v1
4. **`chromactl download-model`** -- pre-download embedding model
5. **Idle timeout for server** -- server runs until explicit stop
6. **Shell completion** -- Commander plugins exist but not critical for v1
7. **Configurable embedding model** -- hardcode `Xenova/all-MiniLM-L6-v2`
8. **`CHROMACTL_DB` environment variable** -- depending on user decision (see Open Questions)
