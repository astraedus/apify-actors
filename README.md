# apify-actors

Astraedus' paid Actors for the Apify Store. Monorepo: one actor per directory under `actors/`, each self-contained (own `package.json`, `.actor/actor.json`, `INPUT_SCHEMA.json`, `README.md`), published independently with `apify push` from inside its directory.

| Actor | Dir | Status |
|---|---|---|
| App Store Review Monitor (Google Play + Apple, incremental + webhook) | `actors/app-review-monitor` | pushed + running (`szhCIgo7C3TT470R1`, build 1.0.2, 97 tests); private until payout billing + public profile |
| Fediverse Scraper (Mastodon + Bluesky, official APIs) | `actors/fediverse-scraper` | pushed + running (`84KPWnTsBOvgAWB7M`, build 1.0.2, 343 tests); private until payout billing + public profile |
| TikTok Growth Monitor (batch profiles, daily deltas, outlier alerts) | `actors/tiktok-growth-monitor` | pushed + running (`6gqmdiZL8pzYaGfhT`, build 0.1.2, 138 tests); private until payout billing + public profile |
