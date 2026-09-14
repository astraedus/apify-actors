import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { buildReport, buildSnapshot } from '../src/analytics.ts';
import { normalizeItems } from '../src/normalize.ts';
import { buildSummary } from '../src/summary.ts';
import type { ProfileReport } from '../src/types.ts';

const FIXTURE: unknown[] = JSON.parse(
    readFileSync(new URL('./fixtures/clockworks-items.json', import.meta.url), 'utf8'),
);
const REQUESTED = ['tiktok', 'khaby.lame'];

const META = {
    runStartedAt: '2026-09-14T00:00:00.000Z',
    finishedAt: '2026-09-14T00:01:00.000Z',
    profilesRequested: 2,
    profilesMissing: [] as string[],
};

function reportsFor(previousRun: boolean): ProfileReport[] {
    const { profiles } = normalizeItems(FIXTURE, REQUESTED);

    return profiles.map((profile) => {
        const previous = previousRun
            ? buildSnapshot(
                { ...profile, followers: profile.followers - 1000, videos: profile.videos.slice(0, 1) },
                '2026-09-13T00:00:00.000Z',
            )
            : null;

        return buildReport(profile, previous, {
            snapshotAt: '2026-09-14T00:00:00.000Z',
            outlierMultiplier: 3,
        });
    });
}

describe('buildSummary', () => {
    it('counts profiles, new videos and outliers across the batch', () => {
        const summary = buildSummary(reportsFor(true), META);

        assert.equal(summary.profilesMonitored, 2);
        assert.equal(summary.profilesRequested, 2);
        assert.equal(summary.newVideoCount, 4, 'two profiles each gained two videos vs the 1-video baseline');
        assert.equal(summary.outlierCount, 1, 'only the 900k tiktok video clears 3x its median');
    });

    it('sums follower deltas when there is a baseline', () => {
        const summary = buildSummary(reportsFor(true), META);

        assert.equal(summary.totalFollowerDelta, 2000);
    });

    it('reports totalFollowerDelta as null on a first run, not 0', () => {
        // "We could not measure growth" must not look like "growth was zero" to
        // an alerting rule downstream.
        const summary = buildSummary(reportsFor(false), META);

        assert.equal(summary.totalFollowerDelta, null);
    });

    it('carries missing profiles through so a webhook can alert on them', () => {
        const summary = buildSummary(reportsFor(true), { ...META, profilesMissing: ['ghost'], profilesRequested: 3 });

        assert.deepEqual(summary.profilesMissing, ['ghost']);
        assert.equal(summary.profilesMonitored, 2);
        assert.equal(summary.profilesRequested, 3);
    });

    it('includes one compact row per profile with the link worth clicking', () => {
        const summary = buildSummary(reportsFor(true), META);
        const [first] = summary.profiles;

        assert.deepEqual(Object.keys(first).sort(), [
            'followers',
            'followersDelta',
            'newVideos',
            'outliers',
            'topVideoUrl',
            'username',
        ]);
        assert.match(first.topVideoUrl ?? '', /^https:\/\/www\.tiktok\.com\/@tiktok\/video\//);
    });

    it('stays small enough for a webhook body', () => {
        const summary = buildSummary(reportsFor(true), META);
        const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8');

        assert.ok(bytes < 4096, `summary for 2 profiles should be tiny, was ${bytes} bytes`);
        assert.ok(
            !JSON.stringify(summary).includes('welcome to the app'),
            'video descriptions belong in the dataset, not the webhook payload',
        );
    });

    it('handles an empty batch without throwing', () => {
        const summary = buildSummary([], { ...META, profilesRequested: 0 });

        assert.equal(summary.profilesMonitored, 0);
        assert.equal(summary.totalFollowerDelta, null);
        assert.deepEqual(summary.profiles, []);
    });

    it('is JSON-serialisable, since it is stored as OUTPUT and POSTed', () => {
        const summary = buildSummary(reportsFor(true), META);

        assert.deepEqual(JSON.parse(JSON.stringify(summary)), summary);
    });
});
