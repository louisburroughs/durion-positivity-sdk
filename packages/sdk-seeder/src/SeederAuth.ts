import {
  AuthAPIApi,
  createSecurityClient,
  JWTAPIApi,
  SecurityAuthWorkflow,
  TokenPairResponse,
} from '@durion-sdk/security';
import { DurionSdkConfig } from '@durion-sdk/transport';
import { SeederConfig } from './SeederConfig';

interface TokenState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 36_000_000;
const REFRESH_THRESHOLD_MS = 60_000;

export class SeederAuth {
  private tokenState: TokenState | null = null;
  private readonly workflow: SecurityAuthWorkflow;

  constructor(private readonly config: SeederConfig) {
    const sdkConfig: DurionSdkConfig = { baseUrl: this.gatewayBaseUrl('security-service') };
    const securityClient = createSecurityClient(sdkConfig);

    this.workflow = new SecurityAuthWorkflow(
      securityClient.authAPIApi as AuthAPIApi,
      securityClient.jwtAPIApi as JWTAPIApi,
    );
  }

  private gatewayBaseUrl(servicePrefix: string): string {
    return `${this.config.baseUrl}/${servicePrefix}`;
  }

  async login(): Promise<void> {
    const result = await this.workflow.login({
      loginRequest: {
        username: this.config.username,
        password: this.config.password,
      },
    });

    this.tokenState = this.toTokenState(result, 'Login response missing tokens');
    console.log('[Auth] Login successful.');
  }

  getToken(): string {
    if (!this.tokenState) {
      throw new Error('SeederAuth: not logged in - call login() first');
    }
    return this.tokenState.accessToken;
  }

  async refreshIfNeeded(): Promise<void> {
    if (!this.tokenState) {
      throw new Error('SeederAuth: not logged in');
    }
    if (Date.now() < this.tokenState.expiresAt - REFRESH_THRESHOLD_MS) {
      return;
    }

    const result = await this.workflow.refresh({
      refreshTokenRequest: {
        refreshToken: this.tokenState.refreshToken,
      },
    });

    this.tokenState = this.toTokenState(result, 'Refresh response missing tokens');
    console.log('[Auth] Token refreshed.');
  }

  buildSdkConfig(servicePrefix: string): DurionSdkConfig {
    return {
      baseUrl: this.gatewayBaseUrl(servicePrefix),
      token: () => this.getToken(),
    };
  }

  private toTokenState(result: TokenPairResponse, errorMessage: string): TokenState {
    if (!result.accessToken || !result.refreshToken) {
      throw new Error(errorMessage);
    }

    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresAt: Date.now() + TOKEN_TTL_MS,
    };
  }
}
