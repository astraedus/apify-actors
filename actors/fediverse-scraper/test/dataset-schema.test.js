import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import AjvModule from 'ajv';

import { normaliseProfileRow as normaliseMastodonProfileRow, normaliseStatusRow } from '../src/mastodon.js';
import { normalisePostRow, normaliseProfileRow as normaliseBlueskyProfileRow } from '../src/bluesky.js';

// ajv v8 ships as CJS; this is the documented way to pull the constructor under ESM.
const Ajv = AjvModule.default ?? AjvModule;

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** The schema Apify validates every pushed item against (draft-07). */
const SCHEMA = JSON.parse(
    readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8'),
);

const MASTODON_ACCOUNT = load('mastodon-account.json');
const MASTODON_STATUSES = load('mastodon-statuses.json');
const BLUESKY_PROFILE = load('bluesky-profile.json');
const BLUESKY_FEED = load('bluesky-feed.json').feed;

const MASTODON_OPTS = { instance: 'mastodon.social', target: '@Gargron@mastodon.social' };
const BLUESKY_OPTS = { target: 'bsky.app' };

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA.fields);

/** Validate `row` and fail with the ajv error detail, not just a boolean. */
function assertValid(row, label) {
    const ok = validate(row);
    assert.equal(ok, true, `${label} failed schema validation: ${JSON.stringify(validate.errors)}`);
}

describe('dataset schema validates every row the actor actually emits', () => {
    test('mastodon profile row, every includeRaw combination', () => {
        let count = 0;
        for (const includeRaw of [true, false]) {
            const row = normaliseMastodonProfileRow(MASTODON_ACCOUNT, { ...MASTODON_OPTS, includeRaw });
            assertValid(row, `mastodon profile (includeRaw:${includeRaw})`);
            count += 1;
        }
        assert.equal(count, 2, 'both includeRaw branches must actually run');
    });

    test('mastodon status rows, every status x includeRaw x resolveMedia combination', () => {
        let count = 0;
        for (const status of MASTODON_STATUSES) {
            for (const includeRaw of [true, false]) {
                for (const resolveMedia of [true, false]) {
                    const row = normaliseStatusRow(status, { ...MASTODON_OPTS, includeRaw, resolveMedia });
                    assertValid(row, `mastodon status ${status.id} (includeRaw:${includeRaw}, resolveMedia:${resolveMedia})`);
                    count += 1;
                }
            }
        }
        assert.ok(MASTODON_STATUSES.length > 0, 'fixture must contain statuses');
        assert.equal(count, MASTODON_STATUSES.length * 4, 'every status x includeRaw x resolveMedia combination must run');
    });

    test('bluesky profile row, every includeRaw combination', () => {
        let count = 0;
        for (const includeRaw of [true, false]) {
            const row = normaliseBlueskyProfileRow(BLUESKY_PROFILE, { ...BLUESKY_OPTS, includeRaw });
            assertValid(row, `bluesky profile (includeRaw:${includeRaw})`);
            count += 1;
        }
        assert.equal(count, 2, 'both includeRaw branches must actually run');
    });

    test('bluesky post rows, every item x includeRaw x resolveMedia combination', () => {
        let count = 0;
        for (const item of BLUESKY_FEED) {
            for (const includeRaw of [true, false]) {
                for (const resolveMedia of [true, false]) {
                    const row = normalisePostRow(item, { ...BLUESKY_OPTS, includeRaw, resolveMedia });
                    assertValid(row, `bluesky post (includeRaw:${includeRaw}, resolveMedia:${resolveMedia})`);
                    count += 1;
                }
            }
        }
        assert.ok(BLUESKY_FEED.length > 0, 'fixture must contain feed items');
        assert.equal(count, BLUESKY_FEED.length * 4, 'every item x includeRaw x resolveMedia combination must run');
    });
});

/** Walk `properties` one dotted-path segment at a time, e.g. "author.handle". */
function resolveDottedPath(properties, dottedPath) {
    const segments = dottedPath.split('.');
    let node = properties;
    for (const segment of segments) {
        if (!node || typeof node !== 'object' || !(segment in node)) return undefined;
        node = node[segment];
        // Descend into the next segment's properties, if there is one to come.
        node = node?.properties ?? node;
    }
    return node;
}

describe('every view.transformation.fields entry resolves inside fields.properties', () => {
    test('overview and profiles views reference real, resolvable fields (including dotted author paths)', () => {
        let checked = 0;
        for (const [viewName, view] of Object.entries(SCHEMA.views)) {
            const fieldPaths = view.transformation.fields;
            assert.ok(fieldPaths.length > 0, `${viewName} view must list at least one field`);
            for (const path of fieldPaths) {
                const resolved = resolveDottedPath(SCHEMA.fields.properties, path);
                assert.notEqual(resolved, undefined, `${viewName} view references "${path}", which does not resolve in fields.properties`);
                checked += 1;
            }
        }
        assert.ok(checked > 0, 'must have actually checked at least one field path');
        // Both views are documented to use dotted author paths -- make sure this test would
        // catch a regression there specifically, not just resolve top-level fields.
        const dottedPaths = Object.values(SCHEMA.views)
            .flatMap((view) => view.transformation.fields)
            .filter((path) => path.includes('.'));
        assert.ok(dottedPaths.length > 0, 'at least one view must use a dotted author.* path');
        assert.ok(dottedPaths.includes('author.handle'), 'overview and profiles both reference author.handle');
    });
});

