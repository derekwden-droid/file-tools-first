// Finds the parts of a shell command that read or write files the way Claude's file tools
// should: a single-file read (cat, head -n, sed -n 'A,Bp'), an in-place edit (sed -i,
// perl -i), text written into a file (echo or a here-document redirected into it, tee), and
// inline scripts that rewrite an existing file. Everything else is left alone.

import { commandOf, literalText, parseBash } from './bash.mjs';
import { isExempt, isFile, resolvePath } from './paths.mjs';

const NEUTRAL = new Set(['cd', 'pushd', 'popd', 'true', ':', 'echo', 'printf', 'pwd']);
const PRODUCERS = new Set(['echo', 'printf']);
const WRITE_OPS = new Set(['>', '>>', '>|', '&>', '&>>']);
const SCRIPT_LANGS = { python: 'python', python3: 'python', py: 'python', node: 'node', ruby: 'ruby' };

// A word with literal text in it, as opposed to only variables or command substitutions.
function hasLiteral(word) {
  if (!word.dynamic) return word.value.trim() !== '';
  return /[A-Za-z0-9]/.test(literalText(word.value));
}

// The file a redirect writes to, or null when it writes to a descriptor.
function redirectTarget(r) {
  if (!WRITE_OPS.has(r.op) || !r.target) return null;
  if (r.fd && r.fd !== '1' && r.op !== '&>' && r.op !== '&>>') return null;
  return r.target;
}

function outputRedirects(cmd) {
  return cmd.redirects.map(redirectTarget).filter(Boolean);
}

function fileItem(kind, word, cwd, extra = {}) {
  const { abs } = resolvePath(word.value, cwd);
  return { kind, text: word.value, abs, dynamic: Boolean(word.dynamic), ...extra };
}

// sed: returns { inPlace, quiet, scripts, files }.
function parseSed(args) {
  let inPlace = false;
  let quiet = false;
  const scripts = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (v.startsWith('--')) {
      if (v === '--in-place' || v.startsWith('--in-place=')) inPlace = true;
      else if (v === '--quiet' || v === '--silent') quiet = true;
      else if (v.startsWith('--expression=')) scripts.push(v.slice(13));
      else if (v === '--expression' || v === '--file') scripts.push((args[++i] || {}).value || '');
      continue;
    }
    if (v.startsWith('-') && v.length > 1 && !args[i].quoted) {
      for (let k = 1; k < v.length; k++) {
        const f = v[k];
        if (f === 'n') quiet = true;
        else if (f === 'i') {
          inPlace = true;
          if (k === v.length - 1 && args[i + 1] && args[i + 1].quoted && args[i + 1].value === '') i++;
          break;
        } else if (f === 'e' || f === 'f') {
          const attached = v.slice(k + 1);
          scripts.push(attached || (args[++i] || {}).value || '');
          break;
        } else if (f === 'l') {
          if (k === v.length - 1) i++;
          break;
        }
      }
      continue;
    }
    rest.push(args[i]);
  }
  if (!scripts.length && rest.length) scripts.push(rest.shift().value);
  return { inPlace, quiet, scripts, files: rest };
}

// perl and ruby switches: which ones take the code that follows, and which ones take the
// rest of their cluster as an argument (-MModule, -I/dir, -rlib).
const SWITCHES = {
  perl: { code: 'eE', withArg: 'MmIFCdDx' },
  ruby: { code: 'e', withArg: 'IrCEFxKTWU' },
};

// perl -i / ruby -i: returns { inPlace, files }.
function parseInPlaceScript(args, lang) {
  const { code: codeChars, withArg } = SWITCHES[lang];
  let inPlace = false;
  let code = false;
  let i = 0;
  for (; i < args.length; i++) {
    const v = args[i].value;
    if (v === '--') {
      i++;
      break;
    }
    if (!v.startsWith('-') || v.length < 2 || args[i].quoted) break;
    if (v.startsWith('--')) continue;
    for (let k = 1; k < v.length; k++) {
      const c = v[k];
      if (c === 'i') {
        inPlace = true;
        break;
      }
      if (codeChars.includes(c)) {
        code = true;
        i++;
        break;
      }
      if (withArg.includes(c)) break;
    }
  }
  return { inPlace, files: args.slice(i + (code ? 0 : 1)) };
}

