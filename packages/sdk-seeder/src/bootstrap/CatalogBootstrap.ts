import { createCatalogClient, type CatalogItemRequestDto, type ProductCreateRequestDto } from '@durion-sdk/catalog';

type CatalogClient = ReturnType<typeof createCatalogClient>;
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
  createdServiceNames: string[];
  skippedServiceNames: string[];
  createdProductNames: string[];
  skippedProductNames: string[];
  serviceNameById: Map<string, string>;
  productNameById: Map<string, string>;
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
    const createdServiceNames: string[] = [];
    const skippedServiceNames: string[] = [];
    const createdProductNames: string[] = [];
    const skippedProductNames: string[] = [];
    const serviceNameById = new Map<string, string>();
    const productNameById = new Map<string, string>();

    for (const service of SERVICE_SEEDS) {
      const existingId = await this.findExistingServiceId(productsApi, service.name);

      if (existingId) {
        serviceEntityIds.push(existingId);
        serviceNameById.set(existingId, service.name);
        skippedServiceNames.push(service.name);
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
        const created = await catalogItemsApi.createCatalogItem({
          type: 'SERVICE',
          catalogItemRequestDto: request,
        });
        const createdId = this.extractEntityId(created);
        if (!createdId) {
          throw new Error(`CatalogBootstrap: service ${service.name} was created without an id`);
        }
        serviceEntityIds.push(createdId);
        serviceNameById.set(createdId, service.name);
        createdServiceNames.push(service.name);
        createdCount += 1;
      } catch (error) {
        if (!this.isDuplicateLikeError(error)) {
          throw error;
        }

        const duplicateId = await this.findExistingServiceId(productsApi, service.name);
        if (!duplicateId) {
          throw error;
        }
        serviceEntityIds.push(duplicateId);
        serviceNameById.set(duplicateId, service.name);
        skippedServiceNames.push(service.name);
        skippedCount += 1;
      }
    }

    for (const product of PRODUCT_SEEDS) {
      const existingId = await this.findExistingProductId(productsApi, product);

      if (existingId) {
        productEntityIds.push(existingId);
        productNameById.set(existingId, product.name);
        skippedProductNames.push(product.name);
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
        productNameById.set(createdId, product.name);
        createdProductNames.push(product.name);
        createdCount += 1;
      } catch (error) {
        if (!this.isDuplicateLikeError(error)) {
          throw error;
        }

        const duplicateId = await this.findExistingProductId(productsApi, product);
        if (!duplicateId) {
          throw error;
        }
        productEntityIds.push(duplicateId);
        productNameById.set(duplicateId, product.name);
        skippedProductNames.push(product.name);
        skippedCount += 1;
      }
    }

    return {
      serviceEntityIds,
      productEntityIds,
      createdCount,
      skippedCount,
      createdServiceNames,
      skippedServiceNames,
      createdProductNames,
      skippedProductNames,
      serviceNameById,
      productNameById,
    };
  }

  /**
   * Resolves an already-seeded service by exact name.
   *
   * listServicesByName cannot be used for this: the endpoint returns a JSON
   * array, but the generated client declares a single ServiceDto, so the
   * deserializer hands back {} and every run reads it as "not found" and seeds
   * a duplicate. The search endpoint returns a real array; the exact-name
   * filter is applied here because the search itself is a substring match.
   */
  private async findExistingServiceId(
    productsApi: CatalogClient['productsApi'],
    name: string,
  ): Promise<string | undefined> {
    try {
      const matches = await productsApi.searchCatalogServices({ q: name, limit: 50 });
      const exact = (Array.isArray(matches) ? matches : []).filter((service) => service.name === name);
      return this.extractEntityId(exact);
    } catch {
      return undefined;
    }
  }

  /**
   * Resolves an already-seeded product, preferring the SKU search over the
   * exact-name lookup.
   *
   * SKU is what the backend enforces uniqueness on - a create that fails with
   * "Product with sku already exists" is answered by exactly this query - and
   * the search endpoint tolerates a miss with an empty page. The by-name
   * endpoint stays as a fallback: it returns 500 on alpha (a row it cannot map
   * to a DTO), and swallowing that would leave the create loop with nothing to
   * fall back on.
   */
  private async findExistingProductId(
    productsApi: CatalogClient['productsApi'],
    product: ProductSeedDefinition,
  ): Promise<string | undefined> {
    const bySku = await this.findCatalogEntityIdByName(() =>
      productsApi.searchCatalogProducts({ sku: product.sku, limit: 1 }),
    );
    if (bySku) {
      return bySku;
    }

    return this.findCatalogEntityIdByName(async () => {
      const raw = await productsApi.listProductsByNameRaw({ name: product.name });
      return raw.raw.json();
    });
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
