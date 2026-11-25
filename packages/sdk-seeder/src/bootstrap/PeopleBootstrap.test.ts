import { createPeopleClient, type JobRoleRefDto, type StaffingAssignmentResponse } from '@durion-sdk/people';
import type { DurionSdkConfig } from '@durion-sdk/transport';
import { calendarDateIn, isEffectiveFrom, PeopleBootstrap, starterTitleFor } from './PeopleBootstrap';

jest.mock('@durion-sdk/people', () => ({
  ...jest.requireActual('@durion-sdk/people'),
  createPeopleClient: jest.fn(),
}));

const LOCATION_ID = 'location-1';
/** The virtual today of an accelerated run, a year behind wall time. */
const STAFFED_ON = '2025-12-02';

/** A staffing record's job title; the position is the wire string. */
function title(code: string, positionType: string): JobRoleRefDto {
  return { id: `title-${code}`, code, name: code, positionType } as JobRoleRefDto;
}

function assignment(overrides: Partial<StaffingAssignmentResponse> = {}): StaffingAssignmentResponse {
  return {
    assignmentId: 'assignment-1',
    personId: 'person-1',
    locationId: LOCATION_ID,
    jobRole: title('TECHNICIAN', 'TECHNICIAN'),
    isPrimary: true,
    status: 'ACTIVE',
    effectiveFrom: new Date('2024-01-01'),
    ...overrides,
  } as StaffingAssignmentResponse;
}

describe('calendarDateIn', () => {
  it('reads the date in the given zone, not in UTC', () => {
    // 03:00 UTC is still the previous evening in New York.
    expect(calendarDateIn(new Date('2025-12-02T03:00:00Z'), 'America/New_York')).toBe('2025-12-01');
    expect(calendarDateIn(new Date('2025-12-02T03:00:00Z'), 'UTC')).toBe('2025-12-02');
  });
});

describe('starterTitleFor', () => {
  it('staffs each seed role in one of the backend\'s starter titles', () => {
    expect(['TECHNICIAN', 'SERVICE_WRITER', 'PARTS_CLERK', 'MANAGER'].map((role) => starterTitleFor(role))).toEqual([
      { code: 'TECHNICIAN', name: 'Technician', positionType: 'TECHNICIAN' },
      { code: 'SERVICE_ADVISOR', name: 'Service advisor', positionType: 'SERVICE_ADVISOR' },
      { code: 'PARTS_COUNTER', name: 'Parts counter', positionType: 'PARTS' },
      { code: 'LOCATION_MANAGER', name: 'Location manager', positionType: 'MANAGEMENT' },
    ]);
  });

  it('refuses a role it has no title for', () => {
    expect(() => starterTitleFor('JANITOR')).toThrow(/no starter job title for seed role JANITOR/);
  });
});

describe('isEffectiveFrom', () => {
  it('accepts an open-ended assignment that started on or before the date', () => {
    expect(isEffectiveFrom(assignment({ effectiveFrom: new Date('2024-01-01') }), STAFFED_ON)).toBe(true);
    expect(isEffectiveFrom(assignment({ effectiveFrom: new Date(STAFFED_ON) }), STAFFED_ON)).toBe(true);
  });

  it('refuses an assignment that starts after the date', () => {
    // Written at wall time on a long-lived alpha: ten months after the virtual now.
    expect(isEffectiveFrom(assignment({ effectiveFrom: new Date('2026-09-20') }), STAFFED_ON)).toBe(false);
    expect(isEffectiveFrom(assignment({ effectiveFrom: new Date('2025-12-03') }), STAFFED_ON)).toBe(false);
  });

  it('refuses an assignment with an end date, even a later one', () => {
    expect(
      isEffectiveFrom(assignment({ effectiveTo: new Date('2026-06-30') }), STAFFED_ON),
    ).toBe(false);
  });
});

