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

// --- Types ---

export type EvalPayload = {
  tests: EvalTest[];
};

export type EvalTest = {
  id: string;
  steps: EvalStep[];
};

export type EvalStep = {
  [key: string]: unknown;
  type: string;
  id: string;
};

// --- Evaluator classification ---

const SCORING_EVALUATORS = new Set([
  'evaluator.text_alignment',
  'evaluator.hallucination_detection',
  'evaluator.citation_recall',
  'evaluator.answer_faithfulness',
]);

const ASSERTION_EVALUATORS = new Set(['evaluator.string_assertion', 'evaluator.json_assertion']);

const DEFAULT_METRIC_NAMES: Record<string, string> = {
  'evaluator.text_alignment': 'base.cosine_similarity',
  'evaluator.hallucination_detection': 'hallucination_detection',
  'evaluator.citation_recall': 'citation_recall',
  'evaluator.answer_faithfulness': 'answer_faithfulness',
};

const SCORING_VALID_FIELDS = new Set([
  'type',
  'id',
  'generated_output',
  'reference_answer',
  'metric_name',
  'threshold',
]);

const ASSERTION_VALID_FIELDS = new Set([
  'type',
  'id',
  'actual',
  'expected',
  'operator',
  'threshold',
  'json_path',
  'json_schema',
  'metric_name',
]);

const VALID_AGENT_FIELDS: Record<string, Set<string>> = {
  'agent.create_session': new Set([
    'type',
    'id',
    'agent_id',
    'agent_version_id',
    'use_agent_api',
    'planner_id',
    'state',
    'setupSessionContext',
    'context_variables',
  ]),
  'agent.send_message': new Set(['type', 'id', 'session_id', 'utterance']),
  'agent.get_state': new Set(['type', 'id', 'session_id']),
};

// --- Auto-correction maps ---

const AGENT_CORRECTIONS: Record<string, string> = {
  agentId: 'agent_id',
  agentVersionId: 'agent_version_id',
  sessionId: 'session_id',
  text: 'utterance',
  message: 'utterance',
  input: 'utterance',
  prompt: 'utterance',
  user_message: 'utterance',
  userMessage: 'utterance',
};

const EVALUATOR_CORRECTIONS: Record<string, string> = {
  subject: 'actual',
  expectedValue: 'expected',
  expected_value: 'expected',
  actualValue: 'actual',
  actual_value: 'actual',
  assertionType: 'operator',
  assertion_type: 'operator',
  comparator: 'operator',
};

// --- camelCase alias maps for agent.create_session ---

const AGENT_FIELD_ALIASES: Record<string, string> = {
  useAgentApi: 'use_agent_api',
  plannerId: 'planner_id',
  plannerDefinitionId: 'planner_id',
  planner_definition_id: 'planner_id',
  planner_version_id: 'planner_id',
  plannerVersionId: 'planner_id',
};

// --- Scoring evaluator field aliases ---

const SCORING_FIELD_ALIASES: Record<string, string> = {
  actual: 'generated_output',
  expected: 'reference_answer',
  actual_value: 'generated_output',
  expected_value: 'reference_answer',
  actual_output: 'generated_output',
  expected_output: 'reference_answer',
  response: 'generated_output',
  ground_truth: 'reference_answer',
};

// --- Assertion evaluator field aliases ---

const ASSERTION_FIELD_ALIASES: Record<string, string> = {
  actual_value: 'actual',
  expected_value: 'expected',
  generated_output: 'actual',
  reference_answer: 'expected',
  actual_output: 'actual',
  expected_output: 'expected',
  response: 'actual',
  ground_truth: 'expected',
};

// --- MCP shorthand field mapping ---

// MCP uses `field: "gs1.planner_state.topic"` — map to Eval API `actual` with correct JSONPath
const MCP_FIELD_MAP: Record<string, string> = {
  'planner_state.topic': 'response.planner_response.lastExecution.topic',
  'planner_state.invokedActions': 'response.planner_response.lastExecution.invokedActions',
  'planner_state.actionsSequence': 'response.planner_response.lastExecution.invokedActions',
  response: 'response',
  'response.messages': 'response',
};

// --- Main entry point ---

/**
 * Apply all normalizations to a test payload.
 * Passes run in order: mcp-shorthand -> auto-correct -> camelCase -> evaluator fields -> shorthand refs -> defaults -> strip.
 */
export function normalizePayload(payload: EvalPayload): EvalPayload {
  const normalized: EvalPayload = {
    tests: payload.tests.map((test) => {
      let steps = [...test.steps];
      steps = normalizeMcpShorthand(steps);
      steps = autoCorrectFields(steps);
      steps = normalizeCamelCase(steps);
      steps = normalizeEvaluatorFields(steps);
      steps = convertShorthandRefs(steps);
      steps = injectDefaults(steps);
      steps = stripUnrecognizedFields(steps);
      return { ...test, steps };
    }),
  };
  return normalized;
}

// --- Individual normalization passes ---

