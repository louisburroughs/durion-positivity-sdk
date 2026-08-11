import { createLocationClient, type BayRequest, type LocationResponseDTO } from '@durion-sdk/location';
import type { DurionSdkConfig } from '@durion-sdk/transport';

interface LocationBootstrapResult {
  locationId: string;
  bayIds: string[];
  createdCount: number;
  skippedCount: number;
}

interface BaySeedDefinition {
  name: string;
  bayType: string;
  maxConcurrentVehicles: number;
}

const LOCATION_CODE = 'MAIN-01';
const LOCATION_NAME = 'Main Street Auto Service';
const LOCATION_TIMEZONE = 'America/New_York';
const LOCATION_TYPE_NAME = 'SHOP';
const LOCATION_ADDRESS_LINE_1 = '100 Main Street';
const LOCATION_CITY = 'Austin';
const LOCATION_STATE = 'TX';
const LOCATION_POSTAL_CODE = '78701';
const LOCATION_COUNTRY = 'US';

const BAY_DEFINITIONS: BaySeedDefinition[] = [
  { name: 'Bay 1', bayType: 'GENERAL_SERVICE', maxConcurrentVehicles: 1 },
  { name: 'Bay 2', bayType: 'GENERAL_SERVICE', maxConcurrentVehicles: 1 },
  { name: 'Bay 3', bayType: 'TIRE_SERVICE', maxConcurrentVehicles: 1 },
];

export class LocationBootstrap {
  constructor(private readonly sdkConfig: DurionSdkConfig) {}

  async run(): Promise<LocationBootstrapResult> {
    const { bayApi, locationApi } = createLocationClient(this.sdkConfig);

    let createdCount = 0;
    let skippedCount = 0;

    const roster = await locationApi.getAllLocations();

    const existingLocation = roster.find(
      (location: LocationResponseDTO) => location.code === LOCATION_CODE,
    );

    let locationId = existingLocation?.id;
    if (!locationId) {
      const createdLocation = await locationApi.createLocation({
        locationRequestDTO: {
          name: LOCATION_NAME,
          code: LOCATION_CODE,
          addressLine1: LOCATION_ADDRESS_LINE_1,
          city: LOCATION_CITY,
          state: LOCATION_STATE,
          postalCode: LOCATION_POSTAL_CODE,
          country: LOCATION_COUNTRY,
          timezone: LOCATION_TIMEZONE,
          active: true,
          type: { name: LOCATION_TYPE_NAME },
        },
      });

      locationId = this.requireLocationId(createdLocation);
      createdCount += 1;
    } else {
      skippedCount += 1;
      const currentLocation = existingLocation;
      if (!currentLocation) {
        throw new Error('LocationBootstrap: existing location lookup failed unexpectedly');
      }

      const needsTaxAddressBackfill = !currentLocation.postalCode || !currentLocation.country;
      if (needsTaxAddressBackfill) {
        await locationApi.updateLocation({
          locationId,
          locationRequestDTO: {
            name: currentLocation.name ?? LOCATION_NAME,
            code: currentLocation.code ?? LOCATION_CODE,
            addressLine1: currentLocation.addressLine1 ?? LOCATION_ADDRESS_LINE_1,
            addressLine2: currentLocation.addressLine2,
            city: currentLocation.city ?? LOCATION_CITY,
            state: currentLocation.state ?? LOCATION_STATE,
            postalCode: currentLocation.postalCode ?? LOCATION_POSTAL_CODE,
            country: currentLocation.country ?? LOCATION_COUNTRY,
            timezone: LOCATION_TIMEZONE,
            active: currentLocation.active ?? true,
            type: currentLocation.type ?? { name: LOCATION_TYPE_NAME },
          },
        });

        console.log(
          `[Bootstrap] Updated location ${locationId} with missing tax address fields (country/postalCode).`,
        );
      }
    }

    const baysPage = await bayApi.listBays({ locationId, size: 10 });
    const existingBays = baysPage.content ?? [];
    const bayIds: string[] = [];

    for (const bayDefinition of BAY_DEFINITIONS) {
      const existingBay = existingBays.find((bay) => bay.name === bayDefinition.name);
      if (existingBay?.id) {
        bayIds.push(existingBay.id);
        skippedCount += 1;
        continue;
      }

      const bayRequest: BayRequest = {
        name: bayDefinition.name,
        bayType: bayDefinition.bayType,
        capacity: {
          maxConcurrentVehicles: bayDefinition.maxConcurrentVehicles,
        },
        maxConcurrentVehicles: bayDefinition.maxConcurrentVehicles,
        status: 'ACTIVE',
      };

      const createdBay = await bayApi.createBay({
        locationId,
        bayRequest,
      });

      if (!createdBay.id) {
        throw new Error(`LocationBootstrap: created bay ${bayDefinition.name} without an id`);
      }

      bayIds.push(createdBay.id);
      createdCount += 1;
    }

    return {
      locationId,
      bayIds,
      createdCount,
      skippedCount,
    };
  }

  private requireLocationId(location: LocationResponseDTO): string {
    if (!location.id) {
      throw new Error('LocationBootstrap: location response did not include an id');
    }
    return location.id;
  }
}
