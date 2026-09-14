/**
 * Contract tests against a REAL capture of the base actor's output.
 *
 * `clockworks-live-sample.json` was pulled verbatim from an actual
 * clockworks/tiktok-profile-scraper run on 2026-09-14 (run FcnOoj1exiAAZQgBW),
 * with only heavy CDN blobs (avatars, media URLs, subtitle links) stripped.
 *
 * The hand-written fixture in `clockworks-items.json` exercises our edge cases,
 * but it encodes OUR assumptions about the base actor's field names. This one
 * encodes THEIRS. If the base actor renames a field, this is the test that
 * fails — and the fix is confined to src/normalize.ts.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildReport } from '../src/analytics.ts';
import { normalizeItems } from '../src/normalize.ts';

const LIVE: any[] = JSON.parse(
    readFileSync(new URL('./fixtures/clockworks-live-sample.json', import.meta.url), 'utf8'),
);

describe('base actor output contract (live capture)', () => {
    it('still carries every field our normalizer reads', () => {
        // Fail loudly on a rename rather than silently normalizing to zeros.
        for (const item of LIVE) {
            for (const field of ['id', 'text', 'createTimeISO', 'webVideoUrl', 'playCount', 'diggCount', 'commentCount', 'shareCount']) {
                assert.ok(field in item, `base actor item lost top-level field "${field}"`);
            }
            for (const field of ['name', 'nickName', 'verified', 'fans', 'following', 'heart', 'video']) {
                assert.ok(field in item.authorMeta, `base actor authorMeta lost field "${field}"`);
            }
        }
    });

    it('emits one item per video, with profile stats repeated in authorMeta', () => {
        // This is the shape assumption the whole normalizer is built on.
        assert.equal(LIVE.length, 4);
        assert.equal(new Set(LIVE.map((i) => i.authorMeta.name)).size, 2);
        assert.equal(new Set(LIVE.map((i) => i.id)).size, 4);
    });
});

describe('normalizing the live capture', () => {
    const { profiles, missing } = normalizeItems(LIVE, ['tiktok', 'khaby.lame']);

    it('finds both profiles', () => {
        assert.deepEqual(missing, []);
        assert.deepEqual(profiles.map((p) => p.username), ['tiktok', 'khaby.lame']);
    });

    it('reads real profile counters correctly', () => {
        const [tiktok, khaby] = profiles;

        assert.equal(tiktok.followers, 95_700_000);
        assert.equal(tiktok.nickname, 'TikTok');
        assert.equal(tiktok.verified, true);
        assert.equal(tiktok.videoCount, 1503);

        assert.equal(khaby.followers, 162_800_000);
        assert.equal(khaby.verified, true);
    });

    it('reads real video counters correctly', () => {
        const [tiktok] = profiles;
        const video = tiktok.videos.find((v) => v.id === '7680721699171601694');

        assert.ok(video, 'expected the captured video to normalize');
        assert.equal(video.views, 256_800);
        assert.equal(video.likes, 10_900);
        assert.equal(video.comments, 1751);
        assert.equal(video.shares, 1009);
        assert.equal(video.createdAt, '2026-09-02T00:03:08.000Z');
        assert.equal(video.url, 'https://www.tiktok.com/@tiktok/video/7680721699171601694');
        assert.equal(video.sound, 'original sound');
        assert.match(video.description, /SongsofTheSummer2026/);
    });

    it('produces a clean report with no NaN or undefined from real data', () => {
        for (const profile of profiles) {
            const report = buildReport(profile, null, {
                snapshotAt: '2026-09-14T00:00:00.000Z',
                outlierMultiplier: 3,
            });

            const serialised = JSON.stringify(report);
            assert.ok(!serialised.includes('null,"views"'), 'video counters must never be null');
            assert.ok(!/NaN/.test(serialised), 'no NaN may reach the dataset');

            for (const key of ['followers', 'following', 'likes', 'videoCount', 'medianViews'] as const) {
                assert.ok(Number.isFinite(report[key]), `${key} must be finite`);
            }
        }
    });

    it('does not leak the base actor\'s heavy nested objects into our output', () => {
        // Our rows are billed per profile and read by humans; dumping the base
        // actor's videoMeta/hashtags/effectStickers would bloat every row.
        const report = buildReport(profiles[0], null, {
            snapshotAt: '2026-09-14T00:00:00.000Z',
            outlierMultiplier: 3,
        });
        const serialised = JSON.stringify(report);

        for (const leaked of ['videoMeta', 'authorMeta', 'musicMeta', 'effectStickers', 'hashtags', 'commentsDatasetUrl']) {
            assert.ok(!serialised.includes(leaked), `${leaked} must not leak into our dataset row`);
        }
    });
});
