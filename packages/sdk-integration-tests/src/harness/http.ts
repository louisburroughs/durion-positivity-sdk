/**
 * HTTP error helpers, lifted from the seeder's CustomerEventSimulator so the
 * suites report backend failures the same proven way.
 */

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
};

export const isHttpStatus = (error: unknown, status: number): boolean => {
  const rec = asRecord(error);
  if (!rec) return false;
  const response = asRecord(rec['response']);
  if (!response) return false;
  return response['status'] === status;
};

export const httpStatusOf = (error: unknown): number | undefined => {
  const rec = asRecord(error);
  if (!rec) return undefined;
  const response = asRecord(rec['response']);
  if (!response) return undefined;
  const status = response['status'];
  return typeof status === 'number' ? status : undefined;
};

export const formatError = async (error: unknown): Promise<string> => {
  if (
    error !== null &&
    typeof error === 'object' &&
    'response' in error &&
    (error as { response: unknown }).response !== null &&
    typeof (error as { response: unknown }).response === 'object'
  ) {
    const response = (error as { response: { status?: unknown; text?: unknown } }).response;
    const status = typeof response.status === 'number' ? response.status : '?';
    if (typeof response.text === 'function') {
      try {
        const body = await (response.text as () => Promise<string>)();
        return `HTTP ${status}: ${body}`;
      } catch {
        return `HTTP ${status}: (could not read body)`;
      }
    }
    return `HTTP ${status}`;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * Negative-path assertion helper: awaits `promise`, fails when it resolves,
 * and when it rejects requires the HTTP status to be one of `statuses`.
 * Returns the observed status so tests can record what the backend actually
 * uses (the spec asks for the actual code, not an assumption).
 */
export async function expectHttpError(promise: Promise<unknown>, ...statuses: number[]): Promise<number> {
  let resolved: unknown;
  let errored = false;
  let caught: unknown;
  try {
    resolved = await promise;
  } catch (error) {
    errored = true;
    caught = error;
  }

  if (!errored) {
    throw new Error(
      `Expected the call to be rejected with HTTP ${statuses.join('/')} but it succeeded` +
        (resolved === undefined ? '' : ` with ${JSON.stringify(resolved).slice(0, 200)}`),
    );
  }

  const status = httpStatusOf(caught);
  if (status === undefined || !statuses.includes(status)) {
    const detail = await formatError(caught);
    throw new Error(`Expected HTTP ${statuses.join('/')} but got: ${detail}`);
  }
  return status;
}
