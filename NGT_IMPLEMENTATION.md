# NGT (Next Generation Testing) Implementation

## Overview

This document describes the implementation of NGT (Next Generation Testing) support in the `@salesforce/agents` library. NGT introduces new test runner endpoints and metadata types for Agentforce testing.

## What's New

### New Classes

#### `AgentTesterNGT`

A new test runner class that uses the NGT endpoints (`/einstein/ai-testing/runs`). This class mirrors the API of the existing `AgentTester` class but works with the new `AiTestSuiteDefinition` metadata type.

**Methods:**

- `start(testDefinitionName: string)` - Start a test run
- `status(runId: string)` - Get the status of a test run
- `poll(runId: string, options?)` - Poll until test completion
- `results(runId: string)` - Get detailed test results

**Note:** NGT does not have a `cancel()` endpoint like the legacy runner.

### New Types

#### NGT Response Types

- `AgentTestNGTStartResponse` - Response from starting a test run
- `AgentTestNGTStatusResponse` - Status information for a test run
- `AgentTestNGTResultsResponse` - Detailed results of a test run
- `TestScorerResult` - Individual scorer result within a test case
- `NGTTestCaseResult` - Test case result structure

#### Helper Types

- `TestRunnerType` - Union type: `'ngt' | 'legacy'`

### New Utilities

#### `determineTestRunner(connection, testDefinitionName?)`

Determines which test runner to use based on available metadata types in the org.

**Behavior:**

- Checks for both `AiEvaluationDefinition` (legacy) and `AiTestSuiteDefinition` (NGT) metadata
- If a `testDefinitionName` is provided and exists in both metadata types, throws an error
- Returns `'ngt'` if only NGT metadata exists
- Returns `'legacy'` if only legacy metadata exists
- Defaults to `'ngt'` if both exist but no specific test name provided
- Throws error if neither metadata type exists

#### `normalizeNGTResults(results)`

Normalizes NGT test results by decoding HTML entities in subject responses and scorer responses.

## API Differences: Legacy vs NGT

### Endpoints

| Operation | Legacy (AiEvaluationDefinition)                    | NGT (AiTestSuiteDefinition)                    |
| --------- | -------------------------------------------------- | ---------------------------------------------- |
| Start     | `POST /einstein/ai-evaluations/runs`               | `POST /einstein/ai-testing/runs`               |
| Status    | `GET /einstein/ai-evaluations/runs/:runId`         | `GET /einstein/ai-testing/runs/:runId`         |
| Results   | `GET /einstein/ai-evaluations/runs/:runId/results` | `GET /einstein/ai-testing/runs/:runId/results` |
| Cancel    | `POST /einstein/ai-evaluations/runs/:runId/cancel` | ❌ Not available                               |

### Request Bodies

**Legacy:**

```json
{
  "aiEvaluationDefinitionName": "MyTestSuite"
}
```

**NGT:**

```json
{
  "testDefinitionName": "MyTestSuite"
}
```

### Response Structures

**Legacy Results:**

```typescript
{
  status: string,
  testCases: [{
    status: string,
    inputs: { utterance: string },
    generatedData: { ... },
    testResults: [{ name, actualValue, expectedValue, result, ... }]
  }]
}
```

**NGT Results:**

```typescript
{
  status: string,
  testCases: [{
    subjectResponse: string,  // JSON-encoded response
    testNumber: number,
    testScorerResults: [{
      scorerName: string,
      scorerResponse: string  // JSON-encoded scorer result
    }]
  }]
}
```

## Usage Examples

### Example 1: Using Detection Utility

```typescript
import { Connection } from '@salesforce/core';
import { determineTestRunner, AgentTester, AgentTesterNGT } from '@salesforce/agents';

const connection = await Connection.create({
  /* ... */
});
const testName = 'MyTestSuite';

// Automatically detect which runner to use
const runnerType = await determineTestRunner(connection, testName);

let tester;
if (runnerType === 'ngt') {
  tester = new AgentTesterNGT(connection);
} else {
  tester = new AgentTester(connection);
}

// Use the tester
const startResponse = await tester.start(testName);
const results = await tester.poll(startResponse.runId);
```

### Example 2: Direct NGT Usage

```typescript
import { Connection } from '@salesforce/core';
import { AgentTesterNGT } from '@salesforce/agents';

const connection = await Connection.create({
  /* ... */
});
const tester = new AgentTesterNGT(connection);

// Start a test run
const { runId, status } = await tester.start('MyTestSuite');

// Poll until complete
const results = await tester.poll(runId, {
  timeout: Duration.minutes(10),
});

// Process results
for (const testCase of results.testCases) {
  console.log(`Test ${testCase.testNumber}:`);

  // Parse subject response (it's JSON-encoded)
  const subjectData = JSON.parse(testCase.subjectResponse);

  // Parse each scorer result
  for (const scorer of testCase.testScorerResults) {
    const scorerData = JSON.parse(scorer.scorerResponse);
    console.log(`  ${scorer.scorerName}:`, scorerData);
  }
}
```

### Example 3: Error Handling

```typescript
import { determineTestRunner } from '@salesforce/agents';

try {
  const runnerType = await determineTestRunner(connection, 'MyTest');
  // Use the appropriate runner...
} catch (error) {
  if (error.name === 'AmbiguousTestDefinition') {
    // Same test name exists in both legacy and NGT metadata
    console.error('Please remove duplicate test definition');
  } else if (error.name === 'NoTestDefinitionsFound') {
    // No test metadata exists in the org
    console.error('No test definitions found');
  }
}
```

## Backwards Compatibility

✅ **Fully backwards compatible** - All existing code using `AgentTester` continues to work unchanged.

The library now supports both:

- **Legacy**: `AgentTester` class with `AiEvaluationDefinition` metadata
- **NGT**: `AgentTesterNGT` class with `AiTestSuiteDefinition` metadata

Consumers can:

1. Continue using `AgentTester` for legacy tests
2. Use `AgentTesterNGT` explicitly for NGT tests
3. Use `determineTestRunner()` to automatically choose the correct runner

## Testing

New test coverage includes:

- `test/agentTesterNGT.test.ts` - NGT class and normalization tests
- HTML entity decoding in NGT responses
- Multiple test cases with multiple scorers
- Empty/undefined value handling

All existing tests continue to pass, ensuring no regressions.

## Future CLI/VSCode Integration

For CLI and VSCode consumers, the recommended pattern is:

```typescript
// In command/action handler
const runnerType = await determineTestRunner(connection, flags.name);
const TesterClass = runnerType === 'ngt' ? AgentTesterNGT : AgentTester;
const tester = new TesterClass(connection);

// Rest of the command logic remains the same
const result = await tester.start(flags.name);
// ...
```

This allows CLI/VSCode to support both test runner types with minimal code changes.
