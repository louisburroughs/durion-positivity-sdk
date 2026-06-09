import { createLocationClient, type LocationResponseDTO } from '@durion-sdk/location';
import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import type { ReferenceCache } from '../support/ReferenceCache';
import { CatalogBootstrap } from './CatalogBootstrap';
import { InventoryBootstrap } from './InventoryBootstrap';
import { PeopleBootstrap } from './PeopleBootstrap';

const LOCATION_CODE = 'MAIN-01';

export class BootstrapOrchestrator {
  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
  ) {
    void this.config;
  }

  async run(): Promise<ReferenceCache> {
    console.log('[Bootstrap] Starting bootstrap sequence...');

    // -- Location --------------------------------------------------------------
    const { locationApi, bayApi } = createLocationClient(this.auth.buildSdkConfig('location'));
    const allLocations = await locationApi.getAllLocations();
    const location = allLocations.find((l: LocationResponseDTO) => l.code === LOCATION_CODE);
    if (!location?.id) {
      throw new Error(`[Bootstrap] Location with code ${LOCATION_CODE} not found`);
    }
    const locationId = location.id;

    const baysPage = await bayApi.listBays({ locationId, size: 20 });
    const bayIds = (baysPage.content ?? [])
      .map((b) => b.id)
      .filter((id): id is string => !!id);

    console.log(`[Bootstrap] Location resolved: ${locationId}, ${bayIds.length} bays.`);

    // -- People ----------------------------------------------------------------
    const peopleResult = await new PeopleBootstrap(this.auth.buildSdkConfig('people')).run(locationId);
    const { employees } = peopleResult;

    // -- Catalog ---------------------------------------------------------------
    const catalogResult = await new CatalogBootstrap(this.auth.buildSdkConfig('catalog')).run();
    const { serviceEntityIds, productEntityIds, productNameById } = catalogResult;

    // -- Inventory -------------------------------------------------------------
    const namedProducts = productEntityIds.map((id) => ({
      id,
      name: productNameById.get(id) ?? id,
    }));
    const inventoryResult = await new InventoryBootstrap(this.auth.buildSdkConfig('inventory')).run(
      namedProducts,
      locationId,
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