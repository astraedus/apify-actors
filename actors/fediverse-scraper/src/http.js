/**
 * Polite HTTP layer shared by both platform clients.
 *
 * Two responsibilities:
 *   1. Per-host pacing, so we never trip Mastodon's 300-requests-per-5-minutes-per-IP
 *      budget or Bluesky's public AppView limits.
 *   2. Bounded retries with jitter on the transient failures (429 / 5xx / network).
 *
 * Both platforms publish their remaining budget in headers, so pacing is adaptive:
 * when a server says we are running low we slow down rather than guessing.
 */

/** Mastodon documents 300 requests / 5 minutes / IP. 350ms keeps us under half of that. */
import { assertPublicHttpUrl, UnsafeHostError } from './hosts.js';

export const MASTODON_MIN_INTERVAL_MS = 350;
/** Bluesky's public AppView is far more generous; 130ms is ~7.5 req/s. */
export const BLUESKY_MIN_INTERVAL_MS = 130;

const DEFAULT_MIN_INTERVAL_MS = 350;
const MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
/** Below this many remaining requests we start spacing calls out defensively. */
const LOW_BUDGET_THRESHOLD = 30;

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Error carrying the HTTP status so callers can branch on 404 vs 401 vs 5xx. */
export class HttpError extends Error {
    constructor(message, { status, url, body }) {
        super(message);
        this.name = 'HttpError';
        this.status = status;
        this.url = url;
        this.body = body;
    }
}

/**
 * Serialises requests per host with a minimum gap between them.
 * Hosts are independent, so Mastodon work never blocks Bluesky work.
 */
export class RateLimiter {
    constructor({ defaultIntervalMs = DEFAULT_MIN_INTERVAL_MS } = {}) {
        this.defaultIntervalMs = defaultIntervalMs;
        /** @type {Map<string, {interval: number, tail: Promise<void>}>} */
        this.hosts = new Map();
    }

    /** Register a host-specific pace. Safe to call repeatedly. */
    configure(host, intervalMs) {
        const entry = this.#entry(host);
        entry.interval = intervalMs;
    }

    #entry(host) {
        let entry = this.hosts.get(host);
        if (!entry) {
            entry = { interval: this.defaultIntervalMs, tail: Promise.resolve() };
            this.hosts.set(host, entry);
        }
        return entry;
    }

    /**
     * Run `fn` once this host's turn comes up, then hold the slot open for
     * `interval` ms so the next caller is naturally spaced out.
     */
    async schedule(host, fn) {
        const entry = this.#entry(host);
        const previous = entry.tail;
        let release;
        entry.tail = new Promise((resolve) => { release = resolve; });
        await previous;
        try {
            return await fn();
        } finally {
            // Hold the slot for the pacing interval, but never block the caller on it.
            sleep(entry.interval).then(release);
        }
    }

    /**
     * Feed server-reported budget back into the pace. When a host tells us we have
     * few requests left before its reset, stretch the interval to cover the window.
     */
    observeBudget(host, { remaining, resetAt }) {
        if (!Number.isFinite(remaining) || remaining > LOW_BUDGET_THRESHOLD) return;
        const msUntilReset = resetAt ? resetAt - Date.now() : 0;
        if (msUntilReset <= 0) return;
        const entry = this.#entry(host);
        // Spread whatever is left evenly across the remaining window.
        const spaced = Math.ceil(msUntilReset / Math.max(remaining, 1));
        entry.interval = Math.max(entry.interval, Math.min(spaced, MAX_BACKOFF_MS));
    }
}

/** Parse the rate-limit headers both platforms expose (Mastodon uses ISO dates). */
export function parseRateLimitHeaders(headers) {
    // Number(null) is 0, so an absent header would otherwise read as "no budget left"
    // and throttle every server that does not publish these headers to a crawl.
    const rawRemaining = headers.get('x-ratelimit-remaining');
    const remaining = rawRemaining === null || rawRemaining === '' ? NaN : Number(rawRemaining);
    const rawReset = headers.get('x-ratelimit-reset');
    let resetAt = null;
    if (rawReset) {
        // Mastodon sends an ISO timestamp; other servers send epoch seconds.
        const asNumber = Number(rawReset);
        resetAt = Number.isFinite(asNumber) && asNumber > 0
            ? asNumber * 1_000
            : Date.parse(rawReset);
        if (!Number.isFinite(resetAt)) resetAt = null;
    }
    return { remaining: Number.isFinite(remaining) ? remaining : null, resetAt };
}

