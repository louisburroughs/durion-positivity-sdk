/**
 * The tool catalog's vocabulary.
 *
 * An {@link Operation} is one public method of one generated API class — the
 * unit the harness exposes to a model as a tool and the unit coverage is
 * counted in. Its input is described by a {@link SchemaIR}: a small,
 * JSON-serializable tree read straight off the generated TypeScript, from which
 * the Zod validator is built (see zodFromIr.ts).
 */

export type SchemaIR =
  | { kind: 'string'; description?: string }
  | { kind: 'number'; description?: string }
  | { kind: 'boolean'; description?: string }
  /** A `Date` in the generated model. Crosses the tool boundary as an ISO-8601 string. */
  | { kind: 'date'; description?: string }
  | { kind: 'enum'; values: string[]; description?: string }
  | { kind: 'array'; items: SchemaIR; description?: string }
  | { kind: 'record'; values: SchemaIR; description?: string }
  | { kind: 'object'; properties: Record<string, SchemaIR>; required: string[]; description?: string }
  | { kind: 'union'; anyOf: SchemaIR[]; description?: string }
  | { kind: 'nullable'; inner: SchemaIR; description?: string }
  /** A `Blob` upload. Crosses the tool boundary as `{ text, contentType?, filename? }`. */
  | { kind: 'blob'; description?: string }
  /** Anything the reader could not, or chose not to, resolve (untyped objects, cut-off recursion). */
  | { kind: 'any'; description?: string };

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

/**
 * How much damage a call can do to a shared tenant.
 *
 * - `read`: a GET/HEAD. Always allowed.
 * - `write`: creates or changes tenant data the way an ordinary user does.
 * - `destructive`: deletes, purges, disables accounts, or acts outside the
 *   tenant (signups, tenant lifecycle, bulk ingest). Refused unless a scenario
 *   pins the operation and the run allows destructive calls.
 */
export type Risk = 'read' | 'write' | 'destructive';

export interface Operation {
  /** `<package>.<ApiClass>.<method>`, e.g. `order.RegisterSessionsApi.openRegisterSession`. */
  id: string;
  /** Package directory name without the `sdk-` prefix, e.g. `order`. */
  pkg: string;
  /** Generated API class name, e.g. `RegisterSessionsApi`. */
  api: string;
  /** Method name on that class. */
  method: string;
  http: HttpMethod;
  /** Path template as generated, e.g. `/v1/orders/register-sessions/{sessionId}`. */
  path: string;
  summary: string;
  /** The backend's own tool-oriented description of the operation. */
  description: string;
  risk: Risk;
  /** Input the method takes. Always an object IR; empty when the method takes nothing. */
  input: Extract<SchemaIR, { kind: 'object' }>;
  /** True when the method declares an `idempotencyKey` request parameter. */
  takesIdempotencyKey: boolean;
}

export interface Catalog {
  operations: Operation[];
  byId: Map<string, Operation>;
  /** Packages that were scanned, including ones with no operations. */
  packages: string[];
}
