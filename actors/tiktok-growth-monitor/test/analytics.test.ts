import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    MIN_VIDEOS_FOR_OUTLIERS,
    buildReport,
    buildSnapshot,
    detectOutliers,
    findNewVideos,
    findTopVideo,
    median,
    withVideoDeltas,
} from '../src/analytics.ts';
import type { ProfileSnapshot, ProfileStat, VideoStat } from '../src/types.ts';

/** Minimal video factory — only the fields a given assertion cares about vary. */
function video(id: string, views: number, extra: Partial<VideoStat> = {}): VideoStat {
    return {
        id,
        url: `https://www.tiktok.com/@test/video/${id}`,
        createdAt: '2026-09-01T00:00:00.000Z',
        views,
        likes: Math.floor(views / 10),
        comments: Math.floor(views / 100),
        shares: Math.floor(views / 200),
        description: `video ${id}`,
        sound: 'original sound',
        ...extra,
    };
}

function profile(videos: VideoStat[], extra: Partial<ProfileStat> = {}): ProfileStat {
    return {
        username: 'test',
        nickname: 'Test',
        verified: false,
        followers: 1000,
        following: 50,
        likes: 20000,
        videoCount: 120,
        videos,
        ...extra,
    };
}

describe('median', () => {
    it('returns 0 for an empty list rather than NaN', () => {
        assert.equal(median([]), 0);
    });

    it('returns the single value for a one-item list', () => {
        assert.equal(median([42]), 42);
    });

    it('picks the middle value of an odd-length list', () => {
        assert.equal(median([1, 2, 3, 4, 5]), 3);
    });

    it('averages the two middle values of an even-length list', () => {
        assert.equal(median([1, 2, 3, 4]), 2.5);
    });

    it('sorts numerically, not lexicographically', () => {
        // The classic JS trap: default .sort() would order these 100, 2, 9 and answer 2.
        assert.equal(median([100, 2, 9]), 9);
    });

    it('does not mutate the caller\'s array', () => {
        const values = [3, 1, 2];
        median(values);
        assert.deepEqual(values, [3, 1, 2]);
    });
});

describe('detectOutliers', () => {
    const window = [video('a', 100), video('b', 100), video('c', 100), video('d', 900)];

    it('flags a video at or above multiplier x median', () => {
        const outliers = detectOutliers(window, median(window.map((v) => v.views)), 3);

        assert.deepEqual(outliers.map((o) => o.id), ['d']);
        assert.equal(outliers[0].viewsMultipleOfMedian, 9);
    });

    it('treats the threshold as inclusive (>=, not >)', () => {
        const videos = [video('a', 100), video('b', 100), video('c', 300)];
        const outliers = detectOutliers(videos, 100, 3);

        assert.deepEqual(outliers.map((o) => o.id), ['c'], 'exactly 3x must count as an outlier');
    });

    it('respects a custom multiplier', () => {
        const videos = [video('a', 100), video('b', 100), video('c', 250)];

        assert.deepEqual(detectOutliers(videos, 100, 2).map((o) => o.id), ['c']);
        assert.deepEqual(detectOutliers(videos, 100, 3).map((o) => o.id), []);
    });

    it('returns outliers sorted by views, biggest first', () => {
        const videos = [video('a', 100), video('b', 500), video('c', 100), video('d', 900)];
        const outliers = detectOutliers(videos, 100, 3);

        assert.deepEqual(outliers.map((o) => o.id), ['d', 'b']);
    });

    it('rounds the median multiple to 2dp', () => {
        const videos = [video('a', 300), video('b', 300), video('c', 1000)];
        const outliers = detectOutliers(videos, 300, 3);

        assert.equal(outliers[0].viewsMultipleOfMedian, 3.33);
    });

    it('flags nothing when the median is zero, instead of flagging everything', () => {
        const videos = [video('a', 0), video('b', 0), video('c', 0)];

        assert.deepEqual(detectOutliers(videos, 0, 3), []);
    });

    it(`withholds outliers below ${MIN_VIDEOS_FOR_OUTLIERS} videos, where the median is meaningless`, () => {
        assert.deepEqual(detectOutliers([video('a', 1_000_000)], 1_000_000, 3), []);
        assert.deepEqual(detectOutliers([video('a', 100), video('b', 10_000)], 5050, 3), []);
    });

    it('flags nothing for a non-positive multiplier', () => {
        const videos = [video('a', 100), video('b', 100), video('c', 900)];

        assert.deepEqual(detectOutliers(videos, 100, 0), []);
        assert.deepEqual(detectOutliers(videos, 100, -1), []);
    });

    it('returns an empty list for an empty window', () => {
        assert.deepEqual(detectOutliers([], 0, 3), []);
    });
});

