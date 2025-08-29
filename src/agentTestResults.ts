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

import { XMLBuilder } from 'fast-xml-parser';
import { type AgentTestResultsResponse } from './types.js';

/**
 * Convert the raw, detailed test results to another format.
 *
 * @param results The detailed results from a test run.
 * @param format The desired format. One of: json, junit, or tap.
 * @returns
 */
export async function convertTestResultsToFormat(
  results: AgentTestResultsResponse,
  format: 'json' | 'junit' | 'tap'
): Promise<string> {
  switch (format) {
    case 'json':
      return jsonFormat(results);
    case 'junit':
      return junitFormat(results);
    case 'tap':
      return tapFormat(results);
    default:
      throw new Error(`Unsupported format: ${format as string}`);
  }
}

async function jsonFormat(results: AgentTestResultsResponse): Promise<string> {
  return Promise.resolve(JSON.stringify(results, null, 2));
}

async function junitFormat(results: AgentTestResultsResponse): Promise<string> {
  const builder = new XMLBuilder({
    format: true,
    attributeNamePrefix: '$',
    ignoreAttributes: false,
  });

  const testCount = results.testCases.length;
  const failureCount = results.testCases.filter(
    (tc) =>
      ['error', 'completed'].includes(tc.status.toLowerCase()) && tc.testResults.some((r) => r.result === 'FAILURE')
  ).length;
  const time = results.testCases.reduce((acc, tc) => {
    if (tc.endTime && tc.startTime) {
      return acc + new Date(tc.endTime).getTime() - new Date(tc.startTime).getTime();
    }
    return acc;
  }, 0);

  const suites = builder.build({
    testsuites: {
      $name: results.subjectName,
      $tests: testCount,
      $failures: failureCount,
      $time: time,
      property: [
        { $name: 'status', $value: results.status },
        { $name: 'start-time', $value: results.startTime },
        { $name: 'end-time', $value: results.endTime },
      ],
      testsuite: results.testCases.map((testCase) => {
        const testCaseTime = testCase.endTime
          ? new Date(testCase.endTime).getTime() - new Date(testCase.startTime).getTime()
          : 0;

        return {
          $name: testCase.testNumber,
          $time: testCaseTime,
          $assertions: testCase.testResults.length,
          failure: testCase.testResults
            .map((r) => {
              if (r.result === 'FAILURE') {
                return { $message: r.errorMessage ?? 'Unknown error', $name: r.name };
              }
            })
            .filter((f) => f),
        };
      }),
    },
  });

  return Promise.resolve(`<?xml version="1.0" encoding="UTF-8"?>\n${suites}`.trim());
}

async function tapFormat(results: AgentTestResultsResponse): Promise<string> {
  const lines: string[] = [];
  let expectationCount = 0;
  for (const testCase of results.testCases) {
    for (const result of testCase.testResults) {
      const status = result.result === 'PASS' ? 'ok' : 'not ok';
      expectationCount++;
      lines.push(`${status} ${expectationCount} ${testCase.testNumber}.${result.name}`);
      if (status === 'not ok') {
        lines.push('  ---');
        lines.push(`  message: ${result.errorMessage ?? 'Unknown error'}`);
        lines.push(`  expectation: ${result.name}`);
        lines.push(`  actual: ${result.actualValue}`);
        lines.push(`  expected: ${result.expectedValue}`);
        lines.push('  ...');
      }
    }
  }

  return Promise.resolve(`Tap Version 14\n1..${expectationCount}\n${lines.join('\n')}`);
}

export function humanFriendlyName(name: string): string {
  // topic_sequence_match, action_sequence_match, and bot_response_rating have all changed
  // eventually we can remove them
  switch (name) {
    case 'topic_sequence_match':
    case 'topic_assertion':
      return 'Topic';
    case 'action_sequence_match':
    case 'actions_assertion':
      return 'Action';
    case 'output_latency_milliseconds':
      return 'Output Latency';
    case 'instruction_following':
      return 'Instruction Following';
    case 'bot_response_rating':
    case 'output_validation':
      return 'Outcome';
    default:
      return name;
  }
}
