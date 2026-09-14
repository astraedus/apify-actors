# App Store & Google Play Review Monitor

Watch your apps' reviews on both stores and get **only the reviews that are actually new**.

Most review scrapers re-download the same backlog every run and hand you a pile you have already read. This one remembers what it emitted last time, so a daily schedule gives you today's reviews — and only today's reviews. Point it at a webhook and a 1-star review turns into a Slack message minutes after it lands.

## Quick start

1. Press **Start**. The default input monitors four real apps (three on Google Play, one on the App Store) and finishes in well under a minute — no configuration, no account linking.
2. Open the **Dataset** tab to see the reviews it found.
3. Replace the `apps` list with your own, hit **Start** again, then **Schedule** it (see [Scheduling](#scheduling)).

You can paste any of these into `apps` and the store is detected automatically:

| What you have | Example |
|---|---|
| Google Play package name | `com.spotify.music` |
| Google Play URL | `https://play.google.com/store/apps/details?id=com.spotify.music` |
| Apple numeric app ID | `324684580` |
| App Store URL | `https://apps.apple.com/us/app/spotify/id324684580` |

A country baked into a URL (`.../gb/app/...`, `&gl=DE`) applies to that app only; everything else uses the `countries` list.

## What you get

One dataset row per review, identical across both stores:

```json
{
  "store": "google-play",
  "appId": "dev.astraedus.nudge",
  "appName": "Nudge: App Blocker",
  "country": "us",
  "reviewId": "6ca5d4fd-5ef6-49bc-877e-159f062a5a91",
  "rating": 3,
  "title": null,
  "text": "It doesn't work sometimes",
  "author": "sepehr",
  "date": "2026-09-06T09:09:52.941Z",
  "appVersion": "1.15.2",
  "developerReply": { "text": "Sorry about that — fixed in 1.16.", "date": "2026-09-07T10:00:00.000Z" },
  "url": "https://play.google.com/store/apps/details?id=dev.astraedus.nudge&reviewId=6ca5d4fd-...",
  "isNew": true
}
```

| Field | Notes |
|---|---|
| `store` | `google-play` or `app-store` |
| `appId` | Package name (Play) or numeric track ID (Apple) |
| `appName` | Resolved from the store; `null` if the ID is unknown |
| `country` | Storefront the review came from |
| `reviewId` | Stable store-side ID — this is the de-duplication key |
| `rating` | 1–5, or `null` if the store omitted it |
| `title` | Always `null` on Google Play (Play removed review titles years ago) |
| `text` | Review body; empty string for a rating with no text |
| `date` | ISO-8601 UTC |
| `appVersion` | Version the reviewer was on, when the store exposes it |
| `developerReply` | `{ text, date }`, or `null`. **Google Play only** — Apple's public feed does not expose developer responses |
| `url` | Direct link to the review (Play) or the app's store page (Apple) |
| `isNew` | Always `true` for emitted rows, so downstream tools can key on it |

### Webhook payload

Set `webhookUrl` and this gets POSTed once per run, after the dataset is written:

```json
{
  "actor": "app-review-monitor",
  "runAt": "2026-09-14T06:00:00.000Z",
  "totals": { "appsChecked": 5, "newReviews": 18, "errors": 0 },
  "apps": [
    {
      "store": "google-play",
      "appId": "com.spotify.music",
      "appName": "Spotify",
      "country": "us",
      "newCount": 12,
      "avgRating": 3.42,
      "firstRun": false,
      "lowestReviews": [ { "reviewId": "...", "rating": 1, "title": null, "text": "Crashes on launch", "author": "...", "date": "...", "url": "..." } ]
    }
  ]
}
```

Works as-is with Slack workflow webhooks, Zapier catch hooks, Make, n8n, or your own endpoint. A webhook that is down or slow is logged and ignored — it never fails a run you already paid for.

## Scheduling

The actor is built to be scheduled; running it once by hand only gives you the backlog.

1. Run it once with your apps to establish the baseline (the first run per app emits up to `maxReviewsPerApp` reviews).
2. **Actor → Schedules → Create schedule**, cron `0 * * * *` for hourly or `0 8 * * *` for a daily 08:00 digest.
3. Keep `onlyNew` on. Every later run emits only review IDs that no previous run emitted.
4. Set `webhookUrl` so you find out without opening Apify.

**Alert only on angry reviews:** set `maxRating` to `2` and point `webhookUrl` at Slack. You get a message only when someone is unhappy.

**Two schedules over the same apps:** give each one a different `stateStoreName` (for example `hourly-alerts` and `weekly-digest`) so they do not consume each other's new reviews.

The seen-review IDs live in a named key-value store on your own account (default `app-review-monitor-state`), one record per app+country. Set `resetState` to `true` for a single run to forget them and re-emit a fresh baseline.

## Pricing

Pay-per-event. You pay for work done, not for time:

| Event | Price | Charged |
|---|---|---|
| `app-checked` | $0.01 | Once per app **per country** per run — covers the app lookup and every review page fetched for it |
| `review-emitted` | $0.002 | Once per review row written to the dataset |

Reviews you have already seen are **free**: a run that finds nothing new costs only the `app-checked` events.

**Worked example — 5 apps, 1 country, checked daily, ~20 new reviews a day across all of them:**

| | Per day | Per 30 days |
|---|---|---|
| 5 × `app-checked` @ $0.01 | $0.05 | $1.50 |
| 20 × `review-emitted` @ $0.002 | $0.04 | $1.20 |
| **Total** | **$0.09** | **≈ $2.70** |

The one-off first run costs more because it backfills: 5 apps × 200 reviews = 1,000 rows ≈ $2.00, plus $0.05 of checks. Lower `maxReviewsPerApp` if you only care about what happens from today onward.

Your Apify spending limit is respected inside the run: when the limit is reached the actor stops emitting rather than pushing rows it cannot charge for.

## Limits

- **Apple:** the public review feed serves at most 10 pages × 50 reviews = **500 reviews per app per country**, newest first, and carries no developer replies. Apps with no reviews in a storefront return nothing — that is Apple's answer, not an error.
- **Google Play:** the actor asks for up to `maxReviewsPerApp` (ceiling 1,000) newest-first reviews per app per country.
- **Countries:** each app is checked once per country in `countries`, and each pair is a separate `app-checked` event. Two apps × three countries = six events per run.
- **Public data only.** No login, no cookies, no personal-data enrichment — the actor reads the same public store pages and feeds a browser would.
- Apps in `apps` are capped at 100 per run.

## FAQ

**Why did my second run return nothing?**
That is the point — nothing new had appeared. Check the run log: it reports how many reviews were fetched and how many were skipped as already seen.

**Why did the first run return a lot?**
The first run per app+country has no history, so it emits a baseline of up to `maxReviewsPerApp`. Every run after that is a delta.

**How do I re-export everything?**
Either set `onlyNew` to `false` (re-emits every fetched review each run) or set `resetState` to `true` for one run (forgets history, then resumes incrementally).

**Can I monitor a competitor's app?**
Yes. Everything it reads is public store data.

**Why is `title` always null for Google Play?**
Google Play removed review titles from its public store pages. Apple still has them.

**An app returned zero reviews — is it broken?**
Check the package name or numeric ID against the live store page, and check the country. `dev.astraedus.nudge` in `us` is a valid pair; `dev.astraedus.nudge` in `xx` is not.

---

Built by [Astraedus](https://apify.com/astraedus). Found a bug or want a field added? Open an issue on the Actor's **Issues** tab — they get answered.
