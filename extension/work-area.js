// FUT Assistant – points SBCs (FC 27 "Work Area" SBCs, EA type ONE_CLICK_CHALLENGE).
//
// These SBCs have no squad: you select up to 30 cards whose points (EA's `sbsScore`) add up
// to a target, then press Review Selection and submit. Big targets (e.g. 17,000 for a Player
// of the Month) take several submissions.
//
// What it does: picks your cheapest eligible cards for the points still needed and selects
// them in the Work Area exactly as tapping them would (toggleSelection + the view update).
// Selecting is local to the page; nothing is sent to EA. If the Work Area hasn't loaded
// enough of your club yet, it loads more with EA's own paging, at the paced speed.
// What it never does: press Review Selection, submit, or change a selection you made.

(() => {
  'use strict';
  const MAX_EXTRA_FETCHES = 8; // paced; enough for a club of about 300 players

  const need = () => {
    const H = window.__futAssistantExport;
    const P = window.__futAssistantPrefill;
    const X = window.__futAssistantSolver;
    if (!H || !P || !X?.selectForScore) throw new Error('Some extension scripts did not load. Reload the Web App.');
    return { H, P, X };
  };

  // The Work Area's view model: it holds the challenge, the loaded cards and the selection.
  const looksLikeWorkArea = (o) => {
    try {
      return Boolean(o && typeof o === 'object' && o._challenge && typeof o.toggleSelection === 'function' &&
        typeof o.getSelectedScore === 'function' && o._itemEntityMap instanceof Map);
    } catch { return false; }
  };
  // The controller that draws it (progress bar, Review button, card highlights).
  const looksLikeWorkAreaController = (vm) => (o) => {
    try { return Boolean(o && typeof o === 'object' && o.viewModel === vm && typeof o._refreshSelectionControls === 'function'); } catch { return false; }
  };

  // Returns { vm, controller } for the open points SBC, or null if none is open.
  function find() {
    const { H, P } = need();
    const root = H.tryCall(() => window.getAppMain().getRootViewController());
    const current = H.tryCall(() => root.getPresentedViewController().getCurrentViewController().getCurrentController());
    const start = current ?? root;
    if (!start) return null;
    const vms = P.searchTree(start, 6, looksLikeWorkArea);
    if (!vms.length) return null;
    if (vms.length > 1) throw new Error('Found more than one points SBC on screen. Open just the one you want.');
    const vm = vms[0];
    const controller = P.searchTree(start, 6, looksLikeWorkAreaController(vm))[0] ?? null;
    return { vm, controller };
  }

  // Load more of the club into the Work Area with EA's own paging (a server read, like
  // pressing Next), paced, until it has everything or we've asked a few times.
  async function loadMore(vm, enough, onStatus) {
    const { H } = need();
    for (let i = 0; i < MAX_EXTRA_FETCHES; i++) {
      const state = H.tryCall(() => vm._currentState());
      if (!state || state.retrievedAll || enough()) return;
      if (typeof vm._ensureItemsForPage !== 'function') return;
      onStatus(`Loading more of your club into the Work Area… ${vm._itemEntityMap.size} cards`);
      await H.pause();
      const before = vm._itemEntityMap.size;
      // EA fetches until it has more than (page + 1) * pageSize + 1 cards; this page needs
      // exactly one more batch, so each paced step is a single request.
      const page = Math.floor(Math.max(0, state.items.length - 1) / (vm._pageSize || 30));
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 30000);
        try { vm._ensureItemsForPage(page, () => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
      });
      if (vm._itemEntityMap.size === before) return;
    }
  }

  // Load the SBC Storage tab's cards (the cheapest fodder) the way tapping the tab does: one
  // read for this challenge, then back to the tab that was showing. Only when storage has cards.
  async function loadStorageTab(vm, onStatus) {
    const { H } = need();
    const STORAGE = window.OneClickSBCWorkAreaTab?.STORAGE ?? 'storage';
    if (!H.storageIds.size || typeof vm.setActiveTab !== 'function' || !(vm._tabStates instanceof Map)) return;
    // The real Web App creates an empty state for every tab up front; only a state with cards,
    // or one marked complete, means the tab was really loaded.
    const st = vm._tabStates.get(STORAGE);
    if (st && (st.items?.length > 0 || st.retrievedAll)) return;
    const back = H.tryCall(() => vm.getActiveTab()) ?? vm._activeTab;
    if (back === STORAGE) return;
    onStatus('Loading SBC storage into the Work Area…');
    await H.pause();
    const wait = (tab) => new Promise((resolve) => {
      const timer = setTimeout(resolve, 30000);
      try { vm.setActiveTab(tab, () => { clearTimeout(timer); resolve(); }); } catch { clearTimeout(timer); resolve(); }
    });
    await wait(STORAGE);
    await wait(back);
  }

  // What the panel shows about an open points SBC, without loading anything (local reads only).
  function describe(found) {
    const { H } = need();
    const { vm } = found;
    const ch = vm.getChallenge?.() ?? vm._challenge;
    return {
      kind: 'points',
      name: ch.name ?? 'this SBC',
      target: Number(ch.scoreRequirement) || 0,
      submitted: Number(ch.submittedScore) || 0,
      selectedCount: Number(H.tryCall(() => vm.getSelectedCount())) || 0,
      selectedScore: Number(H.tryCall(() => vm.getSelectedScore())) || 0,
    };
  }

  const tagsFor = (card, inSquad) => [
    card.duplicate ? 'Storage' : card.untradeable ? 'Untradeable' : 'Tradeable',
    inSquad ? 'Active squad' : null,
  ].filter(Boolean);

  // Works out the selection. Nothing is selected until apply() runs.
  async function plan(found, options, onStatus) {
    const { H, P, X } = need();
    const { vm, controller } = found;
    const info = describe(found);
    const { name, target, submitted } = info;
    const remaining = Math.max(0, target - submitted);
    if (!target) throw H.notice(`Couldn't read the points target of "${name}".`);
    if (!remaining) throw H.notice(`"${name}" already has all its points.`, { tone: 'ok' });
    const yours = () => H.notice(`You already have ${describe(found).selectedCount} cards selected`, {
      lines: ['FUT Assistant won\'t change a selection you made.', 'Press Remove All in the Work Area, then try again.'],
    });
    if (info.selectedCount > 0) throw yours();
    const limit = Number(H.tryCall(() => vm.getSelectionLimit())) || 30;

    // Storage duplicates are the cheapest fodder; know which cards are in storage.
    if (!H.clubState.storageRead) {
      onStatus('Reading SBC storage…');
      await H.readStorage().catch(() => {});
    }
    await loadStorageTab(vm, onStatus);
    // The whole club is needed to say whether the target can be reached at all.
    await loadMore(vm, () => false, onStatus);

    const keepSquad = options.protectSquad !== false;
    const inDrafts = P.cardsInOtherDrafts(vm._challenge);
    const isInSquad = (e) => H.tryCall(() => window.services.SBC.isItemInSquad(Number(e.id))) === true;
    const scoreOf = (e) => Number(H.tryCall(() => vm._itemScoreMap.get(e.id)) ?? e.sbsScore) || 0;
    const eligible = [...vm._itemEntityMap.values()].filter((e) =>
      H.tryCall(() => vm.isItemSelectable(e)) !== false && scoreOf(e) > 0 && !inDrafts.has(String(e.id)) &&
      !(Number(e.loans) > 0 || H.tryCall(() => e.isLimitedUse?.())));
    const squadIds = new Set(eligible.filter(isInSquad).map((e) => String(e.id)));
    const entities = keepSquad ? eligible.filter((e) => !squadIds.has(String(e.id))) : eligible;

    const toCards = (list) => list.map((e) => X.normalizePlayer(H.toCard(e, H.storageIds.has(String(e.id)))));
    const byId = new Map(eligible.map((e) => [String(e.id), e]));
    const cards = toCards(entities);
    const scores = new Map(eligible.map((e) => [String(e.id), scoreOf(e)]));
    const opts = {
      target: remaining, limit,
      protectMinRating: options.protectMinRating ?? 87,
      protectFavorites: options.protectFavorites !== false,
      protectIds: options.protectIds ?? [],
      excludeIds: options.excludeIds ?? [],
    };
    const sel = X.selectForScore(cards, scores, opts);
    const keptSquad = keepSquad ? squadIds.size : 0;
    const allowSquad = keptSquad ? { label: 'Try with active-squad cards', retry: { protectSquad: false } } : null;
    if (!sel.cards.length) {
      throw H.notice('No cards to use for this SBC', {
        lines: [`Kept: cards rated ${opts.protectMinRating}+, favourites, special cards` +
          (keptSquad ? `, ${keptSquad} active-squad cards` : '') + ', and cards in other SBC drafts.'],
        action: allowSquad,
      });
    }
    const whole = X.planBatches(cards, scores, opts);
    // Would allowing the active squad make the target reachable? Only worth saying if so.
    const squadWouldHelp = !whole.reachable && keptSquad > 0 &&
      X.planBatches(toCards(eligible), scores, opts).reachable;

    const apply = async (setStatus) => {
      const wait = P.cooldownLeft();
      if (wait > 0) throw H.notice(`Please wait ${Math.ceil(wait / 1000)} s`, { lines: ['FUT Assistant waits 30 seconds between fills.'], tone: 'info' });
      if (describe(found).selectedCount > 0) throw yours();
      setStatus('Selecting cards…');
      const view = H.tryCall(() => controller.getView());
      let selected = 0;
      for (const c of sel.cards) {
        const e = byId.get(String(c.id));
        if (!e || H.tryCall(() => vm.isItemSelected(e))) continue;
        if (H.tryCall(() => vm.isSelectionLimitReached())) break;
        // Exactly what tapping a card does in the Work Area. Local only; nothing is sent.
        if (vm.toggleSelection(e)) selected++;
        H.tryCall(() => view?.setItemSelected(e, true));
      }
      H.tryCall(() => controller._refreshSelectionControls());
      P.markFilled();

      const eaScore = Number(H.tryCall(() => vm.getSelectedScore()));
      const eaCount = Number(H.tryCall(() => vm.getSelectedCount()));
      const agrees = eaScore === sel.score && eaCount === sel.cards.length;
      // Requirement lines only ("OVR Min: 45"); the same list on screen also holds the reward card.
      const check = (window.__futAssistantSbc?.screenText?.() ?? []).filter((t) => t && !t.includes('\n') && t.includes(':'));
      const left = remaining - (Number.isFinite(eaScore) ? eaScore : sel.score);
      if (!agrees) {
        return {
          tone: 'bad',
          title: 'EA shows a different selection',
          lines: [`EA: ${eaCount} cards, ${Number.isFinite(eaScore) ? eaScore.toLocaleString() : '?'} points. ` +
            `FUT Assistant: ${sel.cards.length} cards, ${sel.score.toLocaleString()} points.`],
          next: 'Check the selection, or press Remove All in the Work Area.',
          cards: sel.cards,
        };
      }
      return {
        tone: whole.reachable ? 'ok' : 'warn',
        title: `Selected ${selected} cards · ${eaScore.toLocaleString()} points`,
        lines: [
          'EA\'s progress bar agrees.',
          left > 0 ? `${left.toLocaleString()} points still needed after this batch.` : 'That covers the target.',
          !whole.reachable ? `Your club can't reach ${target.toLocaleString()} yet (${whole.shortBy.toLocaleString()} short). ` +
            'Cards you submit now only count if you finish before it expires.' : null,
          check.length ? `Check yourself: ${check.join('; ')}.` : null,
        ],
        next: left > 0 && whole.reachable
          ? 'In EA: Review Selection → Confirm Submission. Then come back for the next batch.'
          : 'In EA: Review Selection → Confirm Submission, when you\'re sure.',
        cards: sel.cards,
      };
    };

    return {
      kind: 'points',
      name,
      cards: sel.cards.map((c) => ({
        id: c.id, name: c.name, rating: c.rating, pos: c.positions[0] ?? '', score: c.score, value: c.price,
        tags: tagsFor(c, squadIds.has(String(c.id))),
      })),
      value: sel.cost,
      points: {
        target, submitted, remaining, batch: sel.score, after: Math.max(0, remaining - sel.score), limit,
        reachable: whole.reachable, batches: whole.batches, cardsNeeded: whole.cards,
        // Everything the usable cards could add, not just what reaching the target takes.
        usableTotal: submitted + sel.available, shortBy: whole.shortBy, squadWouldHelp,
      },
      // Only cards still in the club: a submitted draft's cards are gone, not kept out.
      leftOut: { drafts: [...vm._itemEntityMap.keys()].filter((id) => inDrafts.has(String(id))).length, squad: keptSquad },
      action: squadWouldHelp ? allowSquad : null,
      apply,
    };
  }

  window.__futAssistantWorkArea = { find, describe, plan, looksLikeWorkArea };
})();
