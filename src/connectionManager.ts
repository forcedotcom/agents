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

import { AuthInfo, Connection, Logger, SfError } from '@salesforce/core';
import { useNamedUserJwt } from './utils';

/**
 * Result of JWT validation
 */
export type JwtValidationResult = {
  isValid: boolean;
  hasRequiredFields: boolean;
  missingFields: string[];
  expiresAt?: Date;
  issuedAt?: Date;
  isExpired: boolean;
  subject?: string;
  issuer?: string;
  appId?: string;
  scopes?: string[];
};

/**
 * Manages JWT and standard connections for agent operations.
 *
 * This class provides:
 * - Automatic JWT creation and validation
 * - Separation of JWT connection (for SFAP) and standard connection (for org operations)
 * - Guard installation to prevent JWT token clobbering
 * - JWT validation utilities for debugging
 *
 * @example
 * ```typescript
 * const manager = await ConnectionManager.create(connection);
 *
 * // Get JWT connection for SFAP calls
 * const jwtConn = manager.getJwtConnection();
 * await jwtConn.request({ method: 'POST', url: '/authoring/scripts', ... });
 *
 * // Get standard connection for org queries
 * const standardConn = manager.getStandardConnection();
 * await standardConn.query('SELECT Id FROM User LIMIT 1');
 * ```
 */
export class ConnectionManager {
  private jwtConnection: Connection;
  private standardConnection: Connection;

  /**
   * Private constructor. Use ConnectionManager.create() instead.
   */
  private constructor(jwtConnection: Connection, standardConnection: Connection) {
    this.jwtConnection = jwtConnection;
    this.standardConnection = standardConnection;
  }

  /**
   * Creates a new ConnectionManager instance.
   *
   * Builds two separate Connection objects derived from the username on the supplied
   * connection: a standard connection for org-instance operations (SOQL, tooling,
   * metadata) and a JWT-upgraded connection for SFAP API calls. The supplied
   * connection is read-only — it is never mutated.
   *
   * @param connection - The connection whose username is used to derive the new connections
   * @returns A new ConnectionManager instance
   * @throws {SfError} If JWT creation or validation fails, or if the connection has no username
   */
  public static async create(connection: Connection): Promise<ConnectionManager> {
    const logger = Logger.childFromRoot('ConnectionManager');
    const username = connection.getUsername();

    if (!username) {
      throw SfError.create({
        name: 'MissingUsername',
        message: 'Cannot create ConnectionManager: username not found on connection.',
      });
    }

    logger.debug(`Creating ConnectionManager for user: ${username}`);

    // Build two fresh, independent connections — one for org operations, one for SFAP JWT.
    // Building from username (not from the caller's connection object) guarantees the
    // caller's connection is not mutated by the JWT upgrade.
    const standardConn = await this.createConnectionFromUsername(username);
    const jwtSeed = await this.createConnectionFromUsername(username);
    logger.debug('Standard and JWT seed connections created');

    const jwtConn = await this.createAndValidateJwtConnection(jwtSeed, logger);
    logger.debug('JWT connection created and validated');

    return new ConnectionManager(jwtConn, standardConn);
  }

  /**
   * Creates a fresh Connection from a username. Used for both the standard and JWT
   * connections so the caller's original Connection object is never mutated.
   */
  private static async createConnectionFromUsername(username: string): Promise<Connection> {
    const authInfo = await AuthInfo.create({ username });
    return Connection.create({ authInfo });
  }

