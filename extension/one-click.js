// FUT Assistant – solve and pre-fill the open SBC.
//
// plan():  reads the open SBC (no network), uses your club (read once per session at the
//          paced speed, then reused), and solves on your computer. Nothing is placed yet.
// apply(): places that one squad with the pre-fill step (saves the draft once), or selects
//          the cards of a points SBC. Never submits.
//
// Cards sitting in another SBC's saved draft, and cards from an earlier fill this session,
// are left out. "Re-read my club" starts fresh.

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
    return `Club re-read: ${data.meta.clubCards} club + ${data.meta.storageCards} storage cards.`;
  }

  const checkWait = (P) => {
    const wait = P.cooldownLeft();
    if (wait > 0) throw new Error(`Please wait ${Math.ceil(wait / 1000)}s before the next pre-fill.`);
  };
  const cardNote = (p) => [p.slot, p.duplicate ? 'storage' : p.untradeable ? 'untr.' : 'tradeable', coins(p.price)].filter(Boolean).join(' · ');

  // When the club can't do it: would buying a few plain cards make it possible? Prices are
  // estimates by rating, and "any N-rated" cards have no league, nation or club, so this only
  // helps where rating or quality is what's missing.
  function whatToBuy(X, club, sbc, opts) {
    try {
      const prices = Object.fromEntries(BUY_RATINGS.map((r) => [r, X.estimatePrice(r)]));
      const res = X.solve(club, sbc, { ...opts, market: { prices }, restarts: 2, iterations: 2000 });
      const buys = res.feasible ? res.squad.filter((p) => p.virtual) : [];
      if (!buys.length) return '';
      const byRating = new Map();
      for (const b of buys) byRating.set(b.rating, (byRating.get(b.rating) ?? 0) + 1);
      const list = [...byRating.entries()].sort((a, b) => b[0] - a[0]).map(([r, n]) => `${n}× any ${r}-rated`).join(', ');
      return ` Buying ${list} would make it possible (about ${coins(buys.reduce((a, p) => a + p.price, 0))} coins by estimate). ` +
        'Buy them yourself, then press Re-read my club.';
    } catch { return ''; }
  }

  async function planSquad(options, onStatus) {
    const { H, P, S, X } = need();
    const read = S.readOpenSbc();
    const { sbc } = read;
    if (!read.enumsFound) throw new Error("Couldn't read this SBC's requirements from the Web App. Use the debug tools instead.");
    const challenge = P.findOpenChallenge();

    const data = await loadClub(onStatus, false);
    onStatus(`Solving "${sbc.name}"…`);
    await sleep(30); // let the status paint before the solver runs

    const club = X.normalizeClub(data);
    const inDrafts = P.cardsInOtherDrafts(challenge);
    // Cards in your active squad stay there (EA lists them; drafts are handled above).
    const inSquad = club.filter((p) => H.tryCall(() => window.services.SBC.isItemInSquad(Number(p.id))) === true).map((p) => p.id);
    const opts = {
      protectMinRating: options.protectMinRating ?? 87,
      protectFavorites: options.protectFavorites !== false,
      protectIds: options.protectIds ?? [],
      excludeIds: [...new Set([...placedEarlier, ...inDrafts, ...inSquad, ...(options.excludeIds ?? [])])],
    };
    const res = X.solve(club, sbc, opts);
    if (!res.feasible) {
      const why = res.squad.length
        ? res.evaluation.results.filter((r) => !r.ok).map((r) => `${r.label} (best: ${r.actual})`).join('; ')
        : res.message;
      throw new Error(`Can't complete this with your club. ${why}.${whatToBuy(X, club, sbc, opts)}`);
    }

    const ev = res.evaluation;
    const numbers = `rating ${ev.rating} · chemistry ${ev.chemistry?.total ?? '–'} · card value ${coins(res.cost)}`;
    const apply = async (setStatus) => {
      checkWait(P);
      const code = JSON.stringify({
        kind: 'fut-assistant-prefill', v: 1, sbc: sbc.name,
        cards: res.squad.map((p) => ({ id: p.id, name: p.name, rating: p.rating, slot: p.slot })),
      });
      await P.run(code, setStatus);
      res.squad.forEach((p) => placedEarlier.add(p.id));

      const check = ev.results.filter((r) => r.unchecked || r.uncertain).map((r) => r.label);
      // Ask EA's own squad screen whether it agrees, and say so loudly if it doesn't.
      await sleep(300);
      const ea = P.eaCheck();
      let eaLine = '';
      if (ea) {
        const what = `EA shows rating ${ea.rating ?? '–'} · chemistry ${ea.chemistry ?? '–'}`;
        if (ea.met) eaLine = ` ✔ ${what}, requirements met.`;
        else {
          const labels = ea.failing.map((i) => read.eaText?.[i] ?? `requirement ${i + 1}`);
          eaLine = ` ✖ ${what}, and says NOT met: ${labels.join('; ') || 'see the list'}. Don't submit; clear the squad.`;
        }
      }
      return `Placed ${res.squad.length} cards · ${numbers}.${eaLine}` +
        (check.length ? ` ⚠ Check yourself: ${check.join('; ')}.` : '') +
        ' Check the squad, then submit it yourself.';
    };

    return {
      kind: 'squad',
      cards: res.squad.map((p) => ({ id: p.id, name: p.name, rating: p.rating, note: cardNote(p) })),
      summary: `Found ${res.squad.length} cards for "${sbc.name}" · ${numbers}.` +
        (inDrafts.size ? ` Left out ${inDrafts.size} card(s) in other SBC drafts.` : '') +
        (inSquad.length ? ` Kept ${inSquad.length} card(s) in your active squad.` : ''),
      apply,
    };
  }

  // Returns { kind, cards, summary, apply }. Nothing is placed until apply() runs.
  async function plan(options, onStatus) {
    const { P } = need();
    checkWait(P);
    // FC 27 points SBCs (Work Area: pick cards worth N points) instead of a squad.
    const workArea = window.__futAssistantWorkArea?.find();
    if (workArea) {
      const exclude = [...new Set([...placedEarlier, ...(options.excludeIds ?? [])])];
      const p = await window.__futAssistantWorkArea.plan(workArea, { ...options, excludeIds: exclude }, onStatus);
      const apply = async (setStatus) => {
        const res = await p.apply(setStatus);
        res.cards.forEach((c) => placedEarlier.add(c.id));
        return res.message;
      };
      return { kind: 'points', cards: p.cards.map((c) => ({ id: c.id, name: c.name, rating: c.rating, note: `${c.score.toLocaleString()} pts · ${cardNote(c)}` })), summary: p.summary, apply };
    }
    return planSquad(options, onStatus);
  }

  // Solve and place in one go (no preview).
  async function solveAndFill(options, onStatus) {
    const p = await plan(options, onStatus);
    return p.apply(onStatus);
  }

  window.__futAssistantOneClick = { plan, solveAndFill, refreshClub, placedEarlier };
})();
