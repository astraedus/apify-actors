#!/usr/bin/env node
/**
 * Smoke test: run the Actor locally against the ZERO-CONFIG default input and
 * assert it produces real rows, the way Apify's daily automated test does.
 *
 * This is the test that protects the Store listing: a default run that fails or
 * returns nothing earns an "Under Maintenance" label after three consecutive
 * days, and deprecation 28 days after that.
 *
 * Usage: npm run smoke
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ACTOR_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const STORAGE = join(ACTOR_DIR, 'storage');
const DATASET_DIR = join(STORAGE, 'datasets', 'default');
const RUN_TIMEOUT_MS = 5 * 60 * 1000; // Apify's own ceiling for the default-input test.

function fail(message) {
    console.error(`\nSMOKE FAILED: ${message}\n`);
    process.exit(1);
}

// A fresh state store, so the run behaves like a first run and emits a baseline.
// Without this a second smoke run would legitimately find nothing new and the
// assertion below would flap.
if (existsSync(STORAGE)) rmSync(STORAGE, { recursive: true, force: true });

// An explicit empty input proves the DEFAULTS carry the run — not something the
// CLI happened to prefill from the schema.
const inputDir = join(STORAGE, 'key_value_stores', 'default');
mkdirSync(inputDir, { recursive: true });
writeFileSync(join(inputDir, 'INPUT.json'), '{}\n');

console.log('Running `apify run` against the default (empty) input...');
const started = Date.now();
try {
    execFileSync('apify', ['run'], {
        cwd: ACTOR_DIR,
        stdio: 'inherit',
        timeout: RUN_TIMEOUT_MS,
        env: { ...process.env, APIFY_LOG_LEVEL: 'INFO' },
    });
} catch (error) {
    fail(`\`apify run\` exited non-zero: ${error.message}`);
}
const elapsedMs = Date.now() - started;

if (!existsSync(DATASET_DIR)) fail(`no dataset directory at ${DATASET_DIR}`);

const files = readdirSync(DATASET_DIR).filter((f) => f.endsWith('.json'));
if (files.length < 1) fail('the default run produced 0 dataset items; Apify requires a working default run');

const items = files.map((f) => JSON.parse(readFileSync(join(DATASET_DIR, f), 'utf8')));

// Shape assertions: a run that emits malformed rows is as bad as one that emits none.
const REQUIRED_FIELDS = [
    'store',
    'appId',
    'appName',
    'country',
    'reviewId',
    'rating',
    'title',
    'text',
    'author',
    'date',
    'appVersion',
    'developerReply',
    'url',
    'isNew',
];

for (const [index, item] of items.entries()) {
    for (const field of REQUIRED_FIELDS) {
        if (!(field in item)) fail(`dataset item ${index} is missing the "${field}" field`);
    }
    if (item.store !== 'google-play' && item.store !== 'app-store') {
        fail(`dataset item ${index} has an unknown store "${item.store}"`);
    }
    if (item.isNew !== true) fail(`dataset item ${index} was emitted with isNew !== true`);
    if (typeof item.reviewId !== 'string' || item.reviewId.length === 0) {
        fail(`dataset item ${index} has no reviewId, so it can never be de-duplicated`);
    }
}

const ids = items.map((i) => i.reviewId);
if (new Set(ids).size !== ids.length) fail('the run emitted duplicate reviewIds within a single dataset');

if (elapsedMs > RUN_TIMEOUT_MS) fail(`the default run took ${Math.round(elapsedMs / 1000)}s, over Apify's 5-minute limit`);

const byStore = items.reduce((acc, i) => ({ ...acc, [i.store]: (acc[i.store] ?? 0) + 1 }), {});
console.log(
    `\nSMOKE PASSED: ${items.length} dataset item(s) in ${(elapsedMs / 1000).toFixed(1)}s — ` +
        `${Object.entries(byStore).map(([s, n]) => `${s}: ${n}`).join(', ')}`,
);
