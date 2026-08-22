import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import type { ReferenceCache } from '../support/ReferenceCache';
import { VirtualClock } from '../support/VirtualClock';
import { CatalogBootstrap } from './CatalogBootstrap';
import { InventoryBootstrap } from './InventoryBootstrap';
import { LocationBootstrap } from './LocationBootstrap';
import { PeopleBootstrap } from './PeopleBootstrap';

export class BootstrapOrchestrator {
  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
  ) {}

  async run(): Promise<ReferenceCache> {
    console.log('[Bootstrap] Starting bootstrap sequence...');

    // -- Location --------------------------------------------------------------
    const locationResult = await new LocationBootstrap(this.auth.buildSdkConfig('location')).run();
    const { locationId, bayIds } = locationResult;

    // -- People ----------------------------------------------------------------
    const peopleResult = await new PeopleBootstrap(this.auth.buildSdkConfig('people')).run(locationId);
    const { employees, employeeNameById } = peopleResult;

    // -- Catalog ---------------------------------------------------------------
    const catalogResult = await new CatalogBootstrap(this.auth.buildSdkConfig('catalog')).run();
    const { serviceEntityIds, productEntityIds, productNameById, serviceNameById } = catalogResult;

    // -- Inventory -------------------------------------------------------------
    const namedProducts = productEntityIds.map((id) => ({
      id,
      name: productNameById.get(id) ?? id,
    }));
    // /system/time exists only under the backend's accelerated profile. The
    // integration suite bootstraps against the normal clock, where the endpoint
    // is absent - fall back to the real clock instead of failing the whole
    // bootstrap. Only the inventory PO/delivery dates below use this value.
    const acceleratedNow = await new VirtualClock(this.config.baseUrl, this.config.pollIntervalMs)
      .tryGetCurrentVirtualTime();
    if (acceleratedNow === null) {
      console.log('[Bootstrap] No /system/time endpoint (non-accelerated backend); using the real clock.');
    }
    const virtualNow = acceleratedNow ?? new Date();
    const inventoryResult = await new InventoryBootstrap(
      this.auth.buildSdkConfig('inventory'),
      this.auth.buildSdkConfig('order'),
    ).run(
      namedProducts,
      locationId,
      virtualNow,
    );

    // -- Summary ---------------------------------------------------------------
    const sep = '─'.repeat(71);
    console.log(`[Bootstrap] ${sep}`);
    console.log(`[Bootstrap]  BOOTSTRAP SUMMARY`);
    console.log(`[Bootstrap] ${sep}`);
    console.log(`[Bootstrap]  Location  : ${locationId}  (${bayIds.length} bays)`);
    this.logNamedResult('[Bootstrap]  People    ', peopleResult.created, peopleResult.skipped);
    this.logNamedResult('[Bootstrap]  Services  ', catalogResult.createdServiceNames, catalogResult.skippedServiceNames);
    this.logNamedResult('[Bootstrap]  Products  ', catalogResult.createdProductNames, catalogResult.skippedProductNames);
    this.logNamedResult('[Bootstrap]  Inventory ', inventoryResult.created, inventoryResult.skipped);
    console.log(`[Bootstrap] ${sep}`);
    console.log('[Bootstrap] Complete.');

    return {
      locationId,
      bayIds,
      employees,
      serviceEntityIds,
      productEntityIds,
      serviceNameById,
      productNameById,
      employeeNameById,
    };
  }

  private logNamedResult(
    prefix: string,
    created: string[],
    skipped: string[],
  ): void {
    if (created.length > 0) {
      console.log(`${prefix}: ${created.length} created — ${created.join(', ')}`);
    }
    if (skipped.length > 0) {
      console.log(`${prefix}: ${skipped.length} skipped — ${skipped.join(', ')}`);
    }
    if (created.length === 0 && skipped.length === 0) {
      console.log(`${prefix}: nothing to report`);
    }
  }

}