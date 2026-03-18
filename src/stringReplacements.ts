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

import { SfProject, SfError } from '@salesforce/core';
// Use SDR's ReplacementConfig type to ensure compatibility with sfdx-project.json schema
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - importing type from internal SDR path for compatibility
import type { ReplacementConfig } from '@salesforce/source-deploy-retrieve/lib/src/convert/types';
// Import helper functions from SDR that handle the replacement logic
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore - importing from internal SDR path
import {
  matchesFile,
  envFilter,
  getContentsOfReplacementFile,
  stringToRegex,
} from '@salesforce/source-deploy-retrieve/lib/src/convert/replacements';

// Re-export ReplacementConfig from SDR for convenience
export type { ReplacementConfig };

/**
 * Result of applying string replacements to content
 */
export type ReplacementResult = {
  content: string;
  replacementsMade: number;
  replacements: Array<{
    file: string;
    stringReplaced: string;
    replacedWith: string;
  }>;
};

/**
 * Applies string replacements to a specific file's content
 *
 * This uses SDR's replacement configuration format and helper functions
 * to maintain compatibility with the standard sfdx-project.json replacement schema.
 *
 * @param filePath - The file to check for replacements
 * @param content - The content of the file
 * @param project - The SfProject instance
 * @returns The modified content and replacement details
 */
export async function applyStringReplacements(
  filePath: string,
  content: string,
  project: SfProject
): Promise<ReplacementResult> {
  const projectJson = project.getSfProjectJson();
  const replacementConfigs = projectJson.get('replacements') as ReplacementConfig[] | undefined;

  if (!replacementConfigs || replacementConfigs.length === 0) {
    return {
      content,
      replacementsMade: 0,
      replacements: [],
    };
  }

  let modifiedContent = content;
  const appliedReplacements: Array<{
    file: string;
    stringReplaced: string;
    replacedWith: string;
  }> = [];

  // Normalize file path to use forward slashes for cross-platform compatibility
  // Glob patterns always use forward slashes, even on Windows
  // Windows paths like C:\path\to\file.txt become C:/path/to/file.txt
  const normalizedFilePath = filePath.replace(/\\/g, '/');

  // Filter replacements using SDR's envFilter to check environment conditionals
  // eslint-disable-next-line @typescript-eslint/no-unsafe-call
  const envFilteredReplacements = replacementConfigs.filter(envFilter as (r: ReplacementConfig) => boolean);

  // eslint-disable-next-line no-await-in-loop -- replacements must be applied sequentially
  for (const config of envFilteredReplacements) {
    // Normalize config paths for cross-platform matching
    // Create a normalized version of the config for matching (don't mutate original)
    const normalizedConfig = { ...config };
    if (normalizedConfig.filename) {
      normalizedConfig.filename = normalizedConfig.filename.replace(/\\/g, '/');
    }
    if (normalizedConfig.glob) {
      normalizedConfig.glob = normalizedConfig.glob.replace(/\\/g, '/');
    }

    // Use SDR's matchesFile function to check if this replacement applies to the current file
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const fileMatchesFn = matchesFile(normalizedFilePath) as (r: ReplacementConfig) => boolean;
    const fileMatches = fileMatchesFn(normalizedConfig);

    if (!fileMatches) {
      continue;
    }

    // Get replacement value
    let replacementValue: string;
    if (config.replaceWithEnv) {
      const envValue = process.env[config.replaceWithEnv];
      if (envValue === undefined) {
        if (config.allowUnsetEnvVariable) {
          replacementValue = '';
        } else {
          throw SfError.create({
            name: 'UnsetEnvironmentVariable',
            message: `Environment variable "${config.replaceWithEnv}" is not set. Set the variable or use "allowUnsetEnvVariable": true to replace with empty string.`,
          });
        }
      } else {
        replacementValue = envValue;
      }
    } else if (config.replaceWithFile) {
      // Use SDR's getContentsOfReplacementFile to read the file
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, no-await-in-loop
      replacementValue = await getContentsOfReplacementFile(config.replaceWithFile);
    } else {
      continue;
    }

    // Build regex for replacement
    let regex: RegExp;
    let patternStr: string;

    if (config.stringToReplace) {
      patternStr = config.stringToReplace;
      // Use SDR's stringToRegex to properly escape the string
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call
      regex = stringToRegex(config.stringToReplace);
    } else if (config.regexToReplace) {
      patternStr = config.regexToReplace;
      regex = new RegExp(config.regexToReplace, 'g');
    } else {
      continue;
    }

    // Count occurrences before replacement
    const matches = modifiedContent.match(regex);
    if (matches && matches.length > 0) {
      // Apply replacement
      modifiedContent = modifiedContent.replace(regex, replacementValue);

      appliedReplacements.push({
        file: filePath,
        stringReplaced: patternStr,
        replacedWith: replacementValue,
      });
    }
  }

  return {
    content: modifiedContent,
    replacementsMade: appliedReplacements.length,
    replacements: appliedReplacements,
  };
}

/**
 * Applies string replacements configured in sfdx-project.json to agent file content
 * This follows the same pattern as the Salesforce CLI for source deployment
 *
 * @param agentFilePath - Path to the .agent file
 * @param agentContent - The original agent file content
 * @param project - The SfProject instance
 * @returns Object containing modified content and details about replacements made
 */
export async function applyStringReplacementsToAgent(
  agentFilePath: string,
  agentContent: string,
  project: SfProject
): Promise<ReplacementResult> {
  return applyStringReplacements(agentFilePath, agentContent, project);
}
