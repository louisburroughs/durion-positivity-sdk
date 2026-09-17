/**
 * One customer's work, advanced a step at a time.
 *
 * The non-accelerated suites run a lifecycle straight through, because nothing
 * stops them mid-way. An accelerated run cannot: the shop closes. At scale 1,460
 * a ten-hour open window is 25 real seconds and a full lifecycle is 20-25 gateway
 * calls, so a job that insisted on finishing in one window would either overrun
 * into the night — breaking the rule that nobody works after hours — or be
 * abandoned half-done.
 *
 * So a job is a *step machine*. The day runner advances it one step at a time and
 * only while the shop is open for that job's kind of position; when the window
 * closes the job simply stops where it is, keeps its bay and its mechanic, and
 * resumes the next open morning. A repair spanning several days is what a real
 * shop looks like, and it is what lets a fast clock still produce finished,
 * invoiced, paid work.
 *
 * Mobile-unit jobs are never gated (see ShopCalendar), so they are what keeps a
 * virtual weekend productive.
 *
 * Every step asserts. This is the difference between this and the seeder: a step
 * that fails fails the job, and a job that fails fails the run's day.
 */
import type { ReferenceCache, SeederRandom } from '@durion-sdk/seeder';
import { AssignServicePositionRequestResourceTypeEnum as ResourceType } from '@durion-sdk/workorder';
import {
  addLaborLine,
  addPartLine,
  createDraftEstimate,
  createPersonAccount,
  createVehicle,
  promoteWhenPromotable,
  readNumber,
  readString,
  requireField,
  type BuilderContext,
  type CreatedCustomer,
} from './builders';
import { call, formatError, isHttpStatus, retryWhileReplicating } from './http';
import type { Mutex } from './mutex';
import type { DomainClients } from './personas';
import type { Claim } from './resourceLedger';
import type { PositionKind } from '../runs/shopFloorPlan';

export type JobOutcome = 'in-progress' | 'completed' | 'declined' | 'failed';

/** The personas one job acts as. Same set the non-accelerated suites declare. */
export interface JobPersonas {
  admin: DomainClients;
  advisor: DomainClients;
  manager: DomainClients;
  tech: DomainClients;
  controller: DomainClients;
}

export interface JobDeps {
  as: JobPersonas;
  ctx: BuilderContext;
  claim: Claim;
  /** Authoritative virtual time, for the record a step leaves behind. */
  now: () => Promise<Date>;
  /**
   * Held across startTimer → stopTimers. The timer API is scoped to the calling
   * user, not the workorder, so parallel jobs sharing one technician login would
   * stop each other's timers. See Mutex.
   */
  timerLock: Mutex;
  /** Leaves this job's invoice unpaid, for AR aging (ITEST_ACCEL_UNPAID_RATIO). */
  leaveUnpaid?: boolean;
  /** Customer decision odds, mirroring the seeder's distribution. */
  approveChance?: number;
  declineChance?: number;
}

/** A virtual instant a transition was observed at — the journal's evidence. */
export interface JobMark {
  phase: string;
  at: Date;
}

interface Step {
  name: string;
  run: () => Promise<Step[] | void>;
}

const LABOR_PRICE = 95;
const PART_PRICE = 40;
const COMPLETABLE = new Set(['OPEN', 'READY_TO_EXECUTE', 'IN_PROGRESS']);

export class AcceleratedJob {
  private readonly steps: Step[] = [];
  private cursor = 0;
  private result: JobOutcome = 'in-progress';
  private failureDetail: string | undefined;

  private customer: CreatedCustomer | undefined;
  private vehicleId: string | undefined;
  private estimateId: string | undefined;
  private serviceIds: string[] = [];
  private productIds: string[] = [];
  private serviceItemMap = new Map<string, string>();

  readonly marks: JobMark[] = [];
  workorderId: string | undefined;
  invoiceId: string | undefined;
  invoiceTotal: number | undefined;
  paid = false;

