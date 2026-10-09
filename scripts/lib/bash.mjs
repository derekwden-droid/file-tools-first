// A small parser for the bash commands Claude writes. It splits a command line into
// pipelines and simple commands, and for each command keeps its words, its redirects and any
// here-document bodies. It is not a full shell: command substitutions, arithmetic and parameter
// expansions stay inside the word they appear in, and compound commands are flattened into
// the simple commands inside them.

const OPERATORS = ['&&', '||', ';;', '|&', '|', ';', '&', '(', ')'];
const REDIRECT = /^(\d*)(<<<|<<-|<<|>>|>\||>&|<&|&>>|&>|<>|>|<)/;
const WORD_END = /[\s|&;()<>]/;

// Reads a balanced $( ... ), ${ ... } or backtick group starting at `start` (just after the
// opening characters). Quotes and here-documents inside are skipped. Returns the end index.
function skipGroup(s, start, open, close) {
  let depth = 1;
  let i = start;
  const heredocs = [];
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'" && open !== '`') {
      const end = s.indexOf("'", i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c === '"' && open !== '`') {
      i = skipDouble(s, i + 1);
      continue;
    }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      const m = /^<<-?\s*(['"]?)([A-Za-z0-9_.-]+)\1/.exec(s.slice(i));
      if (m) {
        heredocs.push(m[2]);
        i += m[0].length;
        continue;
      }
    }
    if (c === '\n' && heredocs.length) {
      i = skipHeredocBodies(s, i + 1, heredocs.splice(0));
      continue;
    }
    if (open === '(' && c === '$' && s[i + 1] === '(') {
      i = skipGroup(s, i + 2, '(', ')');
      continue;
    }
    if (c === open && open !== close) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return s.length;
}

// Skips the bodies of here-documents whose delimiters are listed, starting at a line start.
function skipHeredocBodies(s, i, delims) {
  for (const delim of delims) {
    while (i < s.length) {
      const nl = s.indexOf('\n', i);
      const line = s.slice(i, nl < 0 ? s.length : nl);
      i = nl < 0 ? s.length : nl + 1;
      if (line.replace(/^\t+/, '') === delim) break;
    }
  }
  return i;
}

// Skips the inside of a double-quoted string starting after the opening quote.
function skipDouble(s, i) {
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') i += 2;
    else if (c === '"') return i + 1;
    else if (c === '$' && s[i + 1] === '(') i = skipGroup(s, i + 2, '(', ')');
    else if (c === '`') i = skipGroup(s, i + 1, '`', '`');
    else i++;
  }
  return s.length;
}

// Reads one word starting at i. Returns { word, end }.
function readWord(s, i) {
  let value = '';
  let raw = '';
  let quoted = false;
  let dynamic = false;
  let glob = false;
  const start = i;
  while (i < s.length) {
    const c = s[i];
    if (WORD_END.test(c)) {
      // A process substitution such as <(cmd) belongs to the word.
      if ((c === '<' || c === '>') && s[i + 1] === '(' && i === start) {
        const end = skipGroup(s, i + 2, '(', ')');
        value += s.slice(i, end);
        dynamic = true;
        i = end;
        continue;
      }
      break;
    }
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2;
        continue;
      }
      value += s[i + 1] ?? '';
      quoted = true;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      const stop = end < 0 ? s.length : end;
      value += s.slice(i + 1, stop);
      quoted = true;
      i = stop + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === "'") {
      let j = i + 2;
      while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1;
      value += s.slice(i + 2, j);
      quoted = true;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const end = skipDouble(s, i + 1);
      const inner = s.slice(i + 1, end - 1);
      if (/[$`]/.test(inner)) dynamic = true;
      value += inner.replace(/\\([$`"\\\n])/g, '$1');
      quoted = true;
      i = end;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      const end = skipGroup(s, i + 2, '(', ')');
      value += s.slice(i, end);
      dynamic = true;
      i = end;
      continue;
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = skipGroup(s, i + 2, '{', '}');
      value += s.slice(i, end);
      dynamic = true;
      i = end;
      continue;
    }
    if (c === '`') {
      const end = skipGroup(s, i + 1, '`', '`');
      value += s.slice(i, end);
      dynamic = true;
      i = end;
      continue;
    }
    if (c === '$' && /[A-Za-z_0-9@*#?$!-]/.test(s[i + 1] || '')) dynamic = true;
    if (c === '*' || c === '?' || c === '[') glob = true;
    value += c;
    i++;
  }
  raw = s.slice(start, i);
  return { word: { value, raw, quoted, dynamic, glob }, end: i };
}

// Splits a command line into tokens: words, operators, redirects and here-documents.
export function tokenize(s) {
  const tokens = [];
  const comments = [];
  const pending = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      tokens.push({ type: 'op', value: '\n' });
      i++;
      while (pending.length) {
        const doc = pending.shift();
        const lines = [];
        while (i < s.length) {
          const nl = s.indexOf('\n', i);
          const line = s.slice(i, nl < 0 ? s.length : nl);
          i = nl < 0 ? s.length : nl + 1;
          const test = doc.strip ? line.replace(/^\t+/, '') : line;
          if (test.replace(/\r$/, '') === doc.delim) break;
          lines.push(doc.strip ? test : line);
        }
        doc.body = lines.join('\n');
      }
      continue;
    }
    if (c === '#') {
      const nl = s.indexOf('\n', i);
      comments.push(s.slice(i, nl < 0 ? s.length : nl));
      i = nl < 0 ? s.length : nl;
      continue;
    }
    const redirect = REDIRECT.exec(s.slice(i, i + 8));
    if (redirect && !((redirect[2] === '<' || redirect[2] === '>') && s[i + redirect[0].length] === '(' && redirect[1] === '')) {
      const op = redirect[2];
      i += redirect[0].length;
      if (op === '<<' || op === '<<-') {
        while (s[i] === ' ' || s[i] === '\t') i++;
        const { word, end } = readWord(s, i);
        i = end;
        const doc = { type: 'heredoc', delim: word.value, quoted: word.quoted, strip: op === '<<-', body: '' };
        tokens.push(doc);
        pending.push(doc);
        continue;
      }
      tokens.push({ type: 'redirect', op, fd: redirect[1] || null });
      continue;
    }
    const op = OPERATORS.find((o) => s.startsWith(o, i));
    if (op) {
      tokens.push({ type: 'op', value: op });
      i += op.length;
      continue;
    }
    const { word, end } = readWord(s, i);
    if (end === i) {
      i++;
      continue;
    }
    tokens.push({ type: 'word', ...word });
    i = end;
  }
  return { tokens, comments };
}

