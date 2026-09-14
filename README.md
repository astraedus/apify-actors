# apify-actors

Astraedus' paid Actors for the Apify Store. Monorepo: one actor per directory under `actors/`, each self-contained (own `package.json`, `.actor/actor.json`, `INPUT_SCHEMA.json`, `README.md`), published independently with `apify push` from inside its directory.

| Actor | Dir | Status |
|---|---|---|
| App Store Review Monitor (Google Play + Apple, incremental + webhook) | `actors/app-review-monitor` | building |
| Fediverse Scraper (Mastodon + Bluesky, official APIs) | `actors/fediverse-scraper` | built, awaiting `apify push` (needs `~/.secrets/apify-token`) |
| TikTok Growth Monitor (batch profiles, daily deltas, outlier alerts) | `actors/tiktok-growth-monitor` | building |
