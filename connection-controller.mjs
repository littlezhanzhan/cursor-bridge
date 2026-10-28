import { parseSshWorkspace } from './remote-workspace.mjs';
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
  }

  list() {
    return { connections: listNamedConnections(this.file), defaultBehavior: 'continue-saved-session' };
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

  get(name) {
    const connection = this._require(name);
    const session = connection.sessionId ? this.bridge._readSession(connection.sessionId) : null;
    return { ...connection, workspace: parseSshWorkspace(connection.uri),
      defaultBehavior: connection.sessionId ? 'continue' : 'create-first-session',
      session: session ? this.bridge._sessionView(session) : null,
      sessionAvailable: !connection.sessionId || !!session };
  }

  save(input, options = {}) {
    const uri = parseSshWorkspace(input.uri).uri;
    if (input.sessionId) this._session({ uri, sessionId: input.sessionId });
    return saveNamedConnection(this.file, { ...input, uri }, options);
  }

  async send(name, prompt, options = {}) {
    const connection = this._require(name);
    const requestId = typeof options.requestId === 'string' ? options.requestId.trim() : '';
    if (!requestId || requestId.length > 200) throw failure('CONNECTION_REQUEST_ID_REQUIRED', 'Supply one unique request_id of at most 200 characters for each turn');
    const previous = connection.sessionId ? this._session(connection) : null;
    if (previous?.lastRequestId === requestId) {
      // A retry is a read-only receipt lookup, including while the original sender is active.
      const taskId = previous.activeTaskId || previous.lastTask?.taskId || null;
      const task = taskId && this.bridge.tasks.get(taskId);
      return { duplicate: true, connectionName: connection.name, sessionReused: true,
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
    const sessionId = options.newSession ? undefined : connection.sessionId || undefined;
    const receipt = await this.bridge.sshSessionTurn(prompt, { ...options,
      sessionId, requestId, workspacePath: connection.uri });
    if (!receipt.sessionId) throw failure('CONNECTION_SESSION_UNBOUND', 'No durable Bridge session was returned; inspect the original task before retrying');
    let saved;
    try {
      saved = setNamedConnectionSession(this.file, connection.name, receipt.sessionId,
        { expectedRevision: connection.revision, uri: connection.uri });
    } catch (error) {
      // Submission already happened. Preserve its receipt instead of retrying or overwriting
      // a connection that another process explicitly changed in the meantime.
      return { ...receipt, connectionName: connection.name, sessionReused: !!sessionId,
        connectionUpdated: false, warningCode: 'CONNECTION_MAPPING_CHANGED_AFTER_SUBMISSION',
        warning: `${error.message}; the task was already submitted. Collect that exact task; do not resend automatically.` };
    }
    return { ...receipt, connectionName: saved.name, sessionReused: !!sessionId,
      connectionUpdated: true, connectionRevision: saved.revision, workspaceUri: saved.uri };
  }
}
