import { SeederConfig } from '../SeederConfig';

const SYSADMIN_ROLE_NAME = 'SYSTEM_ADMINISTRATOR';

interface PermissionPage {
  content: Array<{ name: string }>;
  totalPages: number;
  number: number;
}

/**
 * Bootstraps the SYSTEM_ADMINISTRATOR role permissions by calling the security
 * service directly (bypassing the gateway) using the GatewayHeaderAuthenticationFilter
 * mechanism. This is necessary because role_permissions is not seeded by SQL
 * migrations — it is managed at runtime via the API.
 *
 * Must run BEFORE auth.login() so the resulting JWT contains all permission bits.
 */
export class SecurityBootstrap {
  constructor(private readonly config: SeederConfig) {}

  async run(): Promise<void> {
    const baseUrl = this.config.securityServiceUrl;

    const permissionNames = await this.fetchAllPermissionNames(baseUrl);

    if (permissionNames.length === 0) {
      console.log('[SecurityBootstrap] No permissions found — skipping role grant.');
      return;
    }

    const roleId = await this.resolveSysAdminRoleId(baseUrl);
    await this.grantPermissionsToSysAdmin(baseUrl, roleId, permissionNames);

    console.log(
      `[SecurityBootstrap] Granted ${permissionNames.length} permissions to SYSTEM_ADMINISTRATOR.`,
    );

    await this.ensureSysAdminRole(baseUrl, roleId);

    console.log(
      `[SecurityBootstrap] Confirmed SYSTEM_ADMINISTRATOR role is assigned to "${this.config.username}".`,
    );
  }

  /**
   * Header-auth identity for the security service, plus the tenant when one is
   * configured. The service binds the tenant from X-Tenant-Id; without it an
   * unbound request falls to the deploy's transitional default (or 401
   * TENANT_REQUIRED when there is none), which need not be the tenant the
   * seeder logs in to. These calls bypass the gateway, so the header arrives.
   */
  private headers(authority: string): Record<string, string> {
    const headers: Record<string, string> = {
      'X-Authorities': authority,
      'X-User': 'seeder-bootstrap',
      'Content-Type': 'application/json',
    };
    if (this.config.tenantId) {
      headers['X-Tenant-Id'] = this.config.tenantId;
    }
    return headers;
  }

  /**
   * Roles are tenant-scoped (row-level security) and each tenant's copy of a
   * template role has its own id, so the role is found by name in the bound
   * tenant rather than by a constant that only ever matched alpha.
   */
  private async resolveSysAdminRoleId(baseUrl: string): Promise<string> {
    const url = `${baseUrl}/v1/roles/by-name/${encodeURIComponent(SYSADMIN_ROLE_NAME)}`;
    const response = await fetch(url, { method: 'GET', headers: this.headers('security:role:view') });
    if (!response.ok) {
      throw new Error(
        `[SecurityBootstrap] Failed to resolve ${SYSADMIN_ROLE_NAME}: ${response.status} ${response.statusText} at ${url}`,
      );
    }
    const role = (await response.json()) as { id?: string };
    if (!role.id) {
      throw new Error(`[SecurityBootstrap] ${SYSADMIN_ROLE_NAME} resolved without an id`);
    }
    return role.id;
  }

  private async fetchAllPermissionNames(baseUrl: string): Promise<string[]> {
    const names: string[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const url = `${baseUrl}/v1/permissions?page=${page}&size=500`;
      const response = await fetch(url, {
        method: 'GET',
        headers: this.headers('security:permission:view'),
      });

      if (!response.ok) {
        throw new Error(
          `[SecurityBootstrap] Failed to list permissions: ${response.status} ${response.statusText} at ${url}`,
        );
      }

      const body = (await response.json()) as PermissionPage;
      for (const perm of body.content) {
        names.push(perm.name);
      }

      totalPages = body.totalPages;
      page += 1;
    }

    return names;
  }

  private async grantPermissionsToSysAdmin(baseUrl: string, roleId: string, permissionNames: string[]): Promise<void> {
    const url = `${baseUrl}/v1/roles/permissions`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: this.headers('security:role:edit'),
      body: JSON.stringify({
        roleId,
        permissionNames,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `[SecurityBootstrap] Failed to grant permissions to SYSTEM_ADMINISTRATOR: ${response.status} ${response.statusText} — ${body}`,
      );
    }
  }

  private async ensureSysAdminRole(baseUrl: string, roleId: string): Promise<void> {
    const usersUrl = `${baseUrl}/v1/users`;
    const usersResponse = await fetch(usersUrl, {
      method: 'GET',
      headers: this.headers('security:user:view'),
    });

    if (!usersResponse.ok) {
      throw new Error(
        `[SecurityBootstrap] Failed to list users: ${usersResponse.status} ${usersResponse.statusText}`,
      );
    }

    const users = (await usersResponse.json()) as Array<{ id?: string; username?: string }>;
    const user = users.find((u) => u.username === this.config.username);

    if (!user?.id) {
      throw new Error(
        `[SecurityBootstrap] Login user "${this.config.username}" not found — cannot assign SYSTEM_ADMINISTRATOR role`,
      );
    }

    const assignUrl = `${baseUrl}/v1/users/${encodeURIComponent(user.id)}/roles/${encodeURIComponent(roleId)}`;
    const assignResponse = await fetch(assignUrl, {
      method: 'PUT',
      headers: this.headers('security:role:assign'),
    });

    if (!assignResponse.ok) {
      const body = await assignResponse.text();
      throw new Error(
        `[SecurityBootstrap] Failed to assign SYSTEM_ADMINISTRATOR to "${this.config.username}": ${assignResponse.status} ${assignResponse.statusText} — ${body}`,
      );
    }
  }
}
