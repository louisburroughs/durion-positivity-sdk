import { siteScopeForStaging, type ResolvedStagingLocation } from './stagingLocation';

const SITE_ID = '11111111-1111-1111-1111-111111111111';

const resolved = (
  source: ResolvedStagingLocation['source'],
  stagingLocationId = '22222222-2222-2222-2222-222222222222',
): ResolvedStagingLocation => ({ stagingLocationId, source });

/** The header the returned override would add, or undefined when there is none. */
const sentSiteId = async (
  override: ReturnType<typeof siteScopeForStaging>,
): Promise<string | null | undefined> => {
  if (!override) {
    return undefined;
  }
  const init = await override({ init: { method: 'POST' } });
  return new Headers(init.headers).get('X-Site-Id');
};

describe('siteScopeForStaging', () => {
  it('scopes the call when the bin is the declared default for the site, so the backend resolves that same bin', async () => {
    await expect(sentSiteId(siteScopeForStaging(resolved('site-defaults'), SITE_ID))).resolves.toBe(SITE_ID);
  });

  it('leaves an env-forced bin unscoped, so the header cannot override it with the declared default', async () => {
    expect(siteScopeForStaging(resolved('env-override'), SITE_ID)).toBeUndefined();
  });

  it('leaves the backend fallback unscoped, where the site declares no default to scope to', async () => {
    expect(siteScopeForStaging(resolved('backend-fallback'), SITE_ID)).toBeUndefined();
  });
});
