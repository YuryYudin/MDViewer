import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const md = fs.readFileSync(path.join(dir, 'sample.md'), 'utf8');
const sidecar = JSON.parse(fs.readFileSync(path.join(dir, 'sample.md.comments.json'), 'utf8'));

for (const t of sidecar.threads) {
  const idx = md.indexOf(t.anchor.exact);
  if (idx === -1) {
    console.error(`could not find ${JSON.stringify(t.anchor.exact)} in sample.md`);
    process.exit(1);
  }
  t.anchor.start = idx;
  t.anchor.end = idx + t.anchor.exact.length;
}

fs.writeFileSync(
  path.join(dir, 'sample.md.comments.json'),
  JSON.stringify(sidecar, null, 2) + '\n',
);
console.log(`updated ${sidecar.threads.length} anchor offsets`);
