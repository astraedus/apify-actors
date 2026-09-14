import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { parseTarget, describeTarget, TargetError } from '../src/targets.js';

/** assert.throws() returns undefined, so capture the error when we need to inspect it. */
function catchError(fn) {
    try {
        fn();
    } catch (error) {
        return error;
    }
    return assert.fail('expected the call to throw, but it returned normally');
}

/** Compact assertion helper: parse and check the fields that matter for a form. */
function expectTarget(input, expected, options) {
    const actual = parseTarget(input, options);
    for (const [key, value] of Object.entries(expected)) {
        assert.equal(actual[key], value, `${JSON.stringify(input)} -> ${key}`);
    }
    assert.equal(actual.raw, input.trim(), 'raw is preserved for provenance');
    return actual;
}

describe('Mastodon target forms', () => {
    test('fediverse address with and without a leading @', () => {
        for (const input of ['@Gargron@mastodon.social', 'Gargron@mastodon.social']) {
            expectTarget(input, {
                platform: 'mastodon', kind: 'profile', instance: 'mastodon.social', acct: 'Gargron',
            });
        }
    });

    test('username case is preserved but the instance is lowercased', () => {
        expectTarget('@GarGron@Mastodon.Social', {
            acct: 'GarGron', instance: 'mastodon.social',
        });
    });

    test('a non-mastodon.social instance is honoured', () => {
        expectTarget('@user@fosstodon.org', {
            platform: 'mastodon', instance: 'fosstodon.org', acct: 'user',
        });
    });

    test('hashtag with an explicit instance', () => {
        expectTarget('#opensource@mastodon.social', {
            platform: 'mastodon', kind: 'hashtag', instance: 'mastodon.social', tag: 'opensource',
        });
    });

    test('bare hashtag falls back to the default instance', () => {
        expectTarget('#rustlang', {
            platform: 'mastodon', kind: 'hashtag', instance: 'mastodon.social', tag: 'rustlang',
        });
        expectTarget('#rustlang', { instance: 'fosstodon.org' }, {
            defaultMastodonInstance: 'fosstodon.org',
        });
    });

    test('hashtag case is preserved (Mastodon tags are case-insensitive but display cased)', () => {
        expectTarget('#RustLang@mastodon.social', { tag: 'RustLang' });
    });

    test('profile URL', () => {
        expectTarget('https://mastodon.social/@Gargron', {
            platform: 'mastodon', kind: 'profile', instance: 'mastodon.social', acct: 'Gargron',
        });
    });

    test('profile URL on an arbitrary instance, with www stripped', () => {
        expectTarget('https://www.fosstodon.org/@user', {
            platform: 'mastodon', instance: 'fosstodon.org', acct: 'user',
        });
    });

    test('status permalink', () => {
        expectTarget('https://mastodon.social/@Gargron/117265110451542347', {
            platform: 'mastodon', kind: 'post', instance: 'mastodon.social', statusId: '117265110451542347',
        });
    });

    test('canonical /users/ URI forms', () => {
        expectTarget('https://mastodon.social/users/Gargron', {
            kind: 'profile', acct: 'Gargron',
        });
        expectTarget('https://mastodon.social/users/Gargron/statuses/117265110451542347', {
            kind: 'post', statusId: '117265110451542347',
        });
    });

    test('hashtag page URL', () => {
        expectTarget('https://mastodon.social/tags/opensource', {
            kind: 'hashtag', tag: 'opensource', instance: 'mastodon.social',
        });
    });

    test('the /deck/ UI prefix is stripped', () => {
        expectTarget('https://mastodon.social/deck/@Gargron', {
            kind: 'profile', acct: 'Gargron',
        });
    });

    test('trailing slash does not create an empty segment', () => {
        expectTarget('https://mastodon.social/@Gargron/', { kind: 'profile', acct: 'Gargron' });
    });

    test('percent-encoded username is decoded', () => {
        expectTarget('https://mastodon.social/@caf%C3%A9', { acct: 'café' });
    });

    test('explicit mastodon: prefix forces the platform for an ambiguous name', () => {
        // Without the prefix this is a Bluesky-shaped handle.
        expectTarget('mastodon:user@example.com', {
            platform: 'mastodon', kind: 'profile', instance: 'example.com', acct: 'user',
        });
    });
});

