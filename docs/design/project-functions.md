# chromactl -- Functional Requirements

**Last Updated:** 2026-06-26
**Source:** `docs/design/refined-request-chromactl.md`, `docs/design/plan-001-chromactl-implementation.md`

---

## Command Structure

```
chromactl
  init [--db <path>] [--force]
  schema
    create <name> --fields '<json>' | --from-file <path>
    list
    show <name>
    delete <name>
  collection
    create <name> [--schema <name>]
    list
    delete <name> --confirm
    info <name>
  index
    file <path> [--collection <name>] [--metadata '<json>'] [--tag <value>]
                [--chunk-size <n>] [--chunk-overlap <n>] [--no-chunking] [--dry-run]
    dir <path>  [--collection <name>] [--metadata '<json>'] [--tag <value>]
                [--chunk-size <n>] [--chunk-overlap <n>] [--no-chunking] [--dry-run]
  search <query> [--collection <name>] [-n <number>] [--filter '<json>']
                 [--min-score <n>] [--snippet-length <n>] [--full-text] [--json]
  stats [<collection>] [--json]
  server
    start
    stop
    status

Global Options:
  --db <path>       Override database directory
  -v, --verbose     Enable verbose output
  -q, --quiet       Suppress non-essential output
  --json            Output as JSON
  -h, --help        Show help
  --version         Print version
```

---

## Functions by Module

### F-INIT: Database Initialization

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-INIT-01 | Initialize database | Create `.chromactl/` directory and `chromactl.json` config file | `--db <path>` (optional, default `./.chromactl`) | Config file, directory structure | Exits with error if DB already exists (unless `--force`) |
| F-INIT-02 | Force reinitialize | Overwrite existing database configuration | `--force` flag | New config file | Preserves existing ChromaDB data; only resets config |
| F-INIT-03 | Config file creation | Write default `chromactl.json` with version, dbPath, defaults | Config defaults | JSON file | Version: "1.0", port: 8100, chunkSize: 1000, chunkOverlap: 200 |

### F-SCHEMA: Schema Management

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-SCHEMA-01 | Create schema | Define a named metadata schema with typed fields | Schema name, fields JSON or file | Updated `chromactl.json` | Fields have type (string/number/boolean) and required flag |
| F-SCHEMA-02 | List schemas | Display all defined schemas with field summaries | None | Table or JSON | Shows field names, types, required/optional |
| F-SCHEMA-03 | Show schema | Display full definition of a specific schema | Schema name | Full schema JSON/table | Error if schema not found |
| F-SCHEMA-04 | Delete schema | Remove a schema definition | Schema name | Updated `chromactl.json` | Error if schema is bound to a collection |
| F-SCHEMA-05 | Parse schema JSON | Parse and validate inline `--fields` JSON | JSON string | SchemaDefinition | Validate types are string/number/boolean only |
| F-SCHEMA-06 | Load schema from file | Read schema from external JSON file | File path | SchemaDefinition | `--from-file` option |

### F-COLLECTION: Collection Management

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-COLL-01 | Create collection | Create a ChromaDB collection | Collection name, optional schema | ChromaDB collection | Created with `embeddingFunction: null` (self-managed embeddings) |
| F-COLL-02 | Bind schema | Associate a schema with a collection | Collection name, schema name | Updated `chromactl.json` | Stored in `collectionSchemas` map |
| F-COLL-03 | List collections | List all collections with document counts | None | Table or JSON | Uses `listCollections()` + `count()` per collection |
| F-COLL-04 | Delete collection | Delete a collection and all documents | Collection name, `--confirm` flag | Collection removed | Also removes schema binding from config |
| F-COLL-05 | Collection info | Show detailed collection information | Collection name | Table or JSON | Document count, associated schema, metadata |
| F-COLL-06 | Auto-create default | Create "default" collection on first use | Implicit (when no --collection specified) | ChromaDB collection | Created via `getOrCreateCollection` |

### F-EXTRACT: Text Extraction

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-EXT-01 | Extract .txt/.md | Read plain text files directly | File path | Text string | UTF-8 encoding, `fs.readFile` |
| F-EXT-02 | Extract .pdf | Extract text from PDF via pdftotext | File path | Text string | `pdftotext <file> -`, maxBuffer 10MB |
| F-EXT-03 | Extract .docx | Extract text from DOCX via pandoc | File path | Text string | `pandoc <file> -t plain` |
| F-EXT-04 | Extract .html | Extract text from HTML via pandoc | File path | Text string | `pandoc <file> -t plain` |
| F-EXT-05 | Check dependency | Verify a system tool is installed | Tool name (e.g., "pdftotext") | Boolean | Uses `which` command |
| F-EXT-06 | Validate dependencies | Check all needed tools for a set of file extensions | Extension list | Missing tools list | Run before batch indexing |
| F-EXT-07 | Dispatch by extension | Route extraction to correct handler by file extension | File path | Text string | Supported: .txt, .md, .pdf, .docx, .html |