// gawk -i inplace.
function parseAwk(args) {
  let inPlace = false;
  let i = 0;
  let program = false;
  for (; i < args.length; i++) {
    const v = args[i].value;
    if ((v === '-i' || v === '--include') && /^inplace$/.test((args[i + 1] || {}).value || '')) {
      inPlace = true;
      i++;
      continue;
    }
    if (v === '--include=inplace') {
      inPlace = true;
      continue;
    }
    if (v === '-f' || v === '-v' || v === '-F') {
      if (v === '-f') program = true;
      i++;
      continue;
    }
    if (v.startsWith('-') && v.length > 1 && !args[i].quoted) continue;
    break;
  }
  return { inPlace, files: args.slice(i + (program ? 0 : 1)) };
}

// head: the line count, or null when it isn't a plain "first N lines".
function headCount(args) {
  let count = 10;
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    let m;
    if ((m = /^-(\d+)$/.exec(v))) count = Number(m[1]);
    else if ((m = /^-n(\d+)$/.exec(v)) || (m = /^--lines=(\d+)$/.exec(v))) count = Number(m[1]);
    else if (v === '-n' || v === '--lines') {
      const n = (args[++i] || {}).value || '';
      if (!/^\d+$/.test(n)) return null;
      count = Number(n);
    } else if (v.startsWith('-') && v.length > 1) return null;
    else files.push(args[i]);
  }
  return { count, files };
}

// sed -n 'A,Bp' or 'Ap': the line range, or null.
function sedRange(scripts) {
  if (scripts.length !== 1) return null;
  const m = /^\s*(\d+)\s*(?:,\s*(\d+|\$)\s*)?p\s*;?\s*$/.exec(scripts[0]);
  if (!m) return null;
  const start = Number(m[1]);
  if (m[2] === undefined) return { offset: start, limit: 1 };
  if (m[2] === '$') return { offset: start, limit: null };
  const end = Number(m[2]);
  return end >= start ? { offset: start, limit: end - start + 1 } : null;
}

