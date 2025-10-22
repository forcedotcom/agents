/*
 * Copyright 2025, Salesforce, Inc.
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
export const compileAgentScriptResponseSuccess = {
  status: 'success',
  compiledArtifact: {
    schemaVersion: '2.0',
    globalConfiguration: {
      developerName: 'test_agent_v1',
    },
    agentVersion: {
      developerName: 'test_agent_v1',
      plannerType: 'Atlas__ConcurrentMultiAgentOrchestration',
      systemMessages: [],
      modalityParameters: {
        voice: null,
        language: null,
      },
      additionalParameters: null,
      company: null,
      role: null,
      stateVariables: [],
      initialNode: null,
      nodes: [],
      knowledgeDefinitions: null,
    },
  },
};

export const compileAgentScriptResponseFailure = {
  status: 'failure',
  compiledArtifact: null,
  errors: [
    {
      errorType: 'SyntaxError',
      description: 'Invalid syntax in agent script',
      lineStart: 5,
      lineEnd: 5,
      colStart: 10,
      colEnd: 20,
    },
  ],
  syntacticMap: {
    blocks: [],
  },
  dslVersion: '0.0.3.rc29',
};