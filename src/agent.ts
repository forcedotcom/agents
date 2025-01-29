/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { inspect } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { Connection, Lifecycle, Logger, Messages, SfError, SfProject } from '@salesforce/core';
import { ComponentSetBuilder } from '@salesforce/source-deploy-retrieve';
import { Duration } from '@salesforce/kit';
import {
  type SfAgent,
  type AgentCreateConfig,
  type AgentCreateConfigV2,
  type AgentCreateResponse,
  type AgentCreateResponseV2,
  type AgentJobSpec,
  type AgentJobSpecV2,
  type AgentJobSpecCreateConfig,
  type AgentJobSpecCreateConfigV2,
  type AgentJobSpecCreateResponse,
  type AttachAgentTopicsBody,
  type DraftAgentTopicsBody,
  type DraftAgentTopicsResponse,
} from './types.js';
import { MaybeMock } from './maybe-mock';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'agents');

/**
 * Events emitted during Agent.create() for consumers to listen to and keep track of progress
 *
 * @type {{DeployingMetadata: string, CreatingLocally: string, CreatingRemotely: string, RetrievingMetadata: string}}
 */
export const AgentCreateLifecycleStages = {
  CreatingLocally: 'creatinglocally',
  DeployingMetadata: 'deployingmetadata',
  CreatingRemotely: 'creatingremotely',
  RetrievingMetadata: 'retrievingmetadata',
};

export const AgentCreateLifecycleStagesV2 = {
  Creating: 'creatingAgent',
  Previewing: 'previewingAgent',
  Retrieving: 'retrievingAgent',
};

/**
 * Class for creating Agents and agent specs.
 */
export class Agent implements SfAgent {
  private logger: Logger;
  private maybeMock: MaybeMock;
  private readonly connection: Connection;

  /**
   * Create an Agent instance
   *
   * @param {Connection} connection
   * @param {SfProject} project
   */
  public constructor(connection: Connection, private project: SfProject) {
    this.logger = Logger.childFromRoot(this.constructor.name);
    this.maybeMock = new MaybeMock(connection);
    this.connection = connection;
  }