  constructor(
    readonly label: string,
    private readonly deps: JobDeps,
  ) {
    const { ctx } = deps;
    const refs = ctx.refs;

    this.serviceIds = ctx.random.pickN(
      refs.serviceEntityIds,
      Math.min(ctx.random.int(2, 4), refs.serviceEntityIds.length),
    );
    const partCount = refs.productEntityIds.length === 0 ? 0 : ctx.random.int(0, 2);
    this.productIds =
      partCount === 0 ? [] : ctx.random.pickN(refs.productEntityIds, Math.min(partCount, refs.productEntityIds.length));

    this.steps.push(
      { name: 'customer', run: () => this.createCustomer() },
      { name: 'vehicle', run: () => this.createVehicle() },
      { name: 'estimate', run: () => this.createEstimate() },
      // One step per line: a step is the unit the day runner can fit inside a
      // closing window, so a step that looped over every line would be the one
      // that overruns.
      ...this.serviceIds.map((serviceId, index) => ({
        name: `labor-line-${index + 1}`,
        run: () => this.addLabor(serviceId),
      })),
      ...this.productIds.map((productId, index) => ({
        name: `part-line-${index + 1}`,
        run: () => this.addPart(productId),
      })),
      { name: 'submit', run: () => this.submitEstimate() },
      { name: 'decide', run: () => this.customerDecision() },
      { name: 'promote', run: () => this.promote() },
      { name: 'approve-workorder', run: () => this.approveWorkorder() },
      { name: 'assign-technician', run: () => this.assignTechnician() },
      { name: 'assign-position', run: () => this.assignPosition() },
      { name: 'start', run: () => this.startWork() },
      { name: 'labor', run: () => this.planLabor() },
      { name: 'complete-items', run: () => this.completeItems() },
      { name: 'complete', run: () => this.completeWorkorder() },
      { name: 'invoice', run: () => this.generateInvoice() },
      { name: 'finalize', run: () => this.finalizeInvoice() },
      { name: 'pay', run: () => this.payInvoice() },
    );
  }

  get kind(): PositionKind {
    return this.deps.claim.position.kind;
  }

  /** True while the shop's hours constrain this job — a bay, never a mobile unit. */
  get gatedByHours(): boolean {
    return this.kind === 'BAY';
  }

  get outcome(): JobOutcome {
    return this.result;
  }

  get failure(): string | undefined {
    return this.failureDetail;
  }

  /** The step that will run next, for logs and for a carried job's report. */
  get nextStep(): string {
    return this.steps[this.cursor]?.name ?? 'done';
  }

  get stepsRemaining(): number {
    return Math.max(0, this.steps.length - this.cursor);
  }

  /**
   * Runs exactly one step.
   *
   * One step, not "as many as fit": the caller owns the clock, and a job that
   * decided for itself how long to keep going is a job that works after closing
   * time. A failure is recorded on the job rather than thrown, because one
   * customer's work going wrong should not abandon the other bays mid-day — the
   * day reports it and carries on.
   */
  async advance(): Promise<JobOutcome> {
    if (this.result !== 'in-progress') {
      return this.result;
    }
    const step = this.steps[this.cursor];
    if (!step) {
      this.result = 'completed';
      return this.result;
    }

    try {
      const inserted = await step.run();
      this.cursor += 1;
      if (inserted && inserted.length > 0) {
        this.steps.splice(this.cursor, 0, ...inserted);
      }
    } catch (error) {
      this.failureDetail = `${this.label} failed at step '${step.name}': ${await formatError(error)}`;
      this.result = 'failed';
      return this.result;
    }

    if (this.result === 'in-progress' && this.cursor >= this.steps.length) {
      this.result = 'completed';
    }
    return this.result;
  }

  private async mark(phase: string): Promise<void> {
    this.marks.push({ phase, at: await this.deps.now() });
  }

  private async createCustomer(): Promise<void> {
    this.customer = await createPersonAccount(this.deps.as.advisor, this.deps.ctx);
  }

  private async createVehicle(): Promise<void> {
    this.vehicleId = await createVehicle(this.deps.as.admin, this.deps.ctx, this.requireCustomer().partyId);
  }

  private async createEstimate(): Promise<void> {
    this.estimateId = await createDraftEstimate(
      this.deps.as.advisor,
      this.deps.ctx,
      this.requireCustomer().partyId,
      requireField(this.vehicleId, 'vehicleId'),
    );
  }

