import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RowSink, EVENT_POST, EVENT_PROFILE, decideCharging, eventNameForRow, rowKey } from '../src/sink.js';
import { pool } from '../src/scrape.js';

const noopLog = { info() {}, warning() {}, error() {}, exception() {} };

const row = (id, type = 'post', platform = 'mastodon') => ({ platform, type, id });

/** Records every push, optionally reporting the charge limit after N rows. */
function recorder({ limitAfter = Infinity } = {}) {
    const pushes = [];
    let charged = 0;
    const pushData = async (rows, eventName) => {
        pushes.push({ rows, eventName });
        if (eventName) charged += rows.length;
        return { eventChargeLimitReached: charged >= limitAfter };
    };
    return { pushData, pushes, get charged() { return charged; } };
}

describe('event naming', () => {
    test('profile rows and post rows bill different events', () => {
        assert.equal(eventNameForRow(row('1', 'profile')), EVENT_PROFILE);
        assert.equal(eventNameForRow(row('1', 'post')), EVENT_POST);
    });

    test('the row key spans platform, type and id', () => {
        assert.notEqual(rowKey(row('1', 'post', 'mastodon')), rowKey(row('1', 'post', 'bluesky')));
        assert.notEqual(rowKey(row('1', 'post')), rowKey(row('1', 'profile')));
    });
});

describe('RowSink de-duplication', () => {
    test('the same row reached via two targets is stored and billed once', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 10 });

        assert.equal(await sink.emit(row('1')), true);
        assert.equal(await sink.emit(row('1')), false, 'duplicate is refused');
        await sink.flushAll();

        assert.equal(pushes.flatMap((p) => p.rows).length, 1);
        assert.equal(sink.duplicates, 1);
        assert.equal(sink.counts[EVENT_POST], 1);
    });

    test('the same id on different platforms is not a duplicate', async () => {
        const { pushData } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 10 });
        assert.equal(await sink.emit(row('1', 'post', 'mastodon')), true);
        assert.equal(await sink.emit(row('1', 'post', 'bluesky')), true);
        assert.equal(sink.duplicates, 0);
    });
});

describe('RowSink batching and charging', () => {
    test('rows are batched and each batch is charged under its own event name', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 2 });

        for (const id of ['1', '2', '3']) await sink.emit(row(id));
        await sink.emit(row('p1', 'profile'));
        await sink.flushAll();

        const byEvent = new Map(pushes.map((p) => [p.eventName, p]));
        assert.ok(byEvent.has(EVENT_POST) && byEvent.has(EVENT_PROFILE));
        for (const push of pushes) {
            assert.ok(push.eventName, 'every push carries an event name so nothing ships unbilled');
        }
        assert.equal(sink.counts[EVENT_POST], 3);
        assert.equal(sink.counts[EVENT_PROFILE], 1);
        assert.equal(sink.total, 4);
    });

    test('a full batch flushes without waiting for flushAll', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 2 });
        await sink.emit(row('1'));
        assert.equal(pushes.length, 0, 'still buffered');
        await sink.emit(row('2'));
        assert.equal(pushes.length, 1, 'flushed at the batch size');
    });

    test('flushAll is safe to call when nothing is buffered', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog });
        await sink.flushAll();
        await sink.flushAll();
        assert.equal(pushes.length, 0);
    });

    test('nothing is ever stored without being counted', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 3 });
        for (let i = 0; i < 7; i += 1) await sink.emit(row(String(i)));
        await sink.flushAll();
        assert.equal(pushes.flatMap((p) => p.rows).length, sink.total);
    });

    test('charge: false stores rows without an event name', async () => {
        const { pushData, pushes } = recorder();
        const sink = new RowSink({ pushData, log: noopLog, charge: false, batchSize: 10 });
        await sink.emit(row('1'));
        await sink.flushAll();
        assert.equal(pushes[0].eventName, undefined);
        assert.equal(sink.counts[EVENT_POST], 1, 'still counted, just not billed');
    });
});

describe('RowSink spending limit', () => {
    test('emitting stops once the user\'s charge limit is reached', async () => {
        const { pushData } = recorder({ limitAfter: 2 });
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 2 });

        await sink.emit(row('1'));
        await sink.emit(row('2'));
        assert.equal(sink.limitReached, true);
        assert.equal(await sink.emit(row('3')), false, 'further rows are refused, not silently billed');
    });

    test('the limit flag is visible to callers so they can stop scraping', async () => {
        const { pushData } = recorder({ limitAfter: 1 });
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 1 });
        assert.equal(sink.limitReached, false);
        await sink.emit(row('1'));
        assert.equal(sink.limitReached, true);
    });
});