  /**
   * From an AgentCreateConfig, deploy the required metadata, call the connect/attach-agent-topics endpoint, and then retrieve
   * the newly updated metadata back to the local project
   *
   * @deprecated Use the V2 APIs.
   *
   * @param {AgentCreateConfig} config
   * @returns {Promise<AgentCreateResponse>}
   */
  public async create(config: AgentCreateConfig): Promise<AgentCreateResponse> {
    this.logger.debug(`Creating Agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.CreatingLocally, {});

    const sourcepaths = await this.createMetadata(config);

    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.DeployingMetadata, {});
    const cs = await ComponentSetBuilder.build({ sourcepath: sourcepaths });
    const deploy = await cs.deploy({ usernameOrConnection: this.connection });
    const result = await deploy.pollStatus({ timeout: Duration.minutes(10_000), frequency: Duration.seconds(1) });
    if (!result.response.success) {
      throw new SfError(result.response.errorMessage ?? `Unable to deploy ${result.response.id}`);
    }

    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.CreatingRemotely, {});

    const plannerId = (
      await this.connection.singleRecordQuery<{ Id: string }>(
        `SELECT Id
           FROM GenAiPlanner
           WHERE MasterLabel = 'MasterLabel for ${config.name}'`,
        { tooling: true }
      )
    ).Id;

    const url = `${
      this.connection.instanceUrl
    }/services/data/v${this.connection.getApiVersion()}/connect/attach-agent-topics`;

    const body: AttachAgentTopicsBody = {
      plannerId,
      agentJobSpecs: config.jobSpec,
      companyDescription: config.companyDescription,
      role: config.role,
      companyName: config.companyName,
      agentType: config.type,
    };
    const response = await this.maybeMock.request<AgentCreateResponse>('POST', url, body);

    await Lifecycle.getInstance().emit(AgentCreateLifecycleStages.RetrievingMetadata, {});

    const genAiPluginNames = (
      await this.connection.tooling.query<{ DeveloperName: string }>(
        `SELECT DeveloperName FROM GenAiPluginDefinition WHERE DeveloperName LIKE 'p_${plannerId}%'`
      )
    ).records;
    // more MD types were created in the org, than were in the project when we started
    genAiPluginNames.map((r) => cs.add({ fullName: r.DeveloperName, type: 'GenAiPlugin' }));

    const retrieve = await cs.retrieve({
      usernameOrConnection: this.connection,
      merge: true,
      format: 'source',
      output: this.project.getDefaultPackage().path ?? 'force-app',
    });
    const retrieveResult = await retrieve.pollStatus({
      frequency: Duration.seconds(1),
      timeout: Duration.minutes(10_000),
    });

    if (!retrieveResult.response.success) {
      throw new SfError(`Unable to retrieve ${retrieveResult.response.id}`);
    }

    return response;
  }

  /**
   * Creates an agent from a configuration, optionally saving the agent in an org.
   *
   * @param config a configuration for creating or previewing an agent
   * @returns the agent definition
   */
  public async createV2(config: AgentCreateConfigV2): Promise<AgentCreateResponseV2> {
    const url = '/connect/ai-assist/create-agent';

    // When previewing agent creation just return the response.
    if (!config.saveAgent) {
      this.logger.debug(
        `Previewing agent creation using config: ${inspect(config)} in project: ${this.project.getPath()}`
      );
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStagesV2.Previewing, {});
      return this.maybeMock.request<AgentCreateResponseV2>('POST', url, config);
    }

    if (!config.agentSettings?.agentName) {
      throw messages.createError('missingAgentName');
    }

    this.logger.debug(`Creating agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    await Lifecycle.getInstance().emit(AgentCreateLifecycleStagesV2.Creating, {});
    if (!config.agentSettings.agentApiName) {
      config.agentSettings.agentApiName = generateAgentApiName(config.agentSettings?.agentName);
    }
    const response = await this.maybeMock.request<AgentCreateResponseV2>('POST', url, config);

    // When saving agent creation we need to retrieve the created metadata.
    if (response.isSuccess) {
      await Lifecycle.getInstance().emit(AgentCreateLifecycleStagesV2.Retrieving, {});
      const defaultPackagePath = this.project.getDefaultPackage().path ?? 'force-app';
      const cs = await ComponentSetBuilder.build({
        metadata: {
          metadataEntries: [`Agent:${config.agentSettings.agentApiName}`],
          directoryPaths: [defaultPackagePath],
        },
        org: {
          username: this.connection.getUsername() as string,
          exclude: [],
        },
      });

      const retrieve = await cs.retrieve({
        usernameOrConnection: this.connection,
        merge: true,
        format: 'source',
        output: defaultPackagePath,
      });
      const retrieveResult = await retrieve.pollStatus({
        frequency: Duration.milliseconds(200),
        timeout: Duration.minutes(5),
      });
      if (!retrieveResult.response.success) {
        const errMessages = retrieveResult.response.messages?.toString() ?? 'unknown';
        throw messages.createError('agentRetrievalError', [errMessages]);
      }
    }

    return response;
  }

  /**
   * Create an agent spec from provided data.
   *
   * @deprecated Use the V2 APIs.
   *
   * @param config The configuration used to generate an agent spec.
   */
  public async createSpec(config: AgentJobSpecCreateConfig): Promise<AgentJobSpec> {
    let agentSpec: AgentJobSpec;
    const response = await this.maybeMock.request<AgentJobSpecCreateResponse>('GET', this.buildAgentJobSpecUrl(config));
    if (response.isSuccess && response.jobSpecs) {
      agentSpec = response.jobSpecs;
    } else {
      throw SfError.create({
        name: 'AgentJobSpecCreateError',
        message: response.errorMessage ?? 'unknown',
      });
    }

    return agentSpec;
  }

  /**
   * Create an agent spec from provided data.
   *
   * @param config The configuration used to generate an agent spec.
   */
  public async createSpecV2(config: AgentJobSpecCreateConfigV2): Promise<AgentJobSpecV2> {
    this.verifyAgentSpecConfig(config);

    const url = '/connect/ai-assist/draft-agent-topics';

    const body: DraftAgentTopicsBody = {
      agentType: config.agentType,
      generationInfo: {
        defaultInfo: {
          role: config.role,
          companyName: config.companyName,
          companyDescription: config.companyDescription,
        },
      },
      generationSettings: {
        maxNumOfTopics: config.maxNumOfTopics ?? 10,
      },
    };
    if (config.companyWebsite) {
      body.generationInfo.defaultInfo.companyWebsite = config.companyWebsite;
    }
    if (config.promptTemplateName) {
      body.generationInfo.customizedInfo = { promptTemplateName: config.promptTemplateName };
      if (config.groundingContext) {
        body.generationInfo.customizedInfo.groundingContext = config.groundingContext;
      }
    }

    const response = await this.maybeMock.request<DraftAgentTopicsResponse>('POST', url, body);

    if (response.isSuccess && response.topicDrafts) {
      return { ...config, topics: response.topicDrafts };
    } else {
      throw SfError.create({
        name: 'AgentJobSpecCreateError',
        message: response.errorMessage ?? 'unknown',
      });
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private verifyAgentSpecConfig(config: AgentJobSpecCreateConfigV2): void {
    const { agentType, role, companyName, companyDescription } = config;
    if (!agentType || !role || !companyName || !companyDescription) {
      throw messages.createError('invalidAgentSpecConfig');
    }
  }

  // eslint-disable-next-line class-methods-use-this
  private buildAgentJobSpecUrl(config: AgentJobSpecCreateConfig): string {
    const { type, role, companyName, companyDescription, companyWebsite } = config;
    const encodedType = `agentType=${encodeURIComponent(type)}`;
    const encodedRole = `role=${encodeURIComponent(role)}`;
    const encodedCompanyName = `companyName=${encodeURIComponent(companyName)}`;
    const encodedCompanyDescription = `companyDescription=${encodeURIComponent(companyDescription)}`;
    const encodedCompanyWebsite = companyWebsite ? `&companyWebsite=${companyWebsite}` : '';
    return `/connect/agent-job-spec?${encodedType}&${encodedRole}&${encodedCompanyName}&${encodedCompanyDescription}${encodedCompanyWebsite}`;
  }

  private async createMetadata(config: AgentCreateConfig): Promise<string[]> {
    const genAiSourceDirPath = path.join(this.project.getPath(), 'force-app', 'main', 'default', 'genAiPlanners');
    const botDirPath = path.join(this.project.getPath(), 'force-app', 'main', 'default', 'bots', config.name);
    const genAiSourcePath = path.join(genAiSourceDirPath, `${config.name}.genAiPlanner-meta.xml`);
    const botSourcePath = path.join(botDirPath, `${config.name}.bot-meta.xml`);
    const botVersionSourcePath = path.join(botDirPath, 'v1.botVersion-meta.xml');
    // TODO: will this need to be user specified? Something to update for V2 APIs
    const botUser = (
      await this.connection.singleRecordQuery<{ Username: string }>(
        "SELECT Username FROM User Where Profile.name='Einstein Agent User' LIMIT 1"
      )
    ).Username;

    this.logger.debug(`Creating Agent using config: ${inspect(config)} in project: ${this.project.getPath()}`);
    await Promise.all([
      fs.promises.mkdir(genAiSourceDirPath, { recursive: true }),
      fs.promises.mkdir(botDirPath, { recursive: true }),
    ]);
    // the dirs must exist before we write the files
    await Promise.all([
      fs.promises.writeFile(
        genAiSourcePath,
        `<?xml version="1.0" encoding="UTF-8"?>
<GenAiPlanner xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>description for ${config.name}</description>
    <masterLabel>MasterLabel for ${config.name}</masterLabel>
    <plannerType>AiCopilot__ReAct</plannerType>
</GenAiPlanner>
      `
      ),
      fs.promises.writeFile(
        botSourcePath,
        `<?xml version="1.0" encoding="UTF-8"?>
<Bot xmlns="http://soap.sforce.com/2006/04/metadata">
    <botMlDomain>
        <label>${config.name}</label>
        <name>${config.name}</name>
    </botMlDomain>
    <botUser>${botUser}</botUser>
    <contextVariables>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>Facebook</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>EmbeddedMessaging</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>AppleBusinessChat</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>WhatsApp</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>Text</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.MessagingEndUserId</fieldName>
            <messageType>Line</messageType>
        </contextVariableMappings>
        <dataType>Id</dataType>
        <developerName>EndUserId</developerName>
        <label>End User Id</label>
    </contextVariables>
    <contextVariables>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>Line</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>EmbeddedMessaging</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>AppleBusinessChat</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>WhatsApp</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>Text</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.Id</fieldName>
            <messageType>Facebook</messageType>
        </contextVariableMappings>
        <dataType>Id</dataType>
        <developerName>RoutableId</developerName>
        <label>Routable Id</label>
    </contextVariables>
    <contextVariables>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>Line</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>EmbeddedMessaging</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>AppleBusinessChat</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>WhatsApp</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>Text</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingSession</SObjectType>
            <fieldName>MessagingSession.EndUserLanguage</fieldName>
            <messageType>Facebook</messageType>
        </contextVariableMappings>
        <dataType>Text</dataType>
        <developerName>EndUserLanguage</developerName>
        <label>End User Language</label>
    </contextVariables>
    <contextVariables>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>Line</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>EmbeddedMessaging</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>AppleBusinessChat</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>WhatsApp</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>Text</messageType>
        </contextVariableMappings>
        <contextVariableMappings>
            <SObjectType>MessagingEndUser</SObjectType>
            <fieldName>MessagingEndUser.ContactId</fieldName>
            <messageType>Facebook</messageType>
        </contextVariableMappings>
        <dataType>Id</dataType>
        <developerName>ContactId</developerName>
        <label>Contact Id</label>
    </contextVariables>
    <description>${config.companyDescription}</description>
    <label>${config.name}</label>
    <logPrivateConversationData>false</logPrivateConversationData>
    <richContentEnabled>true</richContentEnabled>
    <sessionTimeout>480</sessionTimeout>
    <type>ExternalCopilot</type>
</Bot>
`
      ),
      fs.promises.writeFile(
        botVersionSourcePath,
        `<?xml version="1.0" encoding="UTF-8"?>
<BotVersion xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>v1</fullName>
    <articleAnswersGPTEnabled>false</articleAnswersGPTEnabled>
    <botDialogs>
        <botSteps>
            <botMessages>
                <message>Hi, I&apos;m an AI assistant. How can I help you?</message>
                <messageIdentifier>bfafa206-133e-44e0-8560-c47c45715124</messageIdentifier>
            </botMessages>
            <stepIdentifier>f85fa042-f009-4722-ba6a-6f743ebd44e8</stepIdentifier>
            <type>Message</type>
        </botSteps>
        <botSteps>
            <stepIdentifier>cc7b5414-18df-43aa-b97a-c5d2682eee62</stepIdentifier>
            <type>Wait</type>
        </botSteps>
        <developerName>Welcome</developerName>
        <isPlaceholderDialog>false</isPlaceholderDialog>
        <label>Hi! I&apos;m your helpful bot.</label>
        <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
    <botDialogs>
        <botSteps>
            <botMessages>
                <message>Sorry, it looks like something has gone wrong.</message>
                <messageIdentifier>41556708-3dda-4bc7-9444-fb9d3972a47f</messageIdentifier>
            </botMessages>
            <stepIdentifier>76ef6e29-6a3e-42fb-a325-606736f36268</stepIdentifier>
            <type>Message</type>
        </botSteps>
        <botSteps>
            <stepIdentifier>c2964b65-3c22-4cfb-9974-1a91820011e0</stepIdentifier>
            <type>Wait</type>
        </botSteps>
        <developerName>Error_Handling</developerName>
        <isPlaceholderDialog>false</isPlaceholderDialog>
        <label>Unfortunately, a system error occurred. Let us start again.</label>
        <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
    <botDialogs>
        <botSteps>
            <botMessages>
                <message>One moment while I connect you to the next available service representative.</message>
                <messageIdentifier>ddf568e3-4805-4529-a71d-4601ec9b5e16</messageIdentifier>
            </botMessages>
            <stepIdentifier>fc998b13-39e8-4142-aa14-80b5c80934dc</stepIdentifier>
            <type>Message</type>
        </botSteps>
        <botSteps>
            <conversationSystemMessage>
                <type>Transfer</type>
            </conversationSystemMessage>
            <stepIdentifier>e9a1f351-66fc-4a2e-8871-905ea08bdfa5</stepIdentifier>
            <type>SystemMessage</type>
        </botSteps>
        <developerName>Transfer_To_Agent</developerName>
        <isPlaceholderDialog>false</isPlaceholderDialog>
        <label>Transfer To Agent</label>
        <showInFooterMenu>false</showInFooterMenu>
    </botDialogs>
    <citationsEnabled>false</citationsEnabled>
    <conversationDefinitionPlanners>
        <genAiPlannerName>${config.name}</genAiPlannerName>
    </conversationDefinitionPlanners>
    <entryDialog>Welcome</entryDialog>
    <intentDisambiguationEnabled>false</intentDisambiguationEnabled>
    <intentV3Enabled>false</intentV3Enabled>
    <knowledgeFallbackEnabled>false</knowledgeFallbackEnabled>
    <smallTalkEnabled>false</smallTalkEnabled>
    <toneType>Casual</toneType>
</BotVersion>
`
      ),
    ]);

    return [genAiSourcePath, botSourcePath, botVersionSourcePath];
  }
}

/**
 * Generate an API name from an agent name. Matches what the UI does.
 */
export const generateAgentApiName = (agentName: string): string => {
  const maxLength = 255;
  let apiName = agentName;
  apiName = apiName.replace(/[\W_]+/g, '_');
  if (apiName.charAt(0).match(/_/i)) {
    apiName = apiName.slice(1);
  }
  apiName = apiName
    .replace(/(^\d+)/, 'X$1')
    .slice(0, maxLength)
    .replace(/_$/, '');
  const logger = Logger.childFromRoot('Agent-GenApiName');
  logger.debug(`Generated Agent API name: [${apiName}] from Agent name: [${agentName}]`);
  return apiName;
};
