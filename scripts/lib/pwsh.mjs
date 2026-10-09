// The PowerShell side: finds Get-Content reads of a single file, and file writes that author
// text (Set-Content, Add-Content, Out-File, Tee-Object, New-Item -Value, a redirect, or a
// .NET File write) or that rewrite a file from its own contents.

import { isExempt, isFile, resolvePath } from './paths.mjs';

// Splits a command into statements, each a list of pipeline stages, each a list of tokens.
// Tokens are { type: 'word' | 'string' | 'group' | 'redirect', value, literal }.
export function tokenizePwsh(s) {
  const statements = [];
  let stages = [];
  let tokens = [];
  const endStage = () => {
    if (tokens.length) stages.push(tokens);
    tokens = [];
  };
  const endStatement = () => {
    endStage();
    if (stages.length) statements.push(stages);
    stages = [];
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '`' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n' || c === ';') {
      endStatement();
      i++;
      continue;
    }
    if (s.startsWith('&&', i) || s.startsWith('||', i)) {
      endStatement();
      i += 2;
      continue;
    }
    if (c === '|') {
      endStage();
      i++;
      continue;
    }
    if (c === '#') {
      const nl = s.indexOf('\n', i);
      i = nl < 0 ? s.length : nl;
      continue;
    }
    if (s.startsWith('<#', i)) {
      const end = s.indexOf('#>', i + 2);
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    const redirect = /^([1-6*]?)(>>|>)(&[12])?/.exec(s.slice(i, i + 5));
    if (redirect) {
      tokens.push({ type: 'redirect', value: redirect[0], fd: redirect[1] || '1', merge: Boolean(redirect[3]) });
      i += redirect[0].length;
      continue;
    }
    if (s.startsWith("@'", i) || s.startsWith('@"', i)) {
      const q = s[i + 1];
      const close = '\n' + q + '@';
      const start = s.indexOf('\n', i) + 1;
      const end = s.indexOf(close, start);
      const stop = end < 0 ? s.length : end;
      tokens.push({ type: 'string', value: s.slice(start, stop).replace(/\r$/, ''), literal: q === "'" || !/\$/.test(s.slice(start, stop)) });
      i = end < 0 ? s.length : end + close.length;
      continue;
    }
    if (c === "'" || c === '"') {
      const { value, end } = readString(s, i);
      tokens.push({ type: 'string', value, literal: c === "'" || !/\$/.test(value) });
      i = end;
      continue;
    }
    if (c === '(' || ((c === '$' || c === '@') && s[i + 1] === '(') || c === '{') {
      const open = c === '{' ? '{' : '(';
      const from = c === '(' || c === '{' ? i + 1 : i + 2;
      const end = skipGroup(s, from, open, open === '(' ? ')' : '}');
      tokens.push({ type: 'group', value: s.slice(from, end - 1) });
      i = end;
      continue;
    }
    let j = i;
    while (j < s.length && !/[\s;|]/.test(s[j])) {
      if (s[j] === '(') j = skipGroup(s, j + 1, '(', ')');
      else if (s[j] === "'" || s[j] === '"') j = readString(s, j).end;
      else if (/>/.test(s[j]) && j > i) break;
      else j++;
    }
    tokens.push({ type: 'word', value: s.slice(i, j) });
    i = j;
  }
  endStatement();
  return statements;
}

function readString(s, i) {
  const q = s[i];
  let value = '';
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === q && s[j + 1] === q) {
      value += q;
      j += 2;
      continue;
    }
    if (c === q) return { value, end: j + 1 };
    if (q === '"' && c === '`' && j + 1 < s.length) {
      value += s[j + 1];
      j += 2;
      continue;
    }
    value += c;
    j++;
  }
  return { value, end: s.length };
}

function skipGroup(s, i, open, close) {
  let depth = 1;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      i = readString(s, i).end;
      continue;
    }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return i + 1;
    i++;
  }
  return s.length;
}

const ALIASES = {
  gc: 'get-content', cat: 'get-content', type: 'get-content', 'get-content': 'get-content',
  sc: 'set-content', 'set-content': 'set-content',
  ac: 'add-content', 'add-content': 'add-content',
  'out-file': 'out-file',
  tee: 'tee-object', 'tee-object': 'tee-object',
  select: 'select-object', 'select-object': 'select-object',
  echo: 'write-output', write: 'write-output', 'write-output': 'write-output',
  'write-host': 'write-host',
  ni: 'new-item', 'new-item': 'new-item',
  cd: 'set-location', sl: 'set-location', chdir: 'set-location', 'set-location': 'set-location',
  pushd: 'set-location', 'push-location': 'set-location', popd: 'pop-location', 'pop-location': 'pop-location',
};
const NEUTRAL = new Set(['set-location', 'pop-location', 'write-host', 'write-output']);

