import { parseSshWorkspace } from './remote-workspace.mjs';
import { dirname, join } from 'node:path';
import { callerConnectionKey, getCallerConnection, setCallerConnectionSession } from './caller-connections.mjs';
import { withInterprocessLock } from './interprocess-lock.mjs';
import {
  resolveNamedConnectionsFile, getNamedConnection, listNamedConnections,
  saveNamedConnection, setNamedConnectionSession,
} from './named-connections.mjs';

function failure(code, message) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  return error;
}

/** Persistent names belong to the user, not a Codex thread or process cwd. */
export class NamedConnectionController {
  constructor(bridge, options = {}) {
    this.bridge = bridge;
    this.file = options.file || resolveNamedConnectionsFile();
    this.callerFile = options.callerFile || process.env.CURSOR_BRIDGE_CALLER_CONNECTIONS_FILE
      || join(dirname(this.file), 'caller-connections-v1.json');
  }

  _scope(value = 'caller') {
    if (!['caller', 'shared'].includes(value)) throw failure('CONNECTION_SESSION_SCOPE_INVALID', 'session_scope must be caller or shared');
    return value;
  }

  _binding(connection, scope) {
    return scope === 'shared' ? connection : getCallerConnection(this.callerFile, this.bridge.callerKey, connection);
  }

  list(options = {}) {
    const scope = this._scope(options.sessionScope);
    return { connections: listNamedConnections(this.file).map(c => this.get(c.name, { sessionScope: scope })),
      defaultBehavior: scope === 'caller' ? 'caller-isolated' : 'explicit-shared-session' };
  }

  _require(name) {
    const connection = getNamedConnection(this.file, name);
    if (!connection) throw failure('CONNECTION_NOT_FOUND', `No saved connection named ${name}; list saved names or explicitly save the target once`);
    return connection;
  }

  _session(connection, sessionId = connection.sessionId) {
    if (!sessionId) return null;
    const session = this.bridge._readSession(sessionId);
    if (!session) throw failure('CONNECTION_SESSION_NOT_FOUND', 'The saved session is absent from this adapter\'s shared session registry; do not silently create a replacement');
    if (parseSshWorkspace(session.projectPath).uri !== connection.uri
        || session.collaborationKind !== 'ssh-read-only'
        || session.scopeEnvelope?.readOnly !== true || (!session.agentId && !session.activeTaskId)) {
      throw failure('CONNECTION_SESSION_MISMATCH', 'The saved session must have the same exact SSH workspace, a bound Agent, and a read-only scope');
    }
    return session;
  }

  get(name, options = {}) {
    const connection = this._require(name);
    const scope = this._scope(options.sessionScope);
    const binding = this._binding(connection, scope);
    const sessionId = binding?.sessionId || null;
    const session = sessionId ? this.bridge._readSession(sessionId) : null;
    return { ...connection, sessionId, ...(scope === 'shared' ? { sharedSessionId: connection.sessionId } : {}), sessionScope: scope,
      callerIdentity: this.bridge.callerIdentity, callerBindingRevision: scope === 'caller' ? binding?.revision || 0 : null,
      workspace: parseSshWorkspace(connection.uri),
      defaultBehavior: sessionId ? `continue-${scope}-session` : `create-first-${scope}-session`,
      session: session ? this.bridge._sessionView(session) : null,
      sessionAvailable: !sessionId || !!session };
  }

  save(input, options = {}) {
    const uri = parseSshWorkspace(input.uri).uri;
    if (input.sessionId) this._session({ uri, sessionId: input.sessionId });
    return saveNamedConnection(this.file, { ...input, uri }, options);
  }

  async send(name, prompt, options = {}) {
    const selected = this._require(name);
    const sessionScope = this._scope(options.sessionScope);
    const lockKey = callerConnectionKey(sessionScope === 'shared' ? 'explicit-shared' : this.bridge.callerKey, selected.name, selected.uri);
    let receipt;
    try {
      return await withInterprocessLock(join(dirname(this.callerFile), 'connection-dispatch', `${lockKey}.lock`),
        async () => (receipt = await this._send(name, prompt, { ...options, sessionScope }, selected.uri)));
    } catch (error) {
      if (!receipt?.taskId) throw error;
      return { ...receipt, warningCode: 'CONNECTION_DISPATCH_LOCK_RELEASE_FAILED',
        warning: `${error.message}; the task was already submitted. Collect its exact taskId and do not resend automatically.` };
    }
  }

