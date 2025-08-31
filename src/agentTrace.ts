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

import { Connection } from '@salesforce/core';
import { MaybeMock } from './maybe-mock';
import { type AgentTraceResponse } from './types';

/**
 * A service for retrieving agent execution traces. Provides detailed information
 * about agent plan execution including steps, timing, and safety scores.
 *
 * **Examples**
 *
 * Get trace data for a specific trace ID:
 *
 * `const traceData = await AgentTrace.getTrace(connection, '12-23-34');`
 */
export class AgentTrace {
  /**
   * Get the trace data for a given trace ID.
   *
   * @param connection The connection to use for making the API request
   * @param traceId The trace ID to retrieve trace data for
   * @returns Promise that resolves with the trace data response containing actions and their execution details
   * @beta
   */
  public static async getTrace(connection: Connection, traceId: string): Promise<AgentTraceResponse> {
    const maybeMock = new MaybeMock(connection);
    // TODO: who knows what the real endpoint will be, or if the return type is 100% accurate
    const url = `/api/trace/${traceId}`;

    return maybeMock.request<AgentTraceResponse>('GET', url);
  }
}
