/**
 * The generated JSONApiResponse reads a 204 (or an empty body) as no value
 * instead of throwing "Unexpected end of JSON input". The generator does not do
 * this itself; scripts/patch-runtime-empty-body.mjs patches every runtime.ts
 * after generation.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Configuration, RegisterSessionsApi } from '@durion-sdk/order';

const ROOT = join(__dirname, '..', '..');

function apiAnswering(status: number, body: string | null): RegisterSessionsApi {
  const fetchApi = async (): Promise<Response> =>
    new Response(body, { status, headers: body ? { 'Content-Type': 'application/json' } : {} });
  return new RegisterSessionsApi(new Configuration({ basePath: 'http://qa.invalid', fetchApi }));
}

describe('generated runtime: empty response bodies', () => {
  it('returns undefined for a 204 with no body', async () => {
    const api = apiAnswering(204, null);
    await expect(api.getCurrentRegisterSession({ terminalId: 'T-1' })).resolves.toBeUndefined();
  });

  it('returns undefined for a 200 with an empty body', async () => {
    const api = apiAnswering(200, '');
    await expect(api.getCurrentRegisterSession({ terminalId: 'T-1' })).resolves.toBeUndefined();
  });

  it('still parses a 200 JSON body', async () => {
    const api = apiAnswering(200, JSON.stringify({ terminalId: 'T-1', status: 'OPEN' }));
    await expect(api.getCurrentRegisterSession({ terminalId: 'T-1' })).resolves.toMatchObject({
      terminalId: 'T-1',
      status: 'OPEN',
    });
  });

  it('is applied to every generated package', () => {
    const unpatched = readdirSync(join(ROOT, 'packages'))
      .filter((dir) => dir.startsWith('sdk-'))
      .map((dir) => join(ROOT, 'packages', dir, 'src', 'runtime.ts'))
      .filter((file) => existsSync(file))
      .filter((file) => !readFileSync(file, 'utf8').includes('patch-runtime-empty-body.mjs'));
    expect(unpatched).toEqual([]);
  });
});

describe('patchRuntime', () => {
  // The script is ESM, which Jest's CommonJS runtime cannot import; call it
  // through a child node process instead.
  const SCRIPT = join(ROOT, 'scripts', 'patch-runtime-empty-body.mjs');
  const run = (body: string): string =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import * as m from ${JSON.stringify(SCRIPT)};\n${body}`], {
      encoding: 'utf8',
    });

  it('patches the generated shape once and is idempotent', () => {
    const out = run(`
      const source = 'export class JSONApiResponse<T> {\\n' + m.GENERATED + '\\n}\\n';
      const once = m.patchRuntime(source);
      console.log(JSON.stringify({ patched: once.includes(m.PATCHED), idempotent: m.patchRuntime(once) === once }));
    `);
    expect(JSON.parse(out)).toEqual({ patched: true, idempotent: true });
  });

  it('refuses a runtime whose value() changed shape', () => {
    const out = run(`
      try { m.patchRuntime('export class JSONApiResponse<T> {\\n    async value() { return 1; }\\n}\\n', 'x.ts'); console.log('no error'); }
      catch (e) { console.log(e.message); }
    `);
    expect(out).toMatch(/not the generated shape/);
  });
});
