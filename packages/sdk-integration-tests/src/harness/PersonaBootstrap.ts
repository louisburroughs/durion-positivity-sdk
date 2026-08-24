// Imported by path, not by package name, for the reason globalSetup.ts spells
// out: Jest applies moduleNameMapper to the suites but NOT to globalSetup, and
// this module is reached from there. By package name these would resolve
// through node_modules to whatever was last built into dist.
import { createPeopleContactClient } from '../../../sdk-people-contact/src';
import { createSecurityClient } from '../../../sdk-security/src';
import type { EmployeeRefs, SeederAuth } from '../../../sdk-seeder/src/lib';
import type { CredentialedPersona, ItestConfig, PersonaName } from './ItestConfig';

/**
 * Role-mode preflight (spec: Task 8).
 *
 * In role mode each persona acts under its own login, so a wrong username or a
 * missing role assignment shows up as a 403 somewhere in the middle of a suite,
 * far from its cause. This runs first and turns that into one error naming
 * every persona that is wrong, in the same collect-then-throw style as
 * {@link ItestConfig}.
 *
 * It is a no-op in single-credential mode: every persona is the admin login,
 * which the reference bootstrap has already exercised.
 */

/** The persona's role, for messages. Verification is by permission, not role. */
const PERSONA_ROLE: Record<CredentialedPersona, string> = {
  advisor: 'SERVICE_ADVISOR',
  tech: 'TECHNICIAN',
  manager: 'LOCATION_MANAGER',
  parts: 'INVENTORY_LEAD',
  acct: 'ACCOUNT_MANAGER',
};

/**
 * The authorities each persona's suite steps actually exercise, taken verbatim
 * from the backend's R__seed_role_permissions.sql. Deliberately a few per
 * persona rather than the whole set: this is a preflight for "is this account
 * wired to the right role", not a re-assertion of the seed.
 */
const REQUIRED_AUTHORITIES: Record<CredentialedPersona, readonly string[]> = {
  advisor: ['appointments:create', 'workorder:estimate:create', 'workorder:estimate:submit'],
  tech: ['workorder:start', 'workorder:labor:add', 'workorder:parts:consume'],
  manager: [
    'workorder:workorder:approve',
    'workorder:workorder:complete',
    'workorder:workorder:assign-technician',
    'order:purchase_order:approve',
    // C6 raises the pick list as the manager precisely because TECHNICIAN
    // cannot; checking it here is what stops that regressing silently.
    'inventory:pick_list:create',
  ],
  parts: [
    'order:purchase_order:create',
    'inventory:asn:create',
    'inventory:goods_receipt:create',
    'inventory:receiving:create',
  ],
  // The acct persona makes exactly one call in the suites - submitting an
  // INVOICE_PAYMENT through accountingEventsApi. Applying payments and managing
  // invoices are ACCOUNT_MANAGER's on paper but nothing here exercises them,
  // and the advisor is what finalizes the invoice.
  acct: ['accounting:events:submit'],
};

/**
 * Personas whose login should point at the matching seeded employee, so labor
 * and assignment views attribute to a real person record.
 *
 * `acct` is absent on purpose: PeopleBootstrap seeds technicians, service
 * writers, a manager and a parts clerk, and no accounting employee, so there is
 * nothing to link it to. That is reported as a limitation, not a failure.
 */
const PERSONA_EMPLOYEE: Partial<Record<CredentialedPersona, (refs: EmployeeRefs) => string | undefined>> =
  {
    advisor: (refs) => refs.serviceWriters[0],
    tech: (refs) => refs.technicians[0],
    manager: (refs) => refs.manager,
    parts: (refs) => refs.partsClerk,
  };

export interface UserSummary {
  id: string;
  username: string;
  roles: string[];
  personId?: string;
}

export type LinkOutcome = 'created' | 'already-linked' | 'linked-elsewhere';

/**
 * The security operations the preflight needs, behind a port so the logic can
 * be tested without HTTP.
 */
