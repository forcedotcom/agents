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
import type { CompileAgentScriptResponse, AgentJson } from '../src/types';

export const compileAgentScriptResponseSuccess: CompileAgentScriptResponse = {
  status: 'success' as const,
  compiledArtifact: {
    schemaVersion: '2.0',
    globalConfiguration: {
      developerName: 'test_agent_v1',
      label: '',
      description: '',
      enableEnhancedEventLogs: false,
      agentType: '',
      templateName: '',
      defaultAgentUser: '',
      defaultOutboundRouting: '',
      contextVariables: [],
    },
    agentVersion: {
      developerName: 'test_agent_v1',
      plannerType: 'Atlas__ConcurrentMultiAgentOrchestration',
      systemMessages: [],
      modalityParameters: {
        voice: {
          inboundModel: null,
          inboundFillerWordsDetection: null,
          outboundVoice: null,
          outboundModel: null,
          outboundSpeed: null,
          outboundStyleExaggeration: null,
        },
        language: {
          defaultLocale: 'en_US',
          additionalLocales: [],
          allAdditionalLocales: false,
        },
      },
      additionalParameters: false,
      company: 'test',
      role: 'test',
      stateVariables: [],
      initialNode: 'test',
      nodes: [],
      knowledgeDefinitions: null,
    },
  },
  errors: [],
  syntacticMap: {
    blocks: [],
  },
  dslVersion: '0.0.3.rc29',
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

export const validAgentScript = `system:
   instructions: "You are a customer support agent focused on order management and answering general FAQs."
   messages:
      welcome: "Hi, I'm an AI service assistant. How can I help you?"
      error: "Sorry, it looks like something has gone wrong."

config:
    developer_name: "Generic_AI_Assistant"
    default_agent_user: "default_agent_user@salesforce.com"
    agent_label: "Customer Support Agent"
    description: "A customer support agent focused on order management and answering general FAQs."

variables:
    EndUserId: linked string
        source: @MessagingSession.MessagingEndUserId
        description: "This variable may also be referred to as MessagingEndUser Id"

language:
    default_locale: "en_US"
    additional_locales: ""
    all_additional_locales: False

connection messaging:
   escalation_message: "One moment while I connect you to the next available service representative."
   outbound_route_type: "OmniChannelFlow"
   outbound_route_name: "agent_support_flow"
   adaptive_response_allowed: True

start_agent topic_selector:
   description: "Welcome the user and determine the appropriate topic based on user input"

              `;

export const testAgentJson: AgentJson = {
  schemaVersion: '2.0',
  globalConfiguration: {
    developerName: 'test_agent_v1',
    label: 'Test Agent',
    description: 'A test agent',
    agentType: 'AgentforceServiceAgent',
    enableEnhancedEventLogs: false,
    templateName: '',
    defaultAgentUser: 'test@example.com',
    defaultOutboundRouting: '',
    contextVariables: [],
  },
  agentVersion: {
    developerName: 'test_agent_v1',
    company: 'Test Company',
    role: 'Test Role',
    plannerType: 'Atlas__ConcurrentMultiAgentOrchestration',
    systemMessages: [],
    modalityParameters: {
      voice: {
        inboundModel: null,
        inboundFillerWordsDetection: null,
        outboundVoice: null,
        outboundModel: null,
        outboundSpeed: null,
        outboundStyleExaggeration: null,
      },
      language: {
        defaultLocale: 'en_US',
        additionalLocales: [],
        allAdditionalLocales: false,
      },
    },
    additionalParameters: false,
    stateVariables: [],
    initialNode: 'greeting',
    nodes: [],
    knowledgeDefinitions: null,
  },
};
