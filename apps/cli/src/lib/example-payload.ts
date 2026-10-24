/**
 * Sample payloads for inbound webhook schemas, matching the language the API
 * validates: fields live in `steps[].fields` (or a legacy flat `fields`) and
 * enum options are `{ value, label }` — the payload must carry the `value`.
 */

interface FieldLike {
  name?: string;
  key?: string;
  type?: string;
  required?: boolean;
  options?: unknown;
}

interface StepLike {
  fields?: FieldLike[];
}

function schemaFields(schema: Record<string, unknown>): FieldLike[] {
  const fields: FieldLike[] = [];
  const steps = Array.isArray(schema['steps']) ? (schema['steps'] as StepLike[]) : [];
  for (const step of steps) {
    if (Array.isArray(step.fields)) fields.push(...step.fields);
  }
  // Legacy flat schemas keep top-level fields.
  if (fields.length === 0 && Array.isArray(schema['fields'])) {
    fields.push(...(schema['fields'] as FieldLike[]));
  }
  return fields;
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return ['option_a'];
  const values: string[] = [];
  for (const option of options) {
    if (typeof option === 'string') values.push(option);
    else if (option && typeof option === 'object' && 'value' in option) {
      const value = (option as { value?: unknown }).value;
      if (typeof value === 'string') values.push(value);
    }
  }
  return values.length > 0 ? values : ['option_a'];
}

/** Builds a payload the webhook's schema will accept, field by field. */
export function buildExamplePayload(schema: Record<string, unknown>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const field of schemaFields(schema)) {
    const key = String(field.name ?? field.key ?? '');
    if (!key) continue;

    switch (field.type) {
      case 'number':
        payload[key] = 42;
        break;
      case 'boolean':
        payload[key] = true;
        break;
      case 'email':
        payload[key] = 'user@example.com';
        break;
      case 'url':
        payload[key] = 'https://microclub.info';
        break;
      case 'phone':
        payload[key] = '+213555123456';
        break;
      case 'date':
        payload[key] = '2026-10-23';
        break;
      case 'datetime':
        payload[key] = '2026-10-23T12:00:00Z';
        break;
      case 'enum':
        payload[key] = optionValues(field.options)[0]!;
        break;
      case 'multi_enum': {
        const values = optionValues(field.options);
        payload[key] = values.slice(0, 1);
        break;
      }
      default:
        payload[key] = 'Sample text';
    }
  }

  return payload;
}

/**
 * Pre-flight payload check against the schema's must-haves: required fields
 * present, enum/multi_enum values among the declared options. The server's
 * validator stays authoritative; this gives immediate, local feedback for the
 * common rejections before anything is signed or sent.
 */
export function validatePayloadAgainstSchema(
  payload: unknown,
  schema: Record<string, unknown>,
): string[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return ['payload must be a JSON object'];
  }
  const data = payload as Record<string, unknown>;
  const problems: string[] = [];

  for (const field of schemaFields(schema)) {
    const key = String(field.name ?? field.key ?? '');
    if (!key) continue;
    const value = data[key];
    const missing = value === undefined || value === null || value === '';

    if (field.required && missing) {
      problems.push(`"${key}" is required`);
      continue;
    }
    if (missing) continue;

    if (field.type === 'enum') {
      const allowed = optionValues(field.options);
      if (typeof value !== 'string' || !allowed.includes(value)) {
        problems.push(`"${key}" must be one of: ${allowed.join(', ')}`);
      }
    } else if (field.type === 'multi_enum') {
      const allowed = optionValues(field.options);
      if (
        !Array.isArray(value) ||
        value.some((item) => typeof item !== 'string' || !allowed.includes(item))
      ) {
        problems.push(`"${key}" must only contain: ${allowed.join(', ')}`);
      }
    } else if (field.type === 'number') {
      if (typeof value !== 'number') problems.push(`"${key}" must be a number`);
    } else if (field.type === 'boolean') {
      if (typeof value !== 'boolean') problems.push(`"${key}" must be a boolean`);
    }
  }

  return problems;
}
