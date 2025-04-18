/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
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
  }) as string;

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
    case 'bot_response_rating':
    case 'output_validation':
      return 'Outcome';
    default:
      return name;
  }
}
