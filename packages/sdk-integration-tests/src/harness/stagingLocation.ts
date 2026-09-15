import type { DomainClients } from './personas';

/** Where the resolved staging location came from, for the log line. */
export type StagingLocationSource = 'env-override' | 'site-defaults' | 'backend-fallback';

export interface ResolvedStagingLocation {
  stagingLocationId: string;
  source: StagingLocationSource;
}

/**
 * pos-inventory's own fallback when a site declares no staging default
 * (`StagingLocationResolver.DEFAULT_STAGING_LOCATION_ID`). Kept here so the
 * suite fails the same way the backend behaves rather than a way of its own,
 * and so the constant has exactly one home.
 */
export const BACKEND_DEFAULT_STAGING_LOCATION_ID = '00000000-0000-0000-0000-000000000002';

/**
 * Resolves the storage location putaway treats as staging, mirroring
 * `StagingLocationResolver`'s chain: an explicit override, then the site's
 * declared default, then the backend's hardcoded fallback.
 *
 * Putaway generation refuses a receipt booked anywhere other than the resolved
 * staging location (`RECEIPT_NOT_STAGED`), so guessing wrong fails the whole
 * putaway path with an error that does not name the cause. Asking the owning
 * service is what keeps this suite off a hardcoded id that only happens to
 * match the backend's fallback.
 *
 * The backend's alpha packs declare site defaults for every site they load
 * (`site-defaults.csv`), including the SDK seeder's site ATX-RIV-001, so on a
 * database loaded from those packs this resolves to the site's declared
 * "Staging Floor". A site loaded without defaults still falls through to the
 * backend constant, exactly as `StagingLocationResolver` does.
 */
export const resolveStagingLocation = async (
  clients: DomainClients,
  siteId: string,
  envOverride: string | undefined,
): Promise<ResolvedStagingLocation> => {
  if (envOverride) {
    return { stagingLocationId: envOverride, source: 'env-override' };
  }

  try {
    const defaults = await clients.location.siteDefaultsApi.getSiteDefaults({
      locationId: siteId,
    });
    if (defaults.defaultStagingLocationId) {
      return {
        stagingLocationId: defaults.defaultStagingLocationId,
        source: 'site-defaults',
      };
    }
  } catch {
    // A site that has never had defaults installed answers 404, which is the
    // normal state today rather than an error worth failing on: the backend
    // treats it as "no declared default" and so does this.
  }

  return {
    stagingLocationId: BACKEND_DEFAULT_STAGING_LOCATION_ID,
    source: 'backend-fallback',
  };
};
