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
        async (personId: string) => peopleStaffingAssignmentsApi.listStaffingAssignments({ personId }),
        async (request: CreateStaffingAssignmentRequest) =>
          peopleStaffingAssignmentsApi.createStaffingAssignment({ createStaffingAssignmentRequest: request }),
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
    getAssignments: (personId: string) => Promise<StaffingAssignmentResponse[]>,
    createAssignment: (request: CreateStaffingAssignmentRequest) => Promise<StaffingAssignmentResponse>,
  ): Promise<void> {
    try {
      const assignments = await getAssignments(personId);
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

    await createAssignment({
      personId,
      locationId,
      role,
      effectiveFrom: new Date('2024-01-01'),
      isPrimary: true,
    });
  }

  private requireEmployeeId(employee: EmployeeProfileDto, employeeNumber: string): string {
    if (!employee.id) {
      throw new Error(`PeopleBootstrap: employee ${employeeNumber} was created without an id`);
    }
    return employee.id;
  }
}
