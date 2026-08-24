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
const COMPLETABLE_ITEM_STATUSES = new Set(['OPEN', 'READY_TO_EXECUTE', 'IN_PROGRESS']);

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

const requireField = (value: string | undefined, name: string): string => {
  if (!value) {
    throw new Error(`${name} is missing`);
  }
  return value;
};

const isHttpStatus = (error: unknown, status: number): boolean => {
  const rec = asRecord(error);
  if (!rec) return false;
  const response = asRecord(rec['response']);
  if (!response) return false;
  return response['status'] === status;
};

const formatError = async (error: unknown): Promise<string> => {
  if (
    error !== null &&
    typeof error === 'object' &&
    'response' in error &&
    (error as { response: unknown }).response !== null &&
    typeof (error as { response: unknown }).response === 'object'
  ) {
    const response = (error as { response: { status?: unknown; text?: unknown } }).response;
    const status = typeof response.status === 'number' ? response.status : '?';
    if (typeof response.text === 'function') {
      try {
        const body = await (response.text as () => Promise<string>)();
        return `HTTP ${status}: ${body}`;
      } catch {
        return `HTTP ${status}: (could not read body)`;
      }
    }
    return `HTTP ${status}`;
  }
  return error instanceof Error ? error.message : String(error);
};

export class CustomerEventSimulator {
  private readonly customerClient;
  private readonly workorderClient;
  private readonly invoiceClient;
  private readonly accountingClient;
  private readonly vehiclesByParty = new Map<string, string[]>();
  private lastLoggedCustomerId: string | undefined;
  private lastLoggedCustomerName: string | undefined;

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

  get lastCustomerName(): string | undefined {
    return this.lastLoggedCustomerName;
  }

  private async completeOutstandingWorkorderItems(dayNumber: number, workorderId: string): Promise<void> {
    const workorderDetails = await this.workorderClient.workorderDetailApi.getWorkorderDetail({ workorderId });

    let attempted = 0;
    let completed = 0;

    for (const service of workorderDetails.services ?? []) {
      if (!service.id || !service.status || !COMPLETABLE_ITEM_STATUSES.has(service.status)) {
        continue;
      }

      attempted += 1;
      const status = await this.postWorkorderItemCompletion(
        `/v1/workorders/${encodeURIComponent(workorderId)}/services/${encodeURIComponent(service.id)}/complete`,
      );
      if (status === 200 || status === 204) {
        completed += 1;
      }
    }

    for (const part of workorderDetails.parts ?? []) {
      if (!part.id || !part.status || !COMPLETABLE_ITEM_STATUSES.has(part.status)) {
        continue;
      }

      attempted += 1;
      const status = await this.postWorkorderItemCompletion(
        `/v1/workorders/${encodeURIComponent(workorderId)}/parts/${encodeURIComponent(part.id)}/complete`,
      );
      if (status === 200 || status === 204) {
        completed += 1;
      }
    }

    if (attempted > 0) {
      console.log(
        `[Day ${dayNumber}] Item completion pass for workorder ${workorderId}: attempted=${attempted}, completed=${completed}`,
      );
    }
  }

