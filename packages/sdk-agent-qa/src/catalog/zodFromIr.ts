/**
 * Builds the Zod validator for an operation's input, and converts a validated
 * value into what the generated client expects.
 *
 * Two steps on purpose. The Zod schema contains only JSON-representable types —
 * a `Date` is an ISO-8601 string, an upload is `{ text, contentType }` — so the
 * same schema can be handed to a model as the tool's input schema without a
 * transform the JSON Schema conversion cannot express. {@link hydrate} then
 * turns those strings into the `Date` and `Blob` instances the generated
 * `ToJSON` functions call methods on.
 */
import { z } from 'zod';
import type { SchemaIR } from './types';

const isoDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'must be an ISO-8601 date or date-time' });

const blobShape = z.strictObject({
  text: z.string().describe('File content as text'),
  contentType: z.string().optional().describe('MIME type, e.g. text/csv'),
  filename: z.string().optional(),
});

export interface ZodFromIrOptions {
  /**
   * Longest field description kept, in characters. A tool definition is resent
   * on every model turn, so the schema handed to the model keeps a field's gist
   * and leaves the full text to sdk_describe. Unlimited by default.
   */
  maxDescription?: number;
}

/** The first sentence of a description, cut to `max` characters. */
export function clip(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const sentence = /^(.+?[.;])\s/.exec(text)?.[1] ?? text;
  return sentence.length <= max ? sentence : `${sentence.slice(0, Math.max(1, max - 1))}…`;
}

export function zodFromIr(ir: SchemaIR, options: ZodFromIrOptions = {}): z.ZodType {
  const max = options.maxDescription;
  const described = <T extends z.ZodType>(schema: T, description: string | undefined): T => {
    const text = description && max !== undefined ? clip(description, max) : description;
    return text ? (schema.describe(text) as T) : schema;
  };
  const child = (node: SchemaIR): z.ZodType => zodFromIr(node, options);
  switch (ir.kind) {
    case 'string':
      return described(z.string(), ir.description);
    case 'number':
      return described(z.number(), ir.description);
    case 'boolean':
      return described(z.boolean(), ir.description);
    case 'date':
      return described(isoDate, ir.description ? `${ir.description} (ISO-8601)` : 'ISO-8601 date or date-time');
    case 'enum':
      return described(z.enum(ir.values as [string, ...string[]]), ir.description);
    case 'array':
      return described(z.array(child(ir.items)), ir.description);
    case 'record':
      return described(z.record(z.string(), child(ir.values)), ir.description);
    case 'union':
      return described(z.union(ir.anyOf.map(child) as [z.ZodType, z.ZodType, ...z.ZodType[]]), ir.description);
    case 'nullable':
      return described(child(ir.inner).nullable(), ir.description);
    case 'blob':
      return described(blobShape, ir.description ?? 'File upload');
    case 'object': {
      const shape: Record<string, z.ZodType> = {};
      for (const [name, property] of Object.entries(ir.properties)) {
        const schema = child(property);
        shape[name] = ir.required.includes(name) ? schema : schema.optional();
      }
      // Strict: a misspelled field is reported back to the model instead of
      // being silently dropped by the generated ToJSON, which would send a
      // request the model did not mean and blame the backend for the result.
      return described(z.strictObject(shape), ir.description);
    }
    case 'any':
    default:
      return described(z.any(), ir.description);
  }
}

/** Converts a validated tool input into the argument the generated method takes. */
export function hydrate(ir: SchemaIR, value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  switch (ir.kind) {
    case 'date':
      return typeof value === 'string' ? new Date(value) : value;
    case 'blob': {
      if (typeof value === 'object' && typeof (value as { text?: unknown }).text === 'string') {
        const file = value as { text: string; contentType?: string };
        return new Blob([file.text], { type: file.contentType ?? 'application/octet-stream' });
      }
      return value;
    }
    case 'array':
      return Array.isArray(value) ? value.map((item) => hydrate(ir.items, item)) : value;
    case 'record':
      return typeof value === 'object'
        ? Object.fromEntries(Object.entries(value as object).map(([key, item]) => [key, hydrate(ir.values, item)]))
        : value;
    case 'nullable':
      return hydrate(ir.inner, value);
    case 'union': {
      // The first member whose validator accepts the value decides how it is hydrated.
      const member = ir.anyOf.find((candidate) => zodFromIr(candidate).safeParse(value).success);
      return member ? hydrate(member, value) : value;
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as object)) {
        const property = ir.properties[key];
        result[key] = property ? hydrate(property, item) : item;
      }
      return result;
    }
    default:
      return value;
  }
}

/** One line per problem, in the form a model can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(input)';
    return `${where}: ${issue.message}`;
  });
}
