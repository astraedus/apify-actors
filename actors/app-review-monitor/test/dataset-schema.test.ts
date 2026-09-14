import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ajv v8 is CJS-only (no `exports`/`module` field — see node_modules/ajv/package.json,
// `"main": "dist/ajv.js"`, `"types": "dist/ajv.d.ts"` with `export =`). Under NodeNext
// moduleResolution a plain default import is synthesised, but at *runtime* some
// interop shapes hand back `{ default: Ajv }` instead of `Ajv` itself — so unwrap
// defensively rather than assume one or the other.
import AjvModule from 'ajv';
const Ajv = (AjvModule as unknown as { default?: unknown }).default ?? AjvModule;

import { storeUrl } from '../src/detect.ts';
import { parseAppleRssPage } from '../src/sources/apple.ts';
import { normaliseGooglePlayReview } from '../src/sources/google-play.ts';
import type { ReviewRow } from '../src/types.ts';

const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), 'utf8'));

const schemaPath = fileURLToPath(new URL('../.actor/dataset_schema.json', import.meta.url));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8')) as {
    actorSpecification: number;
    fields: Record<string, unknown>;
    views: Record<string, { transformation: { fields: string[] } }>;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ajv's own constructor signature, not our data
const ajv = new (Ajv as any)({ allErrors: true, strict: false });
const validate = ajv.compile(schema.fields);

/** Build the exact shape main.ts pushes to the dataset for one row. */
function toPushedRow(row: ReviewRow, store: 'google-play' | 'app-store', appId: string, country: string) {
    return { ...row, isNew: true, url: row.url || storeUrl(store, appId, country) };
}

function assertRowValidates(row: unknown, label: string): void {
    const ok = validate(row) as boolean;
    assert.equal(ok, true, `${label} failed schema validation: ${JSON.stringify((validate as { errors?: unknown }).errors)}`);
}

// ---------------------------------------------------------------------------
// (b) Real rows produced by the actor's own parsing code, validated against
//     the dataset schema.
// ---------------------------------------------------------------------------

const APPLE_CONTEXT = { appId: '284882215', appName: 'Facebook', country: 'us' };
const GPLAY_CONTEXT = { appId: 'dev.astraedus.nudge', appName: 'Nudge', country: 'us' };

const GPLAY_LIVE_SHAPE = {
    id: '6ca5d4fd-5ef6-49bc-877e-159f062a5a91',
    userName: 'sepehr',
    date: '2026-09-06T09:09:52.941Z',
    score: 3,
    url: 'https://play.google.com/store/apps/details?id=dev.astraedus.nudge&reviewId=6ca5d4fd-5ef6-49bc-877e-159f062a5a91',
    title: null,
    text: "It doesn't work sometimes",
    replyDate: null,
    replyText: null,
    version: '1.15.2',
};

let validatedCount = 0;

test('real Apple RSS rows (page 1 + single-entry fixture) validate against the dataset schema', () => {
    const rows = [
        ...parseAppleRssPage(fixture('apple-rss-page1'), APPLE_CONTEXT),
        ...parseAppleRssPage(fixture('apple-rss-single-entry'), APPLE_CONTEXT),
    ];
    assert.ok(rows.length > 0, 'expected the Apple fixtures to produce at least one row');
    for (const row of rows) {
        assertRowValidates(row, `apple row ${row.reviewId}`);
        assertRowValidates(toPushedRow(row, 'app-store', APPLE_CONTEXT.appId, APPLE_CONTEXT.country), `apple pushed row ${row.reviewId}`);
        validatedCount += 2;
    }
});

test('a real Google Play row with a developer reply validates against the dataset schema', () => {
    const row = normaliseGooglePlayReview(
        { ...GPLAY_LIVE_SHAPE, replyText: 'Sorry about that, fixed in 1.16.', replyDate: '2026-09-07T10:00:00.000Z' },
        GPLAY_CONTEXT,
    );
    assert.ok(row, 'expected a normalised row');
    assertRowValidates(row, 'google-play row with developer reply');
    assertRowValidates(toPushedRow(row!, 'google-play', GPLAY_CONTEXT.appId, GPLAY_CONTEXT.country), 'google-play pushed row with developer reply');
    validatedCount += 2;
});

test('a real Google Play row with every optional field missing/null validates against the dataset schema', () => {
    // Mirrors test/google-play.test.ts's "missing text/score/author/appVersion"
    // case: only `id` is present, so rating/title/text/author/date/appVersion/
    // developerReply all fall back to their null/empty defaults.
    const row = normaliseGooglePlayReview({ id: 'r-minimal' }, GPLAY_CONTEXT);
    assert.ok(row, 'expected a normalised row even with almost everything missing');
    assert.equal(row!.developerReply, null);
    assert.equal(row!.title, null);
    assert.equal(row!.date, null);
    assert.equal(row!.appVersion, null);
    assert.equal(row!.author, null);
    assert.equal(row!.rating, null);
    assertRowValidates(row, 'google-play minimal row');
    assertRowValidates(toPushedRow(row!, 'google-play', GPLAY_CONTEXT.appId, GPLAY_CONTEXT.country), 'google-play pushed minimal row');
    validatedCount += 2;
});

test('a non-vacuous number of rows were actually validated', () => {
    assert.ok(validatedCount >= 6, `expected several rows to have been validated, got ${validatedCount}`);
});

