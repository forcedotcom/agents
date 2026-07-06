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

import { Connection } from '@salesforce/core';

export type AgentType = 'employee' | 'service';

export type DimensionWeight = {
  name: string;
  weight: number;
};

export type FindSimilarSessionsOptions = {
  limit?: number;
  weights?: DimensionWeight[];
  strategy?: string;
};

export type SimilarSessionResult = {
  sessionId: string;
  score: number;
  matchedDimensions: string[];
};

export type SimilarityContext = {
  connection: Connection;
  agentType: AgentType;
  sessionId: string;
  fromTime: string;
  toTime: string;
  limit: number;
  weights?: DimensionWeight[];
};

export type SimilarityStrategy = {
  readonly name: string;
  execute(context: SimilarityContext): Promise<SimilarSessionResult[]>;
};

export type SessionTagProfile = {
  sessionId: string;
  tags: Array<{
    tagId: string;
    value: string;
    tagDefinitionId: string;
  }>;
};

// SOQL record types for DLM tables

export type TagAssociationRecord = {
  ssot__AiAgentTagId__c: string;
  ssot__AiAgentSessionId__c: string;
  ssot__CreatedDate__c?: string;
};

export type TagRecord = {
  ssot__Id__c: string;
  ssot__Value__c: string;
  ssot__AiAgentTagDefinitionId__c: string;
};

export type TagDefinitionRecord = {
  ssot__Id__c: string;
  ssot__Name__c: string;
};

export type TagDefinitionAssociationRecord = {
  ssot__AiAgentTagDefinitionId__c: string;
};