describe('findTopVideo', () => {
    it('returns null for an empty window', () => {
        assert.equal(findTopVideo([]), null);
    });

    it('picks the highest-view video regardless of position', () => {
        assert.equal(findTopVideo([video('a', 10), video('b', 900), video('c', 50)])?.id, 'b');
    });

    it('keeps the first of a tie, so output is stable run to run', () => {
        assert.equal(findTopVideo([video('a', 100), video('b', 100)])?.id, 'a');
    });
});

describe('findNewVideos', () => {
    const previous: ProfileSnapshot = {
        username: 'test',
        snapshotAt: '2026-09-13T00:00:00.000Z',
        followers: 900,
        following: 50,
        likes: 19000,
        videoCount: 118,
        videos: {
            a: { views: 100, likes: 10, comments: 1, shares: 0 },
            b: { views: 200, likes: 20, comments: 2, shares: 1 },
        },
    };

    it('reports nothing on the first run, instead of the whole back catalogue', () => {
        const videos = [video('a', 100), video('b', 200), video('c', 300)];

        assert.deepEqual(findNewVideos(videos, null), []);
    });

    it('reports only ids absent from the previous snapshot', () => {
        const videos = [video('c', 300), video('a', 150), video('d', 10)];

        assert.deepEqual(findNewVideos(videos, previous).map((v) => v.id), ['c', 'd']);
    });

    it('reports nothing when the window is unchanged', () => {
        assert.deepEqual(findNewVideos([video('a', 111), video('b', 222)], previous), []);
    });

    it('is not fooled by inherited Object.prototype keys', () => {
        // A video literally called "constructor" must be NEW, not silently matched
        // against Object.prototype.constructor by a naive `in`/lookup check.
        const videos = [video('constructor', 5), video('toString', 5)];

        assert.deepEqual(
            findNewVideos(videos, previous).map((v) => v.id),
            ['constructor', 'toString'],
        );
    });
});

describe('withVideoDeltas', () => {
    const previous: ProfileSnapshot = {
        username: 'test',
        snapshotAt: '2026-09-13T00:00:00.000Z',
        followers: 900,
        following: 50,
        likes: 19000,
        videoCount: 118,
        videos: { a: { views: 100, likes: 10, comments: 1, shares: 0 } },
    };

    it('yields null deltas on the first run', () => {
        const [first] = withVideoDeltas([video('a', 150)], null);

        assert.equal(first.viewsDelta, null);
        assert.equal(first.likesDelta, null);
    });

    it('computes the delta for a video seen before', () => {
        const [first] = withVideoDeltas([video('a', 150, { likes: 25 })], previous);

        assert.equal(first.viewsDelta, 50);
        assert.equal(first.likesDelta, 15);
    });

    it('yields null for a video not in the previous snapshot', () => {
        const [, second] = withVideoDeltas([video('a', 150), video('z', 10)], previous);

        assert.equal(second.viewsDelta, null);
    });

    it('allows a negative delta when a counter goes down', () => {
        // TikTok view counts do occasionally revise downwards; do not clamp to 0.
        const [first] = withVideoDeltas([video('a', 80)], previous);

        assert.equal(first.viewsDelta, -20);
    });

    it('never emits NaN for a video id that collides with Object.prototype', () => {
        // Regression: a bare `previous.videos[id]` lookup resolves "constructor"
        // to an inherited function, which is truthy, so the subtraction silently
        // produced NaN and shipped it into the dataset.
        const deltas = withVideoDeltas([video('constructor', 5), video('toString', 5)], previous);

        for (const delta of deltas) {
            assert.equal(delta.viewsDelta, null, `${delta.id} has no baseline, so its delta must be null`);
            assert.equal(delta.likesDelta, null);
            assert.ok(!Number.isNaN(delta.viewsDelta as number));
        }
    });

    it('preserves the original video fields', () => {
        const [first] = withVideoDeltas([video('a', 150, { sound: 'a song' })], previous);

        assert.equal(first.sound, 'a song');
        assert.equal(first.url, 'https://www.tiktok.com/@test/video/a');
    });
});

describe('buildSnapshot', () => {
    it('captures profile counters and indexes videos by id', () => {
        const snapshot = buildSnapshot(
            profile([video('a', 100), video('b', 200)], { username: 'ttk', followers: 1234 }),
            '2026-09-14T00:00:00.000Z',
        );

        assert.equal(snapshot.username, 'ttk');
        assert.equal(snapshot.followers, 1234);
        assert.equal(snapshot.snapshotAt, '2026-09-14T00:00:00.000Z');
        assert.deepEqual(Object.keys(snapshot.videos).sort(), ['a', 'b']);
        assert.deepEqual(snapshot.videos.a, { views: 100, likes: 10, comments: 1, shares: 0 });
    });

    it('stores only the four counters, keeping persisted state small', () => {
        const snapshot = buildSnapshot(profile([video('a', 100)]), '2026-09-14T00:00:00.000Z');

        assert.deepEqual(Object.keys(snapshot.videos.a).sort(), ['comments', 'likes', 'shares', 'views']);
    });

    it('round-trips through JSON, since it is persisted to a key-value store', () => {
        const snapshot = buildSnapshot(profile([video('a', 100)]), '2026-09-14T00:00:00.000Z');

        assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
    });
});

