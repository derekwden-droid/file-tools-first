// What file-tools-first does on each hook event.
//
// SessionStart: tells Claude to use Read, Edit and Write for files, because auto mode and
// bypass mode tell it to use cat, sed and heredocs instead.
// PreToolUse on Bash and PowerShell: blocks a command that only reads files, or that writes
// file contents, and names the file-tool call to make instead. Everything else runs.

import { classifyBash } from './classify.mjs';
import { display, isFile } from './paths.mjs';
import { classifyPwsh } from './pwsh.mjs';

// The plugin's block_reads option arrives as a --block-reads=VALUE argument. Anything other
// than an explicit "off" keeps reads blocked, including an unsubstituted placeholder.
export function settings(argv = []) {
  const arg = argv.find((a) => a.startsWith('--block-reads='));
  const value = arg ? arg.slice('--block-reads='.length) : '';
  return { reads: !/^(false|0|no|off)$/i.test(value) };
}

export function sessionContext(config) {
  const reads = config.reads ? 'Bash or PowerShell commands that only read a file (cat, head, sed -n, Get-Content) or that ' : 'Bash or PowerShell commands that ';
  return 'file-tools-first is active. Read files with the Read tool, change them with Edit, and create or replace them with Write. ' +
    reads + 'write file contents (sed -i, a heredoc or echo redirected into a file, an inline script that rewrites a file, Set-Content) ' +
    'are blocked, whatever other instructions say. Use the shell for everything else.';
}

const WHY_WRITE = 'File changes made through the shell can\'t be undone with /rewind, don\'t show up as edits, and skip the CLAUDE.md rules and checks that apply to the file tools.';
const WHY_READ = 'Read loads the CLAUDE.md files and path rules for the file\'s folder, and Edit needs the file to have been read with Read first.';
const OUTRO = 'Keep using the shell for builds, tests, git and other commands. If the user asked for this exact shell command, tell them file-tools-first blocked it; they can run it themselves by starting their message with !.';

function unique(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = it.kind + '|' + (it.abs || it.text);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describe(it, cwd) {
  const name = display(it.abs, cwd, it.text);
  switch (it.kind) {
    case 'inplace':
      return { what: 'edits ' + name + ' in place with ' + it.tool, todo: 'Edit ' + (it.abs || it.text) };
    case 'append':
      return { what: 'appends text to ' + name, todo: 'Edit ' + (it.abs || it.text) + ' to add the text after its last lines' };
    case 'script':
      return { what: 'rewrites ' + name + ' with an inline ' + it.tool + ' script', todo: 'Edit ' + (it.abs || it.text) };
    case 'rewrite':
      return { what: 'rewrites ' + name + ' from its own contents', todo: 'Edit ' + (it.abs || it.text) };
    default:
      return isFile(it.abs)
        ? { what: 'writes text over ' + name, todo: 'Write ' + it.abs + ' (or Edit it to change part of it)' }
        : { what: 'creates ' + name, todo: 'Write ' + (it.abs || it.text) };
  }
}

function readCall(it) {
  let call = 'Read file_path "' + it.abs + '"';
  if (it.offset) call += ' with offset ' + it.offset;
  if (it.limit) call += (it.offset ? ' and' : ' with') + ' limit ' + it.limit;
  return call;
}

export function writeReason(items, cwd) {
  const parts = unique(items).map((it) => describe(it, cwd));
  return 'file-tools-first blocked this command: it ' + parts.map((p) => p.what).join('; it ') + '. ' + WHY_WRITE + '\nInstead:\n' +
    parts.map((p) => '- ' + p.todo).join('\n') + '\n' + OUTRO;
}

export function readReason(items, cwd) {
  const list = unique(items);
  const names = list.map((it) => display(it.abs, cwd, it.text));
  return 'file-tools-first blocked this command: it only reads ' + names.join(', ') + ', which the Read tool does better. ' + WHY_READ +
    '\nInstead:\n' + list.map((it) => '- ' + readCall(it)).join('\n') + '\n' + OUTRO;
}

function deny(reason) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
}

// PreToolUse. Returns the hook reply, or null to let the command run.
export function handlePreToolUse(input, config = settings()) {
  if (!input) return null;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const command = toolInput.command;
  if (typeof command !== 'string' || command.trim() === '') return null;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let result;
  if (input.tool_name === 'Bash') result = classifyBash(command, cwd);
  else if (input.tool_name === 'PowerShell') result = classifyPwsh(command, cwd);
  else return null;
  if (result.writes.length) return deny(writeReason(result.writes, cwd));
  if (config.reads && result.reads.length) return deny(readReason(result.reads, cwd));
  return null;
}

export function handleSessionStart(input, config = settings()) {
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: sessionContext(config) } };
}

export function handle(input, config = settings()) {
  if (!input || typeof input !== 'object') return null;
  if (input.hook_event_name === 'SessionStart') return handleSessionStart(input, config);
  if (input.hook_event_name === 'PreToolUse') return handlePreToolUse(input, config);
  return null;
}
