# invalidAgentTestConfig

Must provide one of: [ name, mdPath, specPath, specData ] when instantiating an AgentTest.

# missingConnection

Must provide an org connection to get agent test data based on an AiEvaluationDefinition API name.

# missingTestSpecData

The agent test is missing the required data to provide a test spec.

# ngtMissingTestCases

NGT test spec must define at least one test case under `testCases:`.

# ngtTestCaseMissingInputs

NGT test case %s must define at least one entry under `inputs:`.

# ngtTestCaseMissingScorers

NGT test case %s must define at least one scorer under `scorers:`.

# ngtScorerMissingExpected

NGT scorer '%s' on test case %s requires an `expected:` value.

# ngtTaskResolutionRequiresConversationHistory

NGT scorer 'task_resolution' on test case %s requires conversationHistory on at least one input.

# ngtMultiAgentMissingHandoff

Test case %s targets a multi-agent subject and must include an `agent_handoff_match` scorer with an `expected:` value.

# ngtConversationHistoryIndexAllOrNothing

NGT conversationHistory on test case %s, input %s mixes turns with and without `index:`. Either set `index:` on every turn or none.

# ngtLooksLikeLegacySpec

This YAML looks like a legacy AiEvaluationDefinition spec (uses top-level `utterance:` / `expectedTopic:` / `customEvaluations:`). Use `--test-runner testing-center` for legacy authoring, or hand-edit the deployed XML for `<scorer scorerType="Custom">` blocks on NGT.

# ngtMalformedMetadataXml

Failed to parse AiTestingDefinition metadata XML: %s

# ngtWrongMetadataRoot

AiTestingDefinition metadata XML must have a top-level <%s> element.

# ngtUnknownScorerNoExpected

Unknown NGT scorer name '%s' has no <expectedValue> in the metadata. Cannot infer whether the scorer requires an expected value — add an <expectedValue> or use a known scorer.

# ambiguousTestDefinition

Both an AiEvaluationDefinition and an AiTestingDefinition exist for '%s' in the org. Disambiguate by passing a local metadata file path, or delete one of the metadata records.

# ngtSpecCannotProduceLegacyMetadata

This AgentTest holds an NGT (`NgtTestSpec`) spec but `getMetadata()` returns the legacy `AiEvaluationDefinition` shape. Use `convertToTestingMetadata` + `buildTestingMetadataXml` to serialize an NGT spec to its `AiTestingDefinition` XML.

# ngtPromptInputSetEmpty

NGT test case %s, input %s must define at least one entry under `promptInput:`.

# ngtPromptInputMissingReferenceName

NGT test case %s, input %s has a `promptInput` entry missing a non-blank `referenceName`.

# ngtPromptInputMissingValue

NGT test case %s, input %s: promptInput '%s' requires a non-blank `value`.

# ngtUnknownScorerName

NGT test case %s: unknown scorer name '%s'. The deploy will be validated by the server.

# ngtScorerUnsupportedForSubject

NGT test case %s: scorer '%s' is not supported for subject type '%s'. The deploy will be validated by the server.

# ngtUnknownSubjectType

NGT test spec has an unrecognized `subjectType` '%s'. Must be one of: AGENT, PROMPT.
