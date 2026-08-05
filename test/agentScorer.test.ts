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
import {
  validateScorerSpec,
  labelToApiName,
  generateNumberEnumValues,
  buildDefaultPromptContent,
  buildScorerXml,
  buildPromptTemplateXml,
  createScorerDefinition,
} from '../src/agentScorer';
import type { ScorerSpec } from '../src/agentScorer';

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

describe('generateNumberEnumValues', () => {
  it('generates correct number of values for integer steps', () => {
    const values = generateNumberEnumValues({ min: 0, max: 5, step: 1 });
    expect(values).to.have.lengthOf(6);
    expect(values[0].value).to.equal('0');
    expect(values[5].value).to.equal('5');
  });

  it('generates values for fractional steps', () => {
    const values = generateNumberEnumValues({ min: 0, max: 1, step: 0.5 });
    expect(values).to.have.lengthOf(3);
    expect(values.map((v) => v.value)).to.deep.equal(['0', '0.5', '1']);
  });

  it('sets outcomeType to NotApplicable and isFallback to false', () => {
    const values = generateNumberEnumValues({ min: 1, max: 3, step: 1 });
    for (const v of values) {
      expect(v.outcomeType).to.equal('NotApplicable');
      expect(v.isFallback).to.equal(false);
      expect(v.isSystemFallback).to.equal(false);
    }
  });
});

describe('validateScorerSpec', () => {
  const baseSpec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    dataType: 'Number',
    engineType: 'Manual',
    agentAssociation: {
      agentApiName: 'MyAgent',
      isActive: true,
    },
  };

  it('throws for invalid apiName - starts with number', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        apiName: '1Invalid',
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
      })
    ).to.throw('API name must start with a letter');
  });

  it('throws for apiName longer than 35 characters', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        apiName: 'A'.repeat(36),
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
      })
    ).to.throw('API name must start with a letter');
  });

  it('throws for empty apiName', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        apiName: '',
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
      })
    ).to.throw('API name must start with a letter');
  });

  it('throws when dataType is Text and outputEnumValues is missing', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'Text',
        specification: undefined,
      })
    ).to.throw("outputEnumValues is required when dataType is 'Text'.");
  });

  it('throws when dataType is Text and outputEnumValues is empty', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'Text',
        outputEnumValues: [],
      })
    ).to.throw("outputEnumValues is required when dataType is 'Text'.");
  });

  it('throws when Text scorer has no fallback value', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'Text',
        outputEnumValues: [{ value: 'Good', outcomeType: 'Pass' }],
      })
    ).to.throw('Text scorers must have exactly 1 fallback value, but found 0.');
  });

  it('throws when Text scorer has multiple fallback values', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'Text',
        outputEnumValues: [
          { value: 'Good', outcomeType: 'Pass', isFallback: true },
          { value: 'Bad', outcomeType: 'Fail', isFallback: true },
        ],
      })
    ).to.throw('Text scorers must have exactly 1 fallback value, but found 2.');
  });

  it('does not throw for valid Text scorer', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'Text',
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
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 1.5 },
      })
    ).to.throw('samplingRate must be between 0 and 1, but got 1.5.');
  });

  it('throws when samplingRate is less than 0', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: -0.1 },
      })
    ).to.throw('samplingRate must be between 0 and 1, but got -0.1.');
  });

  it('allows samplingRate at boundaries 0 and 1', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 0 },
      })
    ).to.not.throw();
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
        agentAssociation: { agentApiName: 'MyAgent', isActive: true, samplingRate: 1 },
      })
    ).to.not.throw();
  });

  it('throws when dataType is Number and specification is missing', () => {
    expect(() => validateScorerSpec({ ...baseSpec, specification: undefined })).to.throw(
      "specification is required when dataType is 'Number'."
    );
  });

  it('does not throw when dataType is Number and specification is provided', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
      })
    ).to.not.throw();
  });

  it('throws when Number specification has min >= max', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 10, max: 5, step: 1 } },
      })
    ).to.throw('Minimum value (10) must be less than maximum value (5).');
  });

  it('throws when Number specification has step <= 0', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 0 } },
      })
    ).to.throw('Step must be a positive number.');
  });

  it('throws when Number specification step produces too many values', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 100, step: 0.001 } },
      })
    ).to.throw(/Step too small: would generate \d+ values/);
  });

  it('throws when dataType is Number and outputEnumValues is provided', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        specification: { valueSpecification: { min: 0, max: 10, step: 1 } },
        outputEnumValues: [{ value: '1', outcomeType: 'Pass' }],
      })
    ).to.throw("outputEnumValues cannot be provided when dataType is 'Number'. Use specification instead.");
  });

  it('throws when lightningType is not in SUPPORTED_LIGHTNING_TYPES', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'LightningType',
        lightningType: 'bogus__type',
      })
    ).to.throw("Unsupported lightningType 'bogus__type'.");
  });

  it('throws when dataType is LightningType and lightningType is missing', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'LightningType',
      })
    ).to.throw("lightningType is required when dataType is 'LightningType'.");
  });

  it('does not throw for a valid lightningType', () => {
    expect(() =>
      validateScorerSpec({
        ...baseSpec,
        dataType: 'LightningType',
        lightningType: 'lightning__textType',
      })
    ).to.not.throw();
  });
});

describe('buildDefaultPromptContent', () => {
  it('returns open-ended prompt when scorerType is OpenEnded', () => {
    const content = buildDefaultPromptContent({ scorerType: 'OpenEnded' });
    expect(content).to.include('{!$Input:Session}');
    expect(content).to.include('provide your evaluation');
    expect(content).to.not.include('{!$Input:AllowedLabels}');
  });

  it('returns measurement prompt when semanticType is Measurement', () => {
    const content = buildDefaultPromptContent({ scorerType: 'Predefined', semanticType: 'Measurement' });
    expect(content).to.include('{!$Input:AllowedRange}');
    expect(content).to.include('ONLY a number');
  });

  it('returns multilabel prompt by default', () => {
    const content = buildDefaultPromptContent({ scorerType: 'Predefined', semanticType: 'Dimension' });
    expect(content).to.include('{!$Input:AllowedLabels}');
    expect(content).to.include('{!$Input:FallbackLabel}');
  });
});

describe('buildScorerXml', () => {
  const textSpec: ScorerSpec = {
    apiName: 'SentimentScore',
    label: 'Sentiment Score',
    dataType: 'Text',
    engineType: 'PromptTemplate',
    scorerType: 'Predefined',
    semanticType: 'Dimension',
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
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<AiAgentScorerDefinition');
    expect(xml).to.include('xmlns="http://soap.sforce.com/2006/04/metadata"');
  });

  it('includes dataType and inputScope', () => {
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<dataType>Text</dataType>');
    expect(xml).to.include('<inputScope>Intent</inputScope>');
  });

  it('includes scorerType and semanticType when provided', () => {
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<scorerType>Predefined</scorerType>');
    expect(xml).to.include('<semanticType>Dimension</semanticType>');
  });

  it('includes outputEnumValues for Text scorers', () => {
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<value>Positive</value>');
    expect(xml).to.include('<value>Negative</value>');
    expect(xml).to.include('<outcomeType>Pass</outcomeType>');
    expect(xml).to.include('<outcomeType>Fail</outcomeType>');
  });

  it('includes agentAssociation fields', () => {
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<agentApiName>CopilotAgent</agentApiName>');
    expect(xml).to.include('<isActive>true</isActive>');
    expect(xml).to.include('<samplingRate>0.5</samplingRate>');
  });

  it('includes specification for Number scorers without outputEnumValues', () => {
    const numberSpec: ScorerSpec = {
      apiName: 'ResponseTime',
      label: 'Response Time',
      dataType: 'Number',
      engineType: 'Manual',
      agentAssociation: { agentApiName: 'Agent1', isActive: true },
      specification: { valueSpecification: { min: 1, max: 5, step: 1, threshold: 3 } },
    };
    const xml = buildScorerXml(numberSpec);
    expect(xml).to.include('<min>1</min>');
    expect(xml).to.include('<max>5</max>');
    expect(xml).to.include('<step>1</step>');
    expect(xml).to.include('<threshold>3</threshold>');
    expect(xml).to.not.include('<outputEnumValue>');
  });

  it('omits threshold from specification when not provided', () => {
    const numberSpec: ScorerSpec = {
      apiName: 'ResponseTime',
      label: 'Response Time',
      dataType: 'Number',
      engineType: 'Manual',
      agentAssociation: { agentApiName: 'Agent1', isActive: true },
      specification: { valueSpecification: { min: 0, max: 10, step: 2 } },
    };
    const xml = buildScorerXml(numberSpec);
    expect(xml).to.not.include('<threshold>');
  });

  it('includes engineRef when engineType is PromptTemplate', () => {
    const xml = buildScorerXml(textSpec);
    expect(xml).to.include('<engineRef>SentimentScore</engineRef>');
    expect(xml).to.include('<engineType>PromptTemplate</engineType>');
  });

  it('uses promptTemplateName as engineRef when provided', () => {
    const spec: ScorerSpec = { ...textSpec, promptTemplateName: 'CustomTemplate' };
    const xml = buildScorerXml(spec);
    expect(xml).to.include('<engineRef>CustomTemplate</engineRef>');
  });

  it('omits engineRef when engineType is Manual', () => {
    const spec: ScorerSpec = { ...textSpec, engineType: 'Manual' };
    const xml = buildScorerXml(spec);
    expect(xml).to.not.include('<engineRef>');
  });

  it('defaults status to Draft', () => {
    const spec: ScorerSpec = { ...textSpec, status: undefined };
    const xml = buildScorerXml(spec);
    expect(xml).to.include('<status>Draft</status>');
  });

  it('includes lightningType when dataType is LightningType', () => {
    const spec: ScorerSpec = {
      ...textSpec,
      dataType: 'LightningType',
      lightningType: 'lightning__booleanType',
      outputEnumValues: undefined,
    };
    const xml = buildScorerXml(spec);
    expect(xml).to.include('<lightningType>lightning__booleanType</lightningType>');
  });

  it('includes description when provided', () => {
    const spec: ScorerSpec = { ...textSpec, description: 'A test scorer' };
    const xml = buildScorerXml(spec);
    expect(xml).to.include('<description>A test scorer</description>');
  });

  it('defaults samplingRate to 1.0 when not provided', () => {
    const spec: ScorerSpec = {
      ...textSpec,
      agentAssociation: { agentApiName: 'Agent1', isActive: true },
    };
    const xml = buildScorerXml(spec);
    expect(xml).to.include('<samplingRate>1</samplingRate>');
  });
});

describe('buildPromptTemplateXml', () => {
  const spec: ScorerSpec = {
    apiName: 'TestPrompt',
    label: 'Test Prompt',
    dataType: 'Text',
    engineType: 'PromptTemplate',
    scorerType: 'Predefined',
    semanticType: 'Dimension',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
    outputEnumValues: [
      { value: 'Yes', outcomeType: 'Pass' },
      { value: 'No', outcomeType: 'Fail', isFallback: true },
    ],
  };

  it('produces valid XML with GenAiPromptTemplate root', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'prompt content', spec);
    expect(xml).to.include('<GenAiPromptTemplate');
    expect(xml).to.include('xmlns="http://soap.sforce.com/2006/04/metadata"');
  });

  it('includes developerName and masterLabel', () => {
    const xml = buildPromptTemplateXml('MyScorer', 'content', spec);
    expect(xml).to.include('<developerName>MyScorer</developerName>');
    expect(xml).to.include('<masterLabel>MyScorer</masterLabel>');
  });

  it('includes prompt content', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'Analyze the session', spec);
    expect(xml).to.include('<content>Analyze the session</content>');
  });

  it('uses scorerMultilabel type for Predefined Dimension', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content', spec);
    expect(xml).to.include('<type>agentforce_session_tracing__scorerMultilabel</type>');
  });

  it('uses scorerOpenEnded type for OpenEnded scorer', () => {
    const openEndedSpec: ScorerSpec = { ...spec, scorerType: 'OpenEnded' };
    const xml = buildPromptTemplateXml('TestPrompt', 'content', openEndedSpec);
    expect(xml).to.include('<type>agentforce_session_tracing__scorerOpenEnded</type>');
  });

  it('uses scorerMeasurement type for Measurement semantic type', () => {
    const measurementSpec: ScorerSpec = { ...spec, semanticType: 'Measurement' };
    const xml = buildPromptTemplateXml('TestPrompt', 'content', measurementSpec);
    expect(xml).to.include('<type>agentforce_session_tracing__scorerMeasurement</type>');
  });

  it('includes AllowedRange input for Measurement type', () => {
    const measurementSpec: ScorerSpec = { ...spec, semanticType: 'Measurement' };
    const xml = buildPromptTemplateXml('TestPrompt', 'content', measurementSpec);
    expect(xml).to.include('<apiName>AllowedRange</apiName>');
    expect(xml).to.not.include('<apiName>AllowedLabels</apiName>');
  });

  it('includes AllowedLabels and FallbackLabel inputs for multilabel type', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content', spec);
    expect(xml).to.include('<apiName>AllowedLabels</apiName>');
    expect(xml).to.include('<apiName>FallbackLabel</apiName>');
  });

  it('marks AllowedLabels and FallbackLabel as not required for OpenEnded', () => {
    const openEndedSpec: ScorerSpec = { ...spec, scorerType: 'OpenEnded' };
    const xml = buildPromptTemplateXml('TestPrompt', 'content', openEndedSpec);
    expect(xml).to.include('<apiName>AllowedLabels</apiName>');
    expect(xml).to.include('<apiName>FallbackLabel</apiName>');
  });

  it('includes primaryModel and status', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content', spec);
    expect(xml).to.include('<primaryModel>sfdc_ai__DefaultOpenAIGPT4OmniMini</primaryModel>');
    expect(xml).to.include('<status>Published</status>');
  });

  it('includes activeVersionIdentifier and versionIdentifier', () => {
    const xml = buildPromptTemplateXml('TestPrompt', 'content', spec);
    expect(xml).to.include('<activeVersionIdentifier>');
    expect(xml).to.include('<versionIdentifier>');
  });
});

