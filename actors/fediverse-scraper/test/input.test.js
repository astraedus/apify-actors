import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { normaliseInput, parseSince, InputError, DEFAULTS, MODES } from '../src/input.js';
import { parseTarget } from '../src/targets.js';
import { EVENT_POST, EVENT_PROFILE } from '../src/sink.js';

const readJson = (relative) => JSON.parse(readFileSync(new URL(relative, import.meta.url), 'utf8'));
const INPUT_SCHEMA = readJson('../.actor/input_schema.json');
const ACTOR_JSON = readJson('../.actor/actor.json');
const STORE_LISTING = readJson('../.actor/store-listing.json');

describe('normaliseInput defaults', () => {
    test('an empty input is fully usable -- the zero-config run Apify tests daily', () => {
        const input = normaliseInput({});
        assert.deepEqual(input.targets, DEFAULTS.targets);
        assert.equal(input.mode, 'both');
        assert.equal(input.includeReplies, false);
        assert.equal(input.includeReposts, false);
        assert.equal(input.resolveMedia, true);
        assert.equal(input.includeRaw, false);
        assert.equal(input.sinceMs, null);
    });

    test('undefined and null inputs behave like an empty object', () => {
        assert.deepEqual(normaliseInput(undefined).targets, DEFAULTS.targets);
        assert.deepEqual(normaliseInput(null).targets, DEFAULTS.targets);
    });

    test('false is preserved rather than falling back to a true default', () => {
        assert.equal(normaliseInput({ resolveMedia: false }).resolveMedia, false);
    });

    test('targets are trimmed and blanks dropped', () => {
        assert.deepEqual(normaliseInput({ targets: ['  bsky.app  ', '', '   '] }).targets, ['bsky.app']);
    });

    test('a pasted newline- or comma-separated string is accepted', () => {
        assert.deepEqual(
            normaliseInput({ targets: 'bsky.app\n@Gargron@mastodon.social' }).targets,
            ['bsky.app', '@Gargron@mastodon.social'],
        );
    });

    test('the instance is normalised even when pasted as a URL', () => {
        assert.equal(
            normaliseInput({ defaultMastodonInstance: 'https://Fosstodon.org/about' }).defaultMastodonInstance,
            'fosstodon.org',
        );
    });
});

describe('normaliseInput validation', () => {
    test('rejects an empty target list rather than running to no purpose', () => {
        assert.throws(() => normaliseInput({ targets: [] }), InputError);
        assert.throws(() => normaliseInput({ targets: ['  '] }), InputError);
    });

    test('rejects a non-array targets value', () => {
        assert.throws(() => normaliseInput({ targets: 42 }), InputError);
    });

    test('rejects an unknown mode and names the valid ones', () => {
        let error;
        try {
            normaliseInput({ mode: 'profile' });
        } catch (caught) {
            error = caught;
        }
        assert.ok(error instanceof InputError, 'an unknown mode must be rejected');
        for (const mode of MODES) assert.match(error.message, new RegExp(mode));
    });

    test('rejects a non-positive or non-integer maxPostsPerTarget', () => {
        for (const value of [0, -5, 1.5, 'many']) {
            assert.throws(() => normaliseInput({ maxPostsPerTarget: value }), InputError, `${value}`);
        }
    });

    test('an out-of-range concurrency is refused instead of hammering a server', () => {
        assert.throws(() => normaliseInput({ maxConcurrency: 50 }), InputError);
    });
});

describe('parseSince', () => {
    test('a bare date means midnight UTC', () => {
        assert.equal(parseSince('2026-01-01'), Date.parse('2026-01-01T00:00:00Z'));
    });

    test('a full timestamp is used as given', () => {
        assert.equal(parseSince('2026-01-01T12:30:00Z'), Date.parse('2026-01-01T12:30:00Z'));
    });

    test('empty values mean no cut-off', () => {
        for (const value of [undefined, null, '', '   ']) {
            assert.equal(parseSince(value), null, JSON.stringify(value));
        }
    });

    test('rejects an unparseable date instead of silently ignoring the filter', () => {
        assert.throws(() => parseSince('last tuesday'), InputError);
        assert.throws(() => parseSince('2026-13-45'), InputError);
    });

    test('rejects a future date, which could only ever return nothing', () => {
        const future = new Date(Date.now() + 86_400_000).toISOString();
        assert.throws(() => parseSince(future), InputError);
    });
});