export interface PersonaSecurityPort {
  listUsers(): Promise<UserSummary[]>;
  getUserPermissions(userId: string): Promise<string[]>;
  getRoleIdByName(name: string): Promise<string>;
  assignUserRole(userId: string, roleId: string): Promise<void>;
}

export interface PersonaPeoplePort {
  linkUserToPerson(username: string, personId: string): Promise<LinkOutcome>;
}

export interface PersonaBootstrapResult {
  verified: string[];
  assignments: string[];
  links: string[];
  limitations: string[];
}

export class PersonaBootstrap {
  constructor(
    private readonly config: ItestConfig,
    private readonly security: PersonaSecurityPort,
    private readonly people: PersonaPeoplePort,
  ) {}

  /** True when there is anything to preflight at all. */
  get applies(): boolean {
    return this.config.mode === 'role';
  }

  private personas(): CredentialedPersona[] {
    return Object.keys(this.config.personaCredentials) as CredentialedPersona[];
  }

  /**
   * Steps 1 and 2: confirm every configured persona resolves to a user that
   * carries the authorities its suite steps need, granting the parts persona
   * INVENTORY_LEAD if it is the one thing missing.
   *
   * Runs before the reference bootstrap so a misconfigured run fails in
   * seconds rather than after minutes of seeding.
   */
  async verifyAndProvision(): Promise<Pick<PersonaBootstrapResult, 'verified' | 'assignments'>> {
    const verified: string[] = [];
    const assignments: string[] = [];
    const problems: string[] = [];

    const usersByName = new Map<string, UserSummary>();
    for (const user of await this.security.listUsers()) {
      usersByName.set(user.username, user);
    }

    for (const persona of this.personas()) {
      const username = this.config.credentialsFor(persona).username;
      const user = usersByName.get(username);
      if (!user) {
        problems.push(
          `${persona}: no user named "${username}" exists (set ITEST_${persona.toUpperCase()}_USERNAME to a seeded account)`,
        );
        continue;
      }

      // The parts persona is the one the spec expects to need provisioning:
      // on a database seeded before the operational seed grew an INVENTORY_LEAD
      // user, no account holds the role. Additive assignment by id - never
      // assignUserRolesByUsername, which REPLACES the user's whole direct set.
      if (persona === 'parts' && !user.roles.includes(PERSONA_ROLE.parts)) {
        try {
          const roleId = await this.security.getRoleIdByName(PERSONA_ROLE.parts);
          await this.security.assignUserRole(user.id, roleId);
          assignments.push(`${username} granted ${PERSONA_ROLE.parts}`);
        } catch (error) {
          problems.push(
            `parts: "${username}" lacks ${PERSONA_ROLE.parts} and it could not be granted (${describe(error)})`,
          );
          continue;
        }
      }

      let authorities: string[];
      try {
        authorities = await this.security.getUserPermissions(user.id);
      } catch (error) {
        problems.push(`${persona}: could not read permissions for "${username}" (${describe(error)})`);
        continue;
      }

      const held = new Set(authorities);
      const missing = REQUIRED_AUTHORITIES[persona].filter((name) => !held.has(name));
      if (missing.length > 0) {
        problems.push(
          `${persona}: "${username}" is missing ${missing.join(', ')} — expected from ${PERSONA_ROLE[persona]} (holds: ${user.roles.join(', ') || 'no roles'})`,
        );
        continue;
      }

      verified.push(`${persona}=${username}`);
    }

    if (problems.length > 0) {
      throw new Error(
        `Role-mode preflight failed:\n  - ${problems.join('\n  - ')}\n` +
          'See "Task 8" in BACKEND_INTERACTION_TEST_SPEC.md for the persona/account matrix.',
      );
    }

    return { verified, assignments };
  }

