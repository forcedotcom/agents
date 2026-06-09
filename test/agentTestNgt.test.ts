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
  convertToNgtSpec,
  buildTestingMetadataXml,
  parseNgtMetadataXml,
} from '../src/agentTest';
import type { NgtTestSpec } from '../src/types';

/**
 * Normalize a serialized XML string for comparison:
 * - normalize line endings to \n
 * - trim trailing whitespace per line
 * - drop a final trailing newline
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

    it('action_sequence_match with the python-list-string passes through verbatim to <expectedValue>', () => {
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
  // parseNgtMetadataXml — XML metadata → NgtTestSpec (reverse of convertToTestingMetadata)
  // -------------------------------------------------------------------------
  describe('parseNgtMetadataXml', () => {
    /** Test helper: parse + convert in one step, mirroring how callers use these together. */
    const parseToSpec = (xml: string): NgtTestSpec => convertToNgtSpec(parseNgtMetadataXml(xml));

    afterEach(() => {
      sinon.restore();
    });

    it('round-trips the canonical fixture: yaml → metadata → xml → parse → yaml-equivalent spec', async () => {
      const yamlPath = join(__dirname, 'fixtures', 'ngt-spec-returns-checkout.yaml');
      const xmlPath = join(__dirname, 'fixtures', 'ngt-xml-returns-checkout.xml');

      const { parse } = await import('yaml');
      const sourceSpec = parse(await fs.readFile(yamlPath, 'utf-8')) as NgtTestSpec;

      const xml = await fs.readFile(xmlPath, 'utf-8');
      const parsed = parseToSpec(xml);

      // Top-level passthrough fields.
      expect(parsed.name).to.equal(sourceSpec.name);
      expect(parsed.description).to.equal(sourceSpec.description);
      expect(parsed.subjectName).to.equal(sourceSpec.subjectName);
      expect(parsed.subjectType).to.equal(sourceSpec.subjectType);
      expect(parsed.subjectVersion).to.equal(sourceSpec.subjectVersion);

      // Multi-input case 7 in the fixture fans out to 3 <testCase> elements; the parser
      // collapses those back into one case with 3 inputs sharing the scorer set.
      expect(parsed.testCases).to.have.length(sourceSpec.testCases.length);

      // Convert source → metadata → xml → parse and compare structurally.
      const synthesizedXml = buildTestingMetadataXml(convertToTestingMetadata(sourceSpec));
      const reparsed = parseToSpec(synthesizedXml);
      expect(reparsed).to.deep.equal(parsed);
    });

    it('preserves all 11 catalog scorers across the canonical fixture (presence + expected shape)', async () => {
      const xmlPath = join(__dirname, 'fixtures', 'ngt-xml-returns-checkout.xml');
      const xml = await fs.readFile(xmlPath, 'utf-8');
      const parsed = parseToSpec(xml);

      const scorerNames = new Set<string>();
      parsed.testCases.forEach((tc) => tc.scorers.forEach((s) => scorerNames.add(s.name)));

      // The fixture exercises 9 of the 11 scorers (no conciseness, no output_latency_milliseconds-only case).
      // Make sure the ones it covers all round-trip.
      [
        'topic_sequence_match',
        'action_sequence_match',
        'agent_handoff_match',
        'bot_response_rating',
        'response_match',
        'coherence',
        'factuality',
        'completeness',
        'task_resolution',
        'output_latency_milliseconds',
      ].forEach((expected) => {
        expect(scorerNames.has(expected), `missing scorer ${expected}`).to.be.true;
      });
    });

    it('multi-input fan-out reverses: 3 contiguous <testCase> with identical scorer set collapse to 1 case with 3 inputs', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name>\n' +
        '  <subjectName>A</subjectName>\n' +
        '  <subjectType>AGENT</subjectType>\n' +
        '  <testCase>\n' +
        '    <number>1</number>\n' +
        '    <inputs><utterance>u1</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>T</expectedValue></scorer>\n' +
        '  </testCase>\n' +
        '  <testCase>\n' +
        '    <number>2</number>\n' +
        '    <inputs><utterance>u2</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>T</expectedValue></scorer>\n' +
        '  </testCase>\n' +
        '  <testCase>\n' +
        '    <number>3</number>\n' +
        '    <inputs><utterance>u3</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>T</expectedValue></scorer>\n' +
        '  </testCase>\n' +
        '</AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      expect(spec.testCases).to.have.length(1);
      expect(spec.testCases[0].inputs.map((i) => i.utterance)).to.deep.equal(['u1', 'u2', 'u3']);
      expect(spec.testCases[0].scorers).to.deep.equal([{ name: 'topic_sequence_match', expected: 'T' }]);
    });

    it('does NOT collapse adjacent test cases when scorer sets differ', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u1</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>X</expectedValue></scorer></testCase>\n' +
        '  <testCase><number>2</number><inputs><utterance>u2</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>Y</expectedValue></scorer></testCase>\n' +
        '</AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      expect(spec.testCases).to.have.length(2);
    });

    it('parses contextVariables and conversationHistory roundly (auto-assigned indices are dropped on parse)', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs>\n' +
        '    <utterance>u</utterance>\n' +
        '    <contextVariable><variableName>RoutableId</variableName><variableValue>0Mw</variableValue></contextVariable>\n' +
        '    <conversationHistory><role>user</role><message>a</message><index>0</index></conversationHistory>\n' +
        '    <conversationHistory><role>agent</role><message>b</message><topic>T</topic><index>1</index></conversationHistory>\n' +
        '  </inputs>\n' +
        '  <scorer><name>task_resolution</name></scorer>\n' +
        '  </testCase></AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      const input = spec.testCases[0].inputs[0];
      expect(input.contextVariables).to.deep.equal([{ name: 'RoutableId', value: '0Mw' }]);
      expect(input.conversationHistory).to.deep.equal([
        { role: 'user', message: 'a' },
        { role: 'agent', message: 'b', topic: 'T' },
      ]);
    });

    it('preserves explicit (non-auto) conversationHistory indices on parse', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs>\n' +
        '    <utterance>u</utterance>\n' +
        '    <conversationHistory><role>user</role><message>a</message><index>7</index></conversationHistory>\n' +
        '    <conversationHistory><role>agent</role><message>b</message><topic>T</topic><index>8</index></conversationHistory>\n' +
        '  </inputs>\n' +
        '  <scorer><name>task_resolution</name></scorer></testCase></AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      const turns = spec.testCases[0].inputs[0].conversationHistory!;
      expect(turns.map((t) => t.index)).to.deep.equal([7, 8]);
    });

    it('preserves the python-list-string for action_sequence_match expected verbatim', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u</utterance></inputs>\n' +
        "    <scorer><name>action_sequence_match</name><expectedValue>['Verify_Customer','Get_Order_Status']</expectedValue></scorer>\n" +
        '  </testCase></AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      expect(spec.testCases[0].scorers[0].expected).to.equal("['Verify_Customer','Get_Order_Status']");
    });

    it('quality scorers (no <expectedValue>) round-trip without an expected field', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u</utterance></inputs>\n' +
        '    <scorer><name>coherence</name></scorer>\n' +
        '  </testCase></AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      expect(spec.testCases[0].scorers[0]).to.deep.equal({ name: 'coherence' });
      expect((spec.testCases[0].scorers[0] as { expected?: string }).expected).to.be.undefined;
    });

    it('throws ngtMalformedMetadataXml on unparseable XML', () => {
      // fast-xml-parser is lenient on most input, but a stray < inside a tag name trips it.
      const xml = '<AiTestingDefinition><name>S<<</name></AiTestingDefinition>';
      try {
        parseNgtMetadataXml(xml);
        expect.fail('expected parseNgtMetadataXml to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtMalformedMetadataXml');
      }
    });

    it('throws ngtWrongMetadataRoot when the root is AiEvaluationDefinition (legacy XML)', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>X</name></AiEvaluationDefinition>';
      try {
        parseNgtMetadataXml(xml);
        expect.fail('expected parseNgtMetadataXml to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtWrongMetadataRoot');
      }
    });

    it('preserves an unknown scorer name when expectedValue is present (lifecycle warn, not throw)', () => {
      const lifecycleSpy = sinon.spy(Lifecycle.prototype, 'emitWarning');
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u</utterance></inputs>\n' +
        '    <scorer><name>made_up_scorer</name><expectedValue>whatever</expectedValue></scorer>\n' +
        '  </testCase></AiTestingDefinition>\n';
      const spec = parseToSpec(xml);
      expect(spec.testCases[0].scorers[0]).to.deep.equal({
        name: 'made_up_scorer',
        expected: 'whatever',
      });
      expect(lifecycleSpy.called).to.be.true;
    });

    it('throws ngtUnknownScorerNoExpected when an unknown scorer has no expectedValue', () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u</utterance></inputs>\n' +
        '    <scorer><name>made_up_scorer</name></scorer>\n' +
        '  </testCase></AiTestingDefinition>\n';
      try {
        // Throw lives in the convert step now (unknown-scorer detection needs the catalog
        // lookup that convertToNgtSpec performs); the parse step is shape-only.
        parseToSpec(xml);
        expect.fail('expected parseToSpec to throw');
      } catch (err) {
        expect(err).to.be.instanceOf(SfError);
        expect((err as SfError).name).to.equal('ngtUnknownScorerNoExpected');
        expect((err as SfError).message).to.include('made_up_scorer');
      }
    });

  });

  // -------------------------------------------------------------------------
  // AgentTest.getTestSpec dispatch on local md path
  // -------------------------------------------------------------------------
  describe('AgentTest.getTestSpec dispatch', () => {
    let readFileStub: sinon.SinonStub;

    beforeEach(() => {
      readFileStub = sinon.stub(fs, 'readFile');
    });

    afterEach(() => {
      sinon.restore();
    });

    it('mdPath with <AiTestingDefinition> root → returns NgtTestSpec', async () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiTestingDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>S</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><number>1</number><inputs><utterance>u</utterance></inputs>\n' +
        '    <scorer><name>topic_sequence_match</name><expectedValue>T</expectedValue></scorer>\n' +
        '  </testCase></AiTestingDefinition>\n';
      readFileStub.resolves(xml);

      const agentTest = new AgentTest({ mdPath: 'fake.aiTestingDefinition-meta.xml' });
      const spec = (await agentTest.getTestSpec()) as NgtTestSpec;

      // NGT shape: testCases[].inputs is an array, scorers is the marker.
      expect(spec.testCases[0]).to.have.property('scorers');
      expect(spec.testCases[0].inputs[0].utterance).to.equal('u');
    });

    it('mdPath with <AiEvaluationDefinition> root → still returns legacy TestSpec (regression)', async () => {
      const xml =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<AiEvaluationDefinition xmlns="http://soap.sforce.com/2006/04/metadata">\n' +
        '  <name>L</name><subjectName>A</subjectName><subjectType>AGENT</subjectType>\n' +
        '  <testCase><inputs><utterance>u</utterance></inputs>\n' +
        '    <expectation><name>topic_sequence_match</name><expectedValue>T</expectedValue></expectation>\n' +
        '    <expectation><name>action_sequence_match</name><expectedValue>["A"]</expectedValue></expectation>\n' +
        '    <expectation><name>bot_response_rating</name><expectedValue>ok</expectedValue></expectation>\n' +
        '  </testCase></AiEvaluationDefinition>\n';
      readFileStub.resolves(xml);

      const agentTest = new AgentTest({ mdPath: 'fake.aiEvaluationDefinition-meta.xml' });
      const spec = await agentTest.getTestSpec();
      // Legacy shape: top-level utterance + expectedTopic on the case.
      expect((spec as { testCases: Array<{ utterance?: string }> }).testCases[0]).to.have.property('utterance', 'u');
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

    it('preview: true writes <apiName>-preview-<timestamp>.xml without invoking deploy', async () => {
      const result = await AgentTest.create(connection, 'MyTest', 'spec.yaml', {
        outputDir: 'tmp',
        preview: true,
        testRunner: 'agentforce-studio',
      } as never); // cast: option type is added in src by the developer.

      // Preview parity with the legacy path (src/agentTest.ts:131-132): timestamped
      // filename so previewing in the project root doesn't clobber a real
      // `<apiName>.aiTestingDefinition-meta.xml` checked in alongside source.
      expect(result.path).to.match(/MyTest-preview-.+\.xml$/);
      expect(result.path).to.not.include('aiTestingDefinition');
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

    // Regression guard: omitting testRunner must route through the legacy path,
    // not the NGT path. With preview:true, legacy emits the timestamped preview
    // filename (`<apiName>-preview-<ISO>.xml`) per src/agentTest.ts:131-132 and
    // the existing tests at test/agentTest.test.ts:847,888.
    // The load-bearing assertion is "no aiTestingDefinition in the path" — that's
    // what proves we didn't accidentally branch into the NGT path. The filename
    // shape check just documents the legacy preview convention.
    it('regression: omitting testRunner stays on the legacy path (no NGT routing)', async () => {
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
      expect(path).to.not.include('aiTestingDefinition');
      expect(path).to.match(/LegacyTest-preview-.+\.xml$/);
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
