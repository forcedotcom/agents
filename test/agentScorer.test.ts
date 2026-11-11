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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { expect } from 'chai';
import { XMLParser } from 'fast-xml-parser';
import {
  validateScorerSpec,
  labelToApiName,
  buildDefaultPromptContent,
  buildScorerXml,
  buildPromptTemplateXml,
  parseScorerXml,
  parseScorerVersions,
  createScorerDefinition,
  loadScorerSpec,
  MAX_ENUM_VALUES,
} from '../src/agentScorer';
import type { ScorerSpec } from '../src/agentScorer';

type PromptTemplateInput = { apiName: string; required: boolean };

/** Parses prompt-template XML and returns its declared inputs keyed by apiName. */
function parsePromptTemplateInputs(xml: string): Map<string, PromptTemplateInput> {
  const parsed = new XMLParser({ ignoreAttributes: false }).parse(xml) as {
    GenAiPromptTemplate: { templateVersions: { inputs: PromptTemplateInput | PromptTemplateInput[] } };
  };
  const inputs = parsed.GenAiPromptTemplate.templateVersions.inputs;
  const list = Array.isArray(inputs) ? inputs : [inputs];
  return new Map(list.map((input) => [input.apiName, input]));
}

describe('labelToApiName', () => {
  it('replaces spaces with underscores', () => {
    expect(labelToApiName('My Scorer')).to.equal('My_Scorer');
  });

  it('removes special characters', () => {
    expect(labelToApiName('Score (v2)!')).to.equal('Score_v2');
  });

  it('collapses multiple spaces into one underscore', () => {
    expect(labelToApiName('a   b')).to.equal('a_b');
  });
});

