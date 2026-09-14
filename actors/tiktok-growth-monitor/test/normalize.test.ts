import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { baseActorInput, itemUsername, normalizeItems, toVideoStat } from '../src/normalize.ts';

const FIXTURE: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/clockworks-items.json', import.meta.url), 'utf8'),
);

const REQUESTED = ['tiktok', 'khaby.lame'];

describe('itemUsername', () => {
    it('reads the handle from authorMeta.name', () => {
        assert.equal(itemUsername({ authorMeta: { name: 'tiktok' } }), 'tiktok');
    });

    it('lowercases, so grouping matches our canonical input keys', () => {
        assert.equal(itemUsername({ authorMeta: { name: 'KhabY.Lame' } }), 'khaby.lame');
    });

    it('falls back to authorMeta.uniqueId', () => {
        assert.equal(itemUsername({ authorMeta: { uniqueId: 'tiktok' } }), 'tiktok');
    });

    it('falls back to the author profile URL', () => {
        assert.equal(
            itemUsername({ authorMeta: { profileUrl: 'https://www.tiktok.com/@tiktok' } }),
            'tiktok',
        );
    });

    it('falls back to the video URL when authorMeta is missing entirely', () => {
        assert.equal(
            itemUsername({ webVideoUrl: 'https://www.tiktok.com/@khaby.lame/video/123' }),
            'khaby.lame',
        );
    });

    it('returns null for an item with nothing identifying in it', () => {
        assert.equal(itemUsername({}), null);
        assert.equal(itemUsername({ authorMeta: null }), null);
        assert.equal(itemUsername({ error: 'not_found' }), null);
    });
});

describe('toVideoStat', () => {
    it('maps every base-actor field to our domain field', () => {
        const video = toVideoStat(FIXTURE[0] as Record<string, unknown>);

        assert.deepEqual(video, {
            id: '7300000000000000001',
            url: 'https://www.tiktok.com/@tiktok/video/7300000000000000001',
            createdAt: '2026-09-10T12:00:00.000Z',
            views: 120000,
            likes: 9000,
            comments: 410,
            shares: 220,
            description: 'welcome to the app #fyp',
            sound: 'original sound',
        });
    });

    it('returns null for an item carrying no video id (empty-profile marker)', () => {
        assert.equal(toVideoStat({ authorMeta: { name: 'tiktok' } }), null);
        assert.equal(toVideoStat({ id: '', authorMeta: { name: 'tiktok' } }), null);
    });

    it('coerces string counters to numbers', () => {
        const video = toVideoStat({
            id: '1',
            playCount: '5200000',
            diggCount: '410000',
            webVideoUrl: 'https://www.tiktok.com/@x/video/1',
        });

        assert.equal(video?.views, 5200000);
        assert.equal(video?.likes, 410000);
    });

    it('coerces missing and null counters to 0, never NaN', () => {
        const video = toVideoStat({ id: '1', webVideoUrl: 'https://www.tiktok.com/@x/video/1' });

        for (const key of ['views', 'likes', 'comments', 'shares'] as const) {
            assert.equal(video?.[key], 0, `${key} must default to 0`);
            assert.ok(!Number.isNaN(video?.[key]), `${key} must never be NaN`);
        }
    });

    it('coerces a garbage counter to 0 rather than NaN', () => {
        const video = toVideoStat({ id: '1', playCount: 'not a number', diggCount: {} });

        assert.equal(video?.views, 0);
        assert.equal(video?.likes, 0);
    });

    it('reconstructs the video URL when the base actor omits it', () => {
        const video = toVideoStat({ id: '999', authorMeta: { name: 'tiktok' } });

        assert.equal(video?.url, 'https://www.tiktok.com/@tiktok/video/999');
    });

    it('yields null (not empty string) for an absent sound and create time', () => {
        const video = toVideoStat({ id: '1', musicMeta: {}, authorMeta: { name: 'x' } });

        assert.equal(video?.sound, null);
        assert.equal(video?.createdAt, null);
    });

    it('yields empty string for an absent description, keeping the field a string', () => {
        const video = toVideoStat({ id: '1', authorMeta: { name: 'x' } });

        assert.equal(video?.description, '');
    });
});

