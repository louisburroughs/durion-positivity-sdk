/**
 * Accelerated year — a year of shop activity written against an accelerated
 * backend, with no assertions.
 *
 * The populate twin of `suites-accelerated/z-year-volume.accel.itest.ts`: the same
 * day runner, the same calendar gate, the same resource ledger, the same journal.
 * What it does not do is fail: a day that goes wrong is reported and the year
 * carries on, because the point of a populate run is the data.
 *
 *   npm run populate:accelerated-year
 *
 * Needs a backend on the `accelerated` profile with its clock anchored a year back
 * (see README, "Accelerated year run"), the same ITEST_* environment as the suites,
 * plus the ITEST_ACCEL_* variables. Unlike the suite it is not a `*.accel.itest.ts`,
 * so `npm run test:accelerated` never collects it — but it *does* need the same
 * preparation, so it runs the accelerated global setup itself.
 *
 * Use the suite when you want the year verified. Use this when you want the year.
 */
import acceleratedGlobalSetup from '../harness/acceleratedGlobalSetup';
import { runAcceleratedYear } from '../harness/acceleratedRun';

const TAG = '[accel-year]';
const log = (message: string): void => console.log(`${TAG} ${message}`);

async function main(): Promise<void> {
  // The same setup the suites get: the clock guard, the bootstraps, the published
  // calendar, the feasibility check and the journal. It sets the two context-file
  // environment variables this process then reads, which is why it is called here
  // rather than duplicated.
  await acceleratedGlobalSetup();

  const result = await runAcceleratedYear({ log });

  log('--- summary ---');
  log(`runId=${result.runId}`);
  log(`stopped: ${result.stopDetail}`);
  log(`virtual span: ${result.virtualSpan.from} → ${result.virtualSpan.to}`);
  log(
    `${result.totals.workordersCompleted} workorder(s) completed, ${result.totals.invoicesFinalized} invoiced, ` +
      `${result.totals.invoicesPaid} paid, ${result.totals.estimatesDeclined} estimate(s) declined`,
  );
  log(
    `${result.totals.appointmentsBooked} appointment(s) booked, ${result.totals.appointmentsConverted} converted, ` +
      `${result.totals.cycleCounts} cycle count(s), ${result.totals.restocks} restock(s)`,
  );
  log(`${result.totals.openDaysWorked} open day(s) worked of ${result.daysAttempted} attempted`);

  const overlaps = result.ledger.overlaps();
  if (overlaps.length > 0) {
    // Not an assertion, but not silence either: a double-booked bay in a populate
    // run is data somebody will later mistake for a backend defect.
    log(`WARNING: ${overlaps.length} resource overlap(s) recorded — the ledger was bypassed somewhere`);
  }
  const stillOpen = result.ledger.activeClaims();
  if (stillOpen.length > 0) {
    log(
      `WARNING: ${stillOpen.length} claim(s) still held at the end: ` +
        stillOpen.map((claim) => `${claim.position.name}/${claim.technicianId}`).join(', ') +
        '. The next run counts them busy until they are reconciled.',
    );
  }

  if (result.failures.length > 0) {
    log(`${result.failures.length} day failure(s):`);
    for (const failure of result.failures.slice(0, 20)) {
      log(`  ${failure}`);
    }
    process.exitCode = 1;
  }
  if (result.stoppedBecause === 'budget' || result.stoppedBecause === 'failed') {
    process.exitCode = 1;
  }
}

// Guarded so the module can be imported by a test without executing a run.
if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`${TAG} FATAL`, error);
    process.exit(1);
  });
}
