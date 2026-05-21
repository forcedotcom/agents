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
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sinon from 'sinon';
import { expect } from 'chai';
import { MockTestOrgData, TestContext } from '@salesforce/core/testSetup';
import { Connection, Lifecycle, SfError } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { AgentTest } from '../src';
import {
  validateNgtSpec,
  convertToTestingMetadata,
  buildTestingMetadataXml,
} from '../src/agentTest';
import type { NgtTestSpec } from '../src/types';

/**
 * Normalize a serialized XML string for comparison:
 *   - normalize line endings to \n
 *   - trim trailing whitespace per line
 *   - drop a final trailing newline
 *
 * The XMLBuilder may emit empty self-closing differences depending on options;
 * if the developer's serializer differs in those edge details, the test should
 * fail loud rather than silently — that's why we don't strip blank lines.
 */
const normalizeXml = (xml: string): string =>
  xml.replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n+$/, '');

describe('AgentTest NGT (Agentforce Studio) create surface', () => {
  const $$ = new TestContext();
  let testOrg: MockTestOrgData;
  let connection: Connection;

  beforeEach(async () => {
    $$.inProject(true);
    testOrg = new MockTestOrgData();
    process.env.SF_MOCK_DIR = 'test/mocks';
    connection = await testOrg.getConnection();
    connection.instanceUrl = 'https://mydomain.salesforce.com';
    // restore the connection sandbox so that it doesn't override the builtin mocking (MaybeMock)
    $$.SANDBOXES.CONNECTION.restore();
  });

  afterEach(() => {
    delete process.env.SF_MOCK_DIR;
  });

  // -------------------------------------------------------------------------
  // validateNgtSpec — pure validator
  // -------------------------------------------------------------------------
  describe('validateNgtSpec', () => {
    /** Smallest legal single-agent spec. Tests mutate copies of this. */
    const baseSpec = (): NgtTestSpec => ({
      name: 'Suite',
      subjectType: 'AGENT',
      subjectName: 'MyAgent',
      testCases: [
        {
          inputs: [{ utterance: 'hello' }],
          scorers: [{ name: 'topic_sequence_match', expected: 'GeneralCRM' }],
        },
      ],
    });

    afterEach(() => {
      sinon.restore();
    });

    it('passes for a minimal valid spec (single-agent)', () => {
      expect(() => validateNgtSpec(baseSpec(), { isMultiAgent: false })).to.not.throw();
    });

    it('throws ngtMissingTestCases when testCases is empty', () => {
      const spec = baseSpec();
      spec.testCases = [];
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtMissingTestCases');
      }
    });

    it('throws ngtTestCaseMissingInputs when a test case has empty inputs[]', () => {
      const spec = baseSpec();
      spec.testCases[0].inputs = [];
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtTestCaseMissingInputs');
      }
    });

    it('throws ngtTestCaseMissingScorers when a test case has empty scorers[]', () => {
      const spec = baseSpec();
      spec.testCases[0].scorers = [];
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtTestCaseMissingScorers');
      }
    });

    it('throws ngtScorerMissingExpected when a needsExpected scorer omits expected', () => {
      const spec = baseSpec();
      // bot_response_rating is needsExpected:true (LLM_PASS_FAIL)
      spec.testCases[0].scorers = [{ name: 'bot_response_rating' }];
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtScorerMissingExpected');
        // Message must mention which scorer triggered the failure (per plan: "needs the scorer name").
        expect((err as SfError).message).to.include('bot_response_rating');
      }
    });

    it('passes when a needsExpected scorer has expected', () => {
      const spec = baseSpec();
      spec.testCases[0].scorers = [
        { name: 'bot_response_rating', expected: 'a friendly greeting' },
      ];
      expect(() => validateNgtSpec(spec, { isMultiAgent: false })).to.not.throw();
    });

    it('passes when a quality scorer (needsExpected:false) omits expected', () => {
      const spec = baseSpec();
      // coherence is needsExpected:false (LLM_0_100)
      spec.testCases[0].scorers = [
        { name: 'topic_sequence_match', expected: 'GeneralCRM' },
        { name: 'coherence' },
      ];
      expect(() => validateNgtSpec(spec, { isMultiAgent: false })).to.not.throw();
    });

    it('emits a Lifecycle warn event for an unknown scorer name (does not throw)', async () => {
      const lifecycleSpy = sinon.spy(Lifecycle.prototype, 'emitWarning');
      const spec = baseSpec();
      // Cast through unknown to bypass static typing; this models a hand-edited YAML.
      (spec.testCases[0].scorers as unknown as Array<{ name: string; expected?: string }>).push({
        name: 'made_up_scorer',
        expected: 'whatever',
      });
      expect(() => validateNgtSpec(spec, { isMultiAgent: false })).to.not.throw();
      expect(lifecycleSpy.called).to.be.true;
      const allWarnArgs = lifecycleSpy.getCalls().flatMap((c) => c.args.map(String));
      expect(allWarnArgs.some((a) => a.includes('made_up_scorer'))).to.be.true;
    });

    it('throws ngtTaskResolutionRequiresConversationHistory when task_resolution lacks conversationHistory', () => {
      const spec = baseSpec();
      spec.testCases[0].scorers = [{ name: 'task_resolution' }];
      // No conversationHistory on any input — should fail.
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtTaskResolutionRequiresConversationHistory');
      }
    });

    it('passes when task_resolution is paired with conversationHistory on at least one input', () => {
      const spec = baseSpec();
      spec.testCases[0].inputs = [
        {
          utterance: 'follow up',
          conversationHistory: [
            { role: 'user', message: 'first turn' },
            { role: 'agent', message: 'sure', topic: 'GeneralCRM' },
          ],
        },
      ];
      spec.testCases[0].scorers = [{ name: 'task_resolution' }];
      expect(() => validateNgtSpec(spec, { isMultiAgent: false })).to.not.throw();
    });

    it('throws ngtMultiAgentMissingHandoff when isMultiAgent:true and a test case omits agent_handoff_match', () => {
      const spec = baseSpec();
      // Only topic_sequence_match in default — no agent_handoff_match.
      try {
        validateNgtSpec(spec, { isMultiAgent: true });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtMultiAgentMissingHandoff');
      }
    });

    it('passes when isMultiAgent:true and every test case has agent_handoff_match with expected', () => {
      const spec = baseSpec();
      spec.testCases[0].scorers = [
        { name: 'topic_sequence_match', expected: 'GeneralCRM' },
        { name: 'agent_handoff_match', expected: 'CheckoutAgent' },
      ];
      expect(() => validateNgtSpec(spec, { isMultiAgent: true })).to.not.throw();
    });

    it('throws ngtConversationHistoryIndexAllOrNothing when one input mixes indexed and unindexed turns', () => {
      const spec = baseSpec();
      spec.testCases[0].inputs = [
        {
          utterance: 'mixed indices',
          conversationHistory: [
            { role: 'user', message: 'first', index: 0 },
            { role: 'agent', message: 'second', topic: 'GeneralCRM' }, // no index
            { role: 'user', message: 'third', index: 2 },
          ],
        },
      ];
      try {
        validateNgtSpec(spec, { isMultiAgent: false });
        expect.fail('expected validateNgtSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtConversationHistoryIndexAllOrNothing');
      }
    });

    it('passes when every conversation turn has an index OR none do (the all-or-nothing rule, satisfied)', () => {
      const allSet = baseSpec();
      allSet.testCases[0].inputs = [
        {
          utterance: 'all indexed',
          conversationHistory: [
            { role: 'user', message: 'a', index: 5 },
            { role: 'agent', message: 'b', topic: 'GeneralCRM', index: 6 },
          ],
        },
      ];
      expect(() => validateNgtSpec(allSet, { isMultiAgent: false })).to.not.throw();

      const noneSet = baseSpec();
      noneSet.testCases[0].inputs = [
        {
          utterance: 'none indexed',
          conversationHistory: [
            { role: 'user', message: 'a' },
            { role: 'agent', message: 'b', topic: 'GeneralCRM' },
          ],
        },
      ];
      expect(() => validateNgtSpec(noneSet, { isMultiAgent: false })).to.not.throw();
    });
  });

  // -------------------------------------------------------------------------
  // convertToTestingMetadata — pure converter (and buildTestingMetadataXml)
  // -------------------------------------------------------------------------
  describe('convertToTestingMetadata + buildTestingMetadataXml', () => {
    // Spec doc §7 "ReturnsCheckoutSuite" verbatim — the canonical example from the
    // spec author. Exact-XML compare proves the converter produces what the spec
    // doc draws. Drift between this fixture and the spec doc means we re-transcribe;
    // never adjust the converter to match a stale fixture. See top of fixture file
    // for the one cleanup applied (spec §7 has duplicate "case 6" entries).
    it('matches the expected XML fixture for the ReturnsCheckoutSuite spec (spec doc §7)', async () => {
      const yamlPath = join(__dirname, 'fixtures', 'ngt-spec-returns-checkout.yaml');
      const xmlPath = join(__dirname, 'fixtures', 'ngt-xml-returns-checkout.xml');

      const { parse } = await import('yaml');
      const spec = parse(await fs.readFile(yamlPath, 'utf-8')) as NgtTestSpec;

      const def = convertToTestingMetadata(spec);
      const actual = buildTestingMetadataXml(def);
      const expected = await fs.readFile(xmlPath, 'utf-8');

      expect(normalizeXml(actual)).to.equal(normalizeXml(expected));
    });

    it('multi-input fan-out: one inputs[] with 3 entries → 3 <testCase> elements, shared scorers, globally numbered', () => {
      const spec: NgtTestSpec = {
        name: 'OrderStatusOnly',
        subjectType: 'AGENT',
        subjectName: 'Returns',
        testCases: [
          {
            inputs: [
              { utterance: "What's the status of order #12345?" },
              { utterance: 'Where is my order 12345' },
              { utterance: 'Tell me about order #12345' },
            ],
            scorers: [
              { name: 'topic_sequence_match', expected: 'order_status' },
              { name: 'action_sequence_match', expected: 'Get_Order_Status' },
            ],
          },
        ],
      };

      const def = convertToTestingMetadata(spec);
      expect(def.testCase).to.have.length(3);
      expect(def.testCase.map((tc) => tc.number)).to.deep.equal([1, 2, 3]);
      // All three share the same scorer set verbatim.
      def.testCase.forEach((tc) => {
        expect(tc.scorer.map((s) => s.name)).to.deep.equal([
          'topic_sequence_match',
          'action_sequence_match',
        ]);
        expect(tc.scorer.map((s) => s.expectedValue)).to.deep.equal([
          'order_status',
          'Get_Order_Status',
        ]);
      });
      // Utterances are distributed 1-per-testCase in input order.
      expect(def.testCase.map((tc) => tc.inputs.utterance)).to.deep.equal([
        "What's the status of order #12345?",
        'Where is my order 12345',
        'Tell me about order #12345',
      ]);
    });

    it('quality scorer (needsExpected:false) emits <scorer> without <expectedValue>', () => {
      const spec: NgtTestSpec = {
        name: 'Q',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [{ utterance: 'hi' }],
            scorers: [{ name: 'coherence' }],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      const scorer = def.testCase[0].scorer[0];
      expect(scorer.name).to.equal('coherence');
      expect(scorer.expectedValue).to.be.undefined;

      // Cross-check: the serialized XML must not have an <expectedValue> for coherence.
      const xml = buildTestingMetadataXml(def);
      // Find the scorer block and assert no expectedValue inside it.
      const coherenceBlock = xml.match(/<scorer>\s*<name>coherence<\/name>[\s\S]*?<\/scorer>/);
      expect(coherenceBlock, 'coherence scorer block').to.not.be.null;
      expect(coherenceBlock![0]).to.not.include('<expectedValue>');
    });

    it('assertion scorer (needsExpected:true) emits <scorer> with <expectedValue>', () => {
      const spec: NgtTestSpec = {
        name: 'A',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [{ utterance: 'hi' }],
            scorers: [{ name: 'topic_sequence_match', expected: 'Greeting' }],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      const scorer = def.testCase[0].scorer[0];
      expect(scorer.name).to.equal('topic_sequence_match');
      expect(scorer.expectedValue).to.equal('Greeting');
    });

    it('action_sequence_match with a single value emits the bare value in <expectedValue>', () => {
      const spec: NgtTestSpec = {
        name: 'A',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [{ utterance: 'hi' }],
            scorers: [{ name: 'action_sequence_match', expected: 'Get_Order_Status' }],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      expect(def.testCase[0].scorer[0].expectedValue).to.equal('Get_Order_Status');
      const xml = buildTestingMetadataXml(def);
      expect(xml).to.include('<expectedValue>Get_Order_Status</expectedValue>');
      // Specifically must NOT be wrapped in [ ... ] or quoted.
      expect(xml).to.not.include("['Get_Order_Status']");
    });

    it("action_sequence_match with the python-list-string passes through verbatim to <expectedValue>", () => {
      // Per plan: NgtTestCaseScorer.expected?: string — the user passes the python-list-string
      // (single-quoted, comma-joined, no spaces) verbatim, matching spec doc §7's wire format.
      const spec: NgtTestSpec = {
        name: 'A',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [{ utterance: 'hi' }],
            scorers: [
              { name: 'action_sequence_match', expected: "['Verify_Customer','Get_Order_Status']" },
            ],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      expect(def.testCase[0].scorer[0].expectedValue).to.equal(
        "['Verify_Customer','Get_Order_Status']"
      );
      const xml = buildTestingMetadataXml(def);
      // XMLBuilder encodes ' as &apos;.
      expect(xml).to.include('[&apos;Verify_Customer&apos;,&apos;Get_Order_Status&apos;]');
    });

    it('auto-assigns conversationHistory.index 0..n-1 when none are set', () => {
      const spec: NgtTestSpec = {
        name: 'A',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [
              {
                utterance: 'follow-up',
                conversationHistory: [
                  { role: 'user', message: 'a' },
                  { role: 'agent', message: 'b', topic: 'GeneralCRM' },
                  { role: 'user', message: 'c' },
                ],
              },
            ],
            scorers: [{ name: 'task_resolution' }],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      const turns = def.testCase[0].inputs.conversationHistory!;
      expect(turns.map((t) => t.index)).to.deep.equal([0, 1, 2]);
    });

    it('preserves conversationHistory.index verbatim when every turn has one', () => {
      const spec: NgtTestSpec = {
        name: 'A',
        subjectType: 'AGENT',
        subjectName: 'A',
        testCases: [
          {
            inputs: [
              {
                utterance: 'follow-up',
                conversationHistory: [
                  { role: 'user', message: 'a', index: 7 },
                  { role: 'agent', message: 'b', topic: 'GeneralCRM', index: 8 },
                ],
              },
            ],
            scorers: [{ name: 'task_resolution' }],
          },
        ],
      };
      const def = convertToTestingMetadata(spec);
      const turns = def.testCase[0].inputs.conversationHistory!;
      expect(turns.map((t) => t.index)).to.deep.equal([7, 8]);
    });
  });

  // -------------------------------------------------------------------------
  // AgentTest.create() with testRunner: 'agentforce-studio'
  // -------------------------------------------------------------------------
  describe("AgentTest.create with testRunner: 'agentforce-studio'", () => {
    let writeFileStub: sinon.SinonStub;
    let readFileStub: sinon.SinonStub;
    let mkdirStub: sinon.SinonStub;
    let componentSetBuildStub: sinon.SinonStub;

    const yamlSpec = `name: SimpleSuite
description: NGT minimal
subjectType: AGENT
subjectName: MyAgent
testCases:
  - inputs:
      - utterance: hello
    scorers:
      - name: topic_sequence_match
        expected: Greeting
      - name: conciseness
`;

    beforeEach(() => {
      writeFileStub = sinon.stub(fs, 'writeFile').resolves();
      mkdirStub = sinon.stub(fs, 'mkdir').resolves();
      readFileStub = sinon.stub(fs, 'readFile').resolves(yamlSpec);
      componentSetBuildStub = sinon.stub(ComponentSetBuilder, 'build');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('preview: true writes <apiName>.aiTestingDefinition-meta.xml without invoking deploy', async () => {
      const result = await AgentTest.create(connection, 'MyTest', 'spec.yaml', {
        outputDir: 'tmp',
        preview: true,
        testRunner: 'agentforce-studio',
      } as never); // cast: option type is added in src by the developer.

      expect(result.path).to.match(/MyTest\.aiTestingDefinition-meta\.xml$/);
      expect(componentSetBuildStub.called, 'ComponentSetBuilder.build must NOT be called when preview=true').to.be
        .false;
      expect(writeFileStub.calledOnce).to.be.true;
    });

    it("preview output's XML root is <AiTestingDefinition xmlns=...> (NGT root, not legacy)", async () => {
      const { contents } = await AgentTest.create(connection, 'MyTest', 'spec.yaml', {
        outputDir: 'tmp',
        preview: true,
        testRunner: 'agentforce-studio',
      } as never);

      expect(contents).to.include('<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">');
      expect(contents).to.not.include('<AiEvaluationDefinition');
    });

    it('non-preview path queries BotDefinition.IsMultiAgent and proceeds to deploy on a single-agent subject', async () => {
      // Mock connection.metadata.read for the multi-agent gate.
      // jsforce types don't model BotDefinition; the lib uses the same pattern as for AiEvaluationDefinition.
      const metadataReadStub = sinon
        .stub(connection.metadata, 'read')
        .resolves({ IsMultiAgent: false } as never);

      // Stub a successful deploy.
      const mockDeploy = {
        onUpdate: sinon.stub(),
        onFinish: sinon.stub(),
        pollStatus: sinon.stub().resolves({
          response: { success: true, details: { componentFailures: [] } },
        }),
      };
      const mockComponentSet = { deploy: sinon.stub().resolves(mockDeploy) };
      componentSetBuildStub.resolves(mockComponentSet as never);

      const result = await AgentTest.create(connection, 'MyTest', 'spec.yaml', {
        outputDir: 'tmp',
        preview: false,
        testRunner: 'agentforce-studio',
      } as never);

      expect(result.path).to.match(/MyTest\.aiTestingDefinition-meta\.xml$/);
      expect(metadataReadStub.calledWith('BotDefinition' as never, 'MyAgent' as never)).to.be.true;
      expect(componentSetBuildStub.calledOnce).to.be.true;
      expect(mockComponentSet.deploy.calledOnce).to.be.true;
      expect(mkdirStub.calledOnce).to.be.true;
    });

    // Regression guard: omitting testRunner → legacy behavior, byte-for-byte.
    // The existing legacy `describe('create', ...)` already covers most of this;
    // this single concise test pins the filename suffix.
    it('regression: omitting testRunner writes <apiName>.aiEvaluationDefinition-meta.xml (legacy path unchanged)', async () => {
      readFileStub.restore();
      const legacyYaml = `name: Legacy
description: Legacy
subjectType: AGENT
subjectName: MyAgent
testCases:
  - utterance: hi
    expectedActions:
      - DoSomething
    expectedOutcome: did something
    expectedTopic: General
`;
      sinon.stub(fs, 'readFile').resolves(legacyYaml);
      sinon.stub(AgentTest, 'list').resolves([]);
      const { path } = await AgentTest.create(connection, 'LegacyTest', 'spec.yaml', {
        outputDir: 'tmp',
        preview: true,
      });
      expect(path).to.match(/LegacyTest\.aiEvaluationDefinition-meta\.xml$/);
      expect(path).to.not.include('aiTestingDefinition');
    });
  });

  // -------------------------------------------------------------------------
  // SDR registry resolution: lock in the suffix and catch SDR version drift.
  // This is a real (not mocked) call to ComponentSetBuilder.
  // -------------------------------------------------------------------------
  describe('SDR registry resolution for AiTestingDefinition', () => {
    let workDir: string;

    beforeEach(async () => {
      workDir = await fs.mkdtemp(join(tmpdir(), 'agents-ngt-sdr-'));
    });

    afterEach(async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    });

    it('ComponentSetBuilder resolves <name>.aiTestingDefinition-meta.xml to type=AiTestingDefinition', async () => {
      // Source-format file. The XML body just needs to be a parseable, valid-shape AiTestingDefinition;
      // SDR picks the metadata type from the suffix, not the body.
      const filename = 'SdrSmoke.aiTestingDefinition-meta.xml';
      const filePath = join(workDir, filename);
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '    <name>SdrSmoke</name>\n' +
        '    <subjectName>MyAgent</subjectName>\n' +
        '    <subjectType>AGENT</subjectType>\n' +
        '</AiTestingDefinition>\n';
      await fs.mkdir(workDir, { recursive: true });
      await fs.writeFile(filePath, xml, 'utf-8');

      const cs = await ComponentSetBuilder.build({ sourcepath: [filePath] });

      expect(cs.size, 'expected exactly one component for the source file').to.equal(1);
      const components = cs.getSourceComponents().toArray();
      expect(components).to.have.length(1);
      expect(components[0].type.name).to.equal('AiTestingDefinition');
    });
  });
});