### F-CHUNK: Text Chunking

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-CHUNK-01 | Chunk text | Split text into overlapping character-based chunks | Text, options (size, overlap) | TextChunk[] | Default: 1000 chars, 200 overlap |
| F-CHUNK-02 | Boundary detection | Break chunks at word/sentence boundaries | Text, target offset | Adjusted offset | Prefers sentence ends (. ! ?), falls back to word boundaries |
| F-CHUNK-03 | Make chunk ID | Generate ChromaDB document ID for a chunk | File path, chunk index | String | Format: `<absolute-path>::chunk-<n>` |
| F-CHUNK-04 | Make single doc ID | Generate ChromaDB document ID for unchunked doc | File path | String | Format: `<absolute-path>` |

### F-EMBED: Embedding Management

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-EMBED-01 | Initialize pipeline | Load ONNX model and create inference pipeline | Cache dir (optional) | Pipeline instance | Singleton pattern, lazy loading |
| F-EMBED-02 | Generate embeddings | Produce 384-dim vectors from text | String array | number[][] | Uses cached pipeline, batch processing |
| F-EMBED-03 | Check model cached | Determine if ONNX model files exist in cache | None | Boolean | Checks `.chromactl/models/` directory |
| F-EMBED-04 | Download progress | Report model download progress to user | Progress callback | Console output | First-run only (~24-91 MB download) |

### F-INDEX: Document Indexing

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-IDX-01 | Index single file | Extract, chunk, embed, and upsert a document | File path, collection, metadata | IndexResult | Upsert semantics (dedup by path) |
| F-IDX-02 | Index directory | Recursively index all supported files | Dir path, collection, metadata | IndexResult | Concurrent extraction (limit 5), sequential DB writes |
| F-IDX-03 | Auto-metadata | Generate automatic metadata for documents | File path, extracted text | Metadata object | source_path, file_type, indexed_at, file_size_bytes, content_length |
| F-IDX-04 | Validate metadata | Check user metadata against collection schema | Metadata, schema | ValidationResult | Error if required fields missing or wrong types |
| F-IDX-05 | Merge metadata | Combine auto-metadata, user --metadata, and --tag | Multiple metadata sources | Merged metadata | User metadata overrides auto where keys conflict |
| F-IDX-06 | Dry run | Preview indexing without writing to DB | File/dir path | File list with metadata | `--dry-run` flag |
| F-IDX-07 | Progress reporting | Show indexing progress for directory operations | File count, current file | Console output | `[3/15] Indexing report.pdf...` |
| F-IDX-08 | Summary report | Print indexing results summary | IndexResult | Console output | Files processed, chunks created, skipped files |

### F-SEARCH: Semantic Search

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-SRCH-01 | Query collection | Perform semantic similarity search | Query text, collection, options | SearchResult[] | Uses `collection.query()` with pre-computed query embedding |
| F-SRCH-02 | Distance-to-similarity | Convert ChromaDB distance to 0-1 similarity | Distance value | Similarity score | L2: `1/(1+distance)`, Cosine: `1-distance` |
| F-SRCH-03 | Score filtering | Filter results by minimum similarity score | Results, min-score | Filtered results | `--min-score` option |
| F-SRCH-04 | Metadata filtering | Apply ChromaDB where clause | Filter JSON | Where clause | `--filter` option, passed to `collection.query()` |
| F-SRCH-05 | Format results | Display results with rank, score, path, snippet | SearchResult[] | Console output | Snippet truncated to --snippet-length (default 200) |
| F-SRCH-06 | Full text output | Show complete document/chunk text | SearchResult[] | Console output | `--full-text` flag |
| F-SRCH-07 | JSON output | Output results as JSON array | SearchResult[] | JSON string | `--json` flag, pipeable to jq |

### F-STATS: Statistics

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-STAT-01 | Database overview | Show database-level statistics | None | Console output or JSON | Collection count, total documents, disk size |
| F-STAT-02 | Collection stats | Show collection-level statistics | Collection name | Console output or JSON | Doc count, chunks, unique sources, file type breakdown |
| F-STAT-03 | Metadata distribution | Calculate metadata field frequency | Collection docs | Field -> count map | Which metadata fields exist and how many docs have each |
| F-STAT-04 | Disk size | Calculate database size on disk | DB path | Bytes | Recursive directory size of `.chromactl/` |