describe('validateScorerSpec', () => {
  const baseSpec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    lightningType: 'lightning__textType',
    engineType: 'Manual',
    agentAssociation: {
      agentApiName: 'MyAgent',
      isActive: true,
    },
  };

  it('throws for invalid apiName - starts with number', () => {
    expect(() => validateScorerSpec({ ...baseSpec, apiName: '1Invalid' })).to.throw('API name must start with a letter');
  });

  it('throws for apiName longer than 35 characters', () => {
    expect(() => validateScorerSpec({ ...baseSpec, apiName: 'A'.repeat(36) })).to.throw('API name must start with a letter');
  });

  it('throws for empty apiName', () => {
    expect(() => validateScorerSpec({ ...baseSpec, apiName: '' })).to.throw('API name must start with a letter');
  });

  it('throws when lightningType is missing', () => {
    expect(() =>
      validateScorerSpec({ ...baseSpec, lightningType: undefined as unknown as ScorerSpec['lightningType'] })
    ).to.throw('lightningType is required.');
  });

  it('throws when lightningType is not in SUPPORTED_LIGHTNING_TYPES', () => {
    expect(() =>
      validateScorerSpec({ ...baseSpec, lightningType: 'bogus__type' as unknown as ScorerSpec['lightningType'] })
    ).to.throw("Unsupported lightningType 'bogus__type'.");
  });

  it('does not throw for a valid lightningType', () => {
    expect(() => validateScorerSpec({ ...baseSpec, lightningType: 'lightning__numberType' })).to.not.throw();
  });

  it('throws when engineType is missing', () => {
    expect(() =>
      validateScorerSpec({ ...baseSpec, engineType: undefined as unknown as ScorerSpec['engineType'] })
    ).to.throw('engineType is required.');
  });

  it('throws when engineType is not a supported engine (e.g. mis-cased)', () => {
    // A mis-cased engineType (prompttemplate) would otherwise scaffold a silently-broken definition: the
    // case-sensitive `=== 'PromptTemplate'` branch is false, so no engineRef/template is emitted.
    expect(() =>
      validateScorerSpec({ ...baseSpec, engineType: 'prompttemplate' as unknown as ScorerSpec['engineType'] })
    ).to.throw("Unsupported engineType 'prompttemplate'.");
  });

  it('does not throw for a valid engineType', () => {
    expect(() => validateScorerSpec({ ...baseSpec, engineType: 'PromptTemplate' })).to.not.throw();
  });

  it('throws when agentAssociation is missing', () => {
    // Guards the samplingRate dereference: an omitted (or misspelled) agentAssociation must produce a clear
    // message, not a raw `TypeError: Cannot read properties of undefined (reading 'samplingRate')`.
    expect(() =>
      validateScorerSpec({ ...baseSpec, agentAssociation: undefined as unknown as ScorerSpec['agentAssociation'] })
    ).to.throw('agentAssociation is required.');
  });

  it('throws when agentAssociation.agentApiName is empty', () => {
    expect(() =>
      validateScorerSpec({ ...baseSpec, agentAssociation: { agentApiName: '', isActive: false } })
    ).to.throw('agentAssociation.agentApiName is required.');
  });

  // Build an outputEnumValues array of the given length with exactly one fallback.
  const enumValues = (count: number): ScorerSpec['outputEnumValues'] =>
    Array.from({ length: count }, (_, i) => ({
      value: `Label${i}`,
      outcomeType: 'Pass' as const,
      isFallback: i === count - 1,
    }));

  it('throws when there are more than MAX_ENUM_VALUES outputEnumValues', () => {
    expect(() => validateScorerSpec({ ...baseSpec, outputEnumValues: enumValues(MAX_ENUM_VALUES + 1) })).to.throw(
      `Too many outputEnumValues: ${MAX_ENUM_VALUES + 1} (max ${MAX_ENUM_VALUES}).`
    );
  });

  it('does not throw when there are exactly MAX_ENUM_VALUES outputEnumValues', () => {
    expect(() => validateScorerSpec({ ...baseSpec, outputEnumValues: enumValues(MAX_ENUM_VALUES) })).to.not.throw();
  });

  it('throws when more than one outputEnumValue is the fallback', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        outputEnumValues: [
          { value: 'Good', outcomeType: 'Pass', isFallback: true },
          { value: 'Bad', outcomeType: 'Fail', isFallback: true },
        ],
      })
    ).to.throw('At most one outputEnumValue can be the fallback, but found 2.');
  });

  it('allows zero or one fallback value', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        outputEnumValues: [
          { value: 'Good', outcomeType: 'Pass' },
          { value: 'Bad', outcomeType: 'Fail' },
        ],
      })
    ).to.not.throw();
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        outputEnumValues: [
          { value: 'Good', outcomeType: 'Pass' },
          { value: 'Bad', outcomeType: 'Fail', isFallback: true },
        ],
      })
    ).to.not.throw();
  });

  it('throws when samplingRate is greater than 1', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 1.5 },
      })
    ).to.throw('samplingRate must be between 0 and 1, but got 1.5.');
  });

  it('throws when samplingRate is less than 0', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: -0.1 },
      })
    ).to.throw('samplingRate must be between 0 and 1, but got -0.1.');
  });

  it('allows samplingRate at boundaries 0 and 1', () => {
    expect(() =>
      validateScorerSpec({ ...baseSpec, agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 0 } })
    ).to.not.throw();
    expect(() =>
      validateScorerSpec({ ...baseSpec, agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 1 } })
    ).to.not.throw();
  });
});

