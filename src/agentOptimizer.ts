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

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Connection, SfError, SfProject } from '@salesforce/core';
import { findAuthoringBundle } from './utils';
import { Agent, type AgentInstance } from './agent';
import { ScriptAgent } from './agents/scriptAgent';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LLMProvider = {
  complete(prompt: string): Promise<string>;
};

export type TestUtterance = {
  utterance: string;
  expectedTopic?: string;
  expectedActions?: string[];
  expectedResponse?: string;
};

export type OptimizeConfig = {
  maxIterations: number;
  targetMetric: string;
};

export type OptimizeIteration = {
  iteration: number;
  mutationType: string;
  baselineScore: number;
  candidateScore: number;
  decision: 'KEEP' | 'REJECT';
  description: string;
};

export type OptimizeResult = {
  agentName: string;
  baselineScore: number;
  bestScore: number;
  iterations: OptimizeIteration[];
  totalDurationMs: number;
};

// ---------------------------------------------------------------------------
// Agent file helpers
// ---------------------------------------------------------------------------

type InstructionBlock = {
  subagentName: string;
  instructionStart: number;
  instructionEnd: number;
  text: string;
};

function extractInstructionBlocks(agentSource: string): InstructionBlock[] {
  const blocks: InstructionBlock[] = [];
  const lines = agentSource.split('\n');

  let currentSubagent: string | undefined;
  let inInstructions = false;
  let instructionIndent = 0;
  let instructionLines: string[] = [];
  let instructionStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Detect subagent / start_agent blocks
    if (trimmed.startsWith('start_agent') || trimmed.startsWith('subagent ')) {
      const nameMatch = trimmed.match(/(?:subagent\s+)(\w+)/);
      currentSubagent = nameMatch ? nameMatch[1] : 'start_agent';
    }

    // Detect instructions: block (inside reasoning:)
    if (trimmed.startsWith('instructions:') && currentSubagent) {
      inInstructions = true;
      instructionIndent = indent;
      instructionLines = [];
      instructionStartLine = i;

      // Handle inline: `instructions: |`
      const afterColon = trimmed.slice('instructions:'.length).trim();
      if (afterColon === '|' || afterColon === '|-' || afterColon === '>') {
        // Block scalar — content starts on next line
        continue;
      }
      if (afterColon.length > 0) {
        // Inline single-line instructions
        instructionLines.push(afterColon);
        blocks.push({
          subagentName: currentSubagent,
          instructionStart: instructionStartLine,
          instructionEnd: i,
          text: afterColon,
        });
        inInstructions = false;
      }
      continue;
    }

    if (inInstructions) {
      // Block scalar content: lines indented deeper than the key
      if (trimmed.length === 0 || indent > instructionIndent) {
        instructionLines.push(line);
      } else {
        // Dedent means end of block
        blocks.push({
          subagentName: currentSubagent!,
          instructionStart: instructionStartLine,
          instructionEnd: i - 1,
          text: instructionLines.join('\n'),
        });
        inInstructions = false;
      }
    }
  }

  // Close any trailing block
  if (inInstructions && currentSubagent) {
    blocks.push({
      subagentName: currentSubagent,
      instructionStart: instructionStartLine,
      instructionEnd: lines.length - 1,
      text: instructionLines.join('\n'),
    });
  }

  return blocks;
}

