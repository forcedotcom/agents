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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import sinon from 'sinon';
import { expect } from 'chai';
import { parse } from 'yaml';
import { Lifecycle, SfError } from '@salesforce/core';
import {
  CLT_MAX_TEST_CASES,
  CLT_MAX_TURNS,
  CltScorerCatalog,
  cltSpecToCreateAndRunInput,
  cltSpecToEphemeralInput,
  isCltScorerName,
  isCltSpec,
  validateCltSpec,
  type CltRunTarget,
  type CltTestSpec,
} from '../src';

const AGENT = { agentId: '0XxSB000000001', agentVersionId: '0XySB000000001' };

const fixture = (): CltTestSpec =>
  parse(readFileSync(join('test', 'fixtures', 'clt-spec-returns.yaml'), 'utf8')) as CltTestSpec;

const minimal = (): CltTestSpec => ({
  name: 'Min',
  testScope: 'CONVERSATION_LEVEL',
  subjectName: 'Returns_Agent',
  testCases: [{ conversationGoal: 'Return an item.' }],
});

/** Builds a spec from `minimal()` plus a hand edit; typed loosely to model bad YAML. */
const edited = (edit: (spec: Record<string, unknown>) => void): CltTestSpec => {
  const spec = minimal() as unknown as Record<string, unknown>;
  edit(spec);
  return spec as unknown as CltTestSpec;
};

const firstCase = (spec: Record<string, unknown>): Record<string, unknown> =>
  (spec.testCases as Array<Record<string, unknown>>)[0];

const expectError = (spec: CltTestSpec, target: CltRunTarget, name: string, contains?: string): void => {
  try {
    validateCltSpec(spec, { target });
    expect.fail(`expected ${name}`);
  } catch (err) {
    expect((err as SfError).name).to.equal(name);
    if (contains) {
      expect((err as SfError).message).to.include(contains);
    }
  }
};

