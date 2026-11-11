/**
 * The tenant's shops, read from the tenant itself.
 *
 * A tenant's day is every one of its locations opening, serving its own
 * customers and closing. Which locations those are is not configuration: it is
 * whatever the location service says is active and able to do work today, so a
 * site added to the tenant is in the next morning's plan without anyone
 * touching the harness.
 */
import type { Catalog } from '../catalog/types';
import type { SdkInvoker } from '../sdk/SdkInvoker';

export interface Site {
  id: string;
  code: string;
  name: string;
  /** Short, stable, id-safe label used in task ids: `main`, `north-2`. */
  slug: string;
  /** Active bays plus active mobile units: how much work the site can hold at once. */
  positions: number;
}

const slugOf = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16)
    .replace(/-+$/, '');

/**
 * The locations that take part in the day: active, and with at least one bay
 * or mobile unit to put work on. Sorted by code so the order (and so the
 * slugs) is the same every time.
 */
export function sitesFromLocations(locations: unknown): Site[] {
  if (!Array.isArray(locations)) {
    return [];
  }
  const sites: Site[] = [];
  const used = new Set<string>();
  const rows = locations
    .filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null)
    .sort((a, b) => String(a['code'] ?? a['name'] ?? '').localeCompare(String(b['code'] ?? b['name'] ?? '')));
  for (const row of rows) {
    const id = typeof row['id'] === 'string' ? row['id'] : undefined;
    const positions = Number(row['activeBayCount'] ?? 0) + Number(row['activeMobileUnitCount'] ?? 0);
    if (!id || row['active'] === false || !(positions > 0)) {
      continue;
    }
    const name = typeof row['name'] === 'string' && row['name'] ? row['name'] : id;
    const code = typeof row['code'] === 'string' && row['code'] ? row['code'] : name;
    let slug = slugOf(code) || `site${sites.length + 1}`;
    for (let suffix = 2; used.has(slug); suffix += 1) {
      slug = `${slugOf(code) || 'site'}-${suffix}`;
    }
    used.add(slug);
    sites.push({ id, code, name, slug, positions });
  }
  return sites;
}

/** Asks the tenant which locations are open for work. One read, through the SDK like everything else. */
export async function surveySites(invoker: SdkInvoker, catalog: Catalog, persona: string): Promise<Site[]> {
  const operation = catalog.byId.get('location.LocationAPIApi.listLocations');
  if (!operation) {
    throw new Error('the location client has no listLocations operation');
  }
  const outcome = await invoker.invoke(operation, {}, persona);
  if (outcome.kind === 'transport-error') {
    throw new Error(`cannot reach the backend to list the tenant's locations (${outcome.message})`);
  }
  if (outcome.kind !== 'success') {
    throw new Error(`could not list the tenant's locations: ${outcome.status ?? ''} ${outcome.errorCode ?? outcome.message ?? ''}`.trim());
  }
  return sitesFromLocations(outcome.body);
}
