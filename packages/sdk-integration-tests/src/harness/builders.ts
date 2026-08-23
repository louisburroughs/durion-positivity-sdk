import { AddEstimateItemRequestItemTypeEnum } from '@durion-sdk/workorder';
import type { ReferenceCache, SeederRandom } from '@durion-sdk/seeder';
import { call } from './http';
import type { DomainClients } from './personas';

/**
 * Thin, assertive wrappers around the SDK calls the suites repeat. Field
 * shapes mirror the seeder's CustomerEventSimulator /
 * InventoryMaintenanceSimulator exactly — those shapes are backend-proven.
 * Every builder takes the acting persona's clients as its first argument so
 * the persona declaration is visible at the call site; each throws on a
 * missing id instead of limping on.
 */

export interface BuilderContext {
  runId: string;
  random: SeederRandom;
  refs: ReferenceCache;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

export const readString = (value: unknown, ...keys: string[]): string | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
};

/**
 * Numeric counterpart to readString. Several generated operations declare their
 * response as a bare `object` (calculateEstimateTotals among them), so the
 * fields have to be read defensively rather than through a model.
 */
export const readNumber = (value: unknown, ...keys: string[]): number | undefined => {
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }
  }
  return undefined;
};

export const requireField = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`${name} is missing from the response`);
  }
  return value;
};

/**
 * A stable numeric seed derived from the runId, so a suite's generated data is
 * reproducible within a run and different between runs. A fixed literal seed
 * would regenerate the same person on every run and collide on the unique
 * email.
 */
export function seedFromRunId(runId: string): number {
  let hash = 0;
  for (const char of runId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 2_147_483_647;
  }
  return hash;
}

/**
 * Distinguishes accounts created within one run. The generated name pool is
 * small enough that two customers in the same suite can draw the same first and
 * last name, and the email is unique per account in CRM — so the runId alone
 * is not enough to keep them apart.
 */
let accountSequence = 0;

export interface CreatedCustomer {
  partyId: string;
  firstName: string;
  lastName: string;
  fullName: string;
}

export async function createPersonAccount(
  as: DomainClients,
  ctx: BuilderContext,
): Promise<CreatedCustomer> {
  const firstName = ctx.random.firstName();
  const lastName = ctx.random.lastName();
  // The email carries the runId: it is unique per account in CRM, and a
  // generated address without it collides the moment a suite runs twice.
  accountSequence += 1;
  const email = `${firstName}.${lastName}.${ctx.runId}-${accountSequence}@itest.invalid`.toLowerCase();
  const customer = await call('createCrmCommercialAccount', () =>
    as.customer.crmAccountsApi.createCrmCommercialAccount({
    createCommercialAccountRequest: {
      legalName: `${firstName} ${lastName}`,
      displayName: `${firstName} ${lastName} [${ctx.runId}]`,
      partyType: 'PERSON',
      contactFirstName: firstName,
      contactLastName: lastName,
      email,
      phone: ctx.random.phone(),
    },
    }),
  );
  return {
    partyId: requireField(customer.partyId, 'partyId'),
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
  };
}

/**
 * Registers a vehicle and returns its id.
 *
 * Deliberately not `crmAccountsApi.createVehicleForParty`, which the name
 * suggests: that endpoint appends the VIN to the party's `vehicleVins` list and
 * returns `{partyId, vinNumber, status}` — no vehicle record, and no id, even
 * though its response model declares `vehicleId` as required. pos-customer
 * serves vehicle reads from an `ext_vehicle` replica; the aggregate itself
 * lives in pos-vehicle-inventory, which is what this registers against.
 * Tracked as durion-positivity-backend#1466.
 */
