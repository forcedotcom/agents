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
  cltScorersFor,
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
      expect(cltScorersFor('ephemeral')).to.deep.equal([
        'task_resolution',
        'acceptance_criteria',
        'topic_sequence_match',
        'action_sequence_match',
      ]);
      expect(cltScorersFor('saved')).to.deep.equal([
        'task_resolution',
        'acceptance_criteria',
        'topic_sequence_match',
        'action_sequence_match',
        'displayed_actions_assertion',
      ]);
      expect(CltScorerCatalog.agent_handoff_match.targets).to.be.empty;
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
    // Values Core owns: the spec is accepted with a warning and sent as written, so Core decides.
    type Case = { title: string; spec: () => CltTestSpec; contains: string; target?: CltRunTarget };
    const cases: Case[] = [
      {
        title: 'evaluationMode without saving (ignored)',
        spec: () => edited((s) => (s.evaluationMode = 'TEXT')),
        contains: '`evaluationMode` applies only to saved conversation-level suites.',
      },
      {
        title: 'an unknown persona',
        spec: () => edited((s) => (s.persona = 'ANGRY')),
        contains: "`persona` 'ANGRY', which this CLI doesn't know (known: DEFAULT, FRUSTRATED, DISTRACTED_DAD, ACCENT)",
      },
      {
        title: 'an unknown evaluationMode in a saved suite',
        spec: () => edited((s) => (s.evaluationMode = 'VOICE')),
        contains: "`evaluationMode` 'VOICE', which this CLI doesn't know (known: TEXT, TEXT_VOICE)",
        target: 'saved',
      },
      {
        title: 'maxTurns over the limit without saving',
        spec: () => edited((s) => (s.maxTurns = 31)),
        contains:
          '`maxTurns` 31, over the limit of 30 when running without saving. Sending it anyway; if Core rejects it, ' +
          'lower `maxTurns` or save the suite',
      },
      {
        title: 'maxTurns over both limits without saving',
        spec: () => edited((s) => (s.maxTurns = 101)),
        contains: '`maxTurns` 101, over the limit of 30 when running without saving that this CLI knows.',
      },
      {
        title: 'maxTurns over the saved limit',
        spec: () => edited((s) => (s.maxTurns = 101)),
        contains: '`maxTurns` 101, over the limit of 100 in a saved suite that this CLI knows.',
        target: 'saved',
      },
      {
        title: 'more than 250 test cases',
        spec: () =>
          edited((s) => (s.testCases = Array.from({ length: 251 }, () => ({ conversationGoal: 'Return an item.' })))),
        contains: '251 test cases, more than the 250',
        target: 'saved',
      },
      {
        title: 'a saved-only scorer without saving',
        spec: () =>
          edited((s) => (firstCase(s).scorers = [{ name: 'displayed_actions_assertion', expected: '["Card"]' }])),
        contains:
          "scorer 'displayed_actions_assertion' on test case 1 isn't known to work when running without saving; " +
          "it's supported in a saved suite.",
      },
      {
        title: 'a turn-level scorer the wizard does not offer for CLT',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'coherence' }])),
        contains:
          'Known scorers in a saved suite: task_resolution (Task Resolution), acceptance_criteria (Success Criteria), ' +
          'topic_sequence_match (Subagents Assertion), action_sequence_match (Action Assertion), ' +
          'displayed_actions_assertion (Displayed Actions).',
        target: 'saved',
      },
      {
        title: 'an unknown scorer without saving (lists only scorers known to work without saving)',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'made_up_scorer' }])),
        contains:
          "scorer 'made_up_scorer' on test case 1 isn't one this CLI knows. Sending it anyway; Core validates it. " +
          'Known scorers when running without saving: task_resolution (Task Resolution),',
      },
      {
        title: 'a scorer name with terminal escape sequences (escaped, not echoed)',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'bad\u001b[31mname' }])),
        contains: "'bad\\u001b[31mname'",
      },
    ];

    for (const c of cases) {
      it(`warns about ${c.title}`, () => {
        expect(() => validateCltSpec(c.spec(), { target: c.target ?? 'ephemeral' })).to.not.throw();
        expect(warnings()).to.have.length(1);
        expect(warnings()[0]).to.include(c.contains);
      });
    }

    it('sends an unknown scorer and persona as written, with expected', () => {
      const spec = edited((s) => {
        s.persona = 'angry';
        firstCase(s).scorers = [{ name: 'new_core_scorer', expected: 'x' }, { name: 'other_scorer' }];
      });
      validateCltSpec(spec, { target: 'ephemeral' });
      const input = cltSpecToEphemeralInput(spec, AGENT);
      expect(input.persona).to.equal('ANGRY');
      expect(input.testCases[0].scorers).to.deep.equal([
        { name: 'new_core_scorer', expectedValue: 'x' },
        { name: 'other_scorer' },
      ]);
    });
  });

  describe('validateCltSpec: rejected specs', () => {
    type Case = { title: string; spec: () => CltTestSpec; error: string; contains?: string; target?: CltRunTarget };
    const cases: Case[] = [
      { title: 'non-object spec', spec: () => null as unknown as CltTestSpec, error: 'cltSpecNotObject' },
      {
        title: 'non-string description',
        spec: () => edited((s) => (s.description = 2026)),
        error: 'cltFieldNotString',
        contains: '`description`',
      },
      {
        title: 'non-string subjectVersion',
        spec: () => edited((s) => (s.subjectVersion = 2)),
        error: 'cltFieldNotString',
        contains: '`subjectVersion`',
      },
      {
        title: 'non-string subjectName next to project',
        spec: () =>
          edited((s) => {
            s.subjectName = 123;
            s.project = { projectId: '1bY1', projectVersionId: '1bZ1' };
          }),
        error: 'cltAgentIdentity',
      },
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
        error: 'cltInvalidShape',
        contains: "`project` must be a mapping, but it's the text abc.",
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
        title: 'non-string persona',
        spec: () => edited((s) => (s.persona = 5)),
        error: 'cltFieldNotString',
        contains: '`persona`',
      },
      {
        title: 'non-string evaluationMode',
        spec: () => edited((s) => (s.evaluationMode = 1)),
        error: 'cltFieldNotString',
        contains: '`evaluationMode`',
      },
      { title: 'maxTurns 0', spec: () => edited((s) => (s.maxTurns = 0)), error: 'cltInvalidMaxTurns' },
      { title: 'maxTurns fraction', spec: () => edited((s) => (s.maxTurns = 2.5)), error: 'cltInvalidMaxTurns' },
      {
        title: 'maxTurns as string',
        spec: () => edited((s) => (s.maxTurns = '10')),
        error: 'cltMaxTurnsQuoted',
        contains: 'Remove the quotes',
      },
      {
        title: 'simulation not an object',
        spec: () => edited((s) => (s.simulation = true)),
        error: 'cltInvalidShape',
        contains: '`simulation` must be a mapping',
      },
      {
        title: 'unknown simulation field',
        spec: () => edited((s) => (s.simulation = { enable: true })),
        error: 'cltUnknownField',
      },
      {
        title: 'non-boolean simulation.enabled',
        spec: () => edited((s) => (s.simulation = { enabled: 'yes' })),
        error: 'cltSimulationEnabledNotBoolean',
        contains: '`simulation.enabled` yes',
      },
      {
        title: 'excludedActions not a list',
        spec: () => edited((s) => (s.simulation = { excludedActions: 'Cancel_Order' })),
        error: 'cltInvalidShape',
        contains: '`simulation.excludedActions` must be a list',
      },
      {
        title: 'excludedActions entry not an object',
        spec: () => edited((s) => (s.simulation = { excludedActions: ['Cancel_Order'] })),
        error: 'cltInvalidShape',
        contains: 'excluded action entry 1 in `simulation` must be a mapping',
      },
      {
        title: 'excludedActions entry with empty actions',
        spec: () => edited((s) => (s.simulation = { excludedActions: [{ subagent: 'Orders', actions: [] }] })),
        error: 'cltSimulationMissingActions',
        contains: "entry 1 in `simulation` (subagent 'Orders')",
      },
      {
        title: 'excludedActions entry without a subagent',
        spec: () =>
          edited(
            (s) =>
              (s.simulation = {
                excludedActions: [
                  { subagent: 'Orders', actions: ['A'] },
                  { subagent: ' ', actions: ['B'] },
                ],
              })
          ),
        error: 'cltSimulationMissingSubagent',
        contains: 'entry 2',
      },
      {
        title: 'excludedActions entry with a blank action',
        spec: () => edited((s) => (s.simulation = { excludedActions: [{ subagent: 'Orders', actions: ['A', ''] }] })),
        error: 'cltSimulationInvalidAction',
        contains: 'action 2 in excluded action entry 1',
      },
      {
        title: 'unknown excludedActions field',
        spec: () => edited((s) => (s.simulation = { excludedActions: [{ topic: 'Orders', actions: ['A'] }] })),
        error: 'cltUnknownField',
        contains: "'topic' in excluded action entry 1 in `simulation`",
      },
      {
        title: 'testCases not a list',
        spec: () => edited((s) => (s.testCases = { conversationGoal: 'x' })),
        error: 'cltInvalidShape',
        contains: '`testCases` must be a list',
      },
      { title: 'missing testCases', spec: () => edited((s) => delete s.testCases), error: 'cltMissingTestCases' },
      { title: 'empty testCases', spec: () => edited((s) => (s.testCases = [])), error: 'cltMissingTestCases' },
      {
        title: 'test case not an object',
        spec: () => edited((s) => (s.testCases = ['Return an item.'])),
        error: 'cltInvalidShape',
        contains: "test case 1 must be a mapping, but it's the text Return an item.",
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
        contains: "'goal' in test case 1.",
      },
      {
        title: 'blank conversationGoal',
        spec: () => edited((s) => (firstCase(s).conversationGoal = '')),
        error: 'cltMissingConversationGoal',
      },
      {
        title: 'contextVariables not a list',
        spec: () => edited((s) => (firstCase(s).contextVariables = { name: 'A' })),
        error: 'cltInvalidShape',
        contains: "`contextVariables` in test case 1 must be a list, but it's a mapping",
      },
      {
        title: 'context variable not an object',
        spec: () => edited((s) => (firstCase(s).contextVariables = ['A'])),
        error: 'cltInvalidShape',
        contains: 'context variable 1 in test case 1 must be a mapping',
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
        title: 'context variable with a number value',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: 'Zip', value: 2134 }])),
        error: 'cltContextVariableInvalidValue',
        contains: "'Zip' must have a string `value:`, but it's 2134",
      },
      {
        title: 'context variable with a boolean value',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: 'Flag', value: true }])),
        error: 'cltContextVariableInvalidValue',
      },
      {
        title: 'context variable with a blank (null) value',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: 'A', value: null }])),
        error: 'cltContextVariableInvalidValue',
      },
      {
        title: 'context variable without a value',
        spec: () => edited((s) => (firstCase(s).contextVariables = [{ name: 'A' }])),
        error: 'cltContextVariableInvalidValue',
        contains: 'undefined',
      },
      {
        title: 'connections not an object',
        spec: () => edited((s) => (firstCase(s).connections = 'Messaging')),
        error: 'cltInvalidShape',
        contains: 'For example: `surfaceType: Messaging`',
      },
      {
        title: 'blank connections (YAML null)',
        spec: () => edited((s) => (firstCase(s).connections = null)),
        error: 'cltInvalidShape',
        contains: "must be a mapping, but it's empty.",
      },
      {
        title: 'a test case written as a list',
        spec: () => edited((s) => (s.testCases = [['Return an item.']])),
        error: 'cltInvalidShape',
        contains: "test case 1 must be a mapping, but it's a list.",
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
        error: 'cltInvalidShape',
        contains: '`scorers` in test case 1 must be a list',
      },
      {
        title: 'scorer not an object',
        spec: () => edited((s) => (firstCase(s).scorers = ['task_resolution'])),
        error: 'cltInvalidShape',
        contains:
          "scorer 1 in test case 1 must be a mapping, but it's the text task_resolution. For example: `- name: task_resolution`",
      },
      {
        title: 'unknown field on the second scorer',
        spec: () =>
          edited(
            (s) => (firstCase(s).scorers = [{ name: 'task_resolution' }, { name: 'task_resolution', expect: 'x' }])
          ),
        error: 'cltUnknownField',
        contains: "'expect' in scorer 2 in test case 1.",
      },
      {
        title: 'an unknown field with control characters and a very long name',
        spec: () => edited((s) => (s[`x\u0007${'y'.repeat(300)}`] = 1)),
        error: 'cltUnknownField',
        contains: `'x\\u0007${'y'.repeat(193)}...'`,
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
        title: 'a numeric expected on a scorer that needs one',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'action_sequence_match', expected: 2 }])),
        error: 'cltScorerExpectedNotString',
        contains: "'action_sequence_match'",
      },
      {
        title: 'a numeric expected on a scorer that takes none',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'task_resolution', expected: 5 }])),
        error: 'cltScorerExpectedNotString',
      },
      {
        title: 'saved-only scorer without expected (warns, then needs expected)',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'displayed_actions_assertion' }])),
        error: 'cltScorerMissingExpected',
      },
      {
        title: 'agent_handoff_match without expected, before checking expected',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'agent_handoff_match' }])),
        error: 'cltScorerNotAvailable',
      },
      {
        title: 'agent_handoff_match without expected in a saved suite',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'agent_handoff_match' }])),
        error: 'cltScorerNotAvailable',
        target: 'saved',
      },
      {
        title: 'agent_handoff_match without saving (Core always fails it)',
        spec: () =>
          edited((s) => (firstCase(s).scorers = [{ name: 'agent_handoff_match', expected: 'CheckoutAgent' }])),
        error: 'cltScorerNotAvailable',
        contains: 'Agent Handoff',
      },
      {
        title: 'agent_handoff_match in a saved suite (Core drops the expected agent)',
        spec: () =>
          edited((s) => (firstCase(s).scorers = [{ name: 'agent_handoff_match', expected: 'CheckoutAgent' }])),
        error: 'cltScorerNotAvailable',
        contains: "'agent_handoff_match'",
        target: 'saved',
      },
      {
        title: 'a numeric expected on an unknown scorer',
        spec: () => edited((s) => (firstCase(s).scorers = [{ name: 'coherence', expected: 5 }])),
        error: 'cltScorerExpectedNotString',
        contains: "'coherence'",
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

    it('trims context variable names and drops expected on scorers that take none', () => {
      const spec = edited((s) => {
        firstCase(s).contextVariables = [{ name: ' $Context.ChannelType ', value: 'Web' }];
        firstCase(s).scorers = [{ name: 'task_resolution', expected: 'ignored' }];
      });
      validateCltSpec(spec, { target: 'ephemeral' });
      expect(cltSpecToEphemeralInput(spec, AGENT).testCases[0]).to.deep.equal({
        number: 1,
        conversationGoal: 'Return an item.',
        contextVariables: [{ variableName: '$Context.ChannelType', variableValue: 'Web' }],
        scorers: [{ name: 'task_resolution' }],
      });
    });

    it('narrows parsed YAML to CltTestSpec without a cast', () => {
      const parsed: unknown = parse(readFileSync(join('test', 'fixtures', 'clt-spec-returns.yaml'), 'utf8'));
      validateCltSpec(parsed, { target: 'ephemeral' });
      expect(cltSpecToEphemeralInput(parsed, AGENT).persona).to.equal('FRUSTRATED');
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
});
