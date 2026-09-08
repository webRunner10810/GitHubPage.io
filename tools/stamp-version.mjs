#!/usr/bin/env node
/**
 * Stamp a build identity into the service worker before deploying.
 *
 * The service worker serves precached assets cache-first, so its cache name
 * has to change whenever any shipped file changes — otherwise a returning
 * visitor keeps the old bundle indefinitely. CI passes the commit SHA.
 *
 * Usage: node tools/stamp-version.mjs [version]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const SW = new URL('../sw.js', import.meta.url);

function resolveVersion() {
  const explicit = process.argv[2] || process.env.GITHUB_SHA;
  if (explicit) return explicit.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return `dev-${Date.now().toString(36)}`;
  }
}

const version = resolveVersion();
const source = readFileSync(SW, 'utf8');
const stamped = source.replace(/^const CACHE = '[^']*';$/m, `const CACHE = 'summary-${version}';`);

if (stamped === source) {
  console.error('stamp-version: could not find the CACHE constant in sw.js');
  process.exit(1);
}

writeFileSync(SW, stamped);
console.log(`stamped service worker cache as summary-${version}`);