describe('buildDefaultPromptContent', () => {
  const labeledSpec: Pick<ScorerSpec, 'lightningType' | 'outputEnumValues' | 'instructions'> = {
    lightningType: 'lightning__textType',
    outputEnumValues: [
      { value: 'Positive', outcomeType: 'Pass' },
      { value: 'Negative', outcomeType: 'Fail', isFallback: true },
    ],
  };

  it('renders the shared prompt scaffold and resolves every author-time placeholder', () => {
    const content = buildDefaultPromptContent(labeledSpec);
    expect(content).to.include('You are evaluating an AI agent conversation.');
    expect(content).to.include('Scoring instructions:');
    expect(content).to.include('Provide the reasoning for your evaluation under "explanation".');
    expect(content).to.include('Conversation Transcript:');
    expect(content).to.include('{!$Input:Session}');
    // No author-time placeholder should survive substitution.
    expect(content).to.not.include('{!$Instructions}');
    expect(content).to.not.include('{!$ScoringGuidance}');
  });

  it('does not restate the output envelope (the prompt template type already fixes it)', () => {
    const content = buildDefaultPromptContent(labeledSpec);
    expect(content).to.not.include('output schema');
    expect(content).to.not.include('"properties"');
    expect(content).to.not.include('additionalProperties');
  });

  it('describes the "label" member and mirrors it into "value" when predefined labels exist', () => {
    const content = buildDefaultPromptContent(labeledSpec);
    expect(content).to.include('set its "label" member to one of the allowed labels:');
    expect(content).to.include('{!$Input:AllowedLabels}');
    expect(content).to.include('{!$Input:FallbackLabel}');
    // For an enum scorer the label IS the score; the value member just mirrors it.
    expect(content).to.include('Set each item\'s "value" member to the same label you chose.');
    // Labels come from the input, never hardcoded.
    expect(content).to.not.include('Positive');
  });

  it('never hands an enum scorer the value JSON schema (the model would echo it into "value")', () => {
    // Regression for the schema-echo bug: even a labeled scorer with a non-string lightning type must not be
    // told to conform "value" to a JSON schema -- its value mirrors the chosen label instead.
    const content = buildDefaultPromptContent({ ...labeledSpec, lightningType: 'lightning__numberType' });
    expect(content).to.not.include('conform to this JSON schema');
    expect(content).to.not.include('{"type":"number"}');
    expect(content).to.include('Set each item\'s "value" member to the same label you chose.');
  });

  it('omits the label guidance but still describes the "value" member when no labels are defined', () => {
    const content = buildDefaultPromptContent({ lightningType: 'lightning__textType' });
    expect(content).to.not.include('{!$Input:AllowedLabels}');
    expect(content).to.not.include('{!$Input:FallbackLabel}');
    expect(content).to.include('Set each item\'s "value" member to conform to this JSON schema:');
    expect(content).to.include('{"type":"string"}');
  });

  it('maps the lightning type to the value member JSON schema', () => {
    expect(buildDefaultPromptContent({ lightningType: 'lightning__booleanType' })).to.include('{"type":"boolean"}');
    expect(buildDefaultPromptContent({ lightningType: 'lightning__integerType' })).to.include('{"type":"integer"}');
    expect(buildDefaultPromptContent({ lightningType: 'lightning__urlType' })).to.include(
      '{"type":"string","format":"uri"}'
    );
  });

  it('uses the default instructions placeholder when none is supplied', () => {
    expect(buildDefaultPromptContent(labeledSpec)).to.include('[EDIT:');
  });

  it('substitutes supplied instructions verbatim', () => {
    const content = buildDefaultPromptContent({
      ...labeledSpec,
      instructions: 'Score high when the agent resolves the issue.',
    });
    expect(content).to.include('Score high when the agent resolves the issue.');
    expect(content).to.not.include('[EDIT:');
  });
});

describe('buildScorerXml', () => {
  const baseSpec: ScorerSpec = {
    apiName: 'SentimentScore',
    label: 'Sentiment Score',
    lightningType: 'lightning__textType',
    engineType: 'PromptTemplate',
    status: 'Available',
    agentAssociation: {
      agentApiName: 'CopilotAgent',
      isActive: true,
      samplingRate: 0.5,
      inputScope: 'Intent',
    },
    outputEnumValues: [
      { value: 'Positive', outcomeType: 'Pass' },
      { value: 'Negative', outcomeType: 'Fail', isFallback: true },
    ],
  };

  it('produces valid XML with correct root element', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.include('<AiAgentScorerDefinition');
    expect(xml).to.include('xmlns="http://soap.sforce.com/2006/04/metadata"');
  });

  it('always emits LightningType dataType and OpenEnded scorerType', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.include('<dataType>LightningType</dataType>');
    expect(xml).to.include('<scorerType>OpenEnded</scorerType>');
    expect(xml).to.include('<lightningType>lightning__textType</lightningType>');
    expect(xml).to.include('<inputScope>Intent</inputScope>');
  });

  it('never emits a semanticType or specification block', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.not.include('<semanticType>');
    expect(xml).to.not.include('<specification>');
    expect(xml).to.not.include('<valueSpecification>');
  });

  it('includes outputEnumValues when provided', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.include('<value>Positive</value>');
    expect(xml).to.include('<value>Negative</value>');
    expect(xml).to.include('<outcomeType>Pass</outcomeType>');
    expect(xml).to.include('<outcomeType>Fail</outcomeType>');
    expect(xml).to.include('<isFallback>true</isFallback>');
  });

  it('omits the outputEnumValue block when no labels are defined', () => {
    const xml = buildScorerXml({ ...baseSpec, outputEnumValues: undefined });
    expect(xml).to.not.include('<outputEnumValue>');
    // The lightning type is still present for a label-free scorer.
    expect(xml).to.include('<lightningType>lightning__textType</lightningType>');
  });

  it('reflects the chosen lightning type', () => {
    const xml = buildScorerXml({ ...baseSpec, lightningType: 'lightning__booleanType', outputEnumValues: undefined });
    expect(xml).to.include('<lightningType>lightning__booleanType</lightningType>');
  });

  it('includes agentAssociation fields', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.include('<agentApiName>CopilotAgent</agentApiName>');
    expect(xml).to.include('<isActive>true</isActive>');
    expect(xml).to.include('<samplingRate>0.5</samplingRate>');
  });

  it('includes engineRef when engineType is PromptTemplate', () => {
    const xml = buildScorerXml(baseSpec);
    expect(xml).to.include('<engineRef>SentimentScore</engineRef>');
    expect(xml).to.include('<engineType>PromptTemplate</engineType>');
  });

  it('uses promptTemplateName as engineRef when provided', () => {
    const xml = buildScorerXml({ ...baseSpec, promptTemplateName: 'CustomTemplate' });
    expect(xml).to.include('<engineRef>CustomTemplate</engineRef>');
  });

  it('omits engineRef when engineType is Manual', () => {
    const xml = buildScorerXml({ ...baseSpec, engineType: 'Manual' });
    expect(xml).to.not.include('<engineRef>');
  });

  it('defaults status to Draft', () => {
    const xml = buildScorerXml({ ...baseSpec, status: undefined });
    expect(xml).to.include('<status>Draft</status>');
  });

  it('includes description when provided', () => {
    const xml = buildScorerXml({ ...baseSpec, description: 'A test scorer' });
    expect(xml).to.include('<description>A test scorer</description>');
  });

  it('defaults samplingRate to 1.0 when not provided', () => {
    const xml = buildScorerXml({ ...baseSpec, agentAssociation: { agentApiName: 'Agent1', isActive: true } });
    expect(xml).to.include('<samplingRate>1</samplingRate>');
  });
});

