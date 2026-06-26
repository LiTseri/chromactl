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

/**
 * Database-level statistics.
 */
export interface DatabaseStats {
  collectionCount: number;
  totalDocuments: number;
  diskSizeBytes: number;
  diskSizeHuman: string;
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
  schema?: string;
  fileTypeBreakdown: Record<string, number>;
  metadataFields: Record<string, number>;
}

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

// ---------------------------------------------------------------------------
// Command Option Types
// ---------------------------------------------------------------------------

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
  fields?: string;
  fromFile?: string;
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
  metadata?: string;
  tag?: string;
  chunkSize?: string;
  chunkOverlap?: string;
  /**
   * Commander stores --no-chunking as `chunking: false`.
   * The --no-X pattern creates a `X` option defaulting to true.
   */
  chunking?: boolean;
  dryRun?: boolean;
}

/**
 * Options for the search command.
 */
export interface SearchOptions extends GlobalOptions {
  collection?: string;
  results?: string;
  filter?: string;
  minScore?: string;
  snippetLength?: string;
  fullText?: boolean;
}

// ---------------------------------------------------------------------------
// Formatter Options
// ---------------------------------------------------------------------------

export interface FormatterOptions {
  json?: boolean;
  quiet?: boolean;
  verbose?: boolean;
}

// ---------------------------------------------------------------------------
// Validation Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dependency Types
// ---------------------------------------------------------------------------

export interface MissingDependency {
  tool: string;
  requiredFor: string;
  installHint: string;
}

// ---------------------------------------------------------------------------
// Command Context
// ---------------------------------------------------------------------------

/**
 * Context object shared across command handlers via preAction hooks.
 */
export interface CommandContext {
  config: ChromactlConfig;
  configPath: string;
  projectDir: string;
  formatter: FormatterInstance;
  client?: unknown; // ChromaClient -- typed as unknown to avoid import in types
  embeddingManager?: unknown; // EmbeddingManager -- typed as unknown to avoid import in types
}

/**
 * Formatter instance interface for the command context.
 * Mirrors the Formatter class public API.
 */
export interface FormatterInstance {
  success(message: string): void;
  error(message: string): void;
  warn(message: string): void;
  info(message: string): void;
  verbose(message: string): void;
  table(headers: string[], rows: (string | number)[][]): void;
  json(data: unknown): void;
  raw(text: string): void;
  readonly isJson: boolean;
  readonly isQuiet: boolean;
  readonly isVerbose: boolean;
}
