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
  public readonly filePath: string;

  constructor(filePath: string, message: string, hint?: string) {
    super(`Failed to extract text from ${filePath}: ${message}`, 3, hint);
    this.filePath = filePath;
    this.name = 'ExtractionError';
  }
}

/**
 * Missing system dependency (pdftotext, pandoc).
 */
export class DependencyError extends ChromactlError {
  public readonly tool: string;
  public readonly installHint: string;

  constructor(tool: string, installHint: string) {
    super(
      `Required tool '${tool}' is not installed.`,
      4,
      `Install it with: ${installHint}`,
    );
    this.tool = tool;
    this.installHint = installHint;
    this.name = 'DependencyError';
  }
}

/**
 * Metadata does not conform to the schema.
 */
export class SchemaValidationError extends ChromactlError {
  public readonly validationErrors: Array<{ field: string; message: string }>;

  constructor(validationErrors: Array<{ field: string; message: string }>) {
    const details = validationErrors
      .map((e) => `  - ${e.field}: ${e.message}`)
      .join('\n');
    super(`Schema validation failed:\n${details}`, 5);
    this.validationErrors = validationErrors;
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

/**
 * ChromaDB API errors.
 */
export class ChromaDBError extends ChromactlError {
  constructor(message: string, hint?: string) {
    super(message, 6, hint);
    this.name = 'ChromaDBError';
  }
}
