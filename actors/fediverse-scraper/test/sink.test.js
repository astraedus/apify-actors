import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { RowSink, EVENT_POST, EVENT_PROFILE, eventNameForRow, rowKey } from '../src/sink.js';
import { pool } from '../src/scrape.js';

const noopLog = { info() {}, warning() {}, error() {}, exception() {} };

const row = (id, type = 'post', platform = 'mastodon') => ({ platform, type, id });

/** Records every push, optionally reporting the charge limit after N rows. */
function recorder({ limitAfter = Infinity, failEventNames = false } = {}) {
    const pushes = [];
    let charged = 0;
    const pushData = async (rows, eventName) => {
        if (failEventNames && eventName) throw new Error('Actor is not monetized');
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

describe('RowSink survives an unmonetized build', () => {
    test('a rejected event name falls back to storing the rows uncharged', async () => {
        // A build pushed before the Console monetization wizard is completed rejects the
        // event name. Losing the data over a billing error would be the worse failure.
        const { pushData, pushes } = recorder({ failEventNames: true });
        const sink = new RowSink({ pushData, log: noopLog, batchSize: 1 });

        await sink.emit(row('1'));
        await sink.emit(row('2'));
        await sink.flushAll();

        assert.equal(sink.charge, false, 'charging disabled after the first failure');
        assert.equal(pushes.length, 2, 'both rows stored');
        assert.equal(sink.total, 2);
        for (const push of pushes) assert.equal(push.eventName, undefined);
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
