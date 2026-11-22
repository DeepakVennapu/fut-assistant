// FUT Assistant – club reading and export (READ-ONLY). The panel is in panel.js.
//
// Runs inside EA's Web App page after you log in. When you press the button it reads
// your club players and SBC storage through the Web App's own read calls, one page at
// a time at a human-like pace, and downloads them as a JSON file for FUT Assistant.
//
// It never buys, sells, lists, moves, quick-sells or submits anything, and sends
// nothing anywhere except to a file on your computer.
//
// The Web App's internals aren't documented and change between seasons, so every
// field below is read defensively. If something comes out wrong, the export's
// "meta.sampleKeys" lists the raw fields EA provided, which helps fix the mapping.

(() => {
  'use strict';
  const VERSION = '0.1.0';
  const PAGE_SIZE = 91;          // the Web App's own club page size
  const MAX_PAGES = 80;          // safety cap (~7,000 cards)
  const PAUSE_MS = [1500, 3000]; // wait between page reads

  // Position ids used by the Web App, folded to the positions chemistry uses.
  const POSITION_IDS = ['GK', 'SW', 'RWB', 'RB', 'RCB', 'CB', 'LCB', 'LB', 'LWB', 'RDM', 'CDM', 'LDM',
    'RM', 'RCM', 'CM', 'LCM', 'LM', 'RAM', 'CAM', 'LAM', 'RF', 'CF', 'LF', 'RW', 'RS', 'ST', 'LS', 'LW'];
  const FOLD = { RCB: 'CB', LCB: 'CB', SW: 'CB', RDM: 'CDM', LDM: 'CDM', RCM: 'CM', LCM: 'CM',
    RAM: 'CAM', LAM: 'CAM', RF: 'CF', LF: 'CF', RS: 'ST', LS: 'ST' };
  const ICON_LEAGUE_ID = 2118;

  // Every card the extension has read this session, by card id, so pre-fill can reuse them.
  const itemCache = new Map();
  const storageIds = new Set();
  // clubComplete: the whole club has been read this session (not just enough for a pre-fill).
  const clubState = { clubComplete: false, storageRead: false, readAt: null };
  const remember = (items, fromStorage = false) => {
    for (const i of items) {
      if (i?.id == null) continue;
      itemCache.set(String(i.id), i);
      if (fromStorage) storageIds.add(String(i.id));
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const pause = () => sleep(PAUSE_MS[0] + Math.random() * (PAUSE_MS[1] - PAUSE_MS[0]));
  const tryCall = (fn) => { try { return fn(); } catch { return undefined; } };
  const firstDefined = (...vals) => vals.find((v) => v !== undefined && v !== null);

  function position(p) {
    if (p == null) return null;
    const name = typeof p === 'number' ? POSITION_IDS[p] : String(p).toUpperCase();
    return name ? FOLD[name] ?? name : null;
  }

  // ---- Web App access (read-only) ----

  function webAppReady() {
    return typeof window.services !== 'undefined' && window.services?.Club?.search;
  }

  // Web App calls return an "observable"; turn it into a promise.
  function observe(observable, label) {
    return new Promise((resolve, reject) => {
      if (!observable || typeof observable.observe !== 'function') {
        reject(new Error(`${label}: the Web App API looks different from what this extension expects.`));
        return;
      }
      const timer = setTimeout(() => reject(new Error(`${label}: timed out`)), 30000);
      observable.observe(undefined, (_sender, response) => {
        clearTimeout(timer);
        if (response && response.success === false) reject(new Error(`${label}: EA returned status ${response.status}`));
        else resolve(response);
      });
    });
  }

  function searchCriteria(offset) {
    const Dto = window.UTSearchCriteriaDTO;
    const c = Dto ? new Dto() : {};
    c.type = window.SearchType?.PLAYER ?? 'player';
    c.offset = offset;
    c.count = PAGE_SIZE;
    return c;
  }

  // `until` lets pre-fill stop reading as soon as it has found the cards it needs.
  // The real server can return fewer cards than asked for (77 of 91 on a real club) while
  // the club repo still says endOfList: false, so a short page is NOT the end. Stop on an
  // empty page, an explicit "retrieved all" flag, or a page that brings nothing new.
  async function readClubPlayers(onProgress, until) {
    const all = [];
    const seen = new Set();
    let offset = 0;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await observe(window.services.Club.search(searchCriteria(offset)), 'Club search');
      const items = res?.response?.items ?? res?.data?.items ?? [];
      const fresh = items.filter((i) => i?.id != null && !seen.has(String(i.id)));
      fresh.forEach((i) => seen.add(String(i.id)));
      // Advance by what came back, not by the page size, so a short page can't skip cards.
      offset += items.length;
      all.push(...fresh);
      remember(fresh);
      onProgress(`Reading club… ${all.length} cards`);
      const exhausted = items.length === 0 || fresh.length === 0 ||
        res?.response?.retrievedAll === true || res?.response?.endOfList === true;
      if (exhausted) { clubState.clubComplete = true; clubState.readAt = Date.now(); break; }
      if (until?.()) break;
      await pause();
    }
    return all;
  }

  // SBC storage holds at most 100 cards. Older Web Apps had requestStorageItems();
  // FC 27 has searchStorageItems(criteria).
  async function readStorage() {
    const svc = window.services?.Item;
    let call;
    if (svc?.requestStorageItems) call = () => svc.requestStorageItems();
    else if (svc?.searchStorageItems) {
      call = () => {
        const c = searchCriteria(0);
        c.count = 100;
        return svc.searchStorageItems(c);
      };
    }
    if (!call) return { items: [], note: 'SBC storage not available in this Web App version' };
    const res = await observe(call(), 'SBC storage');
    const items = res?.response?.items ?? res?.data?.items ?? [];
    storageIds.clear();
    remember(items, true);
    clubState.storageRead = true;
    return { items };
  }

  // ---- Mapping EA items to FUT Assistant cards ----

  // FC 27 keys league and club names by season, e.g. "global.leagueFull.2027.league13" and
  // "global.teamabbr15.2027.team1". Find the season(s) in the Web App's string table once.
  let seasonYears;
  function nameSeasons() {
    if (seasonYears) return seasonYears;
    const table = tryCall(() => window.services.Localization.repository._collection);
    const years = new Set();
    if (table && typeof table === 'object') {
      for (const k of Object.keys(table)) {
        const m = /^global\.(?:leagueFull|teamabbr15)\.(\d{4})\./.exec(k);
        if (m) years.add(m[1]);
      }
    }
    seasonYears = [...years].sort().reverse();
    return seasonYears;
  }

  const localizeCache = new Map();
  function localizeName(kind, id) {
    if (id == null) return null;
    const key = `${kind}:${id}`;
    if (localizeCache.has(key)) return localizeCache.get(key);
    const loc = window.services?.Localization;
    const seasons = nameSeasons();
    const candidates = {
      nation: [`search.nationName.nation${id}`],
      league: [...seasons.flatMap((y) => [`global.leagueFull.${y}.league${id}`, `global.leagueabbr15.${y}.league${id}`]),
        `global.leagueFull.${id}`, `global.leagueabbr5.${id}`, `search.leagueName.league${id}`],
      club: [...seasons.flatMap((y) => [`global.teamFull.${y}.team${id}`, `global.teamabbr15.${y}.team${id}`]),
        `global.teamFull.${id}`, `global.teamabbr15.${id}`, `search.teamName.team${id}`],
    }[kind];
    let name = null;
    for (const k of candidates) {
      const v = tryCall(() => loc?.localize?.(k));
      if (typeof v === 'string' && v && v !== k && !v.includes(k)) { name = v; break; }
    }
    // Unknown names fall back to the id; chemistry and "same league" checks still work.
    const result = name ?? `${kind[0].toUpperCase()}${kind.slice(1)} ${id}`;
    localizeCache.set(key, result);
    return result;
  }

  function playerName(item) {
    const s = tryCall(() => item.getStaticData?.()) ?? item._staticData ?? {};
    return firstDefined(s.name, s.knownAs, [s.firstName, s.lastName].filter(Boolean).join(' ') || undefined,
      item.name, `#${item.definitionId ?? item.id}`);
  }

  function isLoanOrLocked(item) {
    return Boolean(
      tryCall(() => item.isLimitedUse?.()) || (Number(item.loans) > 0) ||
      tryCall(() => item.isEnrolledInAcademy?.()));
  }

  // What the card is worth, from EA's own data already on the card (no outside site):
  // the market average when EA has one, else the lowest price EA allows for it. With
  // neither, no price is set and the solver falls back to its estimate by rating.
  function cardValue(item) {
    const avg = Number(firstDefined(item._marketAverage, tryCall(() => item.getMarketAverage?.())));
    if (avg > 0) return { price: avg, priceSource: 'ea-average' };
    const min = Number(firstDefined(item._itemPriceLimits?.minimum, tryCall(() => item.getPriceLimits?.()?.minimum)));
    if (min > 0) return { price: min, priceSource: 'ea-minimum' };
    return { priceSource: 'estimate' };
  }

  function toCard(item, fromStorage) {
    const definitionId = Number(firstDefined(item.definitionId, item.resourceId, item.id));
    const rareflag = Number(firstDefined(item.rareflag, item.rareFlag, 0));
    const leagueId = firstDefined(item.leagueId, item.league);
    const isIcon = Boolean(tryCall(() => item.isIcon?.()) ?? leagueId === ICON_LEAGUE_ID);
    const isHero = Boolean(tryCall(() => item.isHero?.()));
    const preferred = position(firstDefined(item.preferredPosition, tryCall(() => item.getPosition?.())));
    const alternates = (firstDefined(item.possiblePositions, item.alternatePositions, []) || []).map(position);
    const positions = [...new Set([preferred, ...alternates].filter(Boolean))];
    const tradeable = tryCall(() => item.isTradeable?.());
    const special = Boolean(tryCall(() => item.isSpecial?.()) ?? rareflag > 1);
    return {
      id: String(item.id),
      // Same player across versions shares the low 24 bits of the definition id.
      baseId: String(firstDefined(item.databaseId, item.baseId, definitionId & 0xffffff)),
      definitionId,
      name: playerName(item),
      rating: Number(item.rating),
      positions,
      nation: localizeName('nation', item.nationId),
      league: localizeName('league', leagueId),
      club: localizeName('club', item.teamId),
      nationId: item.nationId ?? null,
      leagueId: leagueId ?? null,
      clubId: item.teamId ?? null,
      rare: rareflag >= 1,
      special,
      rareflag,
      isIcon,
      isHero,
      untradeable: fromStorage || Boolean(firstDefined(item.untradeable, tradeable === undefined ? undefined : !tradeable, false)),
      duplicate: fromStorage,
      favorite: item.isFavorite === true || tryCall(() => (typeof item.isFavorite === 'function' ? item.isFavorite() : false)) === true,
      ...cardValue(item),
    };
  }

  function buildExport(clubItems, storageItems, notes) {
    const isPlayer = (i) => i && Number.isFinite(Number(i.rating)) && (i.type === undefined || i.type === 'player' ||
      tryCall(() => i.isPlayer?.()) === true);
    const skipped = { loansOrLocked: 0, notPlayers: 0 };
    const cards = [];
    for (const [items, fromStorage] of [[clubItems, false], [storageItems, true]]) {
      for (const item of items) {
        if (!isPlayer(item)) { skipped.notPlayers++; continue; }
        if (isLoanOrLocked(item)) { skipped.loansOrLocked++; continue; }
        cards.push(toCard(item, fromStorage));
      }
    }
    const sample = clubItems[0] ?? storageItems[0];
    return {
      meta: {
        source: 'FUT Assistant club export',
        version: VERSION,
        exportedAt: new Date().toISOString(),
        clubCards: cards.filter((c) => !c.duplicate).length,
        storageCards: cards.filter((c) => c.duplicate).length,
        skipped,
        notes,
        sampleKeys: sample ? Object.keys(sample).sort() : [],
      },
      players: cards,
    };
  }

  function download(data) {
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `fut-club-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- Settings and protected cards, remembered in this browser only (localStorage) ----

  const store = {
    get(key, fallback) {
      try { const v = JSON.parse(localStorage.getItem(`futAssistant.${key}`)); return v ?? fallback; } catch { return fallback; }
    },
    set(key, value) { try { localStorage.setItem(`futAssistant.${key}`, JSON.stringify(value)); } catch { /* private mode */ } },
  };
  const settings = () => ({ protectMinRating: 87, preview: true, protectFavorites: true, protectSquad: true, ...store.get('settings', {}) });
  const saveSettings = (patch) => store.set('settings', { ...settings(), ...patch });
  // Cards you told the tool to always keep: { id: name }.
  const protectedCards = () => store.get('protected', {});
  const protectCards = (cards) => {
    const all = protectedCards();
    for (const c of cards) all[String(c.id)] = c.name ?? '';
    store.set('protected', all);
  };

  // A message for the panel: a short title, a few plain lines, and optionally one action the
  // panel can offer as a button ({ label, retry: { ...options to solve again with } }).
  function notice(title, { lines = [], action = null, tone = 'bad' } = {}) {
    const e = new Error([title, ...lines].join(' '));
    e.title = title;
    e.lines = lines.filter(Boolean);
    e.action = action;
    e.tone = tone;
    return e;
  }

  // Exposed for testing and for a manual run from the console.
  window.__futAssistantExport = {
    buildExport, toCard, cardValue, position, settings, saveSettings, protectedCards, protectCards, store, readClubPlayers,
    readStorage, download, notice, webAppReady, observe, tryCall, firstDefined,
    pause, itemCache, storageIds, clubState, VERSION,
  };

})();
