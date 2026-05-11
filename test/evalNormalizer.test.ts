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
import {
  normalizePayload,
  normalizeMcpShorthand,
  autoCorrectFields,
  normalizeCamelCase,
  normalizeEvaluatorFields,
  convertShorthandRefs,
  injectDefaults,
  stripUnrecognizedFields,
  splitIntoBatches,
  type EvalStep,
  type EvalPayload,
} from '../src/evalNormalizer';

describe('evalNormalizer', () => {
  describe('normalizeMcpShorthand', () => {
    it('should convert type="evaluator" + evaluator_type to type="evaluator.xxx"', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'planner_topic_assertion',
          field: 'gs1.planner_state.topic',
          expected: 'my_topic',
          operator: 'contains',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('type', 'evaluator.planner_topic_assertion');
      expect(result[0]).to.not.have.property('evaluator_type');
    });

    it('should convert field to actual with mapped JSONPath', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'planner_topic_assertion',
          field: 'gs1.planner_state.topic',
          expected: 'my_topic',
          operator: 'contains',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('actual', '{gs1.response.planner_response.lastExecution.topic}');
      expect(result[0]).to.not.have.property('field');
    });

    it('should map planner_state.invokedActions correctly', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'planner_actions_assertion',
          field: 'gs1.planner_state.invokedActions',
          expected: ['Get_Order'],
          operator: 'includes_items',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('actual', '{gs1.response.planner_response.lastExecution.invokedActions}');
    });

    it('should map response field for send_message refs', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'string_assertion',
          field: 'sm1.response',
          expected: 'hello',
          operator: 'contains',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('actual', '{sm1.response}');
    });

    it('should auto-generate id when missing', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: '',
          evaluator_type: 'planner_topic_assertion',
          field: 'gs1.planner_state.topic',
          expected: 'test',
          operator: 'contains',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0].id).to.equal('eval_0');
    });

    it('should preserve existing id when present', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'my_eval',
          evaluator_type: 'string_assertion',
          field: 'sm1.response',
          expected: 'test',
          operator: 'equals',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0].id).to.equal('my_eval');
    });

    it('should not modify steps that already use raw API format', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator.planner_topic_assertion',
          id: 'e1',
          actual: '{gs.response.planner_response.lastExecution.topic}',
          expected: 'test',
          operator: 'contains',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.deep.equal(steps[0]);
    });

    it('should not modify agent steps', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 'cs', use_agent_api: true }];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.deep.equal(steps[0]);
    });

    it('should leave unmapped field paths as-is', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'string_assertion',
          field: 'sm1.custom_field',
          expected: 'test',
          operator: 'equals',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('actual', '{sm1.custom_field}');
    });

    it('should not overwrite existing actual field', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator',
          id: 'e1',
          evaluator_type: 'string_assertion',
          field: 'sm1.response',
          actual: '{sm1.response}',
          expected: 'test',
          operator: 'equals',
        },
      ];
      const result = normalizeMcpShorthand(steps);
      expect(result[0]).to.have.property('actual', '{sm1.response}');
      expect(result[0]).to.not.have.property('field');
    });
  });

  describe('autoCorrectFields', () => {
    it('should correct camelCase agent fields to snake_case', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', agentId: 'abc', agentVersionId: 'v1' }];
      const result = autoCorrectFields(steps);
      expect(result[0]).to.have.property('agent_id', 'abc');
      expect(result[0]).to.have.property('agent_version_id', 'v1');
      expect(result[0]).to.not.have.property('agentId');
      expect(result[0]).to.not.have.property('agentVersionId');
    });

    it('should correct common utterance aliases', () => {
      const steps: EvalStep[] = [{ type: 'agent.send_message', id: 's1', text: 'hello' }];
      const result = autoCorrectFields(steps);
      expect(result[0]).to.have.property('utterance', 'hello');
      expect(result[0]).to.not.have.property('text');
    });

    it('should correct evaluator field aliases', () => {
      const steps: EvalStep[] = [
        { type: 'evaluator.string_assertion', id: 'e1', subject: 'test', expectedValue: 'expected' },
      ];
      const result = autoCorrectFields(steps);
      expect(result[0]).to.have.property('actual', 'test');
      expect(result[0]).to.have.property('expected', 'expected');
    });

    it('should not overwrite existing correct fields', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', agentId: 'wrong', agent_id: 'correct' }];
      const result = autoCorrectFields(steps);
      expect(result[0]).to.have.property('agent_id', 'correct');
    });
  });

  describe('normalizeCamelCase', () => {
    it('should convert useAgentApi to use_agent_api', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', useAgentApi: true }];
      const result = normalizeCamelCase(steps);
      expect(result[0]).to.have.property('use_agent_api', true);
      expect(result[0]).to.not.have.property('useAgentApi');
    });

    it('should convert planner aliases to planner_id', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', plannerDefinitionId: 'p1' }];
      const result = normalizeCamelCase(steps);
      expect(result[0]).to.have.property('planner_id', 'p1');
    });

    it('should only apply to agent.create_session', () => {
      const steps: EvalStep[] = [{ type: 'agent.send_message', id: 's1', useAgentApi: true }];
      const result = normalizeCamelCase(steps);
      expect(result[0]).to.have.property('useAgentApi', true);
    });
  });

  describe('normalizeEvaluatorFields', () => {
    it('should map actual/expected to generated_output/reference_answer for scoring evaluators', () => {
      const steps: EvalStep[] = [{ type: 'evaluator.text_alignment', id: 'e1', actual: 'test', expected: 'ref' }];
      const result = normalizeEvaluatorFields(steps);
      expect(result[0]).to.have.property('generated_output', 'test');
      expect(result[0]).to.have.property('reference_answer', 'ref');
      expect(result[0]).to.not.have.property('actual');
      expect(result[0]).to.not.have.property('expected');
    });

    it('should auto-inject metric_name for scoring evaluators', () => {
      const steps: EvalStep[] = [
        { type: 'evaluator.text_alignment', id: 'e1', generated_output: 'test', reference_answer: 'ref' },
      ];
      const result = normalizeEvaluatorFields(steps);
      expect(result[0]).to.have.property('metric_name', 'base.cosine_similarity');
    });

    it('should auto-inject metric_name for assertion evaluators', () => {
      const steps: EvalStep[] = [{ type: 'evaluator.string_assertion', id: 'e1', actual: 'test', expected: 'ref' }];
      const result = normalizeEvaluatorFields(steps);
      expect(result[0]).to.have.property('metric_name', 'string_assertion');
    });

    it('should auto-lowercase operator for assertion evaluators', () => {
      const steps: EvalStep[] = [
        { type: 'evaluator.string_assertion', id: 'e1', actual: 'a', expected: 'b', operator: 'EQUALS' },
      ];
      const result = normalizeEvaluatorFields(steps);
      expect(result[0]).to.have.property('operator', 'equals');
    });
  });

  describe('convertShorthandRefs', () => {
    it('should convert {step_id.field} to JSONPath', () => {
      const steps: EvalStep[] = [
        { type: 'agent.create_session', id: 'session' },
        { type: 'agent.send_message', id: 'msg1', session_id: '{session.session_id}', utterance: 'hi' },
        { type: 'evaluator.string_assertion', id: 'e1', actual: '{msg1.response}', expected: 'hello' },
      ];
      const result = convertShorthandRefs(steps);
      expect(result[1]).to.have.property('session_id', '$.outputs[0].session_id');
      expect(result[2]).to.have.property('actual', '$.outputs[1].response');
    });

    it('should normalize response.messages paths to response', () => {
      const steps: EvalStep[] = [
        { type: 'agent.send_message', id: 'msg1' },
        { type: 'evaluator.string_assertion', id: 'e1', actual: '{msg1.response.messages[0].message}' },
      ];
      const result = convertShorthandRefs(steps);
      expect(result[1]).to.have.property('actual', '$.outputs[0].response');
    });

    it('should leave unknown step IDs unchanged', () => {
      const steps: EvalStep[] = [{ type: 'evaluator.string_assertion', id: 'e1', actual: '{unknown.field}' }];
      const result = convertShorthandRefs(steps);
      expect(result[0]).to.have.property('actual', '{unknown.field}');
    });
  });

  describe('injectDefaults', () => {
    it('should inject use_agent_api=true when neither use_agent_api nor planner_id present', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', agent_id: 'abc' }];
      const result = injectDefaults(steps);
      expect(result[0]).to.have.property('use_agent_api', true);
    });

    it('should not inject when use_agent_api already present', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', agent_id: 'abc', use_agent_api: false }];
      const result = injectDefaults(steps);
      expect(result[0]).to.have.property('use_agent_api', false);
    });

    it('should not inject when planner_id present', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', planner_id: 'p1' }];
      const result = injectDefaults(steps);
      expect(result[0]).to.not.have.property('use_agent_api');
    });
  });

  describe('stripUnrecognizedFields', () => {
    it('should strip unrecognized fields from agent.create_session', () => {
      const steps: EvalStep[] = [{ type: 'agent.create_session', id: 's1', agent_id: 'abc', extra_field: 'bad' }];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.not.have.property('extra_field');
      expect(result[0]).to.have.property('agent_id', 'abc');
    });

    it('should strip unrecognized fields from scoring evaluators', () => {
      const steps: EvalStep[] = [
        {
          type: 'evaluator.text_alignment',
          id: 'e1',
          generated_output: 'test',
          reference_answer: 'ref',
          metric_name: 'base.cosine_similarity',
          bad_field: 'bad',
        },
      ];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.not.have.property('bad_field');
      expect(result[0]).to.have.property('generated_output', 'test');
    });

    it('should preserve state field on agent.create_session', () => {
      const steps: EvalStep[] = [
        {
          type: 'agent.create_session',
          id: 's1',
          planner_id: 'p1',
          state: {
            state: {
              plannerType: 'Atlas',
              sessionContext: {},
              conversationHistory: [],
              lastExecution: {},
            },
          },
        },
      ];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.have.property('state');
      expect((result[0] as Record<string, unknown>).state).to.deep.equal(steps[0].state);
    });

    it('should preserve setupSessionContext on agent.create_session', () => {
      const steps: EvalStep[] = [
        {
          type: 'agent.create_session',
          id: 's1',
          planner_id: 'p1',
          setupSessionContext: { tags: { botId: '0Xx123', botVersionId: '0X9456' } },
        },
      ];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.have.property('setupSessionContext');
      expect((result[0] as Record<string, unknown>).setupSessionContext).to.deep.equal({
        tags: { botId: '0Xx123', botVersionId: '0X9456' },
      });
    });

    it('should preserve context_variables on agent.create_session', () => {
      const steps: EvalStep[] = [
        {
          type: 'agent.create_session',
          id: 's1',
          use_agent_api: true,
          context_variables: { RoutableId: '0Mw123', CaseId: '500456' },
        },
      ];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.have.property('context_variables');
      expect((result[0] as Record<string, unknown>).context_variables).to.deep.equal({
        RoutableId: '0Mw123',
        CaseId: '500456',
      });
    });

    it('should not strip fields from unknown types', () => {
      const steps: EvalStep[] = [{ type: 'evaluator.future_type', id: 'e1', custom_field: 'keep' }];
      const result = stripUnrecognizedFields(steps);
      expect(result[0]).to.have.property('custom_field', 'keep');
    });
  });

  describe('normalizePayload', () => {
    it('should run all normalization passes end-to-end', () => {
      const payload: EvalPayload = {
        tests: [
          {
            id: 'test1',
            steps: [
              { type: 'agent.create_session', id: 'session', agentId: 'abc', agentVersionId: 'v1' },
              { type: 'agent.send_message', id: 'msg1', sessionId: '{session.session_id}', text: 'hello' },
              {
                type: 'evaluator.string_assertion',
                id: 'check1',
                subject: '{msg1.response}',
                expectedValue: 'hi',
              },
            ],
          },
        ],
      };

      const result = normalizePayload(payload);
      const steps = result.tests[0].steps;

      expect(steps[0]).to.have.property('agent_id', 'abc');
      expect(steps[0]).to.have.property('agent_version_id', 'v1');
      expect(steps[0]).to.not.have.property('agentId');

      expect(steps[1]).to.have.property('utterance', 'hello');
      expect(steps[1]).to.have.property('session_id', '$.outputs[0].session_id');

      expect(steps[2]).to.have.property('actual', '$.outputs[1].response');
      expect(steps[2]).to.have.property('expected', 'hi');
      expect(steps[2]).to.have.property('metric_name', 'string_assertion');
    });
  });

  describe('normalizePayload with MCP shorthand', () => {
    it('should normalize a full MCP-format payload end-to-end', () => {
      const payload: EvalPayload = {
        tests: [
          {
            id: 'mcp_test',
            steps: [
              { type: 'agent.create_session', id: 'cs1', agent_id: 'abc', use_agent_api: true },
              { type: 'agent.send_message', id: 'sm1', session_id: '{cs1.session_id}', utterance: 'hello' },
              { type: 'agent.get_state', id: 'gs1', session_id: '{cs1.session_id}' },
              {
                type: 'evaluator',
                id: 'eval1',
                evaluator_type: 'planner_topic_assertion',
                field: 'gs1.planner_state.topic',
                expected: 'greeting',
                operator: 'contains',
              },
              {
                type: 'evaluator',
                id: 'eval2',
                evaluator_type: 'string_assertion',
                field: 'sm1.response',
                expected: 'hello',
                operator: 'contains',
              },
            ],
          },
        ],
      };

      const result = normalizePayload(payload);
      const steps = result.tests[0].steps;

      expect(steps[3]).to.have.property('type', 'evaluator.planner_topic_assertion');
      expect(steps[3]).to.not.have.property('evaluator_type');
      expect(steps[3]).to.not.have.property('field');
      expect(steps[3].actual).to.match(/\$\.outputs\[\d+\]/);

      expect(steps[4]).to.have.property('type', 'evaluator.string_assertion');
      expect(steps[4].actual).to.match(/\$\.outputs\[\d+\]/);
    });
  });

  describe('splitIntoBatches', () => {
    it('should split tests into correct batch sizes', () => {
      const tests = [
        { id: 't1', steps: [] },
        { id: 't2', steps: [] },
        { id: 't3', steps: [] },
        { id: 't4', steps: [] },
        { id: 't5', steps: [] },
      ];
      const batches = splitIntoBatches(tests, 2);
      expect(batches).to.have.length(3);
      expect(batches[0]).to.have.length(2);
      expect(batches[1]).to.have.length(2);
      expect(batches[2]).to.have.length(1);
    });

    it('should return a single batch when tests fit', () => {
      const tests = [
        { id: 't1', steps: [] },
        { id: 't2', steps: [] },
      ];
      const batches = splitIntoBatches(tests, 5);
      expect(batches).to.have.length(1);
      expect(batches[0]).to.have.length(2);
    });

    it('should handle empty tests array', () => {
      const batches = splitIntoBatches([], 5);
      expect(batches).to.have.length(0);
    });
  });
});
