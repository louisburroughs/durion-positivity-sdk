import { createAccountingClient } from '@durion-sdk/accounting';
import { createCatalogClient } from '@durion-sdk/catalog';
import { createCustomerClient } from '@durion-sdk/customer';
import { createInventoryClient } from '@durion-sdk/inventory';
import { createInvoiceClient } from '@durion-sdk/invoice';
import { SeederAuth, SeederConfig } from '@durion-sdk/seeder';
import { createWorkorderClient } from '@durion-sdk/workorder';
import type { ItestConfig, PersonaName } from './ItestConfig';
import { createShopManagerClient, type ShopManagerClient } from './shopManagerClient';

export interface DomainClients {
  customer: ReturnType<typeof createCustomerClient>;
  workorder: ReturnType<typeof createWorkorderClient>;
  invoice: ReturnType<typeof createInvoiceClient>;
  accounting: ReturnType<typeof createAccountingClient>;
  inventory: ReturnType<typeof createInventoryClient>;
  catalog: ReturnType<typeof createCatalogClient>;
  shopManager: ShopManagerClient;
  /** The identity behind these clients — for labor-attribution assertions. */
  username: string;
  auth: SeederAuth;
}

/**
 * Persona → authenticated-client registry (spec: Personas, Roles, and
 * Credentials). One SeederAuth per distinct login: in single-credential mode
 * every persona shares the admin auth, so there is exactly one login; in
 * role mode each configured persona logs in as itself and unconfigured ones
 * fall back to the shared admin auth.
 */
export class Personas {
  private readonly authsByUsername = new Map<string, SeederAuth>();
  private readonly clientsByPersona = new Map<PersonaName, DomainClients>();
  private loggedIn = false;

  constructor(private readonly config: ItestConfig) {}

  isRoleMode(): boolean {
    return this.config.mode === 'role';
  }

  /** Logs in every distinct identity. Call once per suite file (beforeAll). */
  async login(): Promise<void> {
    const personas: PersonaName[] = ['admin', 'advisor', 'tech', 'manager', 'parts', 'acct'];
    for (const persona of personas) {
      const auth = this.authFor(persona);
      void auth; // creation registers it in authsByUsername
    }
    for (const auth of this.authsByUsername.values()) {
      await auth.login();
    }
    this.loggedIn = true;
  }

  async refreshIfNeeded(): Promise<void> {
    for (const auth of this.authsByUsername.values()) {
      await auth.refreshIfNeeded();
    }
  }

  authFor(persona: PersonaName): SeederAuth {
    const credentials = this.config.credentialsFor(persona);
    let auth = this.authsByUsername.get(credentials.username);
    if (!auth) {
      auth = new SeederAuth(
        SeederConfig.fromValues({
          baseUrl: this.config.baseUrl,
          securityServiceUrl: this.config.securityServiceUrl,
          username: credentials.username,
          password: credentials.password,
          seed: this.config.seed,
        }),
      );
      this.authsByUsername.set(credentials.username, auth);
    }
    return auth;
  }

  as(persona: PersonaName): DomainClients {
    if (!this.loggedIn) {
      throw new Error('Personas.login() must complete before requesting clients');
    }
    let clients = this.clientsByPersona.get(persona);
    if (!clients) {
      const auth = this.authFor(persona);
      clients = {
        customer: createCustomerClient(auth.buildSdkConfig('customer')),
        workorder: createWorkorderClient(auth.buildSdkConfig('workorder')),
        invoice: createInvoiceClient(auth.buildSdkConfig('invoice')),
        accounting: createAccountingClient(auth.buildSdkConfig('accounting')),
        inventory: createInventoryClient(auth.buildSdkConfig('inventory')),
        catalog: createCatalogClient(auth.buildSdkConfig('catalog')),
        shopManager: createShopManagerClient({
          baseUrl: this.config.baseUrl,
          token: () => auth.getToken(),
        }),
        username: this.config.credentialsFor(persona).username,
        auth,
      };
      this.clientsByPersona.set(persona, clients);
    }
    return clients;
  }
}
