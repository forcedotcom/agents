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
import { expect } from 'chai';
import { escapeSoqlString } from '../src/soqlEscape';
import { HOSTILE_VALUES, expectOnlyLiteral, lexSoql } from './soqlLiterals';

describe('escapeSoqlString', () => {
  it('leaves text without quotes or backslashes unchanged', () => {
    for (const value of ['', 'My_Agent', 'user@example.com', '100%_done', 'ünïcödé', 'line1\nline2']) {
      expect(escapeSoqlString(value)).to.equal(value);
    }
  });

  it('escapes a single quote with a backslash', () => {
    expect(escapeSoqlString("O'Malley")).to.equal("O\\'Malley");
  });

  it('escapes a backslash with a backslash', () => {
    expect(escapeSoqlString('a\\b')).to.equal('a\\\\b');
  });

  it('escapes a backslash that meets a quote, so it cannot cancel the escape added for the quote', () => {
    expect(escapeSoqlString("\\'")).to.equal("\\\\\\'");
  });

  it('does not double the quote, which is the ANSI SQL form and not a SOQL escape', () => {
    expect(escapeSoqlString("a'b")).to.not.include("''");
  });

  describe('as SOQL reads the result', () => {
    for (const value of HOSTILE_VALUES) {
      it(`keeps ${JSON.stringify(value)} inside one string literal and reads it back unchanged`, () => {
        expectOnlyLiteral(`SELECT Id FROM BotDefinition WHERE DeveloperName = '${escapeSoqlString(value)}'`, value);
      });
    }

    it('shows why doubling the quote does not work: SOQL reads it as two literals', () => {
      expect(lexSoql("'it''s'").literals).to.deep.equal(['it', 's']);
    });

    it('rejects a backslash that is not part of a valid escape', () => {
      expect(lexSoql("'a\\qb'").error).to.match(/invalid escape sequence/);
    });
  });
});
