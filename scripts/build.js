'use strict';

// Produces a self-contained deployable bundle in dist/ with a manifest of
// SHA-256 file hashes, so the deployed version can be evidenced.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const include = ['server', 'public', 'docs', 'package.json', 'package-lock.json', '.env.example', 'README.md', 'Dockerfile'];

for (const f of fs.readdirSync(path.join(root, 'server'))) {
  if (f.endsWith('.js')) execSync(`node --check "${path.join(root, 'server', f)}"`);
}
execSync(`node --check "${path.join(root, 'public', 'app.js')}"`);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist);
for (const item of include) {
  const src = path.join(root, item);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(dist, item), { recursive: true });
}
fs.mkdirSync(path.join(dist, 'data'));

const files = {};
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else files[path.relative(dist, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  }
}(dist));

let commit = null;
try { commit = execSync('git rev-parse HEAD', { cwd: root }).toString().trim(); } catch { /* not a git checkout */ }
const pkg = require(path.join(root, 'package.json'));
fs.writeFileSync(path.join(dist, 'BUILD_INFO.json'), JSON.stringify({ name: pkg.name, version: pkg.version, commit, builtAt: new Date().toISOString(), files }, null, 2));
console.log(`Built ${Object.keys(files).length} files into dist/ (commit ${commit ? commit.slice(0, 8) : 'n/a'})`);
console.log('Deploy: cd dist && npm ci --omit=dev && npm start');
