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
const panelScript = fileURLToPath(new URL('../extension/panel.js', import.meta.url));
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
    // Logged in: EA's user lookup returns the account (null when logged out).
    User: { getUser: () => ({ id: 1 }) },
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
    await page.addScriptTag({ content: readFileSync(panelScript, 'utf8') });

    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30000 }),
      page.locator('#fut-assistant-export #advanced summary').click().then(() => page.locator('#fut-assistant-export #export').click()),
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
    // EA lists the active squad's cards; here, cards 5010-5040.
    isItemInSquad: (id) => id >= 5010 && id <= 5040,
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
    await page.addScriptTag({ content: readFileSync(panelScript, 'utf8') });

    // Cards 5000.. have preferred positions in slot order GK,RB,CB,LB,CM,CAM,ST,RM,LM,RW,LW (by i % 11).
    // Give them out of order, plus one card to buy, and expect a sensible placement.
    const ids = [5009, 5006, 5004, 5000, 5001, 5002, 5013, 5007, 5008, 5017];
    const code = JSON.stringify({ kind: 'fut-assistant-prefill', v: 1, sbc: 'Test',
      cards: [...ids.map((id) => ({ id: String(id), name: `P${id}` })), { buy: true, name: 'Any 84 gold (buy)', rating: 84 }] });

    await page.locator('#fut-assistant-export #advanced summary').click();
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
    for (const f of [script, prefillScript, readerScript, panelScript]) await page.addScriptTag({ content: readFileSync(f, 'utf8') });

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
    await page.locator('#fut-assistant-export #advanced summary').click();
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

// The panel: its result area says what it is showing (idle, plan, outcome or notice).
const panelState = (page) => page.evaluate(() =>
  document.getElementById('fut-assistant-export')?.shadowRoot.getElementById('result')?.dataset.state);
const waitState = (page, states, timeout = 60000) => page.waitForFunction((st) =>
  st.includes(document.getElementById('fut-assistant-export')?.shadowRoot.getElementById('result')?.dataset.state), states, { timeout });
const resultText = (page) => page.locator('#fut-assistant-export #result').textContent();
const mainButton = (page) => page.evaluate(() => {
  const b = document.getElementById('fut-assistant-export').shadowRoot.getElementById('find');
  return { label: b.textContent, disabled: b.disabled };
});
const contextText = (page) => page.locator('#fut-assistant-export #context').textContent();

// Press "Find cards" once it's enabled; returns the state it lands in (plan or notice).
async function findCards(page) {
  await page.waitForFunction(() => !document.getElementById('fut-assistant-export').shadowRoot.getElementById('find').disabled, null, { timeout: 10000 });
  await page.locator('#fut-assistant-export #find').click();
  await waitState(page, ['plan', 'notice']);
  return panelState(page);
}

// Find cards; when the preview appears, press the place/select button; return what it says.
async function solveAndApply(page) {
  if ((await findCards(page)) === 'plan') {
    await page.locator('#fut-assistant-export #applyPlan').click();
    await waitState(page, ['outcome', 'notice']);
  }
  return resultText(page);
}

async function loadAll(page, { requirements = true } = {}) {
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.evaluate(mockWebApp);
  await page.evaluate(mockOpenSbc);
  if (requirements) await page.evaluate(mockRequirements);
  for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
    await page.addScriptTag({ content: readFileSync(f, 'utf8') });
  }
}

