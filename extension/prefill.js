// FUT Assistant – pre-fill an open SBC with a squad you already chose.
//
// You solve in the local FUT Assistant page, copy its "pre-fill code" and paste it here.
// This script then places exactly those cards in the SBC that's open in the Web App.
//
// What it does to your account:
//   - reads your club/storage (only the cards it hasn't seen this session),
//   - puts the cards into the open SBC squad and saves that draft, the same thing
//     EA's own page does when you drag cards in by hand.
// What it never does: submit the SBC, buy, sell, list, quick-sell, or fill more than
// one squad per click. It also waits 30 seconds between fills.

(() => {
  'use strict';
  const COOLDOWN_MS = 30000;
  let lastFill = 0;

  const H = () => {
    const h = window.__futAssistantExport;
    if (!h) throw new Error('Club export script did not load.');
    return h;
  };

  function parseCode(text) {
    let data;
    try { data = JSON.parse(String(text ?? '').trim()); } catch { throw new Error('That is not a FUT Assistant pre-fill code.'); }
    if (data?.kind !== 'fut-assistant-prefill' || !Array.isArray(data.cards) || !data.cards.length) {
      throw new Error('That is not a FUT Assistant pre-fill code.');
    }
    return data;
  }

  // ---- Finding the SBC that's open on screen ----

  const looksLikeChallenge = (o) => {
    try {
      return Boolean(o && typeof o === 'object' && o.squad && typeof o.squad.setPlayers === 'function' &&
        ('eligibilityRequirements' in o || 'setId' in o || typeof o.isCompleted === 'function'));
    } catch { return false; }
  };

  // FC 27 also has "points" SBCs (type ONE_CLICK_CHALLENGE): a Work Area where you pick cards
  // worth a score (e.g. 0/17,000) instead of building a squad. They have squad: null.
  const looksLikePointsChallenge = (o) => {
    try {
      return Boolean(o && typeof o === 'object' && 'eligibilityRequirements' in o && !o.squad &&
        (o.type === 'ONE_CLICK_CHALLENGE' || Number(o.scoreRequirement) > 0));
    } catch { return false; }
  };

  // Walk the Web App's current screen looking for an object shaped like an SBC challenge.
  // Shape-based so it survives EA renaming internals between seasons.
  function searchTree(start, maxDepth = 6, match = looksLikeChallenge) {
    const seen = new Set();
    const found = new Set();
    const visit = (o, depth) => {
      if (!o || typeof o !== 'object' || seen.has(o) || depth > maxDepth) return;
      if (o === window || o === window.services || (typeof Node !== 'undefined' && o instanceof Node)) return;
      seen.add(o);
      if (match(o)) { found.add(o); return; }
      if (Array.isArray(o) && o.length > 50) return;
      for (const k of Object.keys(o)) {
        let v;
        try { v = o[k]; } catch { continue; }
        if (v && typeof v === 'object') visit(v, depth + 1);
      }
    };
    visit(start, 0);
    return [...found];
  }

  function findOpenChallenge() {
    const { tryCall } = H();
    const root = tryCall(() => window.getAppMain().getRootViewController());
    const current = tryCall(() => root.getPresentedViewController().getCurrentViewController().getCurrentController());
    const direct = [current?._challenge, current?.challenge, current?._viewmodel?.challenge].filter(looksLikeChallenge);
    const found = direct.length ? direct : searchTree(current ?? root);
    const open = [...new Set(found)];
    if (open.length === 0) {
      const points = searchTree(current ?? root, 6, looksLikePointsChallenge)[0];
      if (points) {
        throw new Error(`"${points.name ?? 'This SBC'}" is a points SBC (pick cards worth ${Number(points.scoreRequirement)
          .toLocaleString()} points), not a squad. Use Solve & pre-fill to select cards for it.`);
      }
      throw new Error('No open SBC found. Open the SBC so you can see its squad, then try again.');
    }
    if (open.length > 1) throw new Error('Found more than one SBC on screen. Open just the one you want to fill.');
    return open[0];
  }

  // ---- Placing cards in the right positions ----

  function slotPositions(squad) {
    const { tryCall, firstDefined, position } = H();
    const slots = tryCall(() => squad.getFieldPlayers?.()) ?? tryCall(() => squad.getPlayers?.()) ?? [];
    // Locked "brick" spots in smaller SBCs can't take a card.
    return slots.map((s) => (tryCall(() => s?.isBrick?.()) ? BRICK : position(firstDefined(
      s?.position?.typeName, tryCall(() => s?.getPosition?.()?.typeName), s?.position?.typeId, s?.position))));
  }
  const BRICK = '#BRICK';

  function itemPositions(item) {
    const { firstDefined, position } = H();
    const pref = position(firstDefined(item.preferredPosition, item.position));
    const alts = (firstDefined(item.possiblePositions, item.alternatePositions, []) || []).map(position);
    return new Set([pref, ...alts].filter(Boolean));
  }

  // Put as many cards as possible into one of their own positions; the rest fill the gaps.
  // `wantedSlots[i]` is the position the solver scored card i in (e.g. 'CM'). Those go first,
  // so the squad EA sees is the one whose chemistry the solver computed: when more cards can
  // play a position than there are slots, a different choice changes the chemistry.
  function placeCards(items, slots, wantedSlots = []) {
    const owner = new Array(slots.length).fill(-1);
    items.forEach((_, i) => {
      const want = wantedSlots[i];
      if (!want) return;
      const s = slots.findIndex((name, k) => name === want && owner[k] === -1);
      if (s !== -1) owner[s] = i;
    });
    const preset = new Set(owner.filter((i) => i !== -1));
    const pos = items.map(itemPositions);
    const tryAssign = (i, seen) => {
      for (let s = 0; s < slots.length; s++) {
        // Slots the solver chose are fixed; the matching never moves those cards.
        if (seen[s] || !pos[i].has(slots[s]) || preset.has(owner[s])) continue;
        seen[s] = true;
        if (owner[s] === -1 || tryAssign(owner[s], seen)) { owner[s] = i; return true; }
      }
      return false;
    };
    items.forEach((_, i) => { if (!preset.has(i)) tryAssign(i, new Array(slots.length).fill(false)); });
    const placed = new Set(owner.filter((i) => i !== -1));
    const rest = items.map((_, i) => i).filter((i) => !placed.has(i));
    for (let s = 0; s < slots.length && rest.length; s++) if (owner[s] === -1 && slots[s] !== BRICK) owner[s] = rest.shift();
    return owner.map((i) => (i === -1 ? null : items[i]));
  }

  // ---- Main ----

  async function ensureItems(ids, onStatus) {
    const { itemCache, readStorage, readClubPlayers, pause } = H();
    const missing = () => ids.filter((id) => !itemCache.has(id));
    if (missing().length) {
      onStatus('Finding your cards (storage)…');
      await readStorage().catch(() => {});
    }
    if (missing().length) {
      await pause();
      await readClubPlayers((t) => onStatus(t.replace('Reading club', 'Finding your cards')), () => !missing().length);
    }
    return missing();
  }

  const cooldownLeft = () => Math.max(0, lastFill + COOLDOWN_MS - Date.now());

  async function run(text, onStatus = () => {}) {
    const wait = cooldownLeft();
    if (wait > 0) throw new Error(`Please wait ${Math.ceil(wait / 1000)}s before the next pre-fill.`);
    const code = parseCode(text);
    const challenge = findOpenChallenge();

    const wanted = code.cards.filter((c) => !c.buy && c.id != null).map((c) => String(c.id));
    const toBuy = code.cards.filter((c) => c.buy);
    const missing = await ensureItems(wanted, onStatus);
    if (missing.length) {
      const names = code.cards.filter((c) => missing.includes(String(c.id))).map((c) => c.name).join(', ');
      throw new Error(`These cards are no longer in your club or storage: ${names}. Re-export your club and solve again.`);
    }

    const { itemCache, observe } = H();
    const slots = slotPositions(challenge.squad);
    const openSpots = slots.filter((s) => s !== BRICK).length;
    if (slots.length && wanted.length > openSpots) {
      throw new Error(`The code has ${wanted.length} cards but this SBC has ${openSpots} spots. Is the right SBC open?`);
    }
    const wantedSlots = code.cards.filter((c) => !c.buy && c.id != null).map((c) => c.slot ?? null);
    const placement = placeCards(wanted.map((id) => itemCache.get(id)), slots.length ? slots : wanted.map(() => null), wantedSlots);

    onStatus('Placing cards…');
    challenge.squad.setPlayers(placement, true);
    // Saves the draft squad, as EA's page does when you place cards. It does NOT submit.
    if (window.services?.SBC?.saveChallenge) await observe(window.services.SBC.saveChallenge(challenge), 'Save squad');
    try { challenge.onDataChange?.notify?.({ squad: challenge.squad }); } catch { /* view may refresh on its own */ }
    lastFill = Date.now();
    recordDraft(challenge, wanted);

    const buyNote = toBuy.length ? ` Buy and place ${toBuy.length} more yourself: ${toBuy.map((c) => c.name).join(', ')}.` : '';
    return `Placed ${wanted.length} card(s).${buyNote} Check the squad, then submit it yourself. ` +
      'If the screen did not update, go back and reopen the SBC.';
  }

  // EA's own verdict on the squad as placed, using the Web App's read-only checks
  // (meetsRequirements / isRequirementMet / getChemistry / getRating are local calculations).
  // Returns null if this Web App version doesn't expose them.
  function eaCheck(challenge = findOpenChallenge()) {
    const { tryCall } = H();
    const met = tryCall(() => challenge.meetsRequirements());
    if (typeof met !== 'boolean') return null;
    const reqs = challenge.eligibilityRequirements ?? [];
    const failing = reqs.map((r, i) => (tryCall(() => challenge.isRequirementMet(r)) === false ? i : -1)).filter((i) => i >= 0);
    return {
      met,
      failing,
      rating: tryCall(() => challenge.squad.getRating()) ?? null,
      chemistry: tryCall(() => challenge.squad.getChemistry()) ?? null,
    };
  }

  // ---- Cards already sitting in another SBC's saved draft ----
  // EA only lists the active squad's cards (services.SBC.isItemInSquad), so drafts are
  // found two ways: the fills this tool made (remembered for a week in this browser), and
  // the squads of any SBCs the Web App has already loaded this session. No network calls.
  const DRAFT_DAYS = 7;
  function draftRecords() {
    const { store } = H();
    const all = store.get('drafts', {});
    const cutoff = Date.now() - DRAFT_DAYS * 86400000;
    for (const k of Object.keys(all)) if (!(all[k]?.at > cutoff)) delete all[k];
    return all;
  }
  function recordDraft(challenge, ids) {
    if (challenge?.id == null) return;
    const { store } = H();
    const all = draftRecords();
    all[String(challenge.id)] = { name: challenge.name ?? '', ids: ids.map(String), at: Date.now() };
    store.set('drafts', all);
  }
  const forgetDrafts = () => H().store.set('drafts', {});

  function cardsInOtherDrafts(challenge) {
    const { tryCall } = H();
    const mine = challenge?.id == null ? null : String(challenge.id);
    const ids = new Set();
    for (const [id, rec] of Object.entries(draftRecords())) if (id !== mine) rec.ids.forEach((x) => ids.add(String(x)));
    const list = (c) => (!c ? [] : Array.isArray(c) ? c : Object.values(c._collection ?? c));
    for (const set of list(tryCall(() => window.services.SBC.repository.sets))) {
      for (const ch of list(tryCall(() => set.challenges) ?? tryCall(() => set.getChallenges()))) {
        if (!ch?.squad || ch === challenge || (mine && String(ch.id) === mine)) continue;
        for (const slot of tryCall(() => ch.squad.getFieldPlayers()) ?? []) {
          const item = slot?.item ?? tryCall(() => slot.getItem());
          if (item?.id && Number(item.definitionId) > 0) ids.add(String(item.id));
        }
      }
    }
    return ids;
  }

  // The 30 s wait is shared with points-SBC selections (work-area.js).
  const markFilled = () => { lastFill = Date.now(); };

  window.__futAssistantPrefill = {
    run, parseCode, placeCards, findOpenChallenge, searchTree, eaCheck, cooldownLeft, markFilled, COOLDOWN_MS,
    cardsInOtherDrafts, draftRecords, forgetDrafts,
  };
})();