### F-SERVER: Server Lifecycle

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-SVR-01 | Start server | Spawn ChromaDB server process | Persist path, port, host | PID, connected client | Spawns via node + chromadb CLI binary |
| F-SVR-02 | Stop server | Gracefully terminate server | PID | Success/failure | SIGTERM, 10s timeout, fallback SIGKILL |
| F-SVR-03 | Health check | Verify server is accepting connections | Host, port | Boolean | HTTP GET /api/v2/heartbeat |
| F-SVR-04 | Ensure running | Start server if not already running | Config | ChromaClient | Auto-start on first DB command |
| F-SVR-05 | PID management | Read/write/delete server.json | Project root | ServerInfo | Stale PID detection, cleanup |
| F-SVR-06 | Port conflict detection | Check if port is available | Port, host | Boolean | Pre-spawn check via net.createServer |
| F-SVR-07 | Server status | Report running/stopped state | None | Status info | PID, port, uptime |

### F-CONFIG: Configuration

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-CFG-01 | Find config | Walk up directories to find chromactl.json | Start directory | Config path or null | Stops at filesystem root |
| F-CFG-02 | Load config | Read and parse chromactl.json | Config path | ChromactlConfig | Validates structure |
| F-CFG-03 | Save config | Write chromactl.json atomically | Config path, config data | File written | Pretty-printed JSON |
| F-CFG-04 | Resolve config | Determine config from --db, env var, or discovery | CLI options | Config + path | Priority: --db > CHROMACTL_DB > dir walk > default |
| F-CFG-05 | Default config | Generate default configuration values | None | ChromactlConfig | Version 1.0, port 8100, etc. |

### F-OUTPUT: Output Formatting

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-OUT-01 | Text table | Format data as aligned text table | Headers, rows | Console output | For list/info commands |
| F-OUT-02 | JSON output | Format data as JSON | Any data | JSON string | `--json` flag |
| F-OUT-03 | Colored output | Apply terminal colors | Message, level | Colored string | Red=error, green=success, yellow=warn |
| F-OUT-04 | Respect NO_COLOR | Disable colors when env var set | None | Plain text | `NO_COLOR` environment variable |
| F-OUT-05 | Verbose logging | Show detailed operation info | Message | Console output | Only when `--verbose` flag is set |
| F-OUT-06 | Quiet mode | Suppress non-essential output | None | Minimal output | Only errors and direct results |

### F-ERROR: Error Handling

| ID | Function | Description | Input | Output | Notes |
|----|----------|-------------|-------|--------|-------|
| F-ERR-01 | No database | Detect and report missing chromactl database | None | Error message + exit 1 | "Run 'chromactl init' first" |
| F-ERR-02 | Invalid JSON | Parse error for --metadata, --filter, --fields | JSON string | Error message + exit 1 | Show problematic input |
| F-ERR-03 | Missing dependency | Detect missing pdftotext/pandoc | Tool name | Error message + exit 1 | Include install instructions |
| F-ERR-04 | Extraction failure | Handle corrupt/unreadable files | File path, error | Error message or skip | Single file: exit 1; batch: skip and report |
| F-ERR-05 | Server failure | Handle server start/stop/connection errors | Error | Error message + exit 1 | Suggest checking port, permissions |
| F-ERR-06 | Schema violation | Report metadata validation errors | Field, expected, actual | Error message + exit 1 | Name missing fields and expected types |

---

## Cross-Cutting Requirements

| ID | Requirement | Details |
|----|-------------|---------|
| NFR-01 | Performance -- single file | Index a <10KB file in under 5 seconds (including embedding) |
| NFR-02 | Performance -- search | Return results in under 3 seconds for up to 10,000 chunks |
| NFR-03 | Performance -- batch | Concurrent text extraction during directory indexing |
| NFR-04 | Exit codes | All errors produce non-zero exit codes |
| NFR-05 | Color support | Colored output respecting NO_COLOR env var |
| NFR-06 | Progress indication | File count progress during directory indexing |
| NFR-07 | Help examples | Every command has at least one usage example in --help |
| NFR-08 | TypeScript strict | All code compiles with TypeScript strict mode |
| NFR-09 | Unit tests | Tests for extraction, chunking, schema validation, CLI parsing |
| NFR-10 | Integration tests | Tests for full init-index-search workflow |
