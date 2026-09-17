/**
 * One accelerated run at a time.
 *
 * Two concurrent accelerated runs against one alpha would interleave their
 * clock-ins, fight over the same bays, and produce a year of records neither could
 * be held to. Worse, while the accelerated profile is on, every *non*-accelerated
 * run is already blocked — their guard aborts on a 200 — so an abandoned run holds
 * the whole environment.
 *
 * What this enforces is a **lock file**, which covers the case that actually bites:
 * the same machine, or the same CI runner's workspace, starting a second run.
 * Cross-machine exclusion is not something a lock file can do, and this module does
 * not pretend to: that is the alpha workflow's `concurrency` group plus the
 * operator holding the advisory object named by `ITEST_ACCEL_LOCK_URI`. The lock
 * file records who holds it and against which timeline, so the failure message
 * names a person and a run rather than a path.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { hostname, userInfo } from 'os';
import { dirname } from 'path';

export interface LockHolder {
  runId: string;
  pid: number;
  host: string;
  user: string;
  /** The timeline the holder is writing, so a stale lock can be told apart. */
  realStart: string;
  acquiredAt: string;
}

/**
 * A lock whose holding process no longer exists is stale.
 *
 * A run killed with SIGKILL, or a laptop that slept and rebooted, leaves the file
 * behind; refusing forever on that basis would mean editing a file by hand before
 * every retry. `process.kill(pid, 0)` is the cheapest liveness check there is: it
 * signals nothing and throws ESRCH when the process is gone.
 *
 * Only ever applied to a lock from the *same host*. A live pid on another machine
 * says nothing about a pid number here.
 */
function holderIsAlive(holder: LockHolder): boolean {
  if (holder.host !== hostname()) {
    // Cannot tell from here, so assume it is held: a false release is worse than a
    // false refusal.
    return true;
  }
  if (holder.pid === process.pid) {
    return true;
  }
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else — still alive.
    return (error as { code?: string }).code === 'EPERM';
  }
}

/** Same holder, for the compare-before-unlink in the stale-takeover path. */
function sameHolder(a: LockHolder | undefined, b: LockHolder | undefined): boolean {
  if (a === undefined || b === undefined) {
    // An unreadable file on either read: treat it as changed rather than assume.
    return a === b;
  }
  return a.runId === b.runId && a.pid === b.pid && a.host === b.host && a.acquiredAt === b.acquiredAt;
}

export class AcceleratedLock {
  private held = false;
  private releaseHandlers: Array<() => void> = [];

  constructor(
    readonly path: string,
    private readonly identity: { runId: string; realStart: Date },
  ) {}

