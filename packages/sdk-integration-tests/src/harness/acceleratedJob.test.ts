import { Mutex } from './mutex';

describe('Mutex', () => {
  it('serializes callers in the order they arrived', async () => {
    const mutex = new Mutex();
    const order: string[] = [];

    const task = (name: string, delayMs: number) =>
      mutex.runExclusive(async () => {
        order.push(`${name}-start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        order.push(`${name}-end`);
      });

    await Promise.all([task('a', 30), task('b', 5), task('c', 1)]);

    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end', 'c-start', 'c-end']);
  });

  it('never lets two callers overlap', async () => {
    const mutex = new Mutex();
    let inFlight = 0;
    let maxInFlight = 0;

    await Promise.all(
      Array.from({ length: 8 }, () =>
        mutex.runExclusive(async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
        }),
      ),
    );

    expect(maxInFlight).toBe(1);
  });

  it('releases the lock when a caller throws, so one failure does not wedge the run', async () => {
    const mutex = new Mutex();

    await expect(
      mutex.runExclusive(async () => {
        throw new Error('startTimer refused');
      }),
    ).rejects.toThrow('startTimer refused');

    await expect(mutex.runExclusive(async () => 'still works')).resolves.toBe('still works');
  });

  it('returns each caller its own value', async () => {
    const mutex = new Mutex();
    const values = await Promise.all([1, 2, 3].map((n) => mutex.runExclusive(async () => n * 10)));
    expect(values).toEqual([10, 20, 30]);
  });
});
