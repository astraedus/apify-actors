# TikTok Growth Monitor

**Live on the Apify Store:** [apify.com/astraedus/tiktok-growth-monitor](https://apify.com/astraedus/tiktok-growth-monitor)

**Track a batch of TikTok profiles over time.** Point it at a list of profiles, run it on a schedule, and every run tells you what changed since the last one: followers gained or lost, which videos are still picking up views, which videos are brand new, and which ones have gone viral relative to that profile's own normal.

Most TikTok scrapers hand you a pile of videos. This one hands you **the difference between today and yesterday** — which is the part you actually wanted.

---

## Quick start

1. Click **Try for free**.
2. Leave the default input as-is, or replace the profiles with your own.
3. Click **Start**.

The first run saves a baseline and reports absolute numbers. **Growth deltas appear from the second run onwards** — so schedule it (see [Run it daily](#run-it-daily)) and let it build history.

Minimal input:

```json
{
  "profiles": ["tiktok", "khaby.lame"],
  "videosPerProfile": 10
}
```

Profiles accept whatever you have — bare handles (`tiktok`), @handles (`@tiktok`), or full URLs (`https://www.tiktok.com/@tiktok`). Duplicates are merged, so pasting the same profile in two formats never bills you twice.

---

## What you get

One dataset row per profile, per run:

```json
{
  "username": "tiktok",
  "nickname": "TikTok",
  "verified": true,
  "snapshotAt": "2026-09-14T06:00:00.000Z",
  "previousSnapshotAt": "2026-09-13T06:00:00.000Z",

  "followers": 80120000,
  "followersDelta": 120000,
  "likes": 600450000,
  "likesDelta": 450000,
  "videoCount": 1202,
  "videoCountDelta": 2,

  "medianViews": 120000,
  "newVideos": [
    { "id": "7300000000000000003", "url": "https://www.tiktok.com/@tiktok/video/7300000000000000003", "views": 900000, "likes": 70000, "comments": 5000, "shares": 9000, "description": "this one blew up", "sound": "original sound", "createdAt": "2026-09-12T12:00:00.000Z" }
  ],
  "outliers": [
    { "id": "7300000000000000003", "url": "https://www.tiktok.com/@tiktok/video/7300000000000000003", "views": 900000, "viewsMultipleOfMedian": 7.5, "description": "this one blew up", "sound": "original sound" }
  ],
  "topVideo": { "id": "7300000000000000003", "views": 900000, "url": "https://www.tiktok.com/@tiktok/video/7300000000000000003" },
  "videos": [
    { "id": "7300000000000000001", "views": 120000, "viewsDelta": 4000, "likes": 9000, "likesDelta": 300, "comments": 410, "shares": 220, "url": "https://www.tiktok.com/@tiktok/video/7300000000000000001", "sound": "original sound" }
  ],
  "runNote": "Compared against the snapshot from 2026-09-13T06:00:00.000Z; 9 of 10 fetched videos were seen before."
}
```

Plus a compact run summary in the key-value store under `OUTPUT` (this is also what gets POSTed to your webhook):

```json
{
  "actor": "tiktok-growth-monitor",
  "finishedAt": "2026-09-14T06:01:12.000Z",
  "profilesRequested": 10,
  "profilesMonitored": 10,
  "profilesMissing": [],
  "outlierCount": 2,
  "newVideoCount": 7,
  "totalFollowerDelta": 184200,
  "profiles": [
    { "username": "tiktok", "followers": 80120000, "followersDelta": 120000, "newVideos": 2, "outliers": 1, "topVideoUrl": "https://www.tiktok.com/@tiktok/video/7300000000000000003" }
  ]
}
```

### How "viral outlier" is defined

A video is an outlier when its view count is at least **`outlierMultiplier` times the median view count** of that profile's fetched window (default `3`).

Median, not mean — one 50-million-view video would drag a mean upwards and hide everything else. And the comparison is against **the profile's own normal**, so a creator averaging 2,000 views gets flagged at 6,000, while a creator averaging 2 million does not. Outliers need at least 3 videos in the window to mean anything; below that they are suppressed and `runNote` says so.

---

## Run it daily

The whole point is history, so:

1. Open the Actor → **Schedules** → **Create schedule**, cron `0 6 * * *` (daily at 06:00 UTC).
2. Set `webhookUrl` in the input to a Slack/Make/n8n/Zapier endpoint.

Every run POSTs the summary above to that URL as JSON. Alert on whatever matters to you — `outlierCount > 0` to catch a competitor's video going viral, `followersDelta < 0` to catch a decline, `profilesMissing` being non-empty to catch a deleted or renamed account.

`webhookUrl` must be a **public** http(s) endpoint on the default port, with no `user:password@` in the URL. Loopback, private, link-local, cloud-metadata and internal hostnames (`localhost`, `*.local`, `*.internal`, bare single-label names) are rejected before the run starts, in every notation — and redirects are followed by hand, at most three hops, only to addresses that pass the same check. If you genuinely need a non-standard port, set the Actor environment variable `ALLOW_NON_STANDARD_WEBHOOK_PORT=1`. A webhook that is down, slow or refused is logged and ignored — it never fails a run you already paid for.

Snapshots persist in a named key-value store (`tiktok-growth-monitor-state` by default), so history survives across runs automatically. Running two independent schedules over different profile sets? Give each one its own `snapshotStoreName`.

---

## Input reference

| Field | Type | Default | What it does |
|---|---|---|---|
| `profiles` | array | *(required)* | Handles, @handles or profile URLs. Max 200. |
| `videosPerProfile` | integer | `20` | Recent videos fetched per profile. This is the window the median, outliers and per-video deltas are computed over. |
| `outlierMultiplier` | integer | `3` | Flag a video at >= this multiple of the profile's median views. Lower it to `2` for a chattier feed. |
| `snapshotStoreName` | string | `tiktok-growth-monitor-state` | Named key-value store holding per-profile history. |
| `webhookUrl` | string | *(none)* | POST the run summary here as JSON when the run finishes. Must be a public http(s) endpoint (see below). |
| `baseActor` | string | `clockworks/tiktok-profile-scraper` | The scraper supplying raw data. Only change this if it gets renamed. |

Bigger `videosPerProfile` gives a more stable median but costs more at the base scraper (see below). 20 is a good balance; 10 is plenty if you only care about follower growth and brand-new videos.

---

## How this works (and what it costs)

**This Actor does not scrape TikTok itself.** TikTok's anti-bot defenses are an arms race, and re-fighting it badly would just mean unreliable data for you. Instead this Actor calls **[`clockworks/tiktok-profile-scraper`](https://apify.com/clockworks/tiktok-profile-scraper)** — the most-used TikTok scraper on the Apify Store — once per run for the whole batch, and adds the layer on top: persistent snapshots, run-over-run deltas, median-relative outlier detection, and alerting.

That means **two charges land on your account per run**, and you should know both before you schedule anything:

| Layer | What you pay for | Price |
|---|---|---|
| **This Actor** (analytics) | `profile-monitored` — one event per profile, per run | **$0.02** per profile |
| | `outlier-alert` — one per flagged video | **$0.00** (free, visibility only) |
| **Base scraper** (raw data) | `result` — one charge per video returned | **$0.003** per video |

The base scraper's run is started under **your** account with your token, and billed to you directly at its own published price. We do not mark it up and we never see that money.

> The $0.003 figure is measured, not estimated: a real 2-profile x 10-video run on 2026-09-14 charged exactly 20 `result` events for $0.060 total, with every optional add-on event at 0. Per-result prices drop on higher Apify tiers — check [the base Actor's store page](https://apify.com/clockworks/tiktok-profile-scraper) for your plan's rate.

### Worked example: 10 profiles, daily

At the default `videosPerProfile: 20`:

| | Per run | Per month (30 runs) |
|---|---|---|
| This Actor — 10 profiles x $0.02 | $0.20 | **$6.00** |
| Base scraper — 200 videos x $0.003 | $0.60 | **$18.00** |
| **Total** | **$0.80** | **$24.00** |

Dropping to `videosPerProfile: 10` halves the base-scraper half — **$15.00/month total**. You still get follower deltas and new-video detection; the median just gets noisier.

Monitoring 3 profiles daily at 10 videos each costs about **$3.50/month** all in.

**Cost controls built in:**
- Profiles are de-duplicated before anything is called, so a repeated handle is never billed twice.
- A hard `maxItems` ceiling is passed to the base scraper, so it cannot bill you for more than `profiles x (videosPerProfile + 1)` results even if it misbehaves.
- Every separately-charged base-scraper add-on (video/cover/avatar/subtitle downloads) is explicitly disabled — we never use those files.
- **Profiles the base scraper returns no data for are not charged.** They show up in `profilesMissing` instead.
- If the base scraper's run fails, this Actor fails **before charging anything**.

---

## FAQ

**Why are all my deltas `null` on the first run?**
Because there is nothing to compare against yet. The first run saves a baseline; deltas appear on the second run. This is also why `newVideos` is empty on run one — otherwise you would get a profile's entire back catalogue dumped into your webhook.

**Why `null` and not `0`?**
Because "we could not measure growth" and "growth was exactly zero" are different facts, and an alerting rule needs to tell them apart.

**Can I run it more often than daily?**
Yes, but TikTok's public counters update slowly. Hourly runs mostly buy you noise and 24x the cost. Daily is the sweet spot; every 6 hours is defensible for fast-moving accounts.

**A profile came back in `profilesMissing`. Why?**
Usually the handle is misspelled, the account is private, or it was deleted or renamed. You are not charged for it. Check the handle by opening `https://www.tiktok.com/@<handle>` in a browser.

**Do view counts ever go down?**
Occasionally, yes — TikTok revises counters. Deltas are reported as-is, including negative ones, rather than clamped to zero.

**What happens if a video drops out of the fetched window?**
It stops appearing in `videos`, but its last-known counters stay in the snapshot, so if it reappears the delta still works.

**Can I use a different base scraper?**
Set `baseActor`. Anything that accepts `{ profiles, resultsPerPage }` and returns Clockworks-shaped items will work. This exists so a rename does not break your schedule — not as a general plug-in point.

**Is this affiliated with Clockworks or TikTok?**
No. It is an independent Actor that calls a public Apify Actor. Only public profile data is collected — no logins, no cookies, no private data.

---

## Changelog

**0.1** — First release. Batch monitoring, follower/like/video deltas, per-video view deltas, median-relative viral outlier detection, new-video detection, named-store snapshot persistence, webhook summaries.
