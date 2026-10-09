import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyPwsh, tokenizePwsh } from '../scripts/lib/pwsh.mjs';
import { project } from './fixtures.mjs';

const p = project('pwsh');
test.after(() => p.cleanup());

const writes = (cmd) => classifyPwsh(cmd, p.dir).writes.map((w) => w.kind + ':' + w.text);
const reads = (cmd) => classifyPwsh(cmd, p.dir).reads.map((r) => [r.text, r.offset, r.limit]);

test('splits statements, stages, strings, here-strings and groups', () => {
  const statements = tokenizePwsh("cd src; (Get-Content 'a b.txt') -replace 'x','y' | Set-Content \"a b.txt\" 2>&1\n@'\nraw $text\n'@ > out.md");
  assert.equal(statements.length, 3);
  assert.equal(statements[1].length, 2);
  assert.equal(statements[1][0][0].type, 'group');
  assert.deepEqual(statements[2][0][0], { type: 'string', value: 'raw $text', literal: true });
});

test('blocks text written into files', () => {
  assert.deepEqual(writes("Set-Content -Path config.yml -Value 'port: 4000'"), ['literal:config.yml']);
  assert.deepEqual(writes("Set-Content notes.txt 'hello'"), ['literal:notes.txt']);
  assert.deepEqual(writes("sc notes.txt -Value 'hello'"), ['literal:notes.txt']);
  assert.deepEqual(writes("'hello' | Out-File notes.txt"), ['literal:notes.txt']);
  assert.deepEqual(writes("@'\nline a\nline b\n'@ | Set-Content new.md"), ['literal:new.md']);
  assert.deepEqual(writes("Add-Content -Path notes.txt -Value 'more'"), ['append:notes.txt']);
  assert.deepEqual(writes("New-Item -ItemType File -Path a.txt -Value 'hi'"), ['literal:a.txt']);
  assert.deepEqual(writes("echo 'x' > out.txt"), ['literal:out.txt']);
  assert.deepEqual(writes("\"text\" >> notes.txt"), ['append:notes.txt']);
  assert.deepEqual(writes("[System.IO.File]::WriteAllText('notes.txt', 'hi')"), ['literal:notes.txt']);
});

test('blocks a file rewritten from its own contents', () => {
  assert.deepEqual(writes("(Get-Content config.yml) -replace '3000','4000' | Set-Content config.yml"), ['rewrite:config.yml']);
  assert.deepEqual(writes("$c = Get-Content -Raw config.yml; $c = $c.Replace('a','b'); Set-Content config.yml $c"), ['rewrite:config.yml']);
});

test('follows Set-Location when matching a read-back to its write', () => {
  const cmd = "Set-Location src; (Get-Content app.ts) -replace 'a','b' | Set-Content app.ts";
  const [w] = classifyPwsh(cmd, p.dir).writes;
  assert.equal(w.kind, 'rewrite');
  assert.equal(w.abs, p.file('src/app.ts'));
  const elsewhere = 'Set-Location ' + JSON.stringify(p.dir) + "; (Get-Content config.yml) -replace 'a','b' | Set-Content config.yml";
  assert.equal(classifyPwsh(elsewhere, p.file('src')).writes[0].kind, 'rewrite');
});

test('lets ordinary PowerShell work through', () => {
  for (const cmd of [
    'Get-Process | Out-File procs.txt', 'npm test *> test.log', 'Get-Content README.md -Tail 20',
    'Get-Content README.md | Select-String line', 'New-Item -ItemType Directory -Path dist',
    "Set-Content $env:TEMP\\msg.txt 'hi'", 'Get-ChildItem -Recurse | Out-File list.txt', 'git status',
    'Get-Content src\\*.ts', "Set-Content out.txt $result", 'Get-Content missing.txt', 'npm run build 2>&1 | Tee-Object build.log',
  ]) {
    const r = classifyPwsh(cmd, p.dir);
    assert.deepEqual([r.writes.length, r.reads.length], [0, 0], cmd);
  }
});

test('routes Get-Content reads to Read', () => {
  assert.deepEqual(reads('Get-Content README.md'), [['README.md', null, null]]);
  assert.deepEqual(reads('gc src/app.ts -TotalCount 30'), [['src/app.ts', null, 30]]);
  assert.deepEqual(reads('Get-Content README.md | Select-Object -Skip 9 -First 11'), [['README.md', 10, 11]]);
  assert.deepEqual(reads('Set-Location src; Get-Content app.ts'), [['app.ts', null, null]]);
  assert.equal(classifyPwsh('cd src; Get-Content app.ts', p.dir).reads[0].abs, p.file('src/app.ts'));
});
