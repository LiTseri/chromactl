# Investigation: chromactl -- ChromaDB CLI Management Tool Technology Stack

## Executive Summary

This investigation evaluates the technology choices for building `chromactl`, a TypeScript CLI tool for managing a local ChromaDB instance. The most critical finding is that the **ChromaDB JavaScript/TypeScript client (v3.x) does NOT support embedded/persistent mode** -- it requires a running ChromaDB server. However, the `chromadb` npm package (v3.4.3) ships with native Rust bindings and a bundled CLI (`npx chroma run`) that starts a local server, making a "managed server" architecture viable. For embeddings, the `@chroma-core/default-embed` package provides local inference using `all-MiniLM-L6-v2` via `@huggingface/transformers`, requiring no external API. For the CLI framework, **Commander.js** is recommended over yargs for its zero-dependency footprint, first-class TypeScript support, and natural nested subcommand model. **tsup** is the recommended build tool, and shelling out to `pdftotext`/`pandoc` via `child_process.execFile` (not `execSync`) is the recommended text extraction approach.

## Context

- **What was investigated**: Technology stack decisions for a greenfield TypeScript CLI tool (`chromactl`) that manages a local ChromaDB vector database -- specifically: ChromaDB JS client capabilities, embedding approach, CLI framework, build tooling, and text extraction strategy.
- **Key requirements**: Local-only operation (no external server dependency from the user's perspective), automatic embeddings using `all-MiniLM-L6-v2`, npm-installable CLI binary, TypeScript with strict mode, pnpm package manager.
- **Refined request**: `/home/biks/workspace/test-team/docs/design/refined-request-chromactl.md`

## Options Identified

### Area 1: ChromaDB Client Architecture

#### Option 1A: Managed Local Server (Recommended)

- **Description**: Use the `chromadb` npm package's bundled CLI to start a local ChromaDB server on demand (via the native Rust bindings shipped as `chromadb-js-bindings-*`), then connect with `ChromaClient` over HTTP. The `chromactl` tool manages the server lifecycle transparently: start the server before operations, connect, perform work, and optionally stop it afterward. The server persists data to a configured directory via `--path`.
- **How it works**: The `chromadb` npm package v3.4.3 includes a `dist/cli.mjs` binary entry point that delegates to native Rust bindings (`chromadb-js-bindings-linux-x64-gnu`, ~53 MB). Running `npx chroma run --path ./data` starts a local server on port 8000. The JS `ChromaClient` connects to `http://localhost:8000`.
- **Strengths**:
  - Uses the officially supported JS/TS client API (`ChromaClient`)
  - Data persistence is handled by the Chroma server via `--path`
  - Native bindings are shipped as optional dependencies, auto-selected per platform
  - No Python dependency required -- the Rust bindings are self-contained
  - Aligns with ChromaDB's documented architecture for JS/TS
- **Weaknesses**:
  - Requires managing a server process (start, health check, stop)
  - Adds complexity: port management, process lifecycle, error handling for server failures
  - First startup may be slower (server initialization)
  - Port conflicts possible if another service uses 8000 (must be configurable)
  - The "no separate server" requirement from the refined request is technically violated, though the server is managed transparently
- **Effort/Complexity**: Medium
- **Risk**: Low-Medium (the `npx chroma run` approach is documented and supported)
- **Best suited when**: Building a CLI that needs to work reliably with the official ChromaDB JS client

#### Option 1B: Direct Native Bindings (Experimental)

- **Description**: Import the native Rust bindings directly (via the `bindings.ts` module in the `chromadb` package) and attempt to use them for in-process database operations without starting an HTTP server.
- **Strengths**:
  - True embedded mode -- no server process to manage
  - Simpler architecture, faster operations (no HTTP overhead)
- **Weaknesses**:
  - **Undocumented and unsupported**: The native bindings API is not documented; only `binding.cli()` is used in the shipped code
  - No TypeScript types for the native API
  - Breaking changes likely between versions
  - The `chromadb-core` package only exports HTTP-based client classes (`ChromaClient`, `CloudClient`, `AdminClient`)
  - Would require reverse-engineering the native binding's API surface
- **Effort/Complexity**: High
- **Risk**: High (undocumented, unsupported, likely to break)
- **Best suited when**: Never -- this is not a viable approach for production use

#### Option 1C: Python ChromaDB via Child Process

- **Description**: Shell out to Python's ChromaDB library (which has native `PersistentClient` support) for database operations.
- **Strengths**:
  - Python's `PersistentClient` is fully embedded, no server needed
  - Well-documented, stable API
- **Weaknesses**:
  - Requires Python and `chromadb` pip package installed
  - Cross-language boundary adds complexity and performance overhead
  - Serialization/deserialization overhead for every operation
  - Defeats the purpose of a TypeScript tool
  - Debugging and error handling across process boundaries is painful
- **Effort/Complexity**: High
- **Risk**: Medium (Python dependency management, version mismatches)
- **Best suited when**: The JS client is completely non-functional (not the case)

### Area 2: Embedding Approach

#### Option 2A: ChromaDB Default Embedding (Recommended)

- **Description**: Use ChromaDB's built-in default embedding function, powered by `@chroma-core/default-embed` (v0.1.9). This package uses `@huggingface/transformers` (v3.5.1+) to run the `Xenova/all-MiniLM-L6-v2` model locally via ONNX Runtime. When a collection is created without specifying an embedding function, ChromaDB automatically uses this default.
- **Strengths**:
  - Zero configuration -- just add documents, ChromaDB handles embedding
  - Uses the exact model specified in requirements (`all-MiniLM-L6-v2`)
  - Runs entirely locally, no API keys needed
  - Produces 384-dimensional embeddings suitable for general-purpose semantic search
  - The `chromadb` npm package bundles this as a dependency (vs `chromadb-client` which makes it a peer dependency)
- **Weaknesses**:
  - First run downloads the ONNX model (~23 MB) -- network required once
  - Model loading adds latency on first operation (~1-3 seconds)
  - `@huggingface/transformers` is ~9.5 MB unpacked with `onnxruntime-node` dependency
  - Memory usage increases with model loaded (~100-200 MB)
- **Effort/Complexity**: Low
- **Risk**: Low
- **Best suited when**: Using the default ChromaDB workflow (which is our case)

#### Option 2B: Direct @huggingface/transformers Integration

- **Description**: Bypass ChromaDB's default embedding and use `@huggingface/transformers` directly to generate embeddings, then pass them to ChromaDB via the `embeddings` parameter.
- **Strengths**:
  - Full control over model selection, quantization, and configuration
  - Can pre-generate embeddings before sending to ChromaDB
  - Useful if ChromaDB's default embedding has issues
- **Weaknesses**:
  - Unnecessary complexity when the default works
  - Must manage embedding generation separately from ChromaDB operations
  - More code to write and maintain
- **Effort/Complexity**: Medium
- **Risk**: Low
- **Best suited when**: Custom embedding model is needed (not our case)

### Area 3: CLI Framework

#### Option 3A: Commander.js (Recommended)

- **Description**: Use Commander.js (v15.0.0) for CLI argument parsing and command routing.
- **Strengths**:
  - **Zero production dependencies** -- minimal footprint
  - First-class TypeScript support with `@commander-js/extra-typings` for inferred option types
  - Native nested subcommand support via `.command()` and `.addCommand()`
  - Lifecycle hooks (`preAction`, `postAction`, `preSubcommand`) for cross-cutting concerns like DB initialization checks
  - Help groups for organizing options under custom headings
  - Option conflicts and implications (`--quiet` conflicts with `--verbose`)
  - `.exitOverride()` for testable error handling
  - `.configureOutput()` for custom stdout/stderr routing
  - Well-established (most popular Node.js CLI framework), actively maintained
  - Each subcommand can define its own options independently
  - Supports `hidden: true` for internal commands
- **Weaknesses**:
  - Less "convention-over-configuration" than yargs -- requires more explicit setup
  - No built-in shell completion (though plugins exist)
  - Requires Node.js >= 22.12.0 (v15.0.0) -- compatible with our Node 22 target
- **Effort/Complexity**: Low
- **Risk**: Low
- **Best suited when**: Building a well-structured CLI with nested subcommands and strong TypeScript support

#### Option 3B: Yargs

- **Description**: Use Yargs (v18.0.0) for CLI argument parsing.
- **Strengths**:
  - Built-in shell completion script generation (Bash and Zsh)
  - Dynamically generated help menus
  - `.strictCommands()` and `.demandCommand()` for enforcement
  - Mature ecosystem, widely used
- **Weaknesses**:
  - **6 production dependencies** (y18n, cliui, escalade, string-width, yargs-parser, get-caller-file)
  - TypeScript types are in `@types/yargs` (DefinitelyTyped) -- not first-party, may lag behind releases
  - ESM-only in v18 -- requires `"type": "module"` in package.json (fine, but a constraint)
  - Nested subcommands require more boilerplate (calling `.command()` inside builder functions)
  - Less intuitive API for complex command hierarchies compared to Commander's `.addCommand()` pattern
- **Effort/Complexity**: Low-Medium
- **Risk**: Low
- **Best suited when**: Shell completion is a high priority, or the team has existing yargs experience

### Area 4: Build and Package Tooling

#### Option 4A: tsup (Recommended)

- **Description**: Use tsup (v8.5.1) for building the TypeScript CLI into distributable JavaScript.
- **Strengths**:
  - Zero-config for simple cases, powered by esbuild for speed
  - Generates both CJS and ESM outputs
  - DTS (declaration file) generation
  - Watch mode for development
  - Used by the ChromaDB JS client itself (they use tsup)
  - Handles shebang lines for CLI entry points
  - Code splitting support
  - Well-maintained, widely adopted
- **Weaknesses**:
  - Larger dependency tree (esbuild, rollup, chokidar, sucrase, etc.)
  - Some edge cases with certain TypeScript features (decorators, etc.) -- not relevant here
- **Effort/Complexity**: Low
- **Risk**: Low
- **Best suited when**: Building a TypeScript CLI package for npm distribution

#### Option 4B: tsx (Development Only) + tsc (Build)

- **Description**: Use `tsx` (v4.22.4) for development (direct TypeScript execution) and `tsc` for production builds.
- **Strengths**:
  - `tsx` provides instant TypeScript execution during development
  - `tsc` produces standard, well-understood output
  - Minimal tooling -- just TypeScript compiler
- **Weaknesses**:
  - `tsc` doesn't bundle -- outputs many individual files
  - No tree-shaking or optimization
  - Requires manual configuration for CJS/ESM dual output
  - No watch+rebuild in a single tool
- **Effort/Complexity**: Medium
- **Risk**: Low
- **Best suited when**: Simplicity is paramount and bundling isn't needed

#### Option 4C: tsup + tsx (Combined)

- **Description**: Use `tsx` for development (running/testing TypeScript directly) and `tsup` for production builds.
- **Strengths**:
  - Best of both worlds: fast development iteration with tsx, optimized production output with tsup
  - `tsx` can be a dev dependency for scripts and testing
- **Weaknesses**:
  - Two tools to understand (minor overhead)
- **Effort/Complexity**: Low
- **Risk**: Low
- **Best suited when**: You want both fast development and clean production builds (our case)

### Area 5: Text Extraction Approach

#### Option 5A: child_process.execFile with Promises (Recommended)

- **Description**: Use `child_process.execFile` (wrapped in `util.promisify`) to shell out to `pdftotext` and `pandoc`. Use `execFile` instead of `exec` to avoid shell injection and avoid `execSync` to prevent blocking the event loop.
- **Strengths**:
  - `execFile` does not spawn a shell -- safer against injection, slightly faster
  - Async/promisified approach allows concurrent text extraction during directory indexing
  - Can set timeout, maxBuffer, encoding options per call
  - Standard Node.js API, no additional dependencies
  - `maxBuffer` can be increased for large files (default 1 MB may be insufficient for large PDFs)
- **Weaknesses**:
  - Must handle errors (command not found, non-zero exit, timeout) explicitly
  - `maxBuffer` must be configured appropriately for large documents
  - Platform-dependent (requires pdftotext and pandoc installed)
- **Effort/Complexity**: Low
- **Risk**: Low
- **Best suited when**: Shelling out to known, pre-installed system tools

#### Option 5B: child_process.execSync

- **Description**: Use synchronous `execSync` for text extraction.
- **Strengths**:
  - Simpler control flow (no async/await needed)
  - Easier error handling (try/catch)
- **Weaknesses**:
  - **Blocks the event loop** -- prevents concurrent extraction during directory indexing
  - Spawns a shell (injection risk if file paths aren't sanitized)
  - Cannot process files in parallel
  - No timeout handling granularity
- **Effort/Complexity**: Low
- **Risk**: Medium (performance penalty for batch operations)
- **Best suited when**: Never for this use case -- batch directory indexing requires concurrency

#### Option 5C: Node.js Libraries (pdfjs-dist, mammoth)

- **Description**: Use pure JavaScript libraries for text extraction instead of shelling out.
- **Strengths**:
  - No system dependency requirements
  - Cross-platform compatibility
  - Programmatic control over extraction
- **Weaknesses**:
  - `pdfjs-dist` is complex and large (~2 MB), designed for rendering not text extraction
  - `mammoth` handles DOCX but not PDF or HTML
  - Would need multiple libraries for different formats
  - Quality of text extraction varies (especially for PDFs)
  - More dependencies to maintain
- **Effort/Complexity**: Medium
- **Risk**: Medium (extraction quality, edge cases)
- **Best suited when**: System tools cannot be assumed to be installed (not our case)

## Comparison Matrix

| Criterion | 1A: Managed Server | 1B: Direct Bindings | 1C: Python Bridge |
|-----------|-------------------|--------------------|--------------------|
| Official support | Yes | No | N/A (wrong lang) |
| Documentation | Good | None | Good (Python) |
| Complexity | Medium | High | High |
| Risk | Low-Medium | High | Medium |
| Performance | Good (HTTP overhead) | Best (in-process) | Poor (cross-process) |
| Long-term viability | High | Very Low | Low |

| Criterion | 2A: Default Embed | 2B: Direct HF |
|-----------|-------------------|----------------|
| Setup effort | None | Medium |
| Model match | all-MiniLM-L6-v2 | Configurable |
| Maintenance | Handled by ChromaDB | Manual |
| Risk | Low | Low |

| Criterion | 3A: Commander | 3B: Yargs |
|-----------|---------------|-----------|
| Dependencies | 0 | 6 |
| TypeScript support | First-party | @types |
| Nested subcommands | Native | Builder pattern |
| Shell completion | No (plugin) | Yes (built-in) |
| Lifecycle hooks | Yes | No |
| Learning curve | Low | Low |

| Criterion | 4A: tsup | 4B: tsx+tsc | 4C: tsup+tsx |
|-----------|---------|-------------|--------------|
| Build speed | Fast | Medium | Fast |
| Bundle output | Yes | No | Yes |
| Dev experience | Watch mode | Direct exec | Best |
| DTS generation | Yes | Yes (tsc) | Yes |

| Criterion | 5A: execFile async | 5B: execSync | 5C: JS libraries |
|-----------|-------------------|--------------|-------------------|
| Concurrency | Yes | No | Yes |
| Safety | High (no shell) | Medium | High |
| Extraction quality | High (system tools) | High | Variable |
| Dependencies | System tools | System tools | npm packages |

## Recommendation

The recommended technology stack for `chromactl` is:

### ChromaDB Architecture: Managed Local Server (Option 1A)

Use the `chromadb` npm package (v3.4.3+) with a **managed local server** pattern. The tool will:

1. On `chromactl init`, record the database path in `chromactl.json`
2. Before any database operation, check if a Chroma server is already running (health check on the configured port)
3. If not running, start one via the bundled CLI (`npx chroma run --path <db-path> --port <port>`) as a background process
4. Connect with `new ChromaClient({ host: 'localhost', port: <port> })`
5. Perform the requested operation
6. Optionally leave the server running between commands (with a configurable idle timeout) or stop it after each command

**Key justification**: The ChromaDB JS client officially only supports client-server mode. The native bindings are undocumented and using them directly would be unsupported and fragile. The managed server approach is the only officially supported path and provides data persistence via the `--path` flag.

**Alternative consideration**: If the managed server approach proves too complex or unreliable, a fallback would be to start the server in the foreground (blocking) for each command and shut it down on completion. This is simpler but slower due to server startup/shutdown overhead per command.

### Embeddings: ChromaDB Default (Option 2A)

Use the default embedding function from `@chroma-core/default-embed`. The `chromadb` npm package (not `chromadb-client`) bundles this as a dependency. Collections created without specifying an embedding function will automatically use `Xenova/all-MiniLM-L6-v2` (384 dimensions, ONNX Runtime, local inference). No additional configuration or packages needed.

### CLI Framework: Commander.js (Option 3A)

Use `commander` (v15.0.0) with `@commander-js/extra-typings` for type-safe CLI construction. Commander's zero-dependency footprint, first-party TypeScript support, native nested subcommands, and lifecycle hooks make it the best fit for `chromactl`'s command structure:

```
chromactl init
chromactl schema create|list|show|delete
chromactl collection create|list|delete|info
chromactl index file|dir
chromactl search
chromactl stats
```

Commander's `preAction` hooks can implement the DB initialization check and server startup transparently.

### Build Tooling: tsup + tsx (Option 4C)

Use `tsup` for production builds and `tsx` as a dev dependency for running TypeScript directly during development and testing. The `package.json` `bin` field will point to the tsup-built output with a shebang line.

### Text Extraction: execFile with Promises (Option 5A)

Use `util.promisify(child_process.execFile)` for all text extraction. Set `maxBuffer` to at least 10 MB for large documents. Implement dependency checking (`which pdftotext`, `which pandoc`) at the start of indexing commands.

### Supporting Libraries

| Library | Purpose | Version |
|---------|---------|---------|
| `chromadb` | ChromaDB client + bundled server CLI | ^3.4.3 |
| `commander` | CLI framework | ^15.0.0 |
| `@commander-js/extra-typings` | Type-safe Commander | matching |
| `chalk` | Terminal colors (respects NO_COLOR) | ^5.6.2 |
| `ora` | Spinners/progress | latest |
| `tsup` | Production build | ^8.5.1 |
| `tsx` | Dev execution (devDep) | ^4.22.4 |
| `typescript` | Compiler (devDep) | ^5.x |

## Technical Research Guidance

**Research needed**: Yes

### Topic 1: ChromaDB JS Client v3.x Server Lifecycle Management

- **Why**: The managed server pattern is the recommended architecture, but the exact API for programmatically starting, health-checking, and stopping a Chroma server from Node.js needs to be validated. Specifically: Can the native bindings' `cli()` function be called programmatically to start a server in a child process? What is the server startup time? How does the server signal readiness? What happens when the port is already in use?
- **Focus**: Server startup via `child_process.spawn` calling the bundled CLI, health check endpoint (`/api/v1/heartbeat` or `ChromaClient.heartbeat()`), graceful shutdown (SIGTERM), port configuration, error scenarios (port conflict, corrupt database)
- **Depth**: Deep dive
- **Relevance**: This is the foundational architecture decision. The entire tool depends on reliably managing the server lifecycle. If the managed server approach proves unworkable, the project scope may need to change significantly.

### Topic 2: ChromaDB JS Client Collection and Query API

- **Why**: The investigation focused on client architecture and connectivity. The actual API for creating collections with embedding functions, adding documents with metadata, querying with where filters, and getting collection statistics needs detailed understanding for implementation planning.
- **Focus**: `createCollection`/`getOrCreateCollection` API (with and without embedding functions), `collection.add`/`upsert` with metadata, `collection.query` with where filters and `nResults`, `collection.count`, `collection.get`, distance-to-similarity score conversion, `listCollections` response format
- **Depth**: Intermediate
- **Relevance**: Directly maps to the implementation of every command in chromactl. The refined request has detailed acceptance criteria that depend on these APIs working as expected.

### Topic 3: @chroma-core/default-embed Behavior and First-Run Experience

- **Why**: The first run of any embedding operation will download the ONNX model. Understanding the download behavior (where files are cached, size, offline handling, error messages) is needed to provide a good UX with progress indication and clear error messages.
- **Focus**: Model download location (cache directory), download size, timeout handling, offline error messages, whether the model can be pre-downloaded, cache persistence across runs
- **Depth**: Overview
- **Relevance**: Affects the UX of `chromactl index` on first use and the NFR-2 error handling requirements.

## Implementation Considerations

### Key decisions still to be made

1. **Server lifecycle strategy**: Start-per-command vs. persistent daemon with idle timeout. Start-per-command is simpler but slower; a persistent daemon needs PID file management and cleanup.
2. **Port selection**: Fixed default port (e.g., 8100 to avoid conflicts with other Chroma instances) vs. dynamic port allocation. Store chosen port in `chromactl.json`.
3. **Concurrency limit for directory indexing**: How many files to extract text from concurrently (e.g., `Promise.allSettled` with a concurrency limit of 5-10).
4. **Chunk ID format**: The refined request specifies `/path/to/file.pdf::chunk-0` -- confirm this works as a ChromaDB document ID (must not contain characters that ChromaDB rejects).

### Dependencies or prerequisites

- Node.js >= 22 (required by Commander v15 and the environment)
- pnpm (specified in requirements, pre-installed)
- `pdftotext` (poppler-utils) and `pandoc` (pre-installed in environment)
- Disk space: ~53 MB for the `chromadb-js-bindings-linux-x64-gnu` native binary, plus ~23 MB for the embedding model on first run

### Potential pitfalls to watch for

1. **Server startup race condition**: The Chroma server may not be ready when `ChromaClient` first tries to connect. Implement a retry loop with exponential backoff on the heartbeat check.
2. **maxBuffer overflow**: Default 1 MB buffer for `child_process.execFile` is insufficient for large PDFs. Set to at least 10 MB.
3. **Port conflicts**: Another process (or another chromactl instance) may already be using the port. Detect this and either reuse the existing server or select a different port.
4. **Native binding platform support**: Windows x64 is NOT supported by the native bindings (only Windows ARM64). Linux x64, Linux ARM64, macOS x64, and macOS ARM64 are supported. The target environment (Linux x64) is covered.
5. **ESM vs CJS**: Both `chalk` v5+ and `yargs` v18 are ESM-only. Commander v15 supports both. The project should use `"type": "module"` in package.json.
6. **ChromaDB version compatibility**: JS client v3.x requires ChromaDB server v1.0.6+. Since we're using the bundled server from the same npm package, versions should match automatically.

### Suggested first steps

1. Create the project scaffold: `pnpm init`, install `chromadb`, `commander`, `chalk`, `tsup`, `tsx`, `typescript`
2. Validate the managed server approach: Write a proof-of-concept that starts `npx chroma run`, waits for readiness, connects with `ChromaClient`, creates a collection, adds a document, queries it, and shuts down
3. If the proof-of-concept succeeds, proceed with full architecture design and command implementation
4. If it fails, investigate alternative approaches (direct Python bridge, or requiring user to start server manually)

## References

| # | Source | URL | What was learned |
|---|--------|-----|-----------------|
| 1 | ChromaDB Docs - Getting Started | https://docs.trychroma.com/docs/overview/getting-started | JS/TS client requires a running server; Python has embedded/persistent mode |
| 2 | ChromaDB Docs - Clients | https://docs.trychroma.com/docs/run-chroma/clients.md | Three client modes (Cloud, In-Memory, Persistent); only Python has embedded; JS needs server |
| 3 | chromadb npm registry | https://registry.npmjs.org/chromadb/latest | v3.4.3 ships native bindings for multiple platforms, has CLI binary entry point |
| 4 | chromadb-js-bindings-linux-x64-gnu npm | https://registry.npmjs.org/chromadb-js-bindings-linux-x64-gnu/latest | v1.3.4, ~53 MB native binary, provides in-process Chroma engine |
| 5 | @chroma-core/default-embed npm | https://registry.npmjs.org/@chroma-core/default-embed | v0.1.9, uses Xenova/all-MiniLM-L6-v2, runs locally via @huggingface/transformers |
| 6 | ChromaDB Docs - Embedding Functions | https://docs.trychroma.com/docs/embeddings/embedding-functions.md | Default embedding is all-MiniLM-L6-v2; JS needs @chroma-core/default-embed installed |
| 7 | ChromaDB Docs - CLI Run | https://docs.trychroma.com/docs/cli/run.md | `chroma run --path <dir>` starts local server; configurable host, port |
| 8 | ChromaDB Docs - CLI Install | https://docs.trychroma.com/docs/cli/install.md | `npm install -g chromadb` provides the CLI; also available via pnpm, bun, yarn |
| 9 | ChromaDB GitHub - JS source | https://github.com/chroma-core/chroma/tree/main/clients/js/packages/chromadb/src | bindings.ts loads platform-specific native modules; cli.ts delegates to binding.cli() |
| 10 | ChromaDB Docs - TS Client Reference | https://docs.trychroma.com/reference/typescript/client.md | ChromaClient, CloudClient, AdminClient classes; all HTTP-based |
| 11 | ChromaDB Docs - TS Embedding Reference | https://docs.trychroma.com/reference/typescript/embedding-functions.md | EmbeddingFunction and SparseEmbeddingFunction interfaces |
| 12 | Commander.js GitHub | https://github.com/tj/commander.js | Nested subcommands, lifecycle hooks, option conflicts, TypeScript extra-typings |
| 13 | commander npm registry | https://registry.npmjs.org/commander/latest | v15.0.0, zero dependencies, requires Node >= 22.12.0 |
| 14 | yargs npm registry | https://registry.npmjs.org/yargs/latest | v18.0.0, 6 dependencies, ESM-only, Node ^20.19.0 or ^22.12.0 or >=23 |
| 15 | tsup npm registry | https://registry.npmjs.org/tsup/latest | v8.5.1, esbuild-powered, zero-config TypeScript bundling |
| 16 | tsx npm registry | https://registry.npmjs.org/tsx/latest | v4.22.4, esbuild-based TypeScript execution, single dependency |
| 17 | chalk npm registry | https://registry.npmjs.org/chalk/latest | v5.6.2, zero dependencies, ESM-only |
| 18 | @huggingface/transformers npm | https://registry.npmjs.org/@huggingface/transformers/latest | v4.2.0, ~9.5 MB, runs ONNX models in Node.js via onnxruntime-node |

## Original Request

Refined request specification at `/home/biks/workspace/test-team/docs/design/refined-request-chromactl.md`. The original user request was to build a CLI tool for initializing ChromaDB databases, defining metadata schemas, indexing documents, searching via semantic similarity, and retrieving database statistics. The tool should be a TypeScript CLI named `chromactl`, installable as an npm package, using ChromaDB's default embedding model locally.
