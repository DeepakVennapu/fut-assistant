// Runs the club-export extension script in headless Chromium against a mock of the
// Web App's read API, then feeds the downloaded file into the solver.
// Skipped when Playwright isn't installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { normalizeClub } from '../src/model.js';
import { solve } from '../src/solver.js';

let chromium = null;
try { ({ chromium } = createRequire(import.meta.url)('playwright')); } catch { /* not installed */ }

const script = fileURLToPath(new URL('../extension/club-export.js', import.meta.url));
const prefillScript = fileURLToPath(new URL('../extension/prefill.js', import.meta.url));
const bundleScript = fileURLToPath(new URL('../extension/solver-bundle.js', import.meta.url));
const oneClickScript = fileURLToPath(new URL('../extension/one-click.js', import.meta.url));
const readerScript = fileURLToPath(new URL('../extension/sbc-reader.js', import.meta.url));
const workAreaScript = fileURLToPath(new URL('../extension/work-area.js', import.meta.url));

// Builds a fake Web App: 120 club players over two pages, 3 storage cards, one loan, one Icon.
function mockWebApp() {
  // Shaped like FC 27: league/club names are keyed by season, missing keys come back as "*key".
  const names = { 'search.nationName.nation14': 'England', 'global.leagueFull.2027.league13': 'Premier League',
    'global.teamabbr15.2027.team1': 'Arsenal' };
  const make = (i, extra = {}) => ({
    id: 5000 + i, definitionId: 200000 + (i % 110), type: 'player', rating: 70 + (i % 20), rareflag: i % 3 === 0 ? 1 : 0,
    nationId: i % 2 ? 14 : 18, leagueId: i % 4 ? 13 : 53, teamId: i % 5 ? 1 : 9,
    preferredPosition: [0, 3, 5, 7, 14, 18, 25, 12, 16, 23, 27][i % 11], possiblePositions: ['CM'],
    untradeable: i % 2 === 0,
    getStaticData() { return { name: `Player ${i}` }; },
    ...extra,
  });
  const club = Array.from({ length: 120 }, (_, i) => make(i));
  club.push(make(200, { loans: 3 }));
  club.push(make(201, { leagueId: 2118, rating: 90 }));
  const storage = [make(300), make(301), make(302)];
  const observable = (payload) => ({ observe(_ctx, cb) { setTimeout(() => cb(this, { success: true, response: payload }), 5); } });
  window.__calls = [];
  window.services = {
    // Like the real server, a page can hold fewer cards than asked for (77 of 91) while more remain.
    Club: { search(c) { window.__calls.push(`search:${c.offset}`); return observable({ items: window.__club.slice(c.offset, c.offset + Math.min(c.count, 77)) }); } },
    Item: { searchStorageItems(c) { window.__calls.push(`storage:${c.count}`); return observable({ items: window.__storage }); } },
    Localization: { localize: (k) => names[k] ?? `*${k}`, repository: { _collection: names } },
  };
  window.__club = club;
  window.__storage = storage;
}

test('extension exports a club the solver can use, using read calls only', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ acceptDownloads: true });
    await page.setContent('<!doctype html><html><body><p>Mock Web App</p></body></html>');
    await page.evaluate(mockWebApp);
    await page.addScriptTag({ content: readFileSync(script, 'utf8') });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('#fut-assistant-export summary').click().then(() => page.locator('#fut-assistant-export #export').click()),
    ]);
    const data = JSON.parse(readFileSync(await download.path(), 'utf8'));
    const calls = await page.evaluate(() => window.__calls);

    assert.deepEqual(calls, ['search:0', 'search:77', 'search:122', 'storage:100']);
    assert.equal(data.meta.clubCards, 121); // 120 + the Icon; the loan is skipped
    assert.equal(data.meta.storageCards, 3);
    assert.equal(data.meta.skipped.loansOrLocked, 1);

    const p1 = data.players.find((p) => p.id === '5001');
    assert.equal(p1.nation, 'England');
    assert.equal(p1.league, 'Premier League');
    assert.equal(p1.club, 'Arsenal');
    assert.deepEqual(p1.positions, ['RB', 'CM']);
    assert.ok(data.players.find((p) => p.id === '5201').isIcon);
    assert.ok(data.players.filter((p) => p.duplicate).every((p) => p.untradeable));
    // Unknown names fall back to ids instead of breaking.
    assert.equal(data.players.find((p) => p.id === '5000').nation, 'Nation 18');

    const club = normalizeClub(data);
    const res = solve(club, { requirements: [{ kind: 'teamRating', min: 80 }] });
    assert.equal(res.feasible, true);
  } finally {
    await browser.close();
  }
});

