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
  - `club-export.js`: paced club and storage reads, card mapping, settings, the club export file.
  - `prefill.js`: finds the open SBC, places cards, saves the draft once, enforces the 30 s wait.
  - `sbc-reader.js`: maps EA's requirement data to the solver's format, using the Web App's
    `SBCEligibilityKey` and `SBCEligibilityScope` tables at runtime.
  - `work-area.js`: points SBCs. Selects cards in the Work Area like a tap; never reviews or submits.
  - `one-click.js`: `screen()` (what's open), `plan()` (solve, structured result) → `apply()`.
  - `panel.js`: the panel. Reads `screen()` once a second (local only), renders plans,
    outcomes and notices (`H.notice(title, { lines, action })`), settings and troubleshooting.

## Status

- 37 tests pass (`npm test`; the Playwright tests need `npm install --no-save playwright` and
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
- **Added after the first real test** (branch `feat/values-preview-protect`):
  - Card values from EA's own item data (`_marketAverage`, else `_itemPriceLimits.minimum`).
  - Preview before filling (`one-click.js` `plan()` → `apply()`), with untick-and-solve-again.
  - Kept cards: favourites (`item.isFavorite === true`), unticked cards kept for good, and the
    protect rating, all in `localStorage` under `futAssistant.*` (this browser only).
  - Draft awareness (`prefill.js` `cardsInOtherDrafts`): the tool's own fills, remembered for a
    week, plus squads of SBCs already loaded in `services.SBC.repository.sets`. EA's
    `isItemInSquad` only covers the active squad.
  - Points SBCs: SBC Storage tab loaded with `vm.setActiveTab('storage')` then back; whole club
    loaded; `planBatches` says how many submissions the target takes or how far short it is.
  - "What to buy" on a refusal (estimated prices; plain cards have no league/nation/club).
  - The "can do this N more times" line was removed from the extension's status.
  - Checked live on 2026-11-16: the preview (nothing placed until "Fill these"), EA values
    (73 of 79 cards had a market average), the points "short by" line and draft awareness
    (11 cards of a loaded draft left out). Found live and fixed: the Work Area creates an empty
    state for every tab up front, and squad SBCs now keep active-squad cards too.
  - Checked live after that: "Fill these" on "Red Bull Wiiings Challenge" (EA showed 6/6, rating
    82, chemistry 27/33, same as the status line), the SBC Storage tab load on a points SBC
    (both storage cards offered, view left on the Club tab), and "Keep my active squad".
  - "Keep my active squad" is a setting (on by default). EA's `isItemInSquad` covers starters,
    subs and reserves: 23 cards on the test club, which made one SBC unsolvable with it on.
  - The buying hint is only given for SBCs without league, nation or club rules.
- **Panel redesign (branch `feat/clearer-panel`), checked live 2026-11-21:** context line and
  button follow the open SBC; points preview leads with target / this batch / left after and a
  can-or-can't-finish verdict; refusals carry a "Try with active-squad cards" button; the panel
  minimises to a pill and remembers it. Logged out, `services.User.getUser()` is null.
  - Known: the squad solver is a randomized search. On "3 Leagues & 2 Nations" it reached
    chemistry 29 of 30, and only 27 with more cards allowed, so a refusal can be wrong by a point
    or two on chemistry-heavy SBCs.
- **Still unverified:**
  - Favourites (the test club had none).
  - Brick SBCs (fewer than 11 spots): none were available to test.
  - PLAYER_RARITY_GROUP 4 = "Rare" (still shown as "⚠ double-check").
  - Loan skipping (the test club had no loans).
  - Points SBCs: their requirement keys
    differ from squad SBCs (OVR Min 45 is `{40:[45],41:[1]}`) and aren't mapped; EA's own
    `isItemSelectable` is used instead.
- **Points SBCs (Work Area, `ONE_CLICK_CHALLENGE`, `squad: null`) are supported** by
  `extension/work-area.js` + `src/points.js`, tested live on "Premier League POTM October":
  30 cards selected, 12,480 points, EA's bar showed the same; Review Selection not pressed.
  - View model: `childViewControllers[i].viewModel` with `_challenge`, `_itemEntityMap`,
    `_itemScoreMap` (= each card's `sbsScore`), `_selectedItemIds`, `getSelectionLimit()` (30).
  - A tap is `vm.toggleSelection(item)` + `view.setItemSelected(item, true)` +
    `workAreaController._refreshSelectionControls()`, all local. EA loads the club in batches
    (61, then 31) via `_ensureItemsForPage`.
  - Card choice is cheapest per point. With placeholder prices it picked an 85 and an 84 on the
    first live run; it now uses EA's values and shows the cards before selecting.
- The solver uses cheap fodder out of position when the chemistry requirement allows it
  (e.g. a spare GK at RB). EA accepts this; it's a known behaviour, not a bug.
- When the owner reports a problem, ask for the **Copy SBC requirements** output (under Troubleshooting tools)
  and the exported club file's `meta.sampleKeys`.

## Next step: finish testing on the real Web App

Steps 1–4 of the first real test are done (see "Status"). What's left:

1. An SBC with fewer than 11 players (locked "brick" spots): Solve & pre-fill, then compare with EA.
2. An SBC with a "Rare" requirement, to confirm PLAYER_RARITY_GROUP 4.
3. A club with a loan player, to confirm loans are skipped.
4. Favourites: mark one in the Web App and confirm it is kept out.

This must run on the owner's own Mac, in their own Chrome, signed in by them. Don't do it from a
cloud session: EA is blocked there, and a data-centre login is a needless account risk. The owner
logs in; never handle their EA credentials. Never submit. Inspect EA internals read-only.

Fix on a branch. Update the mock in `test/extension.test.js` to the real object shapes found. Run
`npm run build` if `src/` changed, then `npm test`. Record what's now verified under "Status", and
open a PR. Don't merge without the owner's OK.

## Ideas not started

- Live prices (e.g. from FUTBIN or FUT.GG). EA's market average is used now; a live source would
  mean outside requests, which the hard rules currently forbid.
- An overview of which SBCs the club can do right now. It would have to open every SBC set,
  which means more requests to EA; deliberately not built.
- Smarter "how many times" (it's greedy now).

## Working conventions

- After changing `src/`, run `npm run build`, then `npm test`.
- Requires Node 20+. No npm dependencies. Playwright tests skip if Playwright isn't installed.
- This project was first built inside `DeepakVennapu/vennapusHomeAssistant` by mistake and moved
  here. Don't put FUT Assistant work in that repo.
