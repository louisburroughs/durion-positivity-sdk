import { githubDeployWatch } from './DeployWatch';

describe('githubDeployWatch', () => {
  const from = new Date('2026-11-26T14:30:00Z');
  const to = new Date('2026-11-26T14:40:00Z');

  it('returns the deploy runs that overlapped the scenario, skipping runs that shipped nothing', async () => {
    const watch = githubDeployWatch({
      repo: 'owner/backend',
      workflow: 'build-push-ecr.yml',
      list: async (repo, workflow) => {
        expect([repo, workflow]).toEqual(['owner/backend', 'build-push-ecr.yml']);
        return [
          { databaseId: 1, createdAt: '2026-11-26T14:24:00Z', updatedAt: '2026-11-26T14:46:00Z', status: 'completed' },
          // Finished in a minute: nothing to ship, nothing restarted.
          { databaseId: 2, createdAt: '2026-11-26T14:31:00Z', updatedAt: '2026-11-26T14:32:00Z', status: 'completed' },
          { databaseId: 3, createdAt: '2026-11-26T12:30:00Z', updatedAt: '2026-11-26T12:51:00Z', status: 'completed' },
          { databaseId: 4, createdAt: '2026-11-26T14:38:00Z', updatedAt: '2026-11-26T14:39:00Z', status: 'in_progress' },
          { databaseId: 5, createdAt: '2026-11-26T14:45:00Z', status: 'queued' },
        ];
      },
    });
    expect(await watch.windows(from, to)).toEqual([
      { start: '2026-11-26T14:24:00.000Z', end: '2026-11-26T14:46:00.000Z', label: 'build-push-ecr.yml run 1' },
      { start: '2026-11-26T14:38:00.000Z', end: undefined, label: 'build-push-ecr.yml run 4 (in progress)' },
    ]);
  });

  it('returns no windows, and logs why, when the runs cannot be read', async () => {
    const lines: string[] = [];
    const watch = githubDeployWatch({
      repo: 'owner/backend',
      workflow: 'build-push-ecr.yml',
      list: async () => {
        throw new Error('gh: not logged in');
      },
      log: (line) => lines.push(line),
    });
    expect(await watch.windows(from, to)).toEqual([]);
    expect(lines).toEqual(['deploy watch: could not list build-push-ecr.yml runs: gh: not logged in']);
  });
});