/** Recursively walk a JSON-Schema-shaped object, calling `visit` on every node. */
function walkSchemaNodes(node, visit, path = '') {
    if (!node || typeof node !== 'object') return;
    visit(node, path);
    if (node.properties && typeof node.properties === 'object') {
        for (const [key, child] of Object.entries(node.properties)) {
            walkSchemaNodes(child, visit, path ? `${path}.${key}` : key);
        }
    }
    if (node.items && typeof node.items === 'object') {
        walkSchemaNodes(node.items, visit, `${path}[]`);
    }
}

describe('class-level invariants over the whole fields tree', () => {
    test('no node anywhere declares "required" or "additionalProperties: false"', () => {
        let nodesWalked = 0;
        walkSchemaNodes(SCHEMA.fields, (node, path) => {
            nodesWalked += 1;
            assert.equal('required' in node, false, `node at "${path || '<root>'}" declares "required", which can reject a real row missing that key`);
            assert.notEqual(node.additionalProperties, false, `node at "${path || '<root>'}" sets additionalProperties: false, which can reject a real row with an extra key`);
        });
        // Root + author + author's children + media.items + media.items' children, at minimum.
        assert.ok(nodesWalked > 5, 'the walk must actually traverse a non-trivial tree, not just the root');
    });

    test('top-level shape', () => {
        assert.equal(SCHEMA.fields.type, 'object');
        assert.ok(SCHEMA.fields.properties && typeof SCHEMA.fields.properties === 'object');
        assert.ok(Object.keys(SCHEMA.fields.properties).length > 0, 'fields.properties must not be empty');
        if ('$schema' in SCHEMA.fields) {
            assert.equal(SCHEMA.fields.$schema, 'http://json-schema.org/draft-07/schema#');
        }
    });
});

describe('every key a real row actually carries is declared in fields.properties', () => {
    test('top-level row keys, including "raw" via an includeRaw:true row', () => {
        const rows = [
            normaliseMastodonProfileRow(MASTODON_ACCOUNT, { ...MASTODON_OPTS, includeRaw: true }),
            normaliseStatusRow(MASTODON_STATUSES[0], { ...MASTODON_OPTS, includeRaw: true }),
            normaliseBlueskyProfileRow(BLUESKY_PROFILE, { ...BLUESKY_OPTS, includeRaw: true }),
            normalisePostRow(BLUESKY_FEED[0], { ...BLUESKY_OPTS, includeRaw: true }),
        ];
        const declaredKeys = new Set(Object.keys(SCHEMA.fields.properties));
        let keysChecked = 0;
        for (const row of rows) {
            const keys = Object.keys(row);
            assert.ok(keys.length > 0, 'a row must have keys to check');
            for (const key of keys) {
                assert.ok(declaredKeys.has(key), `row emits key "${key}" that is not declared in fields.properties`);
                keysChecked += 1;
            }
        }
        assert.ok(keysChecked > 0, 'must have actually checked row keys');
        assert.ok(rows.some((row) => 'raw' in row), 'at least one row must exercise includeRaw:true so "raw" is covered');
    });

    test('author sub-object keys are declared in fields.properties.author.properties', () => {
        const authorSchema = SCHEMA.fields.properties.author;
        assert.ok(authorSchema && authorSchema.properties, 'schema must declare author.properties');
        const declaredAuthorKeys = new Set(Object.keys(authorSchema.properties));

        const authors = [
            normaliseMastodonProfileRow(MASTODON_ACCOUNT, { ...MASTODON_OPTS, includeRaw: false }).author,
            normaliseStatusRow(MASTODON_STATUSES[0], { ...MASTODON_OPTS, includeRaw: false }).author,
            normaliseBlueskyProfileRow(BLUESKY_PROFILE, { ...BLUESKY_OPTS, includeRaw: false }).author,
            normalisePostRow(BLUESKY_FEED[0], { ...BLUESKY_OPTS, includeRaw: false }).author,
        ];
        let keysChecked = 0;
        for (const author of authors) {
            assert.ok(author, 'author must be present on these fixtures');
            for (const key of Object.keys(author)) {
                assert.ok(declaredAuthorKeys.has(key), `author sub-object emits key "${key}" that is not declared in fields.properties.author.properties`);
                keysChecked += 1;
            }
        }
        assert.ok(keysChecked > 0, 'must have actually checked author keys');
    });
});
