/*
 * Copyright 2025, Salesforce, Inc.
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
import { expect } from 'chai';
import { convertTestResultsToFormat, humanFriendlyName } from '../src/agentTestResults';
import type { AgentTestResultsResponse } from '../src/types';

describe('junit formatter', () => {
  it('should transform test results to JUnit format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results/4.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'junit');
    expect(output).to.equal(`<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Guest_Experience_Agent" tests="3" failures="1" time="30000">
  <property name="status" value="COMPLETED"></property>
  <property name="start-time" value="2025-01-07T12:00:00Z"></property>
  <property name="end-time" value="2025-01-07T12:00:10.35Z"></property>
  <testsuite name="1" time="10000" assertions="3"></testsuite>
  <testsuite name="2" time="10000" assertions="3"></testsuite>
  <testsuite name="3" time="10000" assertions="3">
    <failure message="An Apex error occurred: System.CalloutException: Bad Response: System.HttpResponse[Status=Not Found, StatusCode=404]" name="bot_response_rating"></failure>
  </testsuite>
</testsuites>`);
  });
});

describe('tap formatter', () => {
  it('should transform test results to TAP format', async () => {
    const raw = await readFile('./test/mocks/einstein_ai-evaluations_runs_4KBSM000000003F4AQ_results/4.json', 'utf8');
    const input = JSON.parse(raw) as AgentTestResultsResponse;
    const output = await convertTestResultsToFormat(input, 'tap');
    expect(output).to.equal(`Tap Version 14
1..9
ok 1 1.topic_sequence_match
ok 2 1.action_sequence_match
ok 3 1.bot_response_rating
ok 4 2.topic_sequence_match
ok 5 2.action_sequence_match
ok 6 2.bot_response_rating
ok 7 3.topic_sequence_match
ok 8 3.action_sequence_match
not ok 9 3.bot_response_rating
  ---
  message: An Apex error occurred: System.CalloutException: Bad Response: System.HttpResponse[Status=Not Found, StatusCode=404]
  expectation: bot_response_rating
  actual: It looks like I am unable to check the weather. There's something wrong with the Weather Service. How else can I assist you?
  expected: The answer should start by describing expected conditions, for example "clear skies" or "50% chance of rain" and conclude with a range of high and low temperatures in degrees fahrenheit.
  ...`);
  });
});

describe('humanFriendlyName', () => {
  it('handles current api responses', () => {
    expect(humanFriendlyName('bot_response_rating')).to.equal('Outcome');
    expect(humanFriendlyName('action_sequence_match')).to.equal('Action');
    expect(humanFriendlyName('topic_sequence_match')).to.equal('Topic');
    // an unknown value will return itself
    expect(humanFriendlyName('unknown_sequence_match')).to.equal('unknown_sequence_match');

    // it will handle the upcoming api changes
    expect(humanFriendlyName('output_validation')).to.equal('Outcome');
    expect(humanFriendlyName('actions_assertion')).to.equal('Action');
    expect(humanFriendlyName('topic_assertion')).to.equal('Topic');
    // it will handle new metrics
    expect(humanFriendlyName('output_latency_milliseconds')).to.equal('Output Latency');
    expect(humanFriendlyName('instruction_following')).to.equal('Instruction Following');
  });
});
