import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isSshWorkspaceUri, parseSshWorkspace } from './remote-workspace.mjs';

export const NAMED_CONNECTIONS_VERSION = 1;

const CONNECTION_FIELDS = Object.freeze([
  'name', 'uri', 'sessionId', 'revision', 'createdAt', 'updatedAt',
]);
const TOP_LEVEL_FIELDS = Object.freeze(['version', 'connections']);
const PROTOTYPE_NAMES = new Set(['constructor', 'prototype']);
const SESSION_ID_PATTERN = /^cursor-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

function namedConnectionsError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function canonicalName(value) {
  if (typeof value !== 'string') {
    throw namedConnectionsError('NAMED_CONNECTION_NAME_INVALID', 'name must be a string');
  }
  const name = value.trim().toLowerCase();
  if (name.length > 64 || !/^[a-z0-9][a-z0-9._-]*$/.test(name) || PROTOTYPE_NAMES.has(name)) {
    throw namedConnectionsError(
      'NAMED_CONNECTION_NAME_INVALID',
      'name must be 1-64 ASCII letters/digits/dot/underscore/dash, start with a letter or digit, and not be a prototype key',
    );
  }
  return name;
}

function canonicalUri(value) {
  if (!isSshWorkspaceUri(value)) {
    throw namedConnectionsError('NAMED_CONNECTION_URI_INVALID', 'uri must be a vscode-remote SSH workspace URI');
  }
  try {
    return parseSshWorkspace(value).uri;
  } catch (error) {
    throw namedConnectionsError('NAMED_CONNECTION_URI_INVALID', error.message, error);
  }
}

function canonicalSessionId(value) {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw namedConnectionsError('NAMED_CONNECTION_SESSION_ID_INVALID', 'sessionId must be null or a cursor-session UUID');
  }
  const match = value.match(SESSION_ID_PATTERN);
  if (!match) {
    throw namedConnectionsError('NAMED_CONNECTION_SESSION_ID_INVALID', 'sessionId must use the cursor-session-UUID format');
  }
  return `cursor-session-${match[1].toLowerCase()}`;
}

function validateRevision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw namedConnectionsError(
      'NAMED_CONNECTION_REVISION_INVALID',
      `revision must be a safe integer of at least ${minimum}`,
    );
  }
  return value;
}

function validateTimestamp(value, fieldName) {
  if (typeof value !== 'string') {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `${fieldName} must be an ISO timestamp`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `${fieldName} must be a canonical ISO timestamp`);
  }
  return time;
}

function isObjectRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function assertExactFields(value, fields, context) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `${context} has missing or unsupported fields`);
  }
}