  private async addLabor(serviceId: string): Promise<void> {
    await addLaborLine(
      this.deps.as.advisor,
      this.deps.ctx,
      requireField(this.estimateId, 'estimateId'),
      serviceId,
      Number((LABOR_PRICE * (1 + this.deps.ctx.random.price(-0.15, 0.15))).toFixed(2)),
    );
  }

  private async addPart(productId: string): Promise<void> {
    await addPartLine(
      this.deps.as.advisor,
      this.deps.ctx,
      requireField(this.estimateId, 'estimateId'),
      productId,
      this.deps.ctx.random.int(1, 2),
      Number((PART_PRICE * (1 + this.deps.ctx.random.price(-0.15, 0.15))).toFixed(2)),
    );
  }

  private async submitEstimate(): Promise<void> {
    const estimateId = requireField(this.estimateId, 'estimateId');
    await call('calculateEstimateTotals', () =>
      this.deps.as.advisor.workorder.estimateAPIApi.calculateEstimateTotals({ estimateId }),
    );
    await call('submitEstimateForApproval', () =>
      this.deps.as.advisor.workorder.estimateAPIApi.submitEstimateForApproval({ estimateId }),
    );
  }

  /**
   * The customer says yes, no, or nothing — the seeder's distribution (78 % / 14 %
   * / the rest), because a year in which every estimate is approved produces a
   * ledger no real shop would recognise and no declined-estimate history at all.
   */
  private async customerDecision(): Promise<void> {
    const estimateId = requireField(this.estimateId, 'estimateId');
    const customer = this.requireCustomer();
    const approveChance = this.deps.approveChance ?? 0.78;
    const declineChance = this.deps.declineChance ?? 14 / 22;

    if (this.deps.ctx.random.chance(approveChance)) {
      await call('approveEstimate', () =>
        this.deps.as.advisor.workorder.estimateAPIApi.approveEstimate({
          estimateId,
          approveEstimateRequest: {
            customerId: customer.partyId,
            signatureData: this.deps.ctx.random.base64(32),
            signerName: customer.fullName,
            signatureMimeType: 'image/png',
          },
        }),
      );
      await this.mark('estimate-approved');
      return;
    }

    if (this.deps.ctx.random.chance(declineChance)) {
      await call('declineEstimate', () =>
        this.deps.as.advisor.workorder.estimateAPIApi.declineEstimate({
          estimateId,
          reason: `Customer declined [${this.deps.ctx.runId}]`,
        }),
      );
      await this.mark('estimate-declined');
    } else {
      // Left open on purpose: an estimate nobody ever answered is a state the
      // year should contain, and it is not a failure.
      await this.mark('estimate-ignored');
    }
    this.result = 'declined';
  }

  private async promote(): Promise<void> {
    const estimateId = requireField(this.estimateId, 'estimateId');
    const promoted = await promoteWhenPromotable(this.deps.as.advisor, estimateId);
    this.workorderId = requireField(readString(promoted, 'id', 'workorderId'), 'workorderId');

    const detail = await call('getWorkorderDetail', () =>
      this.deps.as.advisor.workorder.workorderDetailApi.getWorkorderDetail({ workorderId: this.workorderId as string }),
    );
    for (const service of detail.services ?? []) {
      if (service.id && service.serviceEntityId) {
        this.serviceItemMap.set(service.serviceEntityId, service.id);
      }
    }
    await this.mark('promoted');
  }

  private async approveWorkorder(): Promise<void> {
    const customer = this.requireCustomer();
    await call('approveWorkorder', () =>
      this.deps.as.manager.workorder.workOrderAPIApi.approveWorkorder({
        workorderId: this.requireWorkorder(),
        approveWorkorderRequest: {
          customerId: customer.partyId,
          signatureData: this.deps.ctx.random.base64(32),
          signerName: customer.fullName,
          signatureMimeType: 'image/png',
          notes: `Accelerated run approval [${this.deps.ctx.runId}]`,
        },
      }),
    );
  }

