/*
 * Copyright (c) 2025, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Connection, Logger, Messages } from '@salesforce/core';
import { type ApexLog, type TraceFlag } from '@salesforce/types/tooling';

Messages.importMessagesDirectory(__dirname);
const messages = Messages.loadMessages('@salesforce/agents', 'apexUtils');

let logger: Logger;
const getLogger = (): Logger => {
  if (!logger) {
    logger = Logger.childFromRoot('AgentApexDebug');
  }
  return logger;
};

// Correct some of the typings of TraceFlag
export type ApexTraceFlag = TraceFlag & {
  ExpirationDate: string;
  StartDate: string;
  Id: string;
};

/**
 * Get the apex debug log with a start time that falls in between the provided start and end times.
 *
 * @param connection The connection to use to make requests.
 * @param start The start time of the apex debug log.
 * @param end The end time of the apex debug log.
 * @returns The apex debug log.
 */
export const getDebugLog = async (connection: Connection, start: number, end: number): Promise<ApexLog | undefined> => {
  const query =
    'SELECT Id, Application, DurationMilliseconds, Location, LogLength, LogUserId, LogUser.Name, Operation, Request, StartTime, Status FROM ApexLog ORDER BY StartTime DESC';
  const queryResult = await connection.tooling.query<Record<string, ApexLog>>(query);
  if (queryResult.records.length) {
    getLogger().debug(`Found ${queryResult.records.length} apex debug logs.`);
    for (const apexLog of queryResult.records) {
      const startTime = new Date(apexLog.StartTime as unknown as string).getTime();
      if (startTime >= start && startTime <= end) {
        return apexLog;
      }
    }
  } else {
    getLogger().debug(
      `No debug logs found between ${new Date(start).toDateString()} and ${new Date(end).toDateString()}`
    );
  }
};

export const writeDebugLog = async (connection: Connection, log: ApexLog, outputDir: string): Promise<void> => {
  const logId = log.Id;
  if (!logId) {
    throw messages.createError('apexLogIdNotFound');
  }
  const logFile = join(outputDir, `${logId}.log`);
  // eslint-disable-next-line no-underscore-dangle
  const url = `${connection.tooling._baseUrl()}/sobjects/ApexLog/${logId}/Body`;
  const logContent = await connection.tooling.request<string>(url);
  getLogger().debug(`Writing apex debug log to file: ${logFile}`);
  return writeFile(logFile, logContent);
};

/**
 * Get the debug level id for `SFDC_DevConsole`.
 *
 * @param connection The connection to use to make requests.
 * @returns The debug level id.
 */
export const getDebugLevelId = async (connection: Connection): Promise<string> => {
  const query = "SELECT Id FROM DebugLevel WHERE DeveloperName = 'SFDC_DevConsole'";
  return (await connection.singleRecordQuery<{ Id: string }>(query, { tooling: true })).Id;
};

/**
 * Create a trace flag for the given user id.
 *
 * @param connection The connection to use to make requests.
 * @param userId The user id to create the trace flag for.
 */
export const createTraceFlag = async (connection: Connection, userId: string): Promise<void> => {
  const now = Date.now();
  const debuglevelid = await getDebugLevelId(connection);
  const expirationDate = new Date(now + 30 * 60_000).toUTCString(); // 30 minute expiration
  const result = await connection.tooling.create('TraceFlag', {
    tracedentityid: userId,
    logtype: 'DEVELOPER_LOG',
    debuglevelid,
    StartDate: now,
    ExpirationDate: expirationDate,
  });
  if (!result.success) {
    throw messages.createError('traceFlagCreationError', [userId]);
  } else {
    getLogger().debug(`Created new apexTraceFlag for userId: ${userId} with ExpirationDate of ${expirationDate}`);
  }
};

/**
 * Find a trace flag for the given user id.
 *
 * @param connection The connection to use to make requests.
 * @param userId The user id to find the trace flag for.
 * @returns The trace flag.
 */
export const findTraceFlag = async (connection: Connection, userId: string): Promise<ApexTraceFlag | undefined> => {
  const traceFlagQuery = `
    SELECT Id, logtype, startdate, expirationdate, debuglevelid, debuglevel.apexcode, debuglevel.visualforce
    FROM TraceFlag
    WHERE logtype='DEVELOPER_LOG' AND TracedEntityId='${userId}'
    ORDER BY CreatedDate DESC
    LIMIT 1
  `;
  const traceFlagResult = await connection.tooling.query<Record<string, ApexTraceFlag>>(traceFlagQuery);
  if (traceFlagResult.totalSize > 0) {
    const traceFlag = traceFlagResult.records[0] as unknown as ApexTraceFlag;
    if (traceFlag.ExpirationDate && new Date(traceFlag.ExpirationDate) > new Date()) {
      getLogger().debug(`Using apexTraceFlag in the org with ExpirationDate of ${traceFlag.ExpirationDate}`);
      return traceFlag;
    }
  }
};