describe('createScorerDefinition', () => {
  const textSpec: ScorerSpec = {
    apiName: 'TestScorer',
    label: 'Test Scorer',
    dataType: 'Text',
    engineType: 'PromptTemplate',
    scorerType: 'Predefined',
    semanticType: 'Dimension',
    agentAssociation: { agentApiName: 'Agent1', isActive: true },
    outputEnumValues: [
      { value: 'Good', outcomeType: 'Pass' },
      { value: 'Bad', outcomeType: 'Fail', isFallback: true },
    ],
  };

  it('returns scorer path and contents without writing when write is false', async () => {
    const result = await createScorerDefinition(textSpec, { outputDir: '/tmp/test', write: false });
    expect(result.path).to.equal('/tmp/test/aiAgentScorerDefinitions/TestScorer.aiAgentScorerDefinition-meta.xml');
    expect(result.apiName).to.equal('TestScorer');
    expect(result.contents).to.include('<AiAgentScorerDefinition');
  });

  it('returns prompt template path when engineType is PromptTemplate', async () => {
    const result = await createScorerDefinition(textSpec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplatePath).to.equal('/tmp/test/genAiPromptTemplates/TestScorer.genAiPromptTemplate-meta.xml');
    expect(result.promptTemplateContents).to.include('<GenAiPromptTemplate');
  });

  it('does not return prompt template when promptTemplateName is provided', async () => {
    const spec: ScorerSpec = { ...textSpec, promptTemplateName: 'ExistingTemplate' };
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplatePath).to.be.undefined;
    expect(result.promptTemplateContents).to.be.undefined;
  });

  it('does not return prompt template for Manual engineType', async () => {
    const spec: ScorerSpec = { ...textSpec, engineType: 'Manual' };
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplatePath).to.be.undefined;
    expect(result.promptTemplateContents).to.be.undefined;
  });

  it('uses custom promptContent when provided', async () => {
    const spec: ScorerSpec = { ...textSpec, promptContent: 'Custom prompt here' };
    const result = await createScorerDefinition(spec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplateContents).to.include('Custom prompt here');
  });

  it('uses default prompt content when promptContent is not provided', async () => {
    const result = await createScorerDefinition(textSpec, { outputDir: '/tmp/test', write: false });
    expect(result.promptTemplateContents).to.include('{!$Input:AllowedLabels}');
  });

  it('validates spec before building', async () => {
    const invalidSpec: ScorerSpec = { ...textSpec, apiName: '' };
    try {
      await createScorerDefinition(invalidSpec, { outputDir: '/tmp/test', write: false });
      expect.fail('should have thrown');
    } catch (e: unknown) {
      expect((e as Error).message).to.include('API name must start with a letter');
    }
  });
});
