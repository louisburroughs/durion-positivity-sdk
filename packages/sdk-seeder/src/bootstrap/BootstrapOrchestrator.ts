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
    console.log(
      `[Bootstrap] PeopleBootstrap: ${peopleResult.createdCount} created, ${peopleResult.skippedCount} skipped.`,
    );

    // -- Catalog ---------------------------------------------------------------
    const catalogResult = await new CatalogBootstrap(this.auth.buildSdkConfig('catalog')).run();
    const { serviceEntityIds, productEntityIds } = catalogResult;
    console.log(
      `[Bootstrap] CatalogBootstrap: ${catalogResult.createdCount} created, ${catalogResult.skippedCount} skipped. ` +
      `${serviceEntityIds.length} services, ${productEntityIds.length} products.`,
    );

    // -- Inventory -------------------------------------------------------------
    const inventoryResult = await new InventoryBootstrap(this.auth.buildSdkConfig('inventory')).run(
      productEntityIds,
      locationId,
    );
    console.log(
      `[Bootstrap] InventoryBootstrap: ${inventoryResult.createdCount} created, ${inventoryResult.skippedCount} skipped.`,
    );

    console.log('[Bootstrap] Complete.');
    return {
      locationId,
      bayIds,
      employees,
      serviceEntityIds,
      productEntityIds,
    };
  }

}