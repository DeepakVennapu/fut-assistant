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

- 22 tests pass (`npm test`; the Playwright tests need `npm install --no-save playwright` and
  `npx playwright install chromium`, otherwise they skip). They run the extension against a
  **mock** of the Web App whose shapes now follow what the real FC 27 Web App returns.
- **Tested on EA's real FC 27 Web App on 2026-11-16** (branch `fix/real-webapp-testing`):
  - Panel loads (bottom-left, right of EA's 96px nav so it doesn't cover Store/Club).
  - Club export: 77 club + 2 storage cards, matching EA's "Players: 77 items" and SBC Storage.
    Names, ratings, positions (numeric ids 0=GK … 27=LW), nation/league/club names,
    untradeable (`tradable`), `_rareflag` (0, 3, 87) all checked against the screen.
  - Requirements: read correctly on 3 squad SBCs (league/nation counts, same-league/nation/club,
    CLUB_ID with two clubs, PLAYER_QUALITY per player, PLAYER_LEVEL count, chemistry). Key names
    match `SBCEligibilityKey`; scope is GREATER=0/LOWER=1/EXACT=2. Quality 1/2/3 =
    bronze/silver/gold is confirmed (EA's `ItemRatingTier`).
  - Solve & pre-fill on "Red Bull Wiiings Challenge" (f433): EA showed 6/6 requirements, rating
    81, chemistry 14/33, the same as the status line. No 87+ or special cards used. Not submitted.
  - Refuses correctly when the club can't do it ("3 Leagues & 2 Nations").
- **What FC 27 looks like inside** (found read-only):
  - Open SBC: `getCurrentController().childViewControllers[0].viewModel._challenge`;
    squad SBCs are `type: "OPEN_CHALLENGE"` with `formation` like `"f433"`.
  - Slots: `squad.getFieldPlayers()[i].position` = `{ id, typeId, name: 'RCB', typeName: 'CB' }`.
  - EA's own local checks: `challenge.meetsRequirements()`, `isRequirementMet(req)`,
    `squad.getChemistry()`, `squad.getRating()`. One-click reports these after filling.
  - Names: `global.leagueFull.<season>.league<id>`, `global.teamabbr15.<season>.team<id>`
    (season e.g. 2027), `search.nationName.nation<id>`; missing keys localize to `*key`.
  - Club search can return fewer cards than asked for while more remain; storage is
    `services.Item.searchStorageItems(criteria)`.
- **Still unverified:**
  - Brick SBCs (fewer than 11 spots): none were available to test.
  - PLAYER_RARITY_GROUP 4 = "Rare" (still shown as "⚠ double-check").
  - Loan skipping (the test club had no loans).
  - "Points" SBCs (`ONE_CLICK_CHALLENGE`: pick cards worth a score, `squad: null`) are not
    supported; the panel says so. Their requirement keys differ (OVR Min 45 is `{40:[45],41:[1]}`).
- The solver uses cheap fodder out of position when the chemistry requirement allows it
  (e.g. a spare GK at RB). EA accepts this; it's a known behaviour, not a bug.
- When the owner reports a problem, ask for the **Copy SBC requirements** output (under More tools)
  and the exported club file's `meta.sampleKeys`.

## Ideas not started

- Read current prices (e.g. from FUTBIN or FUT.GG) instead of placeholders/estimates.
- Smarter "how many times" (it's greedy now).
- Remember settings such as the protect rating between sessions.

## Working conventions

- After changing `src/`, run `npm run build`, then `npm test`.
- Requires Node 20+. No npm dependencies. Playwright tests skip if Playwright isn't installed.
- This project was first built inside `DeepakVennapu/vennapusHomeAssistant` by mistake and moved
  here. Don't put FUT Assistant work in that repo.
