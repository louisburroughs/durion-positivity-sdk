import {
  createPeopleClient,
  CreateEmployeeRequestStatusEnum,
  type CreateEmployeeRequest,
  type EmployeeProfileDto,
  type StaffingAssignmentResponse,
  type CreateStaffingAssignmentRequest,
} from '@durion-sdk/people';
import type { DurionSdkConfig } from '@durion-sdk/transport';
import type { EmployeeRefs } from '../support/ReferenceCache';

interface EmployeeSeedDefinition {
  legalName: string;
  employeeNumber: string;
  preferredName?: string;
  hireDate: Date;
  role: string;
  bucket: 'technicians' | 'serviceWriters' | 'manager' | 'partsClerk';
}

interface PeopleBootstrapResult {
  employees: EmployeeRefs;
  employeeNameById: Map<string, string>;
  createdCount: number;
  skippedCount: number;
  created: string[];
  skipped: string[];
}

const EMPLOYEE_SEEDS: EmployeeSeedDefinition[] = [
  {
    legalName: 'James Rivera',
    employeeNumber: 'EMP-T001',
    preferredName: 'James',
    hireDate: new Date('2022-01-10'),
    role: 'TECHNICIAN',
    bucket: 'technicians',
  },
  {
    legalName: 'Marcus Bennett',
    employeeNumber: 'EMP-T002',
    preferredName: 'Marcus',
    hireDate: new Date('2022-04-18'),
    role: 'TECHNICIAN',
    bucket: 'technicians',
  },
  {
    legalName: 'Elena Torres',
    employeeNumber: 'EMP-T003',
    preferredName: 'Elena',
    hireDate: new Date('2023-02-06'),
    role: 'TECHNICIAN',
    bucket: 'technicians',
  },
  {
    legalName: 'Olivia Price',
    employeeNumber: 'EMP-SW001',
    preferredName: 'Olivia',
    hireDate: new Date('2021-09-13'),
    role: 'SERVICE_WRITER',
    bucket: 'serviceWriters',
  },
  {
    legalName: 'Daniel Kim',
    employeeNumber: 'EMP-SW002',
    preferredName: 'Daniel',
    hireDate: new Date('2023-07-24'),
    role: 'SERVICE_WRITER',
    bucket: 'serviceWriters',
  },
  {
    legalName: 'Michelle Carter',
    employeeNumber: 'EMP-M001',
    preferredName: 'Michelle',
    hireDate: new Date('2020-05-04'),
    role: 'MANAGER',
    bucket: 'manager',
  },
  {
    legalName: 'Avery Collins',
    employeeNumber: 'EMP-P001',
    preferredName: 'Avery',
    hireDate: new Date('2022-11-14'),
    role: 'PARTS_CLERK',
    bucket: 'partsClerk',
  },
];

const PERSON_REPLICATION_TIMEOUT_MS = 30_000;
const PERSON_REPLICATION_POLL_MS = 500;
const ASSIGNMENT_LOOKUP_TIMEOUT_MS = 10_000;

/**
 * True when the failure is the staffing endpoint reporting that the person is
 * not yet in its replica. Reads the response body once and tolerates any shape,
 * so a non-JSON error page cannot break the retry decision.
 */
async function isPersonNotFound(error: unknown): Promise<boolean> {
  const response = (error as { response?: Response } | undefined)?.response;
  if (!response || response.status !== 404) {
    return false;
  }
  try {
    return (await response.clone().text()).includes('Person not found');
  } catch {
    return false;
  }
}

export class PeopleBootstrap {
  constructor(private readonly sdkConfig: DurionSdkConfig) {}

  async run(locationId: string): Promise<PeopleBootstrapResult> {
    const { employeeApi, peopleStaffingAssignmentsApi } = createPeopleClient(this.sdkConfig);

    let createdCount = 0;
    let skippedCount = 0;
    const created: string[] = [];
    const skipped: string[] = [];
    const employeeNameById = new Map<string, string>();

    const employeeIndex = await this.buildEmployeeIndex();

    const employees: EmployeeRefs = {
      technicians: [],
      serviceWriters: [],
      manager: '',
      partsClerk: '',
    };

    for (const seed of EMPLOYEE_SEEDS) {
      const label = seed.preferredName ?? seed.legalName;
      let employeeId = employeeIndex.get(seed.employeeNumber);
      if (!employeeId) {
        // The regenerated API takes firstName/lastName instead of a single
        // legalName; split the seed's legal name at the last space.
        const nameParts = seed.legalName.trim().split(/\s+/);
        const lastName = nameParts.length > 1 ? nameParts[nameParts.length - 1] : seed.legalName;
        const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : seed.legalName;
        const createEmployeeRequest: CreateEmployeeRequest = {
          firstName,
          lastName,
          preferredName: seed.preferredName,
          employeeNumber: seed.employeeNumber,
          status: CreateEmployeeRequestStatusEnum.Active,
          hireDate: seed.hireDate,
        };

        const createdEmployee = await employeeApi.createEmployee({ createEmployeeRequest });
        employeeId = this.requireEmployeeId(createdEmployee, seed.employeeNumber);
        employeeIndex.set(seed.employeeNumber, employeeId);
        created.push(label);
        createdCount += 1;
      } else {
        skipped.push(label);
        skippedCount += 1;
      }

      employeeNameById.set(employeeId, label);

      await this.ensureAssignment(
        employeeId,
        seed.role,
        locationId,
        async (personId: string, initOverrides?: RequestInit) =>
          peopleStaffingAssignmentsApi.listStaffingAssignments({ personId }, initOverrides),
        async (request: CreateStaffingAssignmentRequest, initOverrides?: RequestInit) =>
          peopleStaffingAssignmentsApi.createStaffingAssignment(
            { createStaffingAssignmentRequest: request },
            initOverrides,
          ),
      );

      switch (seed.bucket) {
        case 'technicians':
          employees.technicians.push(employeeId);
          break;
        case 'serviceWriters':
          employees.serviceWriters.push(employeeId);
          break;
        case 'manager':
          employees.manager = employeeId;
          break;
        case 'partsClerk':
          employees.partsClerk = employeeId;
          break;
      }
    }

    return {
      employees,
      employeeNameById,
      createdCount,
      skippedCount,
      created,
      skipped,
    };
  }

