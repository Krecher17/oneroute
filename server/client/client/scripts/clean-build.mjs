// Removes files a previous build generated in ../server/public, and nothing else.
// Your own static files there (terms.html, privacy.html, ...) are never touched.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../server/public');
if (!fs.existsSync(out)) { console.log('clean-build: nothing to clean (server/public does not exist yet)'); process.exit(0); }

const removed = [];
const rm = (p) => { fs.rmSync(p, { recursive: true, force: true }); removed.push(path.relative(out, p)); };
for (const name of fs.readdirSync(out)) {
  const full = path.join(out, name);
  if (name === 'assets' || name === 'index.html' || name === 'sw.js' || name === 'registerSW.js' ||
      name === 'manifest.webmanifest' || /^workbox-.*\.js(\.map)?$/.test(name) || /^sw\.js\.map$/.test(name)) rm(full);
}
console.log(removed.length ? `clean-build: removed ${removed.join(', ')}` : 'clean-build: nothing to remove');
