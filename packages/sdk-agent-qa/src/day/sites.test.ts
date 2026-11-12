import { buildCatalog } from '../catalog/buildCatalog';
import { fakeBackend, invokerFor } from '../testing/fakes';
import { sitesFromLocations, surveySites } from './sites';

const location = (overrides: Record<string, unknown>): Record<string, unknown> => ({
  id: 'loc-1',
  code: 'MAIN',
  name: 'Main Street',
  active: true,
  activeBayCount: 4,
  activeMobileUnitCount: 1,
  ...overrides,
});

describe('sitesFromLocations', () => {
  it('takes every active location that has somewhere to put work, in a stable order', () => {
    const sites = sitesFromLocations([
      location({ id: 'loc-2', code: 'NORTH', name: 'Northside', activeBayCount: 2, activeMobileUnitCount: 0 }),
      location({}),
      location({ id: 'loc-3', code: 'WAREHOUSE', name: 'Warehouse', activeBayCount: 0, activeMobileUnitCount: 0 }),
      location({ id: 'loc-4', code: 'OLD', name: 'Closed Shop', active: false }),
      location({ id: 'loc-5', code: 'VAN', name: 'Mobile Only', activeBayCount: 0, activeMobileUnitCount: 2 }),
    ]);
    expect(sites).toEqual([
      { id: 'loc-1', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 5 },
      { id: 'loc-2', code: 'NORTH', name: 'Northside', slug: 'north', positions: 2 },
      { id: 'loc-5', code: 'VAN', name: 'Mobile Only', slug: 'van', positions: 2 },
    ]);
  });

  it('makes slugs that are safe in task ids and unique', () => {
    const sites = sitesFromLocations([
      location({ id: 'a', code: 'Store #12 / East' }),
      location({ id: 'b', code: 'store-12-east' }),
      location({ id: 'c', code: undefined, name: 'Élan Auto' }),
    ]);
    expect(sites.map((site) => site.slug)).toEqual(['lan-auto', 'store-12-east', 'store-12-east-2']);
    expect(sites.every((site) => /^[a-z0-9-]+$/.test(site.slug))).toBe(true);
  });

  it('is empty for anything that is not a list of locations', () => {
    expect(sitesFromLocations(undefined)).toEqual([]);
    expect(sitesFromLocations({ content: [] })).toEqual([]);
  });
});

describe('surveySites', () => {
  const catalog = buildCatalog();

  it('asks the tenant, through the SDK', async () => {
    const backend = fakeBackend((request) => (request.path === '/location/v1/locations' ? { status: 200, body: [location({})] } : undefined));
    await expect(surveySites(invokerFor(backend), catalog, 'admin')).resolves.toEqual([
      { id: 'loc-1', code: 'MAIN', name: 'Main Street', slug: 'main', positions: 5 },
    ]);
    expect(backend.requests[0].headers.get('Authorization')).toBe('Bearer token-admin');
  });

  it('says the backend cannot be reached, rather than planning a day with no sites', async () => {
    const backend = fakeBackend();
    backend.fetchImpl = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(surveySites(invokerFor(backend), catalog, 'admin')).rejects.toThrow(/cannot reach the backend/);
  });

  it('reports a refusal as a refusal', async () => {
    const backend = fakeBackend(() => ({ status: 403, body: { code: 'ACCESS_DENIED' } }));
    await expect(surveySites(invokerFor(backend), catalog, 'admin')).rejects.toThrow(/could not list the tenant's locations: 403 ACCESS_DENIED/);
  });
});