describe('cltSpec', () => {
  let warnSpy: sinon.SinonSpy;

  beforeEach(() => {
    warnSpy = sinon.spy(Lifecycle.prototype, 'emitWarning');
  });

  afterEach(() => {
    sinon.restore();
  });

  const warnings = (): string[] => warnSpy.getCalls().flatMap((c) => c.args.map(String));

  describe('isCltSpec', () => {
    it('is true only for testScope CONVERSATION_LEVEL', () => {
      expect(isCltSpec(fixture())).to.be.true;
      expect(isCltSpec({ ...minimal(), testScope: 'TURN_LEVEL' })).to.be.false;
      expect(isCltSpec({ name: 'turn-level spec without testScope' })).to.be.false;
      expect(isCltSpec(null)).to.be.false;
      expect(isCltSpec([])).to.be.false;
    });
  });

  describe('scorer catalog', () => {
    it('matches the Testing Center wizard scorers for conversation-level tests', () => {
      expect(Object.keys(CltScorerCatalog)).to.have.members([
        'task_resolution',
        'acceptance_criteria',
        'topic_sequence_match',
        'action_sequence_match',
        'agent_handoff_match',
        'displayed_actions_assertion',
      ]);
      const savedOnly = Object.entries(CltScorerCatalog)
        .filter(([, e]) => !e.ephemeral)
        .map(([n]) => n);
      expect(savedOnly).to.deep.equal(['displayed_actions_assertion']);
      expect(CltScorerCatalog.acceptance_criteria.uiLabel).to.equal('Success Criteria');
      expect(CltScorerCatalog.topic_sequence_match.uiLabel).to.equal('Subagents Assertion');
      expect(isCltScorerName('task_resolution')).to.be.true;
      expect(isCltScorerName('coherence')).to.be.false;
      expect(isCltScorerName('toString')).to.be.false;
    });
  });

  describe('validateCltSpec: valid specs', () => {
    it('accepts the fixture for both targets', () => {
      expect(() => validateCltSpec(fixture(), { target: 'ephemeral' })).to.not.throw();
      expect(() => validateCltSpec(fixture(), { target: 'saved' })).to.not.throw();
    });

    it('accepts a project (draft agent) instead of subjectName', () => {
      const spec = edited((s) => {
        delete s.subjectName;
        s.project = { projectId: '1bYSB0000001', projectVersionId: '1bZSB0000001' };
      });
      expect(() => validateCltSpec(spec, { target: 'ephemeral' })).to.not.throw();
    });

    it('accepts maxTurns at each target limit', () => {
      expect(() => validateCltSpec({ ...minimal(), maxTurns: 30 }, { target: 'ephemeral' })).to.not.throw();
      expect(() => validateCltSpec({ ...minimal(), maxTurns: 100 }, { target: 'saved' })).to.not.throw();
      expect(CLT_MAX_TURNS).to.deep.equal({ ephemeral: 30, saved: 100 });
      expect(CLT_MAX_TEST_CASES).to.equal(250);
    });

    it('accepts displayed_actions_assertion when saving', () => {
      const spec = edited((s) => {
        firstCase(s).scorers = [{ name: 'displayed_actions_assertion', expected: '["Card"]' }];
      });
      expect(() => validateCltSpec(spec, { target: 'saved' })).to.not.throw();
    });

    it('accepts an empty scorers list (Core defaults to task_resolution)', () => {
      const spec = edited((s) => {
        firstCase(s).scorers = [];
      });
      expect(() => validateCltSpec(spec, { target: 'ephemeral' })).to.not.throw();
    });

    it('accepts simulation with only enabled set', () => {
      expect(() =>
        validateCltSpec({ ...minimal(), simulation: { enabled: false } }, { target: 'saved' })
      ).to.not.throw();
    });

    it('accepts evaluationMode on a saved suite without a warning', () => {
      validateCltSpec({ ...minimal(), evaluationMode: 'TEXT_VOICE' }, { target: 'saved' });
      expect(warnSpy.called).to.be.false;
    });
  });

  describe('validateCltSpec: warnings', () => {
    it('warns that evaluationMode is ignored without saving', () => {
      validateCltSpec({ ...minimal(), evaluationMode: 'TEXT' }, { target: 'ephemeral' });
      expect(warnings().some((w) => w.includes('evaluationMode'))).to.be.true;
    });
  });

  describe('validateCltSpec: rejected specs', () => {
    type Case = { title: string; spec: () => CltTestSpec; error: string; contains?: string; target?: CltRunTarget };
    const cases: Case[] = [
      { title: 'non-object spec', spec: () => null as unknown as CltTestSpec, error: 'cltMissingTestCases' },
      {
        title: 'wrong testScope',
        spec: () => edited((s) => (s.testScope = 'TURN_LEVEL')),
        error: 'cltWrongTestScope',
        contains: 'TURN_LEVEL',
      },
      {
        title: 'unknown top-level field',
        spec: () => edited((s) => (s.maxturns = 5)),
        error: 'cltUnknownField',
        contains: "'maxturns'",
      },
      { title: 'blank name', spec: () => edited((s) => (s.name = '  ')), error: 'cltMissingName' },
      {
        title: 'PROMPT subjectType',
        spec: () => edited((s) => (s.subjectType = 'PROMPT')),
        error: 'cltUnsupportedSubjectType',
      },
      {
        title: 'neither subjectName nor project',
        spec: () => edited((s) => delete s.subjectName),
        error: 'cltAgentIdentity',
      },
      {
        title: 'both subjectName and project',
        spec: () => edited((s) => (s.project = { projectId: 'a', projectVersionId: 'b' })),
        error: 'cltAgentIdentity',
      },
      {
        title: 'project not an object',
        spec: () =>
          edited((s) => {
            delete s.subjectName;
            s.project = 'abc';
          }),
        error: 'cltProjectIncomplete',
      },
      {
        title: 'project missing projectVersionId',
        spec: () =>
          edited((s) => {
            delete s.subjectName;
            s.project = { projectId: 'a' };
          }),
        error: 'cltProjectIncomplete',
      },
      {
        title: 'unknown project field',
        spec: () =>
          edited((s) => {
            delete s.subjectName;
            s.project = { projectId: 'a', projectVersionId: 'b', version: 'c' };
          }),
        error: 'cltUnknownField',
        contains: 'project',
      },
      {
        title: 'subjectVersion with project',
        spec: () =>
          edited((s) => {
            delete s.subjectName;
            s.project = { projectId: 'a', projectVersionId: 'b' };
            s.subjectVersion = 'v1';
          }),
        error: 'cltSubjectVersionWithProject',
      },
      {
        title: 'invalid persona',
        spec: () => edited((s) => (s.persona = 'ANGRY')),
        error: 'cltInvalidPersona',
        contains: 'DISTRACTED_DAD',
      },
      {
        title: 'invalid evaluationMode',
        spec: () => edited((s) => (s.evaluationMode = 'VOICE')),
        error: 'cltInvalidEvaluationMode',
      },
      {
        title: 'non-string evaluationMode',
        spec: () => edited((s) => (s.evaluationMode = 1)),
        error: 'cltInvalidEvaluationMode',
      },
      { title: 'maxTurns 0', spec: () => edited((s) => (s.maxTurns = 0)), error: 'cltInvalidMaxTurns' },
      { title: 'maxTurns fraction', spec: () => edited((s) => (s.maxTurns = 2.5)), error: 'cltInvalidMaxTurns' },
      {
        title: 'maxTurns as string',
        spec: () => edited((s) => (s.maxTurns = '10')),
        error: 'cltInvalidMaxTurns',
        contains: "'10'",
      },
      {
        title: 'maxTurns over the ephemeral limit',
        spec: () => edited((s) => (s.maxTurns = 31)),
        error: 'cltInvalidMaxTurns',
        contains: 'to 30',
      },
      {
        title: 'maxTurns over the saved limit',
        spec: () => edited((s) => (s.maxTurns = 101)),
        error: 'cltInvalidMaxTurns',
        contains: 'to 100',
        target: 'saved',
      },
      {
        title: 'simulation not an object',
        spec: () => edited((s) => (s.simulation = true)),
        error: 'cltInvalidSimulation',
      },
      {
        title: 'unknown simulation field',
        spec: () => edited((s) => (s.simulation = { enable: true })),
        error: 'cltUnknownField',
      },
      {
        title: 'non-boolean simulation.enabled',
        spec: () => edited((s) => (s.simulation = { enabled: 'yes' })),
        error: 'cltInvalidSimulation',
      },
      {
        title: 'excludedActions not a list',
        spec: () => edited((s) => (s.simulation = { excludedActions: 'Cancel_Order' })),
        error: 'cltInvalidSimulation',
      },
      {
        title: 'excludedActions entry not an object',
        spec: () => edited((s) => (s.simulation = { excludedActions: ['Cancel_Order'] })),
        error: 'cltInvalidSimulation',
      },
      {
        title: 'excludedActions entry with empty actions',
        spec: () => edited((s) => (s.simulation = { excludedActions: [{ subagent: 'Orders', actions: [] }] })),
        error: 'cltInvalidSimulation',
      },
      {
        title: 'unknown excludedActions field',
        spec: () => edited((s) => (s.simulation = { excludedActions: [{ topic: 'Orders', actions: ['A'] }] })),
        error: 'cltUnknownField',
      },
      { title: 'missing testCases', spec: () => edited((s) => delete s.testCases), error: 'cltMissingTestCases' },
      { title: 'empty testCases', spec: () => edited((s) => (s.testCases = [])), error: 'cltMissingTestCases' },
      {
        title: 'test case not an object',
        spec: () => edited((s) => (s.testCases = ['Return an item.'])),
        error: 'cltMissingConversationGoal',
      },
      {
        title: 'turn-level utterance in a test case',
        spec: () => edited((s) => (firstCase(s).utterance = 'Hi')),
        error: 'cltTurnLevelField',
        contains: 'utterance',
      },
      {
        title: 'turn-level inputs in a test case',
        spec: () => edited((s) => (firstCase(s).inputs = [])),
        error: 'cltTurnLevelField',
      },
      {
        title: 'unknown test case field',
        spec: () => edited((s) => (firstCase(s).goal = 'x')),
        error: 'cltUnknownField',
        contains: 'testCases[1]',
      },
      {
        title: 'blank conversationGoal',
        spec: () => edited((s) => (firstCase(s).conversationGoal = '')),
        error: 'cltMissingConversationGoal',
      },
      {
        title: 'contextVariables not a list',
        spec: () => edited((s) => (firstCase(s).contextVariables = { name: 'A' })),
        error: 'cltContextVariableMissingName',
      },
      {
        title: 'context variable not an object',
        spec: () => edited((s) => (firstCase(s).contextVariables = ['A'])),
        error: 'cltContextVariableMissingName',
      },
      {
        title: 'context variable without a name',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ value: 'Web' }])),
        error: 'cltContextVariableMissingName',
      },
      {
        title: 'context variable named only $Context.',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: '$Context. ', value: 'Web' }])),
        error: 'cltContextVariableMissingName',
      },
      {
        title: 'unknown context variable field',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: 'A', val: 'Web' }])),
        error: 'cltUnknownField',
      },
      {
        title: 'duplicate context variable (X and $Context.X)',
        spec: () =>
          edited(
            (s) =>
              (firstCase(s).contextVariables = [
                { name: 'ChannelType', value: 'Web' },
                { name: ' $Context.ChannelType', value: 'Phone' },
              ])
          ),
        error: 'cltContextVariableDuplicate',
        contains: "'ChannelType'",
      },
      {
        title: 'connections not an object',
        spec: () => edited((s) => (firstCase(s).connections = 'Messaging')),
        error: 'cltConnectionsMissingSurfaceType',
      },
      {
        title: 'connections without surfaceType',
        spec: () => edited((s) => (firstCase(s).connections = {})),
        error: 'cltConnectionsMissingSurfaceType',
      },
      {
        title: 'unknown connections field',
        spec: () => edited((s) => (firstCase(s).connections = { surfaceConfig: { surfaceType: 'Messaging' } })),
        error: 'cltUnknownField',
      },
      {
        title: 'scorers not a list',
        spec: () => edited((s) => (firstCase(s).scorers = 'task_resolution')),
        error: 'cltScorerMissingName',
      },
      {
        title: 'scorer not an object',
        spec: () => edited((s) => (firstCase(s).scorers = ['task_resolution'])),
        error: 'cltScorerMissingName',
      },
      {
        title: 'scorer without a name',
        spec: () => edited((s) => (firstCase(s).scorers = [{ expected: 'x' }])),
        error: 'cltScorerMissingName',
      },
      {
        title: 'unknown scorer field',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'task_resolution', expectedValue: 'x' }])),
        error: 'cltUnknownField',
      },
      {
        title: 'acceptance_criteria without expected',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'acceptance_criteria' }])),
        error: 'cltScorerMissingExpected',
        contains: 'acceptance_criteria',
      },
      {
        title: 'saved-only scorer without saving',
        spec: () =>
          edited((s) => (firstCase(s).scorers = [{ name: 'displayed_actions_assertion', expected: '["Card"]' }])),
        error: 'cltScorerNotEphemeral',
        contains: 'task_resolution',
      },
      {
        title: 'a turn-level scorer the wizard does not offer for CLT',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'coherence' }])),
        error: 'cltUnsupportedScorer',
        contains: 'Supported scorers: task_resolution',
        target: 'saved',
      },
      {
        title: 'an unknown scorer name',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'made_up_scorer' }])),
        error: 'cltUnsupportedScorer',
        contains: "'made_up_scorer'",
      },
      {
        title: 'more than 250 test cases',
        spec: () =>
          edited((s) => (s.testCases = Array.from({ length: 251 }, () => ({ conversationGoal: 'Return an item.' })))),
        error: 'cltTooManyTestCases',
        contains: '251',
        target: 'saved',
      },
    ];

    for (const c of cases) {
      it(`rejects ${c.title}`, () => {
        expectError(c.spec(), c.target ?? 'ephemeral', c.error, c.contains);
      });
    }
  });

  describe('cltSpecToEphemeralInput', () => {
    it('maps the fixture to the ephemeral-run body', () => {
      const spec = fixture();
      validateCltSpec(spec, { target: 'ephemeral' });
      expect(cltSpecToEphemeralInput(spec, AGENT)).to.deep.equal({
        ...AGENT,
        persona: 'FRUSTRATED',
        maxTurns: 10,
        enableSimulationMode: true,
        previewConfig: {
          excludedActionsFromSimulate: [{ subagent: 'Order_Management', actions: [{ name: 'Cancel_Order' }] }],
        },
        testCases: [
          {
            number: 1,
            conversationGoal: 'Return a damaged blender bought last week and get a refund to the original card.',
            contextVariables: [{ variableName: '$Context.ChannelType', variableValue: 'Web' }],
            connections: { surfaceConfig: { surfaceType: 'Messaging' } },
            scorers: [
              { name: 'task_resolution' },
              {
                name: 'acceptance_criteria',
                expectedValue: 'The agent confirms the refund amount and the card it goes to.',
              },
            ],
          },
          { number: 2, conversationGoal: 'Ask whether an opened item can be returned after 45 days.' },
        ],
      });
    });

    it('targets the draft project and omits unset optional fields', () => {
      const spec = edited((s) => {
        delete s.subjectName;
        s.project = { projectId: '1bY1', projectVersionId: '1bZ1' };
        s.simulation = { excludedActions: [] };
      });
      expect(cltSpecToEphemeralInput(spec, AGENT)).to.deep.equal({
        projectId: '1bY1',
        projectVersionId: '1bZ1',
        testCases: [{ number: 1, conversationGoal: 'Return an item.' }],
      });
    });

    it('throws cltAgentNotResolved when a published agent has no resolved IDs', () => {
      try {
        cltSpecToEphemeralInput(minimal());
        expect.fail('expected cltAgentNotResolved');
      } catch (err) {
        expect((err as SfError).name).to.equal('cltAgentNotResolved');
        expect((err as SfError).message).to.include('Returns_Agent');
      }
    });
  });

  describe('cltSpecToCreateAndRunInput', () => {
    it('maps the fixture and copies maxTurns to every test case', () => {
      const spec = { ...fixture(), evaluationMode: 'TEXT' as const };
      validateCltSpec(spec, { target: 'saved' });
      const input = cltSpecToCreateAndRunInput(spec, AGENT);
      expect(input).to.include({
        ...AGENT,
        name: 'Returns_CLT',
        description: 'Conversation-level tests for the returns flow',
        evaluationMode: 'TEXT',
        persona: 'FRUSTRATED',
        enableSimulationMode: true,
      });
      expect(input).to.not.have.property('maxTurns');
      expect(input.testCases.map((tc) => tc.maxTurns)).to.deep.equal([10, 10]);
      expect(input.testCases[1]).to.deep.equal({
        number: 2,
        conversationGoal: 'Ask whether an opened item can be returned after 45 days.',
        maxTurns: 10,
      });
    });

    it('omits unset optional fields', () => {
      expect(cltSpecToCreateAndRunInput(minimal(), AGENT)).to.deep.equal({
        ...AGENT,
        name: 'Min',
        testCases: [{ number: 1, conversationGoal: 'Return an item.' }],
      });
    });
  });
});
