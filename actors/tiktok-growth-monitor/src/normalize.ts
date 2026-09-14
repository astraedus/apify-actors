/**
 * The adapter between the base scraper's raw dataset items and our domain types.
 *
 * This is the ONLY file that knows the base actor's field names. Clockworks
 * emits one item per VIDEO, with the profile's own counters repeated inside a
 * nested `authorMeta` on every item, so normalizing means grouping by author and
 * folding the repeated profile stats down to one record.
 *
 * Everything here is defensive: a missing counter becomes 0, never `undefined`
 * and never `NaN`. A single `NaN` leaking into a snapshot would poison every
 * delta computed from it on every subsequent run.
 */

import { parseUsername } from './parse.ts';
import type { ProfileStat, VideoStat } from './types.ts';

/** Coerce an unknown counter to a finite non-negative integer. */
function num(value: unknown): number {
    const parsed = typeof value === 'string' ? Number(value) : value;

    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return 0;

    return Math.max(0, Math.trunc(parsed));
}

/** Coerce an unknown field to a trimmed string, or '' when absent. */
function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** Coerce to a non-empty string, or null. */
function strOrNull(value: unknown): string | null {
    const text = str(value);

    return text.length > 0 ? text : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Work out which profile a raw item belongs to.
 *
 * `authorMeta.name` is the handle on a healthy item, but empty-profile and
 * error markers sometimes carry only a URL or the input echo, so we fall back
 * through every field that can identify the author before giving up.
 */
export function itemUsername(item: Record<string, unknown>): string | null {
    const author = isRecord(item.authorMeta) ? item.authorMeta : {};

    const candidates: unknown[] = [
        author.name,
        author.uniqueId,
        author.profileUrl,
        item.authorUsername,
        item.input,
        item.webVideoUrl,
    ];

    for (const candidate of candidates) {
        const username = parseUsername(candidate);
        if (username !== null) return username;
    }

    return null;
}

/**
 * Pull one video out of a raw item, or null when the item carries no video
 * (Clockworks emits a bare marker item for a profile that exists but has no
 * posts, and an error item for one that could not be reached).
 */
export function toVideoStat(item: Record<string, unknown>): VideoStat | null {
    const id = str(item.id);
    if (id.length === 0) return null;

    const music = isRecord(item.musicMeta) ? item.musicMeta : {};
    const username = itemUsername(item);

    return {
        id,
        url: strOrNull(item.webVideoUrl)
            ?? (username ? `https://www.tiktok.com/@${username}/video/${id}` : ''),
        createdAt: strOrNull(item.createTimeISO),
        views: num(item.playCount),
        likes: num(item.diggCount),
        comments: num(item.commentCount),
        shares: num(item.shareCount),
        description: str(item.text),
        sound: strOrNull(music.musicName),
    };
}

/** Fold the profile-level counters repeated on every item down to one record. */
function toProfileStat(username: string, item: Record<string, unknown>): ProfileStat {
    const author = isRecord(item.authorMeta) ? item.authorMeta : {};

    return {
        username,
        nickname: strOrNull(author.nickName),
        verified: author.verified === true,
        followers: num(author.fans),
        following: num(author.following),
        likes: num(author.heart),
        videoCount: num(author.video),
        videos: [],
    };
}

export interface NormalizeResult {
    /** One record per profile that returned data, in requested order. */
    profiles: ProfileStat[];
    /** Requested profiles the base actor returned nothing usable for. */
    missing: string[];
}

/**
 * Group the base actor's flat item list into per-profile records.
 *
 * `requested` fixes the output order and lets us report which profiles came
 * back empty — important, because we only charge for profiles we actually
 * monitored, and a silently-dropped profile would otherwise look like a
 * zero-growth profile rather than a failure.
 */
export function normalizeItems(items: unknown[], requested: string[]): NormalizeResult {
    const byUsername = new Map<string, ProfileStat>();
    const requestedSet = new Set(requested);

    for (const raw of items) {
        if (!isRecord(raw)) continue;

        const username = itemUsername(raw);
        if (username === null) continue;

        // Ignore anything the caller did not ask for: a profile's item can
        // reference a reposted video whose author is somebody else entirely.
        if (!requestedSet.has(username)) continue;

        let profile = byUsername.get(username);
        if (profile === undefined) {
            profile = toProfileStat(username, raw);
            byUsername.set(username, profile);
        } else if (profile.followers === 0 && num(getAuthor(raw).fans) > 0) {
            // The first item for a profile can be a sparse marker; adopt the
            // richer counters as soon as a real item shows up.
            Object.assign(profile, toProfileStat(username, raw), { videos: profile.videos });
        }

        const video = toVideoStat(raw);
        if (video !== null && !profile.videos.some((existing) => existing.id === video.id)) {
            profile.videos.push(video);
        }
    }

    const profiles: ProfileStat[] = [];
    const missing: string[] = [];

    for (const username of requested) {
        const profile = byUsername.get(username);
        if (profile === undefined) {
            missing.push(username);
            continue;
        }
        profiles.push(profile);
    }

    return { profiles, missing };
}

function getAuthor(item: Record<string, unknown>): Record<string, unknown> {
    return isRecord(item.authorMeta) ? item.authorMeta : {};
}

/** Build the input object for the base scraper. */
export function baseActorInput(usernames: string[], videosPerProfile: number): Record<string, unknown> {
    return {
        profiles: usernames,
        resultsPerPage: videosPerProfile,
        profileSorting: 'latest',
        excludePinnedPosts: false,
        // Media downloads are separately charged add-ons at the base actor and
        // we never use the files, so they stay off.
        shouldDownloadVideos: false,
        shouldDownloadCovers: false,
        shouldDownloadSlideshowImages: false,
        shouldDownloadAvatars: false,
        shouldDownloadSubtitles: false,
    };
}
