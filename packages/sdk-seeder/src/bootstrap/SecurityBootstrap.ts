import { SeederConfig } from '../SeederConfig';

/**
 * UUID of the SYSTEM_ADMINISTRATOR role as seeded in R__seed_reference_security.sql.
 * This role is assigned to the seeder's login user (marcus.webb).
 */
const SYSADMIN_ROLE_ID = 'e9b3e6ba-af10-08ff-0376-1f2fa60d5093';

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

    await this.grantPermissionsToSysAdmin(baseUrl, permissionNames);

    console.log(
      `[SecurityBootstrap] Granted ${permissionNames.length} permissions to SYSTEM_ADMINISTRATOR.`,
    );
  }

  private async fetchAllPermissionNames(baseUrl: string): Promise<string[]> {
    const names: string[] = [];
    let page = 0;
    let totalPages = 1;

    while (page < totalPages) {
      const url = `${baseUrl}/v1/permissions?page=${page}&size=500`;
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'X-Authorities': 'security:permission:view',
          'X-User': 'seeder-bootstrap',
          'Content-Type': 'application/json',
        },
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

  private async grantPermissionsToSysAdmin(baseUrl: string, permissionNames: string[]): Promise<void> {
    const url = `${baseUrl}/v1/roles/permissions`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'X-Authorities': 'security:role:edit',
        'X-User': 'seeder-bootstrap',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        roleId: SYSADMIN_ROLE_ID,
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
}
