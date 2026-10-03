/**
 * Shop floor close-out — finishes yesterday's work so the morning load has
 * positions to fill.
 *
 * `populate:shop-floor` leaves every job it places running on its bay or unit,
 * and only ever loads *free* positions. Run daily on its own it fills the floor
 * once and then finds nothing to do. This run is the night shift that sits
 * between two loads: every open workorder still holding a position from before
 * today (UTC) is started if it never was, has any labor entry still running
 * stopped, has its items completed, is completed
 * itself — which releases the position — and is invoiced, finalized and paid.
 * Work created today is left alone; see `shopFloorCloseOutPlan.ts` for the rule.
 *
 * A populate run, not a test, like the floor load: it asserts nothing, is not a
 * `*.itest.ts`, and tags what it writes with its own `close-*` run id.
 *
 * A workorder that cannot be completed still gives its position back (the
 * technician and the position are released), because a position held by a job
 * nobody can finish blocks every morning load after it. The workorder itself
 * stays open, and the run exits non-zero so the failure is seen.
 *
 *   npm run populate:shop-floor:close
 *   npm run populate:shop-floor:daily     # close-out, then the floor load
 *
 * Same ITEST_* environment and build prerequisites as `populate:shop-floor`.
 */
import { assertNonAcceleratedBackend } from '../harness/acceleratedClock';
import { readNumber, readString } from '../harness/builders';
import { call, formatError, httpStatusOf, isHttpStatus } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadEnvFile } from '../harness/loadEnvFile';
import { Personas, type DomainClients } from '../harness/personas';
import { createStarterActivationPort, StarterActivation } from '../harness/StarterActivation';
import { createTenantPort, TenantPreflight } from '../harness/TenantPreflight';
import { waitFor } from '../harness/waitFor';
import { decideCloseOut, heldPositions, type HeldPosition, type WorkorderView } from './shopFloorCloseOutPlan';

const TAG = '[close]';
const log = (message: string): void => console.log(`${TAG} ${message}`);

/** Item statuses `completeServiceItem` / `completePartItem` accept, as suite C uses them. */
const COMPLETABLE_ITEMS = new Set(['OPEN', 'READY_TO_EXECUTE', 'IN_PROGRESS']);

type CloseState = 'invoiced' | 'completed' | 'released' | 'failed';

interface CloseOutcome {
  siteCode: string;
  position: HeldPosition;
  state: CloseState;
  invoiceId?: string;
  detail?: string;
}

interface Crew {
  admin: DomainClients;
  advisor: DomainClients;
  manager: DomainClients;
  tech: DomainClients;
  controller: DomainClients;
}

async function main(): Promise<void> {
  const envFile = loadEnvFile();
  if (envFile.file !== null) {
    log(`loaded ${envFile.applied.length} vars from ${envFile.file}`);
  }

  const config = ItestConfig.fromEnv();
  // Alpha stays on the accelerated profile after a run converges; wall time is all this needs.
  await assertNonAcceleratedBackend(config.baseUrl, { allowConverged: true });

  const runId = `close-${Math.floor(Date.now() / 1000)}-${Math.random().toString(36).slice(2, 6)}`;
  log(`runId=${runId} mode=${config.mode} tenant=${config.tenant.slug} baseUrl=${config.baseUrl}`);

  const activation = new StarterActivation(config, createStarterActivationPort(config));
  if (activation.applies) {
    const { activated } = await activation.run();
    log(`starter activation: ${activated.join(', ') || 'none'}`);
  }
  const bound = await new TenantPreflight(config, createTenantPort(config)).run();
  log(`tenant binding verified: ${bound.join(', ')}`);

  const personas = new Personas(config);
  await personas.login();
  const crew: Crew = {
    admin: personas.as('admin'),
    advisor: personas.as('advisor'),
    manager: personas.as('manager'),
    tech: personas.as('tech'),
    controller: personas.as('controller'),
  };

  const now = new Date();
  const locations = await call('listLocations', () => crew.admin.location.locationApi.listLocations());
  log(`${locations.length} location(s) found`);

  const outcomes: CloseOutcome[] = [];
  let kept = 0;
  for (const location of locations) {
    const locationId = location.id;
    const code = location.code ?? locationId ?? '(unknown)';
    if (!locationId) {
      continue;
    }

    let board;
    try {
      board = await crew.manager.workorder.dailyDispatchBoardDashboardApi.getDispatchDashboard({ locationId });
    } catch (error) {
      log(`${code}: skipped — dispatch board unavailable: ${await formatError(error)}`);
      continue;
    }

    for (const position of heldPositions(board)) {
      const workorder = await readWorkorder(crew.manager, position.workorderId);
      const decision = decideCloseOut(position, workorder, now);
      if (decision.action === 'keep') {
        kept += 1;
        log(`${code}: kept ${position.kind} ${position.name} (workorder ${position.workorderId}) — ${decision.reason}`);
        continue;
      }
      outcomes.push(await closePosition(crew, locationId, code, position, workorder as WorkorderView, runId));
    }
  }

  report(kept, outcomes);
  if (outcomes.some((outcome) => outcome.state === 'failed' || outcome.state === 'released')) {
    process.exitCode = 1;
  }
}