function validateConnectionRecord(record, key) {
  if (!isObjectRecord(record)) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection ${key} must be an object`);
  }
  assertExactFields(record, CONNECTION_FIELDS, `connection ${key}`);

  const name = canonicalName(record.name);
  if (name !== key || record.name !== name) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection key ${key} must match its canonical name`);
  }
  const uri = canonicalUri(record.uri);
  if (uri !== record.uri) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection ${key} URI is not canonical`);
  }
  const sessionId = canonicalSessionId(record.sessionId);
  if (sessionId !== record.sessionId) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection ${key} sessionId is not canonical`);
  }
  const revision = validateRevision(record.revision);
  const createdAt = validateTimestamp(record.createdAt, `connection ${key} createdAt`);
  const updatedAt = validateTimestamp(record.updatedAt, `connection ${key} updatedAt`);
  if (updatedAt < createdAt) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection ${key} updatedAt precedes createdAt`);
  }
  return { name, uri, sessionId, revision, createdAt: record.createdAt, updatedAt: record.updatedAt };
}

function emptyNamedConnections() {
  return { version: NAMED_CONNECTIONS_VERSION, connections: {} };
}

export function resolveNamedConnectionsFile(env = process.env) {
  const configured = String(env.CURSOR_BRIDGE_CONNECTIONS_FILE || '').trim();
  if (configured) return resolve(configured);

  const appData = String(env.APPDATA || '').trim();
  const configRoot = appData && isAbsolute(appData)
    ? appData
    : join(homedir(), 'AppData', 'Roaming');
  return resolve(configRoot, 'cursor-bridge', 'connections-v1.json');
}

export function readNamedConnections(filePath) {
  if (!filePath) return emptyNamedConnections();
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyNamedConnections();
    throw namedConnectionsError(
      'NAMED_CONNECTIONS_READ_FAILED',
      `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `failed to parse ${filePath}`, error);
  }
  if (!isObjectRecord(parsed) || parsed.version !== NAMED_CONNECTIONS_VERSION) {
    throw namedConnectionsError(
      'NAMED_CONNECTIONS_SCHEMA_UNSUPPORTED',
      `expected version ${NAMED_CONNECTIONS_VERSION}, received ${parsed && parsed.version}`,
    );
  }
  assertExactFields(parsed, TOP_LEVEL_FIELDS, 'named connections registry');
  if (!isObjectRecord(parsed.connections)) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', 'connections must be an object');
  }

  const connections = {};
  for (const key of Object.keys(parsed.connections)) {
    const name = canonicalName(key);
    if (name !== key) {
      throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection key ${key} is not canonical`);
    }
    connections[name] = validateConnectionRecord(parsed.connections[key], name);
  }
  return { version: NAMED_CONNECTIONS_VERSION, connections };
}

export function getNamedConnection(filePath, nameValue) {
  const name = canonicalName(nameValue);
  const state = readNamedConnections(filePath);
  return Object.hasOwn(state.connections, name) ? { ...state.connections[name] } : null;
}

export function listNamedConnections(filePath) {
  const state = readNamedConnections(filePath);
  return Object.keys(state.connections).sort().map(name => ({ ...state.connections[name] }));
}

function acquireConnectionLock(filePath, options = {}) {
  const lockPath = `${resolve(filePath)}.lock`;
  const waitMs = Number(options.waitMs ?? 2000);
  const staleMs = Number(options.staleMs ?? 30000);
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true });

  for (;;) {
    try {
      const handle = openSync(lockPath, 'wx', 0o600);
      closeSync(handle);
      return () => rmSync(lockPath, { force: true });
    } catch (error) {
      if (!error || !['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) {
        throw namedConnectionsError(
          'NAMED_CONNECTIONS_LOCK_FAILED',
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) {
          rmSync(lockPath, { force: true });
          continue;
        }
      } catch {}
      if (Date.now() >= deadline) {
        throw namedConnectionsError('NAMED_CONNECTIONS_BUSY', 'another process is updating named connections');
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function writeNamedConnections(filePath, state) {
  const target = resolve(filePath);
  const validated = readNamedConnectionsFromState(state);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw namedConnectionsError(
      'NAMED_CONNECTIONS_WRITE_FAILED',
      `failed to persist ${target}: ${error instanceof Error ? error.message : String(error)}`,
      error,
    );
  }
  return validated;
}

function readNamedConnectionsFromState(state) {
  if (!isObjectRecord(state) || state.version !== NAMED_CONNECTIONS_VERSION || !isObjectRecord(state.connections)) {
    throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', 'invalid in-memory connection state');
  }
  const connections = {};
  for (const key of Object.keys(state.connections)) {
    const name = canonicalName(key);
    if (name !== key) throw namedConnectionsError('NAMED_CONNECTIONS_INVALID', `connection key ${key} is not canonical`);
    connections[name] = validateConnectionRecord(state.connections[key], name);
  }
  return { version: NAMED_CONNECTIONS_VERSION, connections };
}

function updateNamedConnections(filePath, mutator, options = {}) {
  if (!filePath) throw namedConnectionsError('NAMED_CONNECTIONS_PATH_REQUIRED', 'filePath is required for updates');
  const target = resolve(filePath);
  const release = acquireConnectionLock(target, options);
  try {
    const state = readNamedConnections(target);
    const result = mutator(state);
    writeNamedConnections(target, state);
    return result;
  } finally {
    release();
  }
}

function assertExpectedRevision(expectedRevision, currentRevision, name) {
  if (expectedRevision === undefined) return;
  validateRevision(expectedRevision, { allowZero: true });
  if (expectedRevision !== currentRevision) {
    throw namedConnectionsError(
      'NAMED_CONNECTION_REVISION_CONFLICT',
      `connection ${name} revision is ${currentRevision}; expected ${expectedRevision}`,
    );
  }
}

export function saveNamedConnection(filePath, input, { replace = false, expectedRevision, ...lockOptions } = {}) {
  if (!isObjectRecord(input)) {
    throw namedConnectionsError('NAMED_CONNECTION_INVALID', 'connection input must be an object');
  }
  const allowedInputFields = ['name', 'uri', 'sessionId'];
  if (Object.keys(input).some(key => !allowedInputFields.includes(key)) || !Object.hasOwn(input, 'name') || !Object.hasOwn(input, 'uri')) {
    throw namedConnectionsError('NAMED_CONNECTION_INVALID', 'connection input must contain only name, uri, and optional sessionId');
  }
  const name = canonicalName(input.name);
  const uri = canonicalUri(input.uri);
  const hasSessionId = Object.hasOwn(input, 'sessionId') && input.sessionId !== undefined;
  const suppliedSessionId = hasSessionId ? canonicalSessionId(input.sessionId) : null;
  const replaceExisting = replace === true;

  return updateNamedConnections(filePath, state => {
    const existing = Object.hasOwn(state.connections, name) ? state.connections[name] : null;
    assertExpectedRevision(expectedRevision, existing ? existing.revision : 0, name);
    if (existing && existing.uri !== uri && !replaceExisting) {
      throw namedConnectionsError('NAMED_CONNECTION_REPLACE_REQUIRED', `connection ${name} already points to another SSH workspace`);
    }

    const sameUri = existing?.uri === uri;
    const sessionId = hasSessionId
      ? suppliedSessionId
      : sameUri
        ? existing.sessionId
        : null;
    const now = new Date().toISOString();
    const record = {
      name,
      uri,
      sessionId,
      revision: existing ? existing.revision + 1 : 1,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
    };
    state.connections[name] = record;
    return { ...record };
  }, lockOptions);
}

export function setNamedConnectionSession(filePath, nameValue, sessionIdValue, { expectedRevision, uri: uriValue, ...lockOptions } = {}) {
  const name = canonicalName(nameValue);
  const sessionId = canonicalSessionId(sessionIdValue);
  if (expectedRevision === undefined) {
    throw namedConnectionsError('NAMED_CONNECTION_EXPECTED_REVISION_REQUIRED', 'expectedRevision is required');
  }
  validateRevision(expectedRevision);
  const uri = canonicalUri(uriValue);

  return updateNamedConnections(filePath, state => {
    const existing = Object.hasOwn(state.connections, name) ? state.connections[name] : null;
    if (!existing) throw namedConnectionsError('NAMED_CONNECTION_NOT_FOUND', `connection ${name} does not exist`);
    assertExpectedRevision(expectedRevision, existing.revision, name);
    if (existing.uri !== uri) {
      throw namedConnectionsError('NAMED_CONNECTION_URI_CONFLICT', `connection ${name} no longer points to the expected SSH workspace`);
    }
    const record = {
      ...existing,
      sessionId,
      revision: existing.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    state.connections[name] = record;
    return { ...record };
  }, lockOptions);
}
