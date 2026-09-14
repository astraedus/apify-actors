# Publishing this Actor

Internal notes. The user-facing store copy is `README.md`.

## Current state (2026-09-14)

| | |
|---|---|
| Actor ID | `6gqmdiZL8pzYaGfhT` (`astraedus/tiktok-growth-monitor`) |
| Build | `0.1.2`, SUCCEEDED |
| Platform run | `NQBdRU50CuanhVoOC` — SUCCEEDED in 34s, 2/2 profiles, 3 outliers |
| Listing metadata | **applied** (title, description, seoTitle, seoDescription, categories) |
| PPE pricing | **BLOCKED** — see below |
| Visibility | **private**, deliberately |

## The one blocker: payout billing info

Applying pricing fails with:

```
HTTP 400 cannot-monetize-without-payout-billing-info
To monetize your Actor, you need to set your payout billing info at
https://console.apify.com/actors/6gqmdiZL8pzYaGfhT/publication
```

This is a **once-per-account** legal/tax step (payout identity + tax details), not a per-Actor one. No API or CLI can substitute for it. Until it is done:

- **Do not make this Actor public.** A public Actor with no pricing is a free Actor, and introducing pricing afterwards is a worse experience for anyone who already installed it.
- The Actor is fully built, tested and verified working — only the price tag is missing.

### After billing info is set

One command applies pricing, SEO and public visibility together, then verifies by reading the state back:

```bash
cd actors/tiktok-growth-monitor
npm test                                   # 138 tests must pass first
node scripts/apply-store-config.mjs --public
```

Then confirm the live page renders: <https://apify.com/astraedus/tiktok-growth-monitor>

## What is settable from the API vs the Console

Verified empirically on 2026-09-14, because the docs are ambiguous here:

- `PUT /v2/acts/:actorId` **does** accept `pricingInfos` with a `PAY_PER_EVENT` block. Sending it returns the monetization-specific error above rather than being ignored, and removing it lets the same request through — so the field reaches the monetization path and is gated only on billing info. (A field the API merely ignored would have returned 200.)
- Confirmed settable via API right now: `title`, `description`, `seoTitle`, `seoDescription`, `categories`, `isPublic`.
- Undocumented hard limit found the hard way: **`seoTitle` must be <= 60 characters** or the whole PUT fails with `schema-validation`. Pinned by a test.
- `.actor/actor.json` supports **no** pricing or SEO keys at all. That is why `.actor/store-config.json` exists.

## Cost of a run (measured, not estimated)

From base-actor run `FcnOoj1exiAAZQgBW`, 2 profiles x 10 videos:

- 20 `result` events x $0.003 = **$0.060**, no fixed per-run fee.
- Every optional add-on event charged **0** (`filter-applied`, `video-download`, `follower-dataset-item`, ...), confirming `baseActorInput()` correctly disables them.

Our own layer adds `profile-monitored` at $0.02/profile on top, billed to the end user.

## Watch item: the daily automated test

Apify runs a daily test on the default input for public Actors. Ours calls a paid base Actor, so that test consumes real credit (~$0.06/run at the default 2 profiles x 10 videos, roughly $1.80/month). That is the cost of the reliability badge. The default input is deliberately kept small for exactly this reason — do not raise the `profiles` or `videosPerProfile` prefills without re-checking this.
