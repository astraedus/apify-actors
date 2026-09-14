/**
 * The compact run summary: what gets written to the default key-value store as
 * OUTPUT and POSTed to the user's webhook.
 *
 * Deliberately small. A webhook payload carrying every video of every profile
 * would blow past Slack's and Make's body limits on a 50-profile schedule, so
 * this carries counts and the one link worth clicking, not the dataset.
 */

import type { ProfileReport, RunSummary } from './types.ts';

export const ACTOR_NAME = 'tiktok-growth-monitor';

export interface SummaryMeta {
    runStartedAt: string;
    finishedAt: string;
    profilesRequested: number;
    profilesMissing: string[];
}

export function buildSummary(reports: ProfileReport[], meta: SummaryMeta): RunSummary {
    const followerDeltas = reports
        .map((report) => report.followersDelta)
        .filter((delta): delta is number => delta !== null);

    return {
        actor: ACTOR_NAME,
        runStartedAt: meta.runStartedAt,
        finishedAt: meta.finishedAt,
        profilesRequested: meta.profilesRequested,
        profilesMonitored: reports.length,
        profilesMissing: meta.profilesMissing,
        outlierCount: reports.reduce((total, report) => total + report.outliers.length, 0),
        newVideoCount: reports.reduce((total, report) => total + report.newVideos.length, 0),
        // null, not 0, on a first run: "we could not measure growth" and "growth
        // was exactly zero" must not look the same to an alerting rule.
        totalFollowerDelta: followerDeltas.length === 0
            ? null
            : followerDeltas.reduce((total, delta) => total + delta, 0),
        profiles: reports.map((report) => ({
            username: report.username,
            followers: report.followers,
            followersDelta: report.followersDelta,
            newVideos: report.newVideos.length,
            outliers: report.outliers.length,
            topVideoUrl: report.topVideo?.url ?? null,
        })),
    };
}