// A fake open SBC: a 4-4-2 squad screen reachable the way the Web App exposes it.
function mockOpenSbc() {
  window.__saved = 0;
  window.__submitted = 0;
  window.__placed = null;
  // Slot positions shaped like FC 27's: { id, typeId, name: 'RCB', typeName: 'CB' }.
  const slots = [['GK', 'GK'], ['RB', 'RB'], ['RCB', 'CB'], ['LCB', 'CB'], ['LB', 'LB'], ['RM', 'RM'], ['RCM', 'CM'],
    ['LCM', 'CM'], ['LM', 'LM'], ['RS', 'ST'], ['LS', 'ST']].map(([name, typeName], id) => ({ position: { id, name, typeName } }));
  window.__eaVerdict = { met: true, chemistry: 21, rating: 82 };
  const challenge = {
    id: 77, setId: 5, type: 'OPEN_CHALLENGE', formation: 'f442', eligibilityRequirements: [],
    squad: {
      getFieldPlayers: () => slots,
      setPlayers(items) { window.__placed = items.map((i) => i && i.id); },
      getChemistry: () => window.__eaVerdict.chemistry,
      getRating: () => window.__eaVerdict.rating,
    },
    // EA's own local checks (no network), used to confirm the fill.
    meetsRequirements() { return window.__eaVerdict.met; },
    isRequirementMet(r) { return window.__eaVerdict.met || this.eligibilityRequirements.indexOf(r) !== 1; },
  };
  window.getAppMain = () => ({
    getRootViewController: () => ({
      getPresentedViewController: () => ({
        getCurrentViewController: () => ({ getCurrentController: () => ({ _view: { deep: { holder: { challenge } } } }) }),
      }),
    }),
  });
  window.services.SBC = {
    saveChallenge() { window.__saved++; return { observe(_c, cb) { setTimeout(() => cb(this, { success: true }), 5); } }; },
    submitChallenge() { window.__submitted++; throw new Error('must never submit'); },
  };
}

test('pre-fill places the chosen cards in position, saves the draft, never submits', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body><p>Mock Web App</p></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockOpenSbc);
    await page.addScriptTag({ content: readFileSync(script, 'utf8') });
    await page.addScriptTag({ content: readFileSync(prefillScript, 'utf8') });

    // Cards 5000.. have preferred positions in slot order GK,RB,CB,LB,CM,CAM,ST,RM,LM,RW,LW (by i % 11).
    // Give them out of order, plus one card to buy, and expect a sensible placement.
    const ids = [5009, 5006, 5004, 5000, 5001, 5002, 5013, 5007, 5008, 5017];
    const code = JSON.stringify({ kind: 'fut-assistant-prefill', v: 1, sbc: 'Test',
      cards: [...ids.map((id) => ({ id: String(id), name: `P${id}` })), { buy: true, name: 'Any 84 gold (buy)', rating: 84 }] });

    await page.locator('#fut-assistant-export summary').click();
    await page.locator('#fut-assistant-export #code').fill(code);
    await page.locator('#fut-assistant-export #prefill').click();
    const status = page.locator('#fut-assistant-export #prefillStatus');
    await status.filter({ hasText: /Placed|Stopped/ }).waitFor({ timeout: 30000 });
    const text = await status.textContent();
    assert.match(text, /Placed 10 card\(s\)\. Buy and place 1 more yourself/);

    const placed = await page.evaluate(() => window.__placed);
    assert.equal(placed.length, 11);
    assert.equal(placed[0], 5000, 'GK card in the GK slot');
    assert.equal(placed[1], 5001, 'RB card in the RB slot');
    assert.deepEqual([placed[9], placed[10]].sort(), [5006, 5017], 'strikers up front');
    assert.equal(placed.filter((x) => x == null).length, 1, 'one empty slot for the card to buy');
    assert.equal(await page.evaluate(() => window.__saved), 1);
    assert.equal(await page.evaluate(() => window.__submitted), 0);

    // A second fill straight away is blocked by the cooldown.
    await page.locator('#fut-assistant-export #prefill').click();
    await status.filter({ hasText: /Please wait/ }).waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__saved), 1);
  } finally {
    await browser.close();
  }
});

