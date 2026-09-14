# apify-actors — lessons

## Publishing / monetization (measured 2026-09-14, CLI 1.10.0)

- **`pricingInfos` IS a settable field on `PUT /v2/acts/{actorId}`**, despite the API reference listing it as response-only and the PPE docs saying prices are set "in Apify Console". Proved by probing error *types*: an unknown field returns `schema-validation`, `pricingInfos` returns the semantic `cannot-monetize-without-payout-billing-info`. Re-confirmed independently by the tiktok-growth-monitor lane the same day.
- **The real gate is one-time payout billing info** at `https://console.apify.com/actors/{actorId}/publication`. It is a KYC step tied to Anti's legal identity, so it is a human ask, not an API call. Until it exists, every `pricingInfos` write is rejected — and rejected *before* shape validation, so you cannot verify your payload nesting either.
- **`seoTitle` has an undocumented hard 60-character limit.** Over it, the whole PUT fails with `schema-validation`.
- Settable via the API today: `title`, `description`, `seoTitle`, `seoDescription`, `categories`, `isPublic`. Not settable: pricing (until billing), anything in `actor.json`.
- **Do not flip `isPublic` before pricing exists** — a public actor with no `pricingInfos` is a FREE actor, and price changes on an actor that already has users carry notice obligations. Order is: billing info → pricing → publish.
- `apify push` builds remotely and tags the build; `apify call <user>/<actor>` runs it on the platform. `--silent` prints nothing, so verify a run through the API (`/v2/acts/{id}/runs/last` → `/v2/datasets/{id}/items`), never from the CLI's exit code alone.

## Build lane

- **Node 24 runs TypeScript directly** — `apify/actor-node:24` + native type stripping means no tsc emit, no `dist/`, and `node --test test/*.test.ts` runs TS tests with zero tooling. Verified in a real platform build.
  - Requires `"type":"module"`, `.ts` extensions in import specifiers, and tsconfig `erasableSyntaxOnly` + `allowImportingTsExtensions` + `noEmit`.
  - **Constructor parameter properties are not erasable** (`constructor(private readonly x)`) → TS1294. Use `#private` fields.
  - Put `RUN node src/selftest.ts` in the Dockerfile importing every runtime module, so a broken import fails the BUILD, not the first customer run.
- `.actor/actor.json` resolves `input` / `readme` / `changelog` / `storages.dataset` **relative to `.actor/`** (hence `"../README.md"`). `apify validate-schema` validates the input + dataset schemas only.

## Data sources

- **Apple's public review RSS (`itunes.apple.com/{cc}/rss/customerreviews/...`) is unreliable.** On 2026-09-14 it served 50 entries, then twenty minutes later began answering HTTP 200 with a valid but *empty* feed for every app, country and page — reproduced from our IP and from an Apify us-east-1 container, so it is not an IP throttle. Treat App Store coverage as best-effort; Google Play is the reliable path.
  - **Disambiguate an empty feed against the iTunes lookup API** (`/lookup?id=&country=`), a separate service that stayed up and reports `userRatingCount`. Millions of ratings + empty feed = the feed is broken; 0 ratings + empty feed = genuinely unrated; `resultCount: 0` = bad app id. Three causes, three messages — otherwise a review monitor reports "nothing new" forever while the source is down.
  - The RSS carries **no developer replies**, and caps at 10 pages × 50 = 500 reviews.
  - The `apps.apple.com` page does server-render reviews (`<script id="serialized-server-data">` → `data[0].data.shelfMapping.allProductReviews.items[].review`), but only ~8 *featured* (not newest) reviews, with no app version and no developer reply — **not a usable fallback for a monitor**. Don't rebuild it.
- **`google-play-scraper` v10 mistypes its `sort` export** as the enum type rather than `typeof`, so `gplay.sort.NEWEST` fails `tsc` while working at runtime. Read it through a cast and pin the value (2) with a guard test, or a package bump silently re-sorts every customer's feed by relevance.
- **Google Play hides its public review count for low-volume apps.** Absent means UNKNOWN, not zero — Nudge reports no count yet returns reviews. Reading absent as 0 would flag every small app as broken.
- Our real package names: `dev.astraedus.nudge`, `com.raeduslabs.origo`, `com.raeduslabs.soulsyncapp`. **Not** `com.raeduslabs.soulsync` — that 404s on Play.

## Product shape

- The Store runs a **daily automated test on the default input** (must succeed within 5 minutes). 3 consecutive failure-days → "Under Maintenance" label; 28 more days → deprecation.
- For an **incremental** actor this has a non-obvious consequence: with `onlyNew` on, a default run that monitors only low-traffic apps legitimately emits nothing after day one and looks broken. **Keep at least one high-volume target in the defaults.**
- Charge PPE events **after** the upstream answers, never before, and never advance seen-state for a failed check — otherwise a transient outage silently burns the reviews it could not fetch and bills for the privilege.
