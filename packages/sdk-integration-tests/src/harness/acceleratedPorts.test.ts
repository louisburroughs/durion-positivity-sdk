import { SeederRandom } from '@durion-sdk/seeder';
import { createAppointmentPort, refusedDecisions } from './acceleratedPorts';
import type { BuilderContext } from './builders';
import type { DomainClients } from './personas';
import { ShopCalendar } from './shopCalendar';
import type { SiteRoster } from '../runs/shopFloorPlan';

describe('refusedDecisions', () => {
  it('is empty when every entry asked about was approved', () => {
    const response = {
      results: [
        { timeEntryId: 'te-1', success: true, message: 'Time entry approved' },
        { timeEntryId: 'te-2', success: true },
      ],
    };

    expect(refusedDecisions(response, ['te-1', 'te-2'])).toEqual([]);
  });

  it('names the entries a 200 batch refused, with their codes', () => {
    const response = {
      results: [
        { timeEntryId: 'te-1', success: true },
        { timeEntryId: 'te-2', success: false, errorCode: 'ENTRY_NOT_PENDING', message: 'not pending' },
      ],
    };

    expect(refusedDecisions(response, ['te-1', 'te-2'])).toEqual(['te-2 (ENTRY_NOT_PENDING: not pending)']);
  });

  it('counts an entry with no result as refused', () => {
    expect(refusedDecisions({ results: [] }, ['te-1'])).toEqual(['te-1 (no result)']);
    expect(refusedDecisions({}, ['te-1'])).toEqual(['te-1 (no result)']);
  });
});

describe('createAppointmentPort (#148)', () => {
  const site = (locationId: string, bays: number, technicians: number): SiteRoster => ({
    locationId,
    code: locationId.toUpperCase(),
    name: locationId,
    freePositions: Array.from({ length: bays }, (_, i) => ({ kind: 'BAY' as const, id: `${locationId}-bay-${i}`, name: `Bay ${i}` })),
    occupiedPositions: [],
    idleTechnicianIds: Array.from({ length: technicians }, (_, i) => `${locationId}-tech-${i}`),
    busyTechnicianIds: [],
  });

  const fakePort = () => {
    const created: Array<{ locationId: string; resourceType?: string; resourceId?: string }> = [];
    let sequence = 0;
    const advisor = {
      shopManager: {
        scheduleApi: {
          searchOpenings: async ({ locationId }: { locationId: string }) => ({
            openings: [0, 1, 2].map((slot) => ({
              bayId: `${locationId}-bay-${slot}`,
              startAt: new Date(`2025-11-10T1${slot}:00:00Z`),
              endAt: new Date(`2025-11-10T1${slot + 1}:00:00Z`),
              localDate: '2025-11-10',
            })),
          }),
        },
        appointmentsApi: {
          createAppointment: async ({ appointmentCreateRequest }: { appointmentCreateRequest: Record<string, string> }) => {
            created.push({
              locationId: appointmentCreateRequest.locationId,
              resourceType: appointmentCreateRequest.resourceType,
              resourceId: appointmentCreateRequest.resourceId,
            });
            sequence += 1;
            return { appointmentId: `appt-${sequence}` };
          },
        },
      },
      workorder: {
        estimatesFromAppointmentsApi: {
          createEstimateFromAppointment: async ({
            createEstimateFromAppointmentRequest,
          }: {
            createEstimateFromAppointmentRequest: { appointmentId: string; locationId: string };
          }) => ({ estimateId: `est-${createEstimateFromAppointmentRequest.appointmentId}` }),
        },
      },
    };
    const port = createAppointmentPort({
      advisor: advisor as unknown as DomainClients,
      admin: {} as DomainClients,
      ctx: {
        runId: 'r',
        random: new SeederRandom(42),
        refs: { serviceEntityIds: ['svc-1'], serviceNameById: new Map([['svc-1', 'Oil change']]) },
      } as unknown as BuilderContext,
      calendar: new ShopCalendar({
        weekday: { openMinutes: 8 * 60, closeMinutes: 18 * 60 },
        saturday: { openMinutes: 9 * 60, closeMinutes: 13 * 60 },
        sunday: null,
        holidays: new Set<string>(),
        graceMinutes: 90,
        mobileAfterHours: true,
      }),
      leadDaysMin: 1,
      leadDaysMax: 3,
      customerFor: async () => ({ partyId: 'party', fullName: 'Pat Doe', vehicleId: 'veh' }),
    });
    return { port, created };
  };

  it('books on a bay, at sites in proportion to their bay capacity over the run', async () => {
    const { port, created } = fakePort();
    // Bay capacity 4 and 1; each day books one per site that can take bay work.
    const rosters = [site('main', 4, 4), site('riv', 3, 1)];
    const booked: string[] = [];
    for (let day = 0; day < 5; day += 1) {
      await port.book(new Date('2025-11-03T08:00:00Z'), rosters, (locationId) => booked.push(locationId));
    }

    expect(created.every((request) => request.resourceType === 'BAY' && request.resourceId?.startsWith(request.locationId))).toBe(true);
    expect(booked.filter((id) => id === 'main')).toHaveLength(8);
    expect(booked.filter((id) => id === 'riv')).toHaveLength(2);
  });

  it('tries every opening it was given when slots turn out to be taken', async () => {
    const { port, created } = fakePort();
    let refusals = 2;
    // Three openings come back; the first two are taken by the time they are booked.
    const original = created.push.bind(created);
    created.push = (...items) => {
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new Error('409 CONFLICT: already booked'), {});
      }
      return original(...items);
    };

    const booked = await port.book(new Date('2025-11-03T08:00:00Z'), [site('riv', 2, 2)]);

    expect(booked).toBe(1);
    expect(created).toHaveLength(1);
  });

  it('queues a converted appointment as an arrival at its own site until a job takes it', async () => {
    const { port } = fakePort();
    await port.book(new Date('2025-11-03T08:00:00Z'), [site('riv', 2, 2)]);

    expect(port.arrivals()).toEqual([]);
    await port.convertDue(new Date('2025-11-20T08:00:00Z'));

    const [arrival] = port.arrivals();
    expect(arrival).toMatchObject({ locationId: 'riv', estimateId: `est-${arrival.appointmentId}` });
    expect(arrival.customer).toEqual({ partyId: 'party', fullName: 'Pat Doe' });

    port.startArrival(arrival.appointmentId);
    expect(port.arrivals()).toEqual([]);
  });
});
