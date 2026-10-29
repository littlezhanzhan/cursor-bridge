const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Host call metadata wins over startup environment. Never use cwd as chat identity. */
export function resolveCallerIdentity({ meta, env = process.env, instanceId } = {}) {
  const supplied = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta.threadId : undefined;
  const raw = supplied === undefined ? String(env.CODEX_THREAD_ID || '').trim() : supplied;
  if (supplied !== undefined || raw) {
    if (typeof raw !== 'string' || !THREAD_ID.test(raw)) {
      throw Object.assign(new Error('CALLER_IDENTITY_INVALID: threadId must be a UUID'), { code: 'CALLER_IDENTITY_INVALID' });
    }
    return { key: `codex-thread:${raw.toLowerCase()}`, source: supplied === undefined ? 'environment' : 'mcp-threadId', persistent: true };
  }
  if (!instanceId) throw Object.assign(new Error('CALLER_IDENTITY_REQUIRED: no adapter identity'), { code: 'CALLER_IDENTITY_REQUIRED' });
  return { key: `adapter:${instanceId}`, source: 'adapter-instance', persistent: false };
}

/** Each caller gets its own mutable task/workspace state even on a shared MCP transport. */
export class CallerBridgePool {
  constructor(defaultBridge, createBridge, { env = process.env } = {}) {
    this.defaultBridge = defaultBridge;
    this.createBridge = createBridge;
    this.env = env;
    this.bridges = new Map([[defaultBridge.callerIdentity.key, defaultBridge]]);
  }

  forRequest(request) {
    const identity = resolveCallerIdentity({ meta: request?.params?._meta, env: this.env,
      instanceId: this.defaultBridge.sessionInstanceId });
    if (!this.bridges.has(identity.key)) this.bridges.set(identity.key, this.createBridge(identity));
    return this.bridges.get(identity.key);
  }
}
