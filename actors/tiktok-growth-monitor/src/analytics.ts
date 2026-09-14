/**
 * The analytics layer: medians, viral outliers, run-over-run deltas.
 *
 * Everything here is pure. No Actor, no network, no clock — `snapshotAt` is
 * always passed in. That is what makes the whole product testable against a
 * fixture without a platform run.
 */

import type {
    OutlierVideo,
    ProfileReport,
    ProfileSnapshot,
    ProfileStat,
    VideoSnapshotEntry,
    VideoStat,
    VideoWithDelta,
} from './types.ts';

/**
 * Outlier detection below this many videos is statistical theatre: with one
 * video the median IS that video, and with two the median is their mean, so a
 * single mediocre pair can trip the threshold. We compute the median either way
 * (it is still reported) but withhold outlier ALERTS until the window is big
 * enough for the comparison to mean something.
 */
export const MIN_VIDEOS_FOR_OUTLIERS = 3;

/** Round to 2dp without float dust (0.1+0.2 territory). */
function round2(value: number): number {
    return Math.round(value * 100) / 100;
}

/**
 * Median of a numeric list. Even-length lists average the two middle values.
 * Returns 0 for an empty list, which callers treat as "no basis for comparison".
 */
export function median(values: number[]): number {
    if (values.length === 0) return 0;

    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);

    return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid];
}

/**
 * Videos whose view count is at least `multiplier` times the profile's median.
 *
 * A zero median means every video has zero views (a brand-new or shadowbanned
 * profile) — everything would trivially "exceed" it, so we return nothing
 * rather than alerting on noise.
 */
export function detectOutliers(
    videos: VideoStat[],
    medianViews: number,
    multiplier: number,
): OutlierVideo[] {
    if (videos.length < MIN_VIDEOS_FOR_OUTLIERS) return [];
    if (medianViews <= 0 || multiplier <= 0) return [];

    const threshold = medianViews * multiplier;

    return videos
        .filter((video) => video.views >= threshold)
        .map((video) => ({
            ...video,
            viewsMultipleOfMedian: round2(video.views / medianViews),
        }))
        .sort((a, b) => b.views - a.views);
}

/** The best-performing video in the fetched window, by views. */
export function findTopVideo(videos: VideoStat[]): VideoStat | null {
    if (videos.length === 0) return null;

    return videos.reduce((best, video) => (video.views > best.views ? video : best));
}

/**
 * Look up a video's previous counters.
 *
 * Deliberately `Object.hasOwn` rather than `in` or a bare bracket lookup: the
 * snapshot comes back from the key-value store via `JSON.parse`, so it carries
 * `Object.prototype`. A video whose id is `constructor` or `toString` would
 * otherwise resolve to an inherited function — truthy — and every delta
 * computed from it would be a silent `NaN` in the output.
 */
function previousEntry(
    previous: ProfileSnapshot | null,
    videoId: string,
): VideoSnapshotEntry | null {
    if (previous === null) return null;
    if (!Object.hasOwn(previous.videos, videoId)) return null;

    return previous.videos[videoId];
}

/**
 * Videos present now that were absent from the previous snapshot.
 *
 * On the first run this is empty by design: with no baseline, every video would
 * look "new", which would spam a webhook with a profile's entire back catalogue.
 */
export function findNewVideos(
    videos: VideoStat[],
    previous: ProfileSnapshot | null,
): VideoStat[] {
    if (previous === null) return [];

    return videos.filter((video) => previousEntry(previous, video.id) === null);
}

/** Attach per-video deltas for videos we have seen before. */
export function withVideoDeltas(
    videos: VideoStat[],
    previous: ProfileSnapshot | null,
): VideoWithDelta[] {
    return videos.map((video) => {
        const before = previousEntry(previous, video.id);

        return {
            ...video,
            viewsDelta: before ? video.views - before.views : null,
            likesDelta: before ? video.likes - before.likes : null,
        };
    });
}

/** Subtract, or null when there is no baseline to subtract from. */
function delta(current: number, previous: number | undefined): number | null {
    return typeof previous === 'number' ? current - previous : null;
}

/** Reduce a live profile to the compact record we persist for the next run. */
export function buildSnapshot(profile: ProfileStat, snapshotAt: string): ProfileSnapshot {
    const videos: Record<string, ProfileSnapshot['videos'][string]> = {};

    for (const video of profile.videos) {
        videos[video.id] = {
            views: video.views,
            likes: video.likes,
            comments: video.comments,
            shares: video.shares,
        };
    }

    return {
        username: profile.username,
        snapshotAt,
        followers: profile.followers,
        following: profile.following,
        likes: profile.likes,
        videoCount: profile.videoCount,
        videos,
    };
}

/** Explain in one sentence what this run could and could not compute. */
function buildRunNote(
    profile: ProfileStat,
    previous: ProfileSnapshot | null,
    matchedVideos: number,
): string {
    const parts: string[] = [];

    if (previous === null) {
        parts.push(
            `First run for @${profile.username}: baseline snapshot saved, deltas appear from the next run onwards.`,
        );
    } else {
        parts.push(
            `Compared against the snapshot from ${previous.snapshotAt}; ${matchedVideos} of ${profile.videos.length} fetched videos were seen before.`,
        );
    }

    if (profile.videos.length < MIN_VIDEOS_FOR_OUTLIERS) {
        parts.push(
            `Outlier detection needs at least ${MIN_VIDEOS_FOR_OUTLIERS} videos in the window; only ${profile.videos.length} were fetched, so no outliers were flagged.`,
        );
    }

    return parts.join(' ');
}

/**
 * Turn one normalized profile plus its previous snapshot into a dataset row.
 *
 * `snapshotAt` is injected rather than read from the clock so that a whole run
 * shares one timestamp and tests are deterministic.
 */
export function buildReport(
    profile: ProfileStat,
    previous: ProfileSnapshot | null,
    options: { snapshotAt: string; outlierMultiplier: number },
): ProfileReport {
    const { snapshotAt, outlierMultiplier } = options;

    const medianViews = median(profile.videos.map((video) => video.views));
    const videos = withVideoDeltas(profile.videos, previous);
    const matchedVideos = videos.filter((video) => video.viewsDelta !== null).length;

    return {
        username: profile.username,
        nickname: profile.nickname,
        verified: profile.verified,
        snapshotAt,
        previousSnapshotAt: previous?.snapshotAt ?? null,
        followers: profile.followers,
        followersDelta: delta(profile.followers, previous?.followers),
        following: profile.following,
        followingDelta: delta(profile.following, previous?.following),
        likes: profile.likes,
        likesDelta: delta(profile.likes, previous?.likes),
        videoCount: profile.videoCount,
        videoCountDelta: delta(profile.videoCount, previous?.videoCount),
        newVideos: findNewVideos(profile.videos, previous),
        medianViews,
        outliers: detectOutliers(profile.videos, medianViews, outlierMultiplier),
        topVideo: findTopVideo(profile.videos),
        videos,
        runNote: buildRunNote(profile, previous, matchedVideos),
    };
}