async function readWorkorder(manager: DomainClients, workorderId: string): Promise<WorkorderView | undefined> {
  try {
    const detail = await manager.workorder.workorderDetailApi.getWorkorderDetail({ workorderId });
    return { status: String(detail.status), createdAt: detail.createdAt };
  } catch (error) {
    log(`  could not read workorder ${workorderId}: ${await formatError(error)}`);
    return undefined;
  }
}

async function closePosition(
  crew: Crew,
  locationId: string,
  siteCode: string,
  position: HeldPosition,
  workorder: WorkorderView,
  runId: string,
): Promise<CloseOutcome> {
  const { workorderId } = position;
  const label = `${siteCode} ${position.kind} ${position.name} (workorder ${workorderId})`;

  try {
    // A job the floor load placed but could not start (role mode refuses the
    // single technician login for someone else's job) is started here when the
    // backend allows it. A refusal is not fatal: completion is tried regardless.
    if (String(workorder.status).toUpperCase() === 'ASSIGNED') {
      try {
        await crew.tech.workorder.operationalContextApi.startWorkorder({ workorderId });
      } catch (error) {
        const status = httpStatusOf(error);
        if (status !== 401 && status !== 403) {
          throw error;
        }
      }
    }

    // A labor entry still running — a job the accelerated year parked when its clock
    // converged mid-shift, or a floor load interrupted before its own close — is
    // stopped first, so finishing the job does not leave a mechanic on it forever.
    await stopOpenLabor(crew.tech, workorderId, label);

    const detail = await call('getWorkorderDetail', () =>
      crew.manager.workorder.workorderDetailApi.getWorkorderDetail({ workorderId }),
    );
    for (const service of detail.services ?? []) {
      if (!service.id || !COMPLETABLE_ITEMS.has(String(service.status))) continue;
      await call(`completeServiceItem ${service.id}`, () =>
        crew.manager.workorder.workOrderAPIApi.completeServiceItem({
          workorderId,
          serviceLineId: service.id as string,
        }),
      );
    }
    for (const part of detail.parts ?? []) {
      if (!part.id || !COMPLETABLE_ITEMS.has(String(part.status))) continue;
      await call(`completePartItem ${part.id}`, () =>
        crew.manager.workorder.workOrderAPIApi.completePartItem({ workorderId, partId: part.id }),
      );
    }

    // Completing a workorder releases its position (suite C8).
    await call('completeWorkorder', () =>
      crew.manager.workorder.workOrderAPIApi.completeWorkorder({
        workorderId,
        completeWorkorderRequest: { completionNotes: `Shop floor close-out [${runId}]` },
      }),
    );
  } catch (error) {
    const detail = await formatError(error);
    log(`FAILED  ${label}: could not complete: ${detail}`);
    const released = await releaseHeldWork(crew.manager, workorderId, label, runId);
    return { siteCode, position, state: released ? 'released' : 'failed', detail };
  }

  try {
    const invoiceId = await invoice(crew, locationId, workorderId);
    log(`invoiced ${label} — invoice ${invoiceId}`);
    return { siteCode, position, state: 'invoiced', invoiceId };
  } catch (error) {
    const detail = await formatError(error);
    log(`completed ${label}, but invoicing failed: ${detail}`);
    return { siteCode, position, state: 'completed', detail };
  }
}