test('pre-fill refuses a bad code and a missing card', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockOpenSbc);
    await page.addScriptTag({ content: readFileSync(script, 'utf8') });
    await page.addScriptTag({ content: readFileSync(prefillScript, 'utf8') });
    const bad = await page.evaluate(() => window.__futAssistantPrefill.run('hello').catch((e) => e.message));
    assert.match(bad, /not a FUT Assistant pre-fill code/);
    // Speed up the paced club read for this test.
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    const code = JSON.stringify({ kind: 'fut-assistant-prefill', cards: [{ id: '999999', name: 'Sold Guy' }] });
    const missing = await page.evaluate((c) => window.__futAssistantPrefill.run(c).catch((e) => e.message), code);
    assert.match(missing, /no longer in your club or storage: Sold Guy/);
    assert.equal(await page.evaluate(() => window.__saved), 0);
  } finally {
    await browser.close();
  }
});

// FC 27 "points" SBC, shaped like the real one: a Work Area with a score target and no squad.
test('a points SBC (no squad) is named clearly instead of "no open SBC"', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(() => {
      const challenge = { id: 212, name: 'Premier League POTM October', type: 'ONE_CLICK_CHALLENGE', formation: '', squad: null,
        scoreRequirement: 17000, submittedScore: 0, setId: 9, eligibilityOperation: 'AND',
        eligibilityRequirements: [{ scope: 0, count: -1, kvPairs: { _collection: { 40: [45], 41: [1] } } }] };
      const ctl = { childViewControllers: [{ viewModel: { _challenge: challenge } }] };
      window.getAppMain = () => ({ getRootViewController: () => ({ getPresentedViewController: () => ({
        getCurrentViewController: () => ({ getCurrentController: () => ctl }) }) }) });
    });
    await page.addScriptTag({ content: readFileSync(script, 'utf8') });
    await page.addScriptTag({ content: readFileSync(prefillScript, 'utf8') });
    const msg = await page.evaluate(() => { try { window.__futAssistantPrefill.findOpenChallenge(); return 'found'; } catch (e) { return e.message; } });
    assert.match(msg, /"Premier League POTM October" is a points SBC \(pick cards worth 17,000 points\), not a squad\. Use Solve & pre-fill to select cards for it/);
  } finally {
    await browser.close();
  }
});

// Fake SBC requirements, shaped the way the Web App stores them (enum tables + kvPairs).
function mockRequirements() {
  window.SBCEligibilityKey = { PLAYER_COUNT: 1, TEAM_RATING_1_TO_100: 2, CHEMISTRY_POINTS: 3, SAME_LEAGUE_COUNT: 4,
    NATION_COUNT: 5, LEAGUE_ID: 6, PLAYER_RARITY_GROUP: 7, FIRST_OWNER_PLAYERS_COUNT: 8, PLAYER_QUALITY: 9 };
  window.SBCEligibilityScope = { GREATER: 0, LOWER: 1, EXACT: 2 };
  const kv = (o) => ({ _collection: o });
  const challenge = window.getAppMain().getRootViewController().getPresentedViewController()
    .getCurrentViewController().getCurrentController()._view.deep.holder.challenge;
  challenge.name = 'Test Hybrid';
  challenge.eligibilityRequirements = [
    { scope: 2, count: -1, kvPairs: kv({ 1: [11] }) },
    { scope: 0, count: -1, kvPairs: kv({ 2: [80] }) },
    { scope: 0, count: -1, kvPairs: kv({ 3: [10] }) },
    { scope: 1, count: -1, kvPairs: kv({ 4: [8] }) },
    { scope: 0, count: -1, kvPairs: kv({ 5: [2] }) },
    { scope: 0, count: 3, kvPairs: kv({ 6: [13] }) },
    { scope: 0, count: 2, kvPairs: kv({ 7: [4] }) },
    { scope: 2, count: 1, kvPairs: kv({ 8: [1] }) },
    { scope: 0, count: -1, kvPairs: new Map([[9, [2]]]) },
  ];
  document.body.insertAdjacentHTML('beforeend', '<ul class="sbc-requirements"><li>Team Rating: Min. 80</li><li>First Owner: Exactly 1</li></ul>');
}

