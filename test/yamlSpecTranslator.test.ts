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

/* eslint-disable camelcase */

import { expect } from 'chai';
import type { TestCase } from '../src/types';
import { isYamlTestSpec, parseTestSpec, translateTestCase, translateTestSpec } from '../src/yamlSpecTranslator';

describe('yamlSpecTranslator', () => {
  describe('isYamlTestSpec', () => {
    it('returns true for valid YAML TestSpec content', () => {
      const yaml = `
name: My_Test
subjectType: AGENT
subjectName: My_Agent
testCases:
  - utterance: 'Hello'
`;
      expect(isYamlTestSpec(yaml)).to.equal(true);
    });

    it('returns false for JSON EvalPayload content', () => {
      const json = JSON.stringify({ tests: [{ id: 'test1', steps: [] }] });
      expect(isYamlTestSpec(json)).to.equal(false);
    });

    it('returns false for invalid/empty content', () => {
      expect(isYamlTestSpec('')).to.equal(false);
      expect(isYamlTestSpec('   ')).to.equal(false);
      expect(isYamlTestSpec('not: [valid: yaml: {')).to.equal(false);
    });

    it('returns false for YAML that is not a TestSpec (missing testCases)', () => {
      const yaml = `
name: Something
subjectName: Agent_1
description: A description but no testCases
`;
      expect(isYamlTestSpec(yaml)).to.equal(false);
    });

    it('returns false for YAML missing subjectName', () => {
      const yaml = `
name: Something
testCases:
  - utterance: 'Hello'
`;
      expect(isYamlTestSpec(yaml)).to.equal(false);
    });
  });

  describe('parseTestSpec', () => {
    it('parses valid YAML into a TestSpec', () => {
      const yaml = `
name: Order_Test
description: Order tests
subjectType: AGENT
subjectName: Order_Agent
testCases:
  - utterance: 'Where is my order?'
    expectedTopic: Order_Lookup
`;
      const spec = parseTestSpec(yaml);
      expect(spec.name).to.equal('Order_Test');
      expect(spec.subjectName).to.equal('Order_Agent');
      expect(spec.testCases).to.have.length(1);
      expect(spec.testCases[0].utterance).to.equal('Where is my order?');
    });

    it('throws on invalid content', () => {
      expect(() => parseTestSpec('[]')).to.throw('expected a YAML object');
    });

    it('throws when testCases is missing', () => {
      const yaml = `
name: Bad
subjectName: Agent
`;
      expect(() => parseTestSpec(yaml)).to.throw('missing testCases');
    });

    it('throws when subjectName is missing', () => {
      const yaml = `
name: Bad
testCases: []
`;
      expect(() => parseTestSpec(yaml)).to.throw('missing subjectName');
    });
  });

  describe('translateTestCase', () => {
    it('creates basic steps: create_session, send_message, get_state', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: 'Greeting',
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const types = result.steps.map((s) => s.type);
      expect(types).to.include('agent.create_session');
      expect(types).to.include('agent.send_message');
      expect(types).to.include('agent.get_state');
    });

    it('adds planner_topic_assertion when expectedTopic present', () => {
      const tc: TestCase = {
        utterance: 'Check order',
        expectedTopic: 'Order_Lookup',
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const topicStep = result.steps.find((s) => s.type === 'evaluator.planner_topic_assertion');
      expect(topicStep).to.exist;
      expect(topicStep!.expected).to.equal('Order_Lookup');
      expect(topicStep!.actual).to.equal('{gs.response.planner_response.lastExecution.topic}');
      expect(topicStep!.operator).to.equal('contains');
      expect(topicStep!.id).to.equal('check_topic');
    });

    it('adds planner_actions_assertion when expectedActions non-empty', () => {
      const tc: TestCase = {
        utterance: 'Check order',
        expectedTopic: undefined,
        expectedActions: ['Get_Order', 'Send_Email'],
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const actionsStep = result.steps.find((s) => s.type === 'evaluator.planner_actions_assertion');
      expect(actionsStep).to.exist;
      expect(actionsStep!.expected).to.deep.equal(['Get_Order', 'Send_Email']);
      expect(actionsStep!.actual).to.equal('{gs.response.planner_response.lastExecution.invokedActions}');
      expect(actionsStep!.operator).to.equal('includes_items');
      expect(actionsStep!.id).to.equal('check_actions');
    });

    it('does not add planner_actions_assertion when expectedActions is empty array', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: [],
        expectedOutcome: 'Greet user',
      };
      const result = translateTestCase(tc, 0);
      const actionsStep = result.steps.find((s) => s.type === 'evaluator.planner_actions_assertion');
      expect(actionsStep).to.be.undefined;
    });

    it('adds bot_response_rating when expectedOutcome present', () => {
      const tc: TestCase = {
        utterance: 'Where is my order?',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: 'The agent should provide order status',
      };
      const result = translateTestCase(tc, 0);
      const outcomeStep = result.steps.find((s) => s.type === 'evaluator.bot_response_rating');
      expect(outcomeStep).to.exist;
      expect(outcomeStep!.expected).to.equal('The agent should provide order status');
      expect(outcomeStep!.actual).to.equal('{sm.response}');
      expect(outcomeStep!.utterance).to.equal('Where is my order?');
      expect(outcomeStep!.threshold).to.equal(3.0);
      expect(outcomeStep!.id).to.equal('check_outcome');
    });

    it('generates all evaluators when all expected fields present', () => {
      const tc: TestCase = {
        utterance: 'Check order #123',
        expectedTopic: 'Order_Lookup',
        expectedActions: ['Get_Order_Status'],
        expectedOutcome: 'Should show order status',
      };
      const result = translateTestCase(tc, 0);
      const types = result.steps.map((s) => s.type);
      expect(types).to.include('evaluator.planner_topic_assertion');
      expect(types).to.include('evaluator.planner_actions_assertion');
      expect(types).to.include('evaluator.bot_response_rating');
    });

    it('uses correct shorthand refs for session_id', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: 'Greeting',
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const sendMsg = result.steps.find((s) => s.id === 'sm');
      expect(sendMsg!.session_id).to.equal('{cs.session_id}');
      const getState = result.steps.find((s) => s.id === 'gs');
      expect(getState!.session_id).to.equal('{cs.session_id}');
    });

    it('skips get_state when no topic/actions/custom evaluations need it', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: 'The agent greets the user',
      };
      const result = translateTestCase(tc, 0);
      const getState = result.steps.find((s) => s.type === 'agent.get_state');
      expect(getState).to.be.undefined;
    });

    it('skips get_state when expectedActions is empty array and no topic', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: [],
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const getState = result.steps.find((s) => s.type === 'agent.get_state');
      expect(getState).to.be.undefined;
    });
  });

  describe('conversation history', () => {
    it('creates send_message steps for user messages in history', () => {
      const tc: TestCase = {
        utterance: 'And what about order #456?',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        conversationHistory: [
          { role: 'user', message: 'Where is my order #123?' },
          { role: 'agent', message: 'Let me check that for you.', topic: 'Order_Lookup' },
          { role: 'user', message: 'Thanks, also check #456' },
        ],
      };
      const result = translateTestCase(tc, 0);
      const historySteps = result.steps.filter((s) => s.id.toString().startsWith('history_'));
      expect(historySteps).to.have.length(2);
      expect(historySteps[0].utterance).to.equal('Where is my order #123?');
      expect(historySteps[1].utterance).to.equal('Thanks, also check #456');
    });

    it('skips agent messages in conversation history', () => {
      const tc: TestCase = {
        utterance: 'Follow up',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        conversationHistory: [
          { role: 'agent', message: 'How can I help?', topic: 'General' },
          { role: 'user', message: 'I need help' },
          { role: 'agent', message: 'Sure thing.', topic: 'General' },
        ],
      };
      const result = translateTestCase(tc, 0);
      const historySteps = result.steps.filter((s) => s.id.toString().startsWith('history_'));
      expect(historySteps).to.have.length(1);
      expect(historySteps[0].utterance).to.equal('I need help');
    });

    it('orders history steps before test utterance', () => {
      const tc: TestCase = {
        utterance: 'Final question',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        conversationHistory: [{ role: 'user', message: 'First question' }],
      };
      const result = translateTestCase(tc, 0);
      const ids = result.steps.map((s) => s.id);
      const historyIndex = ids.indexOf('history_0');
      const smIndex = ids.indexOf('sm');
      expect(historyIndex).to.be.lessThan(smIndex);
    });

    it('assigns sequential IDs (history_0, history_1)', () => {
      const tc: TestCase = {
        utterance: 'Third message',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        conversationHistory: [
          { role: 'user', message: 'First' },
          { role: 'user', message: 'Second' },
        ],
      };
      const result = translateTestCase(tc, 0);
      const historySteps = result.steps.filter((s) => s.id.toString().startsWith('history_'));
      expect(historySteps[0].id).to.equal('history_0');
      expect(historySteps[1].id).to.equal('history_1');
    });

    it('handles empty conversation history', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        conversationHistory: [],
      };
      const result = translateTestCase(tc, 0);
      const historySteps = result.steps.filter((s) => s.id.toString().startsWith('history_'));
      expect(historySteps).to.have.length(0);
    });
  });

  describe('custom evaluations', () => {
    it('translates string_comparison to evaluator.string_assertion', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Check greeting',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'contains', isReference: false },
              { name: 'actual', value: '$.generatedData.outcome', isReference: true },
              { name: 'expected', value: 'hello', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep).to.exist;
      expect(customStep!.type).to.equal('evaluator.string_assertion');
    });

    it('translates numeric_comparison to evaluator.numeric_assertion', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Check score',
            name: 'numeric_comparison',
            parameters: [
              { name: 'operator', value: 'greater_than', isReference: false },
              { name: 'actual', value: '$.generatedData.outcome', isReference: true },
              { name: 'expected', value: '5', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep!.type).to.equal('evaluator.numeric_assertion');
    });

    it('maps $.generatedData.outcome to {sm.response}', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Check outcome',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'equals', isReference: false },
              { name: 'actual', value: '$.generatedData.outcome', isReference: true },
              { name: 'expected', value: 'test', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep!.actual).to.equal('{sm.response}');
    });

    it('maps $.generatedData.topic to planner response path', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Check topic',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'equals', isReference: false },
              { name: 'actual', value: '$.generatedData.topic', isReference: true },
              { name: 'expected', value: 'Greeting', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep!.actual).to.equal('{gs.response.planner_response.lastExecution.topic}');
    });

    it('leaves unknown JSONPaths as-is', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Custom check',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'equals', isReference: false },
              { name: 'actual', value: '$.some.custom.path', isReference: true },
              { name: 'expected', value: 'value', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep!.actual).to.equal('$.some.custom.path');
    });

    it('extracts operator, actual, expected from parameters array', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Full check',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'contains', isReference: false },
              { name: 'actual', value: '$.generatedData.outcome', isReference: true },
              { name: 'expected', value: 'greeting', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const customStep = result.steps.find((s) => s.id === 'custom_0');
      expect(customStep!.operator).to.equal('contains');
      expect(customStep!.actual).to.equal('{sm.response}');
      expect(customStep!.expected).to.equal('greeting');
    });

    it('includes get_state when custom evaluation references planner data', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Topic check',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'equals', isReference: false },
              { name: 'actual', value: '$.generatedData.topic', isReference: true },
              { name: 'expected', value: 'Greeting', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const getState = result.steps.find((s) => s.type === 'agent.get_state');
      expect(getState).to.exist;
    });

    it('skips get_state when custom evaluation references only outcome', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        customEvaluations: [
          {
            label: 'Outcome check',
            name: 'string_comparison',
            parameters: [
              { name: 'operator', value: 'equals', isReference: false },
              { name: 'actual', value: '$.generatedData.outcome', isReference: true },
              { name: 'expected', value: 'hi', isReference: false },
            ],
          },
        ],
      };
      const result = translateTestCase(tc, 0);
      const getState = result.steps.find((s) => s.type === 'agent.get_state');
      expect(getState).to.be.undefined;
    });
  });

  describe('translateTestSpec', () => {
    it('translates multiple test cases with unique IDs', () => {
      const spec = {
        name: 'Agent_Test',
        subjectType: 'AGENT' as const,
        subjectName: 'My_Agent',
        testCases: [
          { utterance: 'Hello', expectedTopic: undefined, expectedActions: undefined, expectedOutcome: undefined },
          { utterance: 'Bye', expectedTopic: undefined, expectedActions: undefined, expectedOutcome: undefined },
          { utterance: 'Help', expectedTopic: undefined, expectedActions: undefined, expectedOutcome: undefined },
        ],
      };
      const payload = translateTestSpec(spec);
      expect(payload.tests).to.have.length(3);
      expect(payload.tests[0].id).to.equal('Agent_Test_case_0');
      expect(payload.tests[1].id).to.equal('Agent_Test_case_1');
      expect(payload.tests[2].id).to.equal('Agent_Test_case_2');
    });

    it('uses spec name in test IDs when available', () => {
      const spec = {
        name: 'Order_Agent_Test',
        subjectType: 'AGENT' as const,
        subjectName: 'Order_Agent',
        testCases: [
          {
            utterance: 'Check order',
            expectedTopic: undefined,
            expectedActions: undefined,
            expectedOutcome: undefined,
          },
        ],
      };
      const payload = translateTestSpec(spec);
      expect(payload.tests[0].id).to.equal('Order_Agent_Test_case_0');
    });

    it('handles spec with single test case', () => {
      const spec = {
        name: 'Single_Test',
        subjectType: 'AGENT' as const,
        subjectName: 'Agent',
        testCases: [
          {
            utterance: 'Hello',
            expectedTopic: 'Greeting',
            expectedActions: ['Greet'],
            expectedOutcome: 'Greets user',
          },
        ],
      };
      const payload = translateTestSpec(spec);
      expect(payload.tests).to.have.length(1);
      expect(payload.tests[0].steps.length).to.be.greaterThan(3);
    });
  });

  describe('edge cases', () => {
    it('handles testCase with only utterance (no expected fields)', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      expect(result.steps).to.have.length(2);
      expect(result.steps[0].type).to.equal('agent.create_session');
      expect(result.steps[1].type).to.equal('agent.send_message');
    });

    it('handles undefined vs empty expectedActions', () => {
      const tcUndef: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const resultUndef = translateTestCase(tcUndef, 0);
      expect(resultUndef.steps.find((s) => s.type === 'evaluator.planner_actions_assertion')).to.be.undefined;
      expect(resultUndef.steps.find((s) => s.type === 'agent.get_state')).to.be.undefined;

      const tcEmpty: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: [],
        expectedOutcome: undefined,
      };
      const resultEmpty = translateTestCase(tcEmpty, 0);
      expect(resultEmpty.steps.find((s) => s.type === 'evaluator.planner_actions_assertion')).to.be.undefined;
      expect(resultEmpty.steps.find((s) => s.type === 'agent.get_state')).to.be.undefined;
    });

    it('generates test_case_{index} ID when no specName provided', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 3);
      expect(result.id).to.equal('test_case_3');
    });

    it('generates {specName}_case_{index} ID when specName provided', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 2, 'My_Spec');
      expect(result.id).to.equal('My_Spec_case_2');
    });

    it('injects context_variables when contextVariables present', () => {
      const tc: TestCase = {
        utterance: 'Help with my camera',
        expectedTopic: 'Product_Help',
        expectedActions: undefined,
        expectedOutcome: undefined,
        contextVariables: [
          { name: 'RoutableId', value: '0Mw123' },
          { name: 'CaseId', value: '500456' },
        ],
      };
      const result = translateTestCase(tc, 0);
      const cs = result.steps.find((s) => s.type === 'agent.create_session');
      expect(cs).to.have.property('context_variables');
      expect((cs as Record<string, unknown>).context_variables).to.deep.equal({
        RoutableId: '0Mw123',
        CaseId: '500456',
      });
    });

    it('does not add context_variables when contextVariables absent', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const cs = result.steps.find((s) => s.type === 'agent.create_session');
      expect(cs).to.not.have.property('context_variables');
    });

    it('does not add context_variables when contextVariables is empty', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        contextVariables: [],
      };
      const result = translateTestCase(tc, 0);
      const cs = result.steps.find((s) => s.type === 'agent.create_session');
      expect(cs).to.not.have.property('context_variables');
    });

    it('throws error when contextVariables has duplicate names', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
        contextVariables: [
          { name: 'CaseId', value: '500123' },
          { name: 'RoutableId', value: '0Mw456' },
          { name: 'CaseId', value: '500789' },
        ],
      };
      expect(() => translateTestCase(tc, 0)).to.throw(/Duplicate contextVariable names found in test case 0: CaseId/);
    });

    it('translates contextVariables to context_variables object format', () => {
      const tc: TestCase = {
        utterance: 'Test with context',
        expectedTopic: 'Test_Topic',
        expectedActions: undefined,
        expectedOutcome: undefined,
        contextVariables: [
          { name: 'CaseId', value: '500ABC' },
          { name: 'RoutableId', value: '0MwXYZ' },
          { name: 'UserId', value: '005DEF' },
        ],
      };
      const result = translateTestCase(tc, 0);
      const cs = result.steps.find((s) => s.type === 'agent.create_session') as Record<string, unknown>;

      expect(cs).to.have.property('context_variables');
      const contextVars = cs.context_variables as Record<string, string>;
      expect(contextVars).to.deep.equal({
        CaseId: '500ABC',
        RoutableId: '0MwXYZ',
        UserId: '005DEF',
      });
    });

    it('sets use_agent_api true on create_session', () => {
      const tc: TestCase = {
        utterance: 'Hello',
        expectedTopic: undefined,
        expectedActions: undefined,
        expectedOutcome: undefined,
      };
      const result = translateTestCase(tc, 0);
      const cs = result.steps.find((s) => s.type === 'agent.create_session');
      expect(cs!.use_agent_api).to.equal(true);
    });
  });
});
