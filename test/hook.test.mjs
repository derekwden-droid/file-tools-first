// Runs scripts/tool-router.mjs the way Claude Code does: hook input as JSON on stdin, reply as
// JSON on stdout.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handlePreToolUse, sessionContext } from '../scripts/lib/hook.mjs';
import { project } from './fixtures.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/tool-router.mjs', import.meta.url));
const p = project('hook');
test.after(() => p.cleanup());

function run(input, env = {}) {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env: { SystemRoot: process.env.SystemRoot, ...env },
  });
  return { status: result.status, stderr: result.stderr, reply: result.stdout ? JSON.parse(result.stdout) : null };
}

const bash = (command, extra = {}) => ({ hook_event_name: 'PreToolUse', cwd: p.dir, tool_name: 'Bash', tool_input: { command }, ...extra });
const reason = (r) => r.reply.hookSpecificOutput.permissionDecisionReason;

test('blocks a sed -i edit and names the Edit to make', () => {
  const { status, reply } = run(bash("sed -i 's/3000/4000/' config.yml"));
  assert.equal(status, 0);
  assert.equal(reply.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(reply.hookSpecificOutput.permissionDecision, 'deny');
  const text = reply.hookSpecificOutput.permissionDecisionReason;
  assert.match(text, /^tool-router blocked this command: it edits config\.yml in place with sed -i\./);
  assert.match(text, /can't be undone with \/rewind/);
  assert.ok(text.includes('- Edit ' + p.file('config.yml')));
  assert.match(text, /starting their message with !/);
});

test('blocks a heredoc that creates a file and names the Write', () => {
  const r = run(bash("cat > src/new.ts <<'EOF'\nexport const a = 1;\nEOF"));
  assert.match(reason(r), /it creates src[\\/]new\.ts\./);
  assert.ok(reason(r).includes('- Write ' + p.file('src/new.ts')));
});

test('blocks text written over an existing file and appended to one', () => {
  const r = run(bash('echo "a" > notes.txt && echo "b" >> README.md'));
  assert.match(reason(r), /it writes text over notes\.txt; it appends text to README\.md\./);
  assert.ok(reason(r).includes('- Write ' + p.file('notes.txt') + ' (or Edit it to change part of it)'));
});

test('blocks a read-only command and gives the Read call with offset and limit', () => {
  const r = run(bash("sed -n '10,20p' src/app.ts"));
  assert.match(reason(r), /it only reads src[\\/]app\.ts, which the Read tool does better/);
  assert.ok(reason(r).includes('- Read file_path "' + p.file('src/app.ts') + '" with offset 10 and limit 11'));
  const head = run(bash('head -n 5 README.md'));
  assert.ok(reason(head).includes('with limit 5'));
});

test('blocks PowerShell writes and reads too', () => {
  const w = run({ ...bash(''), tool_name: 'PowerShell', tool_input: { command: "Set-Content -Path config.yml -Value 'x'" } });
  assert.match(reason(w), /it writes text over config\.yml/);
  const r = run({ ...bash(''), tool_name: 'PowerShell', tool_input: { command: 'Get-Content README.md -TotalCount 3' } });
  assert.match(reason(r), /with limit 3/);
});

test('lets ordinary commands through silently', () => {
  for (const command of ['npm test', 'git status', 'npm run build > build.log 2>&1', 'ls -la; cat README.md']) {
    const { status, reply } = run(bash(command));
    assert.equal(status, 0, command);
    assert.equal(reply, null, command);
  }
  assert.equal(run({ ...bash('cat README.md'), tool_name: 'Read' }).reply, null);
});

test('adds the session-start note', () => {
  const { reply } = run({ hook_event_name: 'SessionStart', source: 'startup', cwd: p.dir });
  assert.equal(reply.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(reply.hookSpecificOutput.additionalContext, /^tool-router is active\. Read files with the Read tool, change them with Edit/);
});

test('TOOL_ROUTER_READS=allow lets reads through but still blocks writes', () => {
  const env = { TOOL_ROUTER_READS: 'allow' };
  assert.equal(run(bash('cat README.md'), env).reply, null);
  assert.match(reason(run(bash("sed -i 's/a/b/' config.yml"), env)), /in place/);
  assert.doesNotMatch(sessionContext({ reads: false }), /cat, head/);
});

test('TOOL_ROUTER=off turns everything off', () => {
  const env = { TOOL_ROUTER: 'off' };
  assert.equal(run(bash("sed -i 's/a/b/' config.yml"), env).reply, null);
  assert.equal(run({ hook_event_name: 'SessionStart', source: 'startup' }, env).reply, null);
});

test('fails open: malformed input exits 1 without a decision', () => {
  const { status, reply, stderr } = run('{"hook_event_name": "PreToolUse", broken');
  assert.equal(status, 1);
  assert.equal(reply, null);
  assert.match(stderr, /^tool-router: /);
});

test('handlePreToolUse ignores empty commands and other tools', () => {
  const config = { off: false, reads: true };
  assert.equal(handlePreToolUse(bash('   '), config), null);
  assert.equal(handlePreToolUse({ ...bash("sed -i 's/a/b/' config.yml"), tool_name: 'Edit' }, config), null);
  assert.equal(handlePreToolUse(null, config), null);
});
