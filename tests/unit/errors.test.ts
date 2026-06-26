import { describe, it, expect } from 'vitest';

import {
  ChromactlError,
  ConfigNotFoundError,
  ServerError,
  ExtractionError,
  DependencyError,
  SchemaValidationError,
  InvalidArgumentError,
  CollectionNotFoundError,
  SchemaNotFoundError,
  ChromaDBError,
} from '../../src/lib/errors.js';

// ---------------------------------------------------------------------------
// ChromactlError (base class)
// ---------------------------------------------------------------------------

describe('ChromactlError', () => {
  it('has a default exit code of 1', () => {
    const err = new ChromactlError('test error');
    expect(err.exitCode).toBe(1);
    expect(err.message).toBe('test error');
  });

  it('accepts a custom exit code', () => {
    const err = new ChromactlError('custom', 42);
    expect(err.exitCode).toBe(42);
  });

  it('accepts an optional hint', () => {
    const err = new ChromactlError('msg', 1, 'try this');
    expect(err.hint).toBe('try this');
  });

  it('is an instance of Error', () => {
    const err = new ChromactlError('test');
    expect(err).toBeInstanceOf(Error);
  });

  it('has name set to ChromactlError', () => {
    const err = new ChromactlError('test');
    expect(err.name).toBe('ChromactlError');
  });
});

// ---------------------------------------------------------------------------
// ConfigNotFoundError
// ---------------------------------------------------------------------------

