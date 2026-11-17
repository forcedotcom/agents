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

/**
 * Registry of scorer engines, keyed by engineType.
 *
 * Built-in engines register themselves here at import time. Only `PromptTemplate` is implemented today; other
 * engine types (e.g. `Manual`) have no engine, so runScorer throws for them until one is added.
 */
import { type ScorerEngineType, type ScorerEngine } from '../types';
import { promptTemplateEngine } from './promptTemplateEngine';

const engines = new Map<ScorerEngineType, ScorerEngine>();

/** Register (or override) the engine for an engineType. */
export function registerEngine(engine: ScorerEngine): void {
  engines.set(engine.engineType, engine);
}

/** The engine for an engineType, or undefined if none is implemented. */
export function getEngine(engineType: ScorerEngineType): ScorerEngine | undefined {
  return engines.get(engineType);
}

/** The engine types that currently have an implementation. */
export function supportedEngineTypes(): ScorerEngineType[] {
  return [...engines.keys()];
}

// Built-in engines.
registerEngine(promptTemplateEngine);
