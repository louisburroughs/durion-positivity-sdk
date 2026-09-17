/**
 * A promise-ordered mutual exclusion, for the few backend APIs that are scoped
 * to the calling *user* rather than to the record being worked.
 *
 * The workexec timer API is the case that forces this: `stopTimers()` stops the
 * timers the caller tracks or started, with no workorder argument. In role mode
 * every parallel job acts as the same technician login, so one job's stop would
 * end another job's running timer and both would record the wrong labor. The
 * non-accelerated suite avoids this by running with `maxWorkers: 1`; a run that
 * works several bays at once has to hold a lock across start → stop instead.
 */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  /** Runs `fn` once every earlier caller has finished. FIFO by construction. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Each caller waits on the previous tail and becomes the new tail, so the
    // queue is ordered and a rejection in one caller cannot skip the next.
    const previous = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}