  /**
   * The mechanic, then the position, in that order: a workorder needs both before
   * it will start (backend #2010, #2011). Both are already claimed in the
   * ledger, so neither call can be the one that double-books.
   */
  private async assignTechnician(): Promise<void> {
    await call('assignTechnician', () =>
      this.deps.as.manager.workorder.technicianAssignmentAPIApi.assignTechnician({
        workorderId: this.requireWorkorder(),
        assignTechnicianRequest: {
          technicianId: this.deps.claim.technicianId,
          notes: `Accelerated run [${this.deps.ctx.runId}]`,
        },
      }),
    );
  }

  private async assignPosition(): Promise<void> {
    const position = this.deps.claim.position;
    // pos-workorder validates the resource against its Kafka-fed replicas of the
    // location domain, so a bay or unit can still be unknown there.
    await retryWhileReplicating(
      () =>
        this.deps.as.manager.workorder.servicePositionAPIApi.assignServicePosition({
          workorderId: this.requireWorkorder(),
          assignServicePositionRequest: {
            resourceType: position.kind === 'BAY' ? ResourceType.Bay : ResourceType.MobileUnit,
            resourceId: position.id,
            reason: `Accelerated run [${this.deps.ctx.runId}]`,
          },
        }),
      {
        markers: ['Unknown bay', 'Unknown mobile unit'],
        description: `assignServicePosition -> ${position.kind} ${position.name}`,
        timeoutMs: 60_000,
        pollMs: 1_000,
      },
    );
    await this.mark('assigned');
  }

  private async startWork(): Promise<void> {
    await call('startWorkorder', () =>
      this.deps.as.tech.workorder.operationalContextApi.startWorkorder({ workorderId: this.requireWorkorder() }),
    );
    await this.mark('started');
  }

  /**
   * Expands into one timed step per service item, now that promotion has said
   * which items exist. Inserted as steps rather than run in a loop so the day
   * runner can still stop this job at closing time between two services.
   */
  private async planLabor(): Promise<Step[]> {
    const steps: Step[] = [];
    for (const serviceId of this.serviceIds) {
      const workorderItemId = this.serviceItemMap.get(serviceId);
      if (!workorderItemId) {
        // A service the workorder did not carry across is not a failure: the
        // estimate's lines and the workorder's items are not guaranteed one to
        // one, and the completion step works from the workorder's own detail.
        continue;
      }
      steps.push({
        name: `labor-${serviceId.slice(0, 8)}`,
        run: () => this.recordLabor(workorderItemId, serviceId),
      });
    }
    return steps;
  }

  /**
   * One service item's labor, start to stop, under the timer lock.
   *
   * No sleep between start and stop. The non-accelerated suite sleeps 1.5 real
   * seconds so the entry carries a duration above zero; here the backend measures
   * its own accelerated clock, so a single round trip is already minutes of
   * virtual labor. Sleeping would burn the open window for nothing.
   */
  private async recordLabor(workorderItemId: string, laborCode: string): Promise<void> {
    const workorderId = this.requireWorkorder();
    await this.deps.timerLock.runExclusive(async () => {
      await this.stopTimersIfRunning();
      await call('startTimer', () =>
        this.deps.as.tech.workorder.workexecTimeTrackingAPIApi.startTimer({
          workexecTimerStartRequest: { workorderId, workorderItemId, laborCode },
        }),
      );
      const stopped = await call('stopTimers', () =>
        this.deps.as.tech.workorder.workexecTimeTrackingAPIApi.stopTimers(),
      );
      const entries = readNumber(stopped, 'stoppedCount', 'count');
      if (entries !== undefined && entries < 1) {
        throw new Error(`stopTimers stopped ${entries} timers for workorder ${workorderId} — the labor was not recorded`);
      }
    });
    await this.mark('labor-recorded');
  }

  /** A stale timer from an interrupted run is not an error; anything else is. */
  private async stopTimersIfRunning(): Promise<void> {
    try {
      await this.deps.as.tech.workorder.workexecTimeTrackingAPIApi.stopTimers();
    } catch (error) {
      if (!isHttpStatus(error, 404) && !isHttpStatus(error, 409)) {
        throw error;
      }
    }
  }

