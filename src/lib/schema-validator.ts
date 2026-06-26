import fs from 'node:fs';
import type {
  SchemaDefinition,
  FieldDefinition,
  ValidationResult,
  ValidationError,
} from '../types/index.js';
import { InvalidArgumentError } from './errors.js';

const VALID_FIELD_TYPES: ReadonlySet<string> = new Set([
  'string',
  'number',
  'boolean',
]);

/**
 * Validate a metadata object against a schema definition.
 * Checks:
 * - Required fields are present
 * - Field types match (string, number, boolean)
 * - Extra keys in metadata (not in schema) are allowed
 */
export function validateMetadata(
  metadata: Record<string, unknown>,
  schema: SchemaDefinition,
): ValidationResult {
  const errors: ValidationError[] = [];

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    const value = metadata[fieldName];

    // Check required fields are present
    if (fieldDef.required && (value === undefined || value === null)) {
      errors.push({
        field: fieldName,
        message: `Required field '${fieldName}' is missing`,
        expected: fieldDef.type,
      });
      continue;
    }

    // Check field type if the field is present
    if (value !== undefined && value !== null) {
      const actualType = typeof value;
      if (actualType !== fieldDef.type) {
        errors.push({
          field: fieldName,
          message: `Expected type '${fieldDef.type}', got '${actualType}'`,
          expected: fieldDef.type,
          actual: actualType,
        });
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Parse schema input from CLI options.
 * Accepts either an inline JSON string (--fields) or a file path (--from-file).
 * Throws InvalidArgumentError if JSON is malformed or neither option is provided.
 */
export function parseSchemaInput(options: {
  fields?: string;
  fromFile?: string;
}): SchemaDefinition {
  if (!options.fields && !options.fromFile) {
    throw new InvalidArgumentError(
      'No schema input provided.',
      'Use --fields \'<json>\' or --from-file <path> to specify the schema.',
    );
  }

  let raw: string;

  if (options.fromFile) {
    if (!fs.existsSync(options.fromFile)) {
      throw new InvalidArgumentError(
        `Schema file not found: ${options.fromFile}`,
      );
    }
    try {
      raw = fs.readFileSync(options.fromFile, 'utf-8');
    } catch {
      throw new InvalidArgumentError(
        `Failed to read schema file: ${options.fromFile}`,
      );
    }
  } else {
    raw = options.fields!;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message =
      err instanceof SyntaxError
        ? `Malformed JSON: ${err.message}`
        : 'Malformed JSON in schema input';
    throw new InvalidArgumentError(message);
  }

  // If the input is a flat object of field definitions (no wrapping "fields" key),
  // wrap it into a SchemaDefinition.
  const schema = normalizeSchemaInput(parsed);

  // Validate the schema definition is well-formed
  assertSchemaValid(schema);

  return schema;
}

/**
 * Normalize parsed JSON input into a SchemaDefinition.
 * Accepts either { fields: { ... } } or a flat { fieldName: { type, required }, ... }.
 */
function normalizeSchemaInput(parsed: unknown): SchemaDefinition {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InvalidArgumentError(
      'Schema input must be a JSON object.',
    );
  }

  const obj = parsed as Record<string, unknown>;

  // If it has a "fields" key that is an object, treat it as a full SchemaDefinition
  if (
    'fields' in obj &&
    typeof obj['fields'] === 'object' &&
    obj['fields'] !== null &&
    !Array.isArray(obj['fields'])
  ) {
    return obj as unknown as SchemaDefinition;
  }

  // Otherwise, treat the entire object as the fields map
  return { fields: obj as Record<string, FieldDefinition> };
}

/**
 * Validate that a schema definition is well-formed:
 * - At least one field defined
 * - All field types are "string", "number", or "boolean"
 * - All fields have a "required" property (boolean)
 * Throws InvalidArgumentError if invalid.
 */
export function assertSchemaValid(schema: SchemaDefinition): void {
  if (
    !schema.fields ||
    typeof schema.fields !== 'object' ||
    Array.isArray(schema.fields)
  ) {
    throw new InvalidArgumentError('Schema must have a "fields" object.');
  }

  const fieldNames = Object.keys(schema.fields);
  if (fieldNames.length === 0) {
    throw new InvalidArgumentError(
      'Schema must define at least one field.',
    );
  }

  for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
    if (typeof fieldDef !== 'object' || fieldDef === null || Array.isArray(fieldDef)) {
      throw new InvalidArgumentError(
        `Field '${fieldName}' must be an object with 'type' and 'required' properties.`,
      );
    }

    if (!('type' in fieldDef) || !VALID_FIELD_TYPES.has(fieldDef.type)) {
      throw new InvalidArgumentError(
        `Field '${fieldName}' has invalid type '${String((fieldDef as unknown as Record<string, unknown>).type ?? 'undefined')}'. Must be one of: string, number, boolean.`,
      );
    }

    if (!('required' in fieldDef) || typeof fieldDef.required !== 'boolean') {
      throw new InvalidArgumentError(
        `Field '${fieldName}' must have a boolean 'required' property.`,
      );
    }
  }
}
