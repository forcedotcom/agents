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

export type ResultFormat = 'human' | 'json' | 'junit' | 'tap';

type EvalOutput = {
  type?: string;
  id?: string;
  session_id?: string;
  response?: unknown;
};

type EvalResult = {
  id?: string;
  score?: number | null;
  is_pass?: boolean | null;
  actual_value?: string;
  expected_value?: string;
  error_message?: string;
};

type TestError = {
  id?: string;
  error_message?: string;
};

type TestResult = {
  id?: string;
  outputs?: EvalOutput[];
  evaluation_results?: EvalResult[];
  errors?: TestError[];
};

export type EvalApiResponse = {
  results?: TestResult[];
};

export function formatResults(results: EvalApiResponse, format: ResultFormat): string {
  switch (format) {
    case 'human':
      return formatHuman(results);
    case 'json':
      return JSON.stringify(results, null, 2);
    case 'junit':
      return formatJunit(results);
    case 'tap':
      return formatTap(results);
    default:
      return formatHuman(results);
  }
}

// --- formatHuman helpers ---

function formatOutputLines(outputs: EvalOutput[]): string[] {
  const lines: string[] = [];

  for (const output of outputs) {
    const stepType = output.type ?? '';
    const stepId = output.id ?? '';

    if (stepType === 'agent.create_session') {
      const sessionId = output.session_id ?? 'N/A';
      lines.push(`- **Create Session**: ${sessionId}`);
    } else if (stepType === 'agent.send_message') {
      let agentMsg = output.response;
      if (agentMsg !== null && typeof agentMsg === 'object' && !Array.isArray(agentMsg)) {
        const msgObj = agentMsg as Record<string, unknown>;
        const msgs = msgObj.messages as Array<Record<string, unknown>> | undefined;
        agentMsg = msgs?.[0]?.message ?? String(agentMsg);
      }
      const msgStr = String(agentMsg ?? '');
      const displayMsg = msgStr.length > 200 ? msgStr.substring(0, 200) + '...' : msgStr;
      lines.push(`- **Agent Response** (${stepId}): ${displayMsg}`);
    } else if (stepType === 'agent.get_state') {
      const respData = output.response;
      if (respData !== null && typeof respData === 'object') {
        const resp = respData as Record<string, unknown>;
        const planner = resp.planner_response as Record<string, unknown> | undefined;
        const lastExec = planner?.lastExecution as Record<string, unknown> | undefined;
        const topic = lastExec?.topic ?? 'N/A';
        const latency = lastExec?.latency ?? 'N/A';
        lines.push(`- **Topic Selected**: ${String(topic)}`);
        lines.push(`- **Response Latency**: ${String(latency)}ms`);
      } else {
        lines.push(`- **State**: ${String(respData).substring(0, 200)}`);
      }
    }
  }

  return lines;
}

function formatEvaluationTable(evalResults: EvalResult[]): string[] {
  const lines: string[] = [];

  if (evalResults.length > 0) {
    lines.push('### Evaluation Results\n');
    lines.push('| Metric | Score | Pass | Actual | Expected |');
    lines.push('|--------|-------|------|--------|----------|');

    for (const evalR of evalResults) {
      const metricId = evalR.id ?? 'unknown';
      const score = evalR.score;
      const scoreStr = score != null ? score.toFixed(3) : 'N/A';
      const isPass = evalR.is_pass;
      const passStr = isPass === true ? 'PASS' : isPass === false ? 'FAIL' : 'N/A';
      const actual = String(evalR.actual_value ?? '').substring(0, 60);
      const expected = String(evalR.expected_value ?? '').substring(0, 60);
      const error = evalR.error_message;

      if (error) {
        lines.push(`| ${metricId} | ERROR | - | ${error.substring(0, 80)} | - |`);
      } else {
        lines.push(`| ${metricId} | ${scoreStr} | ${passStr} | ${actual} | ${expected} |`);
      }
    }

    lines.push('');
  }

  return lines;
}

function formatErrorLines(errors: TestError[]): string[] {
  const lines: string[] = [];

  if (errors.length > 0) {
    lines.push('### Errors\n');
    for (const error of errors) {
      const errorId = error.id ?? 'unknown';
      const errorMsg = error.error_message ?? String(error);
      lines.push(`- **${errorId}**: ${errorMsg}`);
    }
    lines.push('');
  }

  return lines;
}

function formatTestSummaryLines(evalResults: EvalResult[], errors: TestError[]): string[] {
  const lines: string[] = [];

  const totalEvals = evalResults.length;
  const passed = evalResults.filter((e) => e.is_pass === true).length;
  const failed = evalResults.filter((e) => e.is_pass === false).length;
  const scored = evalResults.filter((e) => e.score != null && e.is_pass == null).length;

  lines.push(`**Summary**: ${totalEvals} evaluations`);
  if (passed || failed) {
    lines.push(`  - Passed: ${passed}, Failed: ${failed}`);
  }
  if (scored) {
    lines.push(`  - Scored (no threshold): ${scored}`);
  }
  if (errors.length > 0) {
    lines.push(`  - Errors: ${errors.length}`);
  }
  lines.push('');

  return lines;
}

