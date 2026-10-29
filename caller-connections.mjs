import { createHash } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import {
  getNamedConnection,
  saveNamedConnection,
  setNamedConnectionSession,
} from './named-connections.mjs';
import { isSshWorkspaceUri, parseSshWorkspace } from './remote-workspace.mjs';

const CALLER_CONNECTION_DOMAIN = 'cursor-bridge-caller-connection-v1';
const PROTOTYPE_NAMES = new Set(['constructor', 'prototype']);
const SESSION_ID_PATTERN = /^cursor-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function callerConnectionsError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function canonicalConnectionName(value) {
  if (typeof value !== 'string') {
    throw callerConnectionsError('NAMED_CONNECTION_NAME_INVALID', 'name must be a string');
  }
  const name = value.trim().toLowerCase();
  if (name.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(name) || PROTOTYPE_NAMES.has(name)) {
    throw callerConnectionsError(
      'NAMED_CONNECTION_NAME_INVALID',
      'name must be 1-64 ASCII letters/digits/dot/underscore/dash, start with a letter or digit, and not be a prototype key',
    );
  }
  return name;
}

function canonicalConnectionUri(value) {
  if (!isSshWorkspaceUri(value)) {
    throw callerConnectionsError('NAMED_CONNECTION_URI_INVALID', 'uri must be a vscode-remote SSH workspace URI');
  }
  try {
    return parseSshWorkspace(value).uri;
  } catch (error) {
    throw callerConnectionsError('NAMED_CONNECTION_URI_INVALID', error.message, error);
  }
}

function canonicalSessionId(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw callerConnectionsError('NAMED_CONNECTION_SESSION_ID_INVALID', 'sessionId must be null or a cursor-session UUID');
  }
  const match = value.match(SESSION_ID_PATTERN);
  if (!match) {
    throw callerConnectionsError('NAMED_CONNECTION_SESSION_ID_INVALID', 'sessionId must use the cursor-session-UUID format');
  }
  return `cursor-session-${match[1].toLowerCase()}`;
}

function canonicalCallerKey(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw callerConnectionsError('CALLER_CONNECTION_CALLER_KEY_INVALID', 'callerKey must be a non-empty string');
  }
  // Preserve caller identity byte-for-byte (including case and surrounding
  // whitespace). Callers with accidentally different IDs must not be merged.
  return value;
}

function canonicalConnection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw callerConnectionsError('CALLER_CONNECTION_INVALID', 'connection must contain name and uri');
  }
  return {
    name: canonicalConnectionName(value.name),
    uri: canonicalConnectionUri(value.uri),
  };
}

function canonicalExpectedRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw callerConnectionsError('NAMED_CONNECTION_REVISION_INVALID', 'expectedRevision must be a safe integer of at least 0');
  }
  return value;
}

function presentCallerRecord(record, connection) {
  if (!record) return null;
  if (record.uri !== connection.uri) {
    throw callerConnectionsError(
      'CALLER_CONNECTION_URI_MISMATCH',
      'stored caller mapping does not match the requested canonical SSH workspace',
    );
  }
  return { ...record, name: connection.name, uri: connection.uri };
}

/** Resolve the caller-only registry, independent of connections-v1.json. */
export function resolveCallerConnectionsFile(env = process.env) {
  const configured = String(env?.CURSOR_BRIDGE_CALLER_CONNECTIONS_FILE || '').trim();
  if (configured) return resolve(configured);

  const appData = String(env?.APPDATA || '').trim();
  const configRoot = appData && isAbsolute(appData)
    ? appData
    : join(homedir(), 'AppData', 'Roaming');
  return resolve(configRoot, 'cursor-bridge', 'caller-connections-v1.json');
}

/**
 * Produce a valid named-connections key from the complete caller/name/URI
 * tuple. Full lowercase SHA-256 hex is exactly 64 canonical ASCII characters.
 */
export function callerConnectionKey(callerKey, connectionName, uri) {
  const caller = canonicalCallerKey(callerKey);
  const name = canonicalConnectionName(connectionName);
  const canonicalUri = canonicalConnectionUri(uri);
  const tuple = JSON.stringify([CALLER_CONNECTION_DOMAIN, caller, name, canonicalUri]);
  return createHash('sha256').update(tuple, 'utf8').digest('hex');
}

/** Return only this caller's mapping for the canonical name and URI tuple. */
export function getCallerConnection(filePath, callerKey, connectionValue) {
  const caller = canonicalCallerKey(callerKey);
  const connection = canonicalConnection(connectionValue);
  const storageName = callerConnectionKey(caller, connection.name, connection.uri);
  const record = getNamedConnection(filePath, storageName);
  return presentCallerRecord(record, connection);
}

/**
 * CAS-update this caller's session mapping in a separate atomic registry.
 * expectedRevision 0 creates a new mapping; positive revisions update only
 * that exact current version. The named-connections file is never consulted.
 */
export function setCallerConnectionSession(
  filePath,
  callerKey,
  connectionValue,
  sessionId,
  { expectedRevision, ...lockOptions } = {},
) {
  const caller = canonicalCallerKey(callerKey);
  const connection = canonicalConnection(connectionValue);
  const storageName = callerConnectionKey(caller, connection.name, connection.uri);
  const revision = canonicalExpectedRevision(expectedRevision);
  const canonicalSession = canonicalSessionId(sessionId);

  const record = revision === 0
    ? saveNamedConnection(filePath, {
        name: storageName,
        uri: connection.uri,
        sessionId: canonicalSession,
      }, { expectedRevision: 0, ...lockOptions })
    : setNamedConnectionSession(filePath, storageName, canonicalSession, {
        expectedRevision: revision,
        uri: connection.uri,
        ...lockOptions,
      });

  return presentCallerRecord(record, connection);
}
