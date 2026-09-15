import type { DomainClients } from './personas';
import { withSiteScope } from './http';

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
 * Resolves the storage location putaway treats as staging.
 *
 * `StagingLocationResolver` resolves a site id first — from `X-Site-Id`, a
 * `{siteId}` path variable, or the configured `pos.inventory.receiving.site-id`
 * — and a site's declared default wins whenever one is in scope. Only with no
 * site id, or a site that declares no default, does it fall back to the
 * configured `pos.inventory.receiving.staging-location-id` and then to its
 * hardcoded constant. So the env override here stands in for that configured
 * property, which sits *below* the declared default rather than above it: a
 * forced bin holds only on a call that is not site-scoped.
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
 *
 * One condition this cannot mirror by itself: whether the request is
 * site-scoped. A call to an endpoint with no `{siteId}` in its path must send
 * `withSiteScope(siteId)` from `http.ts` when this returned `site-defaults`, or
 * the backend compares against its own fallback while this resolver returned the
 * declared bin — and must *not* send it when this returned `env-override`, which
 * the header would override with the declared default. The returned `source` is
 * what callers branch on.
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

/**
 * The per-request override a putaway call should carry for a resolved staging
 * location, or undefined when it must not be site-scoped.
 *
 * `X-Site-Id` is not a free-floating "be more correct" flag: it decides which
 * arm of `StagingLocationResolver` wins. Scoped, a site's declared default
 * beats the configured `pos.inventory.receiving.staging-location-id`; unscoped,
 * that property (or the backend constant) is what putaway compares the receipt
 * against.
 *
 * So the header goes out only for `site-defaults`. For `env-override` the
 * forced bin stands in for the configured property, and scoping the call would
 * make the backend resolve the declared default instead and refuse every
 * receipt booked at the forced bin. For `backend-fallback` the site declares no
 * default, so scoping changes nothing - the backend lands on the same fallback
 * either way - and the header is left off to keep "scoped" meaning "the
 * declared default is the bin we mean".
 */
export const siteScopeForStaging = (
  staging: ResolvedStagingLocation,
  siteId: string,
): ReturnType<typeof withSiteScope> | undefined =>
  staging.source === 'site-defaults' ? withSiteScope(siteId) : undefined;
