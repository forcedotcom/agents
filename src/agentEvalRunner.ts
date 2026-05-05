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

import { Org } from '@salesforce/core';
import type { EvalPayload } from './evalNormalizer.js';
import type { EvalApiResponse } from './evalFormatter.js';

type ApiHeaders = {
  orgId: string;
  userId: string;
  instanceUrl: string;
};

export type AgentEvalRunResult = {
  tests: Array<{ id: string; status: string; evaluations: unknown[]; outputs: unknown[] }>;
  summary: { passed: number; failed: number; scored: number; errors: number };
};

async function getApiHeaders(org: Org): Promise<ApiHeaders> {
  const conn = org.getConnection();
  const userInfo = await conn.request<{ user_id: string }>(`${conn.instanceUrl}/services/oauth2/userinfo`);

  return {
    orgId: org.getOrgId(),
    userId: userInfo.user_id,
    instanceUrl: conn.instanceUrl,
  };
}

async function callEvalApi(org: Org, payload: EvalPayload, headers: ApiHeaders): Promise<{ results?: unknown[] }> {
  const conn = org.getConnection();

  return conn.request<{ results?: unknown[] }>({
    url: 'https://api.salesforce.com/einstein/evaluation/v1/tests',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-sfdc-core-tenant-id': `core/prod/${headers.orgId}`,
      'x-org-id': headers.orgId,
      'x-sfdc-core-instance-url': headers.instanceUrl,
      'x-sfdc-user-id': headers.userId,
      'x-client-feature-id': 'AIPlatformEvaluation',
      'x-sfdc-app-context': 'EinsteinGPT',
    },
    body: JSON.stringify(payload),
  });
}

export async function resolveAgent(org: Org, apiName: string): Promise<{ agentId: string; versionId: string }> {
  const conn = org.getConnection();

  // Escape single quotes to prevent SOQL injection
  const escapedApiName = apiName.replace(/'/g, "\\'");

  const botResult = await conn.query<{ Id: string }>(
    `SELECT Id FROM BotDefinition WHERE DeveloperName = '${escapedApiName}'`
  );
  if (!botResult.records.length) {
    throw new Error(`Agent '${apiName}' not found`);
  }
  const agentId = botResult.records[0].Id;

  const versionResult = await conn.query<{ Id: string }>(
    `SELECT Id FROM BotVersion WHERE BotDefinitionId = '${agentId}' ORDER BY VersionNumber DESC LIMIT 1`
  );
  if (!versionResult.records.length) {
    throw new Error(`No version found for agent '${apiName}'`);
  }
  const versionId = versionResult.records[0].Id;

  return { agentId, versionId };
}

export async function executeBatches(
  org: Org,
  batches: Array<EvalPayload['tests']>,
  log?: (msg: string) => void
): Promise<unknown[]> {
  const headers = await getApiHeaders(org);

  if (batches.length > 1) {
    log?.(`Running ${batches.length} batches in parallel`);
  }

  const batchPromises = batches.map(async (batch) => {
    const batchPayload: EvalPayload = { tests: batch };
    const resultObj = await callEvalApi(org, batchPayload, headers);
    return resultObj.results ?? [];
  });

  const batchResults = await Promise.all(batchPromises);
  return batchResults.flat();
}

export function buildResultSummary(mergedResponse: EvalApiResponse): {
  summary: AgentEvalRunResult['summary'];
  testSummaries: AgentEvalRunResult['tests'];
} {
  const summary = { passed: 0, failed: 0, scored: 0, errors: 0 };
  const testSummaries: Array<{ id: string; status: string; evaluations: unknown[]; outputs: unknown[] }> = [];

  for (const testResult of mergedResponse.results ?? []) {
    const tr = testResult as Record<string, unknown>;
    const testId = (tr.id as string) ?? 'unknown';
    const evalResults = (tr.evaluation_results as Array<Record<string, unknown>>) ?? [];
    const testErrors = (tr.errors as unknown[]) ?? [];

    const passed = evalResults.filter((e) => e.is_pass === true).length;
    const failed = evalResults.filter((e) => e.is_pass === false).length;
    const scored = evalResults.filter((e) => e.score != null && e.is_pass == null).length;

    summary.passed += passed;
    summary.failed += failed;
    summary.scored += scored;
    summary.errors += testErrors.length;

    testSummaries.push({
      id: testId,
      status: failed > 0 || testErrors.length > 0 ? 'failed' : 'passed',
      evaluations: evalResults,
      outputs: (tr.outputs as unknown[]) ?? [],
    });
  }

  return { summary, testSummaries };
}