/**
 * Convert MCP shorthand format to raw Eval API format.
 * MCP uses type="evaluator" + evaluator_type, raw API uses type="evaluator.xxx".
 * Also maps `field` to `actual` with proper JSONPath and auto-generates missing `id` fields.
 */
export function normalizeMcpShorthand(steps: EvalStep[]): EvalStep[] {
  let evalCounter = 0;

  return steps.map((step) => {
    const evaluator_type = step.evaluator_type as string | undefined;

    // Only applies to MCP shorthand: type="evaluator" with evaluator_type field
    if (step.type !== 'evaluator' || !evaluator_type) return step;

    const normalized = { ...step };

    // Merge type: "evaluator" + evaluator_type: "xxx" → type: "evaluator.xxx"
    normalized.type = `evaluator.${evaluator_type}`;
    delete normalized.evaluator_type;

    // Convert `field` to `actual` with proper shorthand ref format
    if ('field' in normalized) {
      if (!('actual' in normalized)) {
        const fieldValue = normalized.field as string;

        // Parse "gs1.planner_state.topic" → stepId="gs1", fieldPath="planner_state.topic"
        const dotIdx = fieldValue.indexOf('.');
        if (dotIdx > 0) {
          const stepId = fieldValue.substring(0, dotIdx);
          const fieldPath = fieldValue.substring(dotIdx + 1);
          const mappedPath = MCP_FIELD_MAP[fieldPath] ?? fieldPath;
          normalized.actual = `{${stepId}.${mappedPath}}`;
        } else {
          normalized.actual = fieldValue;
        }
      }
      delete normalized.field;
    }

    // Auto-generate id if missing
    if (!normalized.id || normalized.id === '') {
      normalized.id = `eval_${evalCounter}`;
    }
    evalCounter++;

    return normalized as EvalStep;
  });
}

/**
 * Auto-correct common field name mistakes.
 * Maps wrong field names to correct ones (agentId->agent_id, text->utterance, etc.)
 */
export function autoCorrectFields(steps: EvalStep[]): EvalStep[] {
  return steps.map((step) => {
    const corrected = { ...step };
    const stepType = corrected.type ?? '';

    if (stepType.startsWith('agent.')) {
      for (const [wrong, correct] of Object.entries(AGENT_CORRECTIONS)) {
        if (wrong in corrected && !(correct in corrected)) {
          corrected[correct] = corrected[wrong];
          delete corrected[wrong];
        }
      }
    } else if (stepType.startsWith('evaluator.')) {
      for (const [wrong, correct] of Object.entries(EVALUATOR_CORRECTIONS)) {
        if (wrong in corrected && !(correct in corrected)) {
          corrected[correct] = corrected[wrong];
          delete corrected[wrong];
        }
      }
    }

    return corrected as EvalStep;
  });
}

/**
 * Normalize camelCase agent field names to snake_case.
 * useAgentApi->use_agent_api, plannerDefinitionId->planner_id, etc.
 */
export function normalizeCamelCase(steps: EvalStep[]): EvalStep[] {
  return steps.map((step) => {
    if (step.type !== 'agent.create_session') return step;

    const normalized = { ...step };
    for (const [alias, canonical] of Object.entries(AGENT_FIELD_ALIASES)) {
      if (alias in normalized) {
        if (!(canonical in normalized)) {
          normalized[canonical] = normalized[alias];
        }
        delete normalized[alias];
      }
    }
    return normalized as EvalStep;
  });
}

/**
 * Apply field aliases: remap alias keys to canonical keys, removing duplicates.
 */
function applyFieldAliases(step: EvalStep, aliases: Record<string, string>): void {
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (alias in step && !(canonical in step)) {
      step[canonical] = step[alias];
      delete step[alias];
    } else if (alias in step && canonical in step) {
      delete step[alias];
    }
  }
}

/**
 * Normalize a scoring evaluator step (field aliases + metric_name injection).
 */
function normalizeScoringEvaluator(normalized: EvalStep, evalType: string): void {
  applyFieldAliases(normalized, SCORING_FIELD_ALIASES);

  // Auto-inject or correct metric_name
  if (!('metric_name' in normalized)) {
    const defaultMetric = DEFAULT_METRIC_NAMES[evalType];
    if (defaultMetric) {
      normalized.metric_name = defaultMetric;
    }
  } else if (normalized.metric_name === evalType.split('.')[1]) {
    const defaultMetric = DEFAULT_METRIC_NAMES[evalType];
    if (defaultMetric) {
      normalized.metric_name = defaultMetric;
    }
  }
}

/**
 * Normalize an assertion evaluator step (field aliases + operator lowercase + metric_name).
 */
function normalizeAssertionEvaluator(normalized: EvalStep, evalType: string): void {
  applyFieldAliases(normalized, ASSERTION_FIELD_ALIASES);

  // Auto-lowercase operator
  if ('operator' in normalized && typeof normalized.operator === 'string') {
    normalized.operator = normalized.operator.toLowerCase();
  }

  // Auto-inject metric_name for assertion evaluators
  if (!('metric_name' in normalized)) {
    normalized.metric_name = evalType.split('.')[1];
  }
}

