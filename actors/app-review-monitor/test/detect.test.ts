import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCheckList, detectAppTarget, storeUrl } from '../src/detect.ts';

test('detects bare Google Play package names', () => {
    for (const pkg of ['dev.astraedus.nudge', 'com.raeduslabs.origo', 'com.raeduslabs.soulsyncapp', 'com.whatsapp']) {
        const target = detectAppTarget(pkg);
        assert.equal(target.store, 'google-play');
        assert.equal(target.appId, pkg);
        assert.equal(target.country, undefined);
    }
});

test('detects Google Play URLs and reads the gl country', () => {
    const target = detectAppTarget('https://play.google.com/store/apps/details?id=dev.astraedus.nudge&hl=en&gl=GB');
    assert.deepEqual(
        { store: target.store, appId: target.appId, country: target.country },
        { store: 'google-play', appId: 'dev.astraedus.nudge', country: 'gb' },
    );
});

test('Google Play URL without gl leaves the country unset', () => {
    const target = detectAppTarget('https://play.google.com/store/apps/details?id=com.whatsapp');
    assert.equal(target.country, undefined);
});

test('Google Play URL without an id is rejected with an actionable message', () => {
    assert.throws(
        () => detectAppTarget('https://play.google.com/store/apps/details?hl=en'),
        /missing the \?id= parameter/,
    );
});

test('detects Apple numeric ids in every accepted spelling', () => {
    for (const raw of ['284882215', 'id284882215', 'ID284882215']) {
        const target = detectAppTarget(raw);
        assert.equal(target.store, 'app-store');
        assert.equal(target.appId, '284882215');
    }
});

test('detects App Store URLs and reads the country path segment', () => {
    const cases: Array<[string, string | undefined]> = [
        ['https://apps.apple.com/us/app/facebook/id284882215', 'us'],
        ['https://apps.apple.com/gb/app/facebook/id284882215?mt=8', 'gb'],
        ['https://apps.apple.com/app/id284882215', undefined],
        ['https://itunes.apple.com/us/app/facebook/id284882215', 'us'],
        ['https://www.apps.apple.com/de/app/whatsapp-messenger/id310633997', 'de'],
    ];
    for (const [url, country] of cases) {
        const target = detectAppTarget(url);
        assert.equal(target.store, 'app-store', url);
        assert.ok(/^\d+$/.test(target.appId), url);
        assert.equal(target.country, country, url);
    }
});

test('App Store URL without a numeric id is rejected', () => {
    assert.throws(() => detectAppTarget('https://apps.apple.com/us/app/facebook'), /numeric app id/);
});

test('unknown hosts and junk are rejected, not silently mis-routed', () => {
    assert.throws(() => detectAppTarget('https://example.com/app/id123456'), /Unrecognised store URL/);
    assert.throws(() => detectAppTarget('not an app'), /Cannot tell which store/);
    assert.throws(() => detectAppTarget(''), /Empty app identifier/);
    // A single-segment name is not a package name, and must not be guessed at.
    assert.throws(() => detectAppTarget('whatsapp'), /Cannot tell which store/);
});

test('an Apple id is never mistaken for a Play package and vice versa', () => {
    assert.equal(detectAppTarget('310633997').store, 'app-store');
    assert.equal(detectAppTarget('com.310633997.app').store, 'google-play');
});

test('buildCheckList expands apps across countries', () => {
    const list = buildCheckList(['dev.astraedus.nudge', '284882215'], ['us', 'GB']);
    assert.equal(list.length, 4);
    assert.deepEqual(
        list.map((c) => `${c.store}:${c.appId}:${c.country}`),
        [
            'google-play:dev.astraedus.nudge:us',
            'google-play:dev.astraedus.nudge:gb',
            'app-store:284882215:us',
            'app-store:284882215:gb',
        ],
    );
});

test('a country in the URL overrides the global countries list for that app only', () => {
    const list = buildCheckList(
        ['https://apps.apple.com/de/app/x/id284882215', 'dev.astraedus.nudge'],
        ['us', 'gb'],
    );
    assert.deepEqual(
        list.map((c) => `${c.appId}:${c.country}`),
        ['284882215:de', 'dev.astraedus.nudge:us', 'dev.astraedus.nudge:gb'],
    );
});

test('buildCheckList collapses duplicate app+country pairs so nobody is charged twice', () => {
    const list = buildCheckList(
        [
            'dev.astraedus.nudge',
            'https://play.google.com/store/apps/details?id=dev.astraedus.nudge&gl=US',
        ],
        ['us'],
    );
    assert.equal(list.length, 1);
});

test('buildCheckList rejects an empty or invalid countries list', () => {
    assert.throws(() => buildCheckList(['com.whatsapp'], []), /at least one ISO-3166/);
    assert.throws(() => buildCheckList(['com.whatsapp'], ['united states']), /at least one ISO-3166/);
});

test('storeUrl builds canonical public URLs', () => {
    assert.equal(
        storeUrl('google-play', 'dev.astraedus.nudge', 'us'),
        'https://play.google.com/store/apps/details?id=dev.astraedus.nudge&hl=en&gl=US',
    );
    assert.equal(storeUrl('app-store', '284882215', 'gb'), 'https://apps.apple.com/gb/app/id284882215');
});