test('one click: reads the SBC, solves with the club, places one squad, never submits', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    assert.match(await contextText(page), /Test Hybrid.*Squad SBC/);
    assert.deepEqual(await mainButton(page), { label: 'Find cards for this squad', disabled: false });
    const text = await solveAndApply(page);
    assert.match(text, /✔ Placed 11 cards/);
    assert.match(text, /EA confirms: requirements met, rating 82, chemistry 21\./);
    assert.match(text, /Check yourself: .*Not understood: FIRST_OWNER_PLAYERS_COUNT/);
    assert.match(text, /Next: In EA: check the squad, then Submit\./);

    const placed = await page.evaluate(() => window.__placed);
    assert.equal(placed.filter(Boolean).length, 11);
    assert.ok(placed.every((id) => id < 5010 || id > 5040), 'active-squad cards are kept');
    assert.equal(await page.evaluate(() => window.__saved), 1);
    assert.equal(await page.evaluate(() => window.__submitted), 0);
    // Club read once (storage + 2 pages); pre-fill found everything in that read.
    assert.deepEqual(await page.evaluate(() => window.__calls), ['storage:100', 'search:0', 'search:77', 'search:122']);

    // Straight away again: the button counts down the 30 s wait instead.
    await page.waitForFunction(() => /^Wait \d+ s$/.test(document.getElementById('fut-assistant-export').shadowRoot.getElementById('find').textContent));
    assert.equal((await mainButton(page)).disabled, true);
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
    const text = await solveAndApply(page);
    assert.match(text, /✖ EA says the requirements are NOT met/);
    assert.match(text, /EA shows rating 81, chemistry 10\./);
    assert.match(text, /✖ Team Rating: Min\. 80/);
    assert.match(text, /Next: Don't submit\. In EA: Clear Squad\./);
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
  window.__storageTabLoads = 0;
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
    // As on the real Web App: every tab has a state from the start, empty until it is opened.
    _tabStates: new Map([['club', state], ['storage', { items: [], serverOffset: 0, retrievedAll: false, currentPage: 0 }]]), _activeTab: 'club',
    getActiveTab() { return this._activeTab; },
    // Tapping the SBC Storage tab: one read of the storage cards for this challenge.
    setActiveTab(tab, cb) {
      this._activeTab = tab;
      if (tab === 'storage' && !this._tabStates.get('storage').retrievedAll) {
        window.__storageTabLoads++;
        this._tabStates.set('storage', { items: window.__storage, retrievedAll: true });
        window.__storage.forEach((e) => { e.sbsScore = 300; this._itemEntityMap.set(e.id, e); this._itemScoreMap.set(e.id, 300); });
      }
      setTimeout(cb, 5);
    },
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
  // As on the real page: the requirement and the reward card sit in the same kind of list.
  document.body.insertAdjacentHTML('beforeend',
    '<ul class="sbc-requirements"><li>OVR Min: 45</li><li>85\nST\nx1 POTM Premier League Jackson (Untradeable)</li></ul>');
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
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    assert.match(await contextText(page), /Premier League POTM October.*Points SBC · 0 \/ 17,000 submitted/);
    assert.equal(await findCards(page), 'plan');
    const preview = await resultText(page);
    assert.match(preview, /Target17,000/);
    assert.match(preview, /✔ Your club can finish this: \d+ submissions, \d+ cards\./);
    assert.match(await page.locator('#fut-assistant-export #applyPlan').textContent(), /^Select in Work Area$/);
    await page.locator('#fut-assistant-export #applyPlan').click();
    await waitState(page, ['outcome', 'notice']);
    const text = await resultText(page);
    assert.match(text, /✔ Selected 30 cards · [\d,]+ points/);
    assert.match(text, /EA's progress bar agrees\./);
    assert.match(text, /points still needed after this batch\./);
    assert.match(text, /Check yourself: OVR Min: 45\./); // reward text is left out
    assert.match(text, /Next: In EA: Review Selection → Confirm Submission\. Then come back for the next batch\./);

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
    // Storage duplicates are the cheapest fodder: loaded with one tab read and used first.
    assert.equal(await page.evaluate(() => window.__storageTabLoads), 1);
    assert.equal(await page.evaluate(() => window.__vm._activeTab), 'club');
    assert.ok([5300, 5301, 5302].every((id) => r.ids.includes(id)), 'storage cards are used');
    assert.equal(r.refreshed, 1);
    assert.equal(r.reviewed, 0);
    // 61 loaded on open, then one extra batch of 31 per paced step until the club is all in.
    assert.equal(r.fetches, 3);

    // Now cards are selected: the panel says so and won't search over them.
    await page.waitForFunction(() => /30 selected/.test(document.getElementById('fut-assistant-export').shadowRoot.getElementById('context').textContent));
    assert.equal((await mainButton(page)).disabled, true);
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
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    await page.waitForFunction(() => /1 selected/.test(document.getElementById('fut-assistant-export').shadowRoot.getElementById('context').textContent));
    assert.deepEqual(await mainButton(page), { label: 'Cards already selected', disabled: true });
    // Even called directly, it refuses and says what to do.
    const msg = await page.evaluate(async () => {
      try { await window.__futAssistantOneClick.plan({}, () => {}); return 'planned'; } catch (e) { return `${e.title} | ${e.lines.join(' ')}`; }
    });
    assert.match(msg, /You already have 1 cards selected \| FUT Assistant won't change a selection you made\. Press Remove All/);
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
    const text = await solveAndApply(page);
    assert.match(text, /✖ Your club can't complete this SBC/);
    assert.match(text, /Team rating: Min 95 \(best: \d+\)/);
    assert.equal(await page.evaluate(() => window.__saved), 0);
  } finally {
    await browser.close();
  }
});

// ---- Card values, preview, kept cards, drafts, what to buy ----

test('card values come from EA\'s own data; favourites are flagged', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.addScriptTag({ content: readFileSync(script, 'utf8') });
    const cards = await page.evaluate(() => {
      const base = window.__club[0];
      const { toCard } = window.__futAssistantExport;
      return [
        // Shapes seen on the real Web App: _marketAverage is a number, _itemPriceLimits { minimum, maximum }.
        toCard({ ...base, _marketAverage: 12283, _itemPriceLimits: { minimum: 2400, maximum: 31500 }, isFavorite: true }, false),
        toCard({ ...base, _marketAverage: 0, _itemPriceLimits: { minimum: 700, maximum: 10000 }, isFavorite: false }, false),
        toCard({ ...base }, false),
      ];
    });
    assert.deepEqual(cards.map((c) => [c.price, c.priceSource, c.favorite]),
      [[12283, 'ea-average', true], [700, 'ea-minimum', false], [undefined, 'estimate', false]]);
    assert.equal(normalizeClub(cards)[0].price, 12283);
    assert.equal(normalizeClub(cards)[0].favorite, true);
    assert.ok(normalizeClub(cards)[2].price > 0, 'no EA value: falls back to the estimate by rating');
  } finally {
    await browser.close();
  }
});

