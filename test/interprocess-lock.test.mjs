import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { withInterprocessLock } from '../interprocess-lock.mjs';

function temporaryDirectory(t, prefix = 'cursor-ui-lock-') {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function startNode(code) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function childCompletion(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  return new Promise((resolveChild, rejectChild) => {
    child.once('error', rejectChild);
    child.once('close', (code, signal) => {
      if (code === 0) resolveChild({ stdout, stderr });
      else rejectChild(new Error(`child failed: code=${code}, signal=${signal}, stdout=${stdout}, stderr=${stderr}`));
    });
  });
}

function waitForOutput(child, marker, timeoutMs = 5000) {
  let output = '';
  return new Promise((resolveOutput, rejectOutput) => {
    const timer = setTimeout(() => finish(new Error(`timed out waiting for ${marker}; output=${output}`)), timeoutMs);
    const finish = error => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) rejectOutput(error);
      else resolveOutput(output);
    };
    const onData = chunk => {
      output += chunk;
      if (output.includes(marker)) finish();
    };
    const onError = error => finish(error);
    const onClose = (code, signal) => finish(new Error(`child exited before ${marker}: code=${code}, signal=${signal}, output=${output}`));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

test('serializes multiple lock users in one process without blocking the event loop', async t => {
  const lockPath = join(temporaryDirectory(t), 'ui.lock');
  let releaseFirst;
  let firstEntered;
  const firstHasEntered = new Promise(resolveFirst => { firstEntered = resolveFirst; });
  const firstGate = new Promise(resolveFirst => { releaseFirst = resolveFirst; });
  let secondEntered = false;

  const first = withInterprocessLock(lockPath, async () => {
    firstEntered();
    await firstGate;
    return 'first';
  });
  await firstHasEntered;

  const second = withInterprocessLock(lockPath, async () => {
    secondEntered = true;
    return 'second';
  }, { waitMs: 2000, pollMs: 10 });
  let timerFired = false;
  await new Promise(resolveTimer => setTimeout(() => {
    timerFired = true;
    resolveTimer();
  }, 30));
  assert.equal(timerFired, true);
  assert.equal(secondEntered, false, 'the second callback must wait for the owner');

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
  assert.equal(secondEntered, true);
  assert.equal(existsSync(lockPath), false);
});

test('two child processes never overlap inside the critical section', async t => {
  const directory = temporaryDirectory(t, 'cursor-ui-lock-processes-');
  const lockPath = join(directory, 'ui.lock');
  const logPath = join(directory, 'intervals.log');
  const moduleUrl = new URL('../interprocess-lock.mjs', import.meta.url).href;
  const script = `
    import { appendFileSync } from 'node:fs';
    const { withInterprocessLock } = await import(${JSON.stringify(moduleUrl)});
    const lockPath = ${JSON.stringify(lockPath)};
    const logPath = ${JSON.stringify(logPath)};
    await withInterprocessLock(lockPath, async () => {
      appendFileSync(logPath, 'enter\\n');
      await new Promise(resolve => setTimeout(resolve, 100));
      appendFileSync(logPath, 'exit\\n');
    });
  `;
  const children = [startNode(script), startNode(script)];
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  await Promise.all(children.map(childCompletion));

  let active = 0;
  for (const event of readFileSync(logPath, 'utf8').trim().split(/\r?\n/)) {
    if (event === 'enter') {
      active++;
      assert.equal(active, 1, 'a second process entered before the first exited');
    } else if (event === 'exit') {
      active--;
      assert.equal(active, 0, 'an exit must balance exactly one entry');
    } else {
      assert.fail(`unexpected critical-section event: ${event}`);
    }
  }
  assert.equal(active, 0);
  assert.equal(existsSync(lockPath), false);
});

test('a thrown callback releases its owner file and lock directory', async t => {
  const lockPath = join(temporaryDirectory(t), 'ui.lock');
  const expected = new Error('callback failed');
  await assert.rejects(withInterprocessLock(lockPath, async () => { throw expected; }), error => error === expected);
  assert.equal(existsSync(lockPath), false);
  assert.equal(await withInterprocessLock(lockPath, async () => 'reacquired'), 'reacquired');
});

test('a dead owner process is reaped and the lock can be acquired again', async t => {
  const lockPath = join(temporaryDirectory(t, 'cursor-ui-lock-dead-owner-'), 'ui.lock');
  const moduleUrl = new URL('../interprocess-lock.mjs', import.meta.url).href;
  const script = `
    const { withInterprocessLock } = await import(${JSON.stringify(moduleUrl)});
    await withInterprocessLock(${JSON.stringify(lockPath)}, async () => {
      process.stdout.write('READY\\n');
      await new Promise(() => {});
    });
  `;
  const child = startNode(script);
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const completion = childCompletion(child);
  await waitForOutput(child, 'READY');
  child.kill();
  await assert.rejects(completion, /child failed/);

  let entered = false;
  assert.equal(await withInterprocessLock(lockPath, async () => {
    entered = true;
    return 'recovered';
  }, { waitMs: 2000, pollMs: 10 }), 'recovered');
  assert.equal(entered, true);
  assert.equal(existsSync(lockPath), false);
});

test('an old owner file for a live PID is never stolen', async t => {
  const lockPath = join(temporaryDirectory(t, 'cursor-ui-lock-live-owner-'), 'ui.lock');
  mkdirSync(lockPath);
  const ownerName = `${process.pid}-${randomUUID()}.owner`;
  const ownerPath = join(lockPath, ownerName);
  const fd = openSync(ownerPath, 'wx', 0o600);
  closeSync(fd);
  const old = new Date(Date.now() - 24 * 60 * 60 * 1000);
  utimesSync(ownerPath, old, old);

  await assert.rejects(
    withInterprocessLock(lockPath, async () => 'must not enter', { waitMs: 80, pollMs: 10 }),
    error => error.code === 'UI_LOCK_BUSY' && error.lockPath === resolve(lockPath) && error.ownerPid === process.pid,
  );
  assert.equal(existsSync(ownerPath), true);
  assert.deepEqual(readdirSync(lockPath), [ownerName]);
});

test('an ownerless directory waits and times out as incomplete without deleting it', async t => {
  const lockPath = join(temporaryDirectory(t, 'cursor-ui-lock-incomplete-'), 'ui.lock');
  mkdirSync(lockPath);
  await assert.rejects(
    withInterprocessLock(lockPath, async () => 'must not enter', { waitMs: 60, pollMs: 10 }),
    error => error.code === 'LOCK_INCOMPLETE' && error.lockPath === resolve(lockPath),
  );
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(readdirSync(lockPath), []);
});

test('an ordinary file or unexpected directory entry fails closed and is preserved', async t => {
  const directory = temporaryDirectory(t, 'cursor-ui-lock-invalid-');
  const lockPathIsFile = join(directory, 'not-a-directory.lock');
  writeFileSync(lockPathIsFile, 'preserve me');
  await assert.rejects(
    withInterprocessLock(lockPathIsFile, async () => 'must not enter', { waitMs: 0 }),
    error => error.code === 'LOCK_INCOMPLETE' && error.lockPath === resolve(lockPathIsFile),
  );
  assert.equal(readFileSync(lockPathIsFile, 'utf8'), 'preserve me');

  const lockPath = join(directory, 'ui.lock');
  mkdirSync(lockPath);
  const strayPath = join(lockPath, 'operator-data.txt');
  writeFileSync(strayPath, 'preserve me too');
  await assert.rejects(
    withInterprocessLock(lockPath, async () => 'must not enter', { waitMs: 0 }),
    error => error.code === 'LOCK_INCOMPLETE' && error.lockPath === resolve(lockPath),
  );
  assert.equal(readFileSync(strayPath, 'utf8'), 'preserve me too');
});
