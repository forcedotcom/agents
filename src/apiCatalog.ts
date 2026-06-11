/*
 * Copyright 2026, Salesforce, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { Connection, Lifecycle, SfError } from '@salesforce/core';
import {
  type ListMcpServersOptions,
  type McpServerCollection,
  type McpServerCreateInput,
  type McpServerCreateOutput,
  type McpServerOutput,
  type McpServerUpdateInput,
  type McpServerFetchOutput,
  type McpServerAssetCollection,
  type McpServerAssetReplaceInput,
} from './apiCatalogTypes.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function base(connection: Connection): string {
  return `/services/data/v${String(connection.version)}/api-catalog`;
}

function encode(...segments: string[]): string {
  return segments.map((s) => encodeURIComponent(s)).join('/');
}

/**
 * Thin client over the API Catalog Connect API. Every method is a one-to-one
 * wrapper around a Connect endpoint via `connection.request`, mirroring the
 * shape of `AgentDataLibrary` from `@salesforce/agents`.
 */
export class ApiCatalog {
  // ── MCP servers (CRUD) ──────────────────────────────────────

  /** GET /api-catalog/mcp-servers */
  public static async listMcpServers(
    connection: Connection,
    options?: ListMcpServersOptions
  ): Promise<McpServerCollection> {
    const params = new URLSearchParams();
    if (options?.label) params.set('label', options.label);
    if (options?.type) params.set('type', options.type);
    if (options?.status) params.set('status', options.status);
    const qs = params.toString();
    const url = qs ? `${base(connection)}/mcp-servers?${qs}` : `${base(connection)}/mcp-servers`;
    return ApiCatalog.request<McpServerCollection>(connection, 'GET', url, 'listMcpServers');
  }

  /** POST /api-catalog/mcp-servers */
  public static async createMcpServer(
    connection: Connection,
    input: McpServerCreateInput
  ): Promise<McpServerCreateOutput> {
    return ApiCatalog.request<McpServerCreateOutput>(
      connection,
      'POST',
      `${base(connection)}/mcp-servers`,
      'createMcpServer',
      input
    );
  }

  /** GET /api-catalog/mcp-servers/{id} */
  public static async getMcpServer(connection: Connection, id: string): Promise<McpServerOutput> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}`;
    return ApiCatalog.request<McpServerOutput>(connection, 'GET', url, 'getMcpServer');
  }

  /** PUT /api-catalog/mcp-servers/{id} */
  public static async updateMcpServer(
    connection: Connection,
    id: string,
    input: McpServerUpdateInput
  ): Promise<McpServerOutput> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}`;
    return ApiCatalog.request<McpServerOutput>(connection, 'PUT', url, 'updateMcpServer', input);
  }

  /** DELETE /api-catalog/mcp-servers/{id} */
  public static async deleteMcpServer(connection: Connection, id: string): Promise<void> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}`;
    await ApiCatalog.request<unknown>(connection, 'DELETE', url, 'deleteMcpServer');
  }

  /** POST /api-catalog/mcp-servers/{id}/fetch */
  public static async fetchMcpServer(connection: Connection, id: string): Promise<McpServerFetchOutput> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}/fetch`;
    return ApiCatalog.request<McpServerFetchOutput>(connection, 'POST', url, 'fetchMcpServer');
  }

  /** GET /api-catalog/mcp-servers/{id}/assets */
  public static async listMcpServerAssets(connection: Connection, id: string): Promise<McpServerAssetCollection> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}/assets`;
    return ApiCatalog.request<McpServerAssetCollection>(connection, 'GET', url, 'listMcpServerAssets');
  }

  /** PUT /api-catalog/mcp-servers/{id}/assets */
  public static async replaceMcpServerAssets(
    connection: Connection,
    id: string,
    input: McpServerAssetReplaceInput
  ): Promise<McpServerAssetCollection> {
    const url = `${base(connection)}/mcp-servers/${encode(id)}/assets`;
    return ApiCatalog.request<McpServerAssetCollection>(connection, 'PUT', url, 'replaceMcpServerAssets', input);
  }

  // ── Shared request helper ───────────────────────────────────

  private static async request<T>(
    connection: Connection,
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    op: string,
    body?: unknown
  ): Promise<T> {
    const req: { method: typeof method; url: string; body?: string; headers?: Record<string, string> } = {
      method,
      url,
    };
    if (body !== undefined) {
      req.body = JSON.stringify(body);
      req.headers = JSON_HEADERS;
    }

    let result: T;
    try {
      result = await connection.request<T>(req);
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await ApiCatalog.emitTelemetry(`api_catalog_${op}_failed`);
      throw wrapped;
    }

    // Emit a success event for mutating operations, mirroring AgentDataLibrary.
    if (method !== 'GET') {
      await ApiCatalog.emitTelemetry(`api_catalog_${op}_success`);
    }
    return result;
  }

  /** Best-effort telemetry — never let a telemetry failure mask the real result or error. */
  private static async emitTelemetry(eventName: string): Promise<void> {
    try {
      await Lifecycle.getInstance().emitTelemetry({ eventName });
    } catch {
      // telemetry is best-effort
    }
  }
}