  private async buildEmployeeIndex(): Promise<Map<string, string>> {
    const employeeIndex = new Map<string, string>();
    for (const seed of EMPLOYEE_SEEDS) {
      const personId = await this.resolvePersonIdByEmployeeNumber(seed.employeeNumber);
      if (personId) {
        employeeIndex.set(seed.employeeNumber, personId);
      }
    }

    return employeeIndex;
  }

  private async resolvePersonIdByEmployeeNumber(employeeNumber: string): Promise<string | undefined> {
    const token = this.sdkConfig.token ? await this.sdkConfig.token() : undefined;
    const response = await fetch(
      `${this.sdkConfig.baseUrl}/v1/people/employees/by-number/${encodeURIComponent(employeeNumber)}`,
      {
        method: 'GET',
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'X-API-Version': '1',
          'X-Correlation-Id': crypto.randomUUID(),
        },
      },
    );

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(
        `PeopleBootstrap: employee lookup by number failed for ${employeeNumber} (${response.status} ${response.statusText})`,
      );
    }

    const payload = (await response.json()) as { personId?: unknown };
    return typeof payload.personId === 'string' ? payload.personId : undefined;
  }

  private async ensureAssignment(
    personId: string,
    role: string,
    locationId: string,
    getAssignments: (
      personId: string,
      initOverrides?: RequestInit,
    ) => Promise<StaffingAssignmentResponse[]>,
    createAssignment: (
      request: CreateStaffingAssignmentRequest,
      initOverrides?: RequestInit,
    ) => Promise<StaffingAssignmentResponse>,
  ): Promise<void> {
    try {
      const assignments = await getAssignments(personId, {
        signal: AbortSignal.timeout(ASSIGNMENT_LOOKUP_TIMEOUT_MS),
      });
      const existing = assignments.find(
        (assignment) =>
          assignment.locationId === locationId &&
          assignment.role === role &&
          assignment.isPrimary &&
          assignment.status === 'ACTIVE',
      );

      if (existing) {
        return;
      }
    } catch {
      // Fall through to create the assignment when list retrieval is unavailable.
    }

    // The person this employee points at is created asynchronously: pos-people
    // writes a command to its outbox, pos-people-contact creates the Person, and
    // pos-people replicates it back into ext_people_contact_person. The staffing
    // endpoint validates against that replica, so an assignment issued
    // immediately after createEmployee loses a race it cannot see - observed at
    // 138ms after creation, against a 1s outbox poll.
    await this.createAssignmentWhenPersonReplicated(personId, (initOverrides) =>
      createAssignment(
        {
          personId,
          locationId,
          role,
          effectiveFrom: new Date('2024-01-01'),
          isPrimary: true,
        },
        initOverrides,
      ),
    );
  }

  /**
   * Retries an assignment while the person is still propagating.
   *
   * Only "Person not found" 404s are retried: any other failure - an unknown
   * location, an inactive person, a malformed request - is returned immediately
   * rather than being hidden behind a timeout.
   */
  private async createAssignmentWhenPersonReplicated(
    personId: string,
    attempt: (initOverrides: RequestInit) => Promise<StaffingAssignmentResponse>,
  ): Promise<void> {
    const deadline = Date.now() + PERSON_REPLICATION_TIMEOUT_MS;
    let waited = false;
    let lastError: unknown;

    for (;;) {
      // Bound each request by what is left of the deadline. fetch applies no
      // request timeout of its own, so without an abort signal a stalled
      // connection would park inside attempt() and the deadline check below
      // would never be reached. The signal also covers reading the error body.
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw (
          lastError ??
          new Error(`PeopleBootstrap: timed out waiting for person ${personId} to replicate`)
        );
      }

      try {
        await attempt({ signal: AbortSignal.timeout(remaining) });
        if (waited) {
          console.log(`[Bootstrap] Person ${personId} replicated; assignment created.`);
        }
        return;
      } catch (error) {
        if (!(await isPersonNotFound(error))) {
          throw error;
        }
        lastError = error;
        if (!waited) {
          console.log(`[Bootstrap] Waiting for person ${personId} to replicate...`);
          waited = true;
        }
        await new Promise((resolve) => setTimeout(resolve, PERSON_REPLICATION_POLL_MS));
      }
    }
  }

  private requireEmployeeId(employee: EmployeeProfileDto, employeeNumber: string): string {
    if (!employee.id) {
      throw new Error(`PeopleBootstrap: employee ${employeeNumber} was created without an id`);
    }
    return employee.id;
  }
}
