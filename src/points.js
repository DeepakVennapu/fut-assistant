// Points SBCs (FC 27 "Work Area" SBCs, EA type ONE_CLICK_CHALLENGE): instead of a squad you
// select up to `limit` cards whose points add up to a target (e.g. 17,000). EA gives every
// card its points as `sbsScore`. Big targets are reached over several submissions.
//
// selectForScore picks the cards you lose the least by giving up: the same fodder order and
// protection as the squad solver (storage duplicates → untradeables → tradeables, 87+ and
// special cards kept). It only proposes a selection. It never talks to EA.

import { mergeOptions, cardCost } from './solver.js';

// pool: normalized cards; scores: Map or object of card id → points.
// options: target (points still needed), limit (cards per submission), plus solver options.
export function selectForScore(pool, scores, options = {}) {
  const opts = mergeOptions(options);
  const target = Math.max(0, Number(options.target) || 0);
  const limit = Math.max(1, Number(options.limit) || 30);
  const scoreOf = (p) => Number(scores instanceof Map ? scores.get(p.id) : scores?.[p.id]) || 0;
  const protect = new Set(opts.protectIds.map(String));
  const exclude = new Set(opts.excludeIds.map(String));
  const isProtected = (p) =>
    protect.has(p.id) || (p.rating >= opts.protectMinRating && !(p.duplicate && p.untradeable));

  const cands = pool
    .filter((p) => !p.virtual && scoreOf(p) > 0 && !exclude.has(p.id) && !isProtected(p) && (opts.allowSpecial || !p.special))
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