describe('normalizeItems', () => {
    it('groups the flat video list into one record per profile', () => {
        const { profiles } = normalizeItems(FIXTURE, REQUESTED);

        assert.equal(profiles.length, 2);
        assert.deepEqual(profiles.map((p) => p.username), ['tiktok', 'khaby.lame']);
        assert.equal(profiles[0].videos.length, 3);
        assert.equal(profiles[1].videos.length, 3);
    });

    it('lifts the repeated authorMeta counters to profile level', () => {
        const [tiktok] = normalizeItems(FIXTURE, REQUESTED).profiles;

        assert.equal(tiktok.nickname, 'TikTok');
        assert.equal(tiktok.verified, true);
        assert.equal(tiktok.followers, 80000000);
        assert.equal(tiktok.following, 500);
        assert.equal(tiktok.likes, 600000000);
        assert.equal(tiktok.videoCount, 1200);
    });

    it('returns profiles in the requested order, not the order items arrived', () => {
        const { profiles } = normalizeItems(FIXTURE, ['khaby.lame', 'tiktok']);

        assert.deepEqual(profiles.map((p) => p.username), ['khaby.lame', 'tiktok']);
    });

    it('drops items whose author was never requested', () => {
        const { profiles } = normalizeItems(FIXTURE, REQUESTED);
        const allIds = profiles.flatMap((p) => p.videos.map((v) => v.id));

        assert.ok(
            !allIds.includes('7300000000000000099'),
            'a reposted video by a non-requested author must not inflate a profile',
        );
    });

    it('reports requested profiles that returned nothing', () => {
        const { profiles, missing } = normalizeItems(FIXTURE, ['tiktok', 'ghost_account']);

        assert.deepEqual(profiles.map((p) => p.username), ['tiktok']);
        assert.deepEqual(missing, ['ghost_account']);
    });

    it('reports every profile missing when the base actor returns nothing', () => {
        const { profiles, missing } = normalizeItems([], REQUESTED);

        assert.deepEqual(profiles, []);
        assert.deepEqual(missing, REQUESTED);
    });

    it('de-duplicates a video repeated across pages', () => {
        const doubled = [...FIXTURE, FIXTURE[0]];
        const [tiktok] = normalizeItems(doubled, REQUESTED).profiles;

        assert.equal(tiktok.videos.length, 3, 'the same video id must be counted once');
    });

    it('keeps a profile that exists but has no videos, rather than calling it missing', () => {
        const { profiles, missing } = normalizeItems(
            [{ authorMeta: { name: 'quietuser', nickName: 'Quiet', fans: 12, following: 3, heart: 0, video: 0 } }],
            ['quietuser'],
        );

        assert.deepEqual(missing, []);
        assert.equal(profiles[0].followers, 12);
        assert.deepEqual(profiles[0].videos, []);
    });

    it('ignores malformed entries without throwing', () => {
        const { profiles } = normalizeItems(
            [null, 'a string', 42, [], ...FIXTURE],
            REQUESTED,
        );

        assert.equal(profiles.length, 2);
    });

    it('produces no NaN anywhere in the normalized output', () => {
        const { profiles } = normalizeItems(FIXTURE, REQUESTED);

        const walk = (value: unknown, path: string): void => {
            if (typeof value === 'number') {
                assert.ok(Number.isFinite(value), `${path} must be finite, got ${value}`);
            } else if (Array.isArray(value)) {
                value.forEach((entry, i) => walk(entry, `${path}[${i}]`));
            } else if (value !== null && typeof value === 'object') {
                for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
            }
        };

        walk(profiles, 'profiles');
    });
});

describe('baseActorInput', () => {
    it('sends bare usernames and the per-profile limit under the names the base actor expects', () => {
        const input = baseActorInput(['tiktok', 'khaby.lame'], 10);

        assert.deepEqual(input.profiles, ['tiktok', 'khaby.lame']);
        assert.equal(input.resultsPerPage, 10);
    });

    it('disables every separately-charged media download add-on', () => {
        const input = baseActorInput(['tiktok'], 10);

        for (const key of [
            'shouldDownloadVideos',
            'shouldDownloadCovers',
            'shouldDownloadSlideshowImages',
            'shouldDownloadAvatars',
            'shouldDownloadSubtitles',
        ]) {
            assert.equal(input[key], false, `${key} must stay off: it costs the user money we never use`);
        }
    });
});
