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

import { Connection, Messages } from '@salesforce/core';
import { MaybeMock } from './maybe-mock';
import { CtxLogger } from './ctxLogger';
import { decodeHtmlEntities } from './utils';
import type {
  ConversationScorerOutcome,
  ConversationTestResultsResponse,
  CreateAndRunConversationTestSuiteInput,
  CreateAndRunConversationTestSuiteResponse,
  EphemeralConversationTestInput,
} from './types';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'conversationTester');

let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('ConversationTester');
  }
  return logger;
};

const BASE_URL = '/einstein/ai-testing';

/**
 * A client for conversation-level tests (Testing Center). Build the request bodies with
 * `cltSpecToEphemeralInput` / `cltSpecToCreateAndRunInput`.
 *
 * **Examples**
 *
 * Run without saving (synchronous):
 *
 * `const results = await new ConversationTester(connection).runEphemeral(cltSpecToEphemeralInput(spec, agent));`
 *
 * Save the suite and start a run, then poll it with `AgentforceStudioTester.poll(runId)`:
 *
 * `const { testSuiteId, runId } = await new ConversationTester(connection).createAndRun(input);`
 */
export class ConversationTester {
  private maybeMock: MaybeMock;

  public constructor(connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  /**
   * Runs conversation tests without saving a suite, and waits for the results.
   *
   * The endpoint reports rejected input as HTTP 200 with `status: "Failed"` and no test cases;
   * that case throws `ConversationTestRejected` with the server's message. A `Failed` run that
   * has test cases (for example, the agent failed mid-conversation) is returned so the caller
   * can report each case.
   *
   * @param input - The request body, usually from `cltSpecToEphemeralInput`.
   * @returns The run results, with HTML entities decoded in the JSON-string fields.
   */
  public async runEphemeral(input: EphemeralConversationTestInput): Promise<ConversationTestResultsResponse> {
    const url = `${BASE_URL}/conversation-tests/ephemeral-run`;
    const response = await this.maybeMock.request<ConversationTestResultsResponse>('POST', url, input);
    const testCases = response?.testCases ?? [];

    if (response?.status?.toLowerCase() === 'failed' && testCases.length === 0) {
      const errorCode = response.errorRepresentation?.errorCode;
      const errorMessage = response.errorRepresentation?.errorMessage;
      getLogger().debug('Ephemeral conversation test run rejected', { errorCode, errorMessage });
      throw messages.createError('conversationTestRejected', [errorMessage ?? messages.getMessage('noServerMessage')]);
    }

    return normalizeConversationTestResults({ ...response, testCases });
  }

  /**
   * Saves a conversation-level test suite and starts a run.
   *
   * @param input - The request body, usually from `cltSpecToCreateAndRunInput`.
   * @returns The new suite ID (1W4) and run ID (3A2).
   */
  public async createAndRun(
    input: CreateAndRunConversationTestSuiteInput
  ): Promise<CreateAndRunConversationTestSuiteResponse> {
    const url = `${BASE_URL}/conversation-test-suites/create-and-run`;
    const response = await this.maybeMock.request<CreateAndRunConversationTestSuiteResponse>('POST', url, input);

    if (!response?.testSuiteId || !response.runId) {
      getLogger().debug('Conversation test suite create-and-run returned no IDs', {
        status: response?.status,
        statusMessage: response?.statusMessage,
      });
      throw messages.createError('conversationSuiteNotStarted', [
        response?.statusMessage ?? messages.getMessage('noServerMessage'),
      ]);
    }
    return response;
  }
}

/** Decodes HTML entities in the JSON-string `subjectResponse` and `scorerResponse` fields. */
export function normalizeConversationTestResults(
  results: ConversationTestResultsResponse
): ConversationTestResultsResponse {
  return {
    ...results,
    testCases: results.testCases.map((tc) => ({
      ...tc,
      subjectResponse: tc.subjectResponse === undefined ? undefined : decodeHtmlEntities(tc.subjectResponse),
      testScorerResults: tc.testScorerResults?.map((scorer) => ({
        ...scorer,
        scorerResponse: scorer.scorerResponse === undefined ? undefined : decodeHtmlEntities(scorer.scorerResponse),
      })),
    })),
  };
}

/**
 * Reads a scorer's outcome from its JSON-string `scorerResponse`. Task Resolution puts the
 * fields either at the top level or under `content`; both are read. Values are passed through
 * as sent (for example `score` may be an integer or a decimal).
 *
 * @returns The outcome, or `undefined` when the response is missing or isn't a JSON object.
 */
export function parseConversationScorerResponse(scorerResponse?: string): ConversationScorerOutcome | undefined {
  if (!scorerResponse) return undefined;
  const parsed = parseJson(decodeHtmlEntities(scorerResponse));
  if (!isRecord(parsed)) return undefined;
  const content = isRecord(parsed.content) ? parsed.content : {};
  const pick = (key: string): unknown => content[key] ?? parsed[key];
  const status = pick('status');
  const score = pick('score');
  const reasoning = pick('reasoning') ?? pick('explanation');
  return {
    ...(typeof status === 'string' ? { status } : {}),
    ...(typeof score === 'number' || typeof score === 'string' ? { score } : {}),
    ...(typeof reasoning === 'string' ? { reasoning } : {}),
  };
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
