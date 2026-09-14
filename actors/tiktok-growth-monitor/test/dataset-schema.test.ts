/**
 * Locks in the contract between `.actor/dataset_schema.json` and what the
 * actor's own code actually pushes to the dataset.
 *
 * Apify validates every item on `Actor.pushData()` against this schema and
 * DISCARDS THE ENTIRE REQUEST with HTTP 400 if a single item fails. A row we
 * would otherwise have billed and delivered would simply vanish. So the
 * schema must never be able to reject a real `ProfileReport` — this file
 * compiles the schema with ajv and throws real rows (built with the actor's
 * own `normalizeItems` + `buildReport`, from both the hand-written and the
 * live-capture fixtures, on a first run AND a follow-up run) at it, then
 * asserts the class-level invariants (no `required`, no
 * `additionalProperties: false`) that make future edits safe too.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// ajv v8 ships CJS; its default export lands on `.default` under NodeNext/ESM
// interop, but only sometimes depending on the resolver, so check both.
import AjvModule from 'ajv';
const Ajv = (AjvModule as any).default ?? AjvModule;

import { buildReport, buildSnapshot } from '../src/analytics.ts';
import { normalizeItems } from '../src/normalize.ts';
import type { ProfileReport, ProfileSnapshot, ProfileStat } from '../src/types.ts';

const SCHEMA: any = JSON.parse(
    readFileSync(new URL('../.actor/dataset_schema.json', import.meta.url), 'utf8'),
);

const ITEMS_FIXTURE: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/clockworks-items.json', import.meta.url), 'utf8'),
);
const LIVE_FIXTURE: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/clockworks-live-sample.json', import.meta.url), 'utf8'),
);

const REQUESTED = ['tiktok', 'khaby.lame'];
const SNAPSHOT_AT = '2026-09-14T00:00:00.000Z';
const PREVIOUS_SNAPSHOT_AT = '2026-09-13T00:00:00.000Z';
// Low enough that the hand-written fixture's biggest video (3x its profile's
// median) trips it, so `outliers` gets exercised without needing a fixture
// change; MIN_VIDEOS_FOR_OUTLIERS still gates the 2-video live-sample window
// to [], which is fine — other reports cover the outliers branch.
const OUTLIER_MULTIPLIER = 3;

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(SCHEMA.fields);

/**
 * Build a believable "yesterday" snapshot from a live profile: counters
 * shrunk a bit (so today's counters diff to non-null, non-zero deltas) and
 * its first video dropped entirely (so that video shows up as `newVideos`
 * and every remaining video gets a real per-video delta).
 */
function previousSnapshotFor(profile: ProfileStat): ProfileSnapshot {
    const [, ...remainingVideos] = profile.videos;

    const shrunk: ProfileStat = {
        ...profile,
        followers: Math.max(0, profile.followers - 5),
        following: Math.max(0, profile.following - 1),
        likes: Math.max(0, profile.likes - 50),
        videoCount: Math.max(0, profile.videoCount - 1),
        videos: remainingVideos.map((video) => ({
            ...video,
            views: Math.max(0, video.views - 10),
            likes: Math.max(0, video.likes - 1),
        })),
    };

    return buildSnapshot(shrunk, PREVIOUS_SNAPSHOT_AT);
}

function normalizedProfiles(): ProfileStat[] {
    const fromItems = normalizeItems(ITEMS_FIXTURE, REQUESTED).profiles;
    const fromLive = normalizeItems(LIVE_FIXTURE, REQUESTED).profiles;

    return [...fromItems, ...fromLive];
}

/** Every report the actor's own code would produce from both fixtures, on both a
 * first run (previous = null, everything *Delta null) and a follow-up run
 * (previous = a shrunk snapshot, deltas non-null, one video new). */
function buildAllReports(): ProfileReport[] {
    const reports: ProfileReport[] = [];

    for (const profile of normalizedProfiles()) {
        reports.push(
            buildReport(profile, null, { snapshotAt: SNAPSHOT_AT, outlierMultiplier: OUTLIER_MULTIPLIER }),
        );

        if (profile.videos.length > 0) {
            const previous = previousSnapshotFor(profile);
            reports.push(
                buildReport(profile, previous, { snapshotAt: SNAPSHOT_AT, outlierMultiplier: OUTLIER_MULTIPLIER }),
            );
        }
    }

    return reports;
}

const REPORTS = buildAllReports();

describe('dataset schema validates every real row the actor produces', () => {
    it('built a non-empty set of reports to validate (non-vacuous)', () => {
        assert.ok(REPORTS.length > 0, 'expected at least one report from the fixtures');
    });

    it('accepts every ProfileReport built from both fixtures, first run and follow-up', () => {
        for (const report of REPORTS) {
            const ok = validate(report);
            assert.ok(
                ok,
                `schema rejected a real row for @${report.username} `
                + `(previousSnapshotAt=${report.previousSnapshotAt}): ${JSON.stringify(validate.errors)}`,
            );
        }
    });

    it('exercised the nested-object branches: outliers, newVideos, videos, topVideo', () => {
        assert.ok(REPORTS.some((r) => r.outliers.length > 0), 'no report had a non-empty outliers array');
        assert.ok(REPORTS.some((r) => r.newVideos.length > 0), 'no report had a non-empty newVideos array');
        assert.ok(REPORTS.some((r) => r.videos.length > 0), 'no report had a non-empty videos array');
        assert.ok(REPORTS.some((r) => r.topVideo !== null), 'no report had a non-null topVideo');
    });
});