  /**
   * Upgrades a connection to a JWT connection for SFAP operations and validates the result.
   * The connection passed in is mutated (its accessToken is replaced with the JWT) — callers
   * must pass a fresh, isolated Connection rather than a connection they care about.
   */
  private static async createAndValidateJwtConnection(connection: Connection, logger: Logger): Promise<Connection> {
    const upgraded = await useNamedUserJwt(connection);
    logger.debug('Connection upgraded to JWT');

    const validation = this.validateJwt(upgraded.accessToken ?? undefined);

    if (!validation.isValid) {
      logger.error('JWT validation failed:', validation);
      const actions = ['Ensure your Connected App has the correct scopes: chatbot_api, sfap_api, web'];
      if (validation.missingFields.length > 0) {
        actions.push(`JWT missing required fields: ${validation.missingFields.join(', ')}`);
      }
      if (validation.isExpired) {
        actions.push('JWT is expired - ensure system time is correct');
      }
      throw SfError.create({
        name: 'InvalidJwtToken',
        message: 'Failed to create valid JWT for SFAP access',
        data: {
          validation: {
            ...validation,
            expiresAt: validation.expiresAt?.toISOString(),
            issuedAt: validation.issuedAt?.toISOString(),
          },
        },
        actions,
      });
    }

    if (!validation.hasRequiredFields) {
      logger.warn('JWT missing some expected fields:', validation.missingFields);
    }

    logger.debug('JWT validation passed', {
      hasRequiredFields: validation.hasRequiredFields,
      expiresAt: validation.expiresAt,
      scopes: validation.scopes,
    });

    return upgraded;
  }

  /**
   * Validates that a token is a proper org JWT with required fields.
   *
   * @param token - The JWT token to validate
   * @returns Validation result with diagnostic information
   */
  private static validateJwt(token: string | undefined): JwtValidationResult {
    if (!token) {
      return {
        isValid: false,
        hasRequiredFields: false,
        missingFields: ['token'],
        isExpired: false,
      };
    }

    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return {
          isValid: false,
          hasRequiredFields: false,
          missingFields: ['invalid JWT format - expected 3 parts'],
          isExpired: false,
        };
      }

      // Decode payload (middle part)
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString()) as Record<string, unknown>;

      // Check for expected SFAP JWT fields
      // Common JWT fields: sub (subject), iss (issuer), aud (audience), exp (expiration), iat (issued at)
      // SFAP-specific: sfdc_app_id, scope
      const requiredFields = ['sub', 'iss'];
      const optionalButExpected = ['sfdc_app_id', 'scope', 'exp', 'iat'];

      const missingFields = [
        ...requiredFields.filter((field) => !payload[field]),
        ...optionalButExpected.filter((field) => !payload[field]),
      ];

      const expiresAt = payload.exp ? new Date((payload.exp as number) * 1000) : undefined;
      const issuedAt = payload.iat ? new Date((payload.iat as number) * 1000) : undefined;
      const isExpired = expiresAt ? expiresAt < new Date() : false;

      const hasRequiredFields = requiredFields.every((field) => payload[field]);

      return {
        isValid: parts.length === 3 && hasRequiredFields && !isExpired,
        hasRequiredFields,
        missingFields,
        expiresAt,
        issuedAt,
        isExpired,
        subject: payload.sub as string | undefined,
        issuer: payload.iss as string | undefined,
        appId: payload.sfdc_app_id as string | undefined,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        scopes: payload.scope ? (payload.scope as string).split(' ') : undefined,
      };
    } catch (error) {
      return {
        isValid: false,
        hasRequiredFields: false,
        missingFields: ['JWT parse error'],
        isExpired: false,
      };
    }
  }

  /**
   * Gets the standard (non-JWT) connection for org-instance operations.
   * Use this for SOQL queries, metadata operations, tooling API, etc.
   *
   * @returns The standard connection
   */
  public getStandardConnection(): Connection {
    return this.standardConnection;
  }

  /**
   * Gets the JWT connection for SFAP API calls.
   * Use this for all requests to api.salesforce.com/einstein/ai-agent endpoints.
   *
   * @returns The JWT connection
   */
  public getJwtConnection(): Connection {
    return this.jwtConnection;
  }

  /**
   * Inspects the current JWT and provides diagnostic information.
   * Useful for debugging and troubleshooting JWT-related issues.
   *
   * @returns JWT validation result with detailed diagnostic information
   */
  public inspectJwt(): JwtValidationResult {
    return ConnectionManager.validateJwt(this.jwtConnection.accessToken ?? undefined);
  }

  /**
   * Refreshes the standard connection by clearing the access token and requesting a new one.
   * This is useful after agent operations to ensure subsequent org operations work correctly.
   *
   * @throws {SfError} If the refresh fails
   */
  public async refreshStandardConnection(): Promise<void> {
    delete this.standardConnection.accessToken;
    await this.standardConnection.refreshAuth();
  }
}