  private async completeItems(): Promise<void> {
    const workorderId = this.requireWorkorder();
    const detail = await call('getWorkorderDetail', () =>
      this.deps.as.manager.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }),
    );

    for (const service of detail.services ?? []) {
      if (!service.id || !COMPLETABLE.has(String(service.status))) continue;
      await call(`completeServiceItem ${service.id}`, () =>
        this.deps.as.manager.workorder.workOrderAPIApi.completeServiceItem({
          workorderId,
          serviceLineId: service.id as string,
        }),
      );
    }
    for (const part of detail.parts ?? []) {
      if (!part.id || !COMPLETABLE.has(String(part.status))) continue;
      await call(`completePartItem ${part.id}`, () =>
        this.deps.as.manager.workorder.workOrderAPIApi.completePartItem({ workorderId, partId: part.id }),
      );
    }
  }

  private async completeWorkorder(): Promise<void> {
    await call('completeWorkorder', () =>
      this.deps.as.manager.workorder.workOrderAPIApi.completeWorkorder({
        workorderId: this.requireWorkorder(),
        completeWorkorderRequest: {
          completionNotes: `Completed by the accelerated run [${this.deps.ctx.runId}]`,
        },
      }),
    );
    await this.mark('completed');
  }

  /**
   * Invoice generation is safe to repeat — it returns the same invoice rather
   * than making another — and the id does not always arrive on the first call,
   * so the retry is the same one Suite C uses, bounded here to a few attempts
   * because the day runner owns the clock.
   */
  private async generateInvoice(): Promise<void> {
    const workorderId = this.requireWorkorder();
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const generated = await call('generateWorkorderInvoice', () =>
        this.deps.as.advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({ workorderId }),
      );
      const invoiceId = readString(generated, 'invoiceId');
      if (invoiceId) {
        this.invoiceId = invoiceId;
        await this.mark('invoiced');
        return;
      }
    }
    throw new Error(`generateWorkorderInvoice never returned an invoiceId for workorder ${workorderId}`);
  }

  private async finalizeInvoice(): Promise<void> {
    const invoiceId = requireField(this.invoiceId, 'invoiceId');
    const finalized = await call('finalizeInvoice', () =>
      this.deps.as.advisor.invoice.invoiceApi.finalizeInvoice({ invoiceId, finalizationRequest: {} }),
    );
    const total = readNumber(finalized, 'total', 'totalAmount');
    if (total === undefined || total <= 0) {
      throw new Error(`invoice ${invoiceId} finalized with a total of ${String(total)} — a completed job is worth something`);
    }
    this.invoiceTotal = total;
    await this.mark('finalized');
  }

  private async payInvoice(): Promise<void> {
    if (this.deps.leaveUnpaid === true) {
      await this.mark('left-unpaid');
      return;
    }
    const invoiceId = requireField(this.invoiceId, 'invoiceId');
    await call('submitAccountingEvent', () =>
      this.deps.as.controller.accounting.accountingEventsApi.submitAccountingEvent({
        accountingEventSubmitRequest: {
          eventType: 'INVOICE_PAYMENT',
          organizationId: this.deps.ctx.refs.locationId,
          sourceSystem: 'SDK_ITEST_ACCEL',
          payload: {
            invoiceId,
            paymentMethod: this.deps.ctx.random.chance(0.95) ? 'CREDIT_CARD' : 'CASH',
            amountPaid: this.invoiceTotal ?? 0,
          },
        },
      }),
    );
    this.paid = true;
    await this.mark('paid');
  }

  private requireCustomer(): CreatedCustomer {
    if (!this.customer) {
      throw new Error('the job has no customer yet');
    }
    return this.customer;
  }

  private requireWorkorder(): string {
    return requireField(this.workorderId, 'workorderId');
  }
}

/** Shape a job needs from the reference bootstrap — narrowed for the unit tests. */
export type JobReferences = Pick<
  ReferenceCache,
  'locationId' | 'serviceEntityIds' | 'productEntityIds' | 'serviceNameById' | 'productNameById'
>;

export type JobRandom = Pick<SeederRandom, 'int' | 'pickN' | 'chance' | 'price' | 'base64'>;