describe('Bluesky target forms', () => {
    test('bare handle', () => {
        expectTarget('bsky.app', { platform: 'bluesky', kind: 'profile', actor: 'bsky.app' });
        expectTarget('alice.bsky.social', { platform: 'bluesky', kind: 'profile', actor: 'alice.bsky.social' });
    });

    test('custom-domain handle', () => {
        expectTarget('orchardnotes.com', { platform: 'bluesky', actor: 'orchardnotes.com' });
    });

    test('handle with a single leading @', () => {
        expectTarget('@alice.bsky.social', { platform: 'bluesky', kind: 'profile', actor: 'alice.bsky.social' });
    });

    test('DID', () => {
        expectTarget('did:plc:z72i7hdynmk6r22z27h6tvur', {
            platform: 'bluesky', kind: 'profile', actor: 'did:plc:z72i7hdynmk6r22z27h6tvur',
        });
    });

    test('profile URL', () => {
        expectTarget('https://bsky.app/profile/bsky.app', {
            platform: 'bluesky', kind: 'profile', actor: 'bsky.app',
        });
    });

    test('post URL yields the record key and the actor', () => {
        expectTarget('https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l', {
            platform: 'bluesky', kind: 'post', actor: 'bsky.app', rkey: '3l6oveex3ii2l',
        });
    });

    test('at:// post URI is parsed and kept verbatim', () => {
        const uri = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3l6oveex3ii2l';
        expectTarget(uri, {
            platform: 'bluesky',
            kind: 'post',
            actor: 'did:plc:z72i7hdynmk6r22z27h6tvur',
            rkey: '3l6oveex3ii2l',
            uri,
        });
    });

    test('bare at:// authority is a profile', () => {
        expectTarget('at://did:plc:z72i7hdynmk6r22z27h6tvur', {
            platform: 'bluesky', kind: 'profile', actor: 'did:plc:z72i7hdynmk6r22z27h6tvur',
        });
    });

    test('bsky: prefix forces the platform', () => {
        expectTarget('bsky:bsky.app', { platform: 'bluesky', kind: 'profile', actor: 'bsky.app' });
        expectTarget('bluesky:@bsky.app', { platform: 'bluesky', actor: 'bsky.app' });
    });

    test('actor search', () => {
        expectTarget('bsky:actors:climate science', {
            platform: 'bluesky', kind: 'actor-search', query: 'climate science',
        });
    });
});

describe('platform disambiguation', () => {
    test('two @ signs means Mastodon, one dotted token means Bluesky', () => {
        assert.equal(parseTarget('@a@b.social').platform, 'mastodon');
        assert.equal(parseTarget('a.bsky.social').platform, 'bluesky');
    });

    test('a bsky.app URL is Bluesky, any other host is Mastodon', () => {
        assert.equal(parseTarget('https://bsky.app/profile/x.com').platform, 'bluesky');
        assert.equal(parseTarget('https://hachyderm.io/@x').platform, 'mastodon');
    });

    test('whitespace around a target is ignored', () => {
        assert.equal(parseTarget('  bsky.app  ').actor, 'bsky.app');
    });
});

describe('Bluesky search is rejected with an explanation, not a mystery failure', () => {
    const searchForms = ['bsky:#opensource', 'bsky:climate change', 'https://bsky.app/hashtag/opensource'];

    for (const form of searchForms) {
        test(`${form} is reported as unsupported`, () => {
            const error = catchError(() => parseTarget(form));
            assert.ok(error instanceof TargetError);
            assert.equal(error.supported, false, 'flagged unsupported, not merely malformed');
            assert.match(error.message, /not supported/i);
            // The message must name the workaround, or the user is just stuck.
            assert.match(error.message, /mastodon/i);
        });
    }

    test('the rejection never asks the user for credentials', () => {
        // This Actor is public-data-only; a message hinting at a login would invite
        // exactly the input we refuse to accept.
        const error = catchError(() => parseTarget('bsky:#tag'));
        assert.doesNotMatch(
            error.message,
            /(provide|enter|supply|add|set)\s+(your\s+)?(a\s+)?(password|app.password|token|credentials|session)/i,
        );
    });
});

