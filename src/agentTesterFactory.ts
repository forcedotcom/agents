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
 * Creates the appropriate tester based on runId prefix (no network call) or by querying the org
 * for available metadata types when only a testDefinitionName is provided.
 */
export async function createAgentTester(
  connection: Connection,
  options: { runId: string } | { testDefinitionName: string }
): Promise<AgentTester | AgentTesterNGT> {
  const makeTester = (runnerType: string): AgentTester | AgentTesterNGT =>
    runnerType === 'agentforce-studio' ? new AgentTesterNGT(connection) : new AgentTester(connection);

  if ('runId' in options) {
    const runnerType = detectTestRunnerFromId(options.runId);
    if (!runnerType) {
      throw SfError.create({
        name: 'UnrecognizedRunId',
        message: `Cannot determine test runner from run ID '${options.runId}'. Expected a Salesforce ID starting with '3A2' (Agentforce Studio) or '4KB' (Testing Center).`,
      });
    }
    return makeTester(runnerType);
  }

  return makeTester(await determineTestRunner(connection, options.testDefinitionName));
}
