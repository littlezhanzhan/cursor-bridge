import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isAbsoluteWorkspacePath, normalizeWorkspacePath } from './workspace-binding.mjs';
import { isSshWorkspaceUri, parseSshWorkspace } from './remote-workspace.mjs';
import { withInterprocessLock } from './interprocess-lock.mjs';

export const AGENT_ATTACHMENTS_VERSION = 1;

const CALLER_KEY_PATTERN = /^[0-9a-f]{64}$/;
const SESSION_ID_PATTERN = /^cursor-session-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const AGENT_ID_PATTERN = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:-]{1,256}$/;
const TOP_LEVEL_FIELDS = Object.freeze(['version', 'attachments']);
const RECORD_FIELDS = Object.freeze(['sessionId', 'agentId', 'targetId', 'projectPath', 'revision', 'updatedAt']);
const INPUT_FIELDS = Object.freeze(['sessionId', 'agentId', 'targetId', 'projectPath']);
const OPTIONS_FIELDS = Object.freeze(['expectedRevision']);

function agentAttachmentsError(code, message, cause) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function assertExactFields(value, fields, context) {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', `${context} has missing or unsupported fields`);
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function canonicalCallerKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_CALLER_KEY_INVALID', 'callerKey must be a non-empty string without NUL');
  }
  // Do not normalize identity; the full UTF-8 caller key is hashed as supplied.
  return value;
}

function callerStorageKey(callerKey) {
  return createHash('sha256').update(canonicalCallerKey(callerKey), 'utf8').digest('hex');
}

function canonicalSessionId(value) {
  if (typeof value !== 'string') {
    throw agentAttachmentsError('AGENT_ATTACHMENT_SESSION_ID_INVALID', 'sessionId must use the cursor-session-UUID format');
  }
  const match = SESSION_ID_PATTERN.exec(value);
  if (!match) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_SESSION_ID_INVALID', 'sessionId must use the cursor-session-UUID format');
  }
  return `cursor-session-${match[1].toLowerCase()}`;
}

function canonicalAgentId(value) {
  if (typeof value !== 'string') {
    throw agentAttachmentsError('AGENT_ATTACHMENT_AGENT_ID_INVALID', 'agentId must use the local:UUID format');
  }
  const match = AGENT_ID_PATTERN.exec(value);
  if (!match) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_AGENT_ID_INVALID', 'agentId must use the local:UUID format');
  }
  return `local:${match[1].toLowerCase()}`;
}

function canonicalTargetId(value) {
  if (typeof value !== 'string' || !TARGET_ID_PATTERN.test(value)) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_TARGET_ID_INVALID', 'targetId must be 1-256 ASCII letters, digits, dot, underscore, colon or dash');
  }
  return value;
}

function canonicalProjectPath(value) {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsoluteWorkspacePath(value)) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_PROJECT_PATH_INVALID', 'projectPath must be an absolute local workspace path or a valid SSH workspace URI');
  }
  try {
    if (isSshWorkspaceUri(value)) return parseSshWorkspace(value).uri;
    const normalized = normalizeWorkspacePath(value);
    if (!normalized || !isAbsolute(normalized)) {
      throw new Error('local workspace path is not absolute after normalization');
    }
    return normalized;
  } catch (error) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_PROJECT_PATH_INVALID', error.message, error);
  }
}

function canonicalInput(value) {
  if (!isRecord(value)) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_INVALID', 'attachment must be an object');
  }
  assertExactFields(value, INPUT_FIELDS, 'attachment input');
  return {
    sessionId: canonicalSessionId(value.sessionId),
    agentId: canonicalAgentId(value.agentId),
    targetId: canonicalTargetId(value.targetId),
    projectPath: canonicalProjectPath(value.projectPath),
  };
}

function canonicalRevision(value, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_REVISION_INVALID', `revision must be a safe integer of at least ${minimum}`);
  }
  return value;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', 'updatedAt must be a canonical ISO timestamp');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', 'updatedAt must be a canonical ISO timestamp');
  }
  return value;
}

function emptyAgentAttachments() {
  return { version: AGENT_ATTACHMENTS_VERSION, attachments: {} };
}

