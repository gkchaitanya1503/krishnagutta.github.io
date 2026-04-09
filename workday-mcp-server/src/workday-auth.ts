/**
 * Workday OAuth 2.0 Authentication Module
 *
 * Supports:
 * - Client Credentials grant (service-to-service)
 * - Refresh Token grant (user-delegated access)
 * - Automatic token caching and renewal
 */

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
  refreshToken?: string;
}

export class WorkdayAuth {
  private tokenUrl: string;
  private clientId: string;
  private clientSecret: string;
  private refreshToken: string | undefined;
  private cachedToken: CachedToken | null = null;

  constructor(config: {
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    refreshToken?: string;
  }) {
    this.tokenUrl = config.tokenUrl;
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.refreshToken = config.refreshToken;
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - 60_000) {
      return this.cachedToken.accessToken;
    }

    const token = this.refreshToken
      ? await this.requestTokenWithRefresh()
      : await this.requestTokenWithClientCredentials();

    this.cachedToken = {
      accessToken: token.access_token,
      expiresAt: Date.now() + token.expires_in * 1000,
      refreshToken: token.refresh_token,
    };

    if (token.refresh_token) {
      this.refreshToken = token.refresh_token;
    }

    return token.access_token;
  }

  private async requestTokenWithClientCredentials(): Promise<TokenResponse> {
    const params = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.clientId,
      client_secret: this.clientSecret,
    });

    return this.fetchToken(params);
  }

  private async requestTokenWithRefresh(): Promise<TokenResponse> {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken!,
    });

    return this.fetchToken(params);
  }

  private async fetchToken(params: URLSearchParams): Promise<TokenResponse> {
    const response = await fetch(this.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `OAuth token request failed (${response.status}): ${errorBody}`
      );
    }

    return (await response.json()) as TokenResponse;
  }

  invalidateToken(): void {
    this.cachedToken = null;
  }
}