describe('input schema agrees with the code', () => {
    test('declares schemaVersion 1 and an object type', () => {
        assert.equal(INPUT_SCHEMA.schemaVersion, 1);
        assert.equal(INPUT_SCHEMA.type, 'object');
    });

    test('every schema property is one the code actually reads', () => {
        // A property the code ignores is a promise to the user that nothing keeps.
        const codeFields = new Set([
            'targets', 'mode', 'maxPostsPerTarget', 'since', 'includeReplies',
            'includeReposts', 'resolveMedia', 'includeRaw', 'defaultMastodonInstance', 'maxConcurrency',
        ]);
        for (const name of Object.keys(INPUT_SCHEMA.properties)) {
            assert.ok(codeFields.has(name), `schema exposes "${name}" but normaliseInput ignores it`);
        }
    });

    test('every input the code reads is exposed in the schema', () => {
        for (const name of ['targets', 'mode', 'maxPostsPerTarget', 'since', 'includeReplies',
            'includeReposts', 'resolveMedia', 'includeRaw', 'defaultMastodonInstance', 'maxConcurrency']) {
            assert.ok(INPUT_SCHEMA.properties[name], `"${name}" is read by the code but missing from the schema`);
        }
    });

    test('schema defaults match the code defaults, so Console and API runs agree', () => {
        const { properties } = INPUT_SCHEMA;
        assert.deepEqual(properties.targets.default, DEFAULTS.targets);
        assert.equal(properties.mode.default, DEFAULTS.mode);
        assert.equal(properties.maxPostsPerTarget.default, DEFAULTS.maxPostsPerTarget);
        assert.equal(properties.includeReplies.default, DEFAULTS.includeReplies);
        assert.equal(properties.includeReposts.default, DEFAULTS.includeReposts);
        assert.equal(properties.resolveMedia.default, DEFAULTS.resolveMedia);
        assert.equal(properties.includeRaw.default, DEFAULTS.includeRaw);
        assert.equal(properties.defaultMastodonInstance.default, DEFAULTS.defaultMastodonInstance);
    });

    test('the mode enum matches the modes the code accepts', () => {
        assert.deepEqual([...INPUT_SCHEMA.properties.mode.enum].sort(), [...MODES].sort());
        assert.equal(
            INPUT_SCHEMA.properties.mode.enumTitles.length,
            INPUT_SCHEMA.properties.mode.enum.length,
            'every enum value needs a title or the Console dropdown misaligns',
        );
    });

    test('no input field collects a credential', () => {
        // The repo rule is public data only, so an auth field must never creep in.
        // Only field NAMES are checked: the descriptions legitimately mention passwords
        // when explaining that we never ask for one.
        const forbidden = /password|token|cookie|session|credential|auth|login|secret/i;
        for (const [name, property] of Object.entries(INPUT_SCHEMA.properties)) {
            assert.doesNotMatch(name, forbidden, `input field "${name}" looks like a credential`);
            assert.notEqual(property.isSecret, true, `input field "${name}" is declared secret`);
        }
    });

    test('the targets field documents that Bluesky search is unsupported', () => {
        assert.match(INPUT_SCHEMA.properties.targets.description, /not supported/i);
    });
});

