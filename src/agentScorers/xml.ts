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
  type ScorerVersionStatus,
  type SupportedLightningType,
  SCORER_PROMPT_TEMPLATE_TYPE,
  SCORER_VERSION_STATUSES,
} from './types';

const XML_DECLARATION = { '@_version': '1.0', '@_encoding': 'UTF-8' } as const;
const METADATA_XMLNS = 'http://soap.sforce.com/2006/04/metadata';

/** Shared builder configuration so every document we emit is formatted identically. */
function xmlBuilder(): XMLBuilder {
  return new XMLBuilder({
    format: true,
    ignoreAttributes: false,
    indentBy: '    ',
    suppressBooleanAttributes: false,
  });
}

/** Build one `<scorerVersion>` object (the versioned half of the definition) from a spec. */
function buildScorerVersionObject(
  spec: ScorerSpec,
  options: { versionNumber: number; status?: ScorerVersionStatus }
): Record<string, unknown> {
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

  scorerVersion.status = options.status ?? spec.status ?? 'Draft';
  scorerVersion.versionNumber = options.versionNumber;
  return scorerVersion;
}

/** Serialize an `AiAgentScorerDefinition` element (with the shared xmlns) to a full XML document. */
function buildScorerDocument(definition: Record<string, unknown>): string {
  return xmlBuilder().build({
    '?xml': XML_DECLARATION,
    AiAgentScorerDefinition: { '@_xmlns': METADATA_XMLNS, ...definition },
  });
}

export function buildScorerXml(spec: ScorerSpec): string {
  // A freshly-authored scorer always starts at version 1. `create` only scaffolds this single version;
  // any further change (new versions, status, activation) is authored by hand directly in the XML afterward.
  const scorerVersion = buildScorerVersionObject(spec, { versionNumber: 1 });

  // Every scorer is an open-ended LightningType scorer; the lightning type carries the value's shape.
  return buildScorerDocument({
    dataType: 'LightningType',
    inputScope: spec.inputScope ?? 'Session',
    lightningType: spec.lightningType,
    scorerType: 'OpenEnded',
    scorerVersion,
  });
}

// --- Parsing (metadata XML → spec) ----------------------------------------------------------------------
//
// Reverses buildScorerXml so a scorer already authored into project metadata can be loaded back into a typed
// ScorerSpec (e.g. to run it). The apiName is not stored in the XML — it is the file's developer name — so the
// caller supplies it. A definition may carry more than one <scorerVersion>; parseScorerXml selects one (see
// selectScorerVersion) and flattens it into the single-version ScorerSpec that runScorer consumes.

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
  versionNumber?: unknown;
};
type RawDefinition = {
  inputScope?: string;
  lightningType?: string;
  scorerVersion?: RawVersion | RawVersion[];
};

const toBool = (value: unknown): boolean => value === true || String(value) === 'true';
const toArray = <T>(value: T | T[] | undefined): T[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const toVersionNumber = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};
/** Coerce a raw status string into a known lifecycle status, defaulting an absent/unknown status to 'Draft'. */
const normalizeStatus = (value: unknown): ScorerVersionStatus =>
  (SCORER_VERSION_STATUSES as readonly string[]).includes(String(value))
    ? (String(value) as ScorerVersionStatus)
    : 'Draft';

/** Human-readable list of authored versions and their statuses, for error messages. */
const listVersions = (versions: RawVersion[]): string =>
  [...versions]
    .sort((a, b) => toVersionNumber(a.versionNumber) - toVersionNumber(b.versionNumber))
    .map((v) => `${toVersionNumber(v.versionNumber)} (${normalizeStatus(v.status)})`)
    .join(', ');

/**
 * Choose which scorer version to run.
 *
 * No explicit version → the highest-numbered `Available` version if any exists; otherwise the highest-numbered
 * non-`Archived` (i.e. `Draft`) version. A Draft version can be run ad hoc during authoring — that is the whole
 * point of the inner loop — so the default run selects one when nothing has been promoted yet, rather than
 * forcing `--scorer-version`. Only when *every* version is `Archived` (nothing runnable) does this throw.
 * Note: this governs ad-hoc `run` selection only; *activation* (automatic production scoring via an
 * agentAssociation with isActive: true) still requires `Available` and is enforced by the platform, not here.
 * Explicit version → that exact version, unless it is `Archived` (archived versions cannot be run).
 */