// ---------------------------------------------------------------------------
// (c) Every view's `transformation.fields` entry must resolve inside
//     `fields.properties` (supports dotted paths, e.g. "developerReply.text").
// ---------------------------------------------------------------------------

function resolvesInProperties(root: Record<string, unknown>, dottedPath: string): boolean {
    let node: unknown = root;
    for (const segment of dottedPath.split('.')) {
        if (typeof node !== 'object' || node === null) return false;
        const properties = (node as { properties?: Record<string, unknown> }).properties;
        if (!properties || !(segment in properties)) return false;
        node = properties[segment];
    }
    return true;
}

test('every view transformation field resolves inside fields.properties', () => {
    const properties = (schema.fields as { properties?: Record<string, unknown> }).properties;
    assert.ok(properties, 'schema.fields.properties must exist');

    let checked = 0;
    for (const [viewName, view] of Object.entries(schema.views)) {
        const fieldNames = view.transformation.fields;
        assert.ok(fieldNames.length > 0, `view "${viewName}" declares no transformation fields`);
        for (const fieldName of fieldNames) {
            assert.ok(
                resolvesInProperties(schema.fields as Record<string, unknown>, fieldName),
                `view "${viewName}" references "${fieldName}", which does not resolve inside fields.properties`,
            );
            checked += 1;
        }
    }
    assert.ok(checked > 0, 'expected at least one view transformation field to be checked');
});

// ---------------------------------------------------------------------------
// (d) Class-level invariants, walked recursively over the WHOLE fields tree,
//     that keep the schema from ever being able to reject a real row.
// ---------------------------------------------------------------------------

interface Violation {
    path: string;
    reason: string;
}

function walkForViolations(node: unknown, path: string, violations: Violation[]): void {
    if (Array.isArray(node)) {
        node.forEach((child, index) => walkForViolations(child, `${path}[${index}]`, violations));
        return;
    }
    if (typeof node !== 'object' || node === null) return;

    const obj = node as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(obj, 'required')) {
        violations.push({ path, reason: '"required" key present — a real row missing that key would be rejected' });
    }
    if (obj['additionalProperties'] === false) {
        violations.push({ path, reason: '"additionalProperties": false — an unexpected-but-real key would be rejected' });
    }

    for (const [key, value] of Object.entries(obj)) {
        walkForViolations(value, path ? `${path}.${key}` : key, violations);
    }
}

test('GUARD: no "required" key exists anywhere in the dataset schema fields tree', () => {
    const violations: Violation[] = [];
    walkForViolations(schema.fields, 'fields', violations);
    const requiredViolations = violations.filter((v) => v.reason.startsWith('"required"'));
    assert.deepEqual(requiredViolations, [], JSON.stringify(requiredViolations));
});

test('GUARD: no "additionalProperties": false exists anywhere in the dataset schema fields tree', () => {
    const violations: Violation[] = [];
    walkForViolations(schema.fields, 'fields', violations);
    const additionalPropsViolations = violations.filter((v) => v.reason.startsWith('"additionalProperties"'));
    assert.deepEqual(additionalPropsViolations, [], JSON.stringify(additionalPropsViolations));
});

test('GUARD: the recursive walk is non-vacuous (it actually finds an injected violation)', () => {
    // Prove the walker isn't silently passing over everything by planting a
    // violation in a throwaway clone and asserting it IS caught.
    const poisoned = JSON.parse(JSON.stringify(schema.fields));
    poisoned.properties.developerReply.properties.text.required = ['nope'];
    poisoned.properties.developerReply.additionalProperties = false;

    const violations: Violation[] = [];
    walkForViolations(poisoned, 'fields', violations);
    assert.ok(violations.some((v) => v.reason.startsWith('"required"')), 'walker did not catch a planted "required" key');
    assert.ok(violations.some((v) => v.reason.startsWith('"additionalProperties"')), 'walker did not catch a planted additionalProperties:false');
});

test('fields is a permissive draft-07 object schema', () => {
    const fields = schema.fields as { type?: unknown; properties?: Record<string, unknown>; $schema?: unknown; additionalProperties?: unknown };
    assert.equal(fields.type, 'object');
    assert.ok(fields.properties && Object.keys(fields.properties).length > 0, 'fields.properties must be non-empty');
    assert.equal(fields.additionalProperties, true);
    if (fields.$schema !== undefined) {
        assert.equal(fields.$schema, 'http://json-schema.org/draft-07/schema#');
    }
});

// ---------------------------------------------------------------------------
// (e) Every key of a real pushed row must be declared in fields.properties,
//     so a field added to ReviewRow later without a matching schema edit
//     fails this test instead of silently relying on additionalProperties.
// ---------------------------------------------------------------------------

test('every key of a real pushed row is declared in fields.properties', () => {
    const appleRows = parseAppleRssPage(fixture('apple-rss-page1'), APPLE_CONTEXT);
    assert.ok(appleRows.length > 0, 'expected at least one Apple row to derive keys from');
    const pushedRow = toPushedRow(appleRows[0]!, 'app-store', APPLE_CONTEXT.appId, APPLE_CONTEXT.country);

    const rowKeys = Object.keys(pushedRow);
    assert.ok(rowKeys.length > 0, 'expected the pushed row to have at least one key');

    const properties = (schema.fields as { properties?: Record<string, unknown> }).properties ?? {};
    for (const key of rowKeys) {
        assert.ok(key in properties, `row key "${key}" is not declared in fields.properties`);
    }
});
