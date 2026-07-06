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
  type SimilarityStrategy,
  type SimilarityContext,
  type SimilarSessionResult,
  type DimensionWeight,
  type SessionTagProfile,
  type TagRecord,
  type TagAssociationRecord,
  type TagDefinitionRecord,
} from '../agentObserveTypes.js';

// ── Internal helpers ──────────────────────────────────────────

function resolveWeight(tagDefName: string, weights?: DimensionWeight[]): number {
  if (!weights || weights.length === 0) return 1;
  const match = weights.find((w) => w.name === tagDefName);
  return match?.weight ?? 1;
}

async function query<T>(connection: Connection, soql: string): Promise<T> {
  return connection.request<T>({
    method: 'GET',
    url: `/services/data/v${String(connection.version)}/query?q=${encodeURIComponent(soql)}`,
  });
}

function escape(value: string): string {
  return value.replace(/'/g, "\\'");
}

async function emitTelemetry(eventName: string): Promise<void> {
  try {
    await Lifecycle.getInstance().emitTelemetry({ eventName });
  } catch {
    // never let telemetry mask the real error
  }
}

async function getSessionTagProfile(connection: Connection, sessionId: string): Promise<SessionTagProfile> {
  try {
    const assocResult = await query<{ totalSize: number; records: TagAssociationRecord[] }>(
      connection,
      `SELECT ssot__AiAgentTagId__c, ssot__AiAgentSessionId__c FROM ssot__AiAgentTagAssociation__dlm WHERE ssot__AiAgentSessionId__c = '${escape(sessionId)}'`
    );

    if (assocResult.totalSize === 0) {
      return { sessionId, tags: [] };
    }

    const tagIds = [...new Set(assocResult.records.map((r) => r.ssot__AiAgentTagId__c))];
    const tagResult = await query<{ totalSize: number; records: TagRecord[] }>(
      connection,
      `SELECT ssot__Id__c, ssot__Value__c, ssot__AiAgentTagDefinitionId__c FROM ssot__AiAgentTag__dlm WHERE ssot__Id__c IN (${tagIds.map((id) => `'${escape(id)}'`).join(',')})`
    );

    const tags = tagResult.records.map((r) => ({
      tagId: r.ssot__Id__c,
      value: r.ssot__Value__c,
      tagDefinitionId: r.ssot__AiAgentTagDefinitionId__c,
    }));

    return { sessionId, tags };
  } catch (error) {
    const wrapped = SfError.wrap(error);
    await emitTelemetry('agent_observe_tag_overlap_get_profile_failed');
    throw wrapped;
  }
}

async function getTagDefinitions(
  connection: Connection,
  tagDefIds: string[]
): Promise<Array<{ id: string; name: string }>> {
  if (tagDefIds.length === 0) return [];
  try {
    const result = await query<{ records: TagDefinitionRecord[] }>(
      connection,
      `SELECT ssot__Id__c, ssot__Name__c FROM ssot__AiAgentTagDefinition__dlm WHERE ssot__Id__c IN (${tagDefIds.map((id) => `'${escape(id)}'`).join(',')})`
    );
    return result.records.map((r) => ({ id: r.ssot__Id__c, name: r.ssot__Name__c }));
  } catch (error) {
    const wrapped = SfError.wrap(error);
    await emitTelemetry('agent_observe_tag_overlap_get_defs_failed');
    throw wrapped;
  }
}

async function findSessionsByTags(
  connection: Connection,
  tagIds: string[],
  fromTime: string,
  toTime: string
): Promise<Array<{ sessionId: string; tagId: string }>> {
  if (tagIds.length === 0) return [];
  try {
    const result = await query<{ records: TagAssociationRecord[] }>(
      connection,
      `SELECT ssot__AiAgentSessionId__c, ssot__AiAgentTagId__c FROM ssot__AiAgentTagAssociation__dlm WHERE ssot__AiAgentTagId__c IN (${tagIds.map((id) => `'${escape(id)}'`).join(',')}) AND ssot__CreatedDate__c >= ${fromTime} AND ssot__CreatedDate__c <= ${toTime} LIMIT 2000`
    );
    return result.records.map((r) => ({
      sessionId: r.ssot__AiAgentSessionId__c,
      tagId: r.ssot__AiAgentTagId__c,
    }));
  } catch (error) {
    const wrapped = SfError.wrap(error);
    await emitTelemetry('agent_observe_tag_overlap_find_sessions_failed');
    throw wrapped;
  }
}

// ── Strategy export ─────────────────────────────────────────────

export const TagOverlapStrategy: SimilarityStrategy = {
  name: 'tag-overlap',

  async execute(context: SimilarityContext): Promise<SimilarSessionResult[]> {
    const { connection, sessionId, fromTime, toTime, limit, weights } = context;

    // 1. Get the input session's tag profile
    const profile = await getSessionTagProfile(connection, sessionId);
    if (profile.tags.length === 0) {
      return [];
    }

    // 2. Resolve tag definition names for weight lookup
    const tagDefIds = [...new Set(profile.tags.map((t) => t.tagDefinitionId))];
    const tagDefs = await getTagDefinitions(connection, tagDefIds);
    const tagDefNameById = new Map(tagDefs.map((d) => [d.id, d.name]));

    // 3. For each tag, find candidate sessions within the time window
    const candidateScores = new Map<string, { score: number; matchedDimensions: string[] }>();
    const tagIds = profile.tags.map((t) => t.tagId);

    const candidates = await findSessionsByTags(connection, tagIds, fromTime, toTime);

    for (const candidate of candidates) {
      if (candidate.sessionId === sessionId) continue;

      const matchedTag = profile.tags.find((t) => t.tagId === candidate.tagId);
      if (!matchedTag) continue;

      const defName = tagDefNameById.get(matchedTag.tagDefinitionId) ?? 'unknown';
      const weight = resolveWeight(defName, weights);

      const existing = candidateScores.get(candidate.sessionId);
      if (existing) {
        existing.score += weight;
        if (!existing.matchedDimensions.includes(defName)) {
          existing.matchedDimensions.push(defName);
        }
      } else {
        candidateScores.set(candidate.sessionId, { score: weight, matchedDimensions: [defName] });
      }
    }

    if (candidateScores.size === 0) {
      return [];
    }

    // 4. Sort by score descending, return top-K
    const sorted = [...candidateScores.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit);

    // Normalize scores to 0-1 range
    const maxScore = sorted[0][1].score;
    return sorted.map(([sid, data]) => ({
      sessionId: sid,
      score: maxScore > 0 ? data.score / maxScore : 0,
      matchedDimensions: data.matchedDimensions,
    }));
  },
};
