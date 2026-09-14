/**
 * Congruency guards over the Actor's own definition files.
 *
 * Apify grades "Congruency of texts" (title/description/schema/README all
 * saying the same thing) and "Pricing transparency" as part of the public
 * Quality Score, and PPE prices can only be typed into the Console by hand —
 * so the numbers in the README, the manifest and the code have no platform-level
 * link keeping them honest. These tests are that link.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { CHARGEABLE_EVENTS } from '../src/charging.ts';
import { DEFAULT_APPS, DEFAULT_COUNTRIES, DEFAULT_MAX_REVIEWS_PER_APP } from '../src/input.ts';

const root = new URL('../', import.meta.url);
const read = (relative: string): string => readFileSync(fileURLToPath(new URL(relative, root)), 'utf8');
const readJson = (relative: string): any => JSON.parse(read(relative));

const actorJson = readJson('.actor/actor.json');
const inputSchema = readJson('.actor/input_schema.json');
const datasetSchema = readJson('.actor/dataset_schema.json');
const pricing = readJson('.actor/pay_per_event.json');
const readme = read('README.md');

test('actor.json carries every field the platform requires', () => {
    assert.equal(actorJson.actorSpecification, 1);
    assert.equal(actorJson.name, 'app-review-monitor');
    assert.match(actorJson.version, /^\d+\.\d+$/);
    assert.ok(actorJson.title.length > 0);
    assert.ok(actorJson.description.length > 0);
});

test('every file actor.json points at actually exists', () => {
    for (const relative of [
        actorJson.dockerfile,
        actorJson.input,
        actorJson.readme,
        actorJson.changelog,
        actorJson.storages?.dataset,
    ]) {
        assert.ok(relative, 'actor.json reference should not be empty');
        assert.doesNotThrow(
            () => readFileSync(fileURLToPath(new URL(relative, new URL('.actor/', root)))),
            `actor.json points at a missing file: ${relative}`,
        );
    }
});

test('GUARD: every event charged in src/ is declared in the pricing manifest', () => {
    // Catches "added a charge, forgot to price it" — which on the platform means
    // an event that is billed at whatever the Console happens to hold, or not at all.
    const declared = Object.keys(pricing.events);
    for (const event of CHARGEABLE_EVENTS) {
        assert.ok(declared.includes(event), `event "${event}" is charged in code but not priced`);
    }
    assert.deepEqual(declared.sort(), [...CHARGEABLE_EVENTS].sort(), 'manifest and code must list the same events');
});

test('GUARD: no source file charges an event name the manifest does not know', () => {
    // Discovered from the filesystem rather than hand-listed, so a new module
    // with a stray Actor.charge({ eventName: 'oops' }) cannot slip past.
    const sources = readdirSync(fileURLToPath(new URL('src', root)), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts'))
        .map((f) => read(`src/${f}`));
    assert.ok(sources.length >= 5, 'source discovery found suspiciously few files');

    const declared = new Set(Object.keys(pricing.events));
    const found = new Set<string>();
    for (const source of sources) {
        for (const match of source.matchAll(/eventName:\s*['"]([a-z0-9-]+)['"]/g)) {
            found.add(match[1]!);
        }
        for (const match of source.matchAll(/EVENT_[A-Z_]+\s*=\s*['"]([a-z0-9-]+)['"]/g)) {
            found.add(match[1]!);
        }
    }
    assert.ok(found.size > 0, 'event-name discovery is vacuous — the regex no longer matches the code');
    for (const event of found) {
        assert.ok(declared.has(event), `source charges undeclared event "${event}"`);
    }
});

test('GUARD: manifest prices are positive and match the README pricing table', () => {
    for (const [event, spec] of Object.entries<any>(pricing.events)) {
        assert.ok(typeof spec.eventPriceUsd === 'number' && spec.eventPriceUsd > 0, `${event} needs a price`);
        assert.ok(spec.eventTitle && spec.eventDescription, `${event} needs a title and description`);
        // e.g. "$0.002" for 0.002, "$0.01" for 0.01 — the exact string the README must quote.
        const printed = `$${spec.eventPriceUsd}`;
        assert.ok(
            readme.includes(`\`${event}\``) && readme.includes(printed),
            `README must quote "${event}" and its price ${printed}`,
        );
    }
});

test('GUARD: input schema defaults match the code defaults', () => {
    // The schema drives what the Console pre-fills; the code drives what an API
    // caller who omits a field gets. If they disagree, two users running "the
    // defaults" get different results and different bills.
    const props = inputSchema.properties;
    assert.deepEqual(props.apps.default, [...DEFAULT_APPS]);
    assert.deepEqual(props.apps.prefill, [...DEFAULT_APPS]);
    assert.deepEqual(props.countries.default, [...DEFAULT_COUNTRIES]);
    assert.equal(props.maxReviewsPerApp.default, DEFAULT_MAX_REVIEWS_PER_APP);
    assert.equal(props.onlyNew.default, true);
});

test('input schema is a valid v1 schema with described, editable properties', () => {
    assert.equal(inputSchema.schemaVersion, 1);
    assert.equal(inputSchema.type, 'object');
    for (const [name, prop] of Object.entries<any>(inputSchema.properties)) {
        assert.ok(prop.title, `${name} needs a title`);
        assert.ok(prop.description, `${name} needs a description`);
        assert.ok(prop.type, `${name} needs a type`);
        assert.ok(prop.editor, `${name} needs an editor so the Console can render it`);
    }
});

test('no input field is required, so the Start button works with zero configuration', () => {
    assert.deepEqual(inputSchema.required ?? [], []);
});

test('GUARD: the dataset view only lists fields the actor actually emits', () => {
    // A view referencing a field that does not exist renders a column of blanks
    // on the Store's Output tab — the first thing a prospective buyer looks at.
    const emitted = new Set([
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
    ]);
    const viewFields: string[] = datasetSchema.views.overview.transformation.fields;
    assert.ok(viewFields.length > 0);
    for (const field of viewFields) {
        assert.ok(emitted.has(field), `dataset view lists "${field}", which the actor never emits`);
    }
    for (const field of Object.keys(datasetSchema.views.overview.display.properties)) {
        assert.ok(viewFields.includes(field), `display property "${field}" is not in the view's field list`);
    }
});

test('README leads with a quick start and documents scheduling and limits', () => {
    const firstHeading = readme.split('\n').find((line) => line.startsWith('## '));
    assert.match(firstHeading ?? '', /quick start/i, 'the first section must be the quick start');
    for (const section of ['What you get', 'Scheduling', 'Pricing', 'Limits']) {
        assert.ok(readme.includes(section), `README is missing the "${section}" section`);
    }
});

test('GUARD: the store SEO metadata fits what Google and Apify will show', () => {
    const seo = readJson('.actor/store_listing.json');
    // 60 is an UNDOCUMENTED hard limit on PUT /v2/acts: over it the API rejects
    // the whole update with `schema-validation`. Measured, not read off the docs.
    assert.ok(seo.seoTitle.length > 0 && seo.seoTitle.length <= 60, `seoTitle is ${seo.seoTitle.length} chars, max 60`);
    assert.ok(
        seo.seoDescription.length > 0 && seo.seoDescription.length < 160,
        `seoDescription must be under 160 chars, got ${seo.seoDescription.length}`,
    );
    assert.ok(Array.isArray(seo.categories) && seo.categories.length > 0);
});

test('GUARD: the title says the same thing everywhere it appears', () => {
    const seo = readJson('.actor/store_listing.json');
    assert.equal(actorJson.title, inputSchema.title);
    assert.ok(readme.startsWith(`# ${actorJson.title}`), 'README H1 must match the actor title');
    assert.ok(seo.seoTitle.startsWith(actorJson.title), 'seoTitle must lead with the actor title');
});
