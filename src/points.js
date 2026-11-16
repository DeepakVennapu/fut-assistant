// Points SBCs (FC 27 "Work Area" SBCs, EA type ONE_CLICK_CHALLENGE): instead of a squad you
// select up to `limit` cards whose points add up to a target (e.g. 17,000). EA gives every
// card its points as `sbsScore`. Big targets are reached over several submissions.
//
// selectForScore picks the cards you lose the least by giving up: the same fodder order and
// protection as the squad solver (storage duplicates → untradeables → tradeables, 87+ and
// special cards kept). It only proposes a selection. It never talks to EA.

import { mergeOptions, cardCost, usableFilter } from './solver.js';

// pool: normalized cards; scores: Map or object of card id → points.
// options: target (points still needed), limit (cards per submission), plus solver options.
export function selectForScore(pool, scores, options = {}) {
  const opts = mergeOptions(options);
  const target = Math.max(0, Number(options.target) || 0);
  const limit = Math.max(1, Number(options.limit) || 30);
  const scoreOf = (p) => Number(scores instanceof Map ? scores.get(p.id) : scores?.[p.id]) || 0;
  const usable = usableFilter(opts);

  const cands = pool
    .filter((p) => !p.virtual && scoreOf(p) > 0 && usable(p))
    .map((p) => ({ card: p, score: scoreOf(p), cost: cardCost(p, opts.weights) }));
  const available = cands.reduce((a, c) => a + c.score, 0);

  // Cheapest per point first, until the target or the card limit is reached.
  cands.sort((a, b) => a.cost / a.score - b.cost / b.score || b.score - a.score);
  let picked = [];
  let total = 0;
  for (const c of cands) {
    if (target && total >= target) break;
    if (picked.length >= limit) break;
    picked.push(c);
    total += c.score;
  }
  // Drop the dearest cards that aren't needed to stay at or above the target.
  if (target && total >= target) {
    for (const c of [...picked].sort((a, b) => b.cost - a.cost)) {
      if (total - c.score >= target) {
        picked = picked.filter((x) => x !== c);
        total -= c.score;
      }
    }
  }

  return {
    cards: picked.map((c) => ({ ...c.card, score: c.score })),
    score: total,
    target,
    limit,
    reached: target > 0 && total >= target,
    candidates: cands.length,
    available,
    cost: Math.round(picked.reduce((a, c) => a + c.card.price, 0)),
  };
}

// Can the usable cards reach the target at all, and in how many submissions of `limit` cards?
// Greedy, like selectForScore: batch after batch until the target is met or cards run out.
export function planBatches(pool, scores, options = {}) {
  const target = Math.max(0, Number(options.target) || 0);
  let left = pool.slice();
  let total = 0;
  let batches = 0;
  let cards = 0;
  while (total < target && batches < 50) {
    const sel = selectForScore(left, scores, { ...options, target: target - total });
    if (!sel.cards.length) break;
    const used = new Set(sel.cards.map((c) => c.id));
    left = left.filter((p) => !used.has(p.id));
    total += sel.score;
    cards += sel.cards.length;
    batches++;
  }
  return { reachable: target > 0 && total >= target, batches, cards, score: total, shortBy: Math.max(0, target - total) };
}
