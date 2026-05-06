import { createCatalogClient, type CatalogItemRequestDto, type ProductCreateRequestDto } from '@durion-sdk/catalog';
import type { DurionSdkConfig } from '@durion-sdk/transport';

interface ServiceSeedDefinition {
  name: string;
  price: number;
}

interface ProductSeedDefinition {
  name: string;
  sku: string;
  mpn: string;
  category: string;
  description: string;
  pricingIntent: number;
}

interface CatalogBootstrapResult {
  serviceEntityIds: string[];
  productEntityIds: string[];
  createdCount: number;
  skippedCount: number;
}

const SERVICE_SEEDS: ServiceSeedDefinition[] = [
  { name: 'Oil Change - Full Synthetic', price: 79.99 },
  { name: 'Brake Pad Replacement - Front', price: 189.99 },
  { name: 'Brake Pad Replacement - Rear', price: 179.99 },
  { name: 'Tire Rotation', price: 39.99 },
  { name: 'Wheel Alignment - 4-Wheel', price: 129.99 },
  { name: 'Coolant System Flush', price: 149.99 },
  { name: 'Battery Replacement', price: 199.99 },
  { name: 'Air Filter Replacement', price: 49.99 },
  { name: 'Spark Plug Replacement', price: 249.99 },
  { name: 'Wiper Blade Replacement', price: 34.99 },
  { name: 'Cabin Air Filter Replacement', price: 59.99 },
  { name: 'Transmission Service', price: 299.99 },
];

const PRODUCT_SEEDS: ProductSeedDefinition[] = [
  ...buildProducts('Oil Filter', 'OF', 5, 'FILTERS', 12.49),
  ...buildProducts('Brake Pad Set', 'BP', 6, 'BRAKES', 74.99),
  ...buildProducts('Battery', 'BAT', 3, 'ELECTRICAL', 129.99),
  ...buildProducts('Engine Air Filter', 'AF', 4, 'FILTERS', 19.99),
  ...buildProducts('Wiper Blade', 'WB', 4, 'VISIBILITY', 16.99),
  ...buildProducts('Spark Plug', 'SP', 4, 'IGNITION', 8.99),
  ...buildProducts('Cabin Air Filter', 'CAF', 4, 'FILTERS', 21.99),
];

export class CatalogBootstrap {
  constructor(private readonly sdkConfig: DurionSdkConfig) {}

