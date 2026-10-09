#!/usr/bin/env node
// tool-router's hook entry point. The plugin's hooks.json runs it at session start and before
// every Bash and PowerShell command (PreToolUse). It reads the hook input as JSON on standard
// input and prints a JSON reply only when it has something to say: the session-start note, or
// a block naming the file tool to use. Any error exits with status 1, which Claude Code reports
// without blocking the command.

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  const raw = await readStdin();
  const { handle } = await import('./lib/hook.mjs');
  const reply = handle(JSON.parse(raw));
  if (reply) process.stdout.write(JSON.stringify(reply));
}

main().catch((err) => {
  process.stderr.write('tool-router: ' + (err && err.message ? err.message : String(err)) + '\n');
  process.exitCode = 1;
});
