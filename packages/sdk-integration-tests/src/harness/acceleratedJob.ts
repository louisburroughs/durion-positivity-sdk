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
import type { Arrival } from './acceleratedDayRunner';

/**
 * `held` is a job the run deliberately stopped short of the end (see `HoldPoint`),
 * leaving its estimate or workorder open for the environment that outlives the run.
 */
export type JobOutcome = 'in-progress' | 'completed' | 'declined' | 'failed' | 'held';

/**
 * Where an open-work-tail job stops, by the step it never runs. Each leaves the
 * record in the state a real shop always has some of:
 *
 * - `decide`            — estimate submitted, waiting on the customer (PENDING_APPROVAL)
 * - `approve-workorder` — promoted, waiting on the manager (DRAFT)
 * - `assign-technician` — approved, waiting for dispatch (APPROVED)
 * - `complete-items`    — on its position and being worked (WORK_IN_PROGRESS)
 * - `invoice`           — finished, not yet billed (COMPLETED, no invoice)
 *
 * Only `complete-items` holds a position and a technician; that job is *parked*
 * — carried by the day runner, never advanced again — so the bay reads occupied
 * for real. The others settle as `held` and give their claim back.
 */
export const HOLD_POINTS = ['decide', 'approve-workorder', 'assign-technician', 'complete-items', 'invoice'] as const;
export type HoldPoint = (typeof HOLD_POINTS)[number];
const PARKED_HOLDS: ReadonlySet<HoldPoint> = new Set(['complete-items']);

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
  /**
   * Decides, from the virtual instant of the job's first step, whether it stops
   * short and where (ITEST_ACCEL_TAIL_DAYS / _TAIL_RATIO). Undefined, or a
   * function answering undefined, runs the whole lifecycle.
   */
  holdAt?: (at: Date) => HoldPoint | undefined;
  /**
   * Waits for a virtual instant. Used only to give a labor entry its minimum span
   * before stopping it; without it the floor is skipped.
   */
  waitUntil?: (target: Date) => Promise<void>;
  /** Customer decision odds, mirroring the seeder's distribution. */
  approveChance?: number;
  declineChance?: number;
  /**
   * The appointment this job works (#148). The customer, vehicle and DRAFT estimate
   * already exist — the bridge made the estimate and linked it to the appointment — so
   * the job starts at its lines; promoting that estimate is what links the workorder to
   * the appointment on the backend.
   */
  fromAppointment?: Arrival;
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
/**
 * Mirrors `InvoiceFinalizationServiceImpl.SERVICE_ADVISOR_LIMIT`: above it an advisor
 * needs a manager approval code, and the backend answers 403 MANAGER_APPROVAL_REQUIRED.
 */
export const SERVICE_ADVISOR_LIMIT = 500;
/**
 * How long, in virtual time, a job waits for its invoice to be linked before failing.
 * Generation is queued (202 PENDING); on alpha the link landed 5-53 virtual minutes
 * after completion. The bound is virtual time, not ticks: a tick in which every job is
 * only polling is one quick read, and twelve of those spanned a few virtual minutes,
 * which failed whole days of jobs. It only stops a stuck command holding a bay forever.
 */
export const INVOICE_WAIT_VIRTUAL_MS = 2 * 60 * 60 * 1000;
/**
 * The least labor a job books before its labor clock is closed for good, in virtual
 * time. Nothing in the run makes work take time except the ticks, and at scale 2050 a
 * quick tick is under a virtual minute: labor-open, complete-items and labor-close
 * fitted inside one, and a completed job recorded 0.00 hours (Z13b). The day runner
 * holds the close back (see `readyAt`) rather than the job sleeping inside a tick.
 */
export const MIN_JOB_LABOR_VIRTUAL_MS = 30 * 60 * 1000;
/**
 * The least any single entry runs before it is stopped. The backend books whole
 * minutes, so an entry opened in a closing tick and suspended straight after would
 * record nothing; waiting out the remainder costs ~60 ms real at scale 2050.
 */
