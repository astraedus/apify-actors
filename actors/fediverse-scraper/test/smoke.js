/**
 * Smoke test: run the Actor for real against the default input and assert it produced data.
 *
 * This is the same thing Apify's daily automated test does -- a default-input run that
 * must succeed inside five minutes -- so failing here means failing there, where the
 * penalty is an "Under Maintenance" badge on the Store listing.
 *
 * Usage: npm run smoke
 */

import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const actorDir = dirname(dirname(fileURLToPath(import.meta.url)));
const datasetDir = join(actorDir, 'storage', 'datasets', 'default');
const TIMEOUT_MS = 5 * 60 * 1000;

/** Apify grades the default run on a five-minute budget, so measure against that. */
function run() {
    return new Promise((resolve, reject) => {
        const child = spawn('apify', ['run', '--purge'], {
            cwd: actorDir,
            stdio: 'inherit',
            env: { ...process.env, APIFY_LOG_LEVEL: 'INFO' },
        });
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new Error(`Actor did not finish within ${TIMEOUT_MS / 1000}s -- Apify's daily test would fail.`));
        }, TIMEOUT_MS);

        child.on('error', (error) => {
            clearTimeout(timer);
            reject(error.code === 'ENOENT'
                ? new Error('The Apify CLI is not installed. Run: npm i -g apify-cli')
                : error);
        });
        child.on('exit', (code) => {
            clearTimeout(timer);
            if (code === 0) resolve();
            else reject(new Error(`apify run exited with code ${code}`));
        });
    });
}

function readDataset() {
    if (!existsSync(datasetDir)) return [];
    return readdirSync(datasetDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => JSON.parse(readFileSync(join(datasetDir, name), 'utf8')));
}

const started = Date.now();
if (existsSync(join(actorDir, 'storage'))) rmSync(join(actorDir, 'storage'), { recursive: true, force: true });

await run();
const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const items = readDataset();

const failures = [];
if (items.length < 1) failures.push(`expected at least 1 dataset item, got ${items.length}`);

const platforms = new Set(items.map((item) => item.platform));
if (!platforms.has('mastodon')) failures.push('no Mastodon rows -- the Mastodon path is broken');
if (!platforms.has('bluesky')) failures.push('no Bluesky rows -- the Bluesky path is broken');

const REQUIRED_KEYS = ['platform', 'type', 'id', 'author', 'text', 'createdAt', 'media', 'hashtags', 'target'];
for (const item of items) {
    for (const key of REQUIRED_KEYS) {
        if (!(key in item)) {
            failures.push(`row ${item.id} is missing "${key}"`);
            break;
        }
    }
}

const byType = items.reduce((acc, item) => ({ ...acc, [item.type]: (acc[item.type] ?? 0) + 1 }), {});
console.log('\n--- smoke result ---');
console.log(`items:     ${items.length}`);
console.log(`elapsed:   ${elapsed}s (budget 300s)`);
console.log(`platforms: ${[...platforms].join(', ') || 'none'}`);
console.log(`by type:   ${JSON.stringify(byType)}`);

if (failures.length > 0) {
    console.error('\nFAILED:');
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('\nPASS');
