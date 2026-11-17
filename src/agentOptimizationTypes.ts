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

export type StartOptimizationInput = {
  authoringBundleName: string;
  criteriaJson: string;
  testCasesJson?: string;
  maxIterations?: number;
  targetScore?: number;
};

export type OptimizationStatusEnum = 'RUNNING' | 'COMPLETED' | 'FAILED' | 'STOPPED_EARLY';

export type OptimizationExecution = {
  executionId: string;
  status: OptimizationStatusEnum;
  createdDate: string;
};

export type OptimizationStatus = {
  executionId: string;
  status: OptimizationStatusEnum;
  currentIteration: number;
  maxIterations: number;
  baselineScore: number;
  currentScore: number;
  bestScore: number;
  bestIteration: number;
  message: string;
};

export type IterationEntry = {
  iteration: number;
  compositeScore: number;
  gatesPassed: boolean;
};

export type OptimizationResults = {
  executionId: string;
  status: string;
  iterationsRun: number;
  baselineScore: number;
  finalScore: number;
  bestScore: number;
  bestIteration: number;
  iterationHistory: IterationEntry[];
};

export type OptimizationAcceptResult = {
  executionId: string;
  published: boolean;
  message: string;
};
