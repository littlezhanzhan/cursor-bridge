import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  getAgentAttachment,
  resolveAgentAttachmentsFile,
  setAgentAttachment,
} from '../agent-attachments.mjs';

const URI = 'vscode-remote://ssh-remote+DevBox/home/Alice/Project';
const SESSION_A = 'cursor-session-550e8400-e29b-41d4-a716-446655440000';
const SESSION_B = 'cursor-session-6ba7b810-9dad-41d1-80b4-00c04fd430c8';
const AGENT_A = 'local:11111111-1111-4111-8111-111111111111';
const AGENT_B = 'local:22222222-2222-4222-8222-222222222222';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cursor-agent-attachments-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    file: join(dir, 'config', 'agent-attachments-v1.json'),
    localPath: resolve(join(dir, 'LocalProject')),
    sharedConnections: join(dir, 'connections-v1.json'),
    sessionRegistry: join(dir, 'sessions-v1.json'),
  };
}

function attachment(sessionId, agentId, targetId, projectPath) {
  return { sessionId, agentId, targetId, projectPath };
}

function spawnWriter(file, callerKey, value) {
  const moduleUrl = new URL('../agent-attachments.mjs', import.meta.url).href;
  const source = `
    import { setAgentAttachment } from ${JSON.stringify(moduleUrl)};
    const [file, callerKey, sessionId, agentId, targetId, projectPath] = process.argv.slice(1);
    try {
      const result = await setAgentAttachment(file, callerKey, { sessionId, agentId, targetId, projectPath }, {
        expectedRevision: 0,
      });
      process.stdout.write(JSON.stringify(result));
    } catch (error) {
      console.error(error.stack || error);
      process.exitCode = 1;
    }
  `;
  return new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source,
      file, callerKey, value.sessionId, value.agentId, value.targetId, value.projectPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', rejectChild);
    child.once('close', code => {
      if (code === 0) resolveChild(JSON.parse(stdout));
      else rejectChild(new Error(stderr.trim() || `writer exited with ${code}`));
    });
  });
}

test('default path uses APPDATA and the dedicated override', t => {
  const { dir } = fixture(t);
  const appData = join(dir, 'Roaming');
  assert.equal(resolveAgentAttachmentsFile({ APPDATA: appData }),
    join(appData, 'cursor-bridge', 'agent-attachments-v1.json'));
  const override = join(dir, 'custom', 'attachments.json');
  assert.equal(resolveAgentAttachmentsFile({ APPDATA: appData, CURSOR_BRIDGE_AGENT_ATTACHMENTS_FILE: override }), resolve(override));
});

test('local Windows workspace and case-preserving SSH workspace round-trip per caller', async t => {
  const f = fixture(t);
  const local = await setAgentAttachment(f.file, 'codex-thread:local',
    attachment(SESSION_A, AGENT_A, 'target-local-1', f.localPath), { expectedRevision: 0 });
  const remote = await setAgentAttachment(f.file, 'codex-thread:ssh',
    attachment(SESSION_B, AGENT_B, 'target-ssh-1', URI), { expectedRevision: 0 });

  assert.equal(local.revision, 1);
  assert.equal(local.projectPath, f.localPath);
  assert.equal(remote.revision, 1);
  assert.equal(remote.projectPath, URI);
  assert.equal(remote.sessionId, SESSION_B);
  assert.equal(getAgentAttachment(f.file, 'codex-thread:local').agentId, AGENT_A);
  assert.equal(getAgentAttachment(f.file, 'codex-thread:ssh').agentId, AGENT_B);
  assert.equal(getAgentAttachment(f.file, 'different-caller'), null);

  const detached = getAgentAttachment(f.file, 'codex-thread:ssh');
  detached.agentId = AGENT_A;
  assert.equal(getAgentAttachment(f.file, 'codex-thread:ssh').agentId, AGENT_B, 'reads return detached copies');
  const registry = JSON.parse(readFileSync(f.file, 'utf8'));
  assert.equal(registry.version, 1);
  assert.equal(Object.keys(registry.attachments).length, 2);
  assert.ok(Object.keys(registry.attachments).every(key => /^[0-9a-f]{64}$/.test(key)));
  assert.equal(JSON.stringify(registry).includes('codex-thread:ssh'), false, 'raw caller identity is not stored');
});

test('revision zero creates once and positive revisions use compare-and-swap', async t => {
  const f = fixture(t);
  const first = await setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, 'target-1', URI), {
    expectedRevision: 0,
  });
  assert.equal(first.revision, 1);
  const detached = getAgentAttachment(f.file, 'caller');
  detached.revision = 99;
  assert.equal(getAgentAttachment(f.file, 'caller').revision, 1, 'reads return detached copies');
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_B, AGENT_B, 'target-2', URI), {
    expectedRevision: 0,
  }), { code: 'AGENT_ATTACHMENT_REVISION_CONFLICT' });

  const second = await setAgentAttachment(f.file, 'caller', attachment(SESSION_B, AGENT_B, 'target-2', URI), {
    expectedRevision: 1,
  });
  assert.equal(second.revision, 2);
  assert.equal(getAgentAttachment(f.file, 'caller').sessionId, SESSION_B);
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, 'target-1', URI), {
    expectedRevision: 1,
  }), { code: 'AGENT_ATTACHMENT_REVISION_CONFLICT' });
  await assert.rejects(setAgentAttachment(f.file, 'new-caller', attachment(SESSION_A, AGENT_A, 'target-1', URI)), {
    code: 'AGENT_ATTACHMENT_REVISION_REQUIRED',
  });
});

