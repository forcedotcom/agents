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
import { AgentforceStudioTester } from './agentforceStudioTester';
import { detectTestRunnerFromId, determineTestRunner } from './utils';
import type { TestRunnerType } from './utils';

export type CreateAgentTesterOptions = {
  /** Explicit runner type — always wins, no detection performed. */
  explicitType?: TestRunnerType;
  /** Existing run ID; prefix is used for instant detection without a network call. */
  runId?: string;
  /** Test definition name; triggers an org metadata query as last resort. */
  testDefinitionName?: string;
};

export type CreateAgentTesterResult = {
  runner: AgentTester | AgentforceStudioTester;
  type: TestRunnerType;
};

/**
 * Creates the appropriate tester based on detection priority:
 * 1. `explicitType` — always wins, no detection performed
 * 2. `runId` prefix — instant detection from the Salesforce ID prefix, no network call
 * 3. `testDefinitionName` — org metadata query, used as last resort
 */
export async function createAgentTester(
  connection: Connection,
  options: CreateAgentTesterOptions
): Promise<CreateAgentTesterResult> {
  const makeTester = (type: TestRunnerType): CreateAgentTesterResult => ({
    runner: type === 'agentforce-studio' ? new AgentforceStudioTester(connection) : new AgentTester(connection),
    type,
  });

  if (options.explicitType) {
    return makeTester(options.explicitType);
  }

  if (options.runId) {
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