  private async postWorkorderItemCompletion(path: string): Promise<number> {
    const response = await fetch(`${this.config.baseUrl}/workorder${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.getToken()}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 200 || response.status === 204) {
      return response.status;
    }

    if (response.status === 400 || response.status === 404) {
      let responseBody = '';
      try {
        responseBody = await response.text();
      } catch {
        responseBody = '(could not read body)';
      }
      console.log(
        `[Seeder] Item completion skipped (${response.status}) for ${path}: ${responseBody || '(empty body)'}`,
      );
      return response.status;
    }

    let responseBody = '';
    try {
      responseBody = await response.text();
    } catch {
      responseBody = '(could not read body)';
    }

    throw new Error(`Item completion request failed with HTTP ${response.status}: ${responseBody}`);
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

    const logStepError = async (stepName: string, error: unknown): Promise<void> => {
      const message = await formatError(error);
      console.log(`[Day ${dayNumber}] ERROR at step '${stepName}' for workorder ${workorderId}: ${message}`);
    };

    this.lastLoggedCustomerId = undefined;
    this.lastLoggedCustomerName = undefined;

    try {
      try {
        if (this.customerPool.shouldRepeat(this.random) && this.customerPool.size > 0) {
          partyId = this.customerPool.pickExisting(this.random);
        } else {
          firstName = this.random.firstName();
          lastName = this.random.lastName();
          const customer = await this.customerClient.crmAccountsApi.createCrmCommercialAccount({
            createCommercialAccountRequest: {
              legalName: `${firstName} ${lastName}`,
              displayName: `${firstName} ${lastName}`,
              partyType: 'PERSON',
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
        this.lastLoggedCustomerName = `${firstName} ${lastName}`;
      } catch (error) {
        await logStepError('pickOrCreateCustomer', error);
        return 'error';
      }

      try {
        const knownVehicles = this.vehiclesByParty.get(partyId) ?? [];
        if (knownVehicles.length > 0 && this.random.chance(0.7)) {
          vehicleId = this.random.pickOne(knownVehicles);
        } else {
          const vehicle = await this.customerClient.crmAccountsApi.createVehicleForParty({
            partyId,
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
        await logStepError('pickOrRegisterVehicle', error);
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
        await logStepError('createEstimate', error);
        return 'error';
      }

      try {
        const services = this.random.pickN(
          this.refs.serviceEntityIds,
          Math.min(this.random.int(2, 4), this.refs.serviceEntityIds.length),
        );
        selectedServiceIds.push(...services);
        for (const serviceId of services) {
          const serviceName = this.refs.serviceNameById.get(serviceId) ?? serviceId;
          const estimateItem = await this.workorderClient.estimateAPIApi.addEstimateItem({
            estimateId,
            addEstimateItemRequest: {
              itemType: AddEstimateItemRequestItemTypeEnum.Labor,
              quantity: 1,
              unitPrice: Number((100 * (1 + this.random.price(-0.15, 0.15))).toFixed(2)),
              serviceId,
              description: serviceName,
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
          const productName = this.refs.productNameById.get(productId) ?? productId;
          await this.workorderClient.estimateAPIApi.addEstimateItem({
            estimateId,
            addEstimateItemRequest: {
              itemType: AddEstimateItemRequestItemTypeEnum.Part,
              quantity: this.random.int(1, 2),
              unitPrice: Number((40 * (1 + this.random.price(-0.15, 0.15))).toFixed(2)),
              productId,
              description: productName,
            },
          });
        }
      } catch (error) {
        await logStepError('addEstimateLines', error);
        return 'error';
      }

      try {
        await this.workorderClient.estimateAPIApi.calculateEstimateTotals({ estimateId });
      } catch (error) {
        await logStepError('calculateEstimate', error);
      }

      try {
        await this.workorderClient.estimateAPIApi.submitEstimateForApproval({ estimateId });
      } catch (error) {
        await logStepError('submitForApproval', error);
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
        await logStepError('customerDecision', error);
        return 'error';
      }

      const serviceToWorkorderItemMap = new Map<string, string>();

      try {
        const workorderResponse = await this.workorderClient.estimateAPIApi.promoteEstimate({ estimateId });
        workorderId = requireField(readString(workorderResponse, 'id', 'workorderId'), 'workorderId');

        // Build mapping from serviceEntityId to workorder item ID via detail endpoint
        const workorderDetails = await this.workorderClient.workorderDetailApi.getWorkorderDetail({ workorderId });
        for (const service of workorderDetails.services ?? []) {
          if (service.id && service.serviceEntityId) {
            serviceToWorkorderItemMap.set(service.serviceEntityId, service.id);
          }
        }
      } catch (error) {
        await logStepError('promoteToWorkorder', error);
        return 'error';
      }

      try {
        await this.workorderClient.workOrderAPIApi.approveWorkorder({
          workorderId,
          approveWorkorderRequest: {
            customerId: partyId,
            signatureData: this.random.base64(32),
            signatureMimeType: 'image/png',
            signerName: `${firstName} ${lastName}`,
            notes: 'Seeder approval',
          },
        });
      } catch (error) {
        await logStepError('approveWorkorder', error);
        return 'error';
      }

      try {
        await this.workorderClient.operationalContextApi.startWorkorder({
          workorderId,
        });
      } catch (error) {
        await logStepError('startWorkorderWorkSession', error);
      }

      // assignTechnician is called AFTER the timer loop intentionally.
      // stopTimers always targets the authenticated user (admin.alpha) from the JWT.
      // startTimer, when no technicianId is in the request, attributes labor to the currently
      // assigned technician — creating a mismatch where stop can never reach that timer.
      // With no assignment present during the loop, the backend falls back to the actor
      // (admin.alpha), keeping start and stop on the same identity.

      for (let index = 0; index < selectedServiceIds.length; index += 1) {
        const serviceId = selectedServiceIds[index];
        const serviceName = this.refs.serviceNameById.get(serviceId) ?? serviceId;
        const workorderItemId = serviceToWorkorderItemMap.get(serviceId);
        if (!workorderItemId) {
          console.log(`[Day ${dayNumber}] WARNING: No workorder item found for service ${serviceName}, skipping timer`);
          continue;
        }

        try {
          await this.workorderClient.workexecTimeTrackingAPIApi.stopTimers();
        } catch {
          // No active timer is common here; continue to start attempt.
        }

        let timerStarted = false;
        try {
          await this.workorderClient.workexecTimeTrackingAPIApi.startTimer({
            workexecTimerStartRequest: {
              workorderId,
              workorderItemId,
              laborCode: serviceId,
            },
          });
          timerStarted = true;
        } catch (startError) {
          if (isHttpStatus(startError, 409)) {
            try {
              await this.workorderClient.workexecTimeTrackingAPIApi.stopTimers();
              await this.workorderClient.workexecTimeTrackingAPIApi.startTimer({
                workexecTimerStartRequest: {
                  workorderId,
                  workorderItemId,
                  laborCode: serviceId,
                },
              });
              timerStarted = true;
              console.log(
                `[Day ${dayNumber}] WARNING: recovered from active timer conflict for service ${serviceName} (workorder ${workorderId}).`,
              );
            } catch (retryError) {
              const retryMessage = await formatError(retryError);
              console.log(
                `[Day ${dayNumber}] WARNING: could not recover timer for service ${serviceName} (workorder ${workorderId}): ${retryMessage}`,
              );
            }
          } else {
            const startMessage = await formatError(startError);
            console.log(
              `[Day ${dayNumber}] WARNING: startTimer failed for service ${serviceName} (workorder ${workorderId}): ${startMessage}`,
            );
          }
        }

        if (!timerStarted) {
          continue;
        }

        await sleep(this.random.int(100, 500));
        try {
          await this.workorderClient.workexecTimeTrackingAPIApi.stopTimers();
        } catch (postStopError) {
          const postStopMsg = await formatError(postStopError);
          console.log(`[Day ${dayNumber}] WARNING: post-stop failed after service ${serviceName} timer (workorder ${workorderId}): ${postStopMsg}`);
        }
      }

      try {
        const technicianId = this.random.pickOne(this.refs.employees.technicians);
        const technicianName = this.refs.employeeNameById.get(technicianId) ?? technicianId;
        await this.workorderClient.technicianAssignmentAPIApi.assignTechnician({
          workorderId,
          assignTechnicianRequest: {
            technicianId,
            notes: `Assigned by seeder to ${technicianName}`,
          },
        });
      } catch (error) {
        await logStepError('assignTechnician', error);
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

          await this.workorderClient.workorderPickedItemsApi.consumeWorkorderPickedItems({
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
        if (!isHttpStatus(error, 404)) {
          await logStepError('pickAndConsumeParts', error);
        }
        // 404 = no pick list exists for this workorder (no product items were added); skip silently
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
        await logStepError('changeRequest', error);
      }

      try {
        // AWAITING_PARTS flow is intentionally deferred in this wave.
      } catch (error) {
        await logStepError('awaitingParts', error);
      }

      try {
        await this.completeOutstandingWorkorderItems(dayNumber, workorderId);
      } catch (error) {
        await logStepError('completeOutstandingItems', error);
      }

      try {
        await this.workorderClient.workOrderAPIApi.completeWorkorder({
          workorderId,
          completeWorkorderRequest: {
            completionNotes: this.random.sentence(),
          },
        });
      } catch (error) {
        await logStepError('completeWorkorder', error);
        return 'error';
      }

      let invoiceId: string | undefined;
      try {
        const invoiceResponse = await this.workorderClient.workOrderAPIApi.generateWorkorderInvoice({ workorderId });
        invoiceId = requireField(invoiceResponse.invoiceId, 'invoiceId');
      } catch (error) {
        await logStepError('generateInvoice', error);
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
        await logStepError('finalizeInvoice', error);
        return 'error';
      }

      try {
        const paymentMethod = this.random.chance(0.95) ? 'CREDIT_CARD' : 'CASH';
        await this.accountingClient.accountingEventsApi.submitAccountingEvent({
          accountingEventSubmitRequest: {
            eventType: 'INVOICE_PAYMENT',
            organizationId: this.refs.locationId,
            sourceSystem: 'SDK_SEEDER',
            payload: {
              invoiceId,
              paymentMethod,
              amountPaid: invoiceTotal ?? 0,
            },
          },
        });
      } catch (error) {
        await logStepError('processPayment', error);
        // Non-fatal: continue even if payment event fails
      }

      try {
        if (workSessionId) {
          await this.workorderClient.workSessionAPIApi.stopWorkexecWorkSession({
            workSessionId,
            stopWorkSessionRequest: {
              mechanicId: this.random.pickOne(this.refs.employees.technicians),
            },
          });
        }
      } catch (error) {
        await logStepError('stopWorkorderWorkSession', error);
      }

      return 'completed';
    } catch (error) {
      await logStepError(`simulateCustomer${customerIndex}`, error);
      return 'error';
    }
  }
}
