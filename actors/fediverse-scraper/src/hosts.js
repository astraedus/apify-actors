/**
 * Host safety: the single definition of "a host we are willing to send a request to".
 *
 * `targets` is fully user-controlled and becomes the host of an outbound request, so
 * this is the SSRF boundary. The critical rule is that validation must run on the
 * CANONICAL hostname that `new URL()` produces, never on the raw string the user typed.
 * WHATWG URL canonicalises alternate IPv4 notations, so a denylist applied to the raw
 * string is bypassed by writing the same address a different way:
 *
 *     0xa9.0xfe.0xa9.0xfe    -> 169.254.169.254   (hex)
 *     0251.0376.0251.0376    -> 169.254.169.254   (octal)
 *     2852039166             -> 169.254.169.254   (decimal shorthand)
 *     127.1                  -> 127.0.0.1         (shorthand)
 *
 * All four reach cloud metadata. Canonicalising first collapses every encoding to the
 * same dotted-quad, which a single strict check then rejects.
 */

/** Suffixes that resolve inside a private network rather than to a fediverse server. */
const INTERNAL_SUFFIXES = [
    'internal', 'local', 'localhost', 'localdomain', 'lan', 'home', 'intranet', 'corp',
];

/** Canonical dotted-quad. After canonicalisation, every IPv4 encoding looks like this. */
const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** Dot-separated DNS labels and nothing else. */
const DNS_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

export class UnsafeHostError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsafeHostError';
    }
}

/**
 * Is this CANONICAL hostname safe to request?
 * Pass the value of `new URL(...).hostname`, not a user-supplied string.
 */
export function isPublicHostname(hostname) {
    if (!hostname) return false;
    const host = hostname.toLowerCase().replace(/\.$/, '');

    // IPv6 literals arrive bracketed or with colons. A fediverse instance is never one.
    if (host.includes(':') || host.startsWith('[')) return false;
    // Nor is it ever a bare IPv4 address, so rejecting all of them is both simplest and
    // strictest -- no need to enumerate the private, loopback and link-local ranges.
    if (IPV4.test(host)) return false;
    if (!DNS_NAME.test(host)) return false;

    const lastLabel = host.slice(host.lastIndexOf('.') + 1);
    return !INTERNAL_SUFFIXES.includes(lastLabel);
}

/**
 * Canonicalise a bare host string the way a URL would, so callers can validate a host
 * they are about to interpolate into one. Returns null when it is not a usable host.
 */
export function canonicalHostname(rawHost) {
    if (typeof rawHost !== 'string' || rawHost.trim() === '') return null;
    const trimmed = rawHost.trim();
    // Reject anything carrying URL structure before it can be smuggled into a path.
    if (/[/\\?#@\s]/.test(trimmed)) return null;
    try {
        const url = new URL(`https://${trimmed}`);
        // A port, or userinfo, means the caller gave us more than a host.
        if (url.port || url.username || url.password) return null;
        return url.hostname.toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Validate a host the caller is about to turn into a request, returning its canonical
 * form. Throws UnsafeHostError when the host is malformed, internal, or an IP literal.
 */
export function assertPublicHost(rawHost, context = '') {
    const canonical = canonicalHostname(rawHost);
    const where = context ? ` in ${context}` : '';
    if (!canonical) {
        throw new UnsafeHostError(`"${rawHost}" is not a valid instance host${where}`);
    }
    if (!isPublicHostname(canonical)) {
        throw new UnsafeHostError(
            `"${rawHost}" resolves to a non-public host (${canonical}) and will not be requested${where}`,
        );
    }
    return canonical;
}

/**
 * The choke point: validate a fully-formed URL immediately before it is fetched.
 * Every request in this Actor passes through here, including redirect targets, so a
 * future code path cannot reintroduce the bypass by skipping a caller-side check.
 */
export function assertPublicHttpUrl(rawUrl) {
    let url;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new UnsafeHostError(`Not a valid URL: "${rawUrl}"`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new UnsafeHostError(`Refusing non-HTTP(S) URL: "${rawUrl}"`);
    }
    if (url.username || url.password) {
        throw new UnsafeHostError(`Refusing URL with embedded credentials: "${url.origin}"`);
    }
    if (!isPublicHostname(url.hostname)) {
        throw new UnsafeHostError(
            `Refusing request to non-public host "${url.hostname}" (from "${rawUrl}")`,
        );
    }
    return url;
}
