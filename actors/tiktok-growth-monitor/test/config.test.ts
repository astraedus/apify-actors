/**
 * Source-level invariants over the Actor's own definition files.
 *
 * These guard the failure class that unit tests of pure functions cannot see:
 * a price configured for an event the code never charges, a README promising a
 * default that the input schema does not prefill, an seoDescription that
 * Google will truncate. All of it is silently wrong at runtime and only
 * discovered by a user — or by Apify's daily automated test — so it is pinned
 * here instead.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (relative: string): string =>
    readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const readJson = (relative: string): any => JSON.parse(read(relative));

const actorJson = readJson('.actor/actor.json');
const inputSchema = readJson('.actor/INPUT_SCHEMA.json');
const storeConfig = readJson('.actor/store-config.json');
const packageJson = readJson('package.json');
const mainSource = read('src/main.ts');
const readme = read('README.md');

/** Event names the code actually charges, resolved through their constants. */
function chargedEventNames(): string[] {
    const constants = new Map<string, string>();
    for (const [, name, value] of mainSource.matchAll(/const (EVENT_[A-Z_]+) = '([^']+)'/g)) {
        constants.set(name, value);
    }

    const charged = new Set<string>();
    for (const [, reference] of mainSource.matchAll(/eventName:\s*([A-Za-z_]+)/g)) {
        const resolved = constants.get(reference);
        assert.ok(resolved, `Actor.charge uses ${reference}, which is not a declared EVENT_* constant`);
        charged.add(resolved);
    }

    return [...charged].sort();
}

const configuredEvents = storeConfig.pricingInfos[0].pricingPerEvent.actorChargeEvents;

describe('pay-per-event configuration', () => {
    it('discovers the charge sites at all (guards against a vacuous test)', () => {
        assert.ok(chargedEventNames().length >= 2, 'expected to find the charge calls in src/main.ts');
    });

    it('prices exactly the events the code charges, no more and no fewer', () => {
        // A priced-but-never-charged event is revenue we silently never collect.
        // A charged-but-unpriced event is a runtime billing error mid-run.
        assert.deepEqual(Object.keys(configuredEvents).sort(), chargedEventNames());
    });

    it('gives every event a title and a description for the billing UI', () => {
        for (const [name, spec] of Object.entries<any>(configuredEvents)) {
            assert.ok(spec.eventTitle?.length > 0, `${name} needs an eventTitle`);
            assert.ok(spec.eventDescription?.length > 20, `${name} needs a real eventDescription`);
        }
    });

    it('prices every event as a non-negative number', () => {
        for (const [name, spec] of Object.entries<any>(configuredEvents)) {
            assert.equal(typeof spec.eventPriceUsd, 'number', `${name} price must be a number`);
            assert.ok(Number.isFinite(spec.eventPriceUsd) && spec.eventPriceUsd >= 0, `${name} price must be >= 0`);
        }
    });

    it('charges $0.02 per monitored profile, as the README promises', () => {
        assert.equal(configuredEvents['profile-monitored'].eventPriceUsd, 0.02);
        assert.ok(readme.includes('$0.02'), 'README must state the per-profile price');
    });

    it('keeps the outlier event free, as the README promises', () => {
        assert.equal(configuredEvents['outlier-alert'].eventPriceUsd, 0);
    });

    it('marks exactly one primary event', () => {
        const primary = Object.entries<any>(configuredEvents).filter(([, spec]) => spec.isPrimaryEvent);

        assert.equal(primary.length, 1);
        assert.equal(primary[0][0], 'profile-monitored');
    });

    it('uses the pay-per-event model, since rental listings retire 2026-10-01', () => {
        assert.equal(storeConfig.pricingInfos[0].pricingModel, 'PAY_PER_EVENT');
    });
});

describe('billing safety (ordering invariants in src/main.ts)', () => {
    const indexOf = (needle: string): number => {
        const at = mainSource.indexOf(needle);
        assert.notEqual(at, -1, `expected to find "${needle}" in src/main.ts`);
        return at;
    };

    it('bails out on a failed base run before any charge happens', () => {
        assert.ok(
            indexOf("baseRun.status !== 'SUCCEEDED'") < indexOf('Actor.charge'),
            'a failed base scraper must never bill the user',
        );
    });

    it('bails out on an empty result set before any charge happens', () => {
        assert.ok(
            indexOf('profiles.length === 0') < indexOf('Actor.charge'),
            'a run that delivered nothing must fail, not succeed silently after charging',
        );
    });

    it('builds the report before charging for it, so we only bill delivered work', () => {
        assert.ok(indexOf('buildReport(') < indexOf('Actor.charge'));
    });

    it('writes the new snapshot only after the row is pushed', () => {
        // If the push fails, the old snapshot must survive so the next run still
        // computes a correct (longer) delta instead of comparing against state
        // for data the user never received.
        assert.ok(indexOf('Actor.pushData(report)') < indexOf('store.setValue(snapshotKey'));
    });

    it('keeps the summary out of the dataset, so no bookkeeping row looks billable', () => {
        assert.match(mainSource, /Actor\.setValue\('OUTPUT', summary\)/);
        assert.ok(!/pushData\(summary\)/.test(mainSource));
    });

    it('respects the platform charge limit instead of billing past it', () => {
        assert.match(mainSource, /eventChargeLimitReached/);
    });
});

