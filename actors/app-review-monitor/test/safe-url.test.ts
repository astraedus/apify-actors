/**
 * SSRF guard tests.
 *
 * The interesting cases are the ones that do NOT look like an IP address until
 * the WHATWG URL parser has had them: `0xa9.0xfe.0xa9.0xfe`, `0251.0376.0251.0376`,
 * `127.1` and `0177.0.1` are all perfectly ordinary strings that become
 * 169.254.169.254 / 127.0.0.1 at `new URL()` time — which is after a naive
 * string check and before `fetch()` opens the socket. Second class: a public
 * host that 3xx's the request onto a private address.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
    MAX_REDIRECT_HOPS,
    UnsafeUrlError,
    assertSafeOutboundUrl,
    nonStandardPortAllowed,
    parseIpv4,
    safeFetch,
} from '../src/safe-url.ts';

const refuses = (url: string, why: string): void => {
    assert.throws(
        () => assertSafeOutboundUrl(url, { label: 'webhookUrl' }),
        UnsafeUrlError,
        `${url} should be refused (${why})`,
    );
};

test('alternate IPv4 encodings that only become private after canonicalization', () => {
    // Each of these is what the URL parser turns the string into, which is the
    // whole reason the guard reads `url.hostname` instead of the raw input.
    const aliases: Array<[string, string]> = [
        ['http://0xa9.0xfe.0xa9.0xfe/hook', '169.254.169.254'],
        ['http://0251.0376.0251.0376/hook', '169.254.169.254'],
        ['http://127.1/hook', '127.0.0.1'],
        ['http://0177.0.1/hook', '127.0.0.1'],
        ['http://2130706433/hook', '127.0.0.1'],
        ['http://0x7f000001/hook', '127.0.0.1'],
    ];

    for (const [raw, canonical] of aliases) {
        assert.equal(new URL(raw).hostname, canonical, `${raw} should canonicalize to ${canonical}`);
        refuses(raw, `aliases ${canonical}`);
    }
});

test('the cloud metadata endpoint is refused in every form', () => {
    refuses('http://169.254.169.254/latest/meta-data/iam/security-credentials/', 'metadata IP');
    refuses('http://169.254.170.2/v2/credentials', 'ECS task metadata');
    refuses('http://[::ffff:169.254.169.254]/latest', 'IPv4-mapped metadata IP');
    refuses('http://[0:0:0:0:0:ffff:a9fe:a9fe]/latest', 'IPv4-mapped metadata IP in hex');
});

test('loopback is refused over IPv4 and IPv6', () => {
    refuses('http://127.0.0.1/hook', 'loopback');
    refuses('http://127.0.0.1:8080/hook', 'loopback on a port');
    refuses('http://[::1]/hook', 'IPv6 loopback');
    refuses('http://[0:0:0:0:0:0:0:1]/hook', 'uncompressed IPv6 loopback');
    refuses('http://[::ffff:127.0.0.1]/hook', 'IPv4-mapped loopback');
    refuses('http://[::]/hook', 'the unspecified address');
});

test('private, link-local and reserved ranges are refused', () => {
    for (const host of [
        '10.0.0.1',
        '10.255.255.254',
        '172.16.0.1',
        '172.31.255.254',
        '192.168.1.1',
        '169.254.1.1',
        '100.64.0.1',
        '0.0.0.0',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
    ]) {
        refuses(`http://${host}/hook`, 'private/reserved range');
    }

    refuses('http://[fc00::1]/hook', 'IPv6 unique-local');
    refuses('http://[fd12:3456::1]/hook', 'IPv6 unique-local');
    refuses('http://[fe80::1]/hook', 'IPv6 link-local');
});

test('local and internal hostnames are refused', () => {
    refuses('http://localhost/hook', 'localhost');
    refuses('http://localhost:3000/hook', 'localhost with a port');
    refuses('http://LOCALHOST/hook', 'localhost, uppercase');
    refuses('http://api.localhost/hook', '.localhost suffix');
    refuses('http://printer.local/hook', '.local suffix');
    refuses('http://vault.internal/hook', '.internal suffix');
    refuses('http://box.localdomain/hook', '.localdomain suffix');
    refuses('http://nas.home.arpa/hook', '.home.arpa suffix');
    refuses('http://intranet/hook', 'bare single-label host');
    refuses('http://intranet./hook', 'single-label host with a trailing dot');
});

test('non-http(s) schemes and embedded credentials are refused', () => {
    refuses('ftp://example.com/hook', 'ftp');
    refuses('file:///etc/passwd', 'file');
    refuses('gopher://example.com/hook', 'gopher');
    assert.throws(() => assertSafeOutboundUrl('not-a-url', { label: 'webhookUrl' }), /not a valid URL/);
    assert.throws(() => assertSafeOutboundUrl('ftp://example.com', { label: 'webhookUrl' }), /must be an http\(s\) URL/);
    assert.throws(
        () => assertSafeOutboundUrl('https://user:pass@hooks.example.com/x', { label: 'webhookUrl' }),
        /must not embed credentials/,
    );
    assert.throws(
        () => assertSafeOutboundUrl('https://user@hooks.example.com/x', { label: 'webhookUrl' }),
        /must not embed credentials/,
    );
});

test('a non-standard port needs an explicit opt-in', () => {
    assert.throws(
        () => assertSafeOutboundUrl('https://hooks.example.com:9200/x', { label: 'webhookUrl' }),
        /non-standard port 9200/,
    );
    assert.equal(
        assertSafeOutboundUrl('https://hooks.example.com:9200/x', { allowNonStandardPort: true }).port,
        '9200',
    );
    // The scheme default is dropped by the URL parser, so it is never "a port".
    assert.equal(assertSafeOutboundUrl('https://hooks.example.com:443/x').port, '');
    assert.equal(assertSafeOutboundUrl('http://hooks.example.com:80/x').port, '');

    assert.equal(nonStandardPortAllowed({}), false);
    assert.equal(nonStandardPortAllowed({ ALLOW_NON_STANDARD_WEBHOOK_PORT: '1' }), true);
    assert.equal(nonStandardPortAllowed({ ALLOW_NON_STANDARD_WEBHOOK_PORT: 'true' }), true);
    assert.equal(nonStandardPortAllowed({ ALLOW_NON_STANDARD_WEBHOOK_PORT: '0' }), false);
});

test('a legitimate public webhook URL passes through unchanged', () => {
    const url = assertSafeOutboundUrl('https://hooks.example.com/x', { label: 'webhookUrl' });
    assert.equal(url.href, 'https://hooks.example.com/x');
    assert.equal(url.hostname, 'hooks.example.com');

    // Real endpoints people actually use, plus public IP literals.
    for (const raw of [
        'https://hooks.slack.com/services/T000/B000/XXXX',
        'https://hooks.zapier.com/hooks/catch/123456/abcdef',
        'http://example.co.uk/webhook?token=abc',
        'https://8.8.8.8/hook',
        'https://[2606:4700:4700::1111]/hook',
    ]) {
        assert.doesNotThrow(() => assertSafeOutboundUrl(raw, { label: 'webhookUrl' }), raw);
    }
});

test('parseIpv4 understands every encoding, and rejects non-addresses', () => {
    assert.equal(parseIpv4('127.0.0.1'), 0x7f000001);
    assert.equal(parseIpv4('127.1'), 0x7f000001);
    assert.equal(parseIpv4('0177.0.0.1'), 0x7f000001);
    assert.equal(parseIpv4('0x7f.0.0.1'), 0x7f000001);
    assert.equal(parseIpv4('2130706433'), 0x7f000001);
    assert.equal(parseIpv4('169.254.169.254'), 0xa9fea9fe);
    assert.equal(parseIpv4('hooks.example.com'), null);
    assert.equal(parseIpv4('256.1.1.1'), null);
    assert.equal(parseIpv4('1.2.3.4.5'), null);
    assert.equal(parseIpv4('0x'), 0);
});

// --- safeFetch: redirects are followed by hand, and re-checked ---------------

interface FetchCall {
    url: string;
    method: string;
    redirect: string | undefined;
}

/** Install a scripted fetch, returning the calls it recorded. */
function stubFetch(script: Array<Response | ((url: string) => Response)>): {
    calls: FetchCall[];
    restore: () => void;
} {
    const calls: FetchCall[] = [];
    const original = globalThis.fetch;
    let index = 0;

    globalThis.fetch = (async (input: unknown, init: Record<string, unknown> = {}) => {
        const url = String(input);
        calls.push({
            url,
            method: String(init.method ?? 'GET'),
            redirect: init.redirect === undefined ? undefined : String(init.redirect),
        });
        const step = script[Math.min(index, script.length - 1)];
        index += 1;
        if (step === undefined) throw new Error('fetch stub ran out of scripted responses');
        return typeof step === 'function' ? step(url) : step;
    }) as typeof fetch;

    return { calls, restore: () => { globalThis.fetch = original; } };
}