  async _send(name, prompt, options, selectedUri) {
    const connection = this._require(name);
    if (connection.uri !== selectedUri) throw failure('CONNECTION_MAPPING_CHANGED', 'The named target changed while waiting; no prompt was submitted');
    const binding = this._binding(connection, options.sessionScope);
    const scopedSessionId = binding?.sessionId || null;
    const routing = { sessionScope: options.sessionScope, callerIdentity: this.bridge.callerIdentity };
    const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
    if (!requestId || requestId.length > 200) throw failure('CONNECTION_REQUEST_ID_REQUIRED', 'Supply one unique request_id of at most 200 characters for each turn');
    const previous = scopedSessionId ? this._session(connection, scopedSessionId) : null;
    if (previous?.lastRequestId === requestId) {
      // A retry is a read-only receipt lookup, including while the original sender is active.
      const taskId = previous.activeTaskId || previous.lastTask?.taskId || null;
      const task = taskId && this.bridge.tasks.get(taskId);
      return { ...routing, duplicate: true, connectionName: connection.name, sessionReused: true,
        ...(task ? this.bridge._compactTaskView(task) : this.bridge._sessionView(previous)),
        taskId, taskProcessLocal: !!task, connectionRevision: connection.revision };
    }
    if (previous && !options.newSession && (previous.activeTaskId
        || ['creating', 'busy', 'needs_attention'].includes(previous.state))) {
      throw failure('CONNECTION_SESSION_BUSY', `Session ${previous.id} needs completion or explicit reconciliation; no prompt was sent`);
    }
    if (previous && !options.newSession && ['closed', 'failed'].includes(previous.state)) {
      throw failure('CONNECTION_SESSION_CLOSED', 'The saved session cannot continue; request new_session=true only when a new Agent is intended');
    }

    // The user selected the saved name. Revalidate the real window on every adapter.
    await this.bridge.initializeSshWorkspace(connection.uri, { targetId: options.targetId || '' });
    const sessionId = options.newSession ? undefined : scopedSessionId || undefined;
    const receipt = await this.bridge.sshSessionTurn(prompt, { ...options,
      sessionId, requestId, workspacePath: connection.uri });
    if (!receipt.sessionId) throw failure('CONNECTION_SESSION_UNBOUND', 'No durable Bridge session was returned; inspect the original task before retrying');
    let saved;
    try {
      if (this._require(connection.name).uri !== connection.uri) throw failure('CONNECTION_MAPPING_CHANGED', 'The named target changed during submission');
      saved = options.sessionScope === 'shared'
        ? setNamedConnectionSession(this.file, connection.name, receipt.sessionId,
          { expectedRevision: connection.revision, uri: connection.uri })
        : setCallerConnectionSession(this.callerFile, this.bridge.callerKey, connection, receipt.sessionId,
          { expectedRevision: binding?.revision || 0 });
    } catch (error) {
      // Submission already happened. Preserve its receipt instead of retrying or overwriting
      // a connection that another process explicitly changed in the meantime.
      return { ...routing, ...receipt, connectionName: connection.name, sessionReused: !!sessionId,
        connectionUpdated: false, warningCode: 'CONNECTION_MAPPING_CHANGED_AFTER_SUBMISSION',
        warning: `${error.message}; the task was already submitted. Collect that exact task; do not resend automatically.` };
    }
    return { ...routing, ...receipt, connectionName: connection.name, sessionReused: !!sessionId,
      connectionUpdated: options.sessionScope === 'shared', callerBindingUpdated: options.sessionScope === 'caller',
      connectionRevision: options.sessionScope === 'shared' ? saved.revision : connection.revision,
      callerBindingRevision: options.sessionScope === 'caller' ? saved.revision : null, workspaceUri: saved.uri };
  }
}
