/**
 * Outbound-URL safety guard (SSRF) + a redirect-aware fetch.
 *
 * THIS FILE IS A COPY, ON PURPOSE. Every Actor in this repo is self-contained
 * and published independently, so there is no shared package to import from —
 * the copy under each `actors/<name>/src/safe-url.ts` is identical below this
 * header and they must be changed together.
 *
 * The threat: any URL a user can put in the input (today: `webhookUrl`) is a URL
 * this Actor will connect to from inside Apify's network, where loopback and the
 * cloud metadata endpoint are reachable. Two ways that is exploited, both of
 * which look harmless to a naive check:
 *
 *   1. ALTERNATE IP ENCODINGS. `http://0xa9.0xfe.0xa9.0xfe`, `0251.0376.0251.0376`
 *      and `127.1` are not "IP addresses" to a string check, but the WHATWG URL
 *      parser canonicalizes them to 169.254.169.254 and 127.0.0.1 at `new URL()`
 *      time — i.e. AFTER the naive check and BEFORE `fetch()` connects. Every
 *      decision here is therefore made on the canonical `URL.hostname`, and the
 *      IPv4 parser below still accepts the hex/octal/short forms in case a host
 *      ever reaches it without passing through the URL parser.
 *
 *   2. REDIRECTS. `fetch()` follows redirects by default, so a perfectly public
 *      host can answer 302 Location: http://169.254.169.254/… and the request
 *      lands on the metadata service anyway. `safeFetch()` therefore uses
 *      `redirect: 'manual'` and re-runs the guard on every hop.
 *
 * RESIDUAL RISK (accepted, documented): a public hostname whose DNS A record
 * points at a private address still passes, because the guard is deliberately
 * pure and synchronous (no DNS, no I/O) so it can run at input-validation time
 * and be exhaustively unit-tested. Closing that needs resolve-then-pin at
 * connect time, which Node's fetch does not expose.
 */

/** Thrown for any URL this Actor refuses to connect to. */
export class UnsafeUrlError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsafeUrlError';
    }
}

export interface SafeUrlOptions {
    /** Field name used in error messages, e.g. `webhookUrl`. */
    label?: string;
    /**
     * Permit a port other than 80/443. Off unless the operator opts in with
     * `ALLOW_NON_STANDARD_WEBHOOK_PORT=1`, because "https://example.com:9200/"
     * is far more often an internal Elasticsearch than a customer's endpoint.
     */
    allowNonStandardPort?: boolean;
}

/** Redirect hops we will follow before giving up. */
export const MAX_REDIRECT_HOPS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Ranges that must never be reachable from a user-supplied URL, as
 * [network, prefix length, why]. 169.254.0.0/16 covers 169.254.169.254, the
 * AWS/GCP/Azure instance-metadata address.
 */
const BLOCKED_IPV4_RANGES: ReadonlyArray<readonly [string, number, string]> = [
    ['0.0.0.0', 8, 'this-network'],
    ['10.0.0.0', 8, 'private'],
    ['100.64.0.0', 10, 'carrier-grade NAT'],
    ['127.0.0.0', 8, 'loopback'],
    ['169.254.0.0', 16, 'link-local, incl. the cloud metadata endpoint'],
    ['172.16.0.0', 12, 'private'],
    ['192.0.0.0', 24, 'IETF protocol assignments'],
    ['192.168.0.0', 16, 'private'],
    ['198.18.0.0', 15, 'benchmarking'],
    ['224.0.0.0', 4, 'multicast'],
    ['240.0.0.0', 4, 'reserved / broadcast'],
];

/** Hostnames that resolve inside a private network by construction. */
const BLOCKED_HOST_SUFFIXES = ['.local', '.internal', '.localdomain', '.localhost', '.home.arpa'];
const BLOCKED_HOST_NAMES = new Set(['localhost', 'local', 'internal', 'localdomain']);

