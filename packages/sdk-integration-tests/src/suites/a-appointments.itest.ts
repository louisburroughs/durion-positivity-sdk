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
import { call, expectHttpError, retryWhileReplicating } from '../harness/http';
import { ItestConfig } from '../harness/ItestConfig';
import { loadContext, type ItestContext } from '../harness/ItestContext';
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
 * Windows are real near-future times: valid against a normal clock, and no
 * step waits for one to arrive. Every appointment is booked for tomorrow, so
 * nothing here depends on when the suite runs.
 */
describe('Suite A — appointments', () => {
  let context: ItestContext;
  let personas: Personas;
  let ctx: BuilderContext;
  let advisor: DomainClients;
  let admin: DomainClients;
  let tech: DomainClients;
  let customer: { partyId: string; fullName: string };
  let vehicleId: string;
  let serviceRequestIds: string[];

  /**
   * Tomorrow at 09:00 UTC, plus a per-run band and the requested offset.
   *
   * The band matters: the backend rejects a double-booked slot with
   * "Requested slot is already booked", and every appointment any previous run
   * booked is still there. A random band spread across the next few months keeps
   * runs apart without coordination; a week's worth was not enough once the runs
   * started accumulating.
   */
  const runBandMinutes = Math.floor(Math.random() * 200_000);

  const window = (startOffsetMinutes: number, durationMinutes: number) => {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 1);
    start.setUTCHours(9, 0, 0, 0);
    start.setUTCMinutes(start.getUTCMinutes() + runBandMinutes + startOffsetMinutes);
    const end = new Date(start.getTime() + durationMinutes * 60_000);
    return { startAt: start, endAt: end };
  };

  /**
   * Books an appointment, tolerating the CRM replica pos-shop-manager reads.
   * The customer and vehicle are created by this suite moments earlier and
   * reach shop-manager over customer.events.v1 / vehicle.events.v1, so the
   * first attempts can legitimately answer CUSTOMER_NOT_FOUND.
   */
  const bookAppointment = async (as: DomainClients, offsetMinutes: number) => {
    const { startAt, endAt } = window(offsetMinutes, 60);
    return retryWhileReplicating(
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
  };

  beforeAll(async () => {
    context = loadContext();
    personas = new Personas(ItestConfig.fromEnv());
    await personas.login();
    advisor = personas.as('advisor');
    admin = personas.as('admin');
    tech = personas.as('tech');
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
      booked = await bookAppointment(advisor, 0);
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
      const moved = window(60, 60);

      const rescheduled = await call('rescheduleAppointment', () =>
        advisor.shopManager.appointmentsApi.rescheduleAppointment({
        appointmentId,
        rescheduleAppointmentRequest: {
          newStartAt: moved.startAt,
          newEndAt: moved.endAt,
          reason: RescheduleAppointmentRequestReasonEnum.CustomerRequest,
          rescheduleReasonNotes: `Integration test reschedule [${context.runId}]`,
        },
      }),
      );
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

      const later = window(180, 60);
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
      const appointment = await bookAppointment(advisor, 240);
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
      const { startAt, endAt } = window(300, 60);
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
      await expectHttpError(bookAppointment(tech, 360), 401, 403);
    });

    itInRoleMode('a technician cannot bridge an appointment into an estimate', async () => {
      const appointment = await bookAppointment(advisor, 420);
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
});