describe('decideCharging: billing is settled up front, never inferred from a failure', () => {
    const ppe = {
        isPayPerEvent: true,
        perEventPrices: { [EVENT_PROFILE]: 0.002, [EVENT_POST]: 0.001 },
    };

    test('charges when the Actor is pay-per-event with both events priced', () => {
        assert.equal(decideCharging(ppe, { isAtHome: true }).charge, true);
    });

    test('never charges on a local run', () => {
        const { charge, reason } = decideCharging(ppe, { isAtHome: false });
        assert.equal(charge, false);
        assert.match(reason, /locally/i);
    });

    test('does not charge when the Actor is not pay-per-event yet', () => {
        // The state right after `apify push` and before the Console wizard is completed.
        const { charge, reason } = decideCharging({ isPayPerEvent: false }, { isAtHome: true });
        assert.equal(charge, false);
        assert.match(reason, /not configured pay-per-event/i);
    });

    test('does not charge when an event name is missing from the pricing', () => {
        // Charging an unconfigured event is an error, so refusing to try is the safe move.
        const partial = { isPayPerEvent: true, perEventPrices: { [EVENT_POST]: 0.001 } };
        const { charge, reason } = decideCharging(partial, { isAtHome: true });
        assert.equal(charge, false);
        assert.match(reason, new RegExp(EVENT_PROFILE));
    });

    test('does not charge when pricing info could not be read at all', () => {
        assert.equal(decideCharging(null, { isAtHome: true }).charge, false);
        assert.equal(decideCharging(undefined, { isAtHome: true }).charge, false);
    });
});

describe('RowSink never downgrades billing because of a failed push', () => {
    test('a transient push error is retried, still charged, and never re-pushed uncharged', async () => {
        // Regression: any error used to be read as "not monetized", which silently turned
        // the rest of the run into free delivery and re-pushed rows that may already
        // have been stored.
        let calls = 0;
        const pushes = [];
        const pushData = async (rows, eventName) => {
            calls += 1;
            if (calls === 1) throw new Error('socket hang up');
            pushes.push({ rows, eventName });
            return {};
        };
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 1, retryBaseMs: 1 });

        await sink.emit(row('1'));
        await sink.flushAll();

        assert.equal(sink.charge, true, 'charging is still on after a transient failure');
        assert.equal(pushes.length, 1, 'stored exactly once');
        assert.equal(pushes[0].eventName, EVENT_POST, 'and still charged');
        assert.equal(sink.total, 1);
    });

    test('a persistently failing push fails the run rather than giving data away', async () => {
        const pushData = async () => { throw new Error('upstream down'); };
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 1, retryBaseMs: 1 });

        await assert.rejects(() => sink.emit(row('1')), /Failed to store/);
        assert.equal(sink.total, 0, 'nothing is counted as delivered');
    });

    test('rows are never re-pushed without an event name after a charged attempt', async () => {
        const attempts = [];
        let calls = 0;
        const pushData = async (rows, eventName) => {
            attempts.push(eventName);
            calls += 1;
            if (calls < 3) throw new Error('flaky');
            return {};
        };
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 1, retryBaseMs: 1 });
        await sink.emit(row('1'));
        await sink.flushAll();

        assert.equal(attempts.length, 3);
        for (const eventName of attempts) {
            assert.equal(eventName, EVENT_POST, 'every attempt stayed on the charged path');
        }
    });
});

describe('pool', () => {
    test('runs every item exactly once', async () => {
        const seen = [];
        await pool([1, 2, 3, 4, 5], 2, async (item) => { seen.push(item); });
        assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
    });

    test('never exceeds the requested concurrency', async () => {
        let active = 0;
        let peak = 0;
        await pool(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
            active += 1;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active -= 1;
        });
        assert.ok(peak <= 3, `peak concurrency was ${peak}`);
    });

    test('an empty list is a no-op rather than a hang', async () => {
        await pool([], 4, async () => { throw new Error('should not run'); });
    });

    test('concurrency larger than the item count does not spawn idle runners', async () => {
        const seen = [];
        await pool([1], 10, async (item) => { seen.push(item); });
        assert.deepEqual(seen, [1]);
    });
});
