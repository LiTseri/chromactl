# Refined Request: chromactl -- ChromaDB CLI Management Tool

## Category
Development

## Objective
Build a TypeScript command-line tool named `chromactl` that provides a complete interface for managing a local ChromaDB instance: initializing databases, defining metadata schemas, indexing documents (with automatic text extraction from multiple file formats), performing semantic search across indexed documents, and retrieving database statistics. The tool must be installable as an npm package and use ChromaDB's default embedding model (all-MiniLM-L6-v2 via the built-in embedding function).

## Scope

### In scope
- CLI application with subcommands for init, schema, index, search, and stats operations
- Text extraction from .txt, .md, .pdf, .docx, and .html files using system CLI tools (pdftotext, pandoc)
- Local ChromaDB persistence (no external server required -- using ChromaDB's persistent client)
- Metadata schema definition, validation, and enforcement during indexing
- Semantic similarity search with configurable result count and metadata filtering
- Database and collection statistics reporting
- Structured output (human-readable by default, JSON optional)
- npm-installable package with a `chromactl` binary entry point

### Out of scope
- Web UI or REST API wrapper
- Remote ChromaDB server management (connecting to external ChromaDB servers)
- Custom embedding models or API-based embeddings (OpenAI, Cohere, etc.)
- Document update/versioning or diff tracking
- User authentication or access control
- Batch operations across multiple databases simultaneously
- OCR for scanned PDFs (only text-based PDF extraction)
- Spreadsheet formats (.xlsx, .csv) or image files

## Requirements

### FR-1: Database Initialization (`chromactl init`)
1.1. Initialize a new ChromaDB persistent database at a specified directory path.
1.2. If no path is provided, default to `./.chromactl` in the current working directory.
1.3. Create the directory structure if it does not exist.
1.4. Create a configuration file (`chromactl.json`) in the database directory to store settings (database path, default collection name, schema references).
1.5. If the directory already contains a ChromaDB database, print a warning and exit without overwriting (unless `--force` flag is provided).
1.6. Print a confirmation message with the database path upon successful initialization.

### FR-2: Schema Management (`chromactl schema`)
2.1. **`chromactl schema create <name>`**: Define a named metadata schema as a JSON structure specifying field names, types (`string`, `number`, `boolean`), and whether each field is required or optional.
2.2. Schema definitions are stored in the `chromactl.json` configuration file under a `schemas` key.
2.3. **`chromactl schema list`**: List all defined schemas with their field definitions.
2.4. **`chromactl schema show <name>`**: Display the full definition of a specific schema.
2.5. **`chromactl schema delete <name>`**: Remove a schema definition. Fail with an error if the schema is currently associated with a collection.
2.6. Schema input can be provided via:
  - Inline JSON argument (`--fields '{"author": {"type": "string", "required": true}}'`)
  - A JSON file reference (`--from-file schema.json`)
  - Interactive prompts if neither is provided (prompt for field name, type, required -- repeat until done)

### FR-3: Collection Management (`chromactl collection`)
3.1. **`chromactl collection create <name>`**: Create a new ChromaDB collection. Optionally associate a schema via `--schema <schema-name>`.
3.2. **`chromactl collection list`**: List all collections in the database with document counts.
3.3. **`chromactl collection delete <name>`**: Delete a collection and all its documents. Require `--confirm` flag or interactive confirmation.
3.4. **`chromactl collection info <name>`**: Show detailed information about a collection (document count, associated schema, metadata).
3.5. If no collection is specified in index/search commands, use the default collection named `default` (auto-created on first use).

### FR-4: Document Indexing (`chromactl index`)
4.1. **`chromactl index file <path>`**: Index a single document file. Extract text content, generate embeddings, and store in the specified (or default) collection.
4.2. **`chromactl index dir <path>`**: Recursively index all supported documents in a directory. Supported extensions: `.txt`, `.md`, `.pdf`, `.docx`, `.html`.
4.3. `--collection <name>`: Target a specific collection (default: `default`).
4.4. `--metadata '{"key": "value"}'`: Attach metadata key-value pairs to the indexed document(s). When indexing a directory, the same metadata applies to all documents.
4.5. `--tag <value>`: Shorthand for adding a `tag` metadata field (convenience for common use case).
4.6. Text extraction strategy by file type:
  - `.txt`, `.md`: Read file contents directly (UTF-8).
  - `.pdf`: Use `pdftotext <file> -` (shell out to system command).
  - `.docx`: Use `pandoc <file> -t plain` (shell out to system command).
  - `.html`: Use `pandoc <file> -t plain` (shell out to system command).
4.7. If a collection has an associated schema, validate provided metadata against the schema before indexing. Reject the document with a clear error if required fields are missing or types are wrong.
4.8. Store the following auto-generated metadata on every document:
  - `source_path`: Absolute path to the original file.
  - `file_type`: File extension (e.g., `pdf`, `docx`).
  - `indexed_at`: ISO 8601 timestamp of when the document was indexed.
  - `file_size_bytes`: Size of the original file in bytes.
  - `content_length`: Character count of the extracted text.
4.9. Use the document's absolute file path as the ChromaDB document ID to enable deduplication. If the same file is indexed again, update (upsert) the existing entry.
4.10. For large documents, split text into chunks of configurable size (default: 1000 characters with 200-character overlap). Each chunk is stored as a separate document entry with a chunk index suffix on the ID (e.g., `/path/to/file.pdf::chunk-0`). All chunks share the same metadata plus a `chunk_index` field.
4.11. `--chunk-size <number>`: Override the default chunk size (in characters).
4.12. `--chunk-overlap <number>`: Override the default chunk overlap (in characters).
4.13. `--no-chunking`: Disable chunking; store the entire document as a single entry regardless of length.
4.14. Print a summary after indexing: number of documents processed, number of chunks created, any skipped files with reasons.
4.15. `--dry-run`: Show what would be indexed without actually writing to the database.

### FR-5: Search (`chromactl search`)
5.1. **`chromactl search <query>`**: Perform a semantic similarity search using the query text against the specified (or default) collection.
5.2. `--collection <name>`: Target a specific collection (default: `default`).
5.3. `-n <number>` or `--results <number>`: Number of results to return (default: 5, max: 50).
5.4. `--filter '{"key": "value"}'`: Apply a ChromaDB metadata filter (where clause) to narrow results.
5.5. `--min-score <number>`: Filter out results below a minimum similarity score (0.0 to 1.0). Note: ChromaDB returns distances; the tool must convert to a normalized similarity score for user-facing output.
5.6. Output each result with:
  - Rank number
  - Similarity score (0.0-1.0, higher is more similar)
  - Source file path (`source_path` metadata)
  - Chunk index (if applicable)
  - A text snippet (first 200 characters of the matching chunk, configurable via `--snippet-length`)
  - Metadata key-value pairs
5.7. `--full-text`: Print the full stored text of each result instead of a snippet.
5.8. `--json`: Output results as a JSON array for programmatic consumption.

### FR-6: Statistics (`chromactl stats`)
6.1. **`chromactl stats`**: Show an overview of the entire database -- total collections, total documents, total chunks, database size on disk.
6.2. **`chromactl stats <collection>`**: Show statistics for a specific collection -- document count, chunk count, unique source files, metadata field distribution (which fields exist and how many documents have each), file type breakdown.
6.3. `--json`: Output statistics as JSON.

### FR-7: Global Options
7.1. `--db <path>`: Override the database directory (default: auto-discover by walking up from cwd to find `chromactl.json`, falling back to `./.chromactl`).
7.2. `--verbose` / `-v`: Enable verbose output (show extraction commands, timing, ChromaDB operations).
7.3. `--quiet` / `-q`: Suppress all output except errors and direct query results.
7.4. `--json`: Request JSON output (applies to all commands that produce output).
7.5. `--help` / `-h`: Show help for any command or subcommand.
7.6. `--version`: Print the tool version.

### NFR-1: Performance
- Indexing a single small document (< 10 KB) must complete in under 5 seconds (including embedding generation on first run; model loading is a one-time cost).
- Directory indexing must process files concurrently where possible (parallel text extraction, sequential ChromaDB writes).
- Search queries must return results in under 3 seconds for collections with up to 10,000 chunks.

### NFR-2: Error Handling
- All errors must produce a non-zero exit code.
- Error messages must be human-readable, include the failing operation, and suggest corrective action where possible.
- If a text extraction tool (pdftotext, pandoc) is not installed, the tool must detect this at startup (for the relevant command) and print a clear message naming the missing dependency and how to install it.
- If a file cannot be extracted (corrupt PDF, encoding issues), skip it during batch operations and report it in the summary. For single-file operations, exit with an error.
- Network errors or ChromaDB connection failures must be caught and reported clearly.

### NFR-3: Usability
- The CLI must use colored output for terminals that support it (errors in red, success in green, warnings in yellow). Respect `NO_COLOR` environment variable.
- Progress indication during directory indexing (file count progress, e.g., `[3/15] Indexing report.pdf...`).
- Help text for every command must include at least one usage example.

### NFR-4: Code Quality
- Written in TypeScript with strict mode enabled.
- ESLint configured for the project.
- Unit tests for text extraction, chunking logic, schema validation, and CLI argument parsing.
- Integration tests for the full init-index-search workflow using a temporary database.

## Technical Constraints

### Language and Runtime
- TypeScript targeting Node.js (ES2022+, Node 22 compatible as per environment).
- Package manager: pnpm (pre-installed in the environment).
- Build tool: tsup or tsx for compilation; the CLI entry point must work via `npx` and as a globally installed binary.

### Dependencies (primary)
- `chromadb`: Official ChromaDB JavaScript/TypeScript client.
- `commander` or `yargs`: CLI argument parsing framework.
- `chalk`: Terminal color output.
- `ora`: Spinner/progress indication.
- Additional dependencies as needed, but prefer minimal dependency footprint.

### ChromaDB Architecture
- Use ChromaDB's **persistent client** mode (in-process, no separate server needed). The `chromadb` npm package supports this via `ChromaClient` with a persistent directory path.
- Note: The ChromaDB JS client may require a running ChromaDB server. If the JS client does not support embedded/persistent mode natively, the tool must manage a local ChromaDB server process (start on demand, stop after operation) or document this as a prerequisite. This must be investigated during implementation.

### Text Extraction
- Shell out to system CLI tools for document conversion. The following tools are pre-installed in the environment:
  - `pdftotext` (from poppler-utils) for PDF extraction
  - `pandoc` for DOCX, HTML, and other format conversion
- Text files (.txt, .md) are read directly via Node.js `fs` module.
- All text extraction must handle UTF-8 encoding. Non-UTF-8 files should be detected and reported as errors.

### Project Structure
```
/home/biks/workspace/test-team/
  package.json
  tsconfig.json
  .eslintrc.json (or eslint.config.js)
  src/
    index.ts              # CLI entry point
    commands/
      init.ts
      schema.ts
      collection.ts
      index.ts
      search.ts
      stats.ts
    lib/
      db.ts               # ChromaDB client management
      extractor.ts         # Text extraction from files
      chunker.ts           # Text chunking logic
      schema-validator.ts  # Metadata schema validation
      config.ts            # Configuration file management
      output.ts            # Output formatting (text/JSON)
    types/
      index.ts             # Shared type definitions
  tests/
    unit/
    integration/
  docs/
    design/
```

### Configuration File Format (`chromactl.json`)
```json
{
  "version": "1.0",
  "dbPath": ".chromactl/chroma-data",
  "defaultCollection": "default",
  "chunkSize": 1000,
  "chunkOverlap": 200,
  "schemas": {
    "article": {
      "fields": {
        "author": { "type": "string", "required": true },
        "category": { "type": "string", "required": false },
        "year": { "type": "number", "required": false }
      }
    }
  }
}
```

## Acceptance Criteria

### AC-1: Initialization
- [ ] Running `chromactl init` in an empty directory creates a `.chromactl` directory and a `chromactl.json` config file.
- [ ] Running `chromactl init --db /tmp/mydb` creates the database at the specified path.
- [ ] Running `chromactl init` in a directory that already has a database prints a warning and exits with code 1.
- [ ] Running `chromactl init --force` in a directory that already has a database reinitializes it.

### AC-2: Schema Management
- [ ] `chromactl schema create article --fields '{"author":{"type":"string","required":true},"year":{"type":"number","required":false}}'` creates a schema named "article".
- [ ] `chromactl schema list` shows all schemas with field summaries.
- [ ] `chromactl schema show article` prints the full schema definition.
- [ ] `chromactl schema delete article` removes the schema when it is not bound to any collection.
- [ ] `chromactl schema delete article` fails with an error when the schema is bound to a collection.

### AC-3: Collection Management
- [ ] `chromactl collection create papers --schema article` creates a collection with schema enforcement.
- [ ] `chromactl collection list` displays all collections with document counts.
- [ ] `chromactl collection delete papers --confirm` removes the collection.
- [ ] `chromactl collection delete papers` (without --confirm) prompts for confirmation interactively.

### AC-4: Document Indexing
- [ ] `chromactl index file README.md` indexes a markdown file into the default collection.
- [ ] `chromactl index dir ./docs` recursively indexes all supported files in the directory.
- [ ] `chromactl index file paper.pdf --collection papers --metadata '{"author":"Smith","year":2024}'` indexes with metadata validated against the collection's schema.
- [ ] `chromactl index file paper.pdf --collection papers` (missing required "author" field) fails with a schema validation error.
- [ ] Re-indexing the same file upserts rather than creating duplicates.
- [ ] A large document is automatically split into chunks; each chunk appears as a separate entry with correct chunk_index metadata.
- [ ] `chromactl index dir ./docs --dry-run` lists files that would be indexed without modifying the database.
- [ ] Unsupported file types in a directory are silently skipped and reported in the summary.
- [ ] If `pdftotext` is not installed, attempting to index a PDF produces a clear error message.

### AC-5: Search
- [ ] `chromactl search "machine learning techniques"` returns the top 5 most similar documents from the default collection.
- [ ] `chromactl search "neural networks" -n 10 --collection papers` returns 10 results from the "papers" collection.
- [ ] `chromactl search "deep learning" --filter '{"author":"Smith"}'` only returns documents matching the metadata filter.
- [ ] Each result displays rank, similarity score, source path, snippet, and metadata.
- [ ] `chromactl search "query" --json` outputs valid JSON that can be piped to `jq`.
- [ ] `chromactl search "query" --full-text` shows complete document/chunk text.

### AC-6: Statistics
- [ ] `chromactl stats` shows database-level overview (collection count, total documents, disk size).
- [ ] `chromactl stats papers` shows collection-level details including file type breakdown and metadata field distribution.
- [ ] `chromactl stats --json` outputs valid JSON.

### AC-7: Error Handling
- [ ] All error conditions produce non-zero exit codes.
- [ ] Running any command without initializing first produces a helpful error: "No chromactl database found. Run 'chromactl init' first."
- [ ] Invalid metadata JSON arguments produce a parse error with the problematic input highlighted.
- [ ] Missing system dependencies (pdftotext, pandoc) are detected and reported before operations fail.

### AC-8: Global Behavior
- [ ] `chromactl --version` prints the version number.
- [ ] `chromactl --help` and `chromactl <command> --help` print contextual help with examples.
- [ ] `--verbose` flag increases output detail for any command.
- [ ] `--quiet` flag suppresses non-essential output.
- [ ] The `NO_COLOR` environment variable disables colored output.

## Assumptions

- **ChromaDB JS client persistent mode**: It is assumed that the `chromadb` npm package can operate in a persistent/embedded mode without requiring a separate ChromaDB server process. If this is not the case, the implementation should either bundle a ChromaDB server startup mechanism or document the server as a prerequisite. This is the highest-risk assumption and should be validated early in implementation. *Basis: ChromaDB's Python client supports persistent mode; the JS client documentation suggests similar capability but may require a server.*

- **Embedding model**: The ChromaDB default embedding function in the JS client will use `all-MiniLM-L6-v2` or an equivalent model. The first run may require a model download. *Basis: ChromaDB documentation states this is the default.*

- **System tool availability**: `pdftotext` and `pandoc` are pre-installed in the target environment. The tool will detect their absence gracefully but will not install them. *Basis: User's CLAUDE.md confirms these tools are available.*

- **Chunk size unit**: Chunk size is measured in characters, not tokens or words. Character-based chunking is simpler and sufficient for a general-purpose tool. *Basis: Common practice in document indexing tools.*

- **Single-user**: The tool is designed for single-user, local use. No concurrent access protection is implemented beyond what ChromaDB provides natively. *Basis: CLI tool context implies single-user.*

- **Collection-schema binding**: A collection can be associated with at most one schema. The schema is enforced at index time, not retroactively on existing documents. *Basis: Simplest reasonable interpretation of "define metadata schemas for indexed documents."*

- **Similarity score normalization**: ChromaDB returns distances (lower = more similar). The tool will convert these to similarity scores (higher = more similar) using `1 / (1 + distance)` or a similar normalization. The exact formula may be adjusted during implementation. *Basis: User-facing similarity scores are more intuitive than raw distances.*

- **No daemon mode**: The tool operates as a one-shot CLI command. There is no long-running server or daemon component managed by chromactl itself. *Basis: Standard CLI tool pattern.*

## Open Questions

1. **ChromaDB JS client embedding support**: Does the `chromadb` npm package bundle a default embedding function, or does it require an external embedding service? If the latter, the tool may need to integrate `@xenova/transformers` (now `@huggingface/transformers`) for local embedding generation. This must be resolved during the implementation spike.

2. **Maximum document size**: What is the practical upper limit for document size before performance degrades? The chunking mechanism mitigates this, but extremely large files (100+ MB) may need special handling (streaming extraction). For now, no explicit file size limit is enforced.

3. **Config file discovery**: The specification defines walking up from cwd to find `chromactl.json`. Should the tool also support a `CHROMACTL_DB` environment variable as an alternative to `--db`? Assumed yes for convenience, but this is a minor detail that can be decided during implementation.

## Original Request

> I want you to create a command line tool to allow me to
> - initialize an empty chromadb database
> - define metadata schemas for the indexed documents
> - index individual documents or all the documents from a folder
> - search the database indexes to locate the closest indexed document
> - get statistics for the database indexes

User clarifications:
1. Document types: Common formats (.txt, .md, .pdf, .docx, .html) -- uses pre-installed CLI tools (pdftotext, pandoc)
2. Embedding approach: ChromaDB default (all-MiniLM-L6-v2 via sentence-transformers, runs locally, no API key)
3. CLI: TypeScript CLI tool named "chromactl", installable as a package