describe('invalid targets', () => {
    const bad = [
        ['', 'empty string'],
        ['   ', 'whitespace only'],
        ['@justauser', 'no instance and not a domain'],
        ['not a target', 'free text'],
        ['at://', 'empty at:// authority'],
        ['ftp://example.com/@user', 'unsupported scheme'],
        ['https://mastodon.social/unknown/path', 'unrecognised path'],
    ];

    for (const [input, label] of bad) {
        test(`rejects ${label}`, () => {
            assert.throws(() => parseTarget(input), TargetError);
        });
    }

    test('non-string input is rejected rather than coerced', () => {
        assert.throws(() => parseTarget(null), TargetError);
        assert.throws(() => parseTarget(42), TargetError);
    });

    test('an at:// URI for a non-post collection is unsupported, not malformed', () => {
        const error = catchError(() => parseTarget('at://did:plc:abc/app.bsky.graph.follow/xyz'));
        assert.ok(error instanceof TargetError);
        assert.equal(error.supported, false);
    });

    test('error messages name the offending target so a 50-target run is debuggable', () => {
        const error = catchError(() => parseTarget('@justauser'));
        assert.match(error.message, /justauser/);
    });

    test('a URL-shaped string is not split into a username and an instance', () => {
        // "ftp://example.com/@user" has exactly one @ and two non-empty halves, so a naive
        // split accepts it as the account "ftp://example.com/" on the instance "user".
        for (const input of ['ftp://example.com/@user', 'a/b@c.com', 'user@host/path']) {
            assert.throws(() => parseTarget(input), TargetError, input);
        }
    });
});

describe('a target can never become a request to somewhere it should not go', () => {
    // `targets` is fully user-controlled and becomes the host of an outbound request,
    // so this is the SSRF boundary.
    const hostile = [
        ['@user@127.0.0.1', 'loopback IP literal'],
        ['@user@169.254.169.254', 'cloud metadata IP'],
        ['@user@10.0.0.5', 'private IP literal'],
        ['https://169.254.169.254/@user', 'metadata IP in a URL'],
        ['https://127.0.0.1/@user', 'loopback in a URL'],
        ['@user@db.internal', 'internal TLD'],
        ['@user@service.local', 'local TLD'],
        ['https://evil.com:22/@user', 'explicit port'],
        ['https://user:pass@evil.com/@user', 'embedded credentials'],
        ['file:///etc/passwd', 'file scheme'],
        ['ftp://example.com/@user', 'ftp scheme'],
        ['https://mastodon.social@evil.com/@user', 'userinfo disguised as a host'],
    ];

    for (const [input, label] of hostile) {
        test(`rejects ${label}`, () => {
            assert.throws(() => parseTarget(input), TargetError, input);
        });
    }

    test('a normal public instance still works', () => {
        assert.equal(parseTarget('@user@mastodon.social').instance, 'mastodon.social');
        assert.equal(parseTarget('https://hachyderm.io/@user').instance, 'hachyderm.io');
    });

    test('a path or query cannot be smuggled through the instance', () => {
        for (const input of ['@user@host.com/../admin', '@user@host.com?x=1', '@user@host.com#frag']) {
            assert.throws(() => parseTarget(input), TargetError, input);
        }
    });
});

describe('describeTarget', () => {
    test('produces a readable label for every kind', () => {
        const labels = [
            '@Gargron@mastodon.social',
            '#opensource@mastodon.social',
            'https://mastodon.social/@Gargron/117265110451542347',
            'bsky.app',
            'https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l',
            'bsky:actors:climate',
        ].map((raw) => describeTarget(parseTarget(raw)));

        for (const label of labels) {
            assert.ok(label.length > 0);
            assert.doesNotMatch(label, /\[object|undefined/, `unreadable label: ${label}`);
        }
    });
});