  async run(): Promise<CatalogBootstrapResult> {
    const { catalogItemsApi, productsApi } = createCatalogClient(this.sdkConfig);

    const serviceEntityIds: string[] = [];
    const productEntityIds: string[] = [];
    let createdCount = 0;
    let skippedCount = 0;

    for (const service of SERVICE_SEEDS) {
      const existingId = await this.findCatalogEntityIdByName(
        () => productsApi.getServiceByName({ name: service.name }),
      );

      if (existingId) {
        serviceEntityIds.push(existingId);
        skippedCount += 1;
        continue;
      }

      const request: CatalogItemRequestDto = {
        name: service.name,
        shortDescription: `${service.name} service`,
        longDescription: `${service.name} seeded by sdk-seeder with intended sell price $${service.price.toFixed(2)}.`,
        type: 'SERVICE',
        specifications: JSON.stringify({
          seededBy: 'sdk-seeder',
          pricingIntent: service.price,
        }),
      };

      try {
        const created = await catalogItemsApi.addCatalogItem({
          type: 'SERVICE',
          catalogItemRequestDto: request,
        });
        const createdId = this.extractEntityId(created);
        if (!createdId) {
          throw new Error(`CatalogBootstrap: service ${service.name} was created without an id`);
        }
        serviceEntityIds.push(createdId);
        createdCount += 1;
      } catch (error) {
        if (!this.isDuplicateLikeError(error)) {
          throw error;
        }

        const duplicateId = await this.findCatalogEntityIdByName(
          () => productsApi.getServiceByName({ name: service.name }),
        );
        if (!duplicateId) {
          throw error;
        }
        serviceEntityIds.push(duplicateId);
        skippedCount += 1;
      }
    }

    for (const product of PRODUCT_SEEDS) {
      const existingId = await this.findCatalogEntityIdByName(
        () => productsApi.getProductByName({ name: product.name }),
      );

      if (existingId) {
        productEntityIds.push(existingId);
        skippedCount += 1;
        continue;
      }

      const request: ProductCreateRequestDto = {
        name: product.name,
        description: product.description,
        unitOfMeasure: 'EA',
        sku: product.sku,
        mpn: product.mpn,
        attributes: JSON.stringify({
          seededBy: 'sdk-seeder',
          category: product.category,
          pricingIntent: product.pricingIntent,
        }),
      };

      try {
        const created = await productsApi.createProduct({
          productCreateRequestDto: request,
        });
        const createdId = this.extractEntityId(created);
        if (!createdId) {
          throw new Error(`CatalogBootstrap: product ${product.sku} was created without an id`);
        }
        productEntityIds.push(createdId);
        createdCount += 1;
      } catch (error) {
        if (!this.isDuplicateLikeError(error)) {
          throw error;
        }

        const duplicateId = await this.findCatalogEntityIdByName(
          () => productsApi.getProductByName({ name: product.name }),
        );
        if (!duplicateId) {
          throw error;
        }
        productEntityIds.push(duplicateId);
        skippedCount += 1;
      }
    }

    return {
      serviceEntityIds,
      productEntityIds,
      createdCount,
      skippedCount,
    };
  }

  private async findCatalogEntityIdByName(
    fetchByName: () => Promise<unknown>,
  ): Promise<string | undefined> {
    try {
      const response = await fetchByName();
      return this.extractEntityId(response);
    } catch {
      return undefined;
    }
  }

  private extractEntityId(payload: unknown): string | undefined {
    if (typeof payload === 'string') {
      return undefined;
    }

    if (Array.isArray(payload)) {
      for (const item of payload) {
        const id = this.extractEntityId(item);
        if (id) {
          return id;
        }
      }
      return undefined;
    }

    if (!this.isRecord(payload)) {
      return undefined;
    }

    const directId = this.readString(payload, ['id', 'productId', 'serviceId', 'catalogId', 'entityId']);
    if (directId) {
      return directId;
    }

    for (const collectionKey of ['content', 'data', 'items', 'results']) {
      const collection = payload[collectionKey];
      if (Array.isArray(collection)) {
        for (const item of collection) {
          const id = this.extractEntityId(item);
          if (id) {
            return id;
          }
        }
      }
    }

    return undefined;
  }

  private isDuplicateLikeError(error: unknown): boolean {
    const status = this.extractStatus(error);
    return status === 409 || status === 400 || status === 422;
  }

  private extractStatus(error: unknown): number | undefined {
    if (!this.isRecord(error)) {
      return undefined;
    }

    const directStatus = error.status;
    if (typeof directStatus === 'number') {
      return directStatus;
    }

    const response = error.response;
    if (this.isRecord(response) && typeof response.status === 'number') {
      return response.status;
    }

    const cause = error.cause;
    if (this.isRecord(cause) && typeof cause.status === 'number') {
      return cause.status;
    }

    return undefined;
  }

  private readString(source: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

function buildProducts(
  baseName: string,
  prefix: string,
  count: number,
  category: string,
  startingPrice: number,
): ProductSeedDefinition[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    const sku = `${prefix}-${sequence}`;
    const price = Number((startingPrice + index * 1.75).toFixed(2));

    return {
      name: `${baseName} ${index + 1}`,
      sku,
      mpn: `${prefix}M-${sequence}`,
      category,
      description: `${baseName} ${index + 1} seeded by sdk-seeder for ${category.toLowerCase()} workflows.`,
      pricingIntent: price,
    };
  });
}