describe('buildPromptTemplateXml', () => {
  it('produces valid XML with GenAiPromptTemplate root', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'prompt content');
    expect(xml).to.include('<GenAiPromptTemplate');
    expect(xml).to.include('xmlns="http://soap.sforce.com/2006/04/metadata"');
  });

  it('includes developerName and masterLabel', () => {
    const xml = buildPromptTemplateXml('MyScorer', 'content');
    expect(xml).to.include('<developerName>MyScorer</developerName>');
    expect(xml).to.include('<masterLabel>MyScorer</masterLabel>');
  });

  it('includes prompt content', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'Analyze the session');
    expect(xml).to.include('<content>Analyze the session</content>');
  });

  it('always uses the scorerOpenEnded template type', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content');
    expect(xml).to.include('<type>agentforce_session_tracing__scorerOpenEnded</type>');
  });

  it('declares Session (required) plus optional AllowedLabels and FallbackLabel inputs', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content');
    const inputs = parsePromptTemplateInputs(xml);
    expect(inputs.get('Session')?.required).to.equal(true);
    expect(inputs.get('AllowedLabels')?.required).to.equal(false);
    expect(inputs.get('FallbackLabel')?.required).to.equal(false);
  });

  it('includes primaryModel and status', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content');
    expect(xml).to.include('<primaryModel>sfdc_ai__DefaultOpenAIGPT4OmniMini</primaryModel>');
    expect(xml).to.include('<status>Published</status>');
  });

  it('includes activeVersionIdentifier and versionIdentifier', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content');
    expect(xml).to.include('<activeVersionIdentifier>');
    expect(xml).to.include('<versionIdentifier>');
  });
});

