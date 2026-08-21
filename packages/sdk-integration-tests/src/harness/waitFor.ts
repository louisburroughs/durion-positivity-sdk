export interface WaitForOptions {
  /** Overall deadline. Default comes from the caller (ItestConfig.waitTimeoutMs). */
  timeoutMs?: number;
  /** Pause between attempts. Default 500ms. */
  intervalMs?: number;
  /** What we are waiting for — appears in the timeout error. */
  description?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The suite's only sanctioned waiting mechanism (spec: waitFor-not-sleep).
 *
 * Polls `fn` until it returns a truthy value, awaiting each call before
 * scheduling the next — attempts never overlap. A predicate that throws is
 * treated as "not yet": the error is remembered and polling continues. After
 * the deadline, rejects with the last predicate error when there was one
 * (the real reason things never became ready), otherwise with a timeout
 * error naming `description`.
 */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  options: WaitForOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 30000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;

  // Always make at least one attempt, even when timeoutMs is tiny.
  for (;;) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    if (Date.now() + intervalMs > deadline) {
      break;
    }
    await sleep(intervalMs);
  }

  if (lastError !== undefined) {
    throw lastError;
  }
  const what = options.description ? ` waiting for ${options.description}` : '';
  throw new Error(`waitFor timed out after ${timeoutMs}ms${what}`);
}