  /**
   * Takes the lock, or throws naming whoever holds it.
   *
   * Written with `wx` so the create-or-fail decision is the filesystem's, not a
   * check followed by a write: two runs starting in the same second would both pass
   * an `existsSync` test.
   */
  acquire(): void {
    const holder: LockHolder = {
      runId: this.identity.runId,
      pid: process.pid,
      host: hostname(),
      user: safeUsername(),
      realStart: this.identity.realStart.toISOString(),
      acquiredAt: new Date().toISOString(),
    };

    const directory = dirname(this.path);
    if (directory && directory !== '.' && !existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    try {
      writeFileSync(this.path, JSON.stringify(holder, null, 2), { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') {
        throw error;
      }
      this.takeOverStale(holder);
    }

    this.held = true;
    this.installReleaseHandlers();
  }

  /**
   * Takes a lock whose holder is gone.
   *
   * `wx` above is the airtight part: of two *live* runs, exactly one create
   * succeeds. This is the softer case — a run killed with SIGKILL, or a laptop that
   * slept and rebooted, leaves the file behind, and refusing forever on that basis
   * would mean editing a file by hand before every retry.
   *
   * The holder is therefore re-read immediately before the file is removed, and the
   * replacement is another create-or-fail rather than an overwrite. Either check
   * failing means somebody else got there first, and this run refuses rather than
   * sharing the lock. An earlier version wrote unconditionally, and then removed
   * unconditionally, both of which let two runs believe they held it.
   *
   * The residual window — a winner appearing between the re-read and the unlink — is
   * microseconds wide and cannot be closed with plain file operations. It is
   * tolerated deliberately: the guarantee that matters, two live runs, does not
   * depend on this path at all.
   */
  private takeOverStale(holder: LockHolder): void {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const existing = this.readHolder();
      if (existing && holderIsAlive(existing)) {
        throw new Error(
          `[accel] another accelerated run holds ${this.path}: run ${existing.runId} started ` +
            `${existing.acquiredAt} by ${existing.user}@${existing.host} (pid ${existing.pid}) against ` +
            `timeline ${existing.realStart}. Only one accelerated run may write to a backend at a time — ` +
            'two would interleave their shifts and fight over the same bays. Wait for it, or stop it and ' +
            `delete ${this.path}.`,
        );
      }

      console.log(
        `[accel] taking over a stale lock at ${this.path}` +
          (existing ? ` (run ${existing.runId}, pid ${existing.pid}, no longer running)` : ' (unreadable holder)'),
      );

      // Re-read and compare before unlinking: the file must still be the same dead
      // holder we just judged. Removing whatever happens to be there is how a fresh
      // winner's lock gets deleted.
      const current = this.readHolder();
      if (!sameHolder(existing, current)) {
        // It changed under us — go round again and let the liveness check above
        // decide about the new holder.
        continue;
      }
      rmSync(this.path, { force: true });

      try {
        writeFileSync(this.path, JSON.stringify(holder, null, 2), { encoding: 'utf8', flag: 'wx' });
        return;
      } catch (retryError) {
        if ((retryError as { code?: string }).code !== 'EEXIST') {
          throw retryError;
        }
        // Somebody created it between our unlink and our create.
        continue;
      }
    }

    const winner = this.readHolder();
    throw new Error(
      `[accel] lost the race to take over the stale lock at ${this.path}: it is now held by ` +
        `${winner ? `run ${winner.runId} (pid ${winner.pid}, ${winner.user}@${winner.host})` : 'another run'}. ` +
        'Only one accelerated run may write to a backend at a time — wait for it, or stop it and delete the file.',
    );
  }

  /** Gives the lock back. Safe to call twice, and safe to call when never acquired. */
  release(): void {
    if (!this.held) {
      return;
    }
    this.held = false;
    try {
      // Only our own lock: a stale-takeover race could otherwise delete the lock
      // the process that took over from us is holding.
      const existing = this.readHolder();
      if (existing && existing.pid === process.pid && existing.runId === this.identity.runId) {
        rmSync(this.path, { force: true });
      }
    } catch {
      // Nothing useful to do here; the next run treats it as stale.
    }
    for (const remove of this.releaseHandlers) {
      remove();
    }
    this.releaseHandlers = [];
  }

  readHolder(): LockHolder | undefined {
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as LockHolder;
    } catch {
      return undefined;
    }
  }

  /**
   * Releases on the ways a run ends that are not a clean return: an uncaught
   * throw, Ctrl-C, or a terminate. Without these a failed run leaves the
   * environment locked and the next operator has to work out why.
   */
  private installReleaseHandlers(): void {
    const onExit = () => this.release();
    const onSignal = (signal: NodeJS.Signals) => () => {
      this.release();
      process.kill(process.pid, signal);
    };

    const handlers: Array<[NodeJS.Signals | 'exit', () => void]> = [
      ['exit', onExit],
      ['SIGINT', onSignal('SIGINT')],
      ['SIGTERM', onSignal('SIGTERM')],
    ];

    for (const [event, handler] of handlers) {
      if (event === 'exit') {
        process.once('exit', handler);
        this.releaseHandlers.push(() => process.removeListener('exit', handler));
      } else {
        process.once(event, handler);
        this.releaseHandlers.push(() => process.removeListener(event, handler));
      }
    }
  }
}

function safeUsername(): string {
  try {
    return userInfo().username;
  } catch {
    return 'unknown';
  }
}