describe('createScorerDefinition', () => {
  const spec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    lightningType: 'lightning__textType',
    engineType: 'PromptTemplate',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
    outputEnumValues: [
      { value: 'Good', outcomeType: 'Pass' },
      { value: 'Bad', outcomeType: 'Fail', isFallback: true },
    ],
  };

  it('returns scorer path and contents without writing when write is false', async () => {
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.path).to.equal('/tmp/test/aiAgentScorerDefinitions/TestScorer.aiAgentScorerDefinition-meta.xml');
    expect(result.apiName).to.equal('TestScorer');
    expect(result.contents).to.include('<AiAgentScorerDefinition');
  });

  it('returns prompt template path when engineType is PromptTemplate', async () => {
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplatePath).to.equal('/tmp/test/genAiPromptTemplates/TestScorer.genAiPromptTemplate-meta.xml');
    expect(result.promptTemplateContents).to.include('<GenAiPromptTemplate');
  });

  it('does not return prompt template when promptTemplateName is provided', async () => {
    const result = await createScorerDefinition(
      { ...spec, promptTemplateName: 'ExistingTemplate' },
      { outputDir: '/tmp/test', write: false }
    );
    expect(result.promptTemplatePath).to.be.undefined;
    expect(result.promptTemplateContents).to.be.undefined;
  });

  it('does not return prompt template for Manual engineType', async () => {
    const result = await createScorerDefinition({ ...spec, engineType: 'Manual' }, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplatePath).to.be.undefined;
    expect(result.promptTemplateContents).to.be.undefined;
  });

  it('uses custom promptContent when provided', async () => {
    const result = await createScorerDefinition(
      { ...spec, promptContent: 'Custom prompt here' },
      { outputDir: '/tmp/test', write: false }
    );
    expect(result.promptTemplateContents).to.include('Custom prompt here');
  });

  it('uses default prompt content when promptContent is not provided', async () => {
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplateContents).to.include('{!$Input:Session}');
    expect(result.promptTemplateContents).to.include('Scoring instructions:');
  });

  it('validates spec before building', async () => {
    try {
      await createScorerDefinition({ ...spec, apiName: '' }, { outputDir: '/tmp/test', write: false });
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).to.include('API name must start with a letter');
    }
  });
});

describe('parseScorerXml', () => {
  const spec: ScorerSpec = {
    apiName: 'SentimentScore',
    label: 'Sentiment Score',
    lightningType: 'lightning__textType',
    inputScope: 'Session',
    description: 'Scores sentiment',
    engineType: 'PromptTemplate',
    status: 'Available',
    agentAssociation: { agentApiName: 'CopilotAgent', isActive: true, samplingRate: 0.5, inputScope: 'Intent' },
    outputEnumValues: [
      { value: 'Positive', outcomeType: 'Pass', isFallback: false, isSystemFallback: false },
      { value: 'Negative', outcomeType: 'Fail', isFallback: true, isSystemFallback: false },
    ],
  };

  it('round-trips a full spec through buildScorerXml', () => {
    const parsed = parseScorerXml(buildScorerXml(spec), spec.apiName);
    // buildScorerXml always emits version 1, which parse records back onto the spec.
    expect(parsed).to.deep.equal({ ...spec, scorerVersion: 1 });
  });

  it('coerces boolean and numeric fields to their JS types', () => {
    const parsed = parseScorerXml(buildScorerXml(spec), spec.apiName);
    expect(parsed.agentAssociation.isActive).to.equal(true);
    expect(parsed.agentAssociation.samplingRate).to.equal(0.5);
    expect(parsed.outputEnumValues?.[1].isFallback).to.equal(true);
  });

  it('omits promptTemplateName when the engineRef is the generated template (== apiName)', () => {
    const parsed = parseScorerXml(buildScorerXml(spec), spec.apiName);
    expect(parsed.promptTemplateName).to.be.undefined;
  });

  it('recovers promptTemplateName when a pre-existing template was referenced', () => {
    const xml = buildScorerXml({ ...spec, promptTemplateName: 'CustomTemplate' });
    const parsed = parseScorerXml(xml, spec.apiName);
    expect(parsed.promptTemplateName).to.equal('CustomTemplate');
  });

  it('parses a single outputEnumValue as a one-element array', () => {
    const xml = buildScorerXml({ ...spec, outputEnumValues: [{ value: 'Only', outcomeType: 'Pass' }] });
    const parsed = parseScorerXml(xml, spec.apiName);
    expect(parsed.outputEnumValues).to.have.length(1);
    expect(parsed.outputEnumValues?.[0].value).to.equal('Only');
  });

  it('omits outputEnumValues for a label-free scorer', () => {
    const xml = buildScorerXml({ ...spec, outputEnumValues: undefined });
    const parsed = parseScorerXml(xml, spec.apiName);
    expect(parsed.outputEnumValues).to.be.undefined;
  });

  it('throws when the document is not an AiAgentScorerDefinition', () => {
    expect(() => parseScorerXml('<?xml version="1.0"?><Nope/>', 'X')).to.throw('not a valid AiAgentScorerDefinition');
  });
});

