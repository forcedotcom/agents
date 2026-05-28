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
