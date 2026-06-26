import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  validateMetadata,
  parseSchemaInput,
  assertSchemaValid,
} from '../../src/lib/schema-validator.js';
import type { SchemaDefinition } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// validateMetadata
// ---------------------------------------------------------------------------

describe('validateMetadata', () => {
  const schema: SchemaDefinition = {
    fields: {
      author: { type: 'string', required: true },
      year: { type: 'number', required: false },
      published: { type: 'boolean', required: false },
    },
  };

  it('fails when required fields are missing', () => {
    const result = validateMetadata({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('author');
    expect(result.errors[0].message).toContain('missing');
  });

  it('fails when required field is null', () => {
    const result = validateMetadata({ author: null }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('author');
  });

  it('allows extra fields not defined in the schema', () => {
    const result = validateMetadata(
      { author: 'Smith', extra_field: 'hello', another: 42 },
      schema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects type mismatch (string expected, number given)', () => {
    const result = validateMetadata({ author: 123 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('author');
    expect(result.errors[0].expected).toBe('string');
    expect(result.errors[0].actual).toBe('number');
  });

  it('detects type mismatch (number expected, string given)', () => {
    const result = validateMetadata({ author: 'Smith', year: '2024' }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('year');
    expect(result.errors[0].expected).toBe('number');
    expect(result.errors[0].actual).toBe('string');
  });

  it('detects type mismatch (boolean expected, string given)', () => {
    const result = validateMetadata(
      { author: 'Smith', published: 'yes' },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].field).toBe('published');
  });

  it('passes when all valid types are provided', () => {
    const result = validateMetadata(
      { author: 'Smith', year: 2024, published: true },
      schema,
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('passes when optional fields are omitted', () => {
    const result = validateMetadata({ author: 'Smith' }, schema);
    expect(result.valid).toBe(true);
  });

  it('passes with empty metadata against empty-fields schema', () => {
    const emptySchema: SchemaDefinition = { fields: {} };
    const result = validateMetadata({}, emptySchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('reports multiple errors at once', () => {
    const strictSchema: SchemaDefinition = {
      fields: {
        name: { type: 'string', required: true },
        age: { type: 'number', required: true },
      },
    };
    const result = validateMetadata({}, strictSchema);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// parseSchemaInput
// ---------------------------------------------------------------------------

describe('parseSchemaInput', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses inline JSON fields', () => {
    const fieldsJson = JSON.stringify({
      author: { type: 'string', required: true },
      year: { type: 'number', required: false },
    });

    const schema = parseSchemaInput({ fields: fieldsJson });
    expect(schema.fields).toBeDefined();
    expect(schema.fields['author'].type).toBe('string');
    expect(schema.fields['author'].required).toBe(true);
    expect(schema.fields['year'].type).toBe('number');
  });

  it('parses schema from file', () => {
    const schemaObj = {
      author: { type: 'string', required: true },
    };
    const filePath = path.join(tmpDir, 'schema.json');
    fs.writeFileSync(filePath, JSON.stringify(schemaObj), 'utf-8');

    const schema = parseSchemaInput({ fromFile: filePath });
    expect(schema.fields['author'].type).toBe('string');
  });

  it('parses schema from file with wrapping "fields" key', () => {
    const schemaObj = {
      fields: {
        title: { type: 'string', required: true },
      },
    };
    const filePath = path.join(tmpDir, 'schema2.json');
    fs.writeFileSync(filePath, JSON.stringify(schemaObj), 'utf-8');

    const schema = parseSchemaInput({ fromFile: filePath });
    expect(schema.fields['title'].type).toBe('string');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseSchemaInput({ fields: '{not valid json}' })).toThrow(
      'Malformed JSON',
    );
  });

  it('throws when neither fields nor fromFile is provided', () => {
    expect(() => parseSchemaInput({})).toThrow('No schema input provided');
  });

  it('throws when fromFile points to non-existent file', () => {
    expect(() =>
      parseSchemaInput({ fromFile: '/tmp/nonexistent-schema-xyz.json' }),
    ).toThrow('Schema file not found');
  });
});

// ---------------------------------------------------------------------------
// assertSchemaValid
// ---------------------------------------------------------------------------

describe('assertSchemaValid', () => {
  it('accepts a well-formed schema', () => {
    const schema: SchemaDefinition = {
      fields: {
        name: { type: 'string', required: true },
        count: { type: 'number', required: false },
        active: { type: 'boolean', required: true },
      },
    };
    expect(() => assertSchemaValid(schema)).not.toThrow();
  });

  it('throws on empty fields object', () => {
    const schema: SchemaDefinition = { fields: {} };
    expect(() => assertSchemaValid(schema)).toThrow(
      'Schema must define at least one field',
    );
  });

  it('throws when a field has an invalid type', () => {
    const schema = {
      fields: {
        name: { type: 'integer', required: true },
      },
    } as unknown as SchemaDefinition;

    expect(() => assertSchemaValid(schema)).toThrow('invalid type');
  });

  it('throws when a field is missing the "required" property', () => {
    const schema = {
      fields: {
        name: { type: 'string' },
      },
    } as unknown as SchemaDefinition;

    expect(() => assertSchemaValid(schema)).toThrow(
      "must have a boolean 'required' property",
    );
  });

  it('throws when a field definition is not an object', () => {
    const schema = {
      fields: {
        name: 'string',
      },
    } as unknown as SchemaDefinition;

    expect(() => assertSchemaValid(schema)).toThrow(
      "must be an object with 'type' and 'required' properties",
    );
  });

  it('throws when fields is null', () => {
    const schema = { fields: null } as unknown as SchemaDefinition;
    expect(() => assertSchemaValid(schema)).toThrow(
      'Schema must have a "fields" object',
    );
  });

  it('throws when fields is an array', () => {
    const schema = { fields: [] } as unknown as SchemaDefinition;
    expect(() => assertSchemaValid(schema)).toThrow(
      'Schema must have a "fields" object',
    );
  });
});