// Where a here-document or inline script would write. Only string literals, or variables set
// to one in the same script, are followed.
const PY_OPEN = /\bopen\(\s*(?:[rRbBfF]{0,2})(['"])(.*?)\1\s*,\s*(?:mode\s*=\s*)?[rRbB]?(['"])([^'"]*)\3/g;
const PY_OPEN_VAR = /\bopen\(\s*([A-Za-z_]\w*)\s*,\s*(?:mode\s*=\s*)?(['"])([^'"]*)\2/g;
const PY_PATH_WRITE = /\bPath\(\s*[rR]?(['"])(.*?)\1\s*\)\.write_(?:text|bytes)\(/g;
const PY_VAR_WRITE = /\b([A-Za-z_]\w*)\.write_(?:text|bytes)\(/g;
const NODE_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\(\s*(['"`])(.*?)\1/g;
const NODE_WRITE_VAR = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\(\s*([A-Za-z_$][\w$]*)\s*[,)]/g;
const RUBY_WRITE = /\bFile\.(?:write|open)\(\s*(['"])(.*?)\1(?:\s*,\s*(['"])([^'"]*)\3)?/g;

function assigned(code, name) {
  const esc = name.replace(/[$]/g, '\\$');
  const str = new RegExp('(?:^|[\\s;(,])(?:const\\s+|let\\s+|var\\s+)?' + esc + '\\s*=\\s*(?:[rR]?(["\'`])(.*?)\\1|(?:pathlib\\.)?Path\\(\\s*[rR]?(["\'])(.*?)\\3\\s*\\))', 'm');
  const m = str.exec(code);
  if (!m) return null;
  return m[2] !== undefined ? m[2] : m[4];
}

export function scriptTargets(code, lang) {
  const out = [];
  const add = (p) => {
    if (p && !/[{}$]/.test(p)) out.push(p);
  };
  if (lang === 'python') {
    for (const m of code.matchAll(PY_OPEN)) if (/[wax+]/.test(m[4])) add(m[2]);
    for (const m of code.matchAll(PY_OPEN_VAR)) if (/[wax+]/.test(m[3])) add(assigned(code, m[1]));
    for (const m of code.matchAll(PY_PATH_WRITE)) add(m[2]);
    for (const m of code.matchAll(PY_VAR_WRITE)) if (m[1] !== 'Path') add(assigned(code, m[1]));
  } else if (lang === 'node') {
    for (const m of code.matchAll(NODE_WRITE)) add(m[2]);
    for (const m of code.matchAll(NODE_WRITE_VAR)) add(assigned(code, m[1]));
  } else if (lang === 'ruby') {
    for (const m of code.matchAll(RUBY_WRITE)) if (m[0].startsWith('File.write') || /[wa+]/.test(m[4] || '')) add(m[2]);
  }
  return [...new Set(out)];
}

function inlineCode(name, args, cmd) {
  const lang = SCRIPT_LANGS[name] || (/^python3(\.\d+)?$/.test(name) ? 'python' : null);
  if (!lang) return null;
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if ((lang === 'python' && v === '-c') || (lang !== 'python' && (v === '-e' || v === '--eval' || v === '-p'))) {
      return { lang, code: (args[i + 1] || {}).value || '' };
    }
  }
  const positional = args.filter((a) => !a.value.startsWith('-') || a.value === '-');
  if (cmd.heredoc && (positional.length === 0 || (positional.length === 1 && positional[0].value === '-'))) {
    return { lang, code: cmd.heredoc.body };
  }
  return null;
}

// Classifies one simple command. Returns { role, items } where role is 'read', 'neutral',
// 'write' or 'other', and items name the files involved.
function classifyCommand(cmd, pipeline, index, cwd) {
  const { name, args } = commandOf(cmd);
  const outputs = outputRedirects(cmd);
  const single = pipeline.length === 1;

  if (name === 'find') {
    const at = args.findIndex((a) => a.value === '-exec' || a.value === '-execdir');
    if (at >= 0) {
      const sub = args.slice(at + 1);
      const end = sub.findIndex((a) => a.value === ';' || a.value === '+' || a.value === '\\;');
      const inner = { words: end >= 0 ? sub.slice(0, end) : sub, redirects: [], heredoc: null };
      const result = classifyCommand(inner, [inner], 0, cwd);
      if (result.role === 'write') {
        return { role: 'write', items: result.items.map((it) => ({ ...it, text: 'the files find matches', abs: null, dynamic: true })) };
      }
    }
    return { role: 'other', items: [] };
  }

  if (name === 'sed') {
    const sed = parseSed(args);
    if (sed.inPlace) {
      const files = sed.files.length ? sed.files : cmdViaXargs(cmd) ? [] : null;
      if (files === null) return { role: 'other', items: [] };
      const items = files.length ? files.map((f) => fileItem('inplace', f, cwd, { tool: 'sed -i' })) : [{ kind: 'inplace', text: 'the files xargs passes', abs: null, dynamic: true, tool: 'sed -i' }];
      return { role: 'write', items };
    }
    const range = sed.quiet ? sedRange(sed.scripts) : null;
    if (range && sed.files.length === 1 && single && !outputs.length) {
      return { role: 'read', items: [fileItem('read', sed.files[0], cwd, { ...range })] };
    }
    return { role: 'other', items: [] };
  }

  if (name === 'perl' || name === 'ruby') {
    const p = parseInPlaceScript(args, name);
    if (p.inPlace && p.files.length) return { role: 'write', items: p.files.map((f) => fileItem('inplace', f, cwd, { tool: name + ' -i' })) };
  }
  if (name === 'awk' || name === 'gawk') {
    const p = parseAwk(args);
    if (p.inPlace && p.files.length) return { role: 'write', items: p.files.map((f) => fileItem('inplace', f, cwd, { tool: 'awk -i inplace' })) };
    return { role: 'other', items: [] };
  }

  const script = inlineCode(name, args, cmd);
  if (script) {
    const items = scriptTargets(script.code, script.lang)
      .map((t) => fileItem('script', { value: t, dynamic: false }, cwd, { tool: name }))
      .filter((it) => isFile(it.abs));
    return items.length ? { role: 'write', items } : { role: 'other', items: [] };
  }

  // Text written into a file: echo, printf or a here-document redirected into it.
  const literalInput = Boolean(cmd.heredoc || cmd.herestring);
  const fileArgs = args.filter((a) => !(a.value.startsWith('-') && a.value.length > 1 && !a.quoted));
  const producesText =
    (PRODUCERS.has(name) && args.some(hasLiteral)) ||
    (name === 'cat' && fileArgs.length === 0 && literalInput) ||
    (name === '' && outputs.length > 0 && cmd.words.length === 0) ||
    (name === ':' && outputs.length > 0);
  if (producesText && outputs.length) {
    return { role: 'write', items: outputs.map((w) => fileItem(cmd.redirects.find((r) => r.target === w).op.includes('>>') ? 'append' : 'literal', w, cwd)) };
  }
  if (name === 'tee') {
    const fed = literalInput || pipeline.slice(0, index).some((c) => {
      const prev = commandOf(c);
      const prevFiles = prev.args.filter((a) => !a.value.startsWith('-'));
      return (PRODUCERS.has(prev.name) && prev.args.some(hasLiteral)) || (prev.name === 'cat' && prevFiles.length === 0 && (c.heredoc || c.herestring));
    });
    if (fed) {
      const append = args.some((a) => a.value === '-a' || a.value === '--append');
      return { role: 'write', items: fileArgs.map((f) => fileItem(append ? 'append' : 'literal', f, cwd)) };
    }
    return { role: 'other', items: [] };
  }

  // Single-file reads.
  if (single && !outputs.length && !literalInput) {
    if (name === 'cat' || name === 'nl' || name === 'less' || name === 'more' || name === 'bat' || name === 'batcat') {
      const flags = args.filter((a) => a.value.startsWith('-') && a.value.length > 1);
      const plainFlags = flags.every((a) => /^-[nAvetTbsuE]+$|^--(number|show-all|plain|paging=never|style=plain)$|^-p+$/.test(a.value));
      if (fileArgs.length && plainFlags && !fileArgs.some((f) => f.glob || f.value === '-')) {
        return { role: 'read', items: fileArgs.map((f) => fileItem('read', f, cwd, { offset: null, limit: null })) };
      }
      return { role: 'other', items: [] };
    }
    if (name === 'head') {
      const h = headCount(args);
      if (h && h.files.length && !h.files.some((f) => f.glob)) return { role: 'read', items: h.files.map((f) => fileItem('read', f, cwd, { offset: null, limit: h.count })) };
      return { role: 'other', items: [] };
    }
  }

  if (NEUTRAL.has(name) && !outputs.length) return { role: 'neutral', items: [] };
  if (name === '' && !outputs.length) return { role: 'neutral', items: [] };
  return { role: 'other', items: [] };
}

function cmdViaXargs(cmd) {
  return cmd.words.some((w) => !w.quoted && w.value === 'xargs');
}

// Classifies a whole bash command line. Returns { writes, reads } where writes are the file
// writes to block, and reads are set only when the command does nothing but read files.
export function classifyBash(command, cwd) {
  const { pipelines } = parseBash(command);
  const writes = [];
  const reads = [];
  let onlyReads = true;
  let here = cwd;
  for (const pipeline of pipelines) {
    pipeline.forEach((cmd, index) => {
      const { name, args } = commandOf(cmd);
      if ((name === 'cd' || name === 'pushd') && args.length === 1 && !args[0].dynamic) {
        const r = resolvePath(args[0].value, here);
        if (r.abs) here = r.abs;
      }
      const result = classifyCommand(cmd, pipeline, index, here);
      if (result.role === 'write') writes.push(...result.items);
      else if (result.role === 'read') reads.push(...result.items);
      else if (result.role === 'other') onlyReads = false;
    });
  }
  const blocking = writes.filter((it) => !isExempt(it.text, it.abs));
  const fileReads = reads.filter((it) => !isExempt(it.text, it.abs) && isFile(it.abs));
  return {
    writes: blocking,
    reads: onlyReads && blocking.length === 0 && fileReads.length === reads.length && reads.length > 0 ? fileReads : [],
  };
}
