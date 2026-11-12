/**
 * What has run, kept on disk so that separate invocations agree.
 *
 * `tick` from a scheduler and a long-lived `daemon` are different processes
 * (and on a bad day, both at once). They share this directory: the state file
 * says which scenarios have run in the current day, week and month, and the
 * lock makes sure only one process is running scenarios at a time.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { LastRun } from './planner';

export interface ScenarioState extends LastRun {
  at: string;
  verdict: string;
}

interface StateFile {
  scenarios: Record<string, ScenarioState>;
}

export class RunState {
  private data: StateFile = { scenarios: {} };
  private readonly file: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'state.json');
    this.reload();
  }

  /** Re-reads the file: another process may have run something since. */
  reload(): void {
    if (!fs.existsSync(this.file)) {
      return;
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<StateFile>;
      if (parsed.scenarios && typeof parsed.scenarios === 'object') {
        this.data = { scenarios: parsed.scenarios };
      }
    } catch {
      // A torn or hand-damaged file must not stop the harness; the worst case is one repeated scenario.
    }
  }

  lastRuns(): Record<string, ScenarioState | undefined> {
    return this.data.scenarios;
  }

  markRun(scenarioId: string, state: ScenarioState): void {
    this.reload();
    this.data.scenarios[scenarioId] = state;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`, 'utf8');
    fs.renameSync(temp, this.file);
  }
}

interface LockBody {
  pid: number;
  startedAt: string;
}

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * One runner at a time per state directory.
 *
 * Created with O_EXCL, so two processes cannot both believe they hold it. A
 * lock whose process is gone, or which is older than `staleMs`, is taken over:
 * a crash or a closed laptop lid must not block every later run.
 */
export class RunLock {
  private held = false;
  private readonly file: string;

  constructor(
    stateDir: string,
    private readonly staleMs = 3 * 60 * 60 * 1000,
  ) {
    this.file = path.join(stateDir, 'run.lock');
  }

  /** @returns true when acquired; false when another live process holds it. */
  tryAcquire(now: Date = new Date()): boolean {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const body: LockBody = { pid: process.pid, startedAt: now.toISOString() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fs.writeFileSync(this.file, JSON.stringify(body), { flag: 'wx' });
        this.held = true;
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
        const holder = this.holder();
        const stale =
          !holder || !isAlive(holder.pid) || now.getTime() - Date.parse(holder.startedAt) > this.staleMs;
        if (!stale || (holder && holder.pid === process.pid)) {
          return false;
        }
        fs.rmSync(this.file, { force: true });
      }
    }
    return false;
  }

  holder(): LockBody | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as LockBody;
    } catch {
      return undefined;
    }
  }

  release(): void {
    if (this.held) {
      fs.rmSync(this.file, { force: true });
      this.held = false;
    }
  }
}
