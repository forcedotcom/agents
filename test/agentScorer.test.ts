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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { expect } from 'chai';
import { parse } from 'yaml';
import { AgentScorer } from '../src/agentScorer';
import type { ScorerSpec } from '../src/types';

describe('AgentScorer', () => {
  describe('defaultSpecPath', () => {
    it('returns specs/<name>-scorerSpec.yaml', () => {
      expect(AgentScorer.defaultSpecPath('My_Scorer')).to.equal(join('specs', 'My_Scorer-scorerSpec.yaml'));
    });
  });

  describe('writeScorerSpecTemplate', () => {
    const outputFile = join(tmpdir(), `agentScorer-test-${Date.now()}.yaml`);

    it('writes a valid Number template by default', async () => {
      await AgentScorer.writeScorerSpecTemplate(outputFile);
      const raw = await readFile(outputFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      expect(spec.dataType).to.equal('Number');
      expect(spec.inputScope).to.equal('Session');
      expect(spec.version.status).to.equal('Draft');
      expect(spec.version.engine.engineType).to.equal('PromptTemplate');
      expect(spec.version.outputEnumValues).to.have.length.greaterThan(0);
      expect(spec.version.valueSpecification).to.exist;
    });

    it('writes a valid Text template when dataType is Text', async () => {
      const textFile = join(tmpdir(), `agentScorer-text-test-${Date.now()}.yaml`);
      await AgentScorer.writeScorerSpecTemplate(textFile, 'Text');
      const raw = await readFile(textFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      expect(spec.dataType).to.equal('Text');
      expect(spec.version.valueSpecification).to.be.undefined;
      expect(spec.version.outputEnumValues.every((v) => v.outcomeType === 'NotApplicable')).to.be.true;
    });

    it('applies --name override to name and label', async () => {
      const namedFile = join(tmpdir(), `agentScorer-name-test-${Date.now()}.yaml`);
      await AgentScorer.writeScorerSpecTemplate(namedFile, 'Number', { name: 'Sentiment_Scorer' });
      const raw = await readFile(namedFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      expect(spec.name).to.equal('Sentiment_Scorer');
      expect(spec.version.label).to.equal('Sentiment_Scorer');
    });

    it('applies --agent-api-name override', async () => {
      const agentFile = join(tmpdir(), `agentScorer-agent-test-${Date.now()}.yaml`);
      await AgentScorer.writeScorerSpecTemplate(agentFile, 'Number', { agentApiName: 'Resort_Agent' });
      const raw = await readFile(agentFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      expect(spec.version.agentApiName).to.equal('Resort_Agent');
    });

    it('applies both overrides at once', async () => {
      const bothFile = join(tmpdir(), `agentScorer-both-test-${Date.now()}.yaml`);
      await AgentScorer.writeScorerSpecTemplate(bothFile, 'Text', {
        name: 'Language_Classifier',
        agentApiName: 'My_Agent',
      });
      const raw = await readFile(bothFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      expect(spec.name).to.equal('Language_Classifier');
      expect(spec.version.label).to.equal('Language_Classifier');
      expect(spec.version.agentApiName).to.equal('My_Agent');
      expect(spec.dataType).to.equal('Text');
    });

    it('Text template has exactly one fallback value', async () => {
      const textFile = join(tmpdir(), `agentScorer-fallback-test-${Date.now()}.yaml`);
      await AgentScorer.writeScorerSpecTemplate(textFile, 'Text');
      const raw = await readFile(textFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      const fallbacks = spec.version.outputEnumValues.filter((v) => v.isFallback);
      expect(fallbacks).to.have.length(1);
    });

    it('Number template has exactly one fallback value', async () => {
      await AgentScorer.writeScorerSpecTemplate(outputFile, 'Number');
      const raw = await readFile(outputFile, 'utf-8');
      const spec = parse(raw) as ScorerSpec;

      const fallbacks = spec.version.outputEnumValues.filter((v) => v.isFallback);
      expect(fallbacks).to.have.length(1);
    });
  });
});
