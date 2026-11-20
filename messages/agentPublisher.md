# agentRetrievalError

Unable to retrieve newly created Agent metadata. Due to: %s

# agentRetrievalErrorActions

Retrieve the agent metadata using the "project retrieve start" command.

# authoringBundleDeploymentError

Unable to deploy AiAuthoringBundle metadata. Due to: %s

# authoringBundleDeploymentErrorActions

Deploy the authoring bundle metadata using the "project deploy start" command.

# findBotVersionError

Unable to find BotVersion with id %s.

# publishedBeforeFailureActions

The agent was already published to the org as %s before this step failed. Don't run the publish command again, because that creates another, duplicate version. Fix the cause of the error, then finish the step that failed.

# publishedBeforeFailureTargetActions

The agent was already published to the org as %s before this step failed. Don't run the publish command again, because that creates another, duplicate version. Fix the cause of the error, then finish the remaining steps: retrieve the agent metadata if that step failed, then deploy the authoring bundle with `<target>%s</target>` set in its bundle-meta.xml. Without the target, the bundle isn't linked to the version that was already published.
