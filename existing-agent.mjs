import { fileURLToPath } from 'node:url';
import { makeClient } from './cdp-client.mjs';
import { EXPR_SSH_WINDOW_IDENTITY, inspectSshWindowIdentity } from './ssh-window-identity.mjs';
import { isSshWorkspaceUri, parseSshWorkspace } from './remote-workspace.mjs';
import { normalizeWorkspacePath } from './workspace-binding.mjs';
import { createCursorSessionId, updateCursorSessionRegistry } from './cursor-session-registry.mjs';
import { getAgentAttachment, setAgentAttachment, resolveAgentAttachmentsFile } from './agent-attachments.mjs';

const active = s => !!(s.activeTaskId || ['creating', 'busy', 'needs_attention'].includes(s.state));
function failure(code, message) { return Object.assign(new Error(`${code}: ${message}`), { code }); }
function localKey(path) { const key = normalizeWorkspacePath(path); return process.platform === 'win32' ? key.toLowerCase() : key; }
export function existingWindowProject(raw, expected) {
  const identity = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!identity || identity.workspace || !identity.folderUri) throw failure('AGENT_WORKSPACE_UNRESOLVED', 'One existing folder must be identified');
  const folder = identity.folderUri;
  let projectPath;
  if (identity.remoteAuthority) {
    const candidate = typeof folder === 'string' ? folder : { scheme: folder.scheme, authority: folder.authority, remotePath: folder.path };
    projectPath = parseSshWorkspace(expected || candidate).uri;
    if (!inspectSshWindowIdentity(identity, projectPath).ok) throw failure('AGENT_WORKSPACE_MISMATCH', 'The window is not the requested SSH folder');
  } else {
    let url;
    if (typeof folder === 'string') url = new URL(folder);
    else {
      if (folder.scheme !== 'file' || typeof folder.path !== 'string' || !folder.path.startsWith('/')
          || folder.query || folder.fragment) throw failure('AGENT_WORKSPACE_UNRESOLVED', 'Expected a local file URI');
      url = new URL(`file://${folder.authority || ''}${encodeURI(folder.path).replaceAll('#', '%23').replaceAll('?', '%3F')}`);
    }
    if (url.protocol !== 'file:' || url.search || url.hash || url.username || url.password) throw failure('AGENT_WORKSPACE_UNRESOLVED', 'Expected a plain file URI');
    projectPath = normalizeWorkspacePath(fileURLToPath(url));
    if (expected && (isSshWorkspaceUri(expected) || localKey(expected) !== localKey(projectPath))) throw failure('AGENT_WORKSPACE_MISMATCH', 'The window is not the requested local folder');
  }
  return { projectPath, workspaceKind: isSshWorkspaceUri(projectPath) ? 'ssh' : 'local', identity };
}

