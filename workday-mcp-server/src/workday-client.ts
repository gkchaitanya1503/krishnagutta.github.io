/**
 * Generic Workday REST API Client
 *
 * Handles authenticated requests to Workday REST API v1 endpoints
 * with automatic pagination, error handling, and token refresh.
 */

import { WorkdayAuth } from "./workday-auth.js";

export interface WorkdayRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: Record<string, unknown>;
  queryParams?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export interface WorkdayPaginatedResponse<T = unknown> {
  data: T[];
  total: number;
}

export class WorkdayClient {
  private auth: WorkdayAuth;
  private baseUrl: string;
  private raasUrl: string | undefined;

  constructor(config: {
    baseUrl: string;
    auth: WorkdayAuth;
    raasUrl?: string;
  }) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.auth = config.auth;
    this.raasUrl = config.raasUrl?.replace(/\/$/, "");
  }

  async request<T = unknown>(
    endpoint: string,
    options: WorkdayRequestOptions = {}
  ): Promise<T> {
    const { method = "GET", body, queryParams, headers = {} } = options;

    const url = new URL(`${this.baseUrl}${endpoint}`);
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const token = await this.auth.getAccessToken();

    const response = await fetch(url.toString(), {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401) {
      this.auth.invalidateToken();
      const retryToken = await this.auth.getAccessToken();
      const retryResponse = await fetch(url.toString(), {
        method,
        headers: {
          Authorization: `Bearer ${retryToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!retryResponse.ok) {
        const errorBody = await retryResponse.text();
        throw new Error(
          `Workday API error (${retryResponse.status}): ${errorBody}`
        );
      }

      return (await retryResponse.json()) as T;
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Workday API error (${response.status}): ${errorBody}`
      );
    }

    return (await response.json()) as T;
  }

  async getPaginated<T = unknown>(
    endpoint: string,
    options: WorkdayRequestOptions = {},
    limit: number = 100,
    offset: number = 0
  ): Promise<WorkdayPaginatedResponse<T>> {
    const queryParams = {
      ...options.queryParams,
      limit: limit,
      offset: offset,
    };

    const result = await this.request<{ data: T[]; total: number }>(endpoint, {
      ...options,
      queryParams,
    });

    return {
      data: result.data ?? [],
      total: result.total ?? 0,
    };
  }

  async requestRaas<T = unknown>(
    reportOwner: string,
    reportName: string,
    queryParams?: Record<string, string>
  ): Promise<T> {
    if (!this.raasUrl) {
      throw new Error(
        "RAAS URL not configured. Set WORKDAY_RAAS_URL in your environment."
      );
    }

    const url = new URL(`${this.raasUrl}/${reportOwner}/${reportName}`);
    url.searchParams.set("format", "json");
    if (queryParams) {
      for (const [key, value] of Object.entries(queryParams)) {
        url.searchParams.set(key, value);
      }
    }

    const token = await this.auth.getAccessToken();

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `Workday RAAS error (${response.status}): ${errorBody}`
      );
    }

    return (await response.json()) as T;
  }
}
