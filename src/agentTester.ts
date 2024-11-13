/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { Connection } from '@salesforce/core';
import { mockOrRequest } from './mockDir';

type AgentTestStartResponse = {
  id: string;
};

type AgentTestStatusResponse = {
  status: 'NEW' | 'IN_PROGRESS' | 'COMPLETED' | 'ERROR';
  startTime: string;
  endTime?: string;
  errorMessage?: string;
};

type AgentTestDetailsResponse = {
  AiEvaluationSuiteDefinition: string;
  tests: Array<{
    AiEvaluationDefinition: string;
    results: Array<{
      test_number: number;
      results: Array<{
        name: string;
        actual: string[];
        is_pass: boolean;
        execution_time_ms: number;
        error?: string;
      }>;
    }>;
  }>;
};

export class AgentTester {
  public constructor(private connection: Connection) {}

  public async start(suiteId: string): Promise<{ id: string }> {
    const url = `/services/data/${this.connection.getApiVersion()}/einstein/ai-evaluations/runs`;

    return mockOrRequest<AgentTestStartResponse>(this.connection, 'POST', url, {
      aiEvaluationSuiteDefinition: suiteId,
    });
  }

  public async status(jobId: string): Promise<AgentTestStatusResponse> {
    const url = `/services/data/${this.connection.getApiVersion()}/einstein/ai-evaluations/runs/${jobId}`;

    return mockOrRequest<AgentTestStatusResponse>(this.connection, 'GET', url);
  }

  public async details(jobId: string): Promise<AgentTestDetailsResponse> {
    const url = `/services/data/${this.connection.getApiVersion()}/einstein/ai-evaluations/runs/${jobId}/details`;

    return mockOrRequest<AgentTestDetailsResponse>(this.connection, 'GET', url);
  }
}