export const MIN_LABOR_ENTRY_VIRTUAL_MS = 2 * 60 * 1000;
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
  /** When the open entry started, as this job observed it; undefined when none is open. */
  private laborOpenedAt: Date | undefined;
  /** Labor already booked in this bracket by entries since stopped. */
  private laborBookedMs = 0;
  /** True once the backend holds this job's technician, until it is handed back. */
  private technicianAssigned = false;
  /** True once the workorder is COMPLETED, after which nothing may be released from it. */
  private workorderClosed = false;
  /** Resolved from `deps.holdAt` on the first advance; null means "run to the end". */
  private hold: HoldPoint | null | undefined;
  private parkedAtHold = false;

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
  /** The draft's total as generate-invoice reported it; picks who finalizes. */
  draftTotal: number | undefined;
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

    const arrival = deps.fromAppointment;
    if (arrival) {
      this.customer = { partyId: arrival.customer.partyId, fullName: arrival.customer.fullName, firstName: '', lastName: '' };
      this.vehicleId = arrival.vehicleId;
      this.estimateId = arrival.estimateId;
    }

    this.steps.push(
      ...(arrival
        ? [{ name: 'arrival', run: () => this.mark('appointment-arrived') }]
        : [
            { name: 'customer', run: () => this.createCustomer() },
            { name: 'vehicle', run: () => this.createVehicle() },
            { name: 'estimate', run: () => this.createEstimate() },
          ]),
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

  /**
   * The virtual instant before which the next step may not run, if any.
   *
   * Only the labor close waits: the mechanic is on the job until it has booked
   * MIN_JOB_LABOR_VIRTUAL_MS across its entries. A suspended job has no open entry
   * and closes as soon as it is advanced — its hours are already on the entries.
   */
  get readyAt(): Date | undefined {
    if (this.nextStep !== 'labor-close' || this.laborOpenedAt === undefined) {
      return undefined;
    }
    const remaining = MIN_JOB_LABOR_VIRTUAL_MS - this.laborBookedMs;
    return remaining > 0 ? new Date(this.laborOpenedAt.getTime() + remaining) : undefined;
  }

  get stepsRemaining(): number {
    return Math.max(0, this.steps.length - this.cursor);
  }

  /**
   * True once the job has stopped at a hold that keeps its position. The day runner
   * never advances a parked job again; it stays carried, holding its bay and
   * mechanic, and its labor clock is suspended at the next close like any other.
   */
  get parked(): boolean {
    return this.parkedAtHold;
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
    if (this.result !== 'in-progress' || this.parkedAtHold) {
      return this.result;
    }
    const step = this.steps[this.cursor];
    if (!step) {
      this.result = 'completed';
      return this.result;
    }

    if (this.hold === undefined) {
      this.hold = this.deps.holdAt ? (this.deps.holdAt(await this.deps.now()) ?? null) : null;
    }
    if (this.hold !== null && step.name === this.hold) {
      if (PARKED_HOLDS.has(this.hold)) {
        this.parkedAtHold = true;
        await this.mark(`parked-before-${this.hold}`);
      } else {
        this.result = 'held';
        await this.mark(`held-before-${this.hold}`);
      }
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
    // A completed workorder holds nobody. `releaseTechnician` answers 409
    // WORKORDER_CLOSED once the workorder is COMPLETED or CANCELLED
    // (TechnicianAssignmentController), so a job that fails at `invoice`,
    // `finalize` or `pay` — all of which run after `complete` — would append a
    // second, misleading failure about a technician who was released by the
    // completion itself.
    if (this.workorderClosed) {
      this.technicianAssigned = false;
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
    // Read after the backend stamped startTime, so the span measured here is never
    // longer than the one it records.
    this.laborOpenedAt = await this.deps.now();
    this.laborBracketOpen = true;
    await this.mark('labor-open');
  }

  /** Closes the session for good: the work is done, and the bracket is over. */
  private async closeLaborSession(): Promise<void> {
    await this.stopLaborEntry();
    this.laborBracketOpen = false;
    this.laborBookedMs = 0;
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
    const openedAt = this.laborOpenedAt;
    if (openedAt && this.deps.waitUntil) {
      const earliest = new Date(openedAt.getTime() + MIN_LABOR_ENTRY_VIRTUAL_MS);
      if ((await this.deps.now()).getTime() < earliest.getTime()) {
        await this.deps.waitUntil(earliest);
      }
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
    if (openedAt) {
      this.laborBookedMs += (await this.deps.now()).getTime() - openedAt.getTime();
    }
    this.laborEntryId = undefined;
    this.laborOpenedAt = undefined;
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
    // Completion closes the workorder, and with it the technician's assignment:
    // nothing may be released from it afterwards.
    this.workorderClosed = true;
    await this.mark('completed');
  }

  /**
   * Invoice generation is queued: until the invoicing domain links the invoice back to
   * the workorder, generate-invoice answers 202 PENDING with no id, and every such call
   * queues *another* generation command. Once linked it returns the existing invoice —
   * id and total — and queues nothing.
   *
   * So the job asks once, then polls the workorder (read-only) for the link, one read per
   * tick so the day runner keeps the clock, and asks once more when the link is there.
   * Suite C re-asks inside one test; a job re-asking every tick flooded the command topic
   * with ~3 commands per invoice.
   */
  private async generateInvoice(): Promise<Step[] | void> {
    if (await this.requestInvoice()) {
      return;
    }
    const deadline = (await this.deps.now()).getTime() + INVOICE_WAIT_VIRTUAL_MS;
    return [{ name: 'invoice-wait', run: () => this.awaitInvoiceLink(deadline) }];
  }

  private async awaitInvoiceLink(deadline: number): Promise<Step[] | void> {
    const workorderId = this.requireWorkorder();
    const workorder = await call('getWorkorder', () =>
      this.deps.as.advisor.workorder.workOrderAPIApi.getWorkorder({ workorderId }),
    );
    if (readString(workorder, 'invoiceId')) {
      if (await this.requestInvoice()) {
        return;
      }
      throw new Error(`workorder ${workorderId} links an invoice but generate-invoice still answers pending`);
    }
    if ((await this.deps.now()).getTime() >= deadline) {
      throw new Error(
        `no invoice was linked to workorder ${workorderId} within ` +
          `${INVOICE_WAIT_VIRTUAL_MS / 60_000} virtual minutes of asking`,
      );
    }
    return [{ name: 'invoice-wait', run: () => this.awaitInvoiceLink(deadline) }];
  }

  /** One generate-invoice call; true when it answered with the invoice. */
  private async requestInvoice(): Promise<boolean> {
    const workorderId = this.requireWorkorder();
    const generated = await call('generateWorkorderInvoice', () =>
      this.deps.as.advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({ workorderId }),
    );
    const invoiceId = readString(generated, 'invoiceId');
    if (!invoiceId) {
      return false;
    }
    this.invoiceId = invoiceId;
    this.draftTotal = readNumber(generated, 'totalAmount', 'total');
    await this.mark('invoiced');
    return true;
  }

  /**
   * Finalized by the advisor, as the non-accelerated suites do, unless the draft total
   * is above the advisor's cap — then by the manager, whose `invoice:finalize:override`
   * needs no approval code.
   *
   * The total is the one generate-invoice returned with the id: the backend's own figure,
   * and nothing re-prices the draft between the two steps. Not a `getInvoice` read, which
   * needs `invoice:invoice:view` — a grant SERVICE_ADVISOR does not hold.
   */
  private async finalizeInvoice(): Promise<void> {
    const invoiceId = requireField(this.invoiceId, 'invoiceId');
    const finalizer =
      (this.draftTotal ?? 0) > SERVICE_ADVISOR_LIMIT ? this.deps.as.manager : this.deps.as.advisor;
    const finalized = await call('finalizeInvoice', () =>
      finalizer.invoice.invoiceApi.finalizeInvoice({ invoiceId, finalizationRequest: {} }),
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
          // The INVOICE_PAYMENT contract (backend #2435): the Payment-domain paymentId keys the
          // receivable payment, so a later payment fact for the same id is not booked twice.
          // paidAt is wall time; accounting applies the payment on its own (accelerated) clock.
          payload: {
            paymentId: crypto.randomUUID(),
            invoiceId,
            paymentMethod: this.ctx.random.chance(0.95) ? 'CREDIT_CARD' : 'CASH',
            amountPaid: this.invoiceTotal ?? 0,
            currency: 'USD',
            paidAt: new Date().toISOString(),
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