test('reads the open SBC requirements and the solver can use them', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch({ args: ['--enable-features=Clipboard'] });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockOpenSbc);
    await page.evaluate(mockRequirements);
    for (const f of [script, prefillScript, readerScript]) await page.addScriptTag({ content: readFileSync(f, 'utf8') });

    const data = await page.evaluate(() => window.__futAssistantSbc.readOpenSbc());
    const { sbc } = data;
    assert.equal(sbc.name, 'Test Hybrid');
    assert.equal(sbc.squadSize, 11);
    // Chemistry is scored on the open squad's own slots.
    assert.deepEqual(sbc.formations, [['GK', 'RB', 'CB', 'CB', 'LB', 'RM', 'CM', 'CM', 'LM', 'ST', 'ST']]);
    assert.equal(sbc.formationName, 'f442');
    assert.equal(data.unsupported, 1);
    assert.equal(data.uncertain, 1); // rarity group 4 only; quality values are confirmed
    assert.deepEqual(data.eaText, ['Team Rating: Min. 80', 'First Owner: Exactly 1']);
    const kinds = sbc.requirements.map((r) => [r.kind, r.attr ?? r.filter ?? null, r.min ?? null, r.max ?? null]);
    assert.deepEqual(kinds, [
      ['teamRating', null, 80, null],
      ['chemistry', null, 10, null],
      ['sameAttr', 'leagueId', null, 8],
      ['distinct', 'nationId', 2, null],
      ['count', { leagueId: [13] }, 3, null],
      ['count', { rare: true }, 2, null],
      ['each', { quality: ['silver', 'gold'] }, null, null],
      ['unsupported', null, null, null],
    ]);

    // The panel button reports what it copied.
    await page.locator('#fut-assistant-export summary').click();
    await page.locator('#fut-assistant-export #readSbc').click();
    await page.locator('#fut-assistant-export #readStatus').filter({ hasText: /Copied|Stopped/ }).waitFor();
    assert.match(await page.locator('#fut-assistant-export #readStatus').textContent(),
      /Copied 7 requirement\(s\) for "Test Hybrid" \(1 not understood, 1 to double-check\)/);

    const exported = await page.evaluate(() => window.__futAssistantExport.buildExport(window.__club, window.__storage, []));
    const res = solve(normalizeClub(exported), sbc);
    assert.equal(res.feasible, true, JSON.stringify(res.evaluation.results));
    assert.ok(res.evaluation.results.find((r) => r.kind === 'unsupported').unchecked);
  } finally {
    await browser.close();
  }
});

async function loadAll(page, { requirements = true } = {}) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(mockWebApp);
  await page.evaluate(mockOpenSbc);
  if (requirements) await page.evaluate(mockRequirements);
  for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript]) {
    await page.addScriptTag({ content: readFileSync(f, 'utf8') });
  }
}

test('one click: reads the SBC, solves with the club, places one squad, never submits', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    const status = page.locator('#fut-assistant-export #oneClickStatus');
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Placed|Stopped/ }).waitFor({ timeout: 60000 });
    const text = await status.textContent();
    assert.match(text, /^Placed 11 cards · rating \d+ · chemistry \d+/);
    assert.match(text, /⚠ Check yourself: .*Not understood: FIRST_OWNER_PLAYERS_COUNT/);
    assert.match(text, /about \d+\+? more time/);
    assert.match(text, /submit it yourself/);
    assert.match(text, /✔ EA shows rating 82 · chemistry 21, requirements met\./);

    const placed = await page.evaluate(() => window.__placed);
    assert.equal(placed.filter(Boolean).length, 11);
    assert.equal(await page.evaluate(() => window.__saved), 1);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    // Club read once (storage + 2 pages); pre-fill found everything in that read.
    assert.deepEqual(await page.evaluate(() => window.__calls), ['storage:100', 'search:0', 'search:77', 'search:122']);

    // Straight away again: blocked by the 30 s wait, before any reading or solving.
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Please wait/ }).waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__saved), 1);
  } finally {
    await browser.close();
  }
});

