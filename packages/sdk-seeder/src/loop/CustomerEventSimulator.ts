import {
  createCustomerClient,
} from '@durion-sdk/customer';
import { createInvoiceClient } from '@durion-sdk/invoice';
import { createAccountingClient } from '@durion-sdk/accounting';
import {
  AddEstimateItemRequestItemTypeEnum,
  createWorkorderClient,
} from '@durion-sdk/workorder';
import { SeederAuth } from '../SeederAuth';
import { SeederConfig } from '../SeederConfig';
import { CustomerPool } from '../support/CustomerPool';
import { ReferenceCache } from '../support/ReferenceCache';
import { SeederRandom } from '../support/SeederRandom';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type CustomerStatus = 'completed' | 'declined' | 'ignored' | 'error';

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (value !== null && typeof value === 'object') {
    return value as Record<string, unknown>;
  }
  return undefined;
};

const readString = (value: unknown, ...keys: string[]): string | undefined => {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate;
    }
  }

  return undefined;
};

const readUnknownArray = (value: unknown, ...keys: string[]): unknown[] => {
  const record = asRecord(value);
  if (!record) {
    return [];
  }

  for (const key of keys) {
    const candidate = record[key];
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
};

const readTaskId = (value: unknown): string | undefined => {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  return readString(record, 'workOrderTaskId', 'workorderTaskId', 'taskId', 'id');
};

const requireField = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
};

export class CustomerEventSimulator {
  private readonly customerClient;
  private readonly workorderClient;
  private readonly invoiceClient;
  private readonly accountingClient;
  private readonly vehiclesByParty = new Map<string, string[]>();
  private lastLoggedCustomerId: string | undefined;

  constructor(
    private readonly config: SeederConfig,
    private readonly auth: SeederAuth,
    private readonly refs: ReferenceCache,
    private readonly random: SeederRandom,
    private readonly customerPool: CustomerPool,
  ) {
    this.customerClient = createCustomerClient(this.auth.buildSdkConfig('customer'));
    this.workorderClient = createWorkorderClient(this.auth.buildSdkConfig('workorder'));
    this.invoiceClient = createInvoiceClient(this.auth.buildSdkConfig('invoice'));
    this.accountingClient = createAccountingClient(this.auth.buildSdkConfig('accounting'));
  }

  get lastCustomerId(): string | undefined {
    return this.lastLoggedCustomerId;
  }

