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
  const MAX_EXTRA_FETCHES = 4;

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

  async function selectAndFill(found, options, onStatus, excludeIds = []) {
    const { H, P, X } = need();
    const { vm, controller } = found;
    const wait = P.cooldownLeft();
    if (wait > 0) throw new Error(`Please wait ${Math.ceil(wait / 1000)}s before the next pre-fill.`);

    const ch = vm.getChallenge?.() ?? vm._challenge;
    const name = ch.name ?? 'this SBC';
    const target = Number(ch.scoreRequirement) || 0;
    const submitted = Number(ch.submittedScore) || 0;
    const remaining = Math.max(0, target - submitted);
    if (!target) throw new Error(`Couldn't read the points target of "${name}".`);
    if (!remaining) throw new Error(`"${name}" already has all ${target.toLocaleString()} points.`);
    if ((H.tryCall(() => vm.getSelectedCount()) ?? 0) > 0) {
      throw new Error('Some cards are already selected. Deselect them first; FUT Assistant won\'t change your selection.');
    }
    const limit = Number(H.tryCall(() => vm.getSelectionLimit())) || 30;

    // Storage duplicates are the cheapest fodder; know which cards are in storage.
    if (!H.clubState.storageRead) {
      onStatus('Reading SBC storage…');
      await H.readStorage().catch(() => {});
    }

    const inSquad = (e) => H.tryCall(() => window.services.SBC.isItemInSquad(Number(e.id))) === true;
    const scoreOf = (e) => Number(H.tryCall(() => vm._itemScoreMap.get(e.id)) ?? e.sbsScore) || 0;
    const usable = () => [...vm._itemEntityMap.values()].filter((e) =>
      H.tryCall(() => vm.isItemSelectable(e)) !== false && scoreOf(e) > 0 && !inSquad(e) &&
      !(Number(e.loans) > 0 || H.tryCall(() => e.isLimitedUse?.())));
    // Enough loaded when the cheapest 'limit' cards could already cover what's needed, or
    // there are plenty more cards than one submission can take.
    await loadMore(vm, () => usable().length >= limit * 3, onStatus);

    const entities = usable();
    const byId = new Map(entities.map((e) => [String(e.id), e]));
    const cards = entities.map((e) => X.normalizePlayer(H.toCard(e, H.storageIds.has(String(e.id)))));
    const scores = new Map(entities.map((e) => [String(e.id), scoreOf(e)]));
    const sel = X.selectForScore(cards, scores, {
      target: remaining, limit, protectMinRating: options.protectMinRating ?? 87, excludeIds,
    });
    if (!sel.cards.length) {
      throw new Error(`No usable cards for "${name}" (cards rated ${options.protectMinRating ?? 87}+, special cards and ` +
        'cards in your active squad are kept).');
    }

    onStatus('Selecting cards…');
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
    return {
      cards: sel.cards,
      message: `Selected ${selected} card(s) · ${sel.score.toLocaleString()} points for "${name}" · card value ` +
        `${Math.round(sel.cost).toLocaleString()}.` +
        (agrees ? ` ✔ EA shows ${eaScore.toLocaleString()} points selected.`
          : ` ✖ EA shows ${Number.isFinite(eaScore) ? eaScore.toLocaleString() : '?'} points for ${eaCount} card(s). ` +
            'Check the selection before reviewing.') +
        (left > 0 ? ` ${left.toLocaleString()} more needed after this; submit it, then click again for the next batch.`
          : ' That covers the target.') +
        (check.length ? ` ⚠ Check yourself: ${check.join('; ')}.` : '') +
        ' Press Review Selection and submit it yourself.',
    };
  }

  window.__futAssistantWorkArea = { find, selectAndFill, looksLikeWorkArea };
})();
