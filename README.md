# chromactl

A command-line tool for managing a local ChromaDB vector database. Initialize databases, define metadata schemas, index documents with automatic text extraction, perform semantic search, and view statistics.

## Prerequisites

- Node.js >= 22
- pnpm
- `pdftotext` (from poppler-utils) -- for PDF text extraction
- `pandoc` -- for DOCX and HTML text extraction

```bash
# Install system dependencies (Ubuntu/Debian)
sudo apt install poppler-utils pandoc
```

## Installation

```bash
git clone <repo-url>
cd chromactl
pnpm install
pnpm run build
```

After building, you can run the tool directly:

```bash
node dist/index.js --help
```

Or install it globally:

```bash
pnpm link --global
chromactl --help
```

## Quick Start

```bash
# Initialize a database in the current directory
chromactl init

# Define a metadata schema
chromactl schema create article --fields '{
  "author": {"type": "string", "required": true},
  "year":   {"type": "number", "required": false}
}'

# Create a collection with the schema
chromactl collection create papers --schema article

# Index a single document
chromactl index file paper.pdf --collection papers --metadata '{"author": "Smith", "year": 2024}'

# Index all documents in a directory
chromactl index dir ./docs

# Search
chromactl search "machine learning techniques"

# View stats
chromactl stats
chromactl stats papers
```

## Commands

### `chromactl init [path]`

Initialize a new database. Creates a `chromactl.json` config file and a `.chromactl/` data directory.

```bash
chromactl init                  # Initialize in current directory
chromactl init /tmp/mydb        # Initialize at a specific path
chromactl init --force          # Reinitialize an existing database
```

### `chromactl schema`

Manage metadata schemas that enforce structure on indexed documents.

```bash
# Create a schema from inline JSON
chromactl schema create article --fields '{"author":{"type":"string","required":true}}'

# Create a schema from a file
chromactl schema create article --from-file schema.json

# List all schemas
chromactl schema list

# Show a specific schema
chromactl schema show article

# Delete a schema (must not be bound to a collection)
chromactl schema delete article
```

### `chromactl collection`

Manage ChromaDB collections.

```bash
# Create a collection, optionally with a schema
chromactl collection create papers --schema article

# List collections with document counts
chromactl collection list

# Show collection details
chromactl collection info papers

# Delete a collection
chromactl collection delete papers --confirm
```

### `chromactl index`

Index documents into a collection. Supports `.txt`, `.md`, `.pdf`, `.docx`, and `.html` files.

```bash
# Index a single file
chromactl index file report.pdf --collection papers

# Index with metadata
chromactl index file report.pdf --metadata '{"author": "Smith"}' --tag research

# Index an entire directory
chromactl index dir ./documents --collection papers

# Dry run (preview without indexing)
chromactl index dir ./documents --dry-run

# Custom chunk size
chromactl index file large-doc.pdf --chunk-size 2000 --chunk-overlap 400

# Disable chunking
chromactl index file short-doc.txt --no-chunking
```

Large documents are automatically split into overlapping chunks (default: 1000 characters, 200 overlap). Each chunk is stored as a separate entry with shared metadata.

### `chromactl search <query>`

Perform semantic similarity search across indexed documents.

```bash
# Basic search (top 5 results)
chromactl search "neural network architectures"

# More results from a specific collection
chromactl search "deep learning" -n 10 --collection papers

# Filter by metadata
chromactl search "transformers" --filter '{"author": "Smith"}'

# Set minimum similarity threshold
chromactl search "attention mechanisms" --min-score 0.5

# Full document text instead of snippets
chromactl search "query" --full-text

# JSON output for scripting
chromactl search "query" --json | jq '.[] | .sourcePath'
```

### `chromactl stats [collection]`

View database or collection statistics.

```bash
# Database overview
chromactl stats

# Collection details (file types, metadata fields)
chromactl stats papers

# JSON output
chromactl stats --json
```

### `chromactl server`

Manage the ChromaDB server process. The server starts automatically when needed, but you can also control it explicitly.

```bash
chromactl server start
chromactl server stop
chromactl server status
```

## Global Options

| Option | Description |
|--------|-------------|
| `--db <path>` | Override the database directory |
| `-v, --verbose` | Show detailed output |
| `-q, --quiet` | Suppress non-essential output |
| `--json` | Output as JSON |
| `--version` | Print version |
| `--help` | Show help |

The database path is resolved in this order: `--db` flag > `CHROMACTL_DB` environment variable > walk up from cwd to find `chromactl.json` > default `./.chromactl`.

## Configuration

The `chromactl.json` file stores database settings and schema definitions:

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

## Architecture

chromactl manages a local ChromaDB server transparently. The server is started automatically on the first command that needs database access and persists between commands (PID tracked in `.chromactl/server.json`).

Embeddings are generated client-side using `all-MiniLM-L6-v2` (384-dimensional vectors via ONNX Runtime). The model (~24 MB) is downloaded on first use and cached in `.chromactl/models/`.

Text extraction delegates to system tools: `pdftotext` for PDFs and `pandoc` for DOCX/HTML. Plain text and markdown files are read directly.

## Development

```bash
# Run in development mode
pnpm dev -- init

# Type check
pnpm typecheck

# Run tests
pnpm test

# Run tests in watch mode
pnpm test:watch

# Lint
pnpm lint

# Build
pnpm run build
```

## License

ISC
