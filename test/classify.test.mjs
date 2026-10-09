import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { classifyBash, scriptTargets } from '../scripts/lib/classify.mjs';
import { project } from './fixtures.mjs';

const p = project('classify');
test.after(() => p.cleanup());

const writes = (cmd) => classifyBash(cmd, p.dir).writes.map((w) => w.kind + ':' + w.text);
const reads = (cmd) => classifyBash(cmd, p.dir).reads.map((r) => [r.text, r.offset, r.limit]);

test('blocks in-place edits by sed, perl, ruby and awk', () => {
  assert.deepEqual(writes("sed -i 's/3000/4000/' config.yml"), ['inplace:config.yml']);
  assert.deepEqual(writes("sed -i '' -e 's/a/b/' src/app.ts"), ['inplace:src/app.ts']);
  assert.deepEqual(writes("sed -Ei.bak 's/a/b/' config.yml notes.txt"), ['inplace:config.yml', 'inplace:notes.txt']);
  assert.deepEqual(writes("sed --in-place=.orig 's/a/b/' config.yml"), ['inplace:config.yml']);
  assert.deepEqual(writes("perl -pi -e 's/foo/bar/g' src/app.ts"), ['inplace:src/app.ts']);
  assert.deepEqual(writes("perl -0777 -i.bak -pe 's/a/b/' config.yml"), ['inplace:config.yml']);
  assert.deepEqual(writes("ruby -pi -e 'gsub(/a/, \"b\")' config.yml"), ['inplace:config.yml']);
  assert.deepEqual(writes("awk -i inplace '{ print }' config.yml"), ['inplace:config.yml']);
});

test('blocks in-place edits spread over files by loops, find and xargs', () => {
  assert.deepEqual(writes("for f in src/*.ts; do sed -i 's/a/b/' \"$f\"; done"), ['inplace:$f']);
  assert.deepEqual(writes("find . -name '*.ts' -exec sed -i 's/a/b/' {} +"), ['inplace:the files find matches']);
  assert.deepEqual(writes("grep -rl foo src | xargs sed -i 's/foo/bar/'"), ['inplace:the files xargs passes']);
  assert.deepEqual(writes('cd src && sed -i s/a/b/ app.ts'), ['inplace:app.ts']);
  assert.equal(classifyBash('cd src && sed -i s/a/b/ app.ts', p.dir).writes[0].abs, p.file('src/app.ts'));
});

test('blocks text written into files', () => {
  assert.deepEqual(writes("cat > notes.txt <<'EOF'\nhello\nEOF"), ['literal:notes.txt']);
  assert.deepEqual(writes('cat <<EOF > new.md\n# Title\nEOF'), ['literal:new.md']);
  assert.deepEqual(writes('echo "PORT=3000" > .env'), ['literal:.env']);
  assert.deepEqual(writes('echo "export X=1" >> config.yml'), ['append:config.yml']);
  assert.deepEqual(writes("printf 'a\\nb\\n' > src/list.txt"), ['literal:src/list.txt']);
  assert.deepEqual(writes("cat <<'EOF' | tee src/out.ts\nconst a = 1;\nEOF"), ['literal:src/out.ts']);
  assert.deepEqual(writes("tee -a notes.txt <<< 'more'"), ['append:notes.txt']);
  assert.deepEqual(writes(': > config.yml'), ['literal:config.yml']);
});

test('blocks inline scripts that rewrite an existing file', () => {
  assert.deepEqual(writes("python3 - <<'EOF'\np='config.yml'\ns=open(p).read().replace('a','b')\nopen(p,'w').write(s)\nEOF"), ['script:config.yml']);
  assert.deepEqual(writes("node -e \"require('fs').writeFileSync('package.json', '{}')\""), ['script:package.json']);
  assert.deepEqual(writes("python -c \"from pathlib import Path; Path('notes.txt').write_text('x')\""), ['script:notes.txt']);
});

test('lets ordinary shell work through', () => {
  for (const cmd of [
    'npm test > test.log 2>&1', 'npm run build | tee build.log', 'git diff > changes.patch', 'echo $PATH > path.txt',
    'cat a.txt b.txt > combined.txt', "sed 's/a/b/' config.yml > config.new", "sed -n '/foo/,/bar/p' src/app.ts",
    'tail -n 20 README.md', 'cat README.md | grep line', 'ls -la; cat README.md', 'echo hi', 'echo hi > /dev/null',
    "python -c \"import json; json.dump({}, open('report.json','w'))\"", 'python3 script.py', 'prettier --write src/app.ts',
    "git commit -m \"$(cat <<'EOF'\nIt didn't work\nEOF\n)\"", 'cat missing-file.txt', 'cat src', 'wc -l README.md',
    'cat <<EOF\njust printing\nEOF', 'rm notes.txt', 'cp config.yml config.bak', 'head -c 100 README.md',
  ]) {
    const r = classifyBash(cmd, p.dir);
    assert.deepEqual([r.writes.length, r.reads.length], [0, 0], cmd);
  }
});

test('ignores writes to temporary folders, devices and .git', () => {
  for (const cmd of [
    "cat > /tmp/msg.txt <<'EOF'\nhi\nEOF", 'echo hi > "$TMPDIR/x.txt"', 'echo hi > ${TMP}/x', "sed -i 's/a/b/' /tmp/x.txt",
    'echo hi > ' + JSON.stringify(path.join(os.tmpdir(), 'x.txt')), 'echo hi > nul', 'echo msg > .git/COMMIT_EDITMSG',
  ]) {
    assert.deepEqual(classifyBash(cmd, p.dir).writes, [], cmd);
  }
});

test('routes commands that only read single files to Read', () => {
  assert.deepEqual(reads("sed -n '10,20p' src/app.ts"), [['src/app.ts', 10, 11]]);
  assert.deepEqual(reads('sed -n 5p README.md'), [['README.md', 5, 1]]);
  assert.deepEqual(reads("sed -n '30,$p' README.md"), [['README.md', 30, null]]);
  assert.deepEqual(reads('cat README.md'), [['README.md', null, null]]);
  assert.deepEqual(reads('cat -n src/app.ts'), [['src/app.ts', null, null]]);
  assert.deepEqual(reads('head -n 50 src/app.ts'), [['src/app.ts', null, 50]]);
  assert.deepEqual(reads('head -20 README.md config.yml'), [['README.md', null, 20], ['config.yml', null, 20]]);
  assert.deepEqual(reads('echo "---"; cat README.md; echo; cat config.yml'), [['README.md', null, null], ['config.yml', null, null]]);
  assert.deepEqual(reads('cat README.md 2>/dev/null || echo missing'), [['README.md', null, null]]);
});

test('finds the files inline scripts write', () => {
  assert.deepEqual(scriptTargets("open('a.txt', 'w').write(x)\nopen(\"b.txt\", mode='a')\nopen('c.txt').read()", 'python'), ['a.txt', 'b.txt']);
  assert.deepEqual(scriptTargets("out = Path('d.txt')\nout.write_text(s)", 'python'), ['d.txt']);
  assert.deepEqual(scriptTargets("const f = 'e.json'; fs.writeFileSync(f, s); fs.appendFileSync(`g.log`, s)", 'node'), ['g.log', 'e.json']);
  assert.deepEqual(scriptTargets("File.write('h.txt', s)", 'ruby'), ['h.txt']);
  assert.deepEqual(scriptTargets("open(f'{name}.txt', 'w')", 'python'), []);
});