// A real origin, so localStorage works (settings and kept cards are remembered there).
async function loadAllOnOrigin(page) {
  await page.route('http://fut.test/', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body></body></html>' }));
  await page.goto('http://fut.test/');
  await page.evaluate(mockWebApp);
  await page.evaluate(mockOpenSbc);
  await page.evaluate(mockRequirements);
  for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
    await page.addScriptTag({ content: readFileSync(f, 'utf8') });
  }
}

test('preview: nothing is placed until "Fill these"; unticked cards are left out and can be kept for good', { skip: !chromium && 'playwright not installed', timeout: 120000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAllOnOrigin(page);
    const panel = page.locator('#fut-assistant-export');
    await panel.locator('#settings summary').click();
    await panel.locator('#protect').fill('85');
    await panel.locator('#protect').dispatchEvent('change');
    assert.match(await panel.locator('#settingsSummary').textContent(), /^Keeping: 85\+ · favourites · active squad$/);
    assert.equal(await findCards(page), 'plan');
    assert.match(await resultText(page), /11 cards for this squad.*Rating\d+.*Chemistry\d+.*Requirements\d+\/\d+/);
    assert.equal(await panel.locator('#previewList input').count(), 11);
    assert.equal(await page.evaluate(() => window.__saved), 0, 'the preview places nothing');

    // Untick the first card, keep it for good, and solve again.
    const first = panel.locator('#previewList input').first();
    const keptId = await first.getAttribute('data-id');
    assert.equal(await panel.locator('#resolvePlan').isVisible(), false);
    await first.uncheck();
    // With a card unticked, placing waits until the squad is solved again without it.
    assert.equal(await panel.locator('#applyPlan').isDisabled(), true);
    assert.equal(await panel.locator('#resolvePlan').textContent(), 'Swap out 1 unticked card');
    assert.equal(await page.evaluate(() => window.__saved), 0);
    await panel.locator('#rememberKeep').check();
    await panel.locator('#resolvePlan').click();
    await waitState(page, ['plan', 'notice']);
    const ids = await panel.locator('#previewList input').evaluateAll((els) => els.map((e) => e.dataset.id));
    assert.equal(ids.length, 11);
    assert.ok(!ids.includes(keptId), 'the unticked card is not offered again');

    await panel.locator('#applyPlan').click();
    await waitState(page, ['outcome', 'notice']);
    const placed = await page.evaluate(() => window.__placed.filter(Boolean).map(String));
    assert.equal(placed.length, 11);
    assert.ok(!placed.includes(keptId));
    assert.equal(await page.evaluate(() => window.__saved), 1);
    assert.equal(await page.evaluate(() => window.__submitted), 0);

    // Remembered in this browser: the setting, the kept card and this fill's draft.
    const stored = await page.evaluate(() => ({
      settings: JSON.parse(localStorage.getItem('futAssistant.settings')),
      kept: Object.keys(JSON.parse(localStorage.getItem('futAssistant.protected'))),
      draft: JSON.parse(localStorage.getItem('futAssistant.drafts'))['77'].ids,
    }));
    assert.equal(stored.settings.protectMinRating, 85);
    assert.deepEqual(stored.kept, [keptId]);
    assert.deepEqual(stored.draft.sort(), placed.sort());
    assert.match(await panel.locator('#clearKept').textContent(), /Stop keeping the 1 card\(s\) I chose/);
    assert.match(await panel.locator('#settingsSummary').textContent(), /· 1 chosen$/);

    // Minimise: the panel folds into a pill and stays folded after a reload.
    await panel.locator('#min').click();
    assert.equal(await panel.locator('#box').isVisible(), false);
    assert.equal(await panel.locator('#pill').isVisible(), true);

    // After a reload the setting is back, and the kept card stays out.
    await page.unroute('http://fut.test/');
    await loadAllOnOrigin(page);
    assert.equal(await panel.locator('#pill').isVisible(), true);
    await panel.locator('#pill').click();
    assert.equal(await panel.locator('#box').isVisible(), true);
    assert.equal(await panel.locator('#protect').inputValue(), '85');
    const again = await page.evaluate(async (id) => {
      const H = window.__futAssistantExport;
      H.pause = () => Promise.resolve();
      const p = await window.__futAssistantOneClick.plan({ protectMinRating: 85, protectIds: Object.keys(H.protectedCards()) }, () => {});
      return p.cards.some((c) => String(c.id) === id);
    }, keptId);
    assert.equal(again, false);
  } finally {
    await browser.close();
  }
});

