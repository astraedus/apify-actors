# Mastodon & Bluesky Scraper (Fediverse)

**Live on the Apify Store:** [apify.com/astraedus/fediverse-scraper](https://apify.com/astraedus/fediverse-scraper)

Scrape **profiles, posts and hashtag timelines** from Mastodon and Bluesky and get them back in **one normalized schema**, so you can analyse both networks in the same spreadsheet without reconciling two different JSON shapes.

It runs on the platforms' **official public APIs** — `docs.joinmastodon.org` and Bluesky's public AppView. No login, no cookies, no password. That also means it does not break the way scrapers built on private endpoints do.

---

## Quick start

1. Click **Start**. The default input already works — no configuration needed.
2. Wait about a minute.
3. Download your data as JSON, CSV, Excel or feed it to the API.

The default run collects 20 posts each from two Mastodon accounts, the `#opensource` hashtag, and Bluesky's official account.

To scrape your own targets, paste them into **Targets**, one per line:

```
@Gargron@mastodon.social
#opensource@mastodon.social
https://mastodon.social/@Mastodon
bsky.app
alice.bsky.social
https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l
```

The platform is detected per line, so you can mix both networks in one run.

### Supported target formats

| You have | Write it as | Gets you |
|---|---|---|
| A Mastodon account | `@user@instance` or `user@instance` | Profile + their posts |
| A Mastodon profile URL | `https://mastodon.social/@Gargron` | Profile + their posts |
| A Mastodon hashtag | `#opensource@mastodon.social` | Posts using that tag |
| A Mastodon post | `https://mastodon.social/@user/117265110451542347` | That single post |
| A Bluesky handle | `bsky.app`, `alice.bsky.social` | Profile + their posts |
| A Bluesky DID | `did:plc:z72i7hdynmk6r22z27h6tvur` | Profile + their posts |
| A Bluesky post | `https://bsky.app/profile/bsky.app/post/3l6o…` or an `at://` URI | That single post |
| Bluesky people search | `bsky:actors:climate science` | Matching profiles |

Any Mastodon instance works — `fosstodon.org`, `hachyderm.io`, your own server. Not just `mastodon.social`.

---

## Sample output

Every row has the same keys on both platforms. A Mastodon post:

```json
{
  "platform": "mastodon",
  "type": "post",
  "id": "117265110451542347",
  "url": "https://mastodon.social/@Gargron/117265110451542347",
  "author": {
    "handle": "@Gargron@mastodon.social",
    "displayName": "Eugen Rochko",
    "url": "https://mastodon.social/@Gargron",
    "followers": 382512,
    "following": 740,
    "postsCount": 82249,
    "createdAt": "2016-03-16T00:00:00.000Z",
    "bio": "Executive Strategy & Product Advisor, Founder of @Mastodon.",
    "avatar": "https://files.mastodon.social/accounts/avatars/000/000/001/original/6b2384b33799a0dd.png"
  },
  "text": "Plain text, with the HTML stripped and entities decoded.",
  "createdAt": "2026-09-13T18:19:44.787Z",
  "language": "en",
  "replies": 1,
  "reposts": 0,
  "likes": 12,
  "media": [
    { "url": "https://files.mastodon.social/media_attachments/…/original/x.png", "type": "image", "alt": "Alt text as written by the poster" }
  ],
  "hashtags": ["opensource", "selfhosted"],
  "mentions": ["@Mastodon@mastodon.social"],
  "inReplyTo": "117265014180109770",
  "isRepost": false,
  "target": "@Gargron@mastodon.social",
  "scrapedAt": "2026-09-14T07:04:11.201Z"
}
```

And a Bluesky post — same keys, different values:

```json
{
  "platform": "bluesky",
  "type": "post",
  "id": "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3mv6jm4auic2g",
  "url": "https://bsky.app/profile/bsky.app/post/3mv6jm4auic2g",
  "author": { "handle": "@bsky.app", "displayName": "Bluesky", "followers": 34893929, "…": "…" },
  "text": "Thanks for being with us here on Bluesky.",
  "createdAt": "2026-09-10T16:59:29.774Z",
  "language": "en",
  "replies": 8,
  "reposts": 16,
  "likes": 317,
  "media": [{ "url": "https://video.bsky.app/watch/…/playlist.m3u8", "type": "video", "alt": null }],
  "hashtags": [],
  "mentions": ["@lightlyspicy.bsky.social"],
  "inReplyTo": "at://did:plc:2buz4gf5sew3rdwzbxsvcd4s/app.bsky.feed.post/3mv6ghymh3s27",
  "isRepost": false,
  "target": "bsky.app",
  "scrapedAt": "2026-09-14T07:04:12.880Z"
}
```

### Field reference

| Field | Notes |
|---|---|
| `platform` | `mastodon` or `bluesky` — the only column you ever need to branch on |
| `type` | `profile` or `post` |
| `id` | Status id (Mastodon) or `at://` URI (Bluesky). Unique per row |
| `text` | Plain text. Mastodon HTML is stripped and entities decoded |
| `media` | `type` is `image`, `video`, `gifv`, `audio` or `external` (a link card). `alt` is the poster's own alt text, or `null` |
| `mentions` | Canonical handles, e.g. `@user@instance` or `@alice.bsky.social` |
| `isRepost` | `true` when the row reached the feed as a boost/repost. The row is credited to the **original** author |
| `inReplyTo` | Parent post id/URI, or `null` |
| `target` | The input line that produced this row, for tracing |
| `raw` | The untouched API object. Only present when **Include raw API response** is on |

Fields that do not apply to a row are `null`, never missing — a `profile` row still has a `likes` key.

### Modes

| Mode | Account target | Hashtag target | Single post target |
|---|---|---|---|
| `both` *(default)* | Profile row + post rows | Post rows | The post row |
| `profiles` | Profile row | Profiles of the accounts posting under the tag | The author's profile |
| `posts` | Post rows | Post rows | The post row |

---

## Use cases

**Brand and community monitoring.** Track a hashtag across Mastodon instances and watch the accounts driving it. Run it on a schedule and diff the results to see what is new.

**Research datasets.** The fediverse is one of the few large social networks whose public data is available through a documented, sanctioned API. Normalized output means a Mastodon corpus and a Bluesky corpus load into the same table.

**Migration from X/Twitter.** Following an audience that moved to Mastodon and Bluesky? Pull both, in one run, in one schema, instead of maintaining two integrations.

**Competitive intelligence.** Follower counts, post cadence and engagement for any set of public accounts on either network.

**Feeding an LLM or a search index.** `text` is already plain text, so there is no HTML to strip downstream.

---

## Pricing

Pay per event. You pay for results, not for runtime.

| Event | Price |
|---|---|
| Profile scraped | **$0.002** |
| Post scraped | **$0.001** |

**Worked example — monitoring 50 Mastodon accounts, 100 posts each:**

| Item | Count | Unit | Cost |
|---|---|---|---|
| Profiles | 50 | $0.002 | $0.10 |
| Posts | 5,000 | $0.001 | $5.00 |
| **Total** | | | **$5.10** |

Comparable social scrapers charge $0.005–$0.01 per item, which would put the same 5,050 items at $25–$50. This Actor is cheaper because it reads an official API instead of paying for proxies and headless browsers.

**A cheaper run:** the default input (4 targets × 20 posts) returns about 65 rows — 3 profiles and 62 posts — for roughly **$0.07**, in about 10 seconds.

Ways to spend less:
- Lower **Max posts per target** — pagination stops as soon as the limit is hit.
- Set **Only posts since** — pagination stops as soon as the feed passes the date.
- Use `posts` mode if you do not need profile rows.

Duplicates are never billed twice: a post reached through two different targets is stored and charged once.

---

## Limits and FAQ

**Do I need a Mastodon or Bluesky account?**
No, and the Actor will never ask for one. Every endpoint it uses serves anonymous requests.

**Is Bluesky hashtag or keyword search supported?**
**No** — and this is the one real gap, so it is worth stating plainly. Bluesky refuses unauthenticated `app.bsky.feed.searchPosts` requests from datacenter IP addresses. Supporting it would mean asking you for a Bluesky app password, which this Actor does not do. Bluesky **people** search (`bsky:actors:…`), profiles, author feeds and individual posts all work fine. For hashtag monitoring, use a Mastodon hashtag target.

**Which Mastodon instances work?**
Any instance running a default configuration. The Actor uses only the public REST endpoints (`/api/v1/accounts/lookup`, `/api/v1/accounts/:id/statuses`, `/api/v1/timelines/tag/:tag`, `/api/v1/statuses/:id`). An instance whose admin has restricted public access, or one in authorized-fetch mode, will return an error for that target — the rest of the run continues.

**What about cross-instance search by URL?**
Resolving an arbitrary remote post URL requires Mastodon's `/api/v2/search?resolve=true`, which needs a token. Instead, point the Actor at the post's **own** instance URL (e.g. `https://fosstodon.org/@user/12345`) and it reads it directly, no auth needed.

**How fast is it?**
Requests to each server are paced to stay well inside published limits — Mastodon allows 300 requests per 5 minutes per IP, and the Actor also reads each server's rate-limit headers and slows down further when a budget runs low. Expect roughly 40 posts per request on Mastodon and up to 100 on Bluesky.

**What happens if one target fails?**
That target is recorded as a failure and the run continues. A summary — counts, duplicates skipped, and every failure with its reason — is written to the key-value store as `RUN_SUMMARY`. The run only fails outright if **nothing** could be collected.

**Are replies and boosts included?**
Not by default. Turn on **Include replies** and **Include boosts / reposts** if you want them. Boosted rows carry `isRepost: true` and are credited to the original author.

**Is private or follower-only content included?**
No. Only public posts are visible to an anonymous client, which is all this Actor ever sees.

---

## Legal

This Actor reads publicly available data through the official, documented APIs of each platform. You are responsible for how you use the output, including compliance with GDPR and other data-protection law where personal data is involved. It does not collect private posts, follower-only posts, direct messages, email addresses or any login-gated data.
