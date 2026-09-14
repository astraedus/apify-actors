/**
 * Store / app-id detection.
 *
 * Accepts any of:
 *   - Google Play package name        `dev.astraedus.nudge`
 *   - Google Play store URL           `https://play.google.com/store/apps/details?id=dev.astraedus.nudge&gl=GB`
 *   - Apple numeric app id            `284882215`  /  `id284882215`
 *   - Apple App Store URL             `https://apps.apple.com/gb/app/facebook/id284882215`
 *   - Legacy iTunes URL               `https://itunes.apple.com/us/app/facebook/id284882215`
 *
 * Pure module: no I/O, no SDK imports. Unit-tested in test/detect.test.ts.
 */

export type Store = 'google-play' | 'app-store';

export interface AppTarget {
    /** Which store the id belongs to. */
    store: Store;
    /** Google Play package name, or Apple numeric track id (as a string). */
    appId: string;
    /**
     * Country hint parsed out of the URL, lower-cased ISO-3166 alpha-2.
     * `undefined` when the input carried no country, in which case the run's
     * `countries` input applies.
     */
    country?: string;
    /** The raw string the user supplied, echoed for error messages. */
    input: string;
}

/** ISO-3166 alpha-2, the only country shape both stores accept. */
const COUNTRY_RE = /^[a-z]{2}$/;

/**
 * A Google Play package name: dot-separated java-ish segments, at least one dot.
 * Deliberately stricter than Play itself so that a typo'd Apple id does not
 * silently become a "package name".
 */
const PACKAGE_RE = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z0-9_]+)+$/;

const APPLE_ID_RE = /^\d{3,12}$/;

function normaliseCountry(raw: string | null | undefined): string | undefined {
    if (!raw) return undefined;
    const c = raw.trim().toLowerCase();
    return COUNTRY_RE.test(c) ? c : undefined;
}

function detectFromUrl(url: URL, input: string): AppTarget {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');

    if (host.endsWith('play.google.com')) {
        const id = url.searchParams.get('id');
        if (!id) {
            throw new Error(`Google Play URL is missing the ?id= parameter: ${input}`);
        }
        return {
            store: 'google-play',
            appId: id,
            country: normaliseCountry(url.searchParams.get('gl')),
            input,
        };
    }

    if (host.endsWith('apps.apple.com') || host.endsWith('itunes.apple.com')) {
        // Path shapes: /us/app/facebook/id284882215 , /app/id284882215 , /us/app/id284882215
        const segments = url.pathname.split('/').filter(Boolean);
        const idSegment = segments.find((s) => /^id\d+$/i.test(s));
        // Some share links carry the id only as ?id=284882215
        const appId = idSegment ? idSegment.slice(2) : url.searchParams.get('id');
        if (!appId || !APPLE_ID_RE.test(appId)) {
            throw new Error(`App Store URL does not contain a numeric app id: ${input}`);
        }
        // The country is the first path segment when it is a 2-letter code.
        const country = segments[0] === undefined ? undefined : normaliseCountry(segments[0]);
        return { store: 'app-store', appId, country, input };
    }

    throw new Error(
        `Unrecognised store URL: ${input}. Supported hosts: play.google.com, apps.apple.com, itunes.apple.com.`,
    );
}

/**
 * Resolve one user-supplied app reference to a concrete store + id.
 * Throws an Error with an actionable message when the reference is unusable.
 */
export function detectAppTarget(raw: string): AppTarget {
    const input = String(raw ?? '').trim();
    if (!input) throw new Error('Empty app identifier.');

    if (/^https?:\/\//i.test(input)) {
        let url: URL;
        try {
            url = new URL(input);
        } catch {
            throw new Error(`Not a valid URL: ${input}`);
        }
        return detectFromUrl(url, input);
    }

    // `id284882215` -> Apple
    const bareAppleId = /^id(\d{3,12})$/i.exec(input);
    if (bareAppleId) {
        return { store: 'app-store', appId: bareAppleId[1]!, input };
    }

    if (APPLE_ID_RE.test(input)) {
        return { store: 'app-store', appId: input, input };
    }

    if (PACKAGE_RE.test(input)) {
        return { store: 'google-play', appId: input, input };
    }

    throw new Error(
        `Cannot tell which store "${input}" belongs to. Use a Google Play package name ` +
            '(e.g. dev.astraedus.nudge), an Apple numeric app id (e.g. 284882215), or a full store URL.',
    );
}

/**
 * Resolve the whole `apps` input into the app x country matrix the run will check.
 * A country baked into a URL wins over the global `countries` list for that app only.
 * Duplicate (store, appId, country) triples are collapsed so users are never
 * charged twice for the same check.
 */
export function buildCheckList(
    apps: readonly string[],
    countries: readonly string[],
): Array<{ store: Store; appId: string; country: string; input: string }> {
    const fallback = countries.map((c) => c.trim().toLowerCase()).filter((c) => COUNTRY_RE.test(c));
    if (fallback.length === 0) {
        throw new Error('`countries` must contain at least one ISO-3166 alpha-2 code, e.g. ["us"].');
    }

    const seen = new Set<string>();
    const out: Array<{ store: Store; appId: string; country: string; input: string }> = [];

    for (const app of apps) {
        const target = detectAppTarget(app);
        const list = target.country ? [target.country] : fallback;
        for (const country of list) {
            const key = `${target.store}|${target.appId}|${country}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({ store: target.store, appId: target.appId, country, input: target.input });
        }
    }

    return out;
}

/** Canonical public store URL for an app, used in output rows. */
export function storeUrl(store: Store, appId: string, country: string): string {
    return store === 'google-play'
        ? `https://play.google.com/store/apps/details?id=${encodeURIComponent(appId)}&hl=en&gl=${country.toUpperCase()}`
        : `https://apps.apple.com/${country}/app/id${appId}`;
}
