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

import { Connection, SfError } from '@salesforce/core';
import { AgentTester } from './agentTester';
import { AgentTesterNGT } from './agentTesterNGT';
import { detectTestRunnerFromId, determineTestRunner } from './utils';

/**
 * Creates the appropriate tester instance without requiring the caller to know which runner to use.
 *
 * When `runId` is provided the runner type is detected instantly from the Salesforce ID prefix
 * (`3A2` = Agentforce Studio, `4KB` = Testing Center) — no network call needed. This is the right choice when resuming
 * status/results polling for an existing run.
 *
 * When only `testDefinitionName` is provided, the org is queried for available metadata types to
 * determine the runner. Use this when starting a new test run.
 *
 * @example Resume polling an existing run:
 * ```typescript
 * const tester = await createAgentTester(connection, { runId: '3A2abc123' });
 * const results = await tester.results('3A2abc123');
 * ```
 *
 * @example Start a new test run:
 * ```typescript
 * const tester = await createAgentTester(connection, { testDefinitionName: 'MyTestSuite' });
 * const { runId } = await tester.start('MyTestSuite');
 * ```
 */
export async function createAgentTester(
  connection: Connection,
  options: { runId: string } | { testDefinitionName: string }
): Promise<AgentTester | AgentTesterNGT> {
  if ('runId' in options) {
    const runnerType = detectTestRunnerFromId(options.runId);
    if (!runnerType) {
      throw SfError.create({
        name: 'UnrecognizedRunId',
        message: `Cannot determine test runner from run ID '${options.runId}'. Expected a Salesforce ID starting with '3A2' (Agentforce Studio) or '4KB' (Testing Center).`,
      });
    }
    return runnerType === 'agentforce-studio' ? new AgentTesterNGT(connection) : new AgentTester(connection);
  }

  const runnerType = await determineTestRunner(connection, options.testDefinitionName);
  return runnerType === 'agentforce-studio' ? new AgentTesterNGT(connection) : new AgentTester(connection);
}
