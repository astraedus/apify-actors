# Changelog

## 1.0 — 2026-09-14

First release.

- Google Play and Apple App Store reviews in one normalised dataset schema.
- Automatic store detection from package names, numeric app IDs, or store URLs from either store.
- Incremental mode (`onlyNew`, on by default): review IDs already emitted are remembered in a named key-value store, so a scheduled run returns only what is new.
- `minRating` / `maxRating` filters — set `maxRating: 2` to be alerted only about angry reviews.
- Optional `webhookUrl`: a JSON summary (per app: new count, average rating, worst reviews) is POSTed after every run.
- Pay-per-event pricing: `app-checked` and `review-emitted`. Already-seen reviews are free.