function cmdlet(stage) {
  const first = stage[0];
  if (!first || first.type !== 'word') return '';
  return ALIASES[first.value.toLowerCase()] || first.value.toLowerCase();
}

// Named and positional parameters of a stage. Switches without values are listed by name.
const SWITCHES = new Set(['-raw', '-force', '-append', '-nonewline', '-wait', '-noclobber', '-passthru', '-asbytestream']);
function params(stage) {
  const named = {};
  const positional = [];
  for (let k = 1; k < stage.length; k++) {
    const t = stage[k];
    if (t.type === 'word' && /^-[A-Za-z]/.test(t.value)) {
      const [name, attached] = t.value.toLowerCase().split(':');
      if (SWITCHES.has(name)) named[name] = true;
      else if (attached !== undefined) named[name] = { type: 'word', value: t.value.slice(name.length + 1) };
      else named[name] = stage[++k] || null;
      continue;
    }
    if (t.type === 'redirect') {
      k++;
      continue;
    }
    positional.push(t);
  }
  return { named, positional };
}

function pick(named, ...names) {
  for (const n of names) {
    for (const key of Object.keys(named)) if (key.length > 2 && n.startsWith(key) && named[key] !== true) return named[key];
  }
  return null;
}

function tokenText(t) {
  return t && (t.type === 'word' || t.type === 'string') ? t.value : null;
}

function item(kind, token, cwd, extra = {}) {
  const text = tokenText(token);
  const { abs } = text === null ? { abs: null } : resolvePath(text, cwd, 'pwsh');
  return { kind, text: text === null ? 'a computed path' : text, abs, dynamic: abs === null, ...extra };
}

// The tokens of a stage without its redirects and their targets.
function withoutRedirects(stage) {
  return stage.filter((t, k) => t.type !== 'redirect' && !(k > 0 && stage[k - 1].type === 'redirect'));
}

// True when a stage only produces literal text: a string, or Write-Output of strings.
function literalStage(stage) {
  const tokens = withoutRedirects(stage);
  if (tokens.length === 1 && tokens[0].type === 'string') return tokens[0].literal || /[A-Za-z0-9]/.test(tokens[0].value.replace(/\$\w+|\$\([^)]*\)/g, ''));
  if (cmdlet(tokens) === 'write-output') return tokens.slice(1).some((t) => t.type === 'string' || (t.type === 'word' && !t.value.startsWith('$')));
  return false;
}

// Get-Content parameters that take a value, so the value isn't mistaken for the path.
const VALUED = /^-(encoding|totalcount|head|first|tail|last|readcount|delimiter|stream|filter|include|exclude)$/i;

