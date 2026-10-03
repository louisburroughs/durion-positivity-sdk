import { environmentLockPath } from './environmentLock';

describe('environmentLockPath', () => {
  const ROOT = '/repo';

  it('defaults to the accelerated journal lock at the repository root', () => {
    expect(environmentLockPath({}, ROOT)).toBe('/repo/.itest-accel-journal.json.lock');
  });

  it('follows ITEST_ACCEL_JOURNAL the way the accelerated config does', () => {
    expect(environmentLockPath({ ITEST_ACCEL_JOURNAL: 'runs/journal.json' }, ROOT)).toBe('/repo/runs/journal.json.lock');
  });

  it('prefers ITEST_ACCEL_LOCK_FILE, and keeps an absolute path as given', () => {
    expect(environmentLockPath({ ITEST_ACCEL_LOCK_FILE: 'x.lock', ITEST_ACCEL_JOURNAL: 'j.json' }, ROOT)).toBe('/repo/x.lock');
    expect(environmentLockPath({ ITEST_ACCEL_LOCK_FILE: '/var/lock/alpha.lock' }, ROOT)).toBe('/var/lock/alpha.lock');
  });
});