describe('PeopleBootstrap staffing', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.resetAllMocks();
  });

  /** Every seed employee already exists, and each holds the given assignments. */
  function mockPeople(assignments: (personId: string) => StaffingAssignmentResponse[]) {
    global.fetch = jest.fn(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ personId: `person-${decodeURIComponent(url.split('/').pop() ?? '')}` }),
    })) as unknown as typeof fetch;

    const peopleStaffingAssignmentsApi = {
      listStaffingAssignments: jest.fn(async ({ personId }: { personId: string }) => assignments(personId)),
      createStaffingAssignment: jest.fn().mockResolvedValue(assignment()),
    };
    // The tenant holds the starter TECHNICIAN and SERVICE_ADVISOR titles, the
    // latter in another case; the other two are created.
    const jobRoleApi = {
      listJobRoles: jest.fn().mockResolvedValue([
        { id: 'title-TECHNICIAN', code: 'TECHNICIAN' },
        { id: 'title-SERVICE_ADVISOR', code: 'service_advisor' },
      ]),
      createJobRole: jest.fn(async ({ createJobRoleRequest }: { createJobRoleRequest: { code: string } }) => ({
        id: `title-${createJobRoleRequest.code}`,
        code: createJobRoleRequest.code,
      })),
    };
    (createPeopleClient as jest.Mock).mockReturnValue({
      employeeApi: { createEmployee: jest.fn() },
      jobRoleApi,
      peopleStaffingAssignmentsApi,
    });
    return Object.assign(peopleStaffingAssignmentsApi, jobRoleApi);
  }

  /** A primary, ACTIVE assignment matching each seed's own role, starting on `from`. */
  const holding = (from: string) => (personId: string) => {
    const roles: Record<string, string> = {
      'person-EMP-T001': 'TECHNICIAN',
      'person-EMP-T002': 'TECHNICIAN',
      'person-EMP-T003': 'TECHNICIAN',
      'person-EMP-SW001': 'SERVICE_WRITER',
      'person-EMP-SW002': 'SERVICE_WRITER',
      'person-EMP-M001': 'MANAGER',
      'person-EMP-P001': 'PARTS_CLERK',
    };
    const starter = starterTitleFor(roles[personId]);
    return [
      assignment({
        personId,
        jobRole: title(starter.code, starter.positionType),
        effectiveFrom: new Date(from),
      }),
    ];
  };

  const run = () => new PeopleBootstrap({ baseUrl: 'http://people' } as DurionSdkConfig).run(LOCATION_ID, STAFFED_ON);

  it('reuses assignments already effective on the staffing date', async () => {
    const api = mockPeople(holding('2024-01-01'));

    const result = await run();

    expect(api.createStaffingAssignment).not.toHaveBeenCalled();
    expect(result.employees.technicians).toHaveLength(3);
  });

  it('uses the tenant\'s title when it has the code, in any case, and creates only the ones it lacks', async () => {
    const api = mockPeople(holding('2024-01-01'));

    await run();

    expect(api.createJobRole).toHaveBeenCalledTimes(2);
    expect(api.createJobRole).toHaveBeenCalledWith({
      createJobRoleRequest: { code: 'PARTS_COUNTER', name: 'Parts counter', positionType: 'PARTS' },
    });
    expect(api.createJobRole).toHaveBeenCalledWith({
      createJobRoleRequest: { code: 'LOCATION_MANAGER', name: 'Location manager', positionType: 'MANAGEMENT' },
    });
    expect(api.createStaffingAssignment).not.toHaveBeenCalled();
  });

  it('staffs a service writer in the tenant\'s service advisor title', async () => {
    const api = mockPeople(() => []);

    await run();

    expect(api.createStaffingAssignment).toHaveBeenCalledWith(
      {
        createStaffingAssignmentRequest: expect.objectContaining({
          personId: 'person-EMP-SW001',
          jobRoleId: 'title-SERVICE_ADVISOR',
        }),
      },
      expect.anything(),
    );
  });

  it('does not count an assignment in another title as the seed\'s staffing', async () => {
    const api = mockPeople((personId) => [
      assignment({
        personId,
        jobRole: title('OTHER', 'OTHER'),
      }),
    ]);

    await run();

    expect(api.createStaffingAssignment).toHaveBeenCalledTimes(7);
  });

  it('refuses to report a shop staffed by assignments that start after the staffing date', async () => {
    const api = mockPeople(holding('2026-09-20'));

    await expect(run()).rejects.toThrow(
      /EMP-T001 .* none is effective from 2025-12-02 onwards: assignment-1 \(2026-09-20 to open\)/,
    );
    expect(api.createStaffingAssignment).not.toHaveBeenCalled();
  });

  it('creates a back-dated assignment when the employee holds none', async () => {
    const api = mockPeople(() => []);

    await run();

    expect(api.createStaffingAssignment).toHaveBeenCalledTimes(7);
    expect(api.createStaffingAssignment).toHaveBeenCalledWith(
      {
        createStaffingAssignmentRequest: expect.objectContaining({
          personId: 'person-EMP-T001',
          jobRoleId: 'title-TECHNICIAN',
          effectiveFrom: new Date('2024-01-01'),
          isPrimary: true,
        }),
      },
      expect.anything(),
    );
  });
});
