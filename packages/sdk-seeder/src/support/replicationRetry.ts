/**
 * Retries a call while a cross-service replica catches up.
 *
 * Services in this platform validate references against replicas fed by Kafka,
 * not against the owning service. A bootstrap that creates a record and
 * immediately references it therefore races a propagation it cannot observe:
 * pos-people creates an employee whose Person lands in
 * ext_people_contact_person a beat later, pos-order creates a purchase order
 * that reaches pos-inventory's ext_purchase_order on the next outbox poll.
 * Both fail with a specific, recognisable error until the replica arrives.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 500;

/**
 * True when the error carries a response with this status whose body mentions
 * this marker. Reads through a clone and tolerates any shape, so a non-JSON
 * error page cannot break the retry decision.
 */
export async function isResponseErrorMatching(
  error: unknown,
  status: number,
  bodyIncludes: string,
): Promise<boolean> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (!response || response.status !== status) {
    return false;
  }
  try {
    return (await response.clone().text()).includes(bodyIncludes);
  } catch {
    return false;
  }
}

export interface ReplicationRetryOptions<T> {
  /** Runs one attempt. The init carries an abort signal bounded by the deadline. */
  attempt: (initOverrides: RequestInit) => Promise<T>;
  /** True only for the failure that means "the replica has not arrived yet". */
  isReplicationLag: (error: unknown) => Promise<boolean>;
  /** Names the thing being waited on, e.g. `person 01a0...`. Used in the logs. */
  subject: string;
  /** What the caller does once the wait ends, e.g. `assignment created`. */
  outcome: string;
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Retries while `isReplicationLag` holds, up to a deadline.
 *
 * Any other failure is rethrown immediately rather than hidden behind the
 * timeout. Each attempt carries `AbortSignal.timeout(remaining)`: fetch applies
 * no request timeout of its own, so without one a stalled connection would park
 * inside the attempt and the deadline check would never run. The signal covers
 * reading the error body too, since that read is what decides whether to retry.
 * On expiry the last replication error is rethrown, so the caller sees the
 * propagation failure rather than a bare abort.
 */
export async function retryWhileReplicating<T>(options: ReplicationRetryOptions<T>): Promise<T> {
  const { attempt, isReplicationLag, subject, outcome } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;

  const deadline = Date.now() + timeoutMs;
  let waited = false;
  let lastError: unknown;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw lastError ?? new Error(`Timed out waiting for ${subject} to replicate`);
    }

    try {
      const result = await attempt({ signal: AbortSignal.timeout(remaining) });
      if (waited) {
        console.log(`[Bootstrap] ${subject} replicated; ${outcome}.`);
      }
      return result;
    } catch (error) {
      if (!(await isReplicationLag(error))) {
        throw error;
      }
      lastError = error;
      if (!waited) {
        console.log(`[Bootstrap] Waiting for ${subject} to replicate...`);
        waited = true;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}
