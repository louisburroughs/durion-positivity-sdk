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
    const response = (error as { response: { status?: unknown; text?: unknown; headers?: Headers } }).response;
    const status = typeof response.status === 'number' ? response.status : '?';

    // The correlation id is the only handle on a failure whose body is empty -
    // which is exactly the shape an unhandled exception takes here
    // (durion-positivity-backend#1471). Without it such a failure cannot be
    // traced to a log line at all.
    const correlationId =
      response.headers && typeof response.headers.get === 'function'
        ? (response.headers.get('x-correlation-id') ?? response.headers.get('X-Correlation-Id'))
        : undefined;
    const trace = correlationId ? ` [correlationId=${correlationId}]` : '';

    if (typeof response.text === 'function') {
      try {
        const body = await (response.text as () => Promise<string>)();
        return `HTTP ${status}${trace}: ${body || '(empty body)'}`;
      } catch {
        return `HTTP ${status}${trace}: (could not read body)`;
      }
    }
    return `HTTP ${status}${trace}`;
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

/**
 * Awaits a call that may be racing a cross-service replica.
 *
 * Several services validate references against replicas fed by Kafka rather
 * than against the owning service, so a fixture created moments earlier is not
 * yet visible: pos-shop-manager answers CUSTOMER_NOT_FOUND for a party the CRM
 * has already returned, pos-inventory answers INVALID_PO_REFERENCE for a
 * purchase order pos-order has already approved. Retries only while the error
 * body carries one of `markers`; anything else is raised at once.
 */
export async function retryWhileReplicating<T>(
  attempt: () => Promise<T>,
  options: { markers: string[]; description: string; timeoutMs?: number; pollMs?: number },
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  for (;;) {
    try {
      return await attempt();
    } catch (error) {
      const detail = await formatError(error);
      if (!options.markers.some((marker) => detail.includes(marker))) {
        // Rethrow the original, not a wrapper. A wrapper is a plain Error with
        // no `response`, so every status-aware helper downstream - isHttpStatus,
        // expectHttpError - goes blind: a role-mode negative that correctly got
        // its 403 fails with "Expected HTTP 401/403 but got: ... HTTP 403",
        // reading the status out of a string it can no longer inspect. The
        // description is preserved as the cause's context instead.
        if (error instanceof Error) {
          error.message = `${options.description} failed: ${detail}`;
          throw error;
        }
        throw new Error(`${options.description} failed: ${detail}`);
      }
      lastError = new Error(`${options.description} never became consistent: ${detail}`);
      if (Date.now() + pollMs >= deadline) {
        throw lastError;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

/**
 * Awaits a call and, on failure, reports the status and body instead of the
 * generated client's context-free "Response returned an error code".
 */
export async function call<T>(description: string, attempt: () => Promise<T>): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    throw new Error(`${description} failed: ${await formatError(error)}`);
  }
}
