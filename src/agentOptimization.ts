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
import { getHttpStatusCode } from './utils';
import { CtxLogger } from './ctxLogger';
import {
  type StartOptimizationInput,
  type OptimizationExecution,
  type OptimizationStatus,
  type OptimizationResults,
  type OptimizationAcceptResult,
} from './agentOptimizationTypes.js';

let logger: CtxLogger;
const getLogger = (): CtxLogger => {
  if (!logger) {
    logger = CtxLogger.child('AgentOptimization');
  }
  return logger;
};

function baseUrl(connection: Connection, executionId?: string): string {
  const base = `/services/data/v${String(connection.version)}/connect/hepo-optimizations`;
  return executionId ? `${base}/${executionId}` : base;
}

export class AgentOptimization {
  public static async start(
    connection: Connection,
    input: StartOptimizationInput
  ): Promise<OptimizationExecution> {
    try {
      return await connection.request<OptimizationExecution>({
        method: 'POST',
        url: baseUrl(connection),
        body: JSON.stringify({
          authoringBundleName: input.authoringBundleName,
          criteriaJson: input.criteriaJson,
          ...(input.testCasesJson !== undefined && { testCasesJson: input.testCasesJson }),
          ...(input.maxIterations !== undefined && { maxIterations: input.maxIterations }),
          ...(input.targetScore !== undefined && { targetScore: input.targetScore }),
        }),
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      getLogger().debug('Optimization start request failed', {
        authoringBundleName: input.authoringBundleName,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      throw wrapped;
    }
  }

  public static async status(
    connection: Connection,
    executionId: string
  ): Promise<OptimizationStatus> {
    try {
      return await connection.request<OptimizationStatus>({
        method: 'GET',
        url: baseUrl(connection, executionId),
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      getLogger().debug('Optimization status request failed', {
        executionId,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      throw wrapped;
    }
  }

  public static async results(
    connection: Connection,
    executionId: string
  ): Promise<OptimizationResults> {
    try {
      return await connection.request<OptimizationResults>({
        method: 'GET',
        url: `${baseUrl(connection, executionId)}/results`,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      getLogger().debug('Optimization results request failed', {
        executionId,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      throw wrapped;
    }
  }

  public static async accept(
    connection: Connection,
    executionId: string
  ): Promise<OptimizationAcceptResult> {
    try {
      return await connection.request<OptimizationAcceptResult>({
        method: 'POST',
        url: `${baseUrl(connection, executionId)}/accept`,
      });
    } catch (error) {
      const wrapped = SfError.wrap(error);
      getLogger().debug('Optimization accept request failed', {
        executionId,
        statusCode: getHttpStatusCode(error),
        errName: wrapped.name,
        errMsg: wrapped.message,
      });
      throw wrapped;
    }
  }
}
