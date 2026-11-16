# FUT Assistant

A local SBC helper for EA FC Ultimate Team. It runs on your computer inside EA's Web App page,
never sees your EA login, and **never submits, buys, sells or lists anything**. You review and
submit every SBC yourself.

Tested on EA's real FC 27 Web App (November 2026). See `CLAUDE.md` for what is and isn't verified.

## Install (Chrome)

Needs Node 20+ only for tests and the optional local page. No dependencies.

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the
   `extension/` folder.
2. Open the Web App and log in. The **FUT Assistant** panel appears at the bottom-left.
3. After pulling new code, click the reload icon on the extension's card and reload the Web App.

## Solve & pre-fill

Open an SBC and press **Solve & pre-fill**.

1. It reads the SBC from the page (no network call) and your club (read once per session, one
   page every 1.5–3 seconds, then reused).
2. It picks the cards you lose least by giving up: storage duplicates, then untradeables, then
   tradeables, using the value EA's own data gives each card.
3. It **shows you the cards first**. Untick any you want to keep and press **Solve again without
   unticked**; tick **Always keep the cards I untick** to keep them out for good.
4. **Fill these** places the squad and saves the draft once. The status line then shows EA's own
   rating, chemistry and whether EA says the requirements are met. If EA disagrees it says so.

What it keeps out: cards rated at or above **Keep cards rated** (default 87), your favourites,
your active squad (starters, subs and reserves; untick **Keep my active squad** to allow them),
special cards, loans, and cards sitting in another SBC's saved draft. It fills one squad per click
and waits 30 seconds between fills. It won't fill a squad that fails the requirements; if buying
a few plain cards would fix that, it says which (prices are estimates; only for SBCs without
league, nation or club rules).

**Points SBCs** (a "Work Area" where you pick cards worth points, as player SBCs are in FC 27) work
the same way: it selects up to 30 cards exactly as tapping them would, tells you whether your club
can reach the target and in how many submissions, and leaves **Review Selection** to you.

- **Re-read my club**: use after opening packs, or if you cleared a draft the tool filled.
- Settings, kept cards and the tool's record of its own fills live in this browser only.

## Debug tools (in the panel)

- **Export club**: saves `fut-club-YYYY-MM-DD.json`. Its `meta.sampleKeys` lists EA's raw fields.
- **Copy SBC requirements**: copies the open SBC's rules as the tool read them, with EA's text.
- **Pre-fill open SBC**: places a squad from a code copied from the local page.

If something reads wrong after an EA update, these two outputs are what's needed to fix it.

## Local page and CLI (optional)

`npm start` serves a page at http://127.0.0.1:5177 that solves against an exported club file and
estimates how many times your club covers an SBC. `node src/cli.js list|solve|repeat` does the same
in a terminal. Both use the same solver as the extension (`src/`); after changing `src/`, run
`npm run build`, then `npm test`.

## Club file format

A JSON array of cards, or `{ "players": [...] }`:

```json
{
  "id": 123,                 // unique card id
  "baseId": 456,             // same player across versions/copies (a squad can't hold two)
  "name": "A. Player",
  "rating": 84,
  "positions": ["CM", "CDM"],
  "nation": "Spain", "league": "Premier League", "club": "Arsenal",
  "rare": true, "special": false,
  "untradeable": true,       // untradeable cards are cheaper fodder
  "duplicate": false,        // true = sitting in SBC storage
  "price": 2200              // optional; estimated from rating if missing
}
```

`data/sample-club.json` is made-up data from `npm run sample`.

## SBC format

See `data/sbcs.json`. Requirement kinds: `teamRating`, `chemistry`, `count` (with a filter such as
`{ "rare": true }` or `{ "league": "Serie A" }`), `sameAttr`, `distinct`, `each`. Optional
`squadSize` (default 11) and `formations` (default: all built-in ones; the best is picked).

## Known limits

- Using any extension inside the Web App is against EA's terms. Filling while you submit yourself
  is lower risk than auto-submitting, but not zero.
- Not yet verified on the real Web App: SBCs with locked "brick" spots, the "Rare" requirement,
  loan skipping and favourites (the test club had none of these).
- Card values are EA's market average, which is a guide, not a live price. Cards EA gives no value
  fall back to an estimate by rating, as do "what to buy" suggestions.
- The solver uses cheap cards out of position when the chemistry target allows it.
- A draft the tool filled keeps its cards out of other SBCs for a week, or until **Re-read my club**.
- Team rating and chemistry follow the community formulas; chemistry matched EA on a real squad.
  Icon/Hero boosts are approximated.
