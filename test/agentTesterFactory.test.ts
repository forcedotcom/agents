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
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, SfError } from '@salesforce/core';
import { createAgentTester } from '../src/agentTesterFactory';
import { AgentTester } from '../src/agentTester';
import { AgentTesterNGT } from '../src/agentTesterNGT';

describe('createAgentTester', () => {
  const $$ = new TestContext();
  let connection: Connection;

  beforeEach(async () => {
    const testOrg = new MockTestOrgData();
    connection = await testOrg.getConnection();
  });

  afterEach(() => {
    $$.restore();
  });

  describe('with runId', () => {
    it('returns AgentTesterNGT for a 3A2 prefix run ID', async () => {
      const tester = await createAgentTester(connection, { runId: '3A2abc123' });
      expect(tester).to.be.instanceOf(AgentTesterNGT);
    });

    it('returns AgentTester for a 4KB prefix run ID', async () => {
      const tester = await createAgentTester(connection, { runId: '4KBabc123' });
      expect(tester).to.be.instanceOf(AgentTester);
    });

    it('throws UnrecognizedRunId for an unknown prefix', async () => {
      try {
        await createAgentTester(connection, { runId: '0HOunknown' });
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('UnrecognizedRunId');
      }
    });
  });

  describe('with testDefinitionName', () => {
    it('returns AgentTesterNGT when only NGT metadata exists', async () => {
      $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
        if ((query as { type: string }).type === 'AiTestingDefinition')
          return Promise.resolve([{ fullName: 'MySuite' }] as never);
        return Promise.resolve([] as never);
      });

      const tester = await createAgentTester(connection, { testDefinitionName: 'MySuite' });
      expect(tester).to.be.instanceOf(AgentTesterNGT);
    });

    it('returns AgentTester when only AiEvalDef metadata exists', async () => {
      $$.SANDBOX.stub(connection.metadata, 'list').callsFake((query) => {
        if ((query as { type: string }).type === 'AiEvaluationDefinition')
          return Promise.resolve([{ fullName: 'MySuite' }] as never);
        return Promise.resolve([] as never);
      });

      const tester = await createAgentTester(connection, { testDefinitionName: 'MySuite' });
      expect(tester).to.be.instanceOf(AgentTester);
    });

    it('throws AmbiguousTestDefinition when definition exists in both metadata types', async () => {
      $$.SANDBOX.stub(connection.metadata, 'list').callsFake(() => Promise.resolve([{ fullName: 'MySuite' }] as never));

      try {
        await createAgentTester(connection, { testDefinitionName: 'MySuite' });
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('AmbiguousTestDefinition');
      }
    });

    it('throws NoTestDefinitionsFound when no metadata types exist', async () => {
      $$.SANDBOX.stub(connection.metadata, 'list').resolves([] as never);

      try {
        await createAgentTester(connection, { testDefinitionName: 'MySuite' });
        expect.fail('Expected error was not thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('NoTestDefinitionsFound');
      }
    });
  });
});
