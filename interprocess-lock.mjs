import { randomUUID } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  lstatSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const OWNER_FILE_PATTERN = /^([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.owner$/i;

function lockError(code, message, lockPath, ownerPid = null, cause = null) {
  const owner = ownerPid === null ? '' : `, ownerPid=${ownerPid}`;
  const error = new Error(`${code}: ${message} (lockPath=${lockPath}${owner})`, cause ? { cause } : undefined);
  error.code = code;
  error.lockPath = lockPath;
  if (ownerPid !== null) error.ownerPid = ownerPid;
  return error;
}

function validateOptions(lockPath, fn, options) {
  if (typeof lockPath !== 'string' || !lockPath.trim()) {
    throw lockError('LOCK_PATH_REQUIRED', 'lockPath must be a non-empty directory path', String(lockPath || ''));
  }
  if (typeof fn !== 'function') {
    throw lockError('LOCK_CALLBACK_REQUIRED', 'fn must be a function', resolve(lockPath));
  }
  const waitMs = Number(options.waitMs ?? 120000);
  const pollMs = Number(options.pollMs ?? 40);
  if (!Number.isFinite(waitMs) || waitMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
    throw lockError('LOCK_OPTIONS_INVALID', 'waitMs must be non-negative and pollMs must be positive', resolve(lockPath));
  }
  return { lockPath: resolve(lockPath), waitMs, pollMs };
}

function inspectLockDirectory(lockPath) {
  let directoryStat;
  try {
    directoryStat = lstatSync(lockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    throw lockError('LOCK_INCOMPLETE', 'cannot inspect the lock path', lockPath, null, error);
  }
  if (!directoryStat.isDirectory()) {
    throw lockError('LOCK_INCOMPLETE', 'the lock path exists but is not a directory', lockPath);
  }

  let entries;
  try {
    entries = readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    throw lockError('LOCK_INCOMPLETE', 'cannot read the lock directory', lockPath, null, error);
  }
  if (entries.length === 0) return { state: 'incomplete', reason: 'the lock directory has no owner file yet' };
  if (entries.length !== 1) {
    throw lockError('LOCK_INCOMPLETE', 'the lock directory contains unexpected or multiple files', lockPath);
  }

  const [entry] = entries;
  const match = OWNER_FILE_PATTERN.exec(entry.name);
  const ownerPid = match ? Number(match[1]) : null;
  if (!match || !Number.isSafeInteger(ownerPid) || !entry.isFile()) {
    throw lockError('LOCK_INCOMPLETE', 'the lock directory does not contain one valid owner file', lockPath, ownerPid);
  }

  let ownerStat;
  try {
    ownerStat = lstatSync(join(lockPath, entry.name));
  } catch (error) {
    if (error && error.code === 'ENOENT') return { state: 'absent' };
    throw lockError('LOCK_INCOMPLETE', 'cannot inspect the owner file', lockPath, ownerPid, error);
  }
  if (!ownerStat.isFile() || ownerStat.size !== 0) {
    throw lockError('LOCK_INCOMPLETE', 'the owner file is not an empty regular file', lockPath, ownerPid);
  }
  return { state: 'owner', ownerPid, ownerPath: join(lockPath, entry.name) };
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM and all unknown errors are conservative: they do not prove the PID is dead.
    return !(error && error.code === 'ESRCH');
  }
}

function createOwnerFile(lockPath) {
  const ownerPath = join(lockPath, `${process.pid}-${randomUUID()}.owner`);
  let descriptor;
  try {
    descriptor = openSync(ownerPath, 'wx', 0o600);
  } catch (error) {
    // We cannot prove ownership of a path when exclusive creation failed, so leave the
    // incomplete directory untouched for fail-closed diagnosis.
    throw lockError('LOCK_INCOMPLETE', 'failed to create the unique owner file', lockPath, process.pid, error);
  }
  try {
    closeSync(descriptor);
  } catch (error) {
    let removed = false;
    try {
      unlinkSync(ownerPath);
      removed = true;
    } catch {}
    if (removed) {
      try { rmdirSync(lockPath); } catch {}
    }
    throw lockError('LOCK_INCOMPLETE', 'failed to close the unique owner file', lockPath, process.pid, error);
  }
  return { lockPath, ownerPath, ownerPid: process.pid };
}

function cleanupOwner(owner) {
  let removed = false;
  try {
    unlinkSync(owner.ownerPath);
    removed = true;
  } catch (error) {
    throw lockError('LOCK_RELEASE_FAILED', 'could not unlink this lock owner file', owner.lockPath, owner.ownerPid, error);
  }
  if (!removed) return;
  try {
    rmdirSync(owner.lockPath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw lockError('LOCK_RELEASE_FAILED', 'could not remove the now-empty lock directory', owner.lockPath, owner.ownerPid, error);
  }
}

function tryReapDeadOwner(lockPath, owner) {
  let removed = false;
  try {
    unlinkSync(owner.ownerPath);
    removed = true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw lockError('LOCK_INCOMPLETE', 'could not unlink the observed dead owner file', lockPath, owner.ownerPid, error);
  }
  if (!removed) return false;
  try {
    rmdirSync(lockPath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTEMPTY' || error.code === 'EEXIST')) return true;
    throw lockError('LOCK_INCOMPLETE', 'could not remove the empty stale lock directory', lockPath, owner.ownerPid, error);
  }
  return true;
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function acquireLock(lockPath, waitMs, pollMs) {
  const deadline = Date.now() + waitMs;
  try {
    mkdirSync(dirname(lockPath), { recursive: true });
  } catch (error) {
    throw lockError('LOCK_ACQUIRE_FAILED', 'could not create the parent directory', lockPath, null, error);
  }

  for (;;) {
    try {
      mkdirSync(lockPath);
      return createOwnerFile(lockPath);
    } catch (error) {
      if (!(error && error.code === 'EEXIST')) {
        if (error && error.code === 'LOCK_INCOMPLETE') throw error;
        throw lockError('LOCK_ACQUIRE_FAILED', 'could not create the lock directory', lockPath, null, error);
      }
    }

    const observed = inspectLockDirectory(lockPath);
    if (observed.state === 'absent') continue;
    if (observed.state === 'owner' && !isProcessAlive(observed.ownerPid)) {
      // Only the process that successfully unlinks this exact observed token may try
      // rmdir. In particular, ENOENT must never authorize removing a replacement lock.
      tryReapDeadOwner(lockPath, observed);
      continue;
    }

    if (Date.now() >= deadline) {
      if (observed.state === 'incomplete') {
        throw lockError('LOCK_INCOMPLETE', observed.reason, lockPath);
      }
      throw lockError('UI_LOCK_BUSY', 'another live process owns the UI lock', lockPath, observed.ownerPid);
    }
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/**
 * Run fn while holding an inter-process directory lock.
 * A live PID is never displaced based on age; only a confirmed-dead owner can be reaped.
 */
export async function withInterprocessLock(lockPath, fn, options = {}) {
  const validated = validateOptions(lockPath, fn, options);
  const owner = await acquireLock(validated.lockPath, validated.waitMs, validated.pollMs);
  let result;
  let operationError = null;
  try {
    result = await fn();
  } catch (error) {
    operationError = error;
  }

  let releaseError = null;
  try {
    cleanupOwner(owner);
  } catch (error) {
    releaseError = error;
  }
  if (operationError && releaseError) {
    const combined = new AggregateError([operationError, releaseError], 'The locked operation failed and its lock could not be fully released', { cause: operationError });
    combined.code = 'LOCK_RELEASE_FAILED';
    combined.lockPath = validated.lockPath;
    combined.ownerPid = owner.ownerPid;
    throw combined;
  }
  if (releaseError) throw releaseError;
  if (operationError) throw operationError;
  return result;
}
