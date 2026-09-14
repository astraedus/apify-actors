# apify-actors

Astraedus' paid Actors for the Apify Store. Monorepo: one actor per directory under `actors/`, each self-contained (own `package.json`, `.actor/actor.json`, `INPUT_SCHEMA.json`, `README.md`), published independently with `apify push` from inside its directory.

| Actor | Dir | Status |
|---|---|---|
| App Store Review Monitor (Google Play + Apple, incremental + webhook) | `actors/app-review-monitor` | **pushed & running on the platform** (`astraedus/app-review-monitor`, build 1.0.2, 97 tests + smoke green). Private until PPE pricing can be set — blocked on one-time payout billing info, see `tasks/lessons.md` |
| Fediverse Scraper (Mastodon + Bluesky, official APIs) | `actors/fediverse-scraper` | building |
| TikTok Growth Monitor (batch profiles, daily deltas, outlier alerts) | `actors/tiktok-growth-monitor` | built + pushed (`0.1.1`), private — pricing blocked on account payout billing info, see `actors/tiktok-growth-monitor/PUBLISHING.md` |
