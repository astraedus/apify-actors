import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    assertPublicHost,
    assertPublicHttpUrl,
    canonicalHostname,
    isPublicHostname,
    UnsafeHostError,
} from '../src/hosts.js';
import { parseTarget, TargetError } from '../src/targets.js';
import { normaliseInput, parseInstance, InputError } from '../src/input.js';

/**
 * Alternate encodings of the two addresses that matter: the cloud metadata endpoint and
 * loopback. Every one of these is canonicalised by `new URL()` into a real address, which
 * is exactly why a denylist run against the raw string does not stop them.
 */
const ENCODED_METADATA = [
    ['169.254.169.254', 'dotted decimal'],
    ['0xa9.0xfe.0xa9.0xfe', 'hex per octet'],
    ['0251.0376.0251.0376', 'octal per octet'],
    ['0xa9fea9fe', 'single hex'],
    ['2852039166', 'decimal shorthand'],
];

const ENCODED_LOOPBACK = [
    ['127.0.0.1', 'dotted decimal'],
    ['127.1', 'two-part shorthand'],
    ['0177.0.0.1', 'octal first octet'],
    ['0x7f.0.0.1', 'hex first octet'],
    ['2130706433', 'decimal shorthand'],
];

describe('canonicalHostname collapses every IPv4 encoding', () => {
    for (const [input, label] of ENCODED_METADATA) {
        test(`metadata address as ${label} canonicalises to 169.254.169.254`, () => {
            assert.equal(canonicalHostname(input), '169.254.169.254');
        });
    }

    for (const [input, label] of ENCODED_LOOPBACK) {
        test(`loopback as ${label} canonicalises to 127.0.0.1`, () => {
            assert.equal(canonicalHostname(input), '127.0.0.1');
        });
    }

    test('a normal host survives unchanged, lowercased', () => {
        assert.equal(canonicalHostname('Mastodon.Social'), 'mastodon.social');
    });

    test('anything carrying URL structure is refused', () => {
        for (const input of ['host.com/path', 'host.com?q=1', 'host.com#f', 'a@host.com', 'host .com', '']) {
            assert.equal(canonicalHostname(input), null, input);
        }
    });

    test('a port or userinfo is refused rather than silently dropped', () => {
        assert.equal(canonicalHostname('host.com:8080'), null);
        assert.equal(canonicalHostname('user:pw@host.com'), null);
    });
});

describe('isPublicHostname', () => {
    test('rejects every canonicalised private, loopback and link-local address', () => {
        for (const host of ['169.254.169.254', '127.0.0.1', '10.0.0.1', '192.168.1.1',
            '172.16.0.1', '0.0.0.0', '100.64.0.1', '8.8.8.8']) {
            assert.equal(isPublicHostname(host), false, `${host} must be refused`);
        }
    });

    test('rejects IPv6 literals', () => {
        for (const host of ['::1', '[::1]', 'fd00::1', '[fe80::1]']) {
            assert.equal(isPublicHostname(host), false, host);
        }
    });

    test('rejects internal names and single-label hosts', () => {
        for (const host of ['localhost', 'db.internal', 'printer.local', 'box.lan',
            'app.corp', 'wiki.intranet', 'host', 'a.localdomain']) {
            assert.equal(isPublicHostname(host), false, host);
        }
    });

    test('accepts ordinary public instances', () => {
        for (const host of ['mastodon.social', 'fosstodon.org', 'hachyderm.io',
            'social.example.co.uk', 'xn--80ak6aa92e.com']) {
            assert.equal(isPublicHostname(host), true, host);
        }
    });

    test('a trailing dot does not smuggle a host past the suffix check', () => {
        assert.equal(isPublicHostname('db.internal.'), false);
    });
});

describe('assertPublicHttpUrl is the choke point before every request', () => {
    test('rejects an encoded metadata address in a URL', () => {
        for (const [host, label] of ENCODED_METADATA) {
            assert.throws(
                () => assertPublicHttpUrl(`https://${host}/api/v1/accounts/lookup`),
                UnsafeHostError,
                label,
            );
        }
    });

    test('rejects non-HTTP schemes and embedded credentials', () => {
        assert.throws(() => assertPublicHttpUrl('file:///etc/passwd'), UnsafeHostError);
        assert.throws(() => assertPublicHttpUrl('ftp://example.com/x'), UnsafeHostError);
        assert.throws(() => assertPublicHttpUrl('https://user:pw@example.com/x'), UnsafeHostError);
    });

    test('rejects a malformed URL', () => {
        assert.throws(() => assertPublicHttpUrl('not a url'), UnsafeHostError);
    });

    test('allows a normal instance URL and returns the parsed URL', () => {
        const url = assertPublicHttpUrl('https://mastodon.social/api/v1/statuses/1');
        assert.equal(url.hostname, 'mastodon.social');
    });

    test('an explicit port is allowed on a public host but never on a private one', () => {
        assert.throws(() => assertPublicHttpUrl('https://127.0.0.1:8080/x'), UnsafeHostError);
    });
});

describe('assertPublicHost', () => {
    test('returns the canonical host for a good instance', () => {
        assert.equal(assertPublicHost('Mastodon.Social'), 'mastodon.social');
    });

    test('names the canonical address in the error, so the log explains the refusal', () => {
        let message = '';
        try {
            assertPublicHost('0xa9.0xfe.0xa9.0xfe');
        } catch (error) {
            message = error.message;
        }
        assert.match(message, /169\.254\.169\.254/);
    });
});

describe('no target form can reach a private address, in any encoding', () => {
    // Regression: these all parsed successfully before the canonical check existed, and
    // each produced a real request to cloud metadata or loopback.
    const forms = (host) => [
        `@user@${host}`,
        `user@${host}`,
        `#tag@${host}`,
        `mastodon:@user@${host}`,
        `https://${host}/@user`,
        `https://${host}/tags/x`,
        `https://${host}/@user/123`,
    ];

    for (const [host, label] of [...ENCODED_METADATA, ...ENCODED_LOOPBACK]) {
        for (const form of forms(host)) {
            test(`rejects ${form} (${label})`, () => {
                assert.throws(() => parseTarget(form), TargetError, form);
            });
        }
    }

    test('internal-suffix hosts are refused in every form too', () => {
        for (const host of ['db.internal', 'box.local', 'thing.lan']) {
            for (const form of forms(host)) {
                assert.throws(() => parseTarget(form), TargetError, form);
            }
        }
    });

    test('a legitimate instance still parses in every form', () => {
        for (const form of forms('fosstodon.org')) {
            assert.doesNotThrow(() => parseTarget(form), form);
        }
    });
});

describe('defaultMastodonInstance is validated like any other host', () => {
    // It becomes the host of a real request for bare targets, so it is a second door
    // to the same SSRF if left unchecked.
    for (const [host, label] of [...ENCODED_METADATA, ...ENCODED_LOOPBACK]) {
        test(`rejects ${host} (${label})`, () => {
            assert.throws(() => parseInstance(host), InputError);
            assert.throws(() => normaliseInput({ defaultMastodonInstance: host }), InputError);
        });
    }

    test('rejects internal names', () => {
        assert.throws(() => normaliseInput({ defaultMastodonInstance: 'db.internal' }), InputError);
        assert.throws(() => normaliseInput({ defaultMastodonInstance: 'localhost' }), InputError);
    });

    test('still accepts and normalises a real instance, including a pasted URL', () => {
        assert.equal(parseInstance('https://Fosstodon.org/about'), 'fosstodon.org');
        assert.equal(parseInstance(''), 'mastodon.social');
        assert.equal(parseInstance(undefined), 'mastodon.social');
    });
});
