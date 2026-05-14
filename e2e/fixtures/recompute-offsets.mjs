import fs from 'node:fs';
import path from 'node:path';

const dir = path.dirname(new URL(import.meta.url).pathname);
const base = process.argv[2] || 'sample';
const mdPath = path.join(dir, `${base}.md`);
const sidecarPath = path.join(dir, `${base}.md.comments.json`);

const md = fs.readFileSync(mdPath, 'utf8');
const sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));

for (const t of sidecar.threads) {
  const idx = md.indexOf(t.anchor.exact);
  if (idx === -1) {
    console.error(`could not find ${JSON.stringify(t.anchor.exact)} in ${base}.md`);
    process.exit(1);
  }
  t.anchor.start = idx;
  t.anchor.end = idx + t.anchor.exact.length;
}

fs.writeFileSync(
  sidecarPath,
  JSON.stringify(sidecar, null, 2) + '\n',
);
console.log(`updated ${sidecar.threads.length} anchor offsets in ${base}.md.comments.json`);
