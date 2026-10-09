// A throwaway project folder for the tests. It sits inside the repository, not the system's
// temporary folder, because tool-router deliberately ignores writes to temporary folders.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function project(name) {
  const dir = path.join(HERE, '.fixtures-' + name + '-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  for (const f of ['config.yml', 'README.md', 'src/app.ts', 'package.json', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, f), Array.from({ length: 40 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n');
  }
  return { dir, file: (f) => path.join(dir, f), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