export async function createVehicle(
  as: DomainClients,
  ctx: BuilderContext,
  partyId: string,
): Promise<string> {
  const year = ctx.random.vehicleYear();
  const make = ctx.random.vehicleMake();
  const model = ctx.random.vehicleModel();
  const vehicle = await call('createVehicle', () =>
    as.vehicleInventory.vehicleRegistryApi.createVehicle({
    createVehicleRequest: {
      accountId: partyId,
      vin: ctx.random.vin(),
      unitNumber: `${year} ${make} ${model}`,
      description: `${year} ${make} ${model} [${ctx.runId}]`,
      licensePlate: ctx.random.licensePlate(),
      licensePlateJurisdiction: 'TX',
      make,
      model,
      year,
    },
    }),
  );
  return requireField(vehicle.vehicleId, 'vehicleId');
}

export async function createDraftEstimate(
  as: DomainClients,
  ctx: BuilderContext,
  partyId: string,
  vehicleId: string,
): Promise<string> {
  const estimate = await as.workorder.estimateAPIApi.createEstimate({
    createEstimateRequest: {
      customerId: partyId,
      vehicleId,
      crmPartyId: partyId,
      crmVehicleId: vehicleId,
      crmContactIds: [],
      currencyUomId: 'USD',
      locationId: ctx.refs.locationId,
    },
  });
  return requireField(readString(estimate, 'id', 'estimateId'), 'estimateId');
}

export async function addLaborLine(
  as: DomainClients,
  ctx: BuilderContext,
  estimateId: string,
  serviceId: string,
  unitPrice: number,
): Promise<string> {
  const item = await as.workorder.estimateAPIApi.addEstimateItem({
    estimateId,
    addEstimateItemRequest: {
      itemType: AddEstimateItemRequestItemTypeEnum.Labor,
      quantity: 1,
      unitPrice,
      serviceId,
      description: `${ctx.refs.serviceNameById.get(serviceId) ?? serviceId} [${ctx.runId}]`,
    },
  });
  return requireField(readString(item, 'id'), 'estimate labor line id');
}

export async function addPartLine(
  as: DomainClients,
  ctx: BuilderContext,
  estimateId: string,
  productId: string,
  quantity: number,
  unitPrice: number,
): Promise<string | undefined> {
  const item = await as.workorder.estimateAPIApi.addEstimateItem({
    estimateId,
    addEstimateItemRequest: {
      itemType: AddEstimateItemRequestItemTypeEnum.Part,
      quantity,
      unitPrice,
      productId,
      description: `${ctx.refs.productNameById.get(productId) ?? productId} [${ctx.runId}]`,
    },
  });
  return readString(item, 'id');
}

export interface PromotedWorkorder {
  workorderId: string;
  /** serviceEntityId → workorder service-item id */
  serviceItemMap: Map<string, string>;
}

/**
 * Submit → approve (customer signature) → promote. The submitting and
 * approving persona is the advisor; the signature records the customer.
 */
export async function approveAndPromote(
  as: DomainClients,
  ctx: BuilderContext,
  estimateId: string,
  customer: { partyId: string; fullName: string },
): Promise<PromotedWorkorder> {
  await as.workorder.estimateAPIApi.calculateEstimateTotals({ estimateId });
  await as.workorder.estimateAPIApi.submitEstimateForApproval({ estimateId });
  await as.workorder.estimateAPIApi.approveEstimate({
    estimateId,
    approveEstimateRequest: {
      customerId: customer.partyId,
      signatureData: ctx.random.base64(32),
      signerName: customer.fullName,
      signatureMimeType: 'image/png',
    },
  });

  const promoted = await as.workorder.estimateAPIApi.promoteEstimate({ estimateId });
  const workorderId = requireField(readString(promoted, 'id', 'workorderId'), 'workorderId');

  const detail = await as.workorder.workorderDetailApi.getWorkorderDetail({ workorderId });
  const serviceItemMap = new Map<string, string>();
  for (const service of detail.services ?? []) {
    if (service.id && service.serviceEntityId) {
      serviceItemMap.set(service.serviceEntityId, service.id);
    }
  }
  return { workorderId, serviceItemMap };
}

