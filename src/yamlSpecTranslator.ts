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

import { parse as parseYaml } from 'yaml';
import type { TestSpec, TestCase } from './types.js';
import type { EvalPayload, EvalTest, EvalStep } from './evalNormalizer.js';

// --- JSONPath mappings from org model to Eval API refs ---

const ACTUAL_PATH_MAP: Record<string, string> = {
  '$.generatedData.outcome': '{sm.response}',
  '$.generatedData.topic': '{gs.response.planner_response.lastExecution.topic}',
  '$.generatedData.invokedActions': '{gs.response.planner_response.lastExecution.invokedActions}',
  '$.generatedData.actionsSequence': '{gs.response.planner_response.lastExecution.invokedActions}',
};

// --- Custom evaluation name to evaluator type mapping ---

const CUSTOM_EVAL_TYPE_MAP: Record<string, string> = {
  string_comparison: 'evaluator.string_assertion',
  numeric_comparison: 'evaluator.numeric_assertion',
};

// JSONPaths that require the get_state step
const PLANNER_PATHS = new Set([
  '$.generatedData.topic',
  '$.generatedData.invokedActions',
  '$.generatedData.actionsSequence',
]);

// --- Public API ---

/**
 * Returns true if the content looks like a YAML TestSpec (has testCases + subjectName).
 * Returns false for JSON EvalPayload, invalid content, or YAML missing required fields.
 */
export function isYamlTestSpec(content: string): boolean {
  try {
    const parsed: unknown = parseYaml(content);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    const obj = parsed as Record<string, unknown>;
    return Array.isArray(obj.testCases) && typeof obj.subjectName === 'string';
  } catch {
    return false;
  }
}

/**
 * Parse a YAML string into a TestSpec.
 * Throws if the content is not valid YAML or is missing required fields.
 */
export function parseTestSpec(content: string): TestSpec {
  const parsed: unknown = parseYaml(content);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid TestSpec: expected a YAML object');
  }
  const obj = parsed as Record<string, unknown>;
  if (!Array.isArray(obj.testCases)) {
    throw new Error('Invalid TestSpec: missing testCases array');
  }
  if (typeof obj.subjectName !== 'string') {
    throw new Error('Invalid TestSpec: missing subjectName');
  }
  if (typeof obj.name !== 'string') {
    throw new Error('Invalid TestSpec: missing name');
  }
  return parsed as TestSpec;
}

/**
 * Translate a full TestSpec into an EvalPayload.
 */
export function translateTestSpec(spec: TestSpec): EvalPayload {
  return {
    tests: spec.testCases.map((tc, idx) => translateTestCase(tc, idx, spec.name)),
  };
}

/**
 * Translate a single TestCase into an EvalTest with ordered steps.
 */
export function translateTestCase(testCase: TestCase, index: number, specName?: string): EvalTest {
  const id = specName ? `${specName}_case_${index}` : `test_case_${index}`;
  const steps: EvalStep[] = [];

  // 1. agent.create_session
  const createSessionStep: EvalStep = {
    type: 'agent.create_session',
    id: 'cs',
    use_agent_api: true,
  };

  if (testCase.contextVariables && testCase.contextVariables.length > 0) {
    // Validate for duplicate names
    const names = testCase.contextVariables.map((cv) => cv.name);
    const duplicates = names.filter((name, idx) => names.indexOf(name) !== idx);
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate contextVariable names found in test case ${index}: ${[...new Set(duplicates)].join(
          ', '
        )}. Each contextVariable name must be unique.`
      );
    }

    createSessionStep.context_variables = Object.fromEntries(
      testCase.contextVariables.map((cv) => [cv.name, cv.value])
    );
  }

  steps.push(createSessionStep);

  // 2. Conversation history — only user messages become send_message steps
  let historyIdx = 0;
  if (testCase.conversationHistory) {
    for (const entry of testCase.conversationHistory) {
      if (entry.role === 'user') {
        steps.push({
          type: 'agent.send_message',
          id: `history_${historyIdx}`,
          session_id: '{cs.session_id}',
          utterance: entry.message,
        });
        historyIdx++;
      }
    }
  }

  // 3. Test utterance
  steps.push({
    type: 'agent.send_message',
    id: 'sm',
    session_id: '{cs.session_id}',
    utterance: testCase.utterance,
  });

  // 4. Determine if get_state is needed
  const needsGetState = needsPlannerState(testCase);
  if (needsGetState) {
    steps.push({
      type: 'agent.get_state',
      id: 'gs',
      session_id: '{cs.session_id}',
    });
  }

  // 5. Evaluators
  if (testCase.expectedTopic !== undefined) {
    steps.push({
      type: 'evaluator.planner_topic_assertion',
      id: 'check_topic',
      expected: testCase.expectedTopic,
      actual: '{gs.response.planner_response.lastExecution.topic}',
      operator: 'contains',
    });
  }

  if (testCase.expectedActions !== undefined && testCase.expectedActions.length > 0) {
    steps.push({
      type: 'evaluator.planner_actions_assertion',
      id: 'check_actions',
      expected: testCase.expectedActions,
      actual: '{gs.response.planner_response.lastExecution.invokedActions}',
      operator: 'includes_items',
    });
  }

  if (testCase.expectedOutcome !== undefined) {
    steps.push({
      type: 'evaluator.bot_response_rating',
      id: 'check_outcome',
      utterance: testCase.utterance,
      expected: testCase.expectedOutcome,
      actual: '{sm.response}',
      threshold: 3.0,
    });
  }

  if (testCase.customEvaluations) {
    testCase.customEvaluations.forEach((customEval, customIdx) => {
      const step = translateCustomEvaluation(customEval, customIdx);
      steps.push(step);
    });
  }

  return { id, steps };
}

// --- Internal helpers ---

/**
 * Determine whether the get_state step is needed for this test case.
 */
function needsPlannerState(testCase: TestCase): boolean {
  if (testCase.expectedTopic !== undefined) return true;
  if (testCase.expectedActions !== undefined && testCase.expectedActions.length > 0) return true;

  if (testCase.customEvaluations) {
    for (const customEval of testCase.customEvaluations) {
      for (const param of customEval.parameters) {
        if (param.name === 'actual' && PLANNER_PATHS.has(param.value)) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Translate a single customEvaluation entry into an EvalStep.
 */
function translateCustomEvaluation(
  customEval: NonNullable<TestCase['customEvaluations']>[number],
  index: number
): EvalStep {
  const evalType = CUSTOM_EVAL_TYPE_MAP[customEval.name] ?? `evaluator.${customEval.name}`;

  let operator = '';
  let actual = '';
  let expected = '';

  for (const param of customEval.parameters) {
    if (param.name === 'operator') {
      operator = param.value;
    } else if (param.name === 'actual') {
      actual = mapActualPath(param.value);
    } else if (param.name === 'expected') {
      expected = param.value;
    }
  }

  return {
    type: evalType,
    id: `custom_${index}`,
    operator,
    actual,
    expected,
  };
}

/**
 * Map an org-model JSONPath to the Eval API shorthand ref.
 * Unknown paths are returned as-is.
 */
function mapActualPath(path: string): string {
  return ACTUAL_PATH_MAP[path] ?? path;
}
