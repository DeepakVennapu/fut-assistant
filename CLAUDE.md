# FUT Assistant – context for Claude

Read this first in any session on this repo. It records what the project is for, the decisions
already made, and where it stands, so the work can continue from any device.

## What this is

A personal tool for EA FC Ultimate Team SBCs (Squad Building Challenges). It was built after
looking at FUT Genie, a third-party SBC solver. The owner's two problems with FUT Genie:

1. Its mobile app has you sign in to EA inside *their* app, so it can see your EA session.
2. It's paid and tiered (free plan: 5 solves a day).

FUT Assistant does the same core job locally: no third-party login, no limits.

## Hard rules (decided with the owner – don't relax without asking)

- **Never submit an SBC.** The tool fills a squad; the owner checks it and clicks Submit.
- **One squad per click**, at least **30 seconds** between fills, and **paced reads** of the club
  (one page of about 91 cards every 1.5–3 s). Human pace, never bulk or loops.
- **Never buy, sell, list, quick-sell or move cards**, and never touch the transfer market.
- **Nothing leaves the machine** except EA's own Web App calls. No servers, no telemetry, and EA
  credentials are never handled.
- **Never guess silently.** Requirements that can't be read are shown as "not checked" and guessed
  ones as "⚠ double-check". Don't fill a squad that fails the requirements.

## Ban risk (researched November 2026)

- EA's FC rules ban bots, automation and tools like auto-buyers, and warn against third-party
  extensions. The User Agreement (reportedly section 7.C) covers unauthorized third-party programs.
- There were credible but unconfirmed reports of a ban wave around the FC 27 launch naming FUT
  Genie and PaleTools. An FC 24 EA forum thread reported a perma-ban for using PaleTools "only for
  SBCs". FUT Genie says there are no bans; that claim is self-interested.
- Conclusion shared with the owner: filling the squad while the owner submits is *lower* risk than
  auto-submitting, but not zero. The owner accepted this. Keep saying it plainly when relevant.

## How it works

- `src/`: the solver, plain ES modules with no dependencies.
  - `model.js`: card shape and fallback prices.
  - `rating.js`: team rating, using the community formula.
  - `chemistry.js`: FC chemistry, with position matching across several formations.
  - `requirements.js`: requirement kinds `teamRating`, `chemistry`, `playerChem`, `count`,
    `sameAttr`, `distinct`, `each`, `unsupported`.
  - `solver.js`: simulated annealing, then a pass that keeps the squad valid while making it
    cheaper. Fodder order: storage duplicates → untradeables → tradeables; cards rated 87+ are
    protected by default.
  - `analyze.js`: "how many times can I do this SBC with what I own?"
- `web/` + `server.js`: local page at `http://127.0.0.1:5177`. `src/cli.js` is the CLI.
- `extension/`: a Chrome MV3 extension. Its scripts run in the Web App page's own context
  (`"world": "MAIN"`), in this order:
  - `solver-bundle.js`: GENERATED from `src/` by `npm run build`. A test fails if it's stale.
  - `club-export.js`: the panel, paced club and storage reads, and the club export file.
  - `prefill.js`: finds the open SBC, places cards, saves the draft once, enforces the 30 s wait.
  - `sbc-reader.js`: maps EA's requirement data to the solver's format, using the Web App's
    `SBCEligibilityKey` and `SBCEligibilityScope` tables at runtime.
  - `one-click.js`: **Solve & pre-fill**. Reads the SBC, uses the cached club, solves, fills.

## Status

- Merged to `main` (PR #1 code, PR #2 this file). 18 tests pass (`npm test`). The Playwright tests run the extension
  against a **mock** of the Web App.
- **Not yet tried on EA's real Web App.** The Web App's internals are undocumented, so these are
  guesses that may need fixing on first real use:
  - finding the open SBC (`findOpenChallenge`);
  - item fields (`toCard`): positions, rarity, untradeable, base id;
  - league, nation and club name lookups (they fall back to ids);
  - requirement key names; quality values 1/2/3 and rarity group 4 = "Rare" are guesses.
- When the owner reports a problem, ask for the **Copy SBC requirements** output (under More tools)
  and the exported club file's `meta.sampleKeys`.

## Next step: test on the real Web App

This must run on the owner's own Mac, in their own Chrome, signed in by them. Don't do it from a
cloud session: EA is blocked there, and a data-centre login is a needless account risk. The owner
logs in; never handle their EA credentials. Never submit. Inspect EA internals read-only.

1. Load `extension/` unpacked. Check that the panel appears in the bottom-left of the Web App.
2. More tools → Export club. Check names, ratings, positions, nation/league/club names,
   rare/special, untradeable, storage, and that loans are skipped. Look at `meta.sampleKeys`.
3. Open a simple SBC, then a league/nation hybrid. More tools → Copy SBC requirements. Compare each
   requirement with what EA shows.
4. Solve & pre-fill. Check that cards appear and that EA's rating/chemistry match the status line;
   check positions and that no protected cards were used. The owner reviews and submits.
5. Repeat on an SBC with fewer than 11 players (locked "brick" spots).

Fix on a branch. Update the mock in `test/extension.test.js` to the real object shapes found. Run
`npm run build` if `src/` changed, then `npm test`. Record what's now verified under "Status", and
open a PR. Don't merge without the owner's OK.

## Ideas not started

- Read current prices (e.g. from FUTBIN or FUT.GG) instead of placeholders/estimates.
- Smarter "how many times" (it's greedy now).
- Remember settings such as the protect rating between sessions.

## Working conventions

- After changing `src/`, run `npm run build`, then `npm test`.
- Requires Node 20+. No npm dependencies. Playwright tests skip if Playwright isn't installed.
- This project was first built inside `DeepakVennapu/vennapusHomeAssistant` by mistake and moved
  here. Don't put FUT Assistant work in that repo.