/** Self-contained metadata probe. Never clicks, fills, or returns chat text. */
export function inspectExistingAgentDocument(document, adapterEntries) {
  const visible = n => !!(n && (n.offsetParent !== null || n.getClientRects?.().length));
  const bars = [...document.querySelectorAll('.composer-bar[data-composer-id]')].filter(visible);
  if (bars.length !== 1) return { attachable: false, reason: 'composer_ambiguous', composerCount: bars.length };
  const bar = bars[0], raw = String(bar.dataset?.composerId || '');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return { attachable: false, reason: 'composer_id_invalid' };
  const agentId = `local:${raw.toLowerCase()}`;
  const entries = (adapterEntries || []).filter(e => e.id?.toLowerCase() === agentId);
  if (entries.length !== 1 || entries[0].durable !== true || entries[0].isSelected !== true) return { attachable: false, reason: 'durable_selected_agent_unconfirmed', agentId };
  const status = String(bar.dataset?.composerStatus || '').toLowerCase();
  const idle = ['completed', 'cancelled', 'error', 'failed'].includes(status) && !entries[0].showSpinner;
  const inputs = [...bar.querySelectorAll('[contenteditable="true"].ui-prompt-input-editor__input,.tiptap.ProseMirror[contenteditable="true"],.aislash-editor-input')].filter(visible);
  const draftLength = inputs.length === 1 ? String(inputs[0].innerText || inputs[0].textContent || '').trim().length : -1;
  const attachments = [...bar.querySelectorAll('.context-pill,.composer-context-pill,.composer-context-item,.image-preview-img,[data-component="attachment-preview"],[data-testid*="attachment-preview"],input[type="file"]')]
    .filter(n => !n.closest?.('.markdown-root,.composer-messages-container,.composer-react-transcript-root'))
    .filter(n => (n.files?.length || 0) > 0 || (n.tagName !== 'INPUT' && visible(n))).length;
  const stop = [...bar.querySelectorAll('button[aria-label^="Stop"],[class*="codicon-stop"],[class*="debug-stop"]')].filter(visible).length;
  const modal = [...document.querySelectorAll('[role="dialog"],dialog[open],.monaco-dialog-box,.quick-input-widget,[data-component="menu-backdrop"]')].some(visible);
  const md = [...document.querySelectorAll('.markdown-root,.aichat-container [class*=markdown]')]
    .filter(n => visible(n) && !n.closest?.('.ui-model-picker__trigger,[class*=model-picker]'));
  const texts = md.map(n => String(n.innerText || '').trim()).filter(Boolean), last = texts.at(-1) || '';
  let hash = 0; for (let i = 0; i < last.length; i++) hash = ((hash << 5) - hash + last.charCodeAt(i)) | 0;
  const reason = !idle || stop ? 'agent_busy_or_unknown' : modal ? 'modal_visible' : draftLength !== 0 ? 'draft_not_empty_or_input_unknown' : attachments ? 'draft_attachments_present' : null;
  return { identityVerified: true, attachable: !reason, reason, agentId, status, draftLength, attachmentCount: attachments,
    responseBaseline: { messageCount: texts.length, replyLength: last.length, replyHash: hash } };
}
async function evaluate(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 5000 });
  if (result.exceptionDetails) throw failure('AGENT_INSPECTION_FAILED', 'The existing page probe failed');
  return JSON.parse(result.result?.value || '{}');
}