test('one click: says so loudly when EA disagrees with the solver', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    // As seen on the real Web App before the fix: EA scored the placed squad lower.
    await page.evaluate(() => { window.__eaVerdict = { met: false, chemistry: 10, rating: 81 }; });
    await page.evaluate(() => document.querySelectorAll('.sbc-requirements').forEach((n) => n.remove()));
    await page.evaluate(() => document.body.insertAdjacentHTML('beforeend',
      '<ul class="sbc-requirements"><li>Players: Exactly 11</li><li>Team Rating: Min. 80</li></ul>'));
    const status = page.locator('#fut-assistant-export #oneClickStatus');
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Placed|Stopped/ }).waitFor({ timeout: 60000 });
    assert.match(await status.textContent(),
      /✖ EA shows rating 81 · chemistry 10, and says NOT met: Team Rating: Min\. 80\. Don't submit; clear the squad\./);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
  } finally {
    await browser.close();
  }
});

test('pre-fill puts each card in the slot the solver scored it in', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    for (const f of [script, prefillScript]) await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    // Four cards can play CM but there are only three CM slots. The solver chose B, C and D for CM;
    // A goes in the leftover RB slot.
    const order = await page.evaluate(() => {
      const card = (id, pos) => ({ id, preferredPosition: pos, possiblePositions: [pos] });
      const items = [card('A', 'CM'), card('B', 'CM'), card('C', 'CM'), card('D', 'CM')];
      const placed = window.__futAssistantPrefill.placeCards(items, ['RB', 'CM', 'CM', 'CM'], [null, 'CM', 'CM', 'CM']);
      return placed.map((i) => i && i.id);
    });
    // Without the solver's slots, plain matching would put A in a CM slot and leave D out of position.
    assert.deepEqual(order, ['A', 'B', 'C', 'D']);
  } finally {
    await browser.close();
  }
});

// FC 27 points SBC ("Work Area"), shaped like the real one: the view model holds the
// challenge, a Map of loaded cards, EA's score map and the selection; EA loads the club in
// batches (61, then 31) and a tap is toggleSelection + view.setItemSelected + refresh.
function mockWorkArea() {
  window.__fetches = 0;
  window.__reviewed = 0;
  window.__refreshed = 0;
  const club = window.__club.map((c, i) => ({ ...c, sbsScore: 100 + (i % 4) * 80 }));
  const challenge = { id: 212, name: 'Premier League POTM October', type: 'ONE_CLICK_CHALLENGE', squad: null,
    scoreRequirement: 17000, submittedScore: 0, eligibilityRequirements: [] };
  const state = { items: [], serverOffset: 0, retrievedAll: false, currentPage: 0 };
  const vm = {
    _challenge: challenge, _pageSize: 30, _itemEntityMap: new Map(), _itemScoreMap: new Map(), _selectedItemIds: new Set(),
    _fetchBatch(done) {
      window.__fetches++;
      const n = state.serverOffset === 0 ? 61 : 31;
      const batch = club.slice(state.serverOffset, state.serverOffset + n);
      batch.forEach((e) => { this._itemEntityMap.set(e.id, e); this._itemScoreMap.set(e.id, e.sbsScore); state.items.push(e); });
      state.serverOffset += batch.length;
      state.retrievedAll = batch.length < n;
      setTimeout(done, 5);
    },
    _ensureItemsForPage(page, cb) {
      if (state.items.length > (page + 1) * this._pageSize + 1 || state.retrievedAll) cb();
      else this._fetchBatch(() => this._ensureItemsForPage(page, cb));
    },
    _currentState: () => state,
    getChallenge() { return challenge; },
    getSelectionLimit: () => 30,
    isSelectionLimitReached() { return this._selectedItemIds.size >= 30; },
    isItemSelectable: (e) => e.sbsScore > 0,
    isItemSelected(e) { return this._selectedItemIds.has(e.id); },
    toggleSelection(e) {
      if (this._selectedItemIds.has(e.id)) { this._selectedItemIds.delete(e.id); return false; }
      if (this.isSelectionLimitReached()) return false;
      this._selectedItemIds.add(e.id);
      return true;
    },
    getSelectedCount() { return this._selectedItemIds.size; },
    getSelectedScore() { let t = 0; this._selectedItemIds.forEach((id) => { t += this._itemScoreMap.get(id) ?? 0; }); return t; },
  };
  vm._fetchBatch(() => {}); // the Web App loads the first 61 cards when the SBC opens
  const view = { selected: new Set(), setItemSelected(e, on) { if (on) this.selected.add(e.id); } };
  const workAreaController = { viewModel: vm, getView: () => view, _refreshSelectionControls() { window.__refreshed++; } };
  const ctl = { childViewControllers: [{ viewModel: vm }], workAreaController,
    reviewSelection() { window.__reviewed++; throw new Error('must never review/submit'); } };
  window.getAppMain = () => ({ getRootViewController: () => ({ getPresentedViewController: () => ({
    getCurrentViewController: () => ({ getCurrentController: () => ctl }) }) }) });
  // Cards 5000-5003 are in the active squad; EA's Review would warn about them.
  window.services.SBC = { isItemInSquad: (id) => id >= 5000 && id <= 5003 };
  window.__vm = vm;
  window.__view = view;
}

