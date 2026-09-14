import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseProfiles, parseUsername, profileUrl, snapshotKey } from '../src/parse.ts';

describe('parseUsername', () => {
    it('accepts a bare handle', () => {
        assert.equal(parseUsername('tiktok'), 'tiktok');
    });

    it('strips a leading @', () => {
        assert.equal(parseUsername('@tiktok'), 'tiktok');
    });

    it('lowercases for stable snapshot keying across runs', () => {
        assert.equal(parseUsername('@TikTok'), 'tiktok');
        assert.equal(parseUsername('https://www.tiktok.com/@KhabY.Lame'), 'khaby.lame');
    });

    it('keeps dots and underscores, which are legal in TikTok handles', () => {
        assert.equal(parseUsername('khaby.lame'), 'khaby.lame');
        assert.equal(parseUsername('some_user.name'), 'some_user.name');
    });

    it('extracts the handle from full profile URLs', () => {
        assert.equal(parseUsername('https://www.tiktok.com/@tiktok'), 'tiktok');
        assert.equal(parseUsername('https://tiktok.com/@tiktok'), 'tiktok');
        assert.equal(parseUsername('www.tiktok.com/@tiktok'), 'tiktok');
        assert.equal(parseUsername('tiktok.com/@tiktok'), 'tiktok');
    });

    it('tolerates trailing slashes, query strings and fragments', () => {
        assert.equal(parseUsername('https://www.tiktok.com/@tiktok/'), 'tiktok');
        assert.equal(parseUsername('https://www.tiktok.com/@tiktok?lang=en'), 'tiktok');
        assert.equal(parseUsername('https://www.tiktok.com/@tiktok#posts'), 'tiktok');
    });

    it('recovers the author handle from a single-video URL', () => {
        assert.equal(
            parseUsername('https://www.tiktok.com/@khaby.lame/video/7212345678901234567'),
            'khaby.lame',
        );
    });

    it('trims surrounding whitespace from pasted input', () => {
        assert.equal(parseUsername('  @tiktok  '), 'tiktok');
    });

    it('rejects input it cannot confidently read as a handle', () => {
        assert.equal(parseUsername(''), null);
        assert.equal(parseUsername('   '), null);
        assert.equal(parseUsername('https://www.tiktok.com/foryou'), null);
        assert.equal(parseUsername('https://instagram.com/@tiktok'), null, 'wrong platform is not a tiktok URL');
        assert.equal(parseUsername('has spaces'), null);
        assert.equal(parseUsername('bad/slash'), null);
    });

    it('rejects non-string input rather than coercing it', () => {
        assert.equal(parseUsername(null), null);
        assert.equal(parseUsername(undefined), null);
        assert.equal(parseUsername(42), null);
        assert.equal(parseUsername({ username: 'tiktok' }), null);
    });
});

describe('parseProfiles', () => {
    it('parses a mixed list of handles and URLs', () => {
        const result = parseProfiles(['tiktok', '@khaby.lame', 'https://www.tiktok.com/@bts_official_bighit']);

        assert.deepEqual(result.usernames, ['tiktok', 'khaby.lame', 'bts_official_bighit']);
        assert.deepEqual(result.invalid, []);
    });

    it('de-duplicates across input formats so a profile is never billed twice', () => {
        const result = parseProfiles([
            'tiktok',
            '@tiktok',
            'https://www.tiktok.com/@tiktok',
            'https://www.tiktok.com/@TIKTOK/',
        ]);

        assert.deepEqual(result.usernames, ['tiktok']);
    });

    it('preserves first-seen order', () => {
        const result = parseProfiles(['zed', 'alpha', 'mid']);

        assert.deepEqual(result.usernames, ['zed', 'alpha', 'mid']);
    });

    it('collects unparseable entries instead of throwing', () => {
        const result = parseProfiles(['tiktok', 'bad entry', '']);

        assert.deepEqual(result.usernames, ['tiktok']);
        assert.deepEqual(result.invalid, ['bad entry', '']);
    });

    it('treats a non-array input as empty', () => {
        assert.deepEqual(parseProfiles(undefined), { usernames: [], invalid: [] });
        assert.deepEqual(parseProfiles('tiktok'), { usernames: [], invalid: [] });
    });
});

describe('profileUrl', () => {
    it('builds the canonical public profile URL', () => {
        assert.equal(profileUrl('khaby.lame'), 'https://www.tiktok.com/@khaby.lame');
    });

    it('round-trips through parseUsername', () => {
        for (const username of ['tiktok', 'khaby.lame', 'some_user.name']) {
            assert.equal(parseUsername(profileUrl(username)), username);
        }
    });
});

describe('snapshotKey', () => {
    it('prefixes the username so state keys never collide with our own keys', () => {
        assert.equal(snapshotKey('tiktok'), 'profile-tiktok');
    });

    it('passes through the legal TikTok charset untouched', () => {
        assert.equal(snapshotKey('khaby.lame'), 'profile-khaby.lame');
        assert.equal(snapshotKey('a_b.c'), 'profile-a_b.c');
    });

    it('replaces characters a key-value store would reject', () => {
        assert.equal(snapshotKey('bad/name'), 'profile-bad_name');
        assert.equal(snapshotKey('sp ace'), 'profile-sp_ace');
    });

    it('produces keys matching the Apify key-value store charset', () => {
        // Apify allows a-zA-Z0-9!-_.'() ; we emit a conservative subset.
        const legal = /^[A-Za-z0-9!\-_.'()]+$/;
        for (const raw of ['tiktok', 'khaby.lame', 'bad/name', 'sp ace', 'wei®d']) {
            assert.match(snapshotKey(raw), legal, `key for ${raw} must be storable`);
        }
    });
});
