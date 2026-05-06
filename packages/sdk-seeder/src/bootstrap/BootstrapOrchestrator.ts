import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { ReferenceCache } from '../support/ReferenceCache';
import { CatalogBootstrap } from './CatalogBootstrap';
import { InventoryBootstrap } from './InventoryBootstrap';
import { LocationBootstrap } from './LocationBootstrap';
import { PeopleBootstrap } from './PeopleBootstrap';

export class BootstrapOrchestrator {
  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
  ) {
    void this.config;
  }

  async run(): Promise<ReferenceCache> {
    console.log('[Bootstrap] Starting bootstrap sequence...');

    const locationResult = await new LocationBootstrap(this.auth.buildSdkConfig('location')).run();
    console.log(
      `[Bootstrap] LocationBootstrap: ${locationResult.createdCount} created, ${locationResult.skippedCount} skipped.`,
    );

    const peopleResult = await new PeopleBootstrap(this.auth.buildSdkConfig('people')).run(locationResult.locationId);
    console.log(
      `[Bootstrap] PeopleBootstrap: ${peopleResult.createdCount} created, ${peopleResult.skippedCount} skipped.`,
    );

    const catalogResult = await new CatalogBootstrap(this.auth.buildSdkConfig('catalog')).run();
    console.log(
      `[Bootstrap] CatalogBootstrap: ${catalogResult.createdCount} created, ${catalogResult.skippedCount} skipped.`,
    );

    const inventoryResult = await new InventoryBootstrap(this.auth.buildSdkConfig('inventory')).run(
      catalogResult.productEntityIds,
      locationResult.locationId,
    );
    console.log(
      `[Bootstrap] InventoryBootstrap: ${inventoryResult.createdCount} created, ${inventoryResult.skippedCount} skipped.`,
    );

    const refs: ReferenceCache = {
      locationId: locationResult.locationId,
      bayIds: locationResult.bayIds,
      employees: peopleResult.employees,
      serviceEntityIds: catalogResult.serviceEntityIds,
      productEntityIds: catalogResult.productEntityIds,
    };

    console.log('[Bootstrap] Complete.');
    return refs;
  }
}