/**
 * Normalize evaluator field names based on evaluator category.
 * Maps actual/expected <-> generated_output/reference_answer.
 * Also auto-lowercases operator values and auto-injects metric_name.
 */
export function normalizeEvaluatorFields(steps: EvalStep[]): EvalStep[] {
  return steps.map((step) => {
    const evalType = step.type ?? '';
    if (!evalType.startsWith('evaluator.')) return step;

    const normalized = { ...step };

    if (SCORING_EVALUATORS.has(evalType)) {
      normalizeScoringEvaluator(normalized, evalType);
    } else if (ASSERTION_EVALUATORS.has(evalType)) {
      normalizeAssertionEvaluator(normalized, evalType);
    }
    // Don't inject metric_name for unknown evaluator types to avoid API validation errors
    // Unknown evaluators like bot_response_rating and planner_topic_assertion don't use metric_name

    return normalized as EvalStep;
  });
}

/**
 * Convert {step_id.field} shorthand references to JSONPath $.outputs[N].field.
 * Builds step_id->index mapping from non-evaluator steps.
 */
export function convertShorthandRefs(steps: EvalStep[]): EvalStep[] {
  // Build step_id -> output-array index mapping
  const stepIdToIdx: Record<string, number> = {};
  let outputIdx = 0;
  for (const step of steps) {
    const sid = step.id;
    const stype = step.type ?? '';
    if (sid && !stype.startsWith('evaluator.')) {
      stepIdToIdx[sid] = outputIdx;
      outputIdx += 1;
    }
  }

  const refPattern = /\{([^}]+)\}/g;

  function replaceValue(value: unknown): unknown {
    if (typeof value !== 'string') return value;

    return value.replace(refPattern, (match, ref: string) => {
      const dotIdx = ref.indexOf('.');
      if (dotIdx < 0) return match;

      const sid = ref.substring(0, dotIdx);
      let field = ref.substring(dotIdx + 1);

      if (!(sid in stepIdToIdx)) return match;

      const idx = stepIdToIdx[sid];

      // Normalize legacy nested-response path to flat response
      if (field.startsWith('response.messages')) {
        field = 'response';
      }

      return `$.outputs[${idx}].${field}`;
    });
  }

  return steps.map((step) => {
    const newStep: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(step)) {
      if (typeof val === 'string') {
        newStep[key] = replaceValue(val);
      } else if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const newObj: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          newObj[k] = typeof v === 'string' ? replaceValue(v) : v;
        }
        newStep[key] = newObj;
      } else if (Array.isArray(val)) {
        newStep[key] = (val as unknown[]).map((item: unknown) =>
          typeof item === 'string' ? replaceValue(item) : item
        );
      } else {
        newStep[key] = val;
      }
    }
    return newStep as EvalStep;
  });
}

/**
 * Inject default values:
 * - use_agent_api=true on agent.create_session if neither use_agent_api nor planner_id present
 */
export function injectDefaults(steps: EvalStep[]): EvalStep[] {
  return steps.map((step) => {
    if (step.type === 'agent.create_session') {
      if (!('use_agent_api' in step) && !('planner_id' in step)) {
        return { ...step, use_agent_api: true };
      }
    }
    return step;
  });
}

/**
 * Strip unrecognized fields from steps based on type-specific whitelists.
 */
export function stripUnrecognizedFields(steps: EvalStep[]): EvalStep[] {
  return steps.map((step) => {
    const stepType = step.type ?? '';

    // Agent steps
    if (stepType in VALID_AGENT_FIELDS) {
      const validFields = VALID_AGENT_FIELDS[stepType];
      const stripped: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(step)) {
        if (validFields.has(key)) {
          stripped[key] = val;
        }
      }
      return stripped as EvalStep;
    }

    // Scoring evaluators
    if (SCORING_EVALUATORS.has(stepType)) {
      const stripped: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(step)) {
        if (SCORING_VALID_FIELDS.has(key)) {
          stripped[key] = val;
        }
      }
      return stripped as EvalStep;
    }

    // Assertion evaluators
    if (ASSERTION_EVALUATORS.has(stepType)) {
      const stripped: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(step)) {
        if (ASSERTION_VALID_FIELDS.has(key)) {
          stripped[key] = val;
        }
      }
      return stripped as EvalStep;
    }

    // Unknown types: don't strip (to avoid breaking future evaluator types)
    return step;
  });
}

// --- Batch splitting ---

/**
 * Split tests array into chunks of batchSize.
 */
export function splitIntoBatches(tests: EvalTest[], batchSize: number): EvalTest[][] {
  const batches: EvalTest[][] = [];
  for (let i = 0; i < tests.length; i += batchSize) {
    batches.push(tests.slice(i, i + batchSize));
  }
  return batches;
}
