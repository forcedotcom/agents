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

// TypeScript shapes derived from shared-api-catalog-connect-api.yaml (v64.0).
// Field names mirror the Connect API representations 1:1.

export type McpServerType = 'EXTERNAL';
export type McpAuthType = 'OAUTH' | 'NO_AUTH';
export type McpAssetKind = 'MCP_TOOL' | 'MCP_PROMPT' | 'MCP_RESOURCE';

// ── MCP servers ───────────────────────────────────────────────

export type McpServerAuthorizationOutput = {
  authType: McpAuthType;
  identityProvider?: string;
  scope?: string;
};

export type McpServerAuthorizationInput = {
  authType: McpAuthType;
  identityProvider?: string;
  clientId?: string;
  clientSecret?: string;
  scope?: string;
};

export type McpServerOutput = {
  id: string;
  name: string;
  label?: string;
  description?: string;
  type: McpServerType;
  status: string;
  serverUrl?: string;
  authorization?: McpServerAuthorizationOutput;
  createdById?: string;
  createdDate?: string;
  lastModifiedById?: string;
  lastModifiedDate?: string;
};

export type McpServerCollection = {
  mcpServers: McpServerOutput[];
};

export type McpServerCreateInput = {
  name: string;
  label?: string;
  description?: string;
  type: McpServerType;
  serverUrl: string;
  authorization?: McpServerAuthorizationInput;
};

export type McpServerUpdateInput = {
  label?: string;
  description?: string;
  serverUrl?: string;
  authorization?: McpServerAuthorizationInput;
};

export type McpFetchedAsset = {
  id?: string;
  name: string;
  label?: string;
  description?: string;
  kind: McpAssetKind;
  active?: boolean;
  availableAsAgentAction?: boolean;
  status?: string;
};

export type McpServerCreateOutput = {
  server: McpServerOutput;
  assets: McpFetchedAsset[];
};

export type McpServerFetchOutput = {
  assets: McpFetchedAsset[];
};

export type McpServerAssetOutput = {
  id: string;
  name: string;
  label?: string;
  description?: string;
  kind: McpAssetKind;
  active: boolean;
  availableAsAgentAction?: boolean;
};

export type McpServerAssetCollection = {
  assets: McpServerAssetOutput[];
};

export type McpServerAssetReplaceItem = {
  id?: string;
  name?: string;
  label?: string;
  description?: string;
  active?: boolean;
  kind?: McpAssetKind;
};

export type McpServerAssetReplaceInput = {
  assets: McpServerAssetReplaceItem[];
};

/**
 * MCP connection status values the server may return on a server record.
 * NOTE: only `ACTIVE` and `DISCONNECTED` are accepted by the `status` query
 * filter on `listMcpServers`; the others can appear on output but are rejected
 * (HTTP 400) if used as a filter value.
 */
export type McpConnectionStatus =
  | 'ACTIVE'
  | 'INCOMPLETE'
  | 'INVALID'
  | 'INACTIVE'
  | 'NOT_APPLICABLE'
  | 'CUSTOM'
  | 'DISCONNECTED';

/** Status values accepted by the `listMcpServers` `status` query filter. */
export type McpServerStatusFilter = 'ACTIVE' | 'DISCONNECTED';

// Query option bag.
export type ListMcpServersOptions = { label?: string; type?: McpServerType; status?: McpServerStatusFilter };
