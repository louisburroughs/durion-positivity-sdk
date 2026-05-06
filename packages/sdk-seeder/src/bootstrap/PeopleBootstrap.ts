import {
  createPeopleClient,
  CreateEmployeeRequestStatusEnum,
  type CreateEmployeeRequest,
  type EmployeeProfileDto,
  type Person,
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
  createdCount: number;
  skippedCount: number;
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
    const { employeeApi, peopleApi, peopleStaffingAssignmentsApi } = createPeopleClient(this.sdkConfig);

    let createdCount = 0;
    let skippedCount = 0;

    const people = await peopleApi.getAllPeople();
    const employeeIndex = await this.buildEmployeeIndex(
      people,
      async (personId: string) => employeeApi.getEmployee({ employeeId: personId }),
    );

    const employees: EmployeeRefs = {
      technicians: [],
      serviceWriters: [],
      manager: '',
      partsClerk: '',
    };

    for (const seed of EMPLOYEE_SEEDS) {
      let employeeId = employeeIndex.get(seed.employeeNumber);
      if (!employeeId) {
        const createEmployeeRequest: CreateEmployeeRequest = {
          legalName: seed.legalName,
          preferredName: seed.preferredName,
          employeeNumber: seed.employeeNumber,
          status: CreateEmployeeRequestStatusEnum.Active,
          hireDate: seed.hireDate,
        };

        const createdEmployee = await employeeApi.createEmployee({ createEmployeeRequest });
        employeeId = this.requireEmployeeId(createdEmployee, seed.employeeNumber);
        employeeIndex.set(seed.employeeNumber, employeeId);
        createdCount += 1;
      } else {
        skippedCount += 1;
      }

      await this.ensureAssignment(
        employeeId,
        seed.role,
        locationId,
        async (personId: string) => peopleStaffingAssignmentsApi.getAssignments1({ personId }),
        async (request: CreateStaffingAssignmentRequest) =>
          peopleStaffingAssignmentsApi.createAssignment1({ createStaffingAssignmentRequest: request }),
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
      createdCount,
      skippedCount,
    };
  }

  private async buildEmployeeIndex(
    people: Person[],
    getEmployee: (personId: string) => Promise<EmployeeProfileDto>,
  ): Promise<Map<string, string>> {
    const employeeIndex = new Map<string, string>();

    for (const person of people) {
      const personId = this.extractPersonId(person);
      if (!personId) {
        continue;
      }

      try {
        const employee = await getEmployee(personId);
        if (employee.employeeNumber && employee.id) {
          employeeIndex.set(employee.employeeNumber, employee.id);
        }
      } catch {
        continue;
      }
    }

    return employeeIndex;
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

  private extractPersonId(person: Person): string | undefined {
    if ('id' in person && typeof person.id === 'string') {
      return person.id;
    }
    return undefined;
  }

  private requireEmployeeId(employee: EmployeeProfileDto, employeeNumber: string): string {
    if (!employee.id) {
      throw new Error(`PeopleBootstrap: employee ${employeeNumber} was created without an id`);
    }
    return employee.id;
  }
}