describe('actor definition', () => {
    it('uses actor specification 1, the only version that exists', () => {
        assert.equal(actorJson.actorSpecification, 1);
    });

    it('keeps the actor name and the package name in sync', () => {
        assert.equal(actorJson.name, packageJson.name);
    });

    it('points at files that exist', () => {
        for (const relative of ['.actor/Dockerfile', '.actor/INPUT_SCHEMA.json', '.actor/dataset_schema.json', 'README.md']) {
            assert.doesNotThrow(() => read(relative), `${relative} is referenced but missing`);
        }
    });

    it('declares no pricing or SEO keys, which actor.json does not support', () => {
        // Apify silently ignores unknown keys here; putting pricing in actor.json
        // would look configured while the Actor stayed unpriced on the platform.
        for (const key of ['pricingInfos', 'payPerEvent', 'pricing', 'seoTitle', 'seoDescription']) {
            assert.ok(!(key in actorJson), `${key} belongs in store-config.json, not actor.json`);
        }
    });
});

describe('store listing SEO', () => {
    it('keeps seoDescription under the 160 characters Google shows', () => {
        assert.ok(storeConfig.seoDescription.length < 160, `was ${storeConfig.seoDescription.length} chars`);
    });

    it('has an seoTitle that reads like a search result, not a repo name', () => {
        // 60 is the platform's own hard limit: the API rejects a longer seoTitle
        // with a schema-validation error, which fails the whole publish.
        assert.ok(
            storeConfig.seoTitle.length > 20 && storeConfig.seoTitle.length <= 60,
            `seoTitle must be 21-60 chars, was ${storeConfig.seoTitle.length}`,
        );
        assert.match(storeConfig.seoTitle, /TikTok/);
    });

    it('says the same thing in actor.json and the store config (congruency)', () => {
        assert.equal(actorJson.title, storeConfig.title);
        assert.equal(actorJson.description, storeConfig.description);
    });
});

describe('input schema', () => {
    const properties = inputSchema.properties;

    it('uses schema version 1', () => {
        assert.equal(inputSchema.schemaVersion, 1);
    });

    it('requires only the profiles field, so the default run is zero-config', () => {
        assert.deepEqual(inputSchema.required, ['profiles']);
    });

    it('prefills profiles, so Apify\'s daily default-input test has something to run', () => {
        // A required field with no prefill means the zero-config run fails, which
        // is 3 strikes to an "Under Maintenance" badge on the store page.
        assert.ok(Array.isArray(properties.profiles.prefill));
        assert.ok(properties.profiles.prefill.length > 0);
    });

    it('also gives profiles a real default, since prefill only fills the Console form', () => {
        // `prefill` is cosmetic: a programmatic caller or Apify's automated test
        // can still send {}. Without `default`, that run gets undefined and fails.
        assert.deepEqual(properties.profiles.default, properties.profiles.prefill);
    });

    it('keeps the code\'s absent-input fallback identical to the schema default', () => {
        const fallback = /const DEFAULT_PROFILES = (\[[^\]]*\])/.exec(mainSource)?.[1];

        assert.ok(fallback, 'src/main.ts must declare DEFAULT_PROFILES');
        assert.deepEqual(JSON.parse(fallback.replace(/'/g, '"')), properties.profiles.default);
    });

    it('keeps the default run small enough to finish inside the 5 minute test window', () => {
        assert.ok(properties.profiles.prefill.length <= 3, 'default batch must stay small');
        assert.ok(properties.videosPerProfile.prefill <= 10, 'default video window must stay small');
    });

    it('describes every field for the ease-of-use quality score', () => {
        for (const [name, spec] of Object.entries<any>(properties)) {
            assert.ok(spec.title?.length > 0, `${name} needs a title`);
            assert.ok(spec.description?.length > 20, `${name} needs a real description`);
            assert.ok(spec.type, `${name} needs a type`);
        }
    });

    it('gives every optional field a default the code agrees with', () => {
        assert.equal(properties.videosPerProfile.default, 20);
        assert.equal(properties.outlierMultiplier.default, 3);
        assert.equal(properties.snapshotStoreName.default, 'tiktok-growth-monitor-state');
        assert.equal(properties.baseActor.default, 'clockworks/tiktok-profile-scraper');

        for (const [field, value] of Object.entries({
            videosPerProfile: 20,
            outlierMultiplier: 3,
            snapshotStoreName: "'tiktok-growth-monitor-state'",
            baseActor: "'clockworks/tiktok-profile-scraper'",
        })) {
            assert.match(
                mainSource,
                new RegExp(`${field}: ${value}`),
                `src/main.ts DEFAULTS.${field} must match the input schema default`,
            );
        }
    });

    it('does not let a user request an unbounded video window', () => {
        assert.ok(properties.videosPerProfile.maximum <= 200);
        assert.ok(properties.profiles.maxItems <= 200);
    });
});

describe('README', () => {
    it('documents the two-layer cost honestly', () => {
        assert.match(readme, /clockworks\/tiktok-profile-scraper/, 'must name the base actor it is built on');
        assert.match(readme, /\$0\.02/, 'must state our per-profile price');
        assert.match(readme, /\$0\.003/, 'must state the measured base-actor per-result price');
    });

    it('leads with a quick start', () => {
        const firstHeadings = [...readme.matchAll(/^## (.+)$/gm)].slice(0, 3).map((m) => m[1]);

        assert.ok(
            firstHeadings.some((heading) => /quick.?start/i.test(heading)),
            `expected a quick-start heading near the top, got: ${firstHeadings.join(' | ')}`,
        );
    });

    it('documents scheduling and the webhook, the reason to run this daily', () => {
        assert.match(readme, /schedul/i);
        assert.match(readme, /webhook/i);
    });
});
