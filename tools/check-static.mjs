#!/usr/bin/env node
/**
 * Static integrity checks for a no-build site.
 *
 * Without a bundler nothing verifies that the files the app references
 * actually exist, so these are the failures that would otherwise only show up
 * in a browser: a precache entry pointing at a deleted module, an import typo,
 * an icon missing from the manifest, or an inline style the CSP will block.
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const fail = (message) => problems.push(message);

const read = (p) => readFileSync(join(root, p), 'utf8');
const exists = (p) => existsSync(join(root, p));

function walk(dir, out = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = join(dir, entry);
    if (statSync(join(root, rel)).isDirectory()) walk(rel, out);
    else out.push(rel);
  }
  return out;
}

/* 1. Every precached path exists, and every shipped module is precached. */
const sw = read('sw.js');
const precached = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter(Boolean);
for (const path of precached) {
  if (!exists(path)) fail(`sw.js precaches a missing file: ${path}`);
}
for (const module of walk('js')) {
  const normalised = module.split('\\').join('/');
  if (!precached.includes(normalised)) {
    fail(`${normalised} ships but is not in the sw.js precache list — it will not be available offline`);
  }
}

/* 2. Every relative import resolves. */
for (const file of walk('js')) {
  const source = read(file);
  for (const [, spec] of source.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = normalize(join(dirname(file), spec));
    if (!exists(target)) fail(`${file} imports ${spec}, which does not exist`);
  }
}

/* 3. The manifest parses and its icons exist. */
let manifest;
try {
  manifest = JSON.parse(read('manifest.webmanifest'));
} catch (err) {
  fail(`manifest.webmanifest is not valid JSON: ${err.message}`);
}
if (manifest) {
  for (const icon of manifest.icons || []) {
    const path = icon.src.replace(/^\.\//, '');
    if (!exists(path)) fail(`manifest references a missing icon: ${icon.src}`);
  }
  if (!(manifest.icons || []).some((i) => i.sizes === '512x512' && (i.purpose || '').includes('maskable'))) {
    fail('manifest needs a 512x512 maskable icon for a good Android install');
  }
  for (const field of ['name', 'start_url', 'scope', 'display', 'theme_color', 'background_color']) {
    if (!manifest[field]) fail(`manifest is missing ${field}`);
  }
}

/* 4. Everything index.html references exists, and paths stay relative so the
      app works from a project subpath such as /GitHubPage.io/. */
const html = read('index.html');
for (const [, href] of html.matchAll(/(?:href|src)="([^"#][^"]*)"/g)) {
  if (/^(https?:)?\/\//.test(href)) {
    fail(`index.html references an absolute URL (${href}); everything must be same-origin and relative`);
    continue;
  }
  if (href.startsWith('/')) fail(`index.html uses a root-absolute path (${href}); use ./ so it works under a subpath`);
  const path = href.replace(/^\.\//, '');
  if (!exists(path)) fail(`index.html references a missing file: ${href}`);
}

/* 5. The CSP blocks inline styles, so no element may carry a style attribute.
      Dynamic values go through CSSOM (`node.style.width = …`) instead. */
if (!/Content-Security-Policy/.test(html)) fail('index.html is missing its Content-Security-Policy');
for (const file of walk('js')) {
  const source = read(file);
  const lines = source.split('\n');
  lines.forEach((line, i) => {
    if (/\bstyle:\s*[`'"]/.test(line)) {
      fail(`${file}:${i + 1} sets an inline style attribute, which the CSP blocks — use a class or CSSOM`);
    }
  });
}

/* 6. No stray debugging left in shipped code. */
for (const file of [...walk('js'), 'sw.js']) {
  const source = read(file);
  if (/\bdebugger\b/.test(source)) fail(`${file} contains a debugger statement`);
  if (/console\.log\(/.test(source)) fail(`${file} contains a console.log`);
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'} found:\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}`);
  console.error('');
  process.exit(1);
}

console.log(`static checks passed (${precached.length} precached files, ${walk('js').length} modules, ${relative('.', root) || '.'})`);
