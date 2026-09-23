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
  /** The labor entry currently open, if the mechanic is on this job right now. */
  private laborEntryId: string | undefined;
  /**
   * True between `labor-open` and `labor-close` — the stretch of the lifecycle the
   * mechanic is working the job, whether or not an entry is open at this instant.
   * A suspended session sets `laborEntryId` to undefined and leaves this true, which
   * is what tells the next `advance` to reopen.
   */
  private laborBracketOpen = false;
  /** True once the backend holds this job's technician, until it is handed back. */
  private technicianAssigned = false;

  /**
   * The job's own context, anchored to the site it holds a position at.
   *
   * The run keeps one BuilderContext for the whole year, whose `refs.locationId`
   * is the reference cache's single site — but a claim can be at any site whose
   * board the day discovered. Building the estimate at the cache's site and then
   * placing the workorder on another site's bay is the shape
   * `ServicePositionController` refuses with 422 SERVICE_POSITION_INVALID, "the
   * position is unknown *or at another site*".
   *
   * It cost an entire virtual year: 3,864 jobs failed at `assign-position`, 2,038
   * on bays and 1,826 on mobile units, none of them completing. The placement is
   * wrapped in `retryWhileReplicating`, whose markers are matched against the
   * response body — and the body could not be read (see formatError), so no marker
   * matched and every one of them failed on the first attempt rather than waiting
   * out the replication window.
   *
   * The random stream and the run id stay shared; only the site moves.
   */
  private readonly ctx: BuilderContext;

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
    this.ctx = {
      ...ctx,
      refs: { ...refs, locationId: deps.claim.locationId },
    };

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
      // The labor session brackets the work itself — opened before the items are
      // completed and closed after — so the hours the backend computes describe the
      // job rather than the calendar. See openLaborSession.
      { name: 'labor-open', run: () => this.openLaborSession() },
      { name: 'complete-items', run: () => this.completeItems() },
      { name: 'labor-close', run: () => this.closeLaborSession() },
      { name: 'complete', run: () => this.completeWorkorder() },
      { name: 'invoice', run: () => this.generateInvoice() },
      { name: 'finalize', run: () => this.finalizeInvoice() },
      { name: 'pay', run: () => this.payInvoice() },
    );
  }

  /** The site this job builds and places at — the claim's, not the cache's. */
  get locationId(): string {
    return this.ctx.refs.locationId;
  }

  /** The catalog this job draws from, shared across sites and unchanged per job. */
  get catalog(): { serviceEntityIds: string[]; productEntityIds: string[] } {
    return {
      serviceEntityIds: this.ctx.refs.serviceEntityIds,
      productEntityIds: this.ctx.refs.productEntityIds,
    };
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

  /** True while an entry is open and the clock is running on this job. */
  get laborOpen(): boolean {
    return this.laborEntryId !== undefined;
  }

  /**
   * Stops the clock on this job because the shop is closing.
   *
   * Not the same as finishing the work: the bracket stays open, so the next time the
   * day runner advances this job it opens a fresh entry and carries on. Two spans
   * either side of a closed night, rather than one span straight through it — which
   * is the whole reason the night is not booked as worked.
   */
  async suspendLabor(): Promise<void> {
    if (!this.laborOpen) {
      return;
    }
    await this.stopLaborEntry();
    await this.mark('labor-suspended');
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
      // A session the shop's closing suspended is reopened before the work resumes, so
      // the mechanic is back on the clock for the step that is about to run rather than
      // from whenever the next `labor-open` would have been.
      //
      // Except when the step *is* the close. Reopening to immediately stop would write a
      // second entry a few seconds long for a morning nobody worked the job, and the
      // suspend at last night's close already recorded everything that was.
      if (this.laborBracketOpen && !this.laborOpen && step.name !== 'labor-close') {
        await this.openLaborSession();
      }
      const inserted = await step.run();
      this.cursor += 1;
      if (inserted && inserted.length > 0) {
        this.steps.splice(this.cursor, 0, ...inserted);
      }
    } catch (error) {
      this.failureDetail = `${this.label} failed at step '${step.name}': ${await formatError(error)}`;
      this.result = 'failed';
      // A failed job leaves the day runner's carried list at once, so nothing will ever
      // suspend its labor clock again. Left running, that entry has no end at all and the
      // mechanic reads as still on the job a virtual year later. The close is best-effort:
      // the failure that got us here is the one worth reporting, not this one.
      try {
        await this.stopLaborEntry();
      } catch (stopError) {
        this.failureDetail += ` (its labor clock could not be stopped either: ${await formatError(stopError)})`;
      }
      this.laborBracketOpen = false;
      // Same reasoning, for the person: a failed job that keeps its technician
      // makes them busy on every later dispatch board.
      try {
        await this.releaseTechnician();
      } catch (releaseError) {
        this.failureDetail +=
          ` (its technician could not be released either: ${await formatError(releaseError)})`;
      }
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
    this.customer = await createPersonAccount(this.deps.as.advisor, this.ctx);
  }

  private async createVehicle(): Promise<void> {
    this.vehicleId = await createVehicle(this.deps.as.admin, this.ctx, this.requireCustomer().partyId);
  }

  private async createEstimate(): Promise<void> {
    this.estimateId = await createDraftEstimate(
      this.deps.as.advisor,
      this.ctx,
      this.requireCustomer().partyId,
      requireField(this.vehicleId, 'vehicleId'),
    );
  }

  private async addLabor(serviceId: string): Promise<void> {
    await addLaborLine(
      this.deps.as.advisor,
      this.ctx,
      requireField(this.estimateId, 'estimateId'),
      serviceId,
      Number((LABOR_PRICE * (1 + this.ctx.random.price(-0.15, 0.15))).toFixed(2)),
    );
  }

  private async addPart(productId: string): Promise<void> {
    await addPartLine(
      this.deps.as.advisor,
      this.ctx,
      requireField(this.estimateId, 'estimateId'),
      productId,
      this.ctx.random.int(1, 2),
      Number((PART_PRICE * (1 + this.ctx.random.price(-0.15, 0.15))).toFixed(2)),
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

    if (this.ctx.random.chance(approveChance)) {
      await call('approveEstimate', () =>
        this.deps.as.advisor.workorder.estimateAPIApi.approveEstimate({
          estimateId,
          approveEstimateRequest: {
            customerId: customer.partyId,
            signatureData: this.ctx.random.base64(32),
            signerName: customer.fullName,
            signatureMimeType: 'image/png',
          },
        }),
      );
      await this.mark('estimate-approved');
      return;
    }

    if (this.ctx.random.chance(declineChance)) {
      await call('declineEstimate', () =>
        this.deps.as.advisor.workorder.estimateAPIApi.declineEstimate({
          estimateId,
          reason: `Customer declined [${this.ctx.runId}]`,
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
          signatureData: this.ctx.random.base64(32),
          signerName: customer.fullName,
          signatureMimeType: 'image/png',
          notes: `Accelerated run approval [${this.ctx.runId}]`,
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
          notes: `Accelerated run [${this.ctx.runId}]`,
        },
      }),
    );
    this.technicianAssigned = true;
  }

  /**
   * Hands the technician back after a job fails holding one.
   *
   * The ledger releases its own claim when a job settles, but that is this
   * process's bookkeeping — the backend still has the person bound to the
   * workorder, and discovery reads `assignedWorkorderId` from the dispatch board
   * and counts them busy. One run that failed at `assign-position` left about
   * 1,800 workorders each holding a technician, which is a roster the next run
   * inherits as permanently occupied.
   *
   * Best-effort and quiet about its own failure: the failure that got here is the
   * one worth reporting. `shopFloorLoad.releaseOrphanedTechnician` is the same
   * safety net on the non-accelerated side, and this path is where it was missing.
   */
  private async releaseTechnician(): Promise<void> {
    if (!this.technicianAssigned || this.workorderId === undefined) {
      return;
    }
    this.technicianAssigned = false;
    await this.deps.as.manager.workorder.technicianAssignmentAPIApi.releaseTechnician({
      workorderId: this.workorderId,
      reason: `Accelerated run: job failed before completion [${this.deps.ctx.runId}]`,
    });
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
            reason: `Accelerated run [${this.ctx.runId}]`,
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
   * The workorder service line this job's labor is booked against.
   *
   * The backend would pick one itself, but it picks with
   * `findByWorkOrder_Id().findFirst()` over a query carrying no `ORDER BY`, so its
   * choice is whatever the database happens to return. Choosing here instead keeps
   * one job's labor on one line for the life of the job, which is what makes a
   * suspended session resumable: `startLaborSession` refuses a second open session
   * on the *same* line, so the line has to be the same one every morning.
   */
  private laborServiceId(): string {
    const [serviceItemId] = this.serviceItemMap.values();
    return requireField(serviceItemId, `a workorder service line for ${this.label}`);
  }

  /**
   * Opens the mechanic's labor session on this workorder.
   *
   * This is the only record of time spent on the job, and the backend measures it:
   * `startLaborSession` stamps `startTime` from its own accelerated clock and
   * `stopLaborSession` stamps `endTime` and computes the difference. Nothing here
   * declares an hours figure.
   *
   * It brackets the work rather than the day. A session left open across a closing
   * time would book the night as worked — `WorkorderLaborEntry.calculateHours` is a
   * plain subtraction with no notion of shop hours — so the day runner suspends it
   * at close (see `suspendLabor`) and the next `advance` reopens it. The job's total
   * is then the sum of its open-hours spans, which is elapsed working time with the
   * closed windows already excluded.
   */
  private async openLaborSession(): Promise<void> {
    const workorderId = this.requireWorkorder();
    const entry = await call('startLaborSession', () =>
      this.deps.as.tech.workorder.workorderLaborAPIApi.startLaborSession({
        workorderId,
        serviceId: this.laborServiceId(),
        startLaborRequest: {
          technicianId: this.deps.claim.technicianId,
          notes: `Accelerated run [${this.ctx.runId}]`,
        },
      }),
    );
    this.laborEntryId = requireField(readString(entry, 'id', 'entryId'), 'labor entry id');
    this.laborBracketOpen = true;
    await this.mark('labor-open');
  }

  /** Closes the session for good: the work is done, and the bracket is over. */
  private async closeLaborSession(): Promise<void> {
    await this.stopLaborEntry();
    this.laborBracketOpen = false;
    await this.mark('labor-closed');
  }

  /**
   * Stops the open entry, tolerating the one refusal that means it is already stopped.
   *
   * A 404 is a session some other path already closed — a previous run's suspend, or a
   * retry after a failure between the call and the bookkeeping — so the id is dropped
   * on that too.
   *
   * On anything else the id is *kept* and the error raised. That id is the only handle
   * on an entry the backend still has open: dropping it on a transient 500 would strip
   * the failure path of anything to retry with, leave the entry running forever, and
   * send the next morning's resume at a second session on the same service line, which
   * the backend refuses outright. Keeping it means `laborOpen` still reports the truth
   * — the clock really is running — so the resume correctly declines to open another
   * and the next stop retries this one.
   */
  private async stopLaborEntry(): Promise<void> {
    const entryId = this.laborEntryId;
    if (!entryId) {
      return;
    }
    try {
      await call('stopLaborSession', () =>
        this.deps.as.tech.workorder.workorderLaborAPIApi.stopLaborSession({
          workorderId: this.requireWorkorder(),
          entryId,
        }),
      );
    } catch (error) {
      if (!isHttpStatus(error, 404)) {
        throw error;
      }
    }
    this.laborEntryId = undefined;
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
          completionNotes: `Completed by the accelerated run [${this.ctx.runId}]`,
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
          organizationId: this.ctx.refs.locationId,
          sourceSystem: 'SDK_ITEST_ACCEL',
          payload: {
            invoiceId,
            paymentMethod: this.ctx.random.chance(0.95) ? 'CREDIT_CARD' : 'CASH',
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