/** Best-effort: an entry that cannot be stopped is reported, and completion is still tried. */
async function stopOpenLabor(tech: DomainClients, workorderId: string, label: string): Promise<void> {
  let history;
  try {
    history = await tech.workorder.workorderLaborAPIApi.getLaborHistory({ workorderId });
  } catch (error) {
    log(`  WARNING: labor history unavailable for ${label}: ${await formatError(error)}`);
    return;
  }
  for (const entry of history) {
    if (!entry.id || entry.endTime) continue;
    try {
      await tech.workorder.workorderLaborAPIApi.stopLaborSession({ workorderId, entryId: entry.id });
      log(`  stopped labor entry ${entry.id} left running on ${label}`);
    } catch (error) {
      if (!isHttpStatus(error, 404)) {
        log(`  WARNING: labor entry ${entry.id} on ${label} is still running: ${await formatError(error)}`);
      }
    }
  }
}

/**
 * Generate, finalize and pay, as suite C9 does. Generation is asynchronous: the
 * first call records an approval and answers with no invoice id; repeating it is
 * safe and returns the invoice once it exists.
 */
async function invoice(crew: Crew, locationId: string, workorderId: string): Promise<string> {
  await call('generateWorkorderInvoice', () =>
    crew.advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({ workorderId }),
  );
  const invoiceId = await waitFor(
    async () =>
      readString(
        await crew.advisor.workorder.workOrderAPIApi.generateWorkorderInvoice({ workorderId }),
        'invoiceId',
      ),
    { description: `an invoice id for workorder ${workorderId}`, timeoutMs: 90_000, intervalMs: 2_000 },
  );

  const finalized = await call('finalizeInvoice', () =>
    crew.advisor.invoice.invoiceApi.finalizeInvoice({ invoiceId, finalizationRequest: {} }),
  );
  const total = readNumber(finalized, 'total', 'totalAmount') ?? 0;

  // The payment is history colour, not the point of the run: a refused event is
  // reported and the invoice still counts.
  try {
    await crew.controller.accounting.accountingEventsApi.submitAccountingEvent({
      accountingEventSubmitRequest: {
        eventType: 'INVOICE_PAYMENT',
        organizationId: locationId,
        sourceSystem: 'SDK_FLOOR',
        payload: { invoiceId, paymentMethod: 'CREDIT_CARD', amountPaid: total },
      },
    });
  } catch (error) {
    log(`  WARNING: payment event for invoice ${invoiceId} was refused: ${await formatError(error)}`);
  }
  return invoiceId;
}

/**
 * Gives the position and the technician back when the workorder cannot be
 * finished, so the morning load is not blocked by it. Best-effort, and each
 * failure names the ids a human would need to unpick it.
 */
async function releaseHeldWork(
  manager: DomainClients,
  workorderId: string,
  label: string,
  runId: string,
): Promise<boolean> {
  let released = true;
  try {
    await manager.workorder.servicePositionAPIApi.releaseServicePosition({
      workorderId,
      reason: `Shop floor close-out: workorder could not be completed [${runId}]`,
    });
  } catch (error) {
    released = false;
    log(`  WARNING: position still held by ${label}: ${await formatError(error)}`);
  }
  try {
    await manager.workorder.technicianAssignmentAPIApi.releaseTechnician({
      workorderId,
      reason: `Shop floor close-out: workorder could not be completed [${runId}]`,
    });
  } catch (error) {
    log(`  WARNING: technician still assigned to ${label}: ${await formatError(error)}`);
  }
  if (released) {
    log(`  released position held by ${label}; the workorder stays open`);
  }
  return released;
}

function report(kept: number, outcomes: CloseOutcome[]): void {
  const count = (state: CloseState) => outcomes.filter((outcome) => outcome.state === state).length;
  log('--- summary ---');
  log(
    `closed ${outcomes.length} position(s): invoiced=${count('invoiced')} completed-not-invoiced=${count('completed')} ` +
      `released-unfinished=${count('released')} failed=${count('failed')}; kept ${kept}`,
  );
}

// Guarded so the module can be imported by a test without executing a run.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`${TAG} FATAL`, error);
    process.exit(1);
  });
}
