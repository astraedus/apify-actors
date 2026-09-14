# Changelog

## Unreleased

- Security: `webhookUrl` is validated against an SSRF guard at input time and again immediately before the POST. Loopback, private, link-local, cloud-metadata and internal hosts are refused in every notation (`0xa9.0xfe.0xa9.0xfe`, `0251.0376.0251.0376`, `127.1`, `0177.0.1`, `::1`, `::ffff:127.0.0.1`, `localhost`, `*.internal`), as are embedded credentials and non-standard ports. Outbound requests no longer follow redirects blindly: at most three hops, each re-checked.

## 1.0 — 2026-09-14

First release.

- Google Play and Apple App Store reviews in one normalised dataset schema.
- Automatic store detection from package names, numeric app IDs, or store URLs from either store.
- Incremental mode (`onlyNew`, on by default): review IDs already emitted are remembered in a named key-value store, so a scheduled run returns only what is new.
- `minRating` / `maxRating` filters — set `maxRating: 2` to be alerted only about angry reviews.
- Optional `webhookUrl`: a JSON summary (per app: new count, average rating, worst reviews) is POSTed after every run.
- Pay-per-event pricing: `app-checked` and `review-emitted`. Already-seen reviews are free.