/** Walk a dotted (possibly array-crossing) path through `fields.properties`. */
function resolvesInSchema(dottedPath: string, fieldsSchema: any): boolean {
    const parts = dottedPath.split('.');
    let node = fieldsSchema;

    for (const part of parts) {
        if (node?.type === 'array' && node.items) node = node.items;
        if (!node?.properties || !(part in node.properties)) return false;
        node = node.properties[part];
    }

    return true;
}

describe('every view\'s transformation.fields resolves inside fields.properties', () => {
    it('checks a non-vacuous number of field paths across every view', () => {
        let checked = 0;

        for (const [viewName, view] of Object.entries<any>(SCHEMA.views)) {
            const fields: string[] = view.transformation?.fields ?? [];

            // "overview" deliberately ships an empty transformation (it wants
            // every field, unfiltered) — nothing to check there, and that's fine.
            for (const path of fields) {
                checked += 1;
                assert.ok(
                    resolvesInSchema(path, SCHEMA.fields),
                    `view "${viewName}" transformation references unknown field path "${path}"`,
                );
            }
        }

        assert.ok(checked > 0, 'no view transformation field paths were checked');
    });
});

/** Recursively visit every object node in a JSON-Schema tree (properties, items, and so on). */
function walkSchemaNodes(node: unknown, visit: (node: Record<string, unknown>) => void): void {
    if (node === null || typeof node !== 'object') return;

    if (Array.isArray(node)) {
        for (const child of node) walkSchemaNodes(child, visit);
        return;
    }

    visit(node as Record<string, unknown>);
    for (const value of Object.values(node)) walkSchemaNodes(value, visit);
}

describe('class-level schema invariants (no property can ever reject a real row)', () => {
    it('never uses `required` anywhere in the tree', () => {
        let visited = 0;

        walkSchemaNodes(SCHEMA.fields, (node) => {
            visited += 1;
            assert.ok(
                !('required' in node),
                'a `required` key would 400 the whole push when the base actor omits a field it normally sends',
            );
        });

        assert.ok(visited > 10, 'schema walk did not descend into the tree (non-vacuous)');
    });

    it('never sets `additionalProperties: false` anywhere in the tree', () => {
        walkSchemaNodes(SCHEMA.fields, (node) => {
            if ('additionalProperties' in node) {
                assert.notEqual(
                    node.additionalProperties,
                    false,
                    '`additionalProperties: false` would reject any row carrying a field this schema does not yet know about',
                );
            }
        });
    });

    it('is a draft-07 object schema with declared properties', () => {
        assert.equal(SCHEMA.fields.type, 'object');
        assert.ok(
            SCHEMA.fields.properties && Object.keys(SCHEMA.fields.properties).length > 0,
            'fields.properties must be non-empty',
        );

        if (SCHEMA.fields.$schema !== undefined) {
            assert.equal(SCHEMA.fields.$schema, 'http://json-schema.org/draft-07/schema#');
        }
    });
});

describe('every real field the actor emits is declared in the schema', () => {
    it('covers every top-level key of a real ProfileReport', () => {
        for (const report of REPORTS) {
            for (const key of Object.keys(report)) {
                assert.ok(
                    key in SCHEMA.fields.properties,
                    `ProfileReport key "${key}" has no schema property under fields.properties`,
                );
            }
        }
    });

    it('covers every key of a real video entry (fields.properties.videos.items.properties)', () => {
        const withVideos = REPORTS.find((r) => r.videos.length > 0);
        assert.ok(withVideos, 'need at least one report with videos to check (non-vacuous)');

        const videoProps = SCHEMA.fields.properties.videos.items.properties;
        for (const key of Object.keys(withVideos!.videos[0])) {
            assert.ok(key in videoProps, `video key "${key}" has no schema property`);
        }
    });

    it('covers every key of a real outlier entry (fields.properties.outliers.items.properties)', () => {
        const withOutliers = REPORTS.find((r) => r.outliers.length > 0);
        assert.ok(withOutliers, 'need at least one report with outliers to check (non-vacuous)');

        const outlierProps = SCHEMA.fields.properties.outliers.items.properties;
        for (const key of Object.keys(withOutliers!.outliers[0])) {
            assert.ok(key in outlierProps, `outlier key "${key}" has no schema property`);
        }
    });

    it('covers every key of a real newVideos entry (fields.properties.newVideos.items.properties)', () => {
        const withNewVideos = REPORTS.find((r) => r.newVideos.length > 0);
        assert.ok(withNewVideos, 'need at least one report with newVideos to check (non-vacuous)');

        const newVideoProps = SCHEMA.fields.properties.newVideos.items.properties;
        for (const key of Object.keys(withNewVideos!.newVideos[0])) {
            assert.ok(key in newVideoProps, `newVideos key "${key}" has no schema property`);
        }
    });

    it('covers every key of a real topVideo (fields.properties.topVideo.properties)', () => {
        const withTopVideo = REPORTS.find((r) => r.topVideo !== null);
        assert.ok(withTopVideo, 'need at least one report with topVideo to check (non-vacuous)');

        const topVideoProps = SCHEMA.fields.properties.topVideo.properties;
        for (const key of Object.keys(withTopVideo!.topVideo!)) {
            assert.ok(key in topVideoProps, `topVideo key "${key}" has no schema property`);
        }
    });
});