  async simulate(dayNumber: number, customerIndex: number): Promise<CustomerStatus> {
    let partyId: string | undefined;
    let vehicleId: string | undefined;
    let estimateId: string | undefined;
    let workorderId = 'unknown';
    let firstName = 'repeat';
    let lastName = 'customer';
    let workSessionId: string | undefined;

    const serviceLineIds: string[] = [];
    const selectedServiceIds: string[] = [];

    const logStepError = (stepName: string, message: string): void => {
      console.log(`[Day ${dayNumber}] ERROR at step '${stepName}' for workorder ${workorderId}: ${message}`);
    };

    this.lastLoggedCustomerId = undefined;

    try {
      try {
        if (this.customerPool.shouldRepeat(this.random) && this.customerPool.size > 0) {
          partyId = this.customerPool.pickExisting(this.random);
        } else {
          firstName = this.random.firstName();
          lastName = this.random.lastName();
          const customer = await this.customerClient.crmAccountsApi.createCommercialAccount({
            createCommercialAccountRequest: {
              legalName: `${firstName} ${lastName}`,
              displayName: `${firstName} ${lastName}`,
              partyType: 'INDIVIDUAL',
              contactFirstName: firstName,
              contactLastName: lastName,
              email: this.random.email(firstName, lastName),
              phone: this.random.phone(),
            },
          });
          partyId = customer.partyId;
          if (partyId) {
            this.customerPool.add(partyId);
          }
        }

        partyId = requireField(partyId, 'partyId');
        this.lastLoggedCustomerId = partyId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('pickOrCreateCustomer', message);
        return 'error';
      }

      try {
        const knownVehicles = this.vehiclesByParty.get(partyId) ?? [];
        if (knownVehicles.length > 0 && this.random.chance(0.7)) {
          vehicleId = this.random.pickOne(knownVehicles);
        } else {
          const vehicle = await this.customerClient.crmVehiclesApi.createVehicles({
            customerId: partyId,
            createVehicleForPartyRequest: {
              vinNumber: this.random.vin(),
              unitNumber: `${this.random.vehicleYear()} ${this.random.vehicleMake()} ${this.random.vehicleModel()}`,
              description: `${this.random.vehicleYear()} ${this.random.vehicleMake()} ${this.random.vehicleModel()}`,
              licensePlate: this.random.licensePlate(),
              licensePlateRegion: 'TX',
            },
          });
          vehicleId = vehicle.vehicleId;
          if (vehicleId) {
            const updatedVehicles = [...knownVehicles, vehicleId];
            this.vehiclesByParty.set(partyId, updatedVehicles);
          }
        }

        vehicleId = requireField(vehicleId, 'vehicleId');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('pickOrRegisterVehicle', message);
        return 'error';
      }

      try {
        const estimateResponse = await this.workorderClient.estimateAPIApi.createEstimate({
          createEstimateRequest: {
            customerId: partyId,
            vehicleId,
            crmPartyId: partyId,
            crmVehicleId: vehicleId,
            crmContactIds: [],
            currencyUomId: 'USD',
            locationId: this.refs.locationId,
          },
        });

        estimateId = requireField(readString(estimateResponse, 'id', 'estimateId'), 'estimateId');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('createEstimate', message);
        return 'error';
      }

      try {
        const services = this.random.pickN(
          this.refs.serviceEntityIds,
          Math.min(this.random.int(2, 4), this.refs.serviceEntityIds.length),
        );
        selectedServiceIds.push(...services);
        for (const serviceId of services) {
          const estimateItem = await this.workorderClient.estimateAPIApi.addEstimateItem({
            estimateId,
            addEstimateItemRequest: {
              itemType: AddEstimateItemRequestItemTypeEnum.Labor,
              quantity: 1,
              unitPrice: Number((100 * (1 + this.random.price(-0.15, 0.15))).toFixed(2)),
              serviceId,
              description: `Service ${serviceId}`,
            },
          });
          const estimateItemId = readString(estimateItem, 'id');
          if (estimateItemId) {
            serviceLineIds.push(estimateItemId);
          }
        }

        const partCount = this.refs.productEntityIds.length === 0 ? 0 : this.random.int(0, 2);
        const products = partCount === 0
          ? []
          : this.random.pickN(this.refs.productEntityIds, Math.min(partCount, this.refs.productEntityIds.length));

        for (const productId of products) {
          await this.workorderClient.estimateAPIApi.addEstimateItem({
            estimateId,
            addEstimateItemRequest: {
              itemType: AddEstimateItemRequestItemTypeEnum.Part,
              quantity: this.random.int(1, 2),
              unitPrice: Number((40 * (1 + this.random.price(-0.15, 0.15))).toFixed(2)),
              productId,
              description: `Part ${productId}`,
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('addEstimateLines', message);
        return 'error';
      }

      try {
        await this.workorderClient.estimateAPIApi.calculateEstimateTotals({ estimateId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('calculateEstimate', message);
      }

      try {
        await this.workorderClient.estimateAPIApi.submitForApproval({ estimateId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('submitForApproval', message);
        return 'error';
      }

      try {
        if (this.random.chance(0.78)) {
          await this.workorderClient.estimateAPIApi.approveEstimate({
            estimateId,
            approveEstimateRequest: {
              customerId: partyId,
              signatureData: this.random.base64(32),
              signerName: `${firstName} ${lastName}`,
              signatureMimeType: 'image/png',
            },
          });
        } else if (this.random.chance(14 / 22)) {
          await this.workorderClient.estimateAPIApi.declineEstimate({
            estimateId,
            reason: 'Customer declined',
          });
          return 'declined';
        } else {
          return 'ignored';
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('customerDecision', message);
        return 'error';
      }

      try {
        const workorderResponse = await this.workorderClient.estimateAPIApi.promoteEstimateToWorkorder({ estimateId });
        workorderId = requireField(readString(workorderResponse, 'id', 'workorderId'), 'workorderId');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('promoteToWorkorder', message);
        return 'error';
      }

      try {
        const technicianId = this.random.pickOne(this.refs.employees.technicians);
        await this.workorderClient.technicianAssignmentAPIApi.assignTechnician({
          workorderId,
          assignTechnicianRequest: {
            technicianId,
            notes: 'Seeder assignment',
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('assignTechnician', message);
      }

      try {
        const technicianId = this.random.pickOne(this.refs.employees.technicians);
        const workorderDetails = await this.workorderClient.workOrderAPIApi.getWorkorderById({ workorderId });
        const taskCandidates = [
          ...readUnknownArray(workorderDetails, 'tasks'),
          ...readUnknownArray(workorderDetails, 'lineItems'),
          ...readUnknownArray(workorderDetails, 'items'),
        ];
        const workOrderTaskId = taskCandidates.map(readTaskId).find((value): value is string => Boolean(value));

        if (!workOrderTaskId) {
          throw new Error('No workorder task ID available on workorder payload');
        }

        const session = await this.workorderClient.workSessionAPIApi.startWorkSession({
          startWorkSessionRequest: {
            mechanicId: technicianId,
            workOrderId: workorderId,
            workOrderTaskId,
            locationId: this.refs.locationId,
            resourceId: this.refs.bayIds[0],
          },
        });
        workSessionId = session.workSessionId;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('startWorkorderWorkSession', message);
      }

      try {
        for (let index = 0; index < selectedServiceIds.length; index += 1) {
          const serviceId = selectedServiceIds[index];
          const workorderItemId = serviceLineIds[index];
          await this.workorderClient.workexecTimeTrackingAPIApi.startTimer({
            workexecTimerStartRequest: {
              workorderId,
              workorderItemId,
              laborCode: serviceId,
            },
          });
          await sleep(this.random.int(100, 500));
          await this.workorderClient.workexecTimeTrackingAPIApi.stopTimers();
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('laborLoop', message);
      }

      try {
        const pickTasks = await this.workorderClient.workorderPickFacadeApi.getPickTasks({ workorderId });
        if (pickTasks.length > 0) {
          for (const task of pickTasks) {
            if (!task.pickTaskId) {
              continue;
            }
            await this.workorderClient.workorderPickFacadeApi.completePickTask({
              workorderId,
              pickTaskId: task.pickTaskId,
              completePickTaskRequest: { reason: 'Seeder auto-complete pick' },
            });
          }

          await this.workorderClient.workorderPickedItemsApi.consumePickedItems({
            workorderId,
            consumePickedItemsRequest: {
              items: pickTasks
                .filter((task): task is typeof task & { pickTaskId: string } => Boolean(task.pickTaskId))
                .map((task) => ({
                  pickTaskId: task.pickTaskId,
                  quantityToConsume: task.pickedQty ?? task.requiredQty ?? 1,
                })),
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('pickAndConsumeParts', message);
      }

      try {
        if (this.random.chance(0.1)) {
          const changeRequest = await this.workorderClient.changeRequestAPIApi.createChangeRequest({
            workorderId,
            createChangeRequestDTO: {
              workorderId,
              description: this.random.sentence(),
              services: [{ serviceEntityId: this.random.pickOne(this.refs.serviceEntityIds) }],
            },
          });
          const changeId = readString(changeRequest, 'id', 'changeId');

          if (changeId && this.random.chance(0.85)) {
            await this.workorderClient.changeRequestAPIApi.approveChangeRequest({
              changeId,
              approveChangeRequestDTO: {
                approvalNote: 'Seeder approved change request',
              },
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('changeRequest', message);
      }

      try {
        // AWAITING_PARTS flow is intentionally deferred in this wave.
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('awaitingParts', message);
      }

      try {
        await this.workorderClient.workOrderAPIApi.completeWorkorder({
          workorderId,
          completeWorkorderRequest: {
            completionNotes: this.random.sentence(),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('completeWorkorder', message);
        return 'error';
      }

      let invoiceId: string | undefined;
      try {
        const invoiceResponse = await this.workorderClient.workOrderAPIApi.generateInvoice({ workorderId });
        invoiceId = requireField(invoiceResponse.invoiceId, 'invoiceId');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('generateInvoice', message);
        return 'error';
      }

      let invoiceTotal: number | undefined;
      try {
        const finalizedInvoice = await this.invoiceClient.invoiceApi.finalizeInvoice({
          invoiceId,
          finalizationRequest: {},
        });
        invoiceTotal = finalizedInvoice.total;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('finalizeInvoice', message);
        return 'error';
      }

      try {
        const paymentMethod = this.random.chance(0.95) ? 'CREDIT_CARD' : 'CASH';
        await this.accountingClient.accountingEventsApi.submitEvent({
          accountingEventSubmitRequest: {
            eventType: 'INVOICE_PAYMENT',
            organizationId: 'DEFAULT',
            sourceSystem: 'SDK_SEEDER',
            payload: {
              invoiceId,
              paymentMethod,
              amountPaid: invoiceTotal ?? 0,
            },
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('processPayment', message);
        // Non-fatal: continue even if payment event fails
      }

      try {
        if (workSessionId) {
          await this.workorderClient.workSessionAPIApi.stopWorkSession({
            workSessionId,
            stopWorkSessionRequest: {
              mechanicId: this.random.pickOne(this.refs.employees.technicians),
            },
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logStepError('stopWorkorderWorkSession', message);
      }

      return 'completed';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logStepError(`simulateCustomer${customerIndex}`, message);
      return 'error';
    }
  }
}
