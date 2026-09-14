/**
 * Shared domain types for TikTok Growth Monitor.
 *
 * These describe OUR normalized shape, deliberately decoupled from the base
 * scraper's raw item shape. `normalize.ts` is the only adapter between the two,
 * so a base-actor field rename stays a one-file fix.
 */

/** One video's public engagement stats at a point in time. */
export interface VideoStat {
    id: string;
    url: string;
    /** ISO-8601, or null when the base actor did not supply a create time. */
    createdAt: string | null;
    views: number;
    likes: number;
    comments: number;
    shares: number;
    description: string;
    /** Sound / music name, or null when unavailable. */
    sound: string | null;
}

/** A profile plus the window of videos fetched for it in this run. */
export interface ProfileStat {
    username: string;
    nickname: string | null;
    verified: boolean;
    followers: number;
    following: number;
    /** Lifetime hearts/likes across the profile. */
    likes: number;
    /** Lifetime video count reported by the profile, not the size of the fetched window. */
    videoCount: number;
    videos: VideoStat[];
}

/** Per-video counters persisted between runs (the minimum needed for deltas). */
export interface VideoSnapshotEntry {
    views: number;
    likes: number;
    comments: number;
    shares: number;
}

/**
 * What we persist per profile in the named key-value store between runs.
 * Kept deliberately small: this is written every run, for every profile.
 */
export interface ProfileSnapshot {
    username: string;
    snapshotAt: string;
    followers: number;
    following: number;
    likes: number;
    videoCount: number;
    /** Keyed by video id. */
    videos: Record<string, VideoSnapshotEntry>;
}

/** A video that crossed the outlier threshold, with its multiple of the median. */
export interface OutlierVideo extends VideoStat {
    /** views / medianViews, rounded to 2dp. */
    viewsMultipleOfMedian: number;
}

/** A video in the output, enriched with its deltas since the last run. */
export interface VideoWithDelta extends VideoStat {
    /** null on the first run, or when this video was absent from the previous snapshot. */
    viewsDelta: number | null;
    likesDelta: number | null;
}

/** One dataset row: everything we know about one profile for this run. */
export interface ProfileReport {
    username: string;
    nickname: string | null;
    verified: boolean;
    snapshotAt: string;
    previousSnapshotAt: string | null;
    followers: number;
    followersDelta: number | null;
    following: number;
    followingDelta: number | null;
    likes: number;
    likesDelta: number | null;
    videoCount: number;
    videoCountDelta: number | null;
    /** Videos present now that were absent from the previous snapshot. */
    newVideos: VideoStat[];
    medianViews: number;
    outliers: OutlierVideo[];
    topVideo: VideoStat | null;
    videos: VideoWithDelta[];
    /** Human-readable note about what this run could and could not compute. */
    runNote: string;
}

/** Compact run summary written to the default KV store as OUTPUT and POSTed to the webhook. */
export interface RunSummary {
    actor: string;
    runStartedAt: string;
    finishedAt: string;
    profilesRequested: number;
    profilesMonitored: number;
    profilesMissing: string[];
    outlierCount: number;
    newVideoCount: number;
    totalFollowerDelta: number | null;
    profiles: Array<{
        username: string;
        followers: number;
        followersDelta: number | null;
        newVideos: number;
        outliers: number;
        topVideoUrl: string | null;
    }>;
}