test('one click on a points SBC: selects cheap cards like a tap, never reviews or submits', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockWorkArea);
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    const status = page.locator('#fut-assistant-export #oneClickStatus');
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Selected|Stopped/ }).waitFor({ timeout: 60000 });
    const text = await status.textContent();
    assert.match(text, /^Selected 30 card\(s\) · [\d,]+ points for "Premier League POTM October"/);
    assert.match(text, /✔ EA shows [\d,]+ points selected\./);
    assert.match(text, /more needed after this; submit it, then click again for the next batch/);
    assert.match(text, /Press Review Selection and submit it yourself/);

    const r = await page.evaluate(() => ({
      ids: [...window.__vm._selectedItemIds],
      shown: [...window.__view.selected],
      fetches: window.__fetches,
      refreshed: window.__refreshed,
      reviewed: window.__reviewed,
      ratings: [...window.__vm._selectedItemIds].map((id) => window.__vm._itemEntityMap.get(id).rating),
    }));
    assert.equal(r.ids.length, 30);
    assert.deepEqual(r.shown.sort(), r.ids.sort()); // the view shows what was selected
    assert.ok(r.ids.every((id) => id < 5000 || id > 5003), 'active-squad cards are skipped');
    assert.ok(r.ratings.every((x) => x < 87), 'protected cards are kept');
    assert.ok(r.ids.every((id) => id !== 5200), 'loan cards are skipped');
    assert.equal(r.refreshed, 1);
    assert.equal(r.reviewed, 0);
    // 61 loaded on open, then one extra batch of 31 per paced step until the club is all in.
    assert.equal(r.fetches, 3);

    // A second click straight away: blocked by the shared 30 s wait, selection unchanged.
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Please wait/ }).waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__vm._selectedItemIds.size), 30);
  } finally {
    await browser.close();
  }
});

test('one click on a points SBC: leaves a selection you made alone', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockWorkArea);
    await page.evaluate(() => window.__vm._selectedItemIds.add(5010));
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    const status = page.locator('#fut-assistant-export #oneClickStatus');
    await page.locator('#fut-assistant-export #oneClick').click();
    await status.filter({ hasText: /Selected|Stopped/ }).waitFor({ timeout: 30000 });
    assert.match(await status.textContent(), /Stopped: Some cards are already selected\. Deselect them first/);
    assert.deepEqual(await page.evaluate(() => [...window.__vm._selectedItemIds]), [5010]);
  } finally {
    await browser.close();
  }
});

test('one click: refuses to fill when the club cannot meet the SBC', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    await page.evaluate(() => {
      const c = window.getAppMain().getRootViewController().getPresentedViewController()
        .getCurrentViewController().getCurrentController()._view.deep.holder.challenge;
      c.eligibilityRequirements = [{ scope: 0, count: -1, kvPairs: { _collection: { 2: [95] } } }];
    });
    await page.locator('#fut-assistant-export #oneClick').click();
    const status = page.locator('#fut-assistant-export #oneClickStatus');
    await status.filter({ hasText: /Placed|Stopped/ }).waitFor({ timeout: 60000 });
    assert.match(await status.textContent(), /Stopped: Can't complete this with your club\. Team rating: Min 95 \(best: \d+\)/);
    assert.equal(await page.evaluate(() => window.__saved), 0);
  } finally {
    await browser.close();
  }
});
