/*
 * ACCELERATED COPY of ../suites/a-appointments.itest.ts (spec: Task A6).
 *
 * Same scenarios, same assertions, same role negatives. What differs is only what
 * the accelerated clock forces:
 *
 *   - business instants come from `accel.now()` (GET /system/time), never from
 *     `new Date()` or `Date.now()`;
 *   - a labor-bearing step runs only while the shop is open, via `accel.openNow()`;
 *   - fixed real-time sleeps are replaced by known virtual intervals
 *     (`accel.elapseVirtual`), because the backend measures its own accelerated
 *     clock and a round trip is already minutes of virtual labor;
 *   - schedule windows land inside a *real* future open window, because the slot
 *     arrives during the run rather than long after it.
 *
 * Keep this file and its twin in step: a change here that is not a clock or
 * calendar concern belongs in both.
 */
import { SeederRandom } from '@durion-sdk/seeder';
import {
  CancelAppointmentRequestCancellationReasonEnum,
  RescheduleAppointmentRequestReasonEnum,
} from '@durion-sdk/shop-manager';
import {
  createPersonAccount,
  createVehicle,
  readString,
  seedFromRunId,
  type BuilderContext,
} from '../harness/builders';
import { call, expectHttpError, formatError, isHttpStatus, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
import { acceleratedFixture, type AcceleratedFixture } from './accelFixture';
import { Personas, type DomainClients } from '../harness/personas';

/**
 * Role mode is decided while Jest collects this file, long before any
 * beforeAll runs, so it comes from the environment rather than from the
 * Personas instance the tests use.
 */
const ROLE_MODE = ItestConfig.fromEnv().mode === 'role';
const itInRoleMode = ROLE_MODE ? it : it.skip;

/**
 * Suite A — appointments, and the appointment → estimate bridge.
 *
 * Windows are virtual near-future times inside a real open window. A slot already
 * taken is retried elsewhere - every appointment any previous run booked is still
 * on the shared environment, and the backend refuses a double-booking.
 *
 * A6 is the test that only exists here: the booked slot's own start time *arrives*
 * during the run, so the whole book -> arrive -> convert path is observable. On a
 * normal clock it never is.
 */
describe('Suite A — appointments', () => {
  let context: ItestContext;
  let accel: AcceleratedFixture;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let tech: DomainClients;
  let customer: { partyId: string; fullName: string };
  let vehicleId: string;
  let serviceRequestIds: string[];

  const SLOT_CONFLICT = 'already booked';

  /**
   * A window starting `offsetMinutes` after 09:00 UTC tomorrow.
   *
   * Callers pass an offset drawn at random rather than a fixed one: the backend
   * refuses a double-booking, and every appointment any previous run booked is
   * still on this environment, so no fixed schedule stays free. A wider range
   * lowers the odds of a clash but cannot remove them - `bookAppointment` is
   * what actually handles one, by trying somewhere else.
   */
  const window = async (offsetMinutes: number, durationMinutes: number) => {
    // Virtual time, and a *real* open window: the twin builds this from tomorrow
    // 09:00 by the laptop's clock, which on an accelerated backend is a date the
    // virtual clock left behind months ago. `futureWindow` starts from the virtual
    // now, lands on a day the shop actually opens, and keeps the slot inside its
    // hours.
    const lead = 1 + Math.floor(offsetMinutes / (24 * 60));
    const { startAt } = await accel.futureWindow(lead, offsetMinutes % (24 * 60));
    return { startAt, endAt: new Date(startAt.getTime() + durationMinutes * 60_000) };
  };

  /**
   * A slot somewhere in the coming virtual weeks, on the half hour.
   *
   * Narrower than the twin's ~140-day real spread, and deliberately so: the run is
   * only a year long in virtual time and the slot has to *arrive* while the suite
   * is still running for A6 to be able to convert it.
   */
  const randomOffsetMinutes = () => Math.floor(Math.random() * 20) * 30 + Math.floor(Math.random() * 14) * 24 * 60;

  const isSlotConflict = async (error: unknown): Promise<boolean> =>
    isHttpStatus(error, 400) && (await formatError(error)).includes(SLOT_CONFLICT);

  /**
   * Books an appointment into a free slot.
   *
   * Two conditions are tolerated, for different reasons. The CRM replica
   * pos-shop-manager validates against is fed over customer.events.v1 /
   * vehicle.events.v1, and this suite creates its customer and vehicle moments
   * earlier, so the first attempts can legitimately answer CUSTOMER_NOT_FOUND.
   * And the chosen slot may already be taken by a previous run, which is a
   * refusal about the *slot* rather than the request - so it is answered by
   * trying a different one rather than by failing.
   */
  const bookAppointment = async (as: DomainClients) => {
    for (let attempt = 1; ; attempt += 1) {
      const { startAt, endAt } = await window(randomOffsetMinutes(), 60);
      try {
        return await retryWhileReplicating(
          () =>
            as.shopManager.appointmentsApi.createAppointment({
              appointmentCreateRequest: {
                crmCustomerId: customer.partyId,
                crmVehicleId: vehicleId,
                locationId: context.referenceCache.locationId,
                startAt,
                endAt,
                serviceRequestIds,
              },
            }),
          {
            markers: ['CUSTOMER_NOT_FOUND', 'VEHICLE_NOT_FOUND'],
            description: `booking an appointment for party ${customer.partyId}`,
            timeoutMs: 60_000,
          },
        );
      } catch (error) {
        // retryWhileReplicating wraps the failure, so the conflict is matched on
        // the message it carries rather than on the original error object.
        const conflicted =
          error instanceof Error ? error.message.includes(SLOT_CONFLICT) : await isSlotConflict(error);
        if (!conflicted || attempt >= 10) {
          throw error;
        }
        console.log(`[A] slot taken on attempt ${attempt}; trying another`);
      }
    }
  };

  /**
   * Fails the suite up front when nobody at the location is staffed on the day
   * it books from (durion-positivity-sdk#94).
   *
   * The booking check counts ACTIVE technician staffing assignments effective on
   * the booked date, as stored. On a long-lived alpha an assignment written at
   * wall time starts months after the virtual now, so every booking is refused a
   * HARD MECHANIC_UNAVAILABLE and A2-A4 then fail on an undefined appointmentId,
   * which says nothing about the cause. The roster applies the same date filter
   * as the booking check, so an empty roster is that refusal, asked in advance.
   *
   * Polled briefly: the roster is a Kafka projection of pos-people, and the
   * seeder may have written the assignments moments before this suite started.
   */
  const assertTechniciansStaffed = async (on: Date) => {
    const locationId = context.referenceCache.locationId;
    const deadline = Date.now() + 60_000;
    for (;;) {
      const roster = await call('listLocationTechnicians', () =>
        admin.shopManager.technicianApi.listLocationTechnicians({ locationId, date: on }),
      );
      const staffed = roster.content?.length ?? 0;
      if (staffed > 0) {
        console.log(`[A] ${staffed} technician(s) staffed at ${locationId} on ${on.toISOString().substring(0, 10)}`);
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `No ACTIVE technician staffing assignment at location ${locationId} is effective on ` +
            `${on.toISOString().substring(0, 10)} (virtual), so every booking would be refused ` +
            'MECHANIC_UNAVAILABLE. The seeded assignments start after the virtual now: back-date them ' +
            '(durion-positivity-backend deployment/alpha/backdate-reference-data.sql) or reseed a wiped database.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
  };

  beforeAll(async () => {
    context = loadContext();
    accel = await acceleratedFixture();
    // The gate, applied once per suite: every scenario below is shop-floor or
    // service-desk work, so none of it starts before the shop opens. A copy whose
    // fixture is otherwise unused still needs this — it is the rule, not a helper.
    const openedAt = await accel.openNow('BAY');
    console.log(`[accel] suite starting at virtual ${openedAt.toISOString()} (scale ${accel.scale})`);
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    advisor = personas.as('advisor');
    admin = personas.as('admin');
    tech = personas.as('tech');
    await assertTechniciansStaffed(openedAt);
    ctx = {
      runId: context.runId,
      // Seeded per suite, not per run: a shared seed makes every suite generate
      // the same VIN, and VINs are globally unique across active vehicles.
      random: new SeederRandom(seedFromRunId(`${context.runId}:a-appointments`)),
      refs: context.referenceCache,
    };

    // The advisor owns the customer (crm:party:create); vehicle registration is
    // still ADMIN-only, so the fixture is split across two personas.
    customer = await createPersonAccount(advisor, ctx);
    vehicleId = await createVehicle(admin, ctx, customer.partyId);
    serviceRequestIds = context.referenceCache.serviceEntityIds.slice(0, 2);
  }, 180_000);

  beforeEach(async () => {
    await personas.refreshIfNeeded();
  });

  describe('A1 — book an appointment', () => {
    let appointmentId: string;
    let booked: Awaited<ReturnType<typeof bookAppointment>>;

    it('creates the appointment and echoes what was booked', async () => {
      booked = await bookAppointment(advisor);
      appointmentId = booked.appointmentId;

      expect(appointmentId).toBeTruthy();
      expect(booked.crmCustomerId).toBe(customer.partyId);
      expect(booked.crmVehicleId).toBe(vehicleId);
      expect(booked.locationId).toBe(context.referenceCache.locationId);
      expect(booked.serviceRequestIds ?? []).toEqual(expect.arrayContaining(serviceRequestIds));
    });

    it('starts in a live status rather than a cancelled one', () => {
      // The initial status is the backend's to choose; what the test pins is
      // that a freshly booked appointment is not already cancelled.
      expect(booked.status).toBeTruthy();
      expect(booked.status.toUpperCase()).not.toContain('CANCEL');
      console.log(`[A1] initial appointment status = ${booked.status}`);
    });

    it('A2 — fetches by id and round-trips the schedule window', async () => {
      const fetched = await call('getAppointmentById', () =>
        advisor.shopManager.appointmentsApi.getAppointmentById({ appointmentId }),
      );

      expect(fetched.appointmentId).toBe(appointmentId);
      expect(fetched.crmCustomerId).toBe(customer.partyId);
      expect(new Date(fetched.startAt).toISOString()).toBe(new Date(booked.startAt).toISOString());
      expect(new Date(fetched.endAt).toISOString()).toBe(new Date(booked.endAt).toISOString());
    });

    it('A3 — reschedules an hour later, and the move persists', async () => {
      // Relative to the slot A1 actually got, which is not the one it first
      // asked for if that was taken. A move into an occupied hour is retried
      // further out for the same reason booking is.
      // Seeded from virtual time, not the laptop's: an unused placeholder still
      // ends up in a failure message, and a real date there reads as a bug.
      const virtualNow = await accel.now();
      let moved = { startAt: virtualNow, endAt: virtualNow };
      let rescheduled;
      for (let attempt = 1; ; attempt += 1) {
        const start = new Date(new Date(booked.startAt).getTime() + attempt * 60 * 60_000);
        moved = { startAt: start, endAt: new Date(start.getTime() + 60 * 60_000) };
        try {
          rescheduled = await advisor.shopManager.appointmentsApi.rescheduleAppointment({
            appointmentId,
            rescheduleAppointmentRequest: {
              newStartAt: moved.startAt,
              newEndAt: moved.endAt,
              reason: RescheduleAppointmentRequestReasonEnum.CustomerRequest,
              rescheduleReasonNotes: `Integration test reschedule [${context.runId}]`,
            },
          });
          break;
        } catch (error) {
          if (!(await isSlotConflict(error)) || attempt >= 10) {
            throw new Error(`rescheduleAppointment failed: ${await formatError(error)}`);
          }
        }
      }
      expect(new Date(rescheduled.startAt).toISOString()).toBe(moved.startAt.toISOString());

      const refetched = await advisor.shopManager.appointmentsApi.getAppointmentById({ appointmentId });
      expect(new Date(refetched.startAt).toISOString()).toBe(moved.startAt.toISOString());
      expect(new Date(refetched.endAt).toISOString()).toBe(moved.endAt.toISOString());
    });

    it('A4 — cancels, and a cancelled appointment cannot be rescheduled', async () => {
      const cancelled = await call('cancelAppointment', () =>
        advisor.shopManager.appointmentsApi.cancelAppointment({
        appointmentId,
        cancelAppointmentRequest: {
          cancellationReason: CancelAppointmentRequestCancellationReasonEnum.CustomerRequest,
          notes: `Integration test cancellation [${context.runId}]`,
        },
      }),
      );
      expect(cancelled.status.toUpperCase()).toContain('CANCEL');

      const later = await window(randomOffsetMinutes(), 60);
      const status = await expectHttpError(
        advisor.shopManager.appointmentsApi.rescheduleAppointment({
          appointmentId,
          rescheduleAppointmentRequest: {
            newStartAt: later.startAt,
            newEndAt: later.endAt,
            reason: RescheduleAppointmentRequestReasonEnum.CustomerRequest,
          },
        }),
        400,
        409,
        422,
      );
      console.log(`[A4] rescheduling a cancelled appointment is rejected with HTTP ${status}`);
    });
  });

  describe('A5 — appointment → estimate bridge', () => {
    it('is idempotent on the appointment: the second call returns the first estimate', async () => {
      const appointment = await bookAppointment(advisor);
      // The field is typed as a plain string by the generated client but is a UUID
      // on the backend, which rejects anything else with a bare 400. One value,
      // reused across both calls: that sameness is what the test is proving.
      const idempotencyKey = crypto.randomUUID();

      const request = {
        createEstimateFromAppointmentRequest: {
          idempotencyKey,
          appointmentId: appointment.appointmentId,
          customerId: customer.partyId,
          vehicleId,
          locationId: context.referenceCache.locationId,
          requestedServices: serviceRequestIds.map(
            (id) => context.referenceCache.serviceNameById.get(id) ?? id,
          ),
        },
      };

      const first = await call('createEstimateFromAppointment (first)', () =>
        advisor.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment(request),
      );
      expect(first.created).toBe(true);
      expect(first.estimateId).toBeTruthy();

      const second = await call('createEstimateFromAppointment (replay)', () =>
        advisor.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment(request),
      );
      expect(second.created).toBe(false);
      expect(second.estimateId).toBe(first.estimateId);

      // The estimate the bridge made must be a real estimate, carrying the
      // appointment's customer and vehicle.
      const estimate = await call('getEstimate', () =>
        advisor.workorder.estimateAPIApi.getEstimate({ estimateId: first.estimateId }),
      );
      expect(readString(estimate, 'id', 'estimateId')).toBe(first.estimateId);
      expect(readString(estimate, 'crmPartyId', 'customerId')).toBe(customer.partyId);
      expect(readString(estimate, 'crmVehicleId', 'vehicleId')).toBe(vehicleId);
    }, 120_000);
  });

  describe('A6 — validation negative', () => {
    it('rejects a window that ends before it starts', async () => {
      const { startAt, endAt } = await window(randomOffsetMinutes(), 60);
      const status = await expectHttpError(
        advisor.shopManager.appointmentsApi.createAppointment({
          appointmentCreateRequest: {
            crmCustomerId: customer.partyId,
            crmVehicleId: vehicleId,
            locationId: context.referenceCache.locationId,
            startAt: endAt,
            endAt: startAt,
            serviceRequestIds,
          },
        }),
        400,
        422,
      );
      console.log(`[A6] endAt before startAt is rejected with HTTP ${status}`);
    });
  });

  describe('role-mode negatives', () => {
    itInRoleMode('a technician cannot book an appointment', async () => {
      await expectHttpError(bookAppointment(tech), 401, 403);
    });

    itInRoleMode('a technician cannot bridge an appointment into an estimate', async () => {
      const appointment = await bookAppointment(advisor);
      await expectHttpError(
        tech.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment({
          createEstimateFromAppointmentRequest: {
            idempotencyKey: crypto.randomUUID(),
            appointmentId: appointment.appointmentId,
            customerId: customer.partyId,
            vehicleId,
            locationId: context.referenceCache.locationId,
          },
        }),
        401,
        403,
      );
    });
  });

  describe('A6 — the booked slot arrives, and only then is it worked', () => {
    // Accelerated-only (spec: Task A6). On a normal clock a booked appointment's
    // start is days away and a test run is minutes long, so nothing ever waits for
    // it. Here the virtual clock reaches the slot, which makes the whole
    // book -> arrive -> convert path one test rather than two disconnected halves.
    it('waits for the appointment to become due, then bridges it', async () => {
      const appointment = await bookAppointment(advisor);
      const startAt = new Date(appointment.startAt);
      const before = await accel.now();
      expect(startAt.getTime()).toBeGreaterThan(before.getTime());

      const arrival = await accel.timer.waitUntil(startAt, `appointment ${appointment.appointmentId} to come due`);
      console.log(
        `[A6] slot ${startAt.toISOString()} arrived after ${arrival.realElapsedMs}ms real ` +
          `(scale ${arrival.observed.scale}); booked ${before.toISOString()}`,
      );
      expect(arrival.observed.virtualTime.getTime()).toBeGreaterThanOrEqual(startAt.getTime());

      // The slot is inside the shop's hours, which is what makes it workable at all.
      expect(accel.calendar.isOpen(startAt, 'BAY')).toBe(true);

      const bridged = await call('createEstimateFromAppointment (on arrival)', () =>
        advisor.workorder.estimatesFromAppointmentsApi.createEstimateFromAppointment({
          createEstimateFromAppointmentRequest: {
            idempotencyKey: crypto.randomUUID(),
            appointmentId: appointment.appointmentId,
            customerId: customer.partyId,
            vehicleId,
            locationId: context.referenceCache.locationId,
            requestedServices: serviceRequestIds.map(
              (id) => context.referenceCache.serviceNameById.get(id) ?? id,
            ),
          },
        }),
      );
      expect(bridged.estimateId).toBeTruthy();

      const estimate = await call('getEstimate', () =>
        advisor.workorder.estimateAPIApi.getEstimate({ estimateId: bridged.estimateId }),
      );
      expect(estimate.status).toBeTruthy();
      console.log(`[A6] estimate ${bridged.estimateId} created on arrival with status ${estimate.status}`);
    }, 600_000);
  });
});