export class ExistingAgentController {
  constructor(bridge, { expression, file, createClient = makeClient } = {}) {
    this.bridge = bridge;
    this.expression = expression;
    this.file = file || resolveAgentAttachmentsFile();
    this.createClient = createClient;
  }
  async _inspectPage(page, options = {}) {
    const c = this.createClient(page.webSocketDebuggerUrl, { origin: `http://localhost:${Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223)}` });
    try {
      await c.ready;
      const workspace = existingWindowProject(await evaluate(c, EXPR_SSH_WINDOW_IDENTITY), options.workspacePath);
      const snapshot = await evaluate(c, this.expression);
      if (options.expectedAgentId && snapshot.agentId !== options.expectedAgentId) throw failure('AGENT_SELECTION_CHANGED', 'The selected Agent changed; no binding or message was made');
      return { ...snapshot, ...workspace, targetId: page.id };
    } finally { c.close(); }
  }
  async inspect(options = {}) {
    const pages = await this.bridge._listSshPages();
    const candidates = options.targetId ? pages.filter(p => p.id === options.targetId) : pages;
    if (candidates.length !== 1) throw failure('AGENT_WINDOW_AMBIGUOUS', 'Specify the exact existing target_id; no window is opened or guessed');
    return this._inspectPage(candidates[0], options);
  }
  get() {
    const binding = getAgentAttachment(this.file, this.bridge.callerKey);
    return { found: !!binding, callerIdentity: this.bridge.callerIdentity, binding,
      session: binding ? this.bridge.sessionStatus(binding.sessionId) : null };
  }
  async ensure(binding) {
    if ((this.bridge.busy || this.bridge.queue.length || this.bridge.activeParallel.size)
        && (this.bridge.projectPath !== binding.projectPath || this.bridge._lastLifecycle?.targetId !== binding.targetId)) throw failure('AGENT_WORKSPACE_BUSY', 'Finish current work before changing the attached workspace');
    const pages = await this.bridge._listSshPages();
    const page = pages.find(p => p.id === binding.targetId);
    if (!page) throw failure('AGENT_TARGET_MISSING', 'The attached window is no longer present; explicitly attach again');
    const c = this.createClient(page.webSocketDebuggerUrl, { origin: `http://localhost:${Number(process.env.CURSOR_BRIDGE_CDP_PORT || 9223)}` });
    try { await c.ready; existingWindowProject(await evaluate(c, EXPR_SSH_WINDOW_IDENTITY), binding.projectPath); }
    finally { c.close(); }
    if (this.bridge.projectPath !== binding.projectPath || this.bridge.workspaceConfirmationRequired) {
      const saved = await this.bridge._saveWorkspaceBinding(binding.projectPath);
      this.bridge.workspaceUpdatedAt = saved.updatedAt;
    }
    this.bridge.projectPath = binding.projectPath;
    this.bridge.workspaceSource = 'persistent_init';
    this.bridge.workspaceConfirmationRequired = false;
    this.bridge._lastLifecycle = { ok: true, status: 'attached-existing-agent', lifecycleMode: 'attached-existing',
      projectPath: binding.projectPath, targetId: binding.targetId, adapterPid: process.pid };
    this.bridge._lastWorkspaceBinding = { ok: true, state: 'existing-agent-window-verified',
      projectPath: binding.projectPath, targetId: binding.targetId, agentId: binding.agentId,
      checkedAt: new Date().toISOString() };
  }
  async verify(client, job, stage) {
    existingWindowProject(await evaluate(client, EXPR_SSH_WINDOW_IDENTITY), job.existingAgentTarget.projectPath);
    if (['before_fill', 'before_send', 'before_send_fallback', 'before_read_reply', 'before_stop'].includes(stage)) {
      const snapshot = await evaluate(client, this.expression);
      if (snapshot.agentId !== job.agentId || snapshot.identityVerified !== true) throw failure('AGENT_SELECTION_CHANGED', 'The exact attached Agent is not confirmed');
      if (stage === 'before_fill' && !snapshot.attachable) throw failure('AGENT_DRAFT_OR_BUSY', snapshot.reason || 'The existing Agent is not ready');
      if (stage === 'before_send' && (snapshot.reason !== 'draft_not_empty_or_input_unknown'
          || snapshot.draftLength <= 0 || snapshot.attachmentCount !== 0)) {
        throw failure('AGENT_INPUT_CHANGED', 'The attached input or foreground state changed before submission');
      }
      if (stage === 'before_send_fallback' && snapshot.reason === 'modal_visible') throw failure('AGENT_INPUT_CHANGED', 'A foreground blocker appeared after submission');
    }
  }
  async attach(options = {}) {
    if (!/^local:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(options.expectedAgentId || '')) throw failure('AGENT_ASSERTION_REQUIRED', 'Inspect first and supply expected_agent_id');
    options = { ...options, expectedAgentId: options.expectedAgentId.toLowerCase() };
    return this.bridge._withWorkspaceAdmission(() => this.bridge._withUiLock(async () => {
      const first = await this.inspect(options);
      if (!first.attachable) throw failure('AGENT_NOT_ATTACHABLE', first.reason || 'The Agent is not ready');
      await new Promise(r => setTimeout(r, 100));
      const current = await this.inspect({ ...options, targetId: first.targetId, workspacePath: first.projectPath });
      if (!current.attachable) throw failure('AGENT_NOT_ATTACHABLE', current.reason || 'The Agent changed');
      if ((this.bridge.busy || this.bridge.queue.length || this.bridge.activeParallel.size)
          && (this.bridge.projectPath !== current.projectPath || this.bridge._lastLifecycle?.targetId !== current.targetId)) {
        throw failure('AGENT_WORKSPACE_BUSY', 'Current work must finish before attaching another workspace');
      }
      const previous = getAgentAttachment(this.file, this.bridge.callerKey);
      const now = new Date().toISOString();
      const registered = updateCursorSessionRegistry(this.bridge.sessionFile, registry => {
        const matches = Object.values(registry.sessions).filter(s => s.agentId === current.agentId);
        if (matches.some(active)) throw failure('AGENT_ALREADY_BUSY', 'An existing Bridge turn owns this Agent');
        const reusable = matches.filter(s => s.state === 'ready');
        if (reusable.length > 1) throw failure('AGENT_BINDING_AMBIGUOUS', 'Multiple existing mappings refer to this Agent');
        if (reusable.length === 1) {
          existingWindowProject(current.identity, reusable[0].projectPath);
          if (reusable[0].origin === 'attached-existing') {
            reusable[0].existingAgentTarget = { agentId: current.agentId, targetId: current.targetId, projectPath: reusable[0].projectPath };
            reusable[0].updatedAt = now;
          }
          return { session: reusable[0], reused: true };
        }
        const policies = new Set(matches.map(s => JSON.stringify({ scope: s.scopeEnvelope, writeEnabled: s.sshWriteEnabled === true })));
        if (policies.size > 1) throw failure('AGENT_POLICY_AMBIGUOUS', 'The existing policies cannot be safely inferred');
        const known = matches[0];
        for (const match of matches) existingWindowProject(current.identity, match.projectPath);
        const target = { agentId: current.agentId, targetId: current.targetId, projectPath: current.projectPath };
        const session = { id: createCursorSessionId(), state: 'ready', projectPath: current.projectPath,
          workspaceKey: this.bridge.workspaceKey, callerKey: this.bridge.callerKey,
          uiCoordinationVersion: 1, agentId: current.agentId, agentLabel: null, origin: 'attached-existing',
          existingAgentTarget: target,
          ...(isSshWorkspaceUri(current.projectPath) ? { collaborationKind: 'ssh-read-only', remoteWorkspace: parseSshWorkspace(current.projectPath) } : {}),
          // Unknown historical Agents get read-only Bridge access. Never infer or grant native write permission.
          scopeEnvelope: known ? JSON.parse(JSON.stringify(known.scopeEnvelope)) : { readOnly: true, allowedPaths: [] },
          ...(known?.sshWriteEnabled === true ? { sshWriteEnabled: true } : {}),
          modelPreference: null, turnIndex: 0, epoch: 0, activeTaskId: null, lastRequestId: null,
          lastTask: null, lease: null, responseBaseline: current.responseBaseline,
          createdAt: now, updatedAt: now, closedAt: null, recoveryState: null, attention: null };
        registry.sessions[session.id] = session;
        return { session, reused: false, knownPolicy: !!known };
      });
      const target = { agentId: current.agentId, targetId: current.targetId, projectPath: registered.session.projectPath };
      let binding;
      try {
        binding = await setAgentAttachment(this.file, this.bridge.callerKey,
          { ...target, sessionId: registered.session.id }, { expectedRevision: previous?.revision || 0 });
        await this.ensure(binding);
      } catch (error) {
        let updated = null;
        try { updated = getAgentAttachment(this.file, this.bridge.callerKey)?.sessionId === registered.session.id; } catch {}
        return { attached: true, callerBindingUpdated: updated, workspaceBound: false, warning: error.message, messageSent: false,
          ...this.bridge._sessionView(registered.session), targetId: current.targetId };
      }
      return { attached: true, callerBindingUpdated: true, workspaceBound: true, reusedSession: registered.reused, messageSent: false,
        binding, ...this.bridge._sessionView(registered.session), targetId: current.targetId,
        permissionPolicy: registered.reused || registered.knownPolicy ? 'saved-bridge-policy-unchanged' : 'read-only-bridge-access' };
    }));
  }
  async send(prompt, options = {}) {
    if (options.readOnly !== undefined && typeof options.readOnly !== 'boolean') throw failure('AGENT_TASK_MODE_INVALID', 'read_only must be boolean');
    const binding = getAgentAttachment(this.file, this.bridge.callerKey);
    if (!binding) throw failure('AGENT_NOT_ATTACHED', 'Explicitly attach the intended existing Agent first');
    const session = this.bridge._readSession(binding.sessionId);
    if (!session || session.agentId !== binding.agentId) throw failure('AGENT_BINDING_MISMATCH', 'The saved Agent association changed');
    const readOnly = options.readOnly === undefined ? session.scopeEnvelope?.readOnly === true : options.readOnly;
    return this.bridge.doTask(prompt, { ...options, readOnly, readOnlySpecified: true,
      allowedPaths: readOnly ? [] : session.scopeEnvelope?.allowedPaths || [], allowedPathsSpecified: true,
      sessionMode: 'continue', sessionId: session.id, execution: 'parallel_agent',
      workspacePath: binding.projectPath, existingAgentTarget: binding });
  }
}
