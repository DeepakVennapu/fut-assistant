// FUT Assistant – find cards for the open SBC, then place them.
//
// screen(): what's open in the Web App right now (local reads only, no network).
// plan():   reads the open SBC (no network), uses your club (read once per session at the
//           paced speed, then reused), and solves on your computer. Nothing is placed yet.
//           Returns the numbers, the cards and an apply() function for the panel.
// apply():  places that one squad with the pre-fill step (saves the draft once), or selects
//           the cards of a points SBC. Never submits.
//
// Cards sitting in another SBC's saved draft, and cards from an earlier fill this session,
// are left out. "Re-read" starts fresh.

(() => {
  'use strict';
  const placedEarlier = new Set();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const coins = (n) => Math.round(n).toLocaleString();
  // Ratings offered as "buy any N-rated card" when your club alone can't do the SBC.
  const BUY_RATINGS = [60, 70, 75, 76, 77, 78, 79, 80, 81, 82, 83, 84, 85, 86];

  const need = () => {
    const H = window.__futAssistantExport;
    const P = window.__futAssistantPrefill;
    const S = window.__futAssistantSbc;
    const X = window.__futAssistantSolver;
    if (!H || !P || !S || !X) throw new Error('Some extension scripts did not load. Reload the Web App.');
    return { H, P, S, X };
  };

  async function loadClub(onStatus, refresh) {
    const { H, P } = need();
    if (refresh) {
      H.itemCache.clear();
      H.clubState.clubComplete = false;
      H.clubState.storageRead = false;
      H.clubState.readAt = null;
      placedEarlier.clear();
      P.forgetDrafts();
    }
    if (!H.clubState.storageRead) {
      onStatus('Reading SBC storage…');
      await H.readStorage().catch(() => {});
    }
    if (!H.clubState.clubComplete) {
      await H.pause();
      await H.readClubPlayers(onStatus);
    }
    const all = [...H.itemCache.values()];
    const clubItems = all.filter((i) => !H.storageIds.has(String(i.id)));
    const storageItems = all.filter((i) => H.storageIds.has(String(i.id)));
    return H.buildExport(clubItems, storageItems, []);
  }

  async function refreshClub(onStatus) {
    const data = await loadClub(onStatus, true);
    return { tone: 'ok', title: 'Club re-read', lines: [`${data.meta.clubCards} club cards and ${data.meta.storageCards} in SBC storage.`] };
  }

  // What's on screen: { kind: 'none' } | { kind: 'squad', name, filled, slots, met } |
  // { kind: 'points', name, target, submitted, selectedCount, selectedScore }.
  function screen() {
    const { H, P } = need();
    const W = window.__futAssistantWorkArea;
    const wa = H.tryCall(() => W?.find());
    if (wa) return W.describe(wa);
    let ch;
    try { ch = P.findOpenChallenge(); } catch { return { kind: 'none' }; }
    const slots = H.tryCall(() => ch.squad.getFieldPlayers()) ?? [];
    const open = slots.filter((s) => !H.tryCall(() => s?.isBrick?.()));
    const filled = open.filter((s) => Number((s?.item ?? H.tryCall(() => s.getItem()))?.definitionId) > 0).length;
    const ea = filled ? P.eaCheck(ch) : null;
    return { kind: 'squad', name: ch.name ?? 'this SBC', filled, slots: open.length, met: ea?.met ?? null, chemistry: ea?.chemistry ?? null, rating: ea?.rating ?? null };
  }

  const cooldownLeft = () => window.__futAssistantPrefill?.cooldownLeft() ?? 0;
  const checkWait = (H, P) => {
    const wait = P.cooldownLeft();
    if (wait > 0) throw H.notice(`Please wait ${Math.ceil(wait / 1000)} s`, { lines: ['FUT Assistant waits 30 seconds between fills.'], tone: 'info' });
  };
  const tagsFor = (p, inSquad) => [
    p.duplicate ? 'Storage' : p.untradeable ? 'Untradeable' : 'Tradeable',
    inSquad ? 'Active squad' : null,
  ].filter(Boolean);

  // When the club can't do it: would buying a few plain cards make it possible? Prices are
  // estimates by rating. "Any N-rated" cards have no league, nation or club, so the hint is
  // only given for SBCs without such rules (live, it once suggested bronzes for a club rule).
  function whatToBuy(X, club, sbc, opts) {
    const plain = (sbc.requirements ?? []).every((r) => ['teamRating', 'chemistry', 'playerChem'].includes(r.kind) ||
      ((r.kind === 'each' || r.kind === 'count') && Object.keys(r.filter ?? {}).every((k) => ['minRating', 'maxRating', 'quality'].includes(k))));
    if (!plain) return null;
    try {
      const prices = Object.fromEntries(BUY_RATINGS.map((r) => [r, X.estimatePrice(r)]));
      const res = X.solve(club, sbc, { ...opts, market: { prices }, restarts: 2, iterations: 2000 });
      const buys = res.feasible ? res.squad.filter((p) => p.virtual) : [];
      if (!buys.length) return null;
      const byRating = new Map();
      for (const b of buys) byRating.set(b.rating, (byRating.get(b.rating) ?? 0) + 1);
      const list = [...byRating.entries()].sort((a, b) => b[0] - a[0]).map(([r, n]) => `${n}× any ${r}-rated`).join(', ');
      return `Buying ${list} would make it possible (about ${coins(buys.reduce((a, p) => a + p.price, 0))} coins, estimated). ` +
        'Buy them yourself, then press Re-read.';
    } catch { return null; }
  }

  async function planSquad(options, onStatus) {
    const { H, P, S, X } = need();
    const read = S.readOpenSbc();
    const { sbc } = read;
    if (!read.enumsFound) throw H.notice("Couldn't read this SBC's requirements", { lines: ['The Web App may have changed. Use Copy SBC requirements under Troubleshooting.'] });
    const challenge = P.findOpenChallenge();

    const data = await loadClub(onStatus, false);
    onStatus(`Solving "${sbc.name}"…`);
    await sleep(30); // let the status paint before the solver runs

    const club = X.normalizeClub(data);
    const inDrafts = P.cardsInOtherDrafts(challenge);
    // Cards in your active squad (starters, subs and reserves; EA lists them) stay there unless
    // "Keep my active squad" is off. Drafts are handled above.
    const squadIds = new Set(club.filter((p) => H.tryCall(() => window.services.SBC.isItemInSquad(Number(p.id))) === true).map((p) => p.id));
    const keepSquad = options.protectSquad !== false;
    const opts = {
      protectMinRating: options.protectMinRating ?? 87,
      protectFavorites: options.protectFavorites !== false,
      protectIds: options.protectIds ?? [],
      excludeIds: [...new Set([...placedEarlier, ...inDrafts, ...(keepSquad ? squadIds : []), ...(options.excludeIds ?? [])])],
    };
    const res = X.solve(club, sbc, opts);
    const keptSquad = keepSquad ? squadIds.size : 0;
    if (!res.feasible) {
      const why = res.squad.length
        ? res.evaluation.results.filter((r) => !r.ok).map((r) => `${r.label} (best: ${r.actual})`)
        : [res.message];
      throw H.notice("Your club can't complete this SBC", {
        lines: [
          ...why,
          keptSquad ? `${keptSquad} active-squad card${keptSquad === 1 ? ' was' : 's were'} kept out.` : null,
          whatToBuy(X, club, sbc, opts),
        ],
        action: keptSquad ? { label: 'Try with active-squad cards', retry: { protectSquad: false } } : null,
      });
    }

    const ev = res.evaluation;
    const check = ev.results.filter((r) => r.unchecked || r.uncertain).map((r) => r.label);
    const apply = async (setStatus) => {
      checkWait(H, P);
      const code = JSON.stringify({
        kind: 'fut-assistant-prefill', v: 1, sbc: sbc.name,
        cards: res.squad.map((p) => ({ id: p.id, name: p.name, rating: p.rating, slot: p.slot })),
      });
      await P.run(code, setStatus);
      res.squad.forEach((p) => placedEarlier.add(p.id));

      // Ask EA's own squad screen whether it agrees, and say so loudly if it doesn't.
      await sleep(300);
      const ea = P.eaCheck();
      if (ea && !ea.met) {
        const labels = ea.failing.map((i) => read.eaText?.[i] ?? `requirement ${i + 1}`);
        return {
          tone: 'bad',
          title: 'EA says the requirements are NOT met',
          lines: [`EA shows rating ${ea.rating ?? '–'}, chemistry ${ea.chemistry ?? '–'}.`, ...labels.map((l) => `✖ ${l}`)],
          next: 'Don\'t submit. In EA: Clear Squad.',
        };
      }
      return {
        tone: 'ok',
        title: `Placed ${res.squad.length} cards`,
        lines: [
          ea ? `EA confirms: requirements met, rating ${ea.rating ?? '–'}, chemistry ${ea.chemistry ?? '–'}.` : `Rating ${ev.rating}, chemistry ${ev.chemistry?.total ?? '–'}.`,
          check.length ? `Check yourself: ${check.join('; ')}.` : null,
        ],
        next: 'In EA: check the squad, then Submit.',
      };
    };

    const total = ev.results.filter((r) => r.kind !== 'unsupported').length;
    return {
      kind: 'squad',
      name: sbc.name,
      cards: res.squad.map((p) => ({
        id: p.id, name: p.name, rating: p.rating, pos: p.slot ?? '', value: p.price, tags: tagsFor(p, squadIds.has(p.id)),
      })),
      value: res.cost,
      squad: { rating: ev.rating, chemistry: ev.chemistry?.total ?? null, met: ev.results.filter((r) => r.ok && r.kind !== 'unsupported').length, total, check },
      // Only cards still in the club: a submitted draft's cards are gone, not kept out.
      leftOut: { ...window.__futAssistantWorkArea.draftsLeftOut(inDrafts, club.map((c) => c.id)), squad: keptSquad },
      apply,
    };
  }

  // Returns { kind, name, cards, ..., apply }. Nothing is placed until apply() runs.
  async function plan(options, onStatus) {
    const { H, P } = need();
    checkWait(H, P);
    // FC 27 points SBCs (Work Area: pick cards worth N points) instead of a squad.
    const workArea = window.__futAssistantWorkArea?.find();
    if (workArea) {
      const exclude = [...new Set([...placedEarlier, ...(options.excludeIds ?? [])])];
      const p = await window.__futAssistantWorkArea.plan(workArea, { ...options, excludeIds: exclude }, onStatus);
      const apply = async (setStatus) => {
        const res = await p.apply(setStatus);
        (res.cards ?? []).forEach((c) => placedEarlier.add(c.id));
        return res;
      };
      return { ...p, apply };
    }
    let open = true;
    try { P.findOpenChallenge(); } catch (e) { open = false; if (!/No open SBC/.test(e.message)) throw H.notice(e.message); }
    if (!open) throw H.notice('No SBC is open', { lines: ['Open an SBC so its squad or Work Area is on screen.'], tone: 'info' });
    return planSquad(options, onStatus);
  }

  // Solve and place in one go (no preview).
  async function solveAndFill(options, onStatus) {
    const p = await plan(options, onStatus);
    return p.apply(onStatus);
  }

  window.__futAssistantOneClick = { plan, solveAndFill, refreshClub, screen, cooldownLeft, placedEarlier };
})();