describe('the default input is genuinely runnable', () => {
    test('every default target parses, so the daily automated test cannot fail on a typo', () => {
        for (const target of DEFAULTS.targets) {
            assert.doesNotThrow(() => parseTarget(target), `default target "${target}" does not parse`);
        }
    });

    test('no default target relies on a capability we do not support', () => {
        for (const target of DEFAULTS.targets) {
            const parsed = parseTarget(target);
            assert.notEqual(parsed.kind, 'actor-search', 'search-shaped defaults are a reliability risk');
        }
    });

    test('the defaults exercise both platforms', () => {
        const platforms = new Set(DEFAULTS.targets.map((t) => parseTarget(t).platform));
        assert.ok(platforms.has('mastodon') && platforms.has('bluesky'));
    });

    test('the schema prefill uses a small post budget so a trial run is fast and cheap', () => {
        assert.ok(
            INPUT_SCHEMA.properties.maxPostsPerTarget.prefill <= 25,
            'the Console prefill should be small enough to finish inside the 5-minute test window',
        );
    });
});

describe('actor definition', () => {
    test('actor.json uses specification 1 and a MAJOR.MINOR version', () => {
        assert.equal(ACTOR_JSON.actorSpecification, 1);
        assert.match(ACTOR_JSON.version, /^\d+\.\d+$/);
    });

    test('actor.json points at files that exist', () => {
        for (const relative of [ACTOR_JSON.input, ACTOR_JSON.dockerfile, ACTOR_JSON.storages.dataset, ACTOR_JSON.readme]) {
            assert.doesNotThrow(
                () => readFileSync(new URL(`../.actor/${relative}`, import.meta.url)),
                `actor.json references a missing file: ${relative}`,
            );
        }
    });

    test('pricing lives in store-listing.json because actor.json has no pricing key', () => {
        // Verified against the Apify actor.json docs: no seo or pricing fields exist.
        for (const key of ['pricingInfos', 'pricingInfo', 'seoTitle', 'seoDescription']) {
            assert.ok(!(key in ACTOR_JSON), `actor.json must not carry "${key}" -- Apify ignores it`);
        }
    });

    test('the SEO title fits the API\'s 60-character cap', () => {
        // Established by probing PUT /v2/acts/{id}: a longer title is rejected with
        // "seoTitle must be at most 60 characters long".
        assert.ok(STORE_LISTING.seoTitle.length > 0);
        assert.ok(
            STORE_LISTING.seoTitle.length <= 60,
            `seoTitle is ${STORE_LISTING.seoTitle.length} chars; the API caps it at 60`,
        );
    });

    test('the SEO description fits the 160-character budget', () => {
        assert.ok(
            STORE_LISTING.seoDescription.length < 160,
            `seoDescription is ${STORE_LISTING.seoDescription.length} chars`,
        );
    });

    test('the ready-to-apply API payload prices the same events at the same prices', () => {
        // This payload is applied verbatim once payout info exists, so it must not drift
        // from the human-readable list beside it or from the names the code charges.
        const apiEvents = STORE_LISTING.pricingInfoApiPayload
            .pricingInfos[0].pricingPerEvent.actorChargeEvents;
        assert.deepEqual(Object.keys(apiEvents).sort(), [EVENT_POST, EVENT_PROFILE].sort());
        for (const event of STORE_LISTING.pricingInfo.events) {
            assert.equal(
                apiEvents[event.eventName].eventPriceUsd,
                event.eventPriceUsd,
                `${event.eventName} price differs between the listing and the API payload`,
            );
        }
    });

    test('the priced event names match the ones the code charges', () => {
        // Charging an event the Console does not know about returns an error and the
        // run collects data for free, so this pair must never drift.
        const priced = STORE_LISTING.pricingInfo.events.map((event) => event.eventName).sort();
        assert.deepEqual(priced, [EVENT_POST, EVENT_PROFILE].sort());
    });

    test('every priced event has a positive price', () => {
        for (const event of STORE_LISTING.pricingInfo.events) {
            assert.ok(event.eventPriceUsd > 0, `${event.eventName} has no price`);
            assert.ok(event.eventTitle && event.eventDescription, `${event.eventName} needs a title and description`);
        }
    });
});
