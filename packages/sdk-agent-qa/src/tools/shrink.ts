/**
 * Cuts a response body down to what a model needs to see.
 *
 * A list endpoint can return hundreds of rows; fed back verbatim, three such
 * calls fill a small model's context and the scenario dies of truncation
 * rather than of anything the backend did. Arrays are cut to their first few
 * items (with the real length stated), long strings are clipped, and if the
 * result is still over budget the limits are tightened until it fits. The
 * output stays valid JSON at every step, so the model never parses a torn
 * document.
 */
type Json = unknown;

function prune(value: Json, maxItems: number, maxString: number, depth: number): Json {
  if (value instanceof Date) {
    // A generated model turns a missing or malformed date into an Invalid Date, and
    // toISOString throws on one. The call has already been made by now; losing its
    // result to a formatting error would hide the response from the model.
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, maxString)}…(+${value.length - maxString} chars)` : value;
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  if (depth <= 0) {
    return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  }
  if (value instanceof Set) {
    return prune([...value], maxItems, maxString, depth);
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, maxItems).map((item) => prune(item, maxItems, maxString, depth - 1));
    return value.length > maxItems ? [...head, `…(+${value.length - maxItems} more items, ${value.length} total)`] : head;
  }
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) {
      result[key] = prune(item, maxItems, maxString, depth - 1);
    }
  }
  return result;
}

export function shrink(value: Json, budget: number): Json {
  if (value === undefined) {
    return undefined;
  }
  const attempts: Array<[items: number, chars: number, depth: number]> = [
    [10, 600, 8],
    [5, 300, 6],
    [3, 160, 5],
    [2, 80, 4],
    [1, 40, 3],
  ];
  let last: Json;
  for (const [items, chars, depth] of attempts) {
    last = prune(value, items, chars, depth);
    if (JSON.stringify(last).length <= budget) {
      return last;
    }
  }
  return { truncated: true, preview: JSON.stringify(last).slice(0, Math.max(0, budget - 40)) };
}

/**
 * Fields an older result keeps: what a later call needs to refer back to it
 * (ids, numbers, codes, page tokens) or to tell what it was (status, name).
 */
const IDENTITY_KEY = /(^id$|Ids?$|^status$|Status$|State$|Number$|^sku$|^code$|Code$|^name$|Name$|Token$|^outcome$|^message$)/;
/** Ids no later call takes: the request's own trace id. */
const NOT_IDENTITY = /^correlationId$/;

const isScalar = (value: Json): boolean => value instanceof Date || typeof value !== 'object' || value === null;

/** The identity fields of a value, at any depth; scalars are kept only under an identity key. */
function skeleton(value: Json, depth: number, identity: boolean): Json {
  if (isScalar(value)) {
    return identity ? value : undefined;
  }
  if (depth <= 0) {
    return undefined;
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => skeleton(item, depth - 1, identity)).filter((item) => item !== undefined);
    return items.length > 0 ? items : undefined;
  }
  const result: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value as Record<string, Json>)) {
    const kept = NOT_IDENTITY.test(key) ? undefined : skeleton(item, depth - 1, IDENTITY_KEY.test(key));
    if (kept !== undefined) {
      result[key] = kept;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * An older tool result as the conversation keeps it: its identity fields only,
 * then cut to the budget. Shrinking the whole result instead dropped the rows a
 * later step needed (a workorder's service-line ids went two turns after they
 * were read, and the agent spent the rest of its budget searching for a way to
 * list them again).
 */
export function compactResult(value: Json, budget: number): Json {
  if (value === undefined) {
    return undefined;
  }
  return shrink(skeleton(value, 10, false) ?? shrink(value, budget), budget);
}
