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

import { Connection, SfError } from '@salesforce/core';
import { emitTelemetry, getHttpStatusCode } from './utils';
import { CtxLogger } from './ctxLogger';

// Shapes of POST /connect/genai-mcp/agent-script/actions, from Core genaimcp-openapi-spec.yaml
// (McpAgentScriptActionRepresentation / McpAgentScriptActionsRepresentation).
export type McpAgentScriptActionOutput = {
  toolId: string;
  genAiFunctionId: string;
  name: string;
  source: string;
  target: string;
  actionBlock: string;
  reasoningReference: string;
};

export type McpAgentScriptActionsOutput = {
  actions: McpAgentScriptActionOutput[];
};

// The agent-script actions API needs API version 68.0 or later (task spec for W-24729191).
const MIN_API_VERSION = 68;

let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('McpAgentScript');
  }
  return logger;
};

function actionsUrl(connection: Connection): string {
  const v = Number.parseFloat(String(connection.version));
  const version = Number.isNaN(v) || v < MIN_API_VERSION ? MIN_API_VERSION : v;
  return `/services/data/v${version.toFixed(1)}/connect/genai-mcp/agent-script/actions`;
}

/**
 * Client for the Core Connect API that returns the Agent Script for MCP tools, the same blocks the
 * Agent Builder writes.
 */
export class McpAgentScript {
  /**
   * POST /connect/genai-mcp/agent-script/actions.
   * Returns the Agent Script action block and reasoning reference per MCP tool id, in request order.
   * Not read-only: like Agent Builder, the call also assigns the MCP runtime permissions for the tools.
   * Uses the connection API version, or 68.0 when that is lower.
   */
  public static async generateActions(connection: Connection, toolIds: string[]): Promise<McpAgentScriptActionsOutput> {
    const url = actionsUrl(connection);
    const start = Date.now();
    try {
      const result = await connection.request<McpAgentScriptActionsOutput>({
        method: 'POST',
        url,
        body: JSON.stringify({ toolIds }),
        // Connect REST HTML-encodes strings by default (" -> &quot;); the blocks must be pasted as returned.
        headers: { 'Content-Type': 'application/json', 'X-Chatter-Entity-Encoding': 'false' },
      });
      await emitTelemetry('mcp_agent_script_generate_actions_success');
      return result;
    } catch (error) {
      const wrapped = SfError.wrap(error);
      getLogger().debug('MCP agent script actions request failed; rethrowing to the caller', {
        url,
        toolCount: toolIds.length,
        durationMs: Date.now() - start,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      await emitTelemetry('mcp_agent_script_generate_actions_failed', error);
      throw wrapped;
    }
  }
}