export interface CreatedProduct {
  productEntityId: string;
  sku: string;
  name: string;
}

/**
 * A brand-new catalog product, suffixed with the runId so every run gets its
 * own SKU and the record is traceable back to the run that made it. Shape
 * mirrors CatalogBootstrap's, which is backend-proven.
 */
export async function createCatalogProduct(
  as: DomainClients,
  ctx: BuilderContext,
  suffix: string,
): Promise<CreatedProduct> {
  const sku = `ITEST-${suffix}-${ctx.runId}`.toUpperCase();
  const name = `Integration test part ${suffix} [${ctx.runId}]`;
  const created = await as.catalog.productsApi.createProduct({
    productCreateRequestDto: {
      name,
      description: `${name}, created by the integration suite.`,
      unitOfMeasure: 'EA',
      sku,
      mpn: `MPN-${suffix}-${ctx.runId}`.toUpperCase(),
      attributes: JSON.stringify({ seededBy: 'sdk-itest', runId: ctx.runId }),
    },
  });
  return {
    productEntityId: requireField(readString(created, 'id', 'productId'), 'productEntityId'),
    sku,
    name,
  };
}

export interface CreatedPo {
  purchaseOrderId: string;
  lines: Array<{ poLineId: string | undefined; skuId: string; quantity: number; unitCostMinor: number }>;
}

/**
 * PO creation (parts persona) and approval (manager persona) — the two
 * halves of the seeded separation of duties, so the builder takes both.
 */
export async function createApprovedPo(
  asParts: DomainClients,
  asManager: DomainClients,
  ctx: BuilderContext,
  vendorId: string,
  products: Array<{ skuId: string; quantity: number; unitCostMinor: number }>,
): Promise<CreatedPo> {
  const po = await asParts.order.purchaseOrdersApi.createPurchaseOrder({
    createPurchaseOrderRequest: {
      vendorId,
      poDate: new Date(),
      currency: 'USD',
      shipToLocationId: ctx.refs.locationId,
      requestedBy: ctx.refs.employees.partsClerk,
      comment: `Integration test restock [${ctx.runId}]`,
      lines: products.map((product, index) => ({
        lineNumber: index + 1,
        skuId: product.skuId,
        description: `Restock ${product.skuId} [${ctx.runId}]`,
        quantity: product.quantity,
        unitCostMinor: product.unitCostMinor,
      })),
    },
  });
  const purchaseOrderId = requireField(po.purchaseOrderId, 'purchaseOrderId');

  await asManager.order.purchaseOrdersApi.approvePurchaseOrder({
    poId: purchaseOrderId,
    approvePurchaseOrderRequest: {
      approvalNotes: `Integration test approval [${ctx.runId}]`,
    },
  });

  const poLines = po.lines ?? [];
  return {
    purchaseOrderId,
    lines: products.map((product, index) => ({
      poLineId: readString(poLines[index], 'poLineId', 'lineId', 'id'),
      skuId: product.skuId,
      quantity: product.quantity,
      unitCostMinor: product.unitCostMinor,
    })),
  };
}

export async function createAsnForPo(
  as: DomainClients,
  ctx: BuilderContext,
  vendorId: string,
  po: CreatedPo,
): Promise<string> {
  const now = new Date();
  const asn = await as.inventory.asnApi.createAsn({
    createAsnRequest: {
      vendorId,
      asnReferenceNumber: `ASN-${ctx.runId}-${po.purchaseOrderId.slice(0, 8)}`,
      relatedPoIds: [po.purchaseOrderId],
      shipDate: now,
      expectedArrivalDate: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000),
      lineItems: po.lines.map((line) => ({
        poId: po.purchaseOrderId,
        poLineId: line.poLineId,
        sku: line.skuId,
        quantityShipped: line.quantity,
        unitCostMinor: line.unitCostMinor,
      })),
    },
  });
  return requireField(asn.asnId, 'asnId');
}