describe('scorer versioning', () => {
  const base: ScorerSpec = {
    apiName: 'Resolution',
    label: 'Resolution v1',
    lightningType: 'lightning__numberType',
    engineType: 'PromptTemplate',
    status: 'Available',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
  };

  // Multi-version scorers are authored by hand in the XML (`create` only scaffolds v1), so the parse/selection
  // paths below run against hand-authored fixtures: v1 Available + v2 at the given status, both associated.
  const scorerXmlWithV2Status = (v2Status: 'Draft' | 'Available' | 'Archived'): string =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<AiAgentScorerDefinition xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <dataType>LightningType</dataType>',
      '    <inputScope>Session</inputScope>',
      '    <lightningType>lightning__numberType</lightningType>',
      '    <scorerType>OpenEnded</scorerType>',
      '    <scorerVersion>',
      '        <agentAssociation>',
      '            <agentApiName>Agent1</agentApiName>',
      '            <isActive>true</isActive>',
      '            <samplingRate>1</samplingRate>',
      '        </agentAssociation>',
      '        <engine>',
      '            <engineRef>Resolution</engineRef>',
      '            <engineType>PromptTemplate</engineType>',
      '        </engine>',
      '        <label>Resolution v1</label>',
      '        <status>Available</status>',
      '        <versionNumber>1</versionNumber>',
      '    </scorerVersion>',
      '    <scorerVersion>',
      '        <agentAssociation>',
      '            <agentApiName>Agent1</agentApiName>',
      '            <isActive>true</isActive>',
      '            <samplingRate>1</samplingRate>',
      '        </agentAssociation>',
      '        <engine>',
      '            <engineRef>Resolution</engineRef>',
      '            <engineType>PromptTemplate</engineType>',
      '        </engine>',
      '        <label>Resolution v2</label>',
      `        <status>${v2Status}</status>`,
      '        <versionNumber>2</versionNumber>',
      '    </scorerVersion>',
      '</AiAgentScorerDefinition>',
    ].join('\n');

  // v1 Available, v2 Draft.
  const twoVersionXml = (): string => scorerXmlWithV2Status('Draft');

  // Build a definition with one <scorerVersion> per supplied status (v1, v2, …), for exercising the default
  // selection gate across Draft/Available/Archived combinations that `create` never scaffolds by hand.
  const versionsXml = (...statuses: string[]): string =>
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<AiAgentScorerDefinition xmlns="http://soap.sforce.com/2006/04/metadata">',
      '    <dataType>LightningType</dataType>',
      '    <inputScope>Session</inputScope>',
      '    <lightningType>lightning__numberType</lightningType>',
      '    <scorerType>OpenEnded</scorerType>',
      ...statuses.flatMap((status, i) => [
        '    <scorerVersion>',
        '        <agentAssociation>',
        '            <agentApiName>Agent1</agentApiName>',
        '            <isActive>true</isActive>',
        '            <samplingRate>1</samplingRate>',
        '        </agentAssociation>',
        '        <engine>',
        '            <engineRef>Resolution</engineRef>',
        '            <engineType>PromptTemplate</engineType>',
        '        </engine>',
        `        <label>Resolution v${i + 1}</label>`,
        `        <status>${status}</status>`,
        `        <versionNumber>${i + 1}</versionNumber>`,
        '    </scorerVersion>',
      ]),
      '</AiAgentScorerDefinition>',
    ].join('\n');

  describe('parseScorerVersions', () => {
    it('lists every version with its number, status, and active flag', () => {
      const versions = parseScorerVersions(twoVersionXml());
      expect(versions).to.deep.equal([
        { versionNumber: 1, status: 'Available', isActive: true, label: 'Resolution v1' },
        { versionNumber: 2, status: 'Draft', isActive: true, label: 'Resolution v2' },
      ]);
    });
  });

  describe('parseScorerXml version selection', () => {
    it('picks the highest-numbered Available version when none is requested', () => {
      // v1 Available, v2 Draft → v1 is the only Available.
      const parsed = parseScorerXml(twoVersionXml(), 'Resolution');
      expect(parsed.label).to.equal('Resolution v1');
    });

    it('prefers the higher Available version when several are Available', () => {
      const parsed = parseScorerXml(scorerXmlWithV2Status('Available'), 'Resolution');
      expect(parsed.label).to.equal('Resolution v2');
    });

    it('runs a requested Draft version explicitly (the refine inner loop)', () => {
      const parsed = parseScorerXml(twoVersionXml(), 'Resolution', { scorerVersion: 2 });
      expect(parsed.label).to.equal('Resolution v2');
    });

    it('records the resolved version number on the spec (default selection)', () => {
      // v1 Available, v2 Draft → v1 is served by default.
      expect(parseScorerXml(twoVersionXml(), 'Resolution').scorerVersion).to.equal(1);
    });

    it('records the resolved version number when a version is requested explicitly', () => {
      expect(parseScorerXml(twoVersionXml(), 'Resolution', { scorerVersion: 2 }).scorerVersion).to.equal(2);
    });

    it('runs the highest-numbered Draft version by default when none is Available', () => {
      // The authoring inner loop: a freshly-scaffolded, Draft-only scorer must run ad hoc without
      // --scorer-version. Default selection falls back to the highest non-Archived (Draft) version.
      const draftOnly = buildScorerXml({ ...base, status: 'Draft' });
      const parsed = parseScorerXml(draftOnly, 'Resolution');
      expect(parsed.label).to.equal('Resolution v1');
      expect(parsed.scorerVersion).to.equal(1);
      expect(parsed.status).to.equal('Draft');
    });

    it('picks the highest-numbered Draft when several exist and none is Available', () => {
      const parsed = parseScorerXml(versionsXml('Draft', 'Draft'), 'Resolution');
      expect(parsed.label).to.equal('Resolution v2');
      expect(parsed.scorerVersion).to.equal(2);
    });

    it('prefers an Available version over a higher-numbered Draft', () => {
      // v1 Available, v2 Draft → the released v1 wins the default even though v2 is newer.
      const parsed = parseScorerXml(versionsXml('Available', 'Draft'), 'Resolution');
      expect(parsed.label).to.equal('Resolution v1');
      expect(parsed.scorerVersion).to.equal(1);
    });

    it('throws only when every authored version is Archived', () => {
      expect(() => parseScorerXml(versionsXml('Archived', 'Archived'), 'Resolution')).to.throw(
        /no runnable version|every authored version is Archived/
      );
    });

    it('throws when a requested version does not exist', () => {
      expect(() => parseScorerXml(twoVersionXml(), 'Resolution', { scorerVersion: 99 })).to.throw(/has no version 99/);
    });

    it('throws when a requested version is archived', () => {
      const archived = scorerXmlWithV2Status('Archived');
      expect(() => parseScorerXml(archived, 'Resolution', { scorerVersion: 2 })).to.throw(/is archived and can't be run/);
    });
  });
});

