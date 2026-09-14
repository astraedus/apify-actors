/**
 * TikTok Growth Monitor — Apify Actor entry point.
 *
 * Architecture, in one breath: we do NOT scrape TikTok. We call a reliable base
 * scraper ONCE for the whole batch, then add the layer nobody else owns —
 * persistent snapshots, run-over-run deltas, median-relative viral outliers —
 * on top of its raw output.
 *
 * The sub-actor run is started under the END USER's account with their token,
 * so its results and its cost land on their account, not ours. Our pay-per-event
 * fee stacks on top of that. Both halves are spelled out in the README.
 */

import { Actor, log } from 'apify';

import { buildReport, buildSnapshot } from './analytics.ts';
import { baseActorInput, normalizeItems } from './normalize.ts';
import { parseProfiles, snapshotKey } from './parse.ts';
import { ACTOR_NAME, buildSummary } from './summary.ts';
import { postWebhook, validateWebhookUrl } from './webhook.ts';
import type { ProfileReport, ProfileSnapshot } from './types.ts';

/** Charged once per profile we actually produce a report for. This is our margin. */
const EVENT_PROFILE_MONITORED = 'profile-monitored';
/** Free ($0.00) — emitted purely so outlier volume is visible in run billing. */
const EVENT_OUTLIER_ALERT = 'outlier-alert';

const DEFAULTS = {
    videosPerProfile: 20,
    outlierMultiplier: 3,
    snapshotStoreName: 'tiktok-growth-monitor-state',
    baseActor: 'clockworks/tiktok-profile-scraper',
} as const;

/**
 * Used only when the `profiles` key is absent entirely.
 *
 * The input schema carries the same default, but `default` is applied by the
 * platform and `prefill` only populates the Console form — so a programmatic
 * caller (or Apify's daily automated default-input test) can still arrive with
 * `{}`. Failing there would be three strikes to an "Under Maintenance" badge on
 * the store page. An explicitly-supplied-but-empty list still fails, because
 * that is a user mistake and charging for profiles nobody asked for is worse
 * than a clear error.
 */
const DEFAULT_PROFILES = ['tiktok', 'khaby.lame'];

/** How long we let the base scraper run before giving up on it. */
const BASE_ACTOR_TIMEOUT_SECS = 600;

interface Input {
    profiles?: unknown;
    videosPerProfile?: number;
    outlierMultiplier?: number;
    snapshotStoreName?: string;
    webhookUrl?: string;
    baseActor?: string;
}

/** Clamp a user-supplied number into a sane range, falling back to the default. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
    const parsed = typeof value === 'string' ? Number(value) : value;

    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;

    return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function nonEmptyString(value: unknown, fallback: string): string {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * Read every item from the base run's dataset.
 *
 * Paginated explicitly: `listItems` caps a single page, and a 50-profile batch
 * at 100 videos each is 5,000 items — silently reading only the first page
 * would drop most profiles and report them as "missing".
 */
async function readAllItems(datasetId: string): Promise<unknown[]> {
    const client = Actor.apifyClient.dataset(datasetId);
    const items: unknown[] = [];
    const limit = 1000;
    let offset = 0;

    for (;;) {
        const page = await client.listItems({ offset, limit, clean: false });
        items.push(...page.items);

        if (page.items.length < limit) break;
        offset += page.items.length;
    }

    return items;
}

/** Load a profile's previous snapshot, tolerating anything unreadable. */
async function loadSnapshot(
    store: Awaited<ReturnType<typeof Actor.openKeyValueStore>>,
    username: string,
): Promise<ProfileSnapshot | null> {
    try {
        const value = await store.getValue<ProfileSnapshot>(snapshotKey(username));

        // A snapshot written by an older version, or hand-edited, must degrade
        // to "first run" rather than crash a paid run mid-batch.
        if (value === null || typeof value !== 'object') return null;
        if (typeof value.snapshotAt !== 'string' || typeof value.videos !== 'object') return null;

        return { ...value, videos: value.videos ?? {} };
    } catch (error) {
        log.warning(`Could not read the previous snapshot for @${username}; treating this as a first run.`, {
            error: (error as Error).message,
        });
        return null;
    }
}

await Actor.init();

const runStartedAt = new Date().toISOString();
const input = (await Actor.getInput<Input>()) ?? {};

const profilesInput = input.profiles ?? DEFAULT_PROFILES;
if (input.profiles === undefined) {
    log.info(`No "profiles" supplied; using the documented default batch: ${DEFAULT_PROFILES.join(', ')}.`);
}

const { usernames, invalid } = parseProfiles(profilesInput);
const videosPerProfile = clampInt(input.videosPerProfile, DEFAULTS.videosPerProfile, 1, 200);
const outlierMultiplier = clampInt(input.outlierMultiplier, DEFAULTS.outlierMultiplier, 2, 50);
const snapshotStoreName = nonEmptyString(input.snapshotStoreName, DEFAULTS.snapshotStoreName);
const baseActor = nonEmptyString(input.baseActor, DEFAULTS.baseActor);
const webhookUrl = nonEmptyString(input.webhookUrl, '');

if (invalid.length > 0) {
    log.warning(`Ignoring ${invalid.length} unreadable profile entries: ${invalid.join(', ')}`);
}

if (usernames.length === 0) {
    await Actor.fail(
        'No valid TikTok profiles in the input. Provide handles (tiktok), @handles (@tiktok) or profile URLs (https://www.tiktok.com/@tiktok).',
    );
}