/**
 * One dotted-quad component, in any radix the URL parser accepts:
 * `0x7f` (hex), `0177` (octal), `127` (decimal).
 */
function parseIpv4Component(input: string): number | null {
    if (input === '') return null;

    let radix = 10;
    let digits = input;
    if (/^0[xX]/.test(digits)) {
        radix = 16;
        digits = digits.slice(2);
    } else if (digits.length > 1 && digits.startsWith('0')) {
        radix = 8;
        digits = digits.slice(1);
    }
    // "0" and "0x" are both zero once the prefix is stripped.
    if (digits === '') return 0;

    const allowed = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
    if (!allowed.test(digits)) return null;

    const value = Number.parseInt(digits, radix);
    return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse a host as an IPv4 address, returning it as a 32-bit integer, or null
 * when the host is not an IPv4 literal at all.
 *
 * Accepts every form the WHATWG parser does: four components, but also `127.1`
 * (the last component absorbs the remaining bytes) and the bare integer
 * `2130706433`.
 */
export function parseIpv4(host: string): number | null {
    const parts = host.split('.');
    // A single trailing dot is allowed ("1.2.3.4.").
    if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
    if (parts.length === 0 || parts.length > 4) return null;

    const numbers: number[] = [];
    for (const part of parts) {
        const value = parseIpv4Component(part);
        if (value === null) return null;
        numbers.push(value);
    }

    const last = numbers[numbers.length - 1]!;
    for (let i = 0; i < numbers.length - 1; i += 1) {
        if (numbers[i]! > 255) return null;
    }
    if (last >= 256 ** (5 - numbers.length)) return null;

    let address = last;
    for (let i = 0; i < numbers.length - 1; i += 1) {
        address += numbers[i]! * 256 ** (3 - i);
    }
    return address >>> 0;
}

function ipv4ToString(address: number): string {
    return [address >>> 24, (address >>> 16) & 255, (address >>> 8) & 255, address & 255].join('.');
}

/** Why this IPv4 address is off limits, or null when it is fine to connect to. */
function blockedIpv4Reason(address: number): string | null {
    for (const [network, prefix, why] of BLOCKED_IPV4_RANGES) {
        const base = parseIpv4(network)!;
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        if (((address & mask) >>> 0) === base) return `${why} (${network}/${prefix})`;
    }
    return null;
}

/**
 * Parse a host as an IPv6 address into its eight 16-bit groups, or null when it
 * is not an IPv6 literal. Tolerates the surrounding brackets that
 * `URL.hostname` keeps, and the `::ffff:1.2.3.4` dotted tail.
 */
export function parseIpv6(host: string): number[] | null {
    let text = host;
    if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
    // Drop a zone id ("fe80::1%eth0"); it does not change which network it is on.
    const zone = text.indexOf('%');
    if (zone !== -1) text = text.slice(0, zone);
    if (!text.includes(':')) return null;

    const doubleColon = text.indexOf('::');
    if (doubleColon !== text.lastIndexOf('::')) return null;

    const expand = (chunk: string): number[] | null => {
        if (chunk === '') return [];
        const groups: number[] = [];
        const pieces = chunk.split(':');
        for (let i = 0; i < pieces.length; i += 1) {
            const piece = pieces[i]!;
            if (piece.includes('.')) {
                // Only legal as the final piece: an embedded IPv4 tail.
                if (i !== pieces.length - 1) return null;
                const address = parseIpv4(piece);
                if (address === null) return null;
                groups.push(address >>> 16, address & 0xffff);
                continue;
            }
            if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return null;
            groups.push(Number.parseInt(piece, 16));
        }
        return groups;
    };

    let groups: number[];
    if (doubleColon === -1) {
        const parsed = expand(text);
        if (parsed === null || parsed.length !== 8) return null;
        groups = parsed;
    } else {
        const head = expand(text.slice(0, doubleColon));
        const tail = expand(text.slice(doubleColon + 2));
        if (head === null || tail === null) return null;
        const fill = 8 - head.length - tail.length;
        if (fill < 1) return null;
        groups = [...head, ...new Array<number>(fill).fill(0), ...tail];
    }

    return groups.every((group) => group >= 0 && group <= 0xffff) ? groups : null;
}

/** The IPv4 address embedded in a mapped/compatible/NAT64 IPv6 address, if any. */
function embeddedIpv4(groups: number[]): number | null {
    const zeroThrough = (end: number): boolean => groups.slice(0, end).every((group) => group === 0);
    const tail = (((groups[6]! << 16) | groups[7]!) >>> 0);

    // ::ffff:a.b.c.d — IPv4-mapped. This is the form `URL.hostname` produces,
    // in hex: [::ffff:7f00:1] is 127.0.0.1 wearing a different hat.
    if (zeroThrough(5) && groups[5] === 0xffff) return tail;
    // 64:ff9b::a.b.c.d — the NAT64 well-known prefix.
    if (
        groups[0] === 0x0064 &&
        groups[1] === 0xff9b &&
        groups[2] === 0 &&
        groups[3] === 0 &&
        groups[4] === 0 &&
        groups[5] === 0
    ) {
        return tail;
    }
    // ::a.b.c.d — deprecated IPv4-compatible. `::` and `::1` are handled separately.
    if (zeroThrough(6) && tail > 1) return tail;

    return null;
}

/** Why this IPv6 address is off limits, or null when it is fine to connect to. */
function blockedIpv6Reason(groups: number[]): string | null {
    if (groups.every((group) => group === 0)) return 'the unspecified address (::)';
    if (groups.slice(0, 7).every((group) => group === 0) && groups[7] === 1) return 'IPv6 loopback (::1)';

    const mapped = embeddedIpv4(groups);
    if (mapped !== null) {
        const reason = blockedIpv4Reason(mapped);
        return reason ? `IPv4-mapped ${ipv4ToString(mapped)} — ${reason}` : null;
    }

    if ((groups[0]! & 0xfe00) === 0xfc00) return 'IPv6 unique-local (fc00::/7)';
    if ((groups[0]! & 0xffc0) === 0xfe80) return 'IPv6 link-local (fe80::/10)';
    return null;
}

/**
 * Validate a URL this Actor is about to connect to, and return it parsed.
 *
 * Throws `UnsafeUrlError` with a message a customer can act on. Pure and
 * synchronous: safe to call at input-validation time, and again immediately
 * before the request (which is what `safeFetch` does, on every redirect hop).
 */
export function assertSafeOutboundUrl(target: string | URL, options: SafeUrlOptions = {}): URL {
    const label = options.label ?? 'URL';
    const raw = typeof target === 'string' ? target.trim() : target.href;

    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        throw new UnsafeUrlError(`\`${label}\` is not a valid URL: ${raw}`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new UnsafeUrlError(`\`${label}\` must be an http(s) URL, got ${url.protocol}`);
    }
    if (url.username !== '' || url.password !== '') {
        throw new UnsafeUrlError(
            `\`${label}\` must not embed credentials (user:password@host). ` +
                'Send the secret in a header or a query token instead.',
        );
    }

    // Everything below judges the CANONICAL hostname: `new URL()` has already
    // turned 0xa9.0xfe.0xa9.0xfe into 169.254.169.254 by this point.
    const hostname = url.hostname.toLowerCase();
    if (hostname === '') {
        throw new UnsafeUrlError(`\`${label}\` has no host: ${url.href}`);
    }

    const refuse = (reason: string): never => {
        throw new UnsafeUrlError(
            `\`${label}\` points at ${hostname}, which is ${reason}. Only public internet hosts are allowed — ` +
                'use a publicly reachable endpoint (Slack, Zapier, Make, n8n, or your own server).',
        );
    };

    const ipv6 = parseIpv6(hostname);
    if (ipv6) {
        const reason = blockedIpv6Reason(ipv6);
        if (reason) refuse(reason);
    } else {
        const ipv4 = parseIpv4(hostname);
        if (ipv4 !== null) {
            const reason = blockedIpv4Reason(ipv4);
            if (reason) refuse(reason);
        } else {
            const host = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
            if (BLOCKED_HOST_NAMES.has(host)) refuse('a local hostname');
            if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
                refuse('an internal-network hostname');
            }
            // "http://intranet/" — a single-label name only resolves through a
            // private search domain, so it can never be a public endpoint.
            if (!host.includes('.')) refuse('a single-label (intranet) hostname, not a public domain');
        }
    }

    if (url.port !== '' && !options.allowNonStandardPort) {
        // WHATWG drops the port when it is the scheme default, so a non-empty
        // port here is always non-standard.
        throw new UnsafeUrlError(
            `\`${label}\` uses the non-standard port ${url.port}. Use the default 80/443, or set the ` +
                'ALLOW_NON_STANDARD_WEBHOOK_PORT=1 environment variable on this Actor to permit other ports.',
        );
    }

    return url;
}

