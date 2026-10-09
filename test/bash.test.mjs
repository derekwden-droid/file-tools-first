import test from 'node:test';
import assert from 'node:assert/strict';
import { commandOf, parseBash } from '../scripts/lib/bash.mjs';

const names = (src) => parseBash(src).pipelines.map((p) => p.map((c) => commandOf(c).name));

test('splits lists and pipelines', () => {
  assert.deepEqual(names('cd src && npm test | tee log; echo done || true &'), [['cd'], ['npm', 'tee'], ['echo'], ['true']]);
  assert.deepEqual(names('a\nb'), [['a'], ['b']]);
});

test('reads quotes, escapes and expansions as single words', () => {
  const [[cmd]] = parseBash("sed -i 's/a b/c d/' \"my file.txt\" $'x\\ty' plain\\ space").pipelines;
  assert.deepEqual(cmd.words.map((w) => w.value), ['sed', '-i', 's/a b/c d/', 'my file.txt', 'x\\ty', 'plain space']);
  const [[echo]] = parseBash('echo "$(date +%s) and ${HOME}" `id` $USER').pipelines;
  assert.equal(echo.words.length, 4);
  assert.ok(echo.words.slice(1).every((w) => w.dynamic));
});

test('collects redirects with their descriptors', () => {
  const [[cmd]] = parseBash('npm test > out.log 2>&1 2>/dev/null >> more.log &> all.log').pipelines;
  assert.deepEqual(cmd.redirects.map((r) => [r.fd, r.op, r.target && r.target.value]), [
    [null, '>', 'out.log'], ['2', '>&', '1'], ['2', '>', '/dev/null'], [null, '>>', 'more.log'], [null, '&>', 'all.log'],
  ]);
});

test('attaches here-document bodies to their command', () => {
  const { pipelines } = parseBash("cat > a.txt <<'EOF'\nline 1\n  line 2\nEOF\necho after");
  assert.equal(pipelines[0][0].heredoc.body, 'line 1\n  line 2');
  assert.equal(pipelines[0][0].heredoc.quoted, true);
  assert.equal(commandOf(pipelines[1][0]).name, 'echo');
  const stripped = parseBash('cat <<-END\n\tindented\n\tEND\n').pipelines[0][0];
  assert.equal(stripped.heredoc.body, 'indented');
});

test('keeps here-documents inside command substitutions out of the command list', () => {
  const src = "git commit -m \"$(cat <<'EOF'\nIt didn't (quite) work\nEOF\n)\" && git push";
  assert.deepEqual(names(src), [['git'], ['git']]);
});

test('skips keywords, assignments and wrappers to find the command', () => {
  for (const [src, name] of [['sudo sed -i x f', 'sed'], ['FOO=1 BAR=2 node x.js', 'node'], ['if true; then cat f; fi', 'true'], ['/usr/bin/env -i python3 -c 1', 'python3'], ['C:/tools/sed.exe -n 1p f', 'sed']]) {
    assert.equal(commandOf(parseBash(src).pipelines[0][0]).name, name, src);
  }
});

test('keeps comments apart and tolerates unbalanced input', () => {
  const { pipelines, comments } = parseBash('ls # list it\necho "unterminated');
  assert.deepEqual(comments, ['# list it']);
  assert.equal(pipelines.length, 2);
  assert.doesNotThrow(() => parseBash('$(( 1 + ( 2 )'));
  assert.doesNotThrow(() => parseBash("cat <<EOF\nno end"));
});
