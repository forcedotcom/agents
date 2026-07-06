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
  type AgentType,
  type SimilarSessionResult,
  type FindSimilarSessionsOptions,
  type SimilarityStrategy,
  type TagDefinitionAssociationRecord,
  type TagDefinitionRecord,
} from './agentObserveTypes.js';
import { TagOverlapStrategy } from './strategies/tagOverlapStrategy.js';

export {
  type AgentType,
  type SimilarSessionResult,
  type FindSimilarSessionsOptions,
  type DimensionWeight,
  type SimilarityStrategy,
  type SimilarityContext,
} from './agentObserveTypes.js';
export { TagOverlapStrategy } from './strategies/tagOverlapStrategy.js';

const DEFAULT_LIMIT = 10;
const DEFAULT_STRATEGY = 'tag-overlap';

const SDM_MODELS: Record<AgentType, string> = {
  employee: 'Employee_Agent_Analytics_Extension_861',
  service: 'Service_Agent_Analytics_Extension_861',
};

export class AgentObserve {
  private static strategies: Map<string, SimilarityStrategy> = new Map([
    ['tag-overlap', TagOverlapStrategy],
  ]);

  /**
   * Register a custom similarity strategy.
   */
  public static registerStrategy(strategy: SimilarityStrategy): void {
    AgentObserve.strategies.set(strategy.name, strategy);
  }

  /**
   * List registered strategy names.
   */
  public static getStrategyNames(): string[] {
    return [...AgentObserve.strategies.keys()];
  }

  /**
   * Find sessions similar to a given session.
   * Delegates to the specified strategy (default: tag-overlap).
   */
  public static async findSimilarSessions(
    connection: Connection,
    agentType: AgentType,
    sessionId: string,
    fromTime: string,
    toTime: string,
    options?: FindSimilarSessionsOptions
  ): Promise<SimilarSessionResult[]> {
    const strategyName = options?.strategy ?? DEFAULT_STRATEGY;
    const strategy = AgentObserve.strategies.get(strategyName);

    if (!strategy) {
      throw new SfError(
        `Unknown similarity strategy: "${strategyName}". Available: ${AgentObserve.getStrategyNames().join(', ')}`,
        'UnknownStrategy'
      );
    }

    // Validate input session exists
    const sessionExists = await AgentObserve.sessionExists(connection, sessionId);
    if (!sessionExists) {
      throw new SfError(`Session not found: ${sessionId}`, 'SessionNotFound');
    }

    return strategy.execute({
      connection,
      agentType,
      sessionId,
      fromTime,
      toTime,
      limit: options?.limit ?? DEFAULT_LIMIT,
      weights: options?.weights,
    });
  }

  /**
   * Get the SDM model name for a given agent type.
   */
  public static getModelName(agentType: AgentType): string {
    return SDM_MODELS[agentType];
  }

  /**
   * Get tag definitions scoped to a specific agent instance.
   */
  public static async getAgentTagDefinitions(
    connection: Connection,
    agentApiName: string
  ): Promise<Array<{ id: string; name: string }>> {
    try {
      const assocResult = await AgentObserve.query<{ records: TagDefinitionAssociationRecord[] }>(
        connection,
        `SELECT ssot__AiAgentTagDefinitionId__c FROM ssot__AiAgentTagDefinitionAssociation__dlm WHERE ssot__AiAgentApiName__c = '${AgentObserve.escape(agentApiName)}'`
      );

      if (assocResult.records.length === 0) return [];
      const defIds = assocResult.records.map((r) => r.ssot__AiAgentTagDefinitionId__c);
      return await AgentObserve.getTagDefinitions(connection, defIds);
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await AgentObserve.emitTelemetry('agent_observe_get_agent_tag_defs_failed');
      throw wrapped;
    }
  }

  // ── Internal helpers ──────────────────────────────────────────

  private static async sessionExists(connection: Connection, sessionId: string): Promise<boolean> {
    try {
      const result = await AgentObserve.query<{ totalSize: number }>(
        connection,
        `SELECT ssot__Id__c FROM ssot__AiAgentSession__dlm WHERE ssot__Id__c = '${AgentObserve.escape(sessionId)}' LIMIT 1`
      );
      return result.totalSize > 0;
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await AgentObserve.emitTelemetry('agent_observe_session_exists_failed');
      throw wrapped;
    }
  }

  private static async getTagDefinitions(
    connection: Connection,
    tagDefIds: string[]
  ): Promise<Array<{ id: string; name: string }>> {
    if (tagDefIds.length === 0) return [];
    try {
      const result = await AgentObserve.query<{ records: TagDefinitionRecord[] }>(
        connection,
        `SELECT ssot__Id__c, ssot__Name__c FROM ssot__AiAgentTagDefinition__dlm WHERE ssot__Id__c IN (${tagDefIds.map((id) => `'${AgentObserve.escape(id)}'`).join(',')})`
      );
      return result.records.map((r) => ({ id: r.ssot__Id__c, name: r.ssot__Name__c }));
    } catch (error) {
      const wrapped = SfError.wrap(error);
      await AgentObserve.emitTelemetry('agent_observe_get_tag_defs_failed');
      throw wrapped;
    }
  }

  private static async query<T>(connection: Connection, soql: string): Promise<T> {
    return connection.request<T>({
      method: 'GET',
      url: `/services/data/v${String(connection.version)}/query?q=${encodeURIComponent(soql)}`,
    });
  }

  private static escape(value: string): string {
    return value.replace(/'/g, "\\'");
  }

  private static async emitTelemetry(eventName: string): Promise<void> {
    try {
      await Lifecycle.getInstance().emitTelemetry({ eventName });
    } catch {
      // never let telemetry mask the real error
    }
  }
}