// `webhookUrl` is an SSRF sink: whatever goes in it is a host this Actor
// connects to from inside Apify's network. Validate it HERE, before the base
// scraper is called, so an unusable URL costs the user nothing — a run that
// scraped everything and then refused to deliver would still be billed in full.
if (webhookUrl.length > 0) {
    try {
        validateWebhookUrl(webhookUrl);
    } catch (error) {
        await Actor.fail(`${(error as Error).message} Nothing was charged.`);
    }
}

log.info(
    `Monitoring ${usernames.length} profile(s) at up to ${videosPerProfile} videos each, `
    + `flagging videos at >= ${outlierMultiplier}x the profile median.`,
);

// --- 1. One base-actor call for the whole batch -----------------------------
// One call, not one per profile: the base actor bills per result either way,
// but per-profile calls would multiply its fixed startup cost by the batch size.

log.info(`Calling base scraper "${baseActor}" for the whole batch...`);

const baseRun = await Actor.call(
    baseActor,
    baseActorInput(usernames, videosPerProfile),
    {
        timeout: BASE_ACTOR_TIMEOUT_SECS,
        waitSecs: BASE_ACTOR_TIMEOUT_SECS,
        // Hard cost ceiling: the base actor charges per result, so this caps what
        // the user can be billed even if it ignores resultsPerPage. The +1 per
        // profile is headroom for profile-level marker items.
        maxItems: usernames.length * (videosPerProfile + 1),
    },
);

if (baseRun.status !== 'SUCCEEDED') {
    await Actor.fail(
        `The base scraper "${baseActor}" finished with status ${baseRun.status} (run ${baseRun.id}). `
        + 'No profiles were charged. If this persists, the base Actor may be down or your account may be out of credit.',
    );
}

const rawItems = await readAllItems(baseRun.defaultDatasetId);
log.info(`Base scraper returned ${rawItems.length} raw items.`);

// --- 2. Normalize, then add the analytics layer ----------------------------

const { profiles, missing } = normalizeItems(rawItems, usernames);

if (missing.length > 0) {
    log.warning(
        `No data returned for: ${missing.join(', ')}. These are not charged. `
        + 'Usually this means the handle is misspelled, private, or the account was removed.',
    );
}

// A run that succeeds while delivering nothing is the worst failure mode: it
// looks healthy on the dashboard, so a broken base actor or a wholesale field
// rename would go unnoticed for days. Fail loudly instead — nothing is charged.
if (profiles.length === 0) {
    await Actor.fail(
        `The base scraper returned no usable data for any of the ${usernames.length} requested profile(s): `
        + `${usernames.join(', ')}. Nothing was charged. Check the handles are spelled correctly and are public.`,
    );
}

const store = await Actor.openKeyValueStore(snapshotStoreName);
const snapshotAt = new Date().toISOString();
const reports: ProfileReport[] = [];

for (const profile of profiles) {
    const previous = await loadSnapshot(store, profile.username);
    const report = buildReport(profile, previous, { snapshotAt, outlierMultiplier });

    // Charge only for a profile we actually produced a report for, and only
    // once the report exists — never for a profile the base scraper missed.
    const { chargedCount, eventChargeLimitReached } = await Actor.charge({
        eventName: EVENT_PROFILE_MONITORED,
    });

    // Actor.charge() does NOT throw for an event name that was never registered
    // on the platform — it silently charges nothing. Without this canary, a
    // forgotten `npm run apply-store-config` means every run serves paid work
    // for free, and the only symptom is revenue that never arrives.
    if (chargedCount === 0 && Actor.isAtHome() && reports.length === 0) {
        log.warning(
            `Charging "${EVENT_PROFILE_MONITORED}" recorded 0 events. If this Actor is monetized, `
            + 'the event is probably not registered on the platform — run `npm run apply-store-config`.',
        );
    }

    await Actor.pushData(report);
    reports.push(report);

    // Persist AFTER a successful push, so a crash mid-batch leaves the previous
    // snapshot intact and the next run still computes a correct (longer) delta
    // rather than silently comparing against a half-written state.
    await store.setValue(snapshotKey(profile.username), buildSnapshot(profile, snapshotAt));

    if (report.outliers.length > 0) {
        await Actor.charge({ eventName: EVENT_OUTLIER_ALERT, count: report.outliers.length });
        log.info(
            `@${profile.username}: ${report.outliers.length} viral outlier(s), `
            + `top ${report.outliers[0].viewsMultipleOfMedian}x the median.`,
        );
    }

    const growth = report.followersDelta === null
        ? 'baseline run'
        : `${report.followersDelta >= 0 ? '+' : ''}${report.followersDelta} followers`;
    log.info(`@${profile.username}: ${report.followers} followers (${growth}), ${report.newVideos.length} new video(s).`);

    if (eventChargeLimitReached) {
        log.warning('This run reached its maximum charge limit; stopping before the remaining profiles.');
        break;
    }
}

// --- 3. Summary + webhook --------------------------------------------------

const summary = buildSummary(reports, {
    runStartedAt,
    finishedAt: new Date().toISOString(),
    profilesRequested: usernames.length,
    profilesMissing: missing,
});

await Actor.setValue('OUTPUT', summary);

if (webhookUrl.length > 0) {
    await postWebhook(webhookUrl, summary);
}

log.info(
    `${ACTOR_NAME} done: ${summary.profilesMonitored}/${summary.profilesRequested} profiles monitored, `
    + `${summary.newVideoCount} new video(s), ${summary.outlierCount} outlier(s).`,
);

await Actor.exit();