const redirectTo = (location: string, status = 302): Response =>
    new Response(null, { status, headers: { location } });

test('safeFetch uses manual redirect mode and returns a non-redirect response as-is', async () => {
    const stub = stubFetch([new Response('ok', { status: 200 })]);
    try {
        const response = await safeFetch('https://hooks.example.com/x', { method: 'POST', body: '{}' });
        assert.equal(response.status, 200);
        assert.equal(stub.calls.length, 1);
        assert.equal(stub.calls[0]!.redirect, 'manual', 'redirects must never be followed by fetch itself');
        assert.equal(stub.calls[0]!.method, 'POST');
    } finally {
        stub.restore();
    }
});

test('safeFetch refuses a redirect to a private address, without ever requesting it', async () => {
    for (const hostile of [
        'http://169.254.169.254/latest/meta-data/',
        'http://127.0.0.1:8080/admin',
        'http://0xa9.0xfe.0xa9.0xfe/',
        'http://[::1]/',
        'http://localhost/',
    ]) {
        const stub = stubFetch([redirectTo(hostile)]);
        try {
            await assert.rejects(
                safeFetch('https://hooks.example.com/x', { method: 'POST', body: '{}' }, { label: 'webhookUrl' }),
                UnsafeUrlError,
                `a 302 to ${hostile} must be refused`,
            );
            assert.equal(stub.calls.length, 1, 'the hostile hop must never be requested');
            assert.equal(stub.calls[0]!.url, 'https://hooks.example.com/x');
        } finally {
            stub.restore();
        }
    }
});

