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

import { createHash } from 'node:crypto';
import { XMLBuilder, XMLParser } from 'fast-xml-parser';
import {
  type ScorerSpec,
  type ScorerEngineType,
  type ScorerInputScope,
  type ScorerOutcomeType,
  type ScorerStatus,
  type SupportedLightningType,
  SCORER_PROMPT_TEMPLATE_TYPE,
} from './types';

export function buildScorerXml(spec: ScorerSpec): string {
  const engine: Record<string, unknown> = {};
  if (spec.engineType === 'PromptTemplate') {
    engine.engineRef = spec.promptTemplateName ?? spec.apiName;
  }
  engine.engineType = spec.engineType;

  const agentAssociationXml: Record<string, unknown> = {
    agentApiName: spec.agentAssociation.agentApiName,
    ...(spec.agentAssociation.inputScope ? { inputScope: spec.agentAssociation.inputScope } : {}),
    isActive: spec.agentAssociation.isActive,
    samplingRate: spec.agentAssociation.samplingRate ?? 1.0,
  };

  const scorerVersion: Record<string, unknown> = {
    agentAssociation: agentAssociationXml,
    ...(spec.description ? { description: spec.description } : {}),
    engine,
    label: spec.label,
  };

  if (spec.outputEnumValues) {
    scorerVersion.outputEnumValue = spec.outputEnumValues.map((v) => ({
      isFallback: v.isFallback ?? false,
      isSystemFallback: v.isSystemFallback ?? false,
      outcomeType: v.outcomeType,
      value: v.value,
    }));
  }

  scorerVersion.status = spec.status ?? 'Draft';
  scorerVersion.versionNumber = 1;

  // Every scorer is an open-ended LightningType scorer; the lightning type carries the value's shape.
  const definition: Record<string, unknown> = {
    '@_xmlns': 'http://soap.sforce.com/2006/04/metadata',
    dataType: 'LightningType',
    inputScope: spec.inputScope ?? 'Session',
    lightningType: spec.lightningType,
    scorerType: 'OpenEnded',
    scorerVersion,
  };

  const xmlObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    AiAgentScorerDefinition: definition,
  };

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    suppressBooleanAttributes: false,
  });

  return builder.build(xmlObj);
}

// --- Parsing (metadata XML → spec) ----------------------------------------------------------------------
//
// Reverses buildScorerXml so a scorer already authored into project metadata can be loaded back into a typed
// ScorerSpec (e.g. to run it). The apiName is not stored in the XML — it is the file's developer name — so the
// caller supplies it.

type RawEngine = { engineType?: string; engineRef?: string };
type RawEnum = { value?: string; outcomeType?: string; isFallback?: unknown; isSystemFallback?: unknown };
type RawAssociation = { agentApiName?: string; isActive?: unknown; samplingRate?: unknown; inputScope?: string };
type RawVersion = {
  agentAssociation?: RawAssociation;
  description?: string;
  engine?: RawEngine;
  label?: string;
  outputEnumValue?: RawEnum | RawEnum[];
  status?: string;
};
type RawDefinition = {
  inputScope?: string;
  lightningType?: string;
  scorerVersion?: RawVersion;
};

const toBool = (value: unknown): boolean => value === true || String(value) === 'true';
const toArray = <T>(value: T | T[] | undefined): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);

/** Parse an `AiAgentScorerDefinition` metadata XML document back into a typed spec. */
export function parseScorerXml(xml: string, apiName: string): ScorerSpec {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const root = parser.parse(xml) as { AiAgentScorerDefinition?: RawDefinition };
  const def = root.AiAgentScorerDefinition;
  if (!def) {
    throw new Error(`The metadata for scorer '${apiName}' is not a valid AiAgentScorerDefinition.`);
  }

  const version = def.scorerVersion ?? {};
  const engine = version.engine ?? {};
  const association = version.agentAssociation ?? {};
  const engineType = engine.engineType as ScorerEngineType;

  const spec: ScorerSpec = {
    apiName,
    lightningType: def.lightningType as SupportedLightningType,
    label: version.label ?? apiName,
    engineType,
    agentAssociation: {
      agentApiName: association.agentApiName ?? '',
      isActive: toBool(association.isActive),
    },
  };

  if (def.inputScope) spec.inputScope = def.inputScope as ScorerInputScope;
  if (version.description) spec.description = version.description;
  if (version.status) spec.status = version.status as ScorerStatus;
  if (association.samplingRate != null && association.samplingRate !== '') {
    spec.agentAssociation.samplingRate = Number(association.samplingRate);
  }
  if (association.inputScope) spec.agentAssociation.inputScope = association.inputScope as ScorerInputScope;

  // engineRef is the generated template (== apiName) unless a pre-existing template was referenced.
  if (engineType === 'PromptTemplate' && engine.engineRef && engine.engineRef !== apiName) {
    spec.promptTemplateName = engine.engineRef;
  }

  const enumValues = toArray(version.outputEnumValue);
  if (enumValues.length) {
    spec.outputEnumValues = enumValues.map((v) => ({
      value: v.value ?? '',
      outcomeType: v.outcomeType as ScorerOutcomeType,
      isFallback: toBool(v.isFallback),
      isSystemFallback: toBool(v.isSystemFallback),
    }));
  }

  return spec;
}

export function buildPromptTemplateXml(apiName: string, promptContent: string): string {
  // Labels are optional (a scorer may define none), but the inputs are always declared so the template shape is
  // stable; the generated prompt references them only when the scorer actually has predefined labels.
  const inputs: Array<{ apiName: string; definition: string; referenceName: string; required: boolean }> = [
    {
      apiName: 'Session',
      definition: 'lightningtype://propertyType/agentforce_session_tracing__stdmDetailViewType',
      referenceName: 'Input:Session',
      required: true,
    },
    {
      apiName: 'AllowedLabels',
      definition: 'primitive://String',
      referenceName: 'Input:AllowedLabels',
      required: false,
    },
    {
      apiName: 'FallbackLabel',
      definition: 'primitive://String',
      referenceName: 'Input:FallbackLabel',
      required: false,
    },
  ];

  const versionIdentifier = createHash('sha256').update(promptContent).digest('base64') + '_1';

  const xmlObj = {
    '?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
    GenAiPromptTemplate: {
      '@_xmlns': 'http://soap.sforce.com/2006/04/metadata',
      activeVersionIdentifier: versionIdentifier,
      developerName: apiName,
      masterLabel: apiName,
      overridable: false,
      templateVersions: {
        content: promptContent,
        inputs,
        // default scaffolding; users can override by editing the prompt template after generation
        primaryModel: 'sfdc_ai__DefaultOpenAIGPT4OmniMini',
        status: 'Published',
        versionIdentifier,
      },
      type: SCORER_PROMPT_TEMPLATE_TYPE,
      visibility: 'Global',
    },
  };

  const builder = new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    suppressBooleanAttributes: false,
  });

  return builder.build(xmlObj);
}
