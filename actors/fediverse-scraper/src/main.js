/**
 * Fediverse Scraper -- Mastodon + Bluesky, official public APIs only.
 *
 * Entry point: read input, parse every target, scrape them with bounded concurrency,
 * and push normalised rows. No credentials are accepted and none are needed: every
 * endpoint used serves anonymous requests.
 */

import { Actor, log } from 'apify';

import { normaliseInput, InputError } from './input.js';
import { parseTarget, describeTarget, TargetError } from './targets.js';
import { RateLimiter } from './http.js';
import { MastodonClient } from './mastodon.js';
import { BlueskyClient } from './bluesky.js';
import { RowSink, EVENT_PROFILE, EVENT_POST, decideCharging } from './sink.js';
import { scrapeTarget, pool } from './scrape.js';

/** Identifies us to every server we call, with somewhere to complain to. */
const USER_AGENT = 'ApifyFediverseScraper/1.0 (+https://apify.com/astraedus/fediverse-scraper)';

await Actor.init();

try {
    const input = normaliseInput(await Actor.getInput());

    // Parse everything up front so a typo in target #9 is reported before we spend
    // twenty minutes scraping targets #1-8.
    const parsed = [];
    const rejected = [];
    for (const raw of input.targets) {
        try {
            parsed.push(parseTarget(raw, { defaultMastodonInstance: input.defaultMastodonInstance }));
        } catch (error) {
            if (!(error instanceof TargetError)) throw error;
            rejected.push({ target: raw, reason: error.message, supported: error.supported });
            log.warning(`Skipping target "${raw}": ${error.message}`);
        }
    }
    if (parsed.length === 0) {
        throw new InputError(
            `None of the ${input.targets.length} target(s) could be parsed. First problem: ${rejected[0]?.reason}`,
        );
    }

    const limiter = new RateLimiter();
    const clients = {
        mastodon: new MastodonClient({ limiter, userAgent: USER_AGENT, log }),
        bluesky: new BlueskyClient({ limiter, userAgent: USER_AGENT, log }),
    };

    // Ask the platform once whether this run should bill, rather than inferring it from a
    // failed push later. That keeps every push error a real error instead of something
    // that could quietly turn the rest of the run into free delivery.
    let pricingInfo = null;
    try {
        pricingInfo = Actor.getChargingManager().getPricingInfo();
    } catch (error) {
        log.warning(`Could not read pricing info (${error.message}); this run will not charge.`);
    }
    const { charge, reason } = decideCharging(pricingInfo, { isAtHome: Actor.isAtHome() });
    log.info(`Charging ${charge ? 'enabled' : 'disabled'}: ${reason}.`);

    const sink = new RowSink({
        pushData: (rows, eventName) => (eventName
            ? Actor.pushData(rows, eventName)
            : Actor.pushData(rows)),
        log,
        charge,
    });

    // Counted as they happen rather than derived: a subtraction over mixed categories
    // (targets that never parsed vs targets that failed while scraping) gets this wrong.
    const scrapeFailures = [];
    let succeeded = 0;
    log.info(`Scraping ${parsed.length} target(s) in mode "${input.mode}" (max ${input.maxPostsPerTarget} posts each).`);

    await pool(parsed, input.maxConcurrency, async (target) => {
        if (sink.limitReached) return;
        try {
            await scrapeTarget(target, {
                clients,
                input,
                sinceMs: input.sinceMs,
                emit: (row) => sink.emit(row),
                log,
            });
            succeeded += 1;
        } catch (error) {
            // One dead handle must not lose the other nineteen targets' data.
            scrapeFailures.push({ target: target.raw, reason: error.message });
            log.exception(error, `Target failed: ${describeTarget(target)}`);
        }
    });

    await sink.flushAll();

    const problems = [
        ...rejected.map((entry) => ({ ...entry, stage: entry.supported ? 'parse' : 'unsupported' })),
        ...scrapeFailures.map((entry) => ({ ...entry, stage: 'scrape' })),
    ];

    await Actor.setValue('RUN_SUMMARY', {
        targetsRequested: input.targets.length,
        targetsParsed: parsed.length,
        targetsSucceeded: succeeded,
        targetsFailed: problems.length,
        profiles: sink.counts[EVENT_PROFILE],
        posts: sink.counts[EVENT_POST],
        duplicatesSkipped: sink.duplicates,
        chargeLimitReached: sink.limitReached,
        failures: problems,
    });

    const summary = `Done: ${sink.counts[EVENT_PROFILE]} profile(s), ${sink.counts[EVENT_POST]} post(s)`
        + `${sink.duplicates ? `, ${sink.duplicates} duplicate(s) skipped` : ''}`
        + `${problems.length ? `, ${problems.length} of ${input.targets.length} target(s) failed` : ''}.`;
    log.info(summary);
    await Actor.setStatusMessage(summary);

    // Every target failing is a run failure; some failing is a partial success worth keeping.
    if (sink.total === 0 && problems.length > 0) {
        throw new Error(`No data collected. First failure: ${problems[0].reason}`);
    }
} catch (error) {
    if (error instanceof InputError) {
        log.error(error.message);
        await Actor.fail(error.message);
    } else {
        throw error;
    }
}

await Actor.exit();