test('invalid fields, identities, target IDs, and paths are rejected', async t => {
  const f = fixture(t);
  const valid = attachment(SESSION_A, AGENT_A, 'target-valid', URI);
  await assert.rejects(setAgentAttachment(f.file, 'caller', { ...valid, label: 'title' }, { expectedRevision: 0 }), {
    code: 'AGENT_ATTACHMENTS_INVALID',
  });
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment('session-a', AGENT_A, 'target', URI), { expectedRevision: 0 }), {
    code: 'AGENT_ATTACHMENT_SESSION_ID_INVALID',
  });
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, 'agent-a', 'target', URI), { expectedRevision: 0 }), {
    code: 'AGENT_ATTACHMENT_AGENT_ID_INVALID',
  });
  for (const targetId of ['', 'target with space', 'tärget', 'bad\0id']) {
    await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, targetId, URI), { expectedRevision: 0 }), {
      code: 'AGENT_ATTACHMENT_TARGET_ID_INVALID',
    });
  }
  for (const projectPath of ['relative/project', 'vscode-remote://ssh-remote+host',
    'vscode-remote://ssh-remote+host/home/project?query=1', 'C:\\bad\0path']) {
    await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, 'target', projectPath), { expectedRevision: 0 }), {
      code: 'AGENT_ATTACHMENT_PROJECT_PATH_INVALID',
    });
  }
  await assert.rejects(setAgentAttachment(f.file, 'caller', valid, { expectedRevision: 0, extra: true }), {
    code: 'AGENT_ATTACHMENTS_INVALID',
  });
  assert.equal(existsSync(f.file), false, 'rejected inputs must not create the attachment file');
});

test('corrupt or unsupported registries fail closed and remain unchanged', async t => {
  const f = fixture(t);
  mkdirSync(join(f.dir, 'config'), { recursive: true });
  writeFileSync(f.file, '{not json', 'utf8');
  const corruptBytes = readFileSync(f.file, 'utf8');
  assert.throws(() => getAgentAttachment(f.file, 'caller'), { code: 'AGENT_ATTACHMENTS_INVALID' });
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, 'target', URI), {
    expectedRevision: 0,
  }), { code: 'AGENT_ATTACHMENTS_INVALID' });
  assert.equal(readFileSync(f.file, 'utf8'), corruptBytes);

  const unsupported = JSON.stringify({ version: 99, attachments: {} });
  writeFileSync(f.file, unsupported, 'utf8');
  assert.throws(() => getAgentAttachment(f.file, 'caller'), { code: 'AGENT_ATTACHMENTS_SCHEMA_UNSUPPORTED' });
  await assert.rejects(setAgentAttachment(f.file, 'caller', attachment(SESSION_A, AGENT_A, 'target', URI), {
    expectedRevision: 0,
  }), { code: 'AGENT_ATTACHMENTS_SCHEMA_UNSUPPORTED' });
  assert.equal(readFileSync(f.file, 'utf8'), unsupported);

  const unknownFields = JSON.stringify({ version: 1, attachments: { ['a'.repeat(64)]: {
    sessionId: SESSION_A, agentId: AGENT_A, targetId: 'target', projectPath: URI,
    revision: 1, updatedAt: new Date().toISOString(), extra: true,
  } } });
  writeFileSync(f.file, unknownFields, 'utf8');
  assert.throws(() => getAgentAttachment(f.file, 'caller'), { code: 'AGENT_ATTACHMENTS_INVALID' });
  assert.equal(readFileSync(f.file, 'utf8'), unknownFields);
});

test('concurrent child processes add independent callers without lost updates or touching other registries', async t => {
  const f = fixture(t);
  writeFileSync(f.sharedConnections, '{"sentinel":"named connections"}\n', 'utf8');
  writeFileSync(f.sessionRegistry, '{"sentinel":"session registry"}\n', 'utf8');
  const sharedBytes = readFileSync(f.sharedConnections, 'utf8');
  const sessionBytes = readFileSync(f.sessionRegistry, 'utf8');
  const writers = await Promise.all([0, 1].map(index => spawnWriter(f.file, `caller-${index}`, attachment(
    index === 0 ? SESSION_A : SESSION_B,
    index === 0 ? AGENT_A : AGENT_B,
    `target-${index}`,
    index === 0 ? f.localPath : URI,
  ))));
  assert.equal(writers.length, 2);
  assert.equal(writers[0].revision, 1);
  assert.equal(writers[1].revision, 1);
  assert.equal(getAgentAttachment(f.file, 'caller-0').agentId, AGENT_A);
  assert.equal(getAgentAttachment(f.file, 'caller-1').agentId, AGENT_B);
  assert.equal(readFileSync(f.sharedConnections, 'utf8'), sharedBytes);
  assert.equal(readFileSync(f.sessionRegistry, 'utf8'), sessionBytes);
  assert.equal(existsSync(`${f.file}.lock`), false);
});