  /**
   * Step 3: point each persona's login at the matching seeded employee.
   *
   * Runs after the reference bootstrap, which is what creates the employees.
   * Never fatal: a persona already linked to a different person is a fact about
   * the environment, not a broken run, and the affected assertions are the
   * labor-attribution ones rather than the whole suite.
   */
  async linkPersons(employees: EmployeeRefs): Promise<Pick<PersonaBootstrapResult, 'links' | 'limitations'>> {
    const links: string[] = [];
    const limitations: string[] = [];

    for (const persona of this.personas()) {
      const username = this.config.credentialsFor(persona).username;
      const pick = PERSONA_EMPLOYEE[persona];
      if (!pick) {
        limitations.push(
          `${persona} (${username}) has no seeded employee to link to, so labor attributed to it has no person record`,
        );
        continue;
      }

      const personId = pick(employees);
      if (!personId) {
        limitations.push(`${persona} (${username}): the reference bootstrap produced no employee to link`);
        continue;
      }

      try {
        const outcome = await this.people.linkUserToPerson(username, personId);
        if (outcome === 'linked-elsewhere') {
          limitations.push(
            `${persona} (${username}) is already linked to a different person; labor attribution for it will not match employee ${personId}`,
          );
        } else if (outcome === 'created') {
          links.push(`${username} -> person ${personId}`);
        }
      } catch (error) {
        limitations.push(`${persona} (${username}): linking to person ${personId} failed (${describe(error)})`);
      }
    }

    return { links, limitations };
  }
}

/**
 * The generated clients throw a ResponseError whose message is always
 * "Response returned an error code" and whose useful half - the status and the
 * URL - hangs off `.response`. A preflight problem reading "(Response returned
 * an error code)" says nothing about whether the caller lacked a permission or
 * the role simply does not exist, so pull the status through.
 */
function describe(error: unknown): string {
  const response = (error as { response?: Response } | undefined)?.response;
  const status = typeof response?.status === 'number' ? response.status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  if (status === undefined) {
    return message;
  }
  const url = typeof response?.url === 'string' && response.url.length > 0 ? ` ${response.url}` : '';
  return `HTTP ${status}${url}: ${message}`;
}

/**
 * Builds the ports from the admin login. Both go through the gateway as the
 * authenticated admin rather than the security service's header-auth bypass,
 * so the preflight exercises the same path the suites do.
 */
export function createPersonaPorts(adminAuth: SeederAuth): {
  security: PersonaSecurityPort;
  people: PersonaPeoplePort;
} {
  const securityClient = createSecurityClient(adminAuth.buildSdkConfig('security-service'));
  const peopleContact = createPeopleContactClient(adminAuth.buildSdkConfig('people-contact'));

  return {
    security: {
      async listUsers(): Promise<UserSummary[]> {
        const users = await securityClient.userAPIApi.listUsers();
        return users.map((user) => ({
          id: user.id,
          username: user.username,
          // The generated model types roles as a Set; normalise so callers and
          // tests deal in one shape.
          roles: Array.from(user.roles ?? []),
          personId: user.personId,
        }));
      },
      async getUserPermissions(userId: string): Promise<string[]> {
        const permissions = await securityClient.userRoleManagementApi.getUserPermissions({ userId });
        return Array.from(permissions).map((permission) => permission.name);
      },
      async getRoleIdByName(name: string): Promise<string> {
        const role = await securityClient.roleManagementApi.getRoleByName({ name });
        if (!role.id) {
          throw new Error(`role "${name}" resolved without an id`);
        }
        return role.id;
      },
      async assignUserRole(userId: string, roleId: string): Promise<void> {
        await securityClient.userRoleManagementApi.assignUserRole({ userId, roleId });
      },
    },
    people: {
      async linkUserToPerson(username: string, personId: string): Promise<LinkOutcome> {
        try {
          await peopleContact.userPersonLinkingApi.linkUserToPerson({
            linkUserToPersonRequest: { username, personId },
          });
          // 200 (identical link already present) and 201 (created) are both
          // successes; the generated client does not surface which, and the
          // distinction does not change what the suites can do.
          return 'created';
        } catch (error) {
          const status = (error as { response?: Response } | undefined)?.response?.status;
          if (status === 409) {
            return 'linked-elsewhere';
          }
          throw error;
        }
      },
    },
  };
}

export type { CredentialedPersona, PersonaName };
export { PERSONA_ROLE, REQUIRED_AUTHORITIES };