test('safeFetch follows a legitimate redirect and re-checks each hop', async () => {
    const stub = stubFetch([
        redirectTo('https://hooks2.example.com/x'),
        redirectTo('/final', 307),
        new Response('delivered', { status: 200 }),
    ]);
    try {
        const response = await safeFetch('https://hooks.example.com/x', { method: 'POST', body: '{}' });
        assert.equal(response.status, 200);
        assert.deepEqual(
            stub.calls.map((c) => c.url),
            ['https://hooks.example.com/x', 'https://hooks2.example.com/x', 'https://hooks2.example.com/final'],
        );
        // 302 on a POST degrades to GET (standard fetch semantics); 307 keeps it.
        assert.deepEqual(stub.calls.map((c) => c.method), ['POST', 'GET', 'GET']);
        assert.ok(stub.calls.every((c) => c.redirect === 'manual'));
    } finally {
        stub.restore();
    }
});

test('safeFetch gives up after MAX_REDIRECT_HOPS hops', async () => {
    // An endless public redirect loop: safe hosts, but it must still terminate.
    let n = 0;
    const stub = stubFetch([() => redirectTo(`https://hooks.example.com/hop${(n += 1)}`)]);
    try {
        await assert.rejects(
            safeFetch('https://hooks.example.com/x', {}, { label: 'webhookUrl' }),
            /redirected more than 3 times/,
        );
        assert.equal(MAX_REDIRECT_HOPS, 3);
        assert.equal(stub.calls.length, MAX_REDIRECT_HOPS + 1);
    } finally {
        stub.restore();
    }
});

test('safeFetch refuses a 3xx with no Location rather than guessing', async () => {
    const stub = stubFetch([new Response(null, { status: 302 })]);
    try {
        await assert.rejects(
            safeFetch('https://hooks.example.com/x', {}, { label: 'webhookUrl' }),
            /no Location header/,
        );
    } finally {
        stub.restore();
    }
});

test('safeFetch refuses an unsafe target before making any request at all', async () => {
    const stub = stubFetch([new Response('ok', { status: 200 })]);
    try {
        await assert.rejects(safeFetch('http://169.254.169.254/', {}, { label: 'webhookUrl' }), UnsafeUrlError);
        assert.equal(stub.calls.length, 0);
    } finally {
        stub.restore();
    }
});

// --- The class of bug, not the instance -------------------------------------

test('GUARD: no source file outside safe-url.ts calls fetch() directly', () => {
    // Discovered from the filesystem, so a new module that adds an unguarded
    // outbound call fails here instead of shipping an SSRF sink.
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const files = readdirSync(srcDir, { recursive: true, encoding: 'utf8' }).filter((f) => f.endsWith('.ts'));
    assert.ok(files.length >= 4, 'source discovery found suspiciously few files');

    /** Strip block comments and whole-line `//` comments; string literals stay intact. */
    const stripComments = (source: string): string =>
        source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .filter((line) => {
                const trimmed = line.trimStart();
                return !trimmed.startsWith('//') && !trimmed.startsWith('*');
            })
            .join('\n');

    const bareFetch = /(?<![\w.$])fetch\s*\(/;
    const offenders: string[] = [];
    let sanctioned = 0;

    for (const file of files) {
        const code = stripComments(readFileSync(`${srcDir}/${file}`, 'utf8'));
        if (!bareFetch.test(code)) continue;
        if (file === 'safe-url.ts') {
            sanctioned += 1;
            continue;
        }
        offenders.push(file);
    }

    // Non-vacuity: if the pattern stopped matching even the one real call site,
    // this test would pass while checking nothing.
    assert.equal(sanctioned, 1, 'safe-url.ts must contain the one sanctioned fetch() call');
    assert.deepEqual(offenders, [], 'these files must use safeFetch() instead of fetch()');
});
