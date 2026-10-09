// Turning the paths in shell commands into absolute paths, and deciding which ones don't
// matter: devices, temporary folders and git's own files.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WINDOWS = process.platform === 'win32';
const CASE_INSENSITIVE = WINDOWS || process.platform === 'darwin';
const DEVICES = /^(nul|con|prn|aux|com\d|lpt\d)(\.[^\\/]*)?$/i;
const TEMP_VAR = /^(\$\{?|\$env:|%)(TMPDIR|TMP|TEMP|RUNNER_TEMP)\b/i;

function fold(p) {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

function tempRoots() {
  const roots = [os.tmpdir(), '/tmp', '/var/tmp', '/private/tmp', '/private/var/folders'];
  return [...new Set(roots.filter(Boolean).map((r) => fold(path.resolve(r))))];
}

function under(p, root) {
  const rel = path.relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Resolves a path as written in a command. Returns { text, abs } where abs is null when the
// path depends on a variable or command substitution that can't be worked out here.
export function resolvePath(text, cwd, shell = 'bash') {
  let p = String(text);
  if (TEMP_VAR.test(p)) {
    p = p.replace(TEMP_VAR, '').replace(/^\}?%?/, '');
    return { text, abs: path.join(os.tmpdir(), p.replace(/^[\\/]+/, '')) };
  }
  p = p.replace(/^(\$\{?HOME\}?|\$env:USERPROFILE|\$HOME|%USERPROFILE%)(?=$|[\\/])/i, os.homedir());
  if (shell === 'pwsh') p = p.replace(/^\$PWD(?=$|[\\/])/i, cwd || '.');
  if (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) p = path.join(os.homedir(), p.slice(1));
  if (/[$`%]/.test(p)) return { text, abs: null };
  if (WINDOWS) {
    const drive = /^\/([a-zA-Z])(\/|$)/.exec(p);
    if (drive) p = drive[1].toUpperCase() + ':\\' + p.slice(3);
    else if (p === '/tmp' || p.startsWith('/tmp/')) p = path.join(os.tmpdir(), p.slice(4));
  }
  return { text, abs: path.resolve(cwd || '.', p) };
}

// True for paths whose changes don't need the file tools: devices, temporary folders and
// git's own .git folder.
export function isExempt(text, abs) {
  const t = String(text);
  if (/^\/dev\//.test(t) || /^\/(proc|sys)\//.test(t)) return true;
  if (DEVICES.test(t)) return true;
  if (TEMP_VAR.test(t)) return true;
  if (!abs) return false;
  const p = fold(abs);
  if (DEVICES.test(path.basename(abs))) return true;
  if (p.split(/[\\/]/).includes('.git')) return true;
  return tempRoots().some((root) => under(p, root));
}

export function isFile(abs) {
  try {
    return abs ? fs.statSync(abs).isFile() : false;
  } catch {
    return false;
  }
}

export function exists(abs) {
  try {
    return abs ? fs.existsSync(abs) : false;
  } catch {
    return false;
  }
}

// How to name a path in a message: relative to the working folder when it's inside it.
export function display(abs, cwd, fallback) {
  if (!abs) return fallback;
  if (cwd) {
    const rel = path.relative(cwd, abs);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return abs;
}