// Paths read with Get-Content anywhere in the command, including inside parentheses, as
// written. They are resolved later against the folder the write happens in.
function contentReads(command) {
  const found = new Set();
  const re = /(?:^|[\s(;|{=])(?:get-content|gc|cat|type)((?:\s+(?:'[^']*'|"[^"]*"|[^\s'"|;)}]+))+)/gi;
  for (const m of command.matchAll(re)) {
    const words = m[1].trim().match(/'[^']*'|"[^"]*"|\S+/g) || [];
    let target = null;
    for (let k = 0; k < words.length; k++) {
      if (/^-(literal)?path$/i.test(words[k])) {
        target = words[k + 1];
        break;
      }
      if (VALUED.test(words[k])) {
        k++;
        continue;
      }
      if (words[k].startsWith('-')) continue;
      target = words[k];
      break;
    }
    if (target) found.add(target.replace(/^['"]|['"]$/g, ''));
  }
  return [...found];
}

function readsBack(texts, abs, here) {
  if (!abs) return false;
  return texts.some((t) => {
    const r = resolvePath(t, here, 'pwsh');
    return r.abs && r.abs.toLowerCase() === abs.toLowerCase();
  });
}

const DOTNET_WRITE = /\[(?:System\.)?IO\.File\]::(?:WriteAllText|WriteAllLines|WriteAllBytes|AppendAllText|AppendAllLines)\(\s*(['"])(.*?)\1/gi;

// Classifies a PowerShell command. Returns { writes, reads } like classifyBash.
export function classifyPwsh(command, cwd) {
  const statements = tokenizePwsh(String(command));
  const readBack = contentReads(command);
  const writes = [];
  const reads = [];
  let onlyReads = true;
  let here = cwd;

  for (const m of String(command).matchAll(DOTNET_WRITE)) {
    const { abs } = resolvePath(m[2], here, 'pwsh');
    writes.push({ kind: 'literal', text: m[2], abs, dynamic: abs === null, tool: '[IO.File]' });
  }
  if (writes.length) onlyReads = false;

  for (const stages of statements) {
    let readThisStatement = null;
    stages.forEach((stage, index) => {
      const name = cmdlet(stage);
      const { named, positional } = params(stage);
      const redirects = [];
      stage.forEach((t, k) => {
        if (t.type === 'redirect' && !t.merge && (t.fd === '1' || t.fd === '*')) redirects.push({ append: t.value.includes('>>'), target: stage[k + 1] });
      });

      if (name === 'set-location' && positional.length === 1) {
        const { abs } = resolvePath(tokenText(positional[0]) || '', here, 'pwsh');
        if (abs) here = abs;
      }

      if (name === 'set-content' || name === 'add-content' || name === 'out-file' || name === 'tee-object') {
        const target = name === 'out-file' || name === 'tee-object' ? pick(named, '-filepath', '-path', '-literalpath') || positional[0] : pick(named, '-path', '-literalpath') || positional[0];
        const value = pick(named, '-value', '-inputobject') || (name === 'set-content' || name === 'add-content' ? positional[1] || null : null);
        const append = name === 'add-content' || named['-append'] === true;
        const target0 = item(append ? 'append' : 'literal', target, here, { tool: stage[0].value });
        const literal = (value && value.type === 'string') || (value && value.type === 'word' && !value.value.startsWith('$')) || (index > 0 && stages.slice(0, index).every(literalStage));
        const rewrite = readsBack(readBack, target0.abs, here);
        if (literal || rewrite) writes.push(rewrite ? { ...target0, kind: 'rewrite' } : target0);
        onlyReads = false;
        return;
      }
      if (name === 'new-item') {
        const value = pick(named, '-value');
        if (value) {
          const target = pick(named, '-path', '-literalpath') || positional[0];
          const leaf = pick(named, '-name');
          const joined = leaf && tokenText(target) ? { type: 'word', value: tokenText(target).replace(/[\\/]$/, '') + '\\' + tokenText(leaf) } : leaf || target;
          writes.push(item('literal', joined, here, { tool: 'New-Item' }));
        }
        onlyReads = false;
        return;
      }
      if (redirects.length && literalStage(stage)) {
        for (const r of redirects) writes.push(item(r.append ? 'append' : 'literal', r.target, here));
        onlyReads = false;
        return;
      }
      if (name === 'get-content' && index === 0 && !redirects.length) {
        const target = pick(named, '-path', '-literalpath') || positional[0];
        const tail = pick(named, '-tail', '-last');
        const head = pick(named, '-totalcount', '-head', '-first');
        if (target && !tail && named['-wait'] !== true && !tokenText(target)?.match(/[*?]/)) {
          readThisStatement = item('read', target, here, { offset: null, limit: head && /^\d+$/.test(tokenText(head) || '') ? Number(tokenText(head)) : null });
          return;
        }
      }
      if (name === 'select-object' && readThisStatement && index === 1 && stages.length === 2) {
        const first = pick(named, '-first');
        const skip = pick(named, '-skip');
        if (first && /^\d+$/.test(tokenText(first) || '') && (!skip || /^\d+$/.test(tokenText(skip) || ''))) {
          readThisStatement.limit = Number(tokenText(first));
          readThisStatement.offset = skip ? Number(tokenText(skip)) + 1 : null;
          return;
        }
        readThisStatement = null;
      }
      if (NEUTRAL.has(name) && !redirects.length && stages.length === 1) return;
      readThisStatement = null;
      onlyReads = false;
    });
    if (readThisStatement) reads.push(readThisStatement);
  }

  const blocking = writes.filter((it) => !isExempt(it.text, it.abs));
  const fileReads = reads.filter((it) => !isExempt(it.text, it.abs) && isFile(it.abs));
  return {
    writes: blocking,
    reads: onlyReads && blocking.length === 0 && reads.length > 0 && fileReads.length === reads.length ? fileReads : [],
  };
}
