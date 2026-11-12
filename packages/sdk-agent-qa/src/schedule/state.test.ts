import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RunLock, RunState } from './state';

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'agent-qa-state-'));
const RUN = { date: '2026-03-10', week: '2026-W11', month: '2026-03', at: '2026-03-10T13:00:00Z', verdict: 'passed' };

describe('RunState', () => {
  it('persists runs, and sees what another process wrote', () => {
    const dir = tempDir();
    const first = new RunState(dir);
    const second = new RunState(dir);
    first.markRun('open-shop', RUN);
    second.markRun('close-shop', { ...RUN, verdict: 'failed' });
    first.reload();
    expect(Object.keys(first.lastRuns()).sort()).toEqual(['close-shop', 'open-shop']);
    expect(new RunState(dir).lastRuns()['close-shop']).toMatchObject({ verdict: 'failed' });
  });

  it('starts empty rather than failing on a damaged file', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'state.json'), '{ not json');
    expect(new RunState(dir).lastRuns()).toEqual({});
  });
});

describe('RunLock', () => {
  it('admits one holder at a time', () => {
    const dir = tempDir();
    const first = new RunLock(dir);
    const second = new RunLock(dir);
    expect(first.tryAcquire()).toBe(true);
    expect(second.tryAcquire()).toBe(false);
    first.release();
    expect(second.tryAcquire()).toBe(true);
    second.release();
    expect(fs.existsSync(path.join(dir, 'run.lock'))).toBe(false);
  });

  it('takes over a lock whose process is gone', () => {
    const dir = tempDir();
    // A pid far above any real one: no such process.
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: 2 ** 30, startedAt: new Date().toISOString() }));
    expect(new RunLock(dir).tryAcquire()).toBe(true);
  });

  it('takes over a lock that is older than the stale limit, even from a live process', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'run.lock'), JSON.stringify({ pid: process.ppid, startedAt: '2026-03-10T00:00:00Z' }));
    expect(new RunLock(dir, 60_000).tryAcquire(new Date('2026-03-10T00:00:30Z'))).toBe(false);
    expect(new RunLock(dir, 60_000).tryAcquire(new Date('2026-03-10T00:02:00Z'))).toBe(true);
  });

  it('does not delete a lock it does not hold', () => {
    const dir = tempDir();
    const holder = new RunLock(dir);
    holder.tryAcquire();
    new RunLock(dir).release();
    expect(fs.existsSync(path.join(dir, 'run.lock'))).toBe(true);
  });
});
