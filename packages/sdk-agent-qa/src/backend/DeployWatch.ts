/**
 * Tells the oracle when the backend was being redeployed.
 *
 * A deploy recreates the services it ships, so calls made meanwhile can answer 500, 503 or 504
 * even after the invoker's retries. Those are the stack restarting, not a defect, and the oracle
 * reports a run whose only server errors fall inside a deploy as `infra` instead of `failed`.
 *
 * The windows come from the deploy workflow's runs on GitHub, read with the `gh` CLI (already
 * authenticated on the machine the daemon runs on). A run that finished within
 * `minDurationMs` found nothing to ship and deployed nothing, so it is not a window.
 */
import { execFile } from 'child_process';

export interface DeployWindow {
  /** ISO start of the deploy run. */
  start: string;
  /** ISO end, or undefined while it is still running. */
  end?: string;
  label: string;
}

export interface DeployWatch {
  /** Deploys that overlapped [from, to]. Never throws: an unreadable source means no windows. */
  windows(from: Date, to: Date): Promise<DeployWindow[]>;
}

interface WorkflowRun {
  databaseId?: number;
  createdAt?: string;
  updatedAt?: string;
  status?: string;
}

export type RunLister = (repo: string, workflow: string) => Promise<WorkflowRun[]>;

const ghRunList: RunLister = (repo, workflow) =>
  new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['run', 'list', '-R', repo, '--workflow', workflow, '--limit', '20', '--json', 'databaseId,createdAt,updatedAt,status'],
      { timeout: 20_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout) as WorkflowRun[]);
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });

export function githubDeployWatch(options: {
  repo: string;
  workflow: string;
  minDurationMs?: number;
  list?: RunLister;
  log?(message: string): void;
}): DeployWatch {
  const minDurationMs = options.minDurationMs ?? 3 * 60_000;
  const list = options.list ?? ghRunList;
  return {
    async windows(from, to) {
      let runs: WorkflowRun[];
      try {
        runs = await list(options.repo, options.workflow);
      } catch (error) {
        options.log?.(`deploy watch: could not list ${options.workflow} runs: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
      const windows: DeployWindow[] = [];
      for (const run of runs) {
        if (!run.createdAt) {
          continue;
        }
        const start = Date.parse(run.createdAt);
        const running = run.status !== 'completed';
        const end = running || !run.updatedAt ? undefined : Date.parse(run.updatedAt);
        if (end !== undefined && end - start < minDurationMs) {
          continue;
        }
        if (start > to.getTime() || (end !== undefined && end < from.getTime())) {
          continue;
        }
        windows.push({
          start: new Date(start).toISOString(),
          end: end === undefined ? undefined : new Date(end).toISOString(),
          label: `${options.workflow} run ${run.databaseId ?? '?'}${running ? ' (in progress)' : ''}`,
        });
      }
      return windows;
    },
  };
}
