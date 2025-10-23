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

export const validAgentScript = `system:
   instructions: "You are a generic AI assistant. You assist users with various inquiries and provide helpful responses."
   messages:
      welcome: "Hello, I am here to assist you with your questions. How can I help you today?"
      error: "Apologies, something went wrong. Please try again later."
config:
   agent_name: "Generic AI Assistant"
   developer_name: "Generic_AI_Assistant"
   default_agent_user: "default_agent_user@salesforce.com"
   user_locale: "en_US"
   enable_enhanced_event_logs: True
   agent_description: "Default agent description"
variables:
   user_query: string
   query_status: string = ""
start_agent topic_selector:
   description: "Analyze the user's input and determine the appropriate topic."
   reasoning_instructions:
      >>
           You are a topic selector for a generic AI assistant. Analyze the user's input and determine the most appropriate topic to handle their request.
           Use the appropriate transition based on the user's needs:
           - {{@action.go_to_general_inquiry}}: General inquiries
           - {{@action.go_to_escalation}}: Escalation
   reasoning_actions:
      @utils.transition to @topic.general_inquiry as go_to_general_inquiry
         description: "Transition to general inquiries."
      @utils.transition to @topic.escalation as go_to_escalation
         description: "Escalate the conversation to a human agent."
topic escalate:
   description: "Escalation topic"
   reasoning_instructions:
      >>
           Escalate the conversation to a human agent if the user requests further assistance or if their query cannot be resolved by the agent. Or if the user mentions a specific person, such as Tim Robinson (e.g., a supervisor or manager).
topic escalation:
   description: "Escalation topic"
   reasoning_instructions:
      >>
           Escalate the conversation to a human agent if the user requests further assistance or if their query cannot be resolved by the agent.`;