function selectScorerVersion(apiName: string, versions: RawVersion[], requested?: number): RawVersion {
  // A malformed/legacy document with no <scorerVersion> block: return an empty version so the caller's
  // engineType guard produces its own clear "no engine" error.
  if (versions.length === 0) return {};

  if (requested != null) {
    const match = versions.find((v) => toVersionNumber(v.versionNumber) === requested);
    if (!match) {
      throw new Error(`Scorer '${apiName}' has no version ${requested}. Authored versions: ${listVersions(versions)}.`);
    }
    if (normalizeStatus(match.status) === 'Archived') {
      throw new Error(
        `Version ${requested} of scorer '${apiName}' is archived and can't be run. ` +
          `Run an Available or Draft version instead. Authored versions: ${listVersions(versions)}.`
      );
    }
    return match;
  }

  // Prefer a released (`Available`) version for a stable default, but fall back to the highest-numbered
  // runnable (non-`Archived`) version so a freshly-scaffolded, Draft-only scorer runs ad hoc without needing
  // an explicit --scorer-version during authoring.
  const runnableDescending = versions
    .filter((v) => normalizeStatus(v.status) !== 'Archived')
    .sort((a, b) => toVersionNumber(b.versionNumber) - toVersionNumber(a.versionNumber));
  if (runnableDescending.length === 0) {
    throw new Error(
      `Scorer '${apiName}' has no runnable version — every authored version is Archived. ` +
        `Author or unarchive a version, or choose one explicitly with --scorer-version. ` +
        `Authored versions: ${listVersions(versions)}.`
    );
  }
  const available = runnableDescending.filter((v) => normalizeStatus(v.status) === 'Available');
  return available[0] ?? runnableDescending[0];
}

/** A version's identity + status, for callers that manage versions (create/promote/archive). */
export type ScorerVersionInfo = {
  versionNumber: number;
  status: ScorerVersionStatus;
  isActive: boolean;
  label?: string;
};

/** List every `<scorerVersion>` in a scorer definition with its number, status, and active flag. */
export function parseScorerVersions(xml: string): ScorerVersionInfo[] {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const root = parser.parse(xml) as { AiAgentScorerDefinition?: RawDefinition };
  const def = root.AiAgentScorerDefinition;
  if (!def) return [];
  return toArray(def.scorerVersion).map((v) => ({
    versionNumber: toVersionNumber(v.versionNumber),
    status: normalizeStatus(v.status),
    isActive: toBool(v.agentAssociation?.isActive),
    label: v.label,
  }));
}

/**
 * Parse an `AiAgentScorerDefinition` metadata XML document back into a typed spec.
 *
 * @param options.scorerVersion When set, run this exact version (see selectScorerVersion for the rules).
 */
export function parseScorerXml(xml: string, apiName: string, options: { scorerVersion?: number } = {}): ScorerSpec {
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
  const root = parser.parse(xml) as { AiAgentScorerDefinition?: RawDefinition };
  const def = root.AiAgentScorerDefinition;
  if (!def) {
    throw new Error(`The metadata for scorer '${apiName}' is not a valid AiAgentScorerDefinition.`);
  }

  const version = selectScorerVersion(apiName, toArray(def.scorerVersion), options.scorerVersion);
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

  // Record which version this spec was resolved from, so callers (e.g. `run`) can report the served version.
  // Skip a malformed/legacy document with no numbered version (toVersionNumber → 0).
  const resolvedVersion = toVersionNumber(version.versionNumber);
  if (resolvedVersion > 0) spec.scorerVersion = resolvedVersion;

  return spec;
}

// --- Prompt template ------------------------------------------------------------------------------------

/** The fixed input set every scorer prompt template declares. Kept identical across template versions. */
function promptTemplateInputs(): Array<{ apiName: string; definition: string; referenceName: string; required: boolean }> {
  // Labels are optional (a scorer may define none), but the inputs are always declared so the template shape is
  // stable; the generated prompt references them only when the scorer actually has predefined labels.
  return [
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
}

/** Base64 sha256 of a template version's content — the part of its identifier the serving layer keys on. */
const contentHash = (content: string): string => createHash('sha256').update(content).digest('base64');

/** Deterministic version identifier for a template version: a content hash suffixed with the version number. */
const templateVersionIdentifier = (content: string, versionNumber: number): string =>
  `${contentHash(content)}_${versionNumber}`;

export function buildPromptTemplateXml(apiName: string, promptContent: string): string {
  const versionIdentifier = templateVersionIdentifier(promptContent, 1);

  const xmlObj = {
    '?xml': XML_DECLARATION,
    GenAiPromptTemplate: {
      '@_xmlns': METADATA_XMLNS,
      activeVersionIdentifier: versionIdentifier,
      developerName: apiName,
      masterLabel: apiName,
      overridable: false,
      templateVersions: {
        content: promptContent,
        inputs: promptTemplateInputs(),
        // default scaffolding; users can override by editing the prompt template after generation
        primaryModel: 'sfdc_ai__DefaultOpenAIGPT4OmniMini',
        status: 'Published',
        versionIdentifier,
      },
      type: SCORER_PROMPT_TEMPLATE_TYPE,
      visibility: 'Global',
    },
  };

  return xmlBuilder().build(xmlObj);
}
