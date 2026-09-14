/**
 * The webhook is the one place a user's own URL becomes an outbound connection
 * from inside Apify's network, so these tests assert the guard is WIRED, not
 * merely present: refused at input time, refused again at delivery time, and a
 * refusal that never takes the run down with it.
 *
 * The exhaustive address matrix lives in test/safe-url.test.ts.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { UnsafeUrlError } from '../src/safe-url.ts';
import { postWebhook, validateWebhookUrl } from '../src/webhook.ts';

const HOSTILE = [
    'http://0xa9.0xfe.0xa9.0xfe/hook',
    'http://0251.0376.0251.0376/hook',
    'http://127.1/hook',
    'http://0177.0.1/hook',
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/hook',
    'http://[::1]/hook',
    'http://localhost/hook',
    'http://vault.internal/hook',
    'https://user:pass@hooks.example.com/hook',
    'https://hooks.example.com:9200/hook',
];

test('validateWebhookUrl refuses anything pointing inside the network', () => {
    for (const hostile of HOSTILE) {
        assert.throws(() => validateWebhookUrl(hostile), UnsafeUrlError, `${hostile} must be refused`);
    }
    assert.equal(validateWebhookUrl('https://hooks.example.com/x'), 'https://hooks.example.com/x');
});

test('postWebhook refuses an unsafe URL without connecting, and without failing the run', async () => {
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
    }) as typeof fetch;

    try {
        for (const hostile of HOSTILE) {
            // Returns false rather than throwing: the data is already in the
            // dataset and already charged, so a bad webhook must not fail the run.
            assert.equal(await postWebhook(hostile, { hello: 'world' }), false, hostile);
        }
        assert.equal(calls, 0, 'no unsafe URL may ever be requested');

        assert.equal(await postWebhook('https://hooks.example.com/x', { hello: 'world' }), true);
        assert.equal(calls, 1);
    } finally {
        globalThis.fetch = original;
    }
});

test('postWebhook refuses a redirect onto a private address, and still does not fail the run', async () => {
    const original = globalThis.fetch;
    const requested: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
        requested.push(String(input));
        return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
    }) as typeof fetch;

    try {
        assert.equal(await postWebhook('https://hooks.example.com/x', { hello: 'world' }), false);
        assert.deepEqual(requested, ['https://hooks.example.com/x'], 'the metadata hop must never be requested');
    } finally {
        globalThis.fetch = original;
    }
});
