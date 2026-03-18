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
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { expect } from 'chai';
import { TestContext } from '@salesforce/core/testSetup';
import { SfError, SfProject } from '@salesforce/core';
import { applyStringReplacements, type ReplacementConfig } from '../src/stringReplacements';

describe('String Replacements', () => {
  const $$ = new TestContext();
  let sfProject: SfProject;
  const testDir = join('test-replacements');

  beforeEach(async () => {
    $$.inProject(true);
    sfProject = SfProject.getInstance();

    // Create test directory
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch (error) {
      // Ignore if directory doesn't exist
    }
  });

  describe('replaceWithEnv', () => {
    it('should replace string with environment variable value', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      process.env.TEST_REPLACEMENT = 'Beautiful';

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'TEST_REPLACEMENT',
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('Hello Beautiful world');
      expect(result.replacementsMade).to.equal(1);
      expect(result.replacements).to.have.lengthOf(1);
      expect(result.replacements[0].stringReplaced).to.equal('REPLACE_ME');
      expect(result.replacements[0].replacedWith).to.equal('Beautiful');

      delete process.env.TEST_REPLACEMENT;
    });

    it('should replace multiple occurrences of the same string', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'REPLACE_ME and REPLACE_ME again';
      await writeFile(testFile, content);

      process.env.TEST_REPLACEMENT = 'REPLACED';

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'TEST_REPLACEMENT',
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('REPLACED and REPLACED again');
      expect(result.replacementsMade).to.equal(1);

      delete process.env.TEST_REPLACEMENT;
    });

    it('should throw error when environment variable is not set and allowUnsetEnvVariable is false', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'NONEXISTENT_VAR',
          allowUnsetEnvVariable: false,
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      try {
        await applyStringReplacements(testFile, content, sfProject);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('UnsetEnvironmentVariable');
      }
    });

    it('should replace with empty string when allowUnsetEnvVariable is true', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'NONEXISTENT_VAR',
          allowUnsetEnvVariable: true,
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('Hello  world');
      expect(result.replacementsMade).to.equal(1);
    });
  });

  describe('replaceWithFile', () => {
    it('should replace string with file contents', async () => {
      const testFile = join(testDir, 'test.agent');
      const replacementFile = join(testDir, 'replacement.txt');
      const content = 'Hello REPLACE_ME world';
      const replacementContent = 'Beautiful';

      await writeFile(testFile, content);
      await writeFile(replacementFile, replacementContent);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithFile: replacementFile,
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('Hello Beautiful world');
      expect(result.replacementsMade).to.equal(1);
    });

    it('should throw error when replacement file does not exist', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithFile: 'nonexistent.txt',
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      try {
        await applyStringReplacements(testFile, content, sfProject);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('ReplacementFileNotFound');
      }
    });
  });

  describe('regexToReplace', () => {
    it('should replace using regular expression', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = '<apiVersion>55.0</apiVersion>';
      await writeFile(testFile, content);

      process.env.NEW_API_VERSION = '<apiVersion>58.0</apiVersion>';

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          regexToReplace: '<apiVersion>\\d+\\.0</apiVersion>',
          replaceWithEnv: 'NEW_API_VERSION',
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('<apiVersion>58.0</apiVersion>');
      expect(result.replacementsMade).to.equal(1);

      delete process.env.NEW_API_VERSION;
    });
  });

  describe('replaceWhenEnv', () => {
    it('should apply replacement when condition is met', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      process.env.DEPLOY_ENV = 'PROD';
      process.env.REPLACEMENT_VALUE = 'Production';

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'REPLACEMENT_VALUE',
          replaceWhenEnv: [
            {
              env: 'DEPLOY_ENV',
              value: 'PROD',
            },
          ],
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('Hello Production world');
      expect(result.replacementsMade).to.equal(1);

      delete process.env.DEPLOY_ENV;
      delete process.env.REPLACEMENT_VALUE;
    });

    it('should not apply replacement when condition is not met', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      process.env.DEPLOY_ENV = 'DEV';
      process.env.REPLACEMENT_VALUE = 'Development';

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'REPLACEMENT_VALUE',
          replaceWhenEnv: [
            {
              env: 'DEPLOY_ENV',
              value: 'PROD',
            },
          ],
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal('Hello REPLACE_ME world');
      expect(result.replacementsMade).to.equal(0);

      delete process.env.DEPLOY_ENV;
      delete process.env.REPLACEMENT_VALUE;
    });
  });

  describe('glob patterns', () => {
    it('should apply replacements to files matching glob pattern', async () => {
      const file1 = join(testDir, 'file1.agent');
      const file2 = join(testDir, 'file2.agent');
      const content = 'Hello REPLACE_ME world';

      await writeFile(file1, content);
      await writeFile(file2, content);

      process.env.REPLACEMENT_VALUE = 'Beautiful';

      const replacements: ReplacementConfig[] = [
        {
          glob: `${testDir}/*.agent`,
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'REPLACEMENT_VALUE',
        },
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      // Test that both files would be processed
      const result1 = await applyStringReplacements(file1, content, sfProject);
      expect(result1.content).to.equal('Hello Beautiful world');

      const result2 = await applyStringReplacements(file2, content, sfProject);
      expect(result2.content).to.equal('Hello Beautiful world');

      delete process.env.REPLACEMENT_VALUE;
    });
  });

  describe('validation', () => {
    it('should throw error when neither filename nor glob is specified', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          stringToReplace: 'REPLACE_ME',
          replaceWithEnv: 'TEST_VAR',
        } as ReplacementConfig,
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      try {
        await applyStringReplacements(testFile, content, sfProject);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('InvalidReplacementConfig');
      }
    });

    it('should throw error when neither stringToReplace nor regexToReplace is specified', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          replaceWithEnv: 'TEST_VAR',
        } as ReplacementConfig,
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      try {
        await applyStringReplacements(testFile, content, sfProject);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('InvalidReplacementConfig');
      }
    });

    it('should throw error when neither replaceWithEnv nor replaceWithFile is specified', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello REPLACE_ME world';
      await writeFile(testFile, content);

      const replacements: ReplacementConfig[] = [
        {
          filename: testFile,
          stringToReplace: 'REPLACE_ME',
        } as ReplacementConfig,
      ];

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: (key: string) => (key === 'replacements' ? replacements : undefined),
      } as never);

      try {
        await applyStringReplacements(testFile, content, sfProject);
        expect.fail('Should have thrown an error');
      } catch (error) {
        expect(error).to.be.instanceOf(SfError);
        expect((error as SfError).name).to.equal('InvalidReplacementConfig');
      }
    });
  });

  describe('no replacements configured', () => {
    it('should return original content when no replacements are configured', async () => {
      const testFile = join(testDir, 'test.agent');
      const content = 'Hello world';
      await writeFile(testFile, content);

      $$.SANDBOX.stub(sfProject, 'getPath').returns(process.cwd());
      $$.SANDBOX.stub(sfProject, 'getSfProjectJson').returns({
        get: () => undefined,
      } as never);

      const result = await applyStringReplacements(testFile, content, sfProject);

      expect(result.content).to.equal(content);
      expect(result.replacementsMade).to.equal(0);
      expect(result.replacements).to.have.lengthOf(0);
    });
  });
});
