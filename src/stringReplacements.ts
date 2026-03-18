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

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { glob } from 'glob';
import { SfError, SfProject } from '@salesforce/core';

/**
 * Configuration for a single string replacement operation
 */
export type ReplacementConfig = {
  // Location of files
  filename?: string;
  glob?: string;

  // String to be replaced
  stringToReplace?: string;
  regexToReplace?: string;

  // Replacement value
  replaceWithEnv?: string;
  replaceWithFile?: string;

  // Conditional processing
  replaceWhenEnv?: Array<{
    env: string;
    value: string;
  }>;

  // Optional flags
  allowUnsetEnvVariable?: boolean;
};

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
 * Validates that a replacement configuration has required fields
 */
function validateReplacementConfig(config: ReplacementConfig): void {
  // Must have either filename or glob
  if (!config.filename && !config.glob) {
    throw SfError.create({
      name: 'InvalidReplacementConfig',
      message: 'Each replacement must specify either "filename" or "glob"',
    });
  }

  // Must have either stringToReplace or regexToReplace
  if (!config.stringToReplace && !config.regexToReplace) {
    throw SfError.create({
      name: 'InvalidReplacementConfig',
      message: 'Each replacement must specify either "stringToReplace" or "regexToReplace"',
    });
  }

  // Must have either replaceWithEnv or replaceWithFile
  if (!config.replaceWithEnv && !config.replaceWithFile) {
    throw SfError.create({
      name: 'InvalidReplacementConfig',
      message: 'Each replacement must specify either "replaceWithEnv" or "replaceWithFile"',
    });
  }
}

/**
 * Checks if conditional replacement should be applied based on environment variables
 */
function shouldApplyReplacement(config: ReplacementConfig): boolean {
  if (!config.replaceWhenEnv || config.replaceWhenEnv.length === 0) {
    return true;
  }

  // All conditions must be met
  return config.replaceWhenEnv.every((condition) => {
    const envValue = process.env[condition.env];
    return envValue === condition.value;
  });
}

/**
 * Gets the replacement value from environment variable or file
 */
async function getReplacementValue(config: ReplacementConfig, projectPath: string): Promise<string> {
  if (config.replaceWithEnv) {
    const envValue = process.env[config.replaceWithEnv];

    if (envValue === undefined) {
      if (config.allowUnsetEnvVariable) {
        // Replace with empty string (remove the matched string)
        return '';
      } else {
        throw SfError.create({
          name: 'UnsetEnvironmentVariable',
          message: `Environment variable "${config.replaceWithEnv}" is not set. Set the variable or use "allowUnsetEnvVariable": true to replace with empty string.`,
        });
      }
    }

    return envValue;
  }

  if (config.replaceWithFile) {
    const filePath = resolve(projectPath, config.replaceWithFile);

    if (!existsSync(filePath)) {
      throw SfError.create({
        name: 'ReplacementFileNotFound',
        message: `Replacement file not found: ${filePath}`,
      });
    }

    return (await readFile(filePath, 'utf-8')).trim();
  }

  throw SfError.create({
    name: 'InvalidReplacementConfig',
    message: 'No replacement value specified',
  });
}

/**
 * Applies string replacements to content
 */
function applyReplacementToContent(
  content: string,
  config: ReplacementConfig,
  replacementValue: string
): { content: string; count: number; pattern: string } {
  let newContent: string;
  let count = 0;
  let pattern: string;

  if (config.stringToReplace) {
    pattern = config.stringToReplace;
    // Count occurrences
    const regex = new RegExp(escapeRegExp(config.stringToReplace), 'g');
    const matches = content.match(regex);
    count = matches ? matches.length : 0;

    // Replace all occurrences
    newContent = content.split(config.stringToReplace).join(replacementValue);
  } else if (config.regexToReplace) {
    pattern = config.regexToReplace;
    const regex = new RegExp(config.regexToReplace, 'g');

    // Count matches
    const matches = content.match(regex);
    count = matches ? matches.length : 0;

    // Replace using regex
    newContent = content.replace(regex, replacementValue);
  } else {
    throw SfError.create({
      name: 'InvalidReplacementConfig',
      message: 'No string or regex pattern specified',
    });
  }

  return { content: newContent, count, pattern };
}

/**
 * Escapes special regex characters in a string
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Gets the list of files to process based on filename or glob pattern
 */
async function getFilesToProcess(config: ReplacementConfig, projectPath: string): Promise<string[]> {
  if (config.filename) {
    const filePath = resolve(projectPath, config.filename);
    if (!existsSync(filePath)) {
      throw SfError.create({
        name: 'FileNotFound',
        message: `File not found: ${filePath}`,
      });
    }
    return [filePath];
  }

  if (config.glob) {
    // Use glob pattern relative to project path
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const files = await glob(config.glob, {
      cwd: projectPath,
      absolute: true,
      nodir: true,
    });

    if (files.length === 0) {
      throw SfError.create({
        name: 'NoFilesMatched',
        message: `No files matched glob pattern: ${config.glob}`,
      });
    }

    return files;
  }

  return [];
}

/**
 * Applies string replacements to a specific file's content
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
  const replacements = projectJson.get('replacements') as ReplacementConfig[] | undefined;

  if (!replacements || replacements.length === 0) {
    return {
      content,
      replacementsMade: 0,
      replacements: [],
    };
  }

  const projectPath = project.getPath();
  const normalizedFilePath = resolve(filePath);
  let modifiedContent = content;
  const appliedReplacements: Array<{
    file: string;
    stringReplaced: string;
    replacedWith: string;
  }> = [];

  for (const config of replacements) {
    // Validate configuration
    validateReplacementConfig(config);

    // Check if this replacement applies to the current file
    // eslint-disable-next-line no-await-in-loop
    const filesToProcess = await getFilesToProcess(config, projectPath);
    const shouldProcessFile = filesToProcess.some((f) => resolve(f) === normalizedFilePath);

    if (!shouldProcessFile) {
      continue;
    }

    // Check conditional replacements
    if (!shouldApplyReplacement(config)) {
      continue;
    }

    // Get replacement value
    // eslint-disable-next-line no-await-in-loop
    const replacementValue = await getReplacementValue(config, projectPath);

    // Apply replacement
    const result = applyReplacementToContent(modifiedContent, config, replacementValue);
    modifiedContent = result.content;

    if (result.count > 0) {
      appliedReplacements.push({
        file: filePath,
        stringReplaced: result.pattern,
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