function formatHuman(results: EvalApiResponse): string {
  const lines: string[] = ['# Agent Evaluation Results\n'];

  for (const testResult of results.results ?? []) {
    const testId = testResult.id ?? 'unknown';
    const errors = testResult.errors ?? [];
    const evalResults = testResult.evaluation_results ?? [];
    const outputs = testResult.outputs ?? [];

    lines.push(`## Test: ${testId}\n`);

    lines.push(...formatOutputLines(outputs));
    lines.push('');
    lines.push(...formatEvaluationTable(evalResults));
    lines.push(...formatErrorLines(errors));
    lines.push(...formatTestSummaryLines(evalResults, errors));
  }

  return lines.join('\n');
}

function formatJunit(results: EvalApiResponse): string {
  const allTests: Array<{
    name: string;
    classname: string;
    failed: boolean;
    errored: boolean;
    message: string;
    score: string;
  }> = [];

  for (const testResult of results.results ?? []) {
    const testId = testResult.id ?? 'unknown';

    for (const evalR of testResult.evaluation_results ?? []) {
      const stepId = evalR.id ?? 'unknown';
      const name = `${testId}.${stepId}`;
      const score = evalR.score;
      const isPass = evalR.is_pass;
      const error = evalR.error_message;

      allTests.push({
        name,
        classname: 'agent-eval-labs',
        failed: isPass === false,
        errored: !!error,
        message: error
          ? error
          : isPass === false
          ? `Expected ${String(evalR.expected_value ?? '')} but got ${String(evalR.actual_value ?? '')}`
          : '',
        score: score != null ? score.toFixed(3) : 'N/A',
      });
    }

    for (const err of testResult.errors ?? []) {
      const stepId = err.id ?? 'unknown';
      allTests.push({
        name: `${testId}.${stepId}`,
        classname: 'agent-eval-labs',
        failed: false,
        errored: true,
        message: err.error_message ?? 'Unknown error',
        score: 'N/A',
      });
    }
  }

  const totalTests = allTests.length;
  const failures = allTests.filter((t) => t.failed).length;
  const errors = allTests.filter((t) => t.errored).length;

  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<testsuites>',
    `  <testsuite name="agent-eval-labs" tests="${totalTests}" failures="${failures}" errors="${errors}">`,
  ];

  for (const tc of allTests) {
    lines.push(`    <testcase name="${escapeXml(tc.name)}" classname="${escapeXml(tc.classname)}">`);
    if (tc.errored) {
      lines.push(`      <error message="${escapeXml(tc.message)}">${escapeXml(tc.message)}</error>`);
    } else if (tc.failed) {
      lines.push(`      <failure message="${escapeXml(tc.message)}">Score: ${tc.score}</failure>`);
    }
    lines.push('    </testcase>');
  }

  lines.push('  </testsuite>');
  lines.push('</testsuites>');

  return lines.join('\n');
}

// --- formatTap helpers ---

type TapEntry = {
  ok: boolean;
  name: string;
  score: string;
  expected?: string;
  actual?: string;
  error?: string;
};

function buildTapEntries(results: EvalApiResponse): TapEntry[] {
  const entries: TapEntry[] = [];

  for (const testResult of results.results ?? []) {
    const testId = testResult.id ?? 'unknown';

    for (const evalR of testResult.evaluation_results ?? []) {
      const stepId = evalR.id ?? 'unknown';
      const name = `${testId}.${stepId}`;
      const score = evalR.score;
      const isPass = evalR.is_pass;
      const error = evalR.error_message;

      entries.push({
        ok: isPass !== false && !error,
        name,
        score: score != null ? score.toFixed(3) : 'N/A',
        expected: evalR.expected_value != null ? String(evalR.expected_value) : undefined,
        actual: evalR.actual_value != null ? String(evalR.actual_value) : undefined,
        error: error ?? undefined,
      });
    }

    for (const err of testResult.errors ?? []) {
      const stepId = err.id ?? 'unknown';
      entries.push({
        ok: false,
        name: `${testId}.${stepId}`,
        score: 'N/A',
        error: err.error_message ?? 'Unknown error',
      });
    }
  }

  return entries;
}

function formatTap(results: EvalApiResponse): string {
  const entries = buildTapEntries(results);

  const lines: string[] = ['TAP version 13', `1..${entries.length}`];

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const num = i + 1;
    const prefix = e.ok ? 'ok' : 'not ok';
    lines.push(`${prefix} ${num} - ${e.name} (score: ${e.score})`);

    if (!e.ok) {
      lines.push('  ---');
      if (e.expected !== undefined) {
        lines.push(`  expected: "${e.expected}"`);
      }
      if (e.actual !== undefined) {
        lines.push(`  actual: "${e.actual}"`);
      }
      if (e.error) {
        lines.push(`  error: "${e.error}"`);
      }
      lines.push('  ...');
    }
  }

  return lines.join('\n');
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