describe('buildReport', () => {
    const options = { snapshotAt: '2026-09-14T00:00:00.000Z', outlierMultiplier: 3 };
    const current = profile([video('a', 120), video('b', 100), video('c', 100), video('new', 900)], {
        username: 'ttk',
        followers: 1000,
        following: 50,
        likes: 20000,
        videoCount: 120,
    });

    describe('first run (no previous snapshot)', () => {
        const report = buildReport(current, null, options);

        it('reports every delta as null rather than as zero', () => {
            assert.equal(report.followersDelta, null);
            assert.equal(report.likesDelta, null);
            assert.equal(report.followingDelta, null);
            assert.equal(report.videoCountDelta, null);
            assert.equal(report.previousSnapshotAt, null);
            assert.ok(report.videos.every((v) => v.viewsDelta === null));
        });

        it('reports no new videos, to avoid a back-catalogue alert storm', () => {
            assert.deepEqual(report.newVideos, []);
        });

        it('still reports absolute stats, median, outliers and the top video', () => {
            assert.equal(report.followers, 1000);
            assert.equal(report.medianViews, 110);
            assert.deepEqual(report.outliers.map((o) => o.id), ['new']);
            assert.equal(report.topVideo?.id, 'new');
        });

        it('explains in runNote that this is the baseline', () => {
            assert.match(report.runNote, /first run/i);
            assert.match(report.runNote, /@ttk/);
        });
    });

    describe('second run (previous snapshot present)', () => {
        const previous = buildSnapshot(
            profile([video('a', 100), video('b', 90), video('c', 80)], {
                username: 'ttk',
                followers: 900,
                following: 48,
                likes: 19000,
                videoCount: 118,
            }),
            '2026-09-13T00:00:00.000Z',
        );
        const report = buildReport(current, previous, options);

        it('computes profile-level deltas', () => {
            assert.equal(report.followersDelta, 100);
            assert.equal(report.followingDelta, 2);
            assert.equal(report.likesDelta, 1000);
            assert.equal(report.videoCountDelta, 2);
            assert.equal(report.previousSnapshotAt, '2026-09-13T00:00:00.000Z');
        });

        it('computes per-video view deltas for videos seen before', () => {
            const byId = new Map(report.videos.map((v) => [v.id, v]));

            assert.equal(byId.get('a')?.viewsDelta, 20);
            assert.equal(byId.get('b')?.viewsDelta, 10);
            assert.equal(byId.get('c')?.viewsDelta, 20);
        });

        it('detects the new video and leaves its delta null', () => {
            assert.deepEqual(report.newVideos.map((v) => v.id), ['new']);
            assert.equal(report.videos.find((v) => v.id === 'new')?.viewsDelta, null);
        });

        it('names the comparison snapshot and match count in runNote', () => {
            assert.match(report.runNote, /2026-09-13T00:00:00\.000Z/);
            assert.match(report.runNote, /3 of 4/);
        });
    });

    it('carries the requested snapshotAt rather than reading the clock', () => {
        const report = buildReport(current, null, { ...options, snapshotAt: '2030-01-01T00:00:00.000Z' });

        assert.equal(report.snapshotAt, '2030-01-01T00:00:00.000Z');
    });

    it('honours a custom outlier multiplier', () => {
        const loose = buildReport(current, null, { ...options, outlierMultiplier: 2 });

        assert.deepEqual(loose.outliers.map((o) => o.id), ['new']);

        const strict = buildReport(current, null, { ...options, outlierMultiplier: 20 });

        assert.deepEqual(strict.outliers, []);
    });

    it('handles a profile with no videos without throwing', () => {
        const report = buildReport(profile([], { username: 'empty' }), null, options);

        assert.equal(report.medianViews, 0);
        assert.equal(report.topVideo, null);
        assert.deepEqual(report.outliers, []);
        assert.deepEqual(report.videos, []);
        assert.match(report.runNote, /at least 3 videos/i);
    });

    it('produces a JSON-serialisable row, since it is pushed to a dataset', () => {
        const report = buildReport(current, null, options);

        assert.deepEqual(JSON.parse(JSON.stringify(report)), report);
    });
});
