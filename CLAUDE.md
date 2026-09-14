# apify-actors -- project knowledge

Route: `~/ops/routes/apify-actors/` (tasks.md + research/INDEX.md). Decision + why: `ops/DECISIONS.md` 2026-09-14. Research: `ops/research/apify-due-diligence-2026-09-14.md`, `ops/research/apify-store-gap-analysis-2026-09-14.md`.

## Stack + rules
- Node 24 / TypeScript, Apify SDK v3 (`apify`) + Crawlee where a crawler is needed. npm only, never bun. One actor per `actors/<name>/`, self-contained; `npm test` inside each dir must pass before `apify push`.
- **Pricing: pay-per-event (PPE) from day one.** Rental listings are retired on the Store 2026-10-01. Define events in `.actor/actor.json` (`pay-per-event`) and charge with `Actor.charge()`; the default input MUST produce a working result inside 5 minutes with zero configuration (Apify runs a daily automated test on default input; 3 failures = public "Under Maintenance" label, 28 more days = deprecation).
- Actor Quality Score factors (official): reliability, popularity, feedback/issue response, ease of use (title/description/input schema/README), pricing transparency, least-privilege permissions. README: quick-start first, `seoTitle` reads like a Google result, `seoDescription` < 160 chars.
- Public data only, no login/cookie inputs, no personal-data enrichment. Legal exposure sits with the publisher (us), not Apify.
- Dogfood: every actor here replaces or feeds something we already run (our own apps' reviews, our Mastodon account, our TikTok analytics poller).
- Account: Astraedus (CEO-created), token at `~/.secrets/apify-token`, CLI `apify`. Payout/KYC = Anti's legal identity, asked once when a payout is pending.

## Testing
- Unit tests with `node --test` (or vitest) per actor; a `smoke` script that runs the actor locally (`apify run`) against the default input and asserts >=1 dataset item.