test('cards in another SBC\'s draft are left out', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAllOnOrigin(page);
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    const free = await page.evaluate(async () => (await window.__futAssistantOneClick.plan({}, () => {})).cards.map((c) => String(c.id)));
    // Another SBC the Web App has loaded holds four of those cards in its saved squad.
    const taken = free.slice(0, 4);
    await page.evaluate((ids) => {
      const slot = (id) => ({ item: { id: Number(id), definitionId: 1 } });
      const other = { id: 500, name: 'Other SBC', squad: { getFieldPlayers: () => [...ids.map(slot), { item: { id: 0, definitionId: 0 } }] } };
      window.services.SBC.repository = { sets: { _collection: { 9: { challenges: { _collection: { 500: other } } } } } };
    }, taken);
    const res = await page.evaluate(async () => {
      const p = await window.__futAssistantOneClick.plan({}, () => {});
      return { ids: p.cards.map((c) => String(c.id)), drafts: p.leftOut.drafts, names: p.leftOut.draftNames };
    });
    assert.equal(res.ids.length, 11);
    assert.ok(taken.every((id) => !res.ids.includes(id)));
    assert.equal(res.drafts, 4);
    assert.deepEqual(res.names, ['Other SBC']);
    // A draft whose cards have left the club (it was submitted) counts for nothing.
    const gone = await page.evaluate(async () => {
      window.__futAssistantExport.store.set('drafts', { 999: { name: 'Submitted SBC', ids: ['91', '92'], at: Date.now() } });
      const stored = Object.keys(window.__futAssistantPrefill.draftRecords()).length;
      return { stored, drafts: (await window.__futAssistantOneClick.plan({}, () => {})).leftOut.drafts };
    });
    assert.deepEqual(gone, { stored: 1, drafts: 4 });
  } finally {
    await browser.close();
  }
});

test('"Keep my active squad" can be turned off; no buying hint when the SBC has club or nation rules', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    // Everything except three cards is in the active squad.
    await page.evaluate(() => { window.services.SBC.isItemInSquad = (id) => id > 5002; });
    const text = await solveAndApply(page);
    assert.match(text, /✖ Your club can't complete this SBC/);
    assert.match(text, /Only \d+ usable players/);
    assert.match(text, /\d+ active-squad cards were kept out\./);
    assert.doesNotMatch(text, /Buying/); // "Test Hybrid" has league and nation rules
    // The fix is one button away, for this search only (the setting stays on).
    await page.locator('#fut-assistant-export #result button', { hasText: 'Try with active-squad cards' }).click();
    await waitState(page, ['plan', 'notice']);
    assert.equal(await panelState(page), 'plan');
    assert.equal(await page.locator('#fut-assistant-export #previewList input').count(), 11);
    assert.match(await resultText(page), /Active squad/);
    assert.equal(await page.evaluate(() => window.__futAssistantExport.settings().protectSquad), true);
  } finally {
    await browser.close();
  }
});

test('when the club falls short, it says what buying would fix', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    await page.evaluate(() => {
      const c = window.getAppMain().getRootViewController().getPresentedViewController()
        .getCurrentViewController().getCurrentController()._view.deep.holder.challenge;
      c.eligibilityRequirements = [{ scope: 0, count: -1, kvPairs: { _collection: { 2: [86] } } }];
    });
    const text = await solveAndApply(page);
    assert.match(text, /✖ Your club can't complete this SBC/);
    assert.match(text, /Team rating: Min 86 \(best: \d+\)/);
    assert.match(text, /Buying \d+× any \d+-rated.* would make it possible \(about [\d,]+ coins, estimated\)\. Buy them yourself, then press Re-read\./);
    assert.equal(await page.evaluate(() => window.__saved), 0);
  } finally {
    await browser.close();
  }
});