describe('ConfigNotFoundError', () => {
  it('has exit code 1', () => {
    const err = new ConfigNotFoundError();
    expect(err.exitCode).toBe(1);
  });

  it('includes the searched path in the message', () => {
    const err = new ConfigNotFoundError('/home/user/project');
    expect(err.message).toContain('/home/user/project');
    expect(err.message).toContain('No chromactl database found');
  });

  it('has a hint about running init', () => {
    const err = new ConfigNotFoundError();
    expect(err.hint).toContain('chromactl init');
  });

  it('is an instance of ChromactlError', () => {
    const err = new ConfigNotFoundError();
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// ServerError
// ---------------------------------------------------------------------------

describe('ServerError', () => {
  it('has exit code 2', () => {
    const err = new ServerError('server failed');
    expect(err.exitCode).toBe(2);
  });

  it('includes the message', () => {
    const err = new ServerError('could not start');
    expect(err.message).toBe('could not start');
  });

  it('is an instance of ChromactlError', () => {
    const err = new ServerError('test');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// ExtractionError
// ---------------------------------------------------------------------------

describe('ExtractionError', () => {
  it('has exit code 3', () => {
    const err = new ExtractionError('/path/to/file.pdf', 'corrupt file');
    expect(err.exitCode).toBe(3);
  });

  it('includes file path and reason in message', () => {
    const err = new ExtractionError('/doc.pdf', 'timeout');
    expect(err.message).toContain('/doc.pdf');
    expect(err.message).toContain('timeout');
  });

  it('exposes filePath property', () => {
    const err = new ExtractionError('/path/file.pdf', 'error');
    expect(err.filePath).toBe('/path/file.pdf');
  });

  it('is an instance of ChromactlError', () => {
    const err = new ExtractionError('f', 'm');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// DependencyError
// ---------------------------------------------------------------------------

describe('DependencyError', () => {
  it('has exit code 4', () => {
    const err = new DependencyError('pdftotext', 'apt install poppler-utils');
    expect(err.exitCode).toBe(4);
  });

  it('includes tool name in message', () => {
    const err = new DependencyError('pandoc', 'apt install pandoc');
    expect(err.message).toContain('pandoc');
  });

  it('exposes tool and installHint properties', () => {
    const err = new DependencyError('pdftotext', 'apt install poppler-utils');
    expect(err.tool).toBe('pdftotext');
    expect(err.installHint).toBe('apt install poppler-utils');
  });

  it('has hint with install instructions', () => {
    const err = new DependencyError('pdftotext', 'apt install poppler-utils');
    expect(err.hint).toContain('apt install poppler-utils');
  });

  it('is an instance of ChromactlError', () => {
    const err = new DependencyError('t', 'h');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// SchemaValidationError
// ---------------------------------------------------------------------------

describe('SchemaValidationError', () => {
  it('has exit code 5', () => {
    const err = new SchemaValidationError([
      { field: 'author', message: 'missing' },
    ]);
    expect(err.exitCode).toBe(5);
  });

  it('includes field details in message', () => {
    const err = new SchemaValidationError([
      { field: 'author', message: 'required field missing' },
      { field: 'year', message: 'type mismatch' },
    ]);
    expect(err.message).toContain('author');
    expect(err.message).toContain('year');
    expect(err.message).toContain('Schema validation failed');
  });

  it('exposes validationErrors array', () => {
    const errors = [{ field: 'x', message: 'y' }];
    const err = new SchemaValidationError(errors);
    expect(err.validationErrors).toEqual(errors);
  });

  it('is an instance of ChromactlError', () => {
    const err = new SchemaValidationError([]);
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// InvalidArgumentError
// ---------------------------------------------------------------------------

describe('InvalidArgumentError', () => {
  it('has exit code 6', () => {
    const err = new InvalidArgumentError('bad arg');
    expect(err.exitCode).toBe(6);
  });

  it('includes the message', () => {
    const err = new InvalidArgumentError('Invalid JSON input');
    expect(err.message).toBe('Invalid JSON input');
  });

  it('is an instance of ChromactlError', () => {
    const err = new InvalidArgumentError('test');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// CollectionNotFoundError
// ---------------------------------------------------------------------------

describe('CollectionNotFoundError', () => {
  it('has exit code 7', () => {
    const err = new CollectionNotFoundError('papers');
    expect(err.exitCode).toBe(7);
  });

  it('includes collection name in message', () => {
    const err = new CollectionNotFoundError('papers');
    expect(err.message).toContain('papers');
  });

  it('has hint about listing collections', () => {
    const err = new CollectionNotFoundError('papers');
    expect(err.hint).toContain('collection list');
  });

  it('is an instance of ChromactlError', () => {
    const err = new CollectionNotFoundError('x');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// SchemaNotFoundError
// ---------------------------------------------------------------------------

describe('SchemaNotFoundError', () => {
  it('has exit code 7', () => {
    const err = new SchemaNotFoundError('article');
    expect(err.exitCode).toBe(7);
  });

  it('includes schema name in message', () => {
    const err = new SchemaNotFoundError('article');
    expect(err.message).toContain('article');
  });

  it('has hint about listing schemas', () => {
    const err = new SchemaNotFoundError('article');
    expect(err.hint).toContain('schema list');
  });

  it('is an instance of ChromactlError', () => {
    const err = new SchemaNotFoundError('x');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// ChromaDBError
// ---------------------------------------------------------------------------

describe('ChromaDBError', () => {
  it('has exit code 6', () => {
    const err = new ChromaDBError('connection failed');
    expect(err.exitCode).toBe(6);
  });

  it('includes the message', () => {
    const err = new ChromaDBError('API timeout');
    expect(err.message).toBe('API timeout');
  });

  it('is an instance of ChromactlError', () => {
    const err = new ChromaDBError('test');
    expect(err).toBeInstanceOf(ChromactlError);
  });
});

// ---------------------------------------------------------------------------
// Cross-cutting: all error classes derive from ChromactlError
// ---------------------------------------------------------------------------

describe('inheritance chain', () => {
  it('all custom errors are instances of ChromactlError and Error', () => {
    const errors = [
      new ConfigNotFoundError(),
      new ServerError('s'),
      new ExtractionError('f', 'm'),
      new DependencyError('t', 'h'),
      new SchemaValidationError([]),
      new InvalidArgumentError('a'),
      new CollectionNotFoundError('c'),
      new SchemaNotFoundError('s'),
      new ChromaDBError('d'),
    ];

    for (const err of errors) {
      expect(err).toBeInstanceOf(ChromactlError);
      expect(err).toBeInstanceOf(Error);
    }
  });
});
