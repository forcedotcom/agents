/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { Connection, PollingClient, StatusResult } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { MaybeMock } from './maybe-mock';

type Format = 'human' | 'tap' | 'junit' | 'json';

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
  private maybeMock: MaybeMock;
  public constructor(connection: Connection) {
    this.maybeMock = new MaybeMock(connection);
  }

  public async start(suiteId: string): Promise<{ id: string }> {
    const url = '/einstein/ai-evaluations/runs';

    return this.maybeMock.request<AgentTestStartResponse>('POST', url, {
      aiEvaluationSuiteDefinition: suiteId,
    });
  }

  public async status(jobId: string): Promise<AgentTestStatusResponse> {
    const url = `/einstein/ai-evaluations/runs/${jobId}`;

    return this.maybeMock.request<AgentTestStatusResponse>('GET', url);
  }

  public async poll(
    jobId: string,
    {
      format = 'human',
      timeout = Duration.minutes(5),
    }: {
      format?: Format;
      timeout?: Duration;
    }
  ): Promise<{ response: AgentTestDetailsResponse; formatted: string }> {
    const client = await PollingClient.create({
      poll: async (): Promise<StatusResult> => {
        const { status } = await this.status(jobId);
        if (status === 'COMPLETED') {
          return { payload: await this.details(jobId, format), completed: true };
        }

        return { completed: false };
      },
      frequency: Duration.seconds(1),
      timeout,
    });

    const result = await client.subscribe<{ response: AgentTestDetailsResponse; formatted: string }>();
    return result;
  }

  public async details(
    jobId: string,
    format: Format = 'human'
  ): Promise<{ response: AgentTestDetailsResponse; formatted: string }> {
    const url = `/einstein/ai-evaluations/runs/${jobId}/details`;

    const response = await this.maybeMock.request<AgentTestDetailsResponse>('GET', url);
    return {
      response,
      formatted:
        format === 'human'
          ? await humanFormat(response)
          : format === 'tap'
          ? await tapFormat(response)
          : format === 'junit'
          ? await junitFormat(response)
          : await jsonFormat(response),
    };
  }
}

export async function humanFormat(details: AgentTestDetailsResponse): Promise<string> {
  // TODO: these tables need to follow the same defaults that sf-plugins-core uses
  // TODO: the api response isn't finalized so this is just a POC
  const { makeTable } = await import('@oclif/table');
  const tables: string[] = [];
  for (const aiEvalDef of details.tests) {
    for (const result of aiEvalDef.results) {
      const table = makeTable({
        title: `Test Results for ${aiEvalDef.AiEvaluationDefinition} (#${result.test_number})`,
        data: result.results.map((r) => ({
          'TEST NAME': r.name,
          OUTCOME: r.is_pass ? 'Pass' : 'Fail',
          MESSAGE: r.error ?? '',
          'RUNTIME (MS)': r.execution_time_ms,
        })),
      });
      tables.push(table);
    }
  }

  return tables.join('\n');
}

export async function junitFormat(details: AgentTestDetailsResponse): Promise<string> {
  // APEX EXAMPLE
  // <?xml version="1.0" encoding="UTF-8"?>
  // <testsuites>
  //     <testsuite name="force.apex" timestamp="2024-11-13T19:19:23.000Z" hostname="https://energy-site-1368-dev-ed.scratch.my.salesforce.com" tests="11" failures="0"  errors="0"  time="2.57">
  //         <properties>
  //             <property name="outcome" value="Successful"/>
  //             <property name="testsRan" value="11"/>
  //             <property name="passing" value="11"/>
  //             <property name="failing" value="0"/>
  //             <property name="skipped" value="0"/>
  //             <property name="passRate" value="100%"/>
  //             <property name="failRate" value="0%"/>
  //             <property name="testStartTime" value="Wed Nov 13 2024 12:19:23 PM"/>
  //             <property name="testSetupTimeInMs" value="0"/>
  //             <property name="testExecutionTime" value="2.57 s"/>
  //             <property name="testTotalTime" value="2.57 s"/>
  //             <property name="commandTime" value="0.17 s"/>
  //             <property name="hostname" value="https://energy-site-1368-dev-ed.scratch.my.salesforce.com"/>
  //             <property name="orgId" value="00DEi000006OlrxMAC"/>
  //             <property name="username" value="test-mgoe8ogsltwe@example.com"/>
  //             <property name="testRunId" value="707Ei00000dTRSa"/>
  //             <property name="userId" value="005Ei00000FkGU9IAN"/>
  //         </properties>
  //         <testcase name="importSampleData" classname="TestSampleDataController" time="0.27">
  //         </testcase>
  //         <testcase name="blankAddress" classname="GeocodingServiceTest" time="0.01">
  //         </testcase>
  //         <testcase name="errorResponse" classname="GeocodingServiceTest" time="0.01">
  //         </testcase>
  //         <testcase name="successResponse" classname="GeocodingServiceTest" time="0.01">
  //         </testcase>
  //         <testcase name="createFileFailsWhenIncorrectBase64Data" classname="FileUtilitiesTest" time="0.10">
  //         </testcase>
  //         <testcase name="createFileFailsWhenIncorrectFilename" classname="FileUtilitiesTest" time="0.03">
  //         </testcase>
  //         <testcase name="createFileFailsWhenIncorrectRecordId" classname="FileUtilitiesTest" time="0.35">
  //         </testcase>
  //         <testcase name="createFileSucceedsWhenCorrectInput" classname="FileUtilitiesTest" time="0.22">
  //         </testcase>
  //         <testcase name="testGetPagedPropertyList" classname="TestPropertyController" time="1.01">
  //         </testcase>
  //         <testcase name="testGetPicturesNoResults" classname="TestPropertyController" time="0.06">
  //         </testcase>
  //         <testcase name="testGetPicturesWithResults" classname="TestPropertyController" time="0.51">
  //         </testcase>
  //     </testsuite>
  // </testsuites>
  await Promise.reject(new Error('Not implemented'));
  return JSON.stringify(details, null, 2);
}

export async function tapFormat(details: AgentTestDetailsResponse): Promise<string> {
  // APEX EXAMPLE
  // 1..11
  // ok 1 TestPropertyController.testGetPagedPropertyList
  // ok 2 TestPropertyController.testGetPicturesNoResults
  // ok 3 TestPropertyController.testGetPicturesWithResults
  // ok 4 FileUtilitiesTest.createFileFailsWhenIncorrectBase64Data
  // ok 5 FileUtilitiesTest.createFileFailsWhenIncorrectFilename
  // ok 6 FileUtilitiesTest.createFileFailsWhenIncorrectRecordId
  // ok 7 FileUtilitiesTest.createFileSucceedsWhenCorrectInput
  // ok 8 TestSampleDataController.importSampleData
  // ok 9 GeocodingServiceTest.blankAddress
  // ok 10 GeocodingServiceTest.errorResponse
  // ok 11 GeocodingServiceTest.successResponse
  // # Run "sf apex get test -i 707Ei00000dUJry -o test-mgoe8ogsltwe@example.com --result-format <format>" to retrieve test results in a different format.
  await Promise.reject(new Error('Not implemented'));
  return JSON.stringify(details, null, 2);
}

export async function jsonFormat(details: AgentTestDetailsResponse): Promise<string> {
  return Promise.resolve(JSON.stringify(details, null, 2));
}