// ---- The panel: what's on screen, unreachable targets, and stale results ----

test('panel: no SBC open means nothing to press', { skip: !chromium && 'playwright not installed', timeout: 60000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(() => { window.getAppMain = () => ({ getRootViewController: () => ({}) }); });
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    assert.match(await contextText(page), /No SBC open.*Open an SBC in the Web App to start\./);
    assert.deepEqual(await mainButton(page), { label: 'Open an SBC first', disabled: true });
    assert.match(await page.locator('#fut-assistant-export #clubInfo').textContent(), /read when a squad SBC needs it/);

    // Logged out (as on EA's Login screen): say so instead.
    await page.evaluate(() => { window.services.User.getUser = () => null; });
    await page.waitForFunction(() => /Not logged in/.test(document.getElementById('fut-assistant-export').shadowRoot.getElementById('context').textContent));
    assert.deepEqual(await mainButton(page), { label: 'Log in first', disabled: true });
  } finally {
    await browser.close();
  }
});

test('panel: a points target the club can\'t reach is said up front, with the fix one button away', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.evaluate(mockWebApp);
    await page.evaluate(mockWorkArea);
    for (const f of [bundleScript, script, prefillScript, readerScript, workAreaScript, oneClickScript, panelScript]) {
      await page.addScriptTag({ content: readFileSync(f, 'utf8') });
    }
    await page.evaluate(() => { window.__futAssistantExport.pause = () => Promise.resolve(); });
    // What the club can reach without its active squad, then a target just above that.
    const usable = await page.evaluate(async () => (await window.__futAssistantOneClick.plan({}, () => {})).points.usableTotal);
    await page.evaluate((t) => { window.__vm._challenge.scoreRequirement = t; }, usable + 100);
    await page.waitForFunction((t) => document.getElementById('fut-assistant-export').shadowRoot.getElementById('context').textContent
      .includes(t.toLocaleString()), usable + 100);

    assert.equal(await findCards(page), 'plan');
    const text = await resultText(page);
    assert.match(text, /✖ Your club can't finish this yet: 100 points short\./);
    assert.match(text, /Allowing active-squad cards would make it possible\./);
    assert.match(text, /Kept out: 4 active-squad cards/);
    const apply = page.locator('#fut-assistant-export #applyPlan');
    assert.equal(await apply.textContent(), 'Select anyway');

    await page.locator('#fut-assistant-export #result button', { hasText: 'Try with active-squad cards' }).click();
    await waitState(page, ['plan', 'notice']);
    assert.match(await resultText(page), /✔ Your club can finish this/);
    assert.equal(await apply.textContent(), 'Select in Work Area');
    assert.equal(await page.evaluate(() => window.__vm._selectedItemIds.size), 0, 'nothing selected yet');
  } finally {
    await browser.close();
  }
});

test('panel: cards found for one SBC are never placed into another', { skip: !chromium && 'playwright not installed', timeout: 90000 }, async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await loadAll(page);
    assert.equal(await findCards(page), 'plan');
    // The user opens a different SBC while the cards are showing.
    await page.evaluate(() => {
      window.getAppMain().getRootViewController().getPresentedViewController()
        .getCurrentViewController().getCurrentController()._view.deep.holder.challenge.name = 'Another SBC';
    });
    await waitState(page, ['idle'], 5000);
    assert.equal(await page.locator('#fut-assistant-export #applyPlan').count(), 0);
    assert.match(await contextText(page), /Another SBC/);
    assert.equal(await page.evaluate(() => window.__saved), 0);

    // Messages too: a refusal for one SBC doesn't linger on the next.
    await page.evaluate(() => {
      window.getAppMain().getRootViewController().getPresentedViewController()
        .getCurrentViewController().getCurrentController()._view.deep.holder.challenge
        .eligibilityRequirements = [{ scope: 0, count: -1, kvPairs: { _collection: { 2: [95] } } }];
    });
    assert.equal(await findCards(page), 'notice');
    await page.evaluate(() => {
      window.getAppMain().getRootViewController().getPresentedViewController()
        .getCurrentViewController().getCurrentController()._view.deep.holder.challenge.name = 'A third SBC';
    });
    await waitState(page, ['idle'], 5000);
    assert.equal(await resultText(page), '');
  } finally {
    await browser.close();
  }
});
