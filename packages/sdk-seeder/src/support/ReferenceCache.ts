export interface EmployeeRefs {
  technicians: string[];
  serviceWriters: string[];
  manager: string;
  partsClerk: string;
}

export interface ReferenceCache {
  locationId: string;
  bayIds: string[];
  employees: EmployeeRefs;
  serviceEntityIds: string[];
  productEntityIds: string[];
  serviceNameById: Map<string, string>;
  productNameById: Map<string, string>;
  employeeNameById: Map<string, string>;
}
