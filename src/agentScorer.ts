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

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { stringify } from 'yaml';
import { ScorerSpec } from './types.js';

/** Default template for a Number (measurement) scorer. */
const NUMBER_SCORER_TEMPLATE: ScorerSpec = {
  name: 'My_Custom_Scorer',
  description: 'A custom numeric scorer',
  inputScope: 'Session',
  dataType: 'Number',
  version: {
    versionNumber: 1,
    status: 'Draft',
    label: 'My Custom Scorer',
    description: 'Evaluates session quality on a 0-5 scale',
    agentApiName: 'My_Agent',
    isActive: false,
    engine: {
      engineType: 'PromptTemplate',
      engineRef: 'My_Scorer_Prompt_Template',
    },
    outputEnumValues: [
      { value: '0', outcomeType: 'Fail', isFallback: false },
      { value: '1', outcomeType: 'Fail', isFallback: false },
      { value: '2', outcomeType: 'Fail', isFallback: false },
      { value: '3', outcomeType: 'Pass', isFallback: true },
      { value: '4', outcomeType: 'Pass', isFallback: false },
      { value: '5', outcomeType: 'Pass', isFallback: false },
    ],
    valueSpecification: {
      min: 0,
      max: 5,
      step: 1,
      threshold: 3,
    },
  },
};

/** Default template for a Text (multilabel) scorer. */
const TEXT_SCORER_TEMPLATE: ScorerSpec = {
  name: 'My_Custom_Scorer',
  description: 'A custom text classifier scorer',
  inputScope: 'Session',
  dataType: 'Text',
  version: {
    versionNumber: 1,
    status: 'Draft',
    label: 'My Custom Scorer',
    description: 'Classifies sessions by category',
    agentApiName: 'My_Agent',
    isActive: false,
    engine: {
      engineType: 'PromptTemplate',
      engineRef: 'My_Scorer_Prompt_Template',
    },
    outputEnumValues: [
      { value: 'category_a', outcomeType: 'NotApplicable', isFallback: false },
      { value: 'category_b', outcomeType: 'NotApplicable', isFallback: false },
      { value: 'NOT_FOUND', outcomeType: 'NotApplicable', isFallback: true },
    ],
  },
};

export class AgentScorer {
  /**
   * Write a scorer spec YAML template to the given output file.
   *
   * @param outputFile - Destination file path.
   * @param dataType - Whether to emit a Number or Text starter template.
   * @param overrides - Optional values to override in the template before writing.
   */
  public static async writeScorerSpecTemplate(
    outputFile: string,
    dataType: 'Number' | 'Text' = 'Number',
    overrides: { name?: string; agentApiName?: string } = {}
  ): Promise<void> {
    const base = dataType === 'Text' ? TEXT_SCORER_TEMPLATE : NUMBER_SCORER_TEMPLATE;
    const template: ScorerSpec = {
      ...base,
      ...(overrides.name && { name: overrides.name }),
      version: {
        ...base.version,
        ...(overrides.name && { label: overrides.name }),
        ...(overrides.agentApiName && { agentApiName: overrides.agentApiName }),
      },
    };
    const yml = stringify(template, undefined, { minContentWidth: 0, lineWidth: 0 });
    await mkdir(dirname(outputFile), { recursive: true });
    await writeFile(outputFile, yml);
  }

  /** Default output path for a scorer spec YAML, mirroring testspec naming. */
  public static defaultSpecPath(scorerName: string): string {
    return join('specs', `${scorerName}-scorerSpec.yaml`);
  }
}