/** How long to wait after a 429/503, honouring Retry-After when present. */
export function retryDelayMs(attempt, retryAfterHeader) {
    if (retryAfterHeader) {
        const seconds = Number(retryAfterHeader);
        if (Number.isFinite(seconds) && seconds >= 0) {
            return Math.min(seconds * 1_000, MAX_BACKOFF_MS);
        }
        const date = Date.parse(retryAfterHeader);
        if (Number.isFinite(date)) {
            return Math.min(Math.max(date - Date.now(), 0), MAX_BACKOFF_MS);
        }
    }
    const exponential = BASE_BACKOFF_MS * 2 ** (attempt - 1);
    const jitter = Math.random() * BASE_BACKOFF_MS;
    return Math.min(exponential + jitter, MAX_BACKOFF_MS);
}

/** A 4xx other than 429 is our fault and will never succeed on retry. */
export function isRetryableStatus(status) {
    return status === 429 || status === 408 || status >= 500;
}

/** How many redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

const isRedirect = (status) => status === 301 || status === 302 || status === 303
    || status === 307 || status === 308;

/**
 * Perform one GET, following redirects MANUALLY.
 *
 * `fetch` follows 3xx transparently, which would let a host that passed validation
 * bounce us to 169.254.169.254 or 127.0.0.1 with nothing re-checking the final target.
 * Following by hand means every hop goes back through the same host guard.
 */
async function getFollowingRedirects(startUrl, { limiter, userAgent, timeoutMs, log }) {
    let current = assertPublicHttpUrl(startUrl).toString();

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        const host = new URL(current).host;
        const response = await limiter.schedule(host, () => {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            return fetch(current, {
                headers: { accept: 'application/json', 'user-agent': userAgent },
                signal: controller.signal,
                redirect: 'manual',
            }).finally(() => clearTimeout(timer));
        });

        limiter.observeBudget(host, parseRateLimitHeaders(response.headers));
        if (!isRedirect(response.status)) return { response, url: current };

        const location = response.headers.get('location');
        if (!location) {
            throw new HttpError(`GET ${current} returned HTTP ${response.status} with no Location header`, {
                status: response.status, url: current, body: '',
            });
        }
        // Relative redirects are legitimate and common, so resolve before validating.
        const next = new URL(location, current).toString();
        // Throws for a metadata address, a loopback, or any non-public host.
        assertPublicHttpUrl(next);
        log?.info(`Following redirect ${response.status}: ${host} -> ${new URL(next).host}`);
        current = next;
    }
    throw new HttpError(`GET ${startUrl} exceeded ${MAX_REDIRECTS} redirects`, {
        status: 310, url: startUrl, body: '',
    });
}

/**
 * GET a JSON document with pacing, retries, redirect safety and rate-limit feedback.
 *
 * @returns {Promise<{ body: any, headers: Headers, url: string }>}
 */
export async function fetchJson(url, { limiter, userAgent, log, timeoutMs = 30_000 } = {}) {
    // Validate before anything else so a bad host fails immediately rather than after
    // four retries, and so `new URL` below can never throw on a malformed input.
    const host = assertPublicHttpUrl(url).host;
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const { response, url: finalUrl } = await getFollowingRedirects(url, {
                limiter, userAgent, timeoutMs, log,
            });

            if (response.ok) {
                return { body: await response.json(), headers: response.headers, url: finalUrl };
            }

            const body = await response.text().catch(() => '');
            if (!isRetryableStatus(response.status) || attempt === MAX_ATTEMPTS) {
                throw new HttpError(
                    `GET ${url} failed with HTTP ${response.status}`,
                    { status: response.status, url, body: body.slice(0, 500) },
                );
            }
            const delay = retryDelayMs(attempt, response.headers.get('retry-after'));
            log?.warning(`HTTP ${response.status} from ${host}, retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
            await sleep(delay);
            lastError = new HttpError(`GET ${url} failed with HTTP ${response.status}`, {
                status: response.status, url, body: body.slice(0, 500),
            });
        } catch (error) {
            // An unsafe host is a permanent refusal, never something to retry into.
            if (error instanceof UnsafeHostError) throw error;
            if (error instanceof HttpError && !isRetryableStatus(error.status)) throw error;
            lastError = error;
            if (attempt === MAX_ATTEMPTS) break;
            const delay = retryDelayMs(attempt);
            log?.warning(`Request to ${host} failed (${error.message}), retrying in ${delay}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
            await sleep(delay);
        }
    }
    throw lastError;
}

/**
 * Mastodon paginates with RFC 5988 Link headers rather than a cursor field.
 * Returns the `rel="next"` URL, or null when the collection is exhausted.
 */
export function parseNextLink(linkHeader) {
    if (!linkHeader) return null;
    // Split on commas that separate links, not commas inside the URL itself.
    for (const part of linkHeader.split(/,\s*(?=<)/)) {
        const match = part.match(/^\s*<([^>]+)>\s*;\s*(.+)$/);
        if (!match) continue;
        const [, url, params] = match;
        if (/rel\s*=\s*"?next"?/i.test(params)) return url;
    }
    return null;
}
