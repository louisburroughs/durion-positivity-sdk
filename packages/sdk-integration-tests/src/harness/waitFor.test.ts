import { waitFor } from './waitFor';

describe('waitFor', () => {
  it('resolves with the first truthy predicate result', async () => {
    let calls = 0;
    const result = await waitFor(
      async () => {
        calls += 1;
        return calls >= 3 ? 'ready' : undefined;
      },
      { timeoutMs: 2000, intervalMs: 10 },
    );

    expect(result).toBe('ready');
    expect(calls).toBe(3);
  });

  it('polls at roughly the configured interval', async () => {
    const timestamps: number[] = [];
    await waitFor(
      async () => {
        timestamps.push(Date.now());
        return timestamps.length >= 3 ? true : undefined;
      },
      { timeoutMs: 2000, intervalMs: 50 },
    );

    const gap = timestamps[2] - timestamps[0];
    expect(gap).toBeGreaterThanOrEqual(80);
  });

  it('rejects with the last predicate error after the deadline, not a generic timeout', async () => {
    await expect(
      waitFor(
        async () => {
          throw new Error('backend said 503');
        },
        { timeoutMs: 60, intervalMs: 10 },
      ),
    ).rejects.toThrow('backend said 503');
  });

  it('rejects with a descriptive timeout when the predicate never errs and never succeeds', async () => {
    await expect(
      waitFor(async () => undefined, {
        timeoutMs: 60,
        intervalMs: 10,
        description: 'pick tasks to appear',
      }),
    ).rejects.toThrow(/pick tasks to appear/);
  });

  it('never overlaps in-flight predicate calls', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let calls = 0;

    await waitFor(
      async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        calls += 1;
        return calls >= 3 ? true : undefined;
      },
      // interval shorter than the predicate's own latency: a naive
      // setInterval implementation would stack calls here
      { timeoutMs: 2000, intervalMs: 5 },
    );

    expect(maxInFlight).toBe(1);
  });

  it('makes at least one attempt even with a tiny timeout', async () => {
    let calls = 0;
    const result = await waitFor(
      async () => {
        calls += 1;
        return 'first-try';
      },
      { timeoutMs: 1, intervalMs: 1000 },
    );
    expect(result).toBe('first-try');
    expect(calls).toBe(1);
  });
});
