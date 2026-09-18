import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { hostname } from 'os';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcceleratedLock, type LockHolder } from './acceleratedLock';

const identity = { runId: 'accel-1', realStart: new Date('2026-09-17T12:00:00.000Z') };
const freshPath = (): string => join(mkdtempSync(join(tmpdir(), 'accel-lock-')), 'run.lock');

const holderFile = (path: string, overrides: Partial<LockHolder> = {}): void => {
  const holder: LockHolder = {
    runId: 'accel-other',
    pid: process.pid,
    host: hostname(),
    user: 'someone',
    realStart: '2026-09-17T12:00:00.000Z',
    acquiredAt: new Date().toISOString(),
    ...overrides,
  };
  writeFileSync(path, JSON.stringify(holder), 'utf8');
};

describe('AcceleratedLock', () => {
  it('takes a free lock and records who holds it', () => {
    const path = freshPath();
    const lock = new AcceleratedLock(path, identity);

    lock.acquire();

    const holder = lock.readHolder();
    expect(holder).toMatchObject({ runId: 'accel-1', pid: process.pid, realStart: identity.realStart.toISOString() });
    lock.release();
  });

  it('releases the lock, so the next run can take it', () => {
    const path = freshPath();
    const first = new AcceleratedLock(path, identity);
    first.acquire();
    first.release();

    expect(existsSync(path)).toBe(false);
    expect(() => new AcceleratedLock(path, { ...identity, runId: 'accel-2' }).acquire()).not.toThrow();
  });

  it('refuses when a live run holds it, and names the holder', () => {
    const path = freshPath();
    // A live pid on this host: this process's own.
    holderFile(path, { runId: 'accel-live', user: 'someone-else' });

    expect(() => new AcceleratedLock(path, identity).acquire()).toThrow(
      /another accelerated run holds .*accel-live.*someone-else.*Only one accelerated run/s,
    );
  });

  it('takes over a lock whose process is gone, rather than needing a hand edit', () => {
    const path = freshPath();
    // A pid that cannot be running: process 2^22 is above the default pid_max.
    holderFile(path, { runId: 'accel-dead', pid: 4_194_303 });

    const lock = new AcceleratedLock(path, identity);
    expect(() => lock.acquire()).not.toThrow();
    expect(lock.readHolder()?.runId).toBe('accel-1');
    lock.release();
  });

  it('never takes over a lock from another host, where a pid means nothing', () => {
    const path = freshPath();
    holderFile(path, { runId: 'accel-elsewhere', host: 'some-other-box', pid: 4_194_303 });

    expect(() => new AcceleratedLock(path, identity).acquire()).toThrow(/accel-elsewhere/);
  });

  it('takes over an unreadable lock file', () => {
    const path = freshPath();
    writeFileSync(path, 'not json at all', 'utf8');

    const lock = new AcceleratedLock(path, identity);
    expect(() => lock.acquire()).not.toThrow();
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe('accel-1');
    lock.release();
  });

  it('refuses when it loses the race to take over a stale lock', () => {
    // The takeover must be create-or-fail, not an unconditional overwrite: two
    // processes that both read the same dead holder would otherwise both believe
    // they hold the lock, which is the one guarantee this file provides. Simulated
    // by having the "other" process win between the read and the create.
    const path = freshPath();
    holderFile(path, { runId: 'accel-dead', pid: 4_194_303 });

    const lock = new AcceleratedLock(path, identity);
    const readHolder = lock.readHolder.bind(lock);
    const deadHolder = readHolder();
    // The winner lands after this run has read the dead holder and before it can
    // replace the file — the window the compare-before-unlink exists to catch.
    jest.spyOn(lock, 'readHolder').mockImplementation(() => {
      const current = readHolder();
      if (current?.runId === 'accel-dead') {
        holderFile(path, { runId: 'accel-winner', pid: process.pid, user: 'someone-else' });
        return deadHolder;
      }
      return current;
    });

    // Refused, naming the winner — the compare-before-unlink noticed the file had
    // changed, went round again, and found a live holder. Which of the two refusal
    // messages it is does not matter; not sharing the lock does.
    expect(() => lock.acquire()).toThrow(/accel-winner/);
    expect(() => lock.acquire()).toThrow(/Only one accelerated run may write/);
    // And the winner's lock is intact: an unconditional unlink here is what used to
    // delete it.
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe('accel-winner');
  });

  it('puts a stale lock back when the replacement cannot be written', () => {
    // The unlink must be undoable. Without the restore, a replacement that fails for
    // any reason other than EEXIST — a read-only mount, no space — propagated with the
    // lock file *gone*, and the next run found nothing and acquired freely: mutual
    // exclusion silently off, which is worse than failing to take the lock.
    const path = freshPath();
    holderFile(path, { runId: 'accel-dead', pid: 4_194_303 });
    const before = readFileSync(path, 'utf8');

    const lock = new AcceleratedLock(path, identity);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const writeLock = (lock as any).writeLock.bind(lock) as (body: string, flag: string) => void;
    let failedOnce = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(lock as any, 'writeLock').mockImplementation(((body: string, flag: string) => {
      if (!failedOnce && body.includes('accel-1')) {
        failedOnce = true;
        const failure = new Error('EROFS: read-only file system') as Error & { code?: string };
        failure.code = 'EROFS';
        throw failure;
      }
      writeLock(body, flag);
    }) as never);

    expect(() => lock.acquire()).toThrow(/EROFS/);
    // The stale lock is back, byte for byte: the next run sees a lock and decides about
    // it, rather than finding nothing.
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('is safe to release twice, and to release one never acquired', () => {
    const path = freshPath();
    const lock = new AcceleratedLock(path, identity);

    expect(() => lock.release()).not.toThrow();
    lock.acquire();
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it('does not delete a lock another run has taken over', () => {
    const path = freshPath();
    const lock = new AcceleratedLock(path, identity);
    lock.acquire();

    // Someone else decided ours was stale and took it.
    holderFile(path, { runId: 'accel-successor', pid: process.pid + 1 });
    lock.release();

    expect(existsSync(path)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe('accel-successor');
  });

  it('creates the lock directory when it does not exist yet', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'accel-lock-')), 'nested', 'deeper', 'run.lock');
    const lock = new AcceleratedLock(path, identity);

    lock.acquire();

    expect(existsSync(path)).toBe(true);
    lock.release();
  });
});
