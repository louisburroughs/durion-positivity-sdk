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
    return value.toISOString();
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
