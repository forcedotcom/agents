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

/* eslint-disable camelcase */

import { expect } from 'chai';
import { formatResults, type EvalApiResponse } from '../src/evalFormatter';

const MOCK_RESPONSE: EvalApiResponse = {
  results: [
    {
      id: 'test-1',
      outputs: [
        { type: 'agent.create_session', id: 'session', session_id: 'sess-123' },
        { type: 'agent.send_message', id: 'msg1', response: 'Hello, how can I help?' },
      ],
      evaluation_results: [
        {
          id: 'check-topic',
          score: null,
          is_pass: true,
          actual_value: 'General_Inquiry',
          expected_value: 'General_Inquiry',
        },
        {
          id: 'check-response',
          score: 0.95,
          is_pass: true,
          actual_value: 'Hello, how can I help?',
          expected_value: 'Hello',
        },
        { id: 'check-fail', score: 0.2, is_pass: false, actual_value: 'wrong', expected_value: 'right' },
      ],
      errors: [],
    },
  ],
};

const MOCK_WITH_ERRORS: EvalApiResponse = {
  results: [
    {
      id: 'test-errors',
      outputs: [],
      evaluation_results: [{ id: 'eval-1', error_message: 'Something went wrong' }],
      errors: [{ id: 'step-1', error_message: 'Agent session failed' }],
    },
  ],
};

describe('evalFormatter', () => {
  describe('human format', () => {
    it('should include test ID and evaluation table', () => {
      const output = formatResults(MOCK_RESPONSE, 'human');
      expect(output).to.include('# Agent Evaluation Results');
      expect(output).to.include('## Test: test-1');
      expect(output).to.include('### Evaluation Results');
      expect(output).to.include('check-topic');
      expect(output).to.include('PASS');
      expect(output).to.include('FAIL');
    });

    it('should show agent interaction outputs', () => {
      const output = formatResults(MOCK_RESPONSE, 'human');
      expect(output).to.include('**Create Session**: sess-123');
      expect(output).to.include('**Agent Response**');
      expect(output).to.include('Hello, how can I help?');
    });

    it('should show summary counts', () => {
      const output = formatResults(MOCK_RESPONSE, 'human');
      expect(output).to.include('**Summary**: 3 evaluations');
      expect(output).to.include('Passed: 2, Failed: 1');
    });

    it('should show errors when present', () => {
      const output = formatResults(MOCK_WITH_ERRORS, 'human');
      expect(output).to.include('### Errors');
      expect(output).to.include('Agent session failed');
    });
  });

  describe('json format', () => {
    it('should return valid JSON', () => {
      const output = formatResults(MOCK_RESPONSE, 'json');
      const parsed = JSON.parse(output) as EvalApiResponse;
      expect(parsed).to.have.property('results');
      expect(parsed.results).to.have.length(1);
    });
  });

  describe('junit format', () => {
    it('should produce valid JUnit XML', () => {
      const output = formatResults(MOCK_RESPONSE, 'junit');
      expect(output).to.include('<?xml version="1.0"');
      expect(output).to.include('<testsuites>');
      expect(output).to.include('<testsuite name="agent-eval-labs"');
      expect(output).to.include('tests="3"');
      expect(output).to.include('failures="1"');
    });

    it('should include failure elements for failed tests', () => {
      const output = formatResults(MOCK_RESPONSE, 'junit');
      expect(output).to.include('<failure');
      expect(output).to.include('test-1.check-fail');
    });

    it('should include error elements for errored tests', () => {
      const output = formatResults(MOCK_WITH_ERRORS, 'junit');
      expect(output).to.include('<error');
      expect(output).to.include('Something went wrong');
    });
  });

  describe('tap format', () => {
    it('should produce valid TAP output', () => {
      const output = formatResults(MOCK_RESPONSE, 'tap');
      expect(output).to.include('TAP version 13');
      expect(output).to.include('1..3');
      expect(output).to.include('ok 1 - test-1.check-topic');
      expect(output).to.include('ok 2 - test-1.check-response');
      expect(output).to.include('not ok 3 - test-1.check-fail');
    });

    it('should include YAML diagnostic for failures', () => {
      const output = formatResults(MOCK_RESPONSE, 'tap');
      expect(output).to.include('  ---');
      expect(output).to.include('  expected: "right"');
      expect(output).to.include('  actual: "wrong"');
      expect(output).to.include('  ...');
    });
  });

  describe('empty results', () => {
    it('should handle empty results gracefully', () => {
      const output = formatResults({ results: [] }, 'human');
      expect(output).to.include('# Agent Evaluation Results');
    });

    it('should handle undefined results gracefully', () => {
      const output = formatResults({}, 'human');
      expect(output).to.include('# Agent Evaluation Results');
    });
  });
});