function applyInstructionMutation(
  agentSource: string,
  block: InstructionBlock,
  newInstructions: string
): string {
  const lines = agentSource.split('\n');

  // Determine indentation from the original block
  const keyLine = lines[block.instructionStart];
  const keyIndent = keyLine.length - keyLine.trimStart().length;
  const contentIndent = ' '.repeat(keyIndent + 2);

  // Rebuild the instruction block
  const newLines = newInstructions
    .split('\n')
    .map((l) => `${contentIndent}${l.trim()}`)
    .filter((l) => l.trim().length > 0);

  const replacement = [
    `${' '.repeat(keyIndent)}instructions: |`,
    ...newLines,
  ];

  const result = [
    ...lines.slice(0, block.instructionStart),
    ...replacement,
    ...lines.slice(block.instructionEnd + 1),
  ];

  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function scoreResponse(
  response: string,
  utterance: TestUtterance,
  topic?: string,
  actions?: string[]
): number {
  let score = 0;
  let checks = 0;

  // Topic accuracy
  if (utterance.expectedTopic) {
    checks++;
    if (topic?.toLowerCase().includes(utterance.expectedTopic.toLowerCase())) {
      score++;
    }
  }

  // Action invocation
  if (utterance.expectedActions?.length) {
    checks++;
    const expectedSet = new Set(utterance.expectedActions.map((a) => a.toLowerCase()));
    const actualSet = new Set((actions ?? []).map((a) => a.toLowerCase()));
    const intersection = [...expectedSet].filter((a) => actualSet.has(a));
    score += intersection.length / expectedSet.size;
  }

  // Response content match
  if (utterance.expectedResponse) {
    checks++;
    const expected = utterance.expectedResponse.toLowerCase();
    const actual = response.toLowerCase();
    if (actual.includes(expected)) {
      score++;
    } else {
      // Partial credit: word overlap
      const expectedWords = new Set(expected.split(/\s+/));
      const actualWords = new Set(actual.split(/\s+/));
      const overlap = [...expectedWords].filter((w) => actualWords.has(w));
      score += overlap.length / expectedWords.size * 0.5;
    }
  }

  // Default: non-empty response gets some credit
  if (checks === 0) {
    return response.trim().length > 0 ? 0.5 : 0;
  }

  return score / checks;
}

// ---------------------------------------------------------------------------
// Mutation prompt
// ---------------------------------------------------------------------------

function buildMutationPrompt(
  subagentName: string,
  currentInstructions: string,
  testResults: Array<{ utterance: string; response: string; score: number }>
): string {
  const failingCases = testResults
    .filter((r) => r.score < 0.8)
    .map((r) => `  Utterance: "${r.utterance}"\n  Response: "${r.response}"\n  Score: ${r.score.toFixed(2)}`)
    .join('\n\n');

  return `You are optimizing a Salesforce Agentforce agent subagent called "${subagentName}".

Current instructions:
${currentInstructions}

The following test cases scored poorly:
${failingCases || '(all test cases passed)'}

Rewrite the instructions to improve performance on the failing test cases while maintaining good performance on passing cases. The instructions should be clear, specific, and actionable for the agent.

Return ONLY the improved instructions text, nothing else. Do not include any markdown formatting, code blocks, or explanation.`;
}

// ---------------------------------------------------------------------------
// Org-native Einstein LLM provider
// ---------------------------------------------------------------------------

type PromptGenerationResponse = {
  generations: Array<{ text: string; responseId: string }>;
};

export class EinsteinLlmProvider implements LLMProvider {
  private readonly connection: Connection;
  private readonly templateName: string;

  public constructor(connection: Connection, templateName = 'AgentOptimizer') {
    this.connection = connection;
    this.templateName = templateName;
  }

  public async complete(prompt: string): Promise<string> {
    const body = {
      isPreview: false,
      inputParams: {
        valueMap: {
          'Input:prompt_text': {
            value: prompt,
          },
        },
      },
      additionalConfig: {
        applicationName: 'PromptTemplateGenerationsInvocable',
        maxTokens: 4096,
        temperature: 0,
      },
    };

    const url = `/services/data/v${this.connection.version}/einstein/prompt-templates/${this.templateName}/generations`;

    const resp = await this.connection.request<PromptGenerationResponse>({
      method: 'POST',
      url,
      body: JSON.stringify(body),
    });

    if (!resp.generations?.length) {
      throw new SfError('Einstein LLM returned empty response');
    }
    return resp.generations[0].text;
  }
}

// ---------------------------------------------------------------------------
// AgentOptimizer
// ---------------------------------------------------------------------------

export class AgentOptimizer {
  private readonly connection: Connection;
  private readonly project: SfProject;
  private readonly llm: LLMProvider;
  private readonly onProgress?: (msg: string) => void;

  public constructor(options: {
    connection: Connection;
    project: SfProject;
    llm: LLMProvider;
    onProgress?: (msg: string) => void;
  }) {
    this.connection = options.connection;
    this.project = options.project;
    this.llm = options.llm;
    this.onProgress = options.onProgress;
  }

  public async run(
    bundleName: string,
    utterances: TestUtterance[],
    config: OptimizeConfig
  ): Promise<OptimizeResult> {
    const startTime = Date.now();
    const iterations: OptimizeIteration[] = [];

    this.progress(`Locating authoring bundle: ${bundleName}`);

    // Find the .agent file
    const packageDirs = this.project.getPackageDirectories().map((d) => d.fullPath);
    const bundleDir = findAuthoringBundle(packageDirs, bundleName);
    if (!bundleDir) {
      throw new SfError(
        `Authoring bundle "${bundleName}" not found in project package directories.`,
        'BundleNotFound'
      );
    }
    const agentFilePath = join(bundleDir, `${bundleName}.agent`);

    // Read original agent source (preserve for rollback)
    const originalSource = await readFile(agentFilePath, 'utf-8');

    this.progress('Running baseline evaluation...');
    const baselineScore = await this.evaluate(bundleName, utterances);
    this.progress(`Baseline score: ${(baselineScore * 100).toFixed(1)}%`);

    let bestScore = baselineScore;
    let currentSource = originalSource;

    for (let i = 1; i <= config.maxIterations; i++) {
      this.progress(`\nIteration ${i}/${config.maxIterations}`);

      // Extract instruction blocks from current source
      const blocks = extractInstructionBlocks(currentSource);
      if (blocks.length === 0) {
        this.progress('No instruction blocks found in agent file. Stopping.');
        break;
      }

      // Pick the block to mutate (round-robin across subagents)
      const targetBlock = blocks[(i - 1) % blocks.length];
      this.progress(`Mutating: ${targetBlock.subagentName}`);

      // Collect per-utterance scores for mutation context
      const testResults = await this.evaluateDetailed(bundleName, utterances);

      // Ask LLM for improved instructions
      const mutationPrompt = buildMutationPrompt(
        targetBlock.subagentName,
        targetBlock.text,
        testResults
      );
      const newInstructions = await this.llm.complete(mutationPrompt);

      // Apply mutation
      const mutatedSource = applyInstructionMutation(currentSource, targetBlock, newInstructions);
      await writeFile(agentFilePath, mutatedSource, 'utf-8');

      // Evaluate mutated agent
      let candidateScore: number;
      try {
        candidateScore = await this.evaluate(bundleName, utterances);
      } catch (error) {
        // Mutation broke compilation — reject and rollback
        this.progress(`Mutation failed evaluation: ${(error as Error).message}`);
        await writeFile(agentFilePath, currentSource, 'utf-8');
        iterations.push({
          iteration: i,
          mutationType: 'prompt_refine',
          baselineScore: bestScore,
          candidateScore: 0,
          decision: 'REJECT',
          description: `${targetBlock.subagentName}: compilation/eval error`,
        });
        continue;
      }

      // KEEP / REJECT
      const decision = candidateScore > bestScore ? 'KEEP' : 'REJECT';
      this.progress(
        `Score: ${(candidateScore * 100).toFixed(1)}% (was ${(bestScore * 100).toFixed(1)}%) → ${decision}`
      );

      iterations.push({
        iteration: i,
        mutationType: 'prompt_refine',
        baselineScore: bestScore,
        candidateScore,
        decision,
        description: `${targetBlock.subagentName}: ${decision === 'KEEP' ? 'improved' : 'no improvement'}`,
      });

      if (decision === 'KEEP') {
        bestScore = candidateScore;
        currentSource = mutatedSource;
      } else {
        await writeFile(agentFilePath, currentSource, 'utf-8');
      }
    }

    // Ensure we leave the file in the best state
    await writeFile(agentFilePath, currentSource, 'utf-8');

    return {
      agentName: bundleName,
      baselineScore,
      bestScore,
      iterations,
      totalDurationMs: Date.now() - startTime,
    };
  }

  private async evaluate(
    bundleName: string,
    utterances: TestUtterance[]
  ): Promise<number> {
    const results = await this.evaluateDetailed(bundleName, utterances);
    if (results.length === 0) return 0;
    return results.reduce((sum, r) => sum + r.score, 0) / results.length;
  }

  private async evaluateDetailed(
    bundleName: string,
    utterances: TestUtterance[]
  ): Promise<Array<{ utterance: string; response: string; score: number }>> {
    let agent: AgentInstance;
    try {
      agent = await Agent.init({
        connection: this.connection,
        project: this.project,
        aabName: bundleName,
      });
    } catch (error) {
      throw new SfError(
        `Failed to initialize agent "${bundleName}": ${(error as Error).message}`,
        'AgentInitFailed'
      );
    }

    if (agent instanceof ScriptAgent) {
      agent.preview.setMockMode('Mock');
    }

    await agent.preview.start({});
    const results: Array<{ utterance: string; response: string; score: number }> = [];

    for (const utt of utterances) {
      try {
        const response = await agent.preview.send(utt.utterance);
        const responseText = response.messages
          ?.filter((m) => m.type === 'Inform')
          .map((m) => m.message)
          .join(' ') ?? '';

        const score = scoreResponse(responseText, utt);
        results.push({ utterance: utt.utterance, response: responseText, score });
      } catch {
        results.push({ utterance: utt.utterance, response: '', score: 0 });
      }
    }

    try {
      await agent.preview.end();
    } catch {
      // Best-effort cleanup
    }

    return results;
  }

  private progress(msg: string): void {
    this.onProgress?.(msg);
  }
}