/** True when the operator has opted in to non-standard ports for outbound calls. */
export function nonStandardPortAllowed(env: Record<string, string | undefined> = process.env): boolean {
    const value = env.ALLOW_NON_STANDARD_WEBHOOK_PORT;
    return value === '1' || value?.toLowerCase() === 'true';
}

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

export interface SafeFetchOptions extends SafeUrlOptions {
    /** Redirect hops to follow. Defaults to `MAX_REDIRECT_HOPS`. */
    maxHops?: number;
}

/**
 * `fetch()` with redirects followed by hand, re-validating every hop.
 *
 * The default `redirect: 'follow'` is what lets a public host walk a request
 * onto 169.254.169.254; `redirect: 'manual'` plus `assertSafeOutboundUrl` per
 * hop is the fix. A redirect chain longer than `maxHops`, a 3xx with no
 * Location, or a hop that fails the guard all throw rather than connect.
 */
export async function safeFetch(
    target: string | URL,
    init: FetchInit = {},
    options: SafeFetchOptions = {},
): Promise<Response> {
    const label = options.label ?? 'URL';
    const maxHops = options.maxHops ?? MAX_REDIRECT_HOPS;

    let current = assertSafeOutboundUrl(target, options);
    let method = init.method ?? 'GET';
    let body = init.body;

    for (let hop = 0; ; hop += 1) {
        const response = await fetch(current, { ...init, method, body, redirect: 'manual' });
        if (!REDIRECT_STATUSES.has(response.status)) return response;

        const location = response.headers.get('location');
        try {
            await response.body?.cancel();
        } catch {
            // Nothing to release; a redirect body is empty in practice.
        }

        if (!location) {
            throw new UnsafeUrlError(
                `\`${label}\` (${current.href}) answered HTTP ${response.status} with no Location header; ` +
                    'refusing to guess where it points.',
            );
        }
        if (hop >= maxHops) {
            throw new UnsafeUrlError(
                `\`${label}\` redirected more than ${maxHops} times (last hop: ${current.href} -> ${location}); ` +
                    'refusing to follow further.',
            );
        }

        let next: URL;
        try {
            next = new URL(location, current);
        } catch {
            throw new UnsafeUrlError(
                `\`${label}\` (${current.href}) redirected to an unparseable Location: ${location}`,
            );
        }

        // Re-run the full guard on the hop — this is the whole point of manual mode.
        current = assertSafeOutboundUrl(next, options);

        // Standard fetch semantics: 303 always becomes a GET, and so does a POST
        // that hits 301/302. 307/308 keep the method and the body.
        const isPost = method.toUpperCase() === 'POST';
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && isPost)) {
            method = 'GET';
            body = undefined;
        }
    }
}
