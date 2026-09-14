#!/usr/bin/env node
/**
 * Apply `.actor/store-config.json` to the published Actor via the Apify API.
 *
 * Pay-per-event prices and store SEO are platform state, not build state —
 * `actor.json` has no keys for them. Rather than click them into the Console by
 * hand (unreproducible, and invisible in git), we version them and PUT them.
 *
 * Usage:
 *   APIFY_TOKEN=... node scripts/apply-store-config.mjs [--public] [--no-pricing] [--dry-run]
 *
 * The token is also read from ~/.secrets/apify-token if the env var is unset.
 * `--public` additionally flips isPublic to true (listing the Actor on the Store).
 * `--no-pricing` applies only the listing metadata (title/description/SEO/categories).
 *
 * NOTE: Apify rejects any pricing write with `cannot-monetize-without-payout-billing-info`
 * until payout billing details are completed once, per account, in the Console at
 * https://console.apify.com/actors/<actorId>/publication. That is a human/legal step
 * (tax + payout identity) that no API can substitute. Until it is done, run this with
 * --no-pricing to stage the listing, and do NOT make the Actor public — a public Actor
 * with no pricing is a free Actor.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(HERE, '..', '.actor', 'store-config.json');
const ACTOR_JSON_PATH = join(HERE, '..', '.actor', 'actor.json');

function readToken() {
    if (process.env.APIFY_TOKEN) return process.env.APIFY_TOKEN.trim();

    try {
        return readFileSync(join(homedir(), '.secrets', 'apify-token'), 'utf8').trim();
    } catch {
        throw new Error('No Apify token: set APIFY_TOKEN or create ~/.secrets/apify-token');
    }
}

async function api(path, token, init = {}) {
    const response = await fetch(`https://api.apify.com/v2${path}`, {
        ...init,
        headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
            ...init.headers,
        },
    });

    const text = await response.text();
    const body = text.length > 0 ? JSON.parse(text) : {};

    if (!response.ok) {
        throw new Error(`${init.method ?? 'GET'} ${path} -> HTTP ${response.status}: ${text.slice(0, 500)}`);
    }

    return body.data ?? body;
}

const token = readToken();
const makePublic = process.argv.includes('--public');
const dryRun = process.argv.includes('--dry-run');
const noPricing = process.argv.includes('--no-pricing');

const { _comment, ...config } = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
const { name: actorName } = JSON.parse(readFileSync(ACTOR_JSON_PATH, 'utf8'));

const me = await api('/users/me', token);
const actorId = `${me.username}~${actorName}`;

console.log(`Actor: ${actorId}`);

const current = await api(`/acts/${actorId}`, token);

console.log(`Current: isPublic=${current.isPublic}, pricing=${current.pricingInfos?.at(-1)?.pricingModel ?? 'none'}`);

const payload = { ...config };
if (makePublic) payload.isPublic = true;
if (noPricing) {
    delete payload.pricingInfos;
    console.log('--no-pricing: applying listing metadata only, leaving pricing untouched.');
}

// Event names must match what the code actually charges. That invariant is
// enforced properly by test/config.test.ts (run `npm test` before publishing);
// this is just an operator-facing echo of what is about to be priced.
const configured = config.pricingInfos?.[0]?.pricingPerEvent?.actorChargeEvents ?? {};
for (const [event, spec] of Object.entries(configured)) {
    console.log(`  will price "${event}" at $${spec.eventPriceUsd}`);
}

if (dryRun) {
    console.log('\n--dry-run, would PUT:\n', JSON.stringify(payload, null, 2));
    process.exit(0);
}

const updated = await api(`/acts/${actorId}`, token, {
    method: 'PUT',
    body: JSON.stringify(payload),
});

// Read back rather than trusting the PUT response: Actor.charge() silently
// charges nothing for an event the platform does not know about, so an event
// that failed to register would mean every run serves paid work for free, with
// no error anywhere. Verify against what the API now actually reports.
const verified = await api(`/acts/${actorId}`, token);
const applied = verified.pricingInfos?.at(-1);
const registered = applied?.pricingPerEvent?.actorChargeEvents ?? {};

console.log(`\nApplied. isPublic=${verified.isPublic}, pricingModel=${applied?.pricingModel ?? 'none'}`);

const missing = noPricing ? [] : Object.keys(configured).filter((event) => !(event in registered));
if (missing.length > 0) {
    throw new Error(
        `Events did not register: ${missing.join(', ')}. Runs would serve paid work for free — do not publish.`,
    );
}

for (const [event, spec] of Object.entries(registered)) {
    const expected = configured[event]?.eventPriceUsd;
    const ok = expected === undefined || expected === spec.eventPriceUsd;
    console.log(`  ${ok ? 'OK  ' : 'DRIFT'} ${event}: $${spec.eventPriceUsd}${ok ? '' : ` (expected $${expected})`}`);
    if (!ok) process.exitCode = 1;
}

console.log(`\nStore page: https://apify.com/${me.username}/${actorName}`);
