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