describe('loadScorerSpec', () => {
  const spec: ScorerSpec = {
    apiName: 'SentimentScore',
    label: 'Sentiment Score',
    lightningType: 'lightning__textType',
    engineType: 'PromptTemplate',
    // Available so it is runnable by default: run resolves the highest-numbered Available version.
    status: 'Available',
    agentAssociation: { agentApiName: 'CopilotAgent', isActive: true },
  };

  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'scorer-load-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('finds and parses a scorer nested under a package directory', async () => {
    const dir = join(root, 'force-app', 'main', 'default', 'aiAgentScorerDefinitions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${spec.apiName}.aiAgentScorerDefinition-meta.xml`), buildScorerXml(spec));

    const loaded = await loadScorerSpec({ apiName: spec.apiName, directories: [join(root, 'force-app')] });
    expect(loaded.apiName).to.equal('SentimentScore');
    expect(loaded.engineType).to.equal('PromptTemplate');
    expect(loaded.agentAssociation.agentApiName).to.equal('CopilotAgent');
  });

  it('searches multiple directories and skips ones that do not exist', async () => {
    const dir = join(root, 'pkg2', 'main', 'default', 'aiAgentScorerDefinitions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${spec.apiName}.aiAgentScorerDefinition-meta.xml`), buildScorerXml(spec));

    const loaded = await loadScorerSpec({
      apiName: spec.apiName,
      directories: [join(root, 'missing-pkg'), join(root, 'pkg2')],
    });
    expect(loaded.apiName).to.equal('SentimentScore');
  });

  it('throws a clear error when no scorer with that api name exists', async () => {
    mkdirSync(join(root, 'force-app'), { recursive: true });
    try {
      await loadScorerSpec({ apiName: 'Missing_Scorer', directories: [join(root, 'force-app')] });
      expect.fail('should have thrown');
    } catch (e: unknown) {
      const message = (e as Error).message;
      expect(message).to.include("No scorer named 'Missing_Scorer'");
      expect(message).to.include('sf agent scorer generate-metadata-file');
    }
  });
});