function validateRecord(value, key) {
  if (!isRecord(value)) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', `attachment ${key} must be an object`);
  }
  assertExactFields(value, RECORD_FIELDS, `attachment ${key}`);
  if (!CALLER_KEY_PATTERN.test(key)) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', `attachment key ${key} must be a SHA-256 hex digest`);
  }
  const record = {
    sessionId: canonicalSessionId(value.sessionId),
    agentId: canonicalAgentId(value.agentId),
    targetId: canonicalTargetId(value.targetId),
    projectPath: canonicalProjectPath(value.projectPath),
    revision: canonicalRevision(value.revision),
    updatedAt: canonicalTimestamp(value.updatedAt),
  };
  for (const field of RECORD_FIELDS) {
    if (record[field] !== value[field]) {
      throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', `attachment ${key} field ${field} is not canonical`);
    }
  }
  return record;
}

function validateState(value) {
  if (!isRecord(value) || value.version !== AGENT_ATTACHMENTS_VERSION) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_SCHEMA_UNSUPPORTED',
      `expected version ${AGENT_ATTACHMENTS_VERSION}, received ${value && value.version}`);
  }
  assertExactFields(value, TOP_LEVEL_FIELDS, 'agent attachments registry');
  if (!isRecord(value.attachments)) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', 'attachments must be an object');
  }
  const attachments = {};
  for (const key of Object.keys(value.attachments)) {
    attachments[key] = validateRecord(value.attachments[key], key);
  }
  return { version: AGENT_ATTACHMENTS_VERSION, attachments };
}

function readAgentAttachments(filePath) {
  if (!filePath) return emptyAgentAttachments();
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyAgentAttachments();
    throw agentAttachmentsError('AGENT_ATTACHMENTS_READ_FAILED',
      `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', `failed to parse ${filePath}`, error);
  }
  return validateState(parsed);
}

function writeAgentAttachments(filePath, state) {
  const target = resolve(filePath);
  const validated = validateState(state);
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw agentAttachmentsError('AGENT_ATTACHMENTS_WRITE_FAILED',
      `failed to persist ${target}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
  return validated;
}

export function resolveAgentAttachmentsFile(env = process.env) {
  const configured = String(env?.CURSOR_BRIDGE_AGENT_ATTACHMENTS_FILE || '').trim();
  if (configured) return resolve(configured);
  const appData = String(env?.APPDATA || '').trim();
  const configRoot = appData && isAbsolute(appData)
    ? appData
    : join(homedir(), 'AppData', 'Roaming');
  return resolve(configRoot, 'cursor-bridge', 'agent-attachments-v1.json');
}

/** Return a detached copy of this caller's explicit Agent attachment, or null. */
export function getAgentAttachment(filePath, callerKey) {
  const storageKey = callerStorageKey(callerKey);
  const state = readAgentAttachments(filePath);
  const record = Object.hasOwn(state.attachments, storageKey) ? state.attachments[storageKey] : null;
  return record ? { ...record } : null;
}

/** CAS-create or replace this caller's explicit Agent attachment. */
export async function setAgentAttachment(filePath, callerKey, input, options = {}) {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_PATH_REQUIRED', 'file must be a non-empty path');
  }
  if (!isRecord(options)) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_OPTIONS_INVALID', 'options must contain expectedRevision');
  }
  if (Object.keys(options).some(field => !OPTIONS_FIELDS.includes(field))) {
    throw agentAttachmentsError('AGENT_ATTACHMENTS_INVALID', 'attachment options contain unsupported fields');
  }
  if (!Object.hasOwn(options, 'expectedRevision')) {
    throw agentAttachmentsError('AGENT_ATTACHMENT_REVISION_REQUIRED', 'expectedRevision is required');
  }
  const expectedRevision = canonicalRevision(options.expectedRevision, { allowZero: true });
  const value = canonicalInput(input);
  const storageKey = callerStorageKey(callerKey);
  const target = resolve(filePath);
  return withInterprocessLock(`${target}.lock`, async () => {
    const state = readAgentAttachments(target);
    const current = Object.hasOwn(state.attachments, storageKey) ? state.attachments[storageKey] : null;
    if (expectedRevision === 0 && current) {
      throw agentAttachmentsError('AGENT_ATTACHMENT_REVISION_CONFLICT', 'expected an absent attachment at revision 0');
    }
    if (expectedRevision > 0 && (!current || current.revision !== expectedRevision)) {
      throw agentAttachmentsError('AGENT_ATTACHMENT_REVISION_CONFLICT',
        `expected revision ${expectedRevision}, received ${current ? current.revision : 'absent'}`);
    }
    const record = {
      ...value,
      revision: (current?.revision || 0) + 1,
      updatedAt: new Date().toISOString(),
    };
    state.attachments[storageKey] = record;
    writeAgentAttachments(target, state);
    return { ...record };
  });
}