const PIPE = new Set(['|', '|&']);

// Parses a command line into pipelines of simple commands.
// Each command is { words, redirects: [{ op, fd, target }], heredoc, herestring }.
export function parseBash(s) {
  const { tokens, comments } = tokenize(String(s));
  const pipelines = [];
  let pipeline = [];
  let cmd = null;
  const fresh = () => ({ words: [], redirects: [], heredoc: null, herestring: null });
  const endCommand = () => {
    if (cmd && (cmd.words.length || cmd.redirects.length || cmd.heredoc)) pipeline.push(cmd);
    cmd = null;
  };
  const endPipeline = () => {
    endCommand();
    if (pipeline.length) pipelines.push(pipeline);
    pipeline = [];
  };
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t];
    if (tok.type === 'op') {
      if (PIPE.has(tok.value)) endCommand();
      else endPipeline();
      continue;
    }
    if (!cmd) cmd = fresh();
    if (tok.type === 'heredoc') {
      cmd.heredoc = tok;
      continue;
    }
    if (tok.type === 'redirect') {
      const next = tokens[t + 1];
      const target = next && next.type === 'word' ? next : null;
      if (target) t++;
      if (tok.op === '<<<') cmd.herestring = target;
      else cmd.redirects.push({ op: tok.op, fd: tok.fd, target });
      continue;
    }
    cmd.words.push(tok);
  }
  endPipeline();
  return { pipelines, comments };
}

// The text of a word with its variables, substitutions and backtick groups taken out, so
// "PORT=$PORT" leaves "PORT=" and "$(date)" leaves nothing. Works for bash and PowerShell.
export function literalText(s) {
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '`') {
      const end = s.indexOf('`', i + 1);
      i = end < 0 ? s.length : end + 1;
      continue;
    }
    if (c !== '$') {
      out += c;
      i++;
      continue;
    }
    const next = s[i + 1] || '';
    if (next === '(') i = skipGroup(s, i + 2, '(', ')');
    else if (next === '{') i = skipGroup(s, i + 2, '{', '}');
    else if (/[A-Za-z0-9_]/.test(next)) {
      i += 1;
      while (i < s.length && /[A-Za-z0-9_:]/.test(s[i])) i++;
    } else if ('@*#?!-'.includes(next) && next !== '') i += 2;
    else {
      out += c;
      i++;
    }
  }
  return out;
}

// Leading words that don't name the command: shell keywords, variable assignments and
// wrappers such as sudo or env.
const KEYWORDS = new Set(['if', 'then', 'elif', 'else', 'do', 'while', 'until', '!', '{', '}', 'time', 'fi', 'done', 'esac']);
const WRAPPERS = new Set(['sudo', 'command', 'builtin', 'exec', 'nohup', 'env', 'nice', 'stdbuf', 'xargs']);

// The command's name (lower-case, without a directory or .exe) and its arguments.
export function commandOf(cmd) {
  const words = cmd.words.slice();
  while (words.length) {
    const w = words[0];
    if (!w.quoted && KEYWORDS.has(w.value)) {
      words.shift();
      continue;
    }
    if (!w.quoted && /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(w.value)) {
      words.shift();
      continue;
    }
    if (!w.quoted && WRAPPERS.has(w.value.split(/[\\/]/).pop())) {
      words.shift();
      while (words.length && words[0].value.startsWith('-')) words.shift();
      continue;
    }
    break;
  }
  if (!words.length) return { name: '', args: [] };
  const base = words[0].value.split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  return { name: base, args: words.slice(1) };
}
