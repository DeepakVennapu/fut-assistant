import { test } from 'node:test';
import assert from 'node:assert/strict';
import { teamRating } from '../src/rating.js';
import { chemistryFor } from '../src/chemistry.js';
import { evaluate } from '../src/requirements.js';
import { normalizePlayer } from '../src/model.js';
import { solve } from '../src/solver.js';
import { analyzeRepeat } from '../src/analyze.js';
import { selectForScore, planBatches } from '../src/points.js';

let nextId = 1;
const card = (o) => normalizePlayer({
  id: nextId++, rating: 80, positions: ['CM'], nation: 'Spain', league: 'L1', club: 'C1', price: 500, ...o,
});
const F442 = ['GK', 'RB', 'CB', 'CB', 'LB', 'RM', 'CM', 'CM', 'LM', 'ST', 'ST'];

test('team rating: flat squad and above-average bonus', () => {
  assert.equal(teamRating(Array(11).fill(84)), 84);
  assert.equal(teamRating([88, ...Array(10).fill(84)]), 84);
  assert.equal(teamRating([...Array(6).fill(86), ...Array(5).fill(83)]), 85);
});

test('chemistry: same club/nation/league in position is 33', () => {
  const squad = F442.map((pos) => card({ positions: [pos] }));
  assert.equal(chemistryFor(squad, '4-4-2').total, 33);
});

test('chemistry: an out-of-position player earns and gives nothing', () => {
  const squad = F442.map((pos) => card({ positions: [pos] }));
  squad[0] = card({ positions: ['ST'] }); // no GK left
  const c = chemistryFor(squad, '4-4-2');
  assert.equal(c.perPlayer.filter((p) => p.slot === null).length, 1);
  assert.equal(c.total, 30);
});

test('requirements: count, distinct and same-club checks', () => {
  const squad = [
    ...Array.from({ length: 4 }, () => card({ club: 'A', league: 'X', rare: true })),
    ...Array.from({ length: 7 }, (_, i) => card({ club: `B${i}`, league: i % 2 ? 'Y' : 'Z' })),
  ];
  const ev = evaluate(squad, {
    requirements: [
      { kind: 'count', filter: { rare: true }, min: 5 },
      { kind: 'distinct', attr: 'league', min: 3 },
      { kind: 'sameAttr', attr: 'club', max: 3 },
    ],
  });
  assert.deepEqual(ev.results.map((r) => r.ok), [false, true, false]);
  assert.equal(ev.ok, false);
});

test('solver: meets the rating, prefers cheap fodder, skips protected cards', () => {
  const pool = [
    ...Array.from({ length: 11 }, (_, i) => card({ baseId: `a${i}`, rating: 84, price: 2200, duplicate: true, untradeable: true })),
    ...Array.from({ length: 11 }, (_, i) => card({ baseId: `b${i}`, rating: 84, price: 2200 })),
    card({ baseId: 'star', rating: 91, price: 90000 }),
  ];
  const res = solve(pool, { requirements: [{ kind: 'teamRating', min: 84 }] });
  assert.equal(res.feasible, true);
  assert.equal(res.evaluation.rating, 84);
  assert.ok(res.squad.every((p) => p.duplicate), 'should use storage duplicates first');
  assert.ok(!res.squad.some((p) => p.baseId === 'star'));
});

test('solver: never puts the same player twice in one squad', () => {
  const pool = Array.from({ length: 22 }, (_, i) => card({ baseId: `p${i % 11}`, rating: 82 }));
  const res = solve(pool, { requirements: [{ kind: 'teamRating', min: 82 }] });
  assert.equal(res.feasible, true);
  assert.equal(new Set(res.squad.map((p) => p.baseId)).size, 11);
});

test('solver: says so when the club is too small', () => {
  const res = solve([card({}), card({})], { requirements: [] });
  assert.equal(res.feasible, false);
});

test('repeat: counts how many times the club covers an SBC', () => {
  const pool = Array.from({ length: 25 }, (_, i) => card({ baseId: `r${i}`, rating: 83 }));
  const res = analyzeRepeat(pool, { requirements: [{ kind: 'teamRating', min: 83 }] });
  assert.equal(res.times, 2);
  assert.ok(res.blockers.length > 0);
});

test('repeat: with market prices, shows what the next attempt costs', () => {
  const pool = Array.from({ length: 15 }, (_, i) => card({ baseId: `m${i}`, rating: 83 }));
  const res = analyzeRepeat(pool, { requirements: [{ kind: 'teamRating', min: 83 }] }, { market: { prices: { 83: 1200 } } });
  assert.equal(res.times, 1);
  assert.equal(res.nextWithMarket.buys.length, 7);
});

test('requirements: per-player chemistry and unsupported entries', () => {
  const squad = F442.map((pos) => card({ positions: [pos] }));
  squad[10] = card({ positions: ['ST'], nation: 'Peru', league: 'L9', club: 'C9' });
  const ev = evaluate(squad, { requirements: [{ kind: 'playerChem', min: 1 }, { kind: 'unsupported', label: 'Mystery' }] });
  assert.equal(ev.results[0].ok, false);
  assert.equal(ev.results[0].actual, 10);
  assert.equal(ev.results[1].unchecked, true);
  assert.equal(ev.results[1].ok, true);
});

test('requirements: EA ids work as filters', () => {
  const squad = [card({ leagueId: 13 }), card({ leagueId: 13 }), card({ leagueId: 53 })];
  const ev = evaluate(squad, { squadSize: 3, requirements: [{ kind: 'count', filter: { leagueId: [13] }, min: 2 }] });
  assert.equal(ev.ok, true);
});

// Real data from EA's Web App (FC 27, "Red Bull Wiiings Challenge", 4-3-3 slots). EA showed
// these per-player chemistry values for this exact placement. Out-of-position cards are
// given a position the formation doesn't have, so the assignment matches EA's placement.
test('chemistry: matches EA on a real squad placed in the SBC\'s own slots', () => {
  const F433 = ['GK', 'RB', 'CB', 'CB', 'LB', 'CM', 'CM', 'CM', 'RW', 'ST', 'LW'];
  const real = [
    // [name, in position?, clubId, nationId, leagueId, EA chemistry]
    ['Jaouen', true, 13, 18, 13, 2], ['Chavas', false, 116035, 18, 2218, 0], ['Raum', false, 112172, 21, 19, 0],
    ['Goretzka', false, 2, 21, 13, 0], ['Morroni', true, 116312, 18, 2221, 1], ['Onana', true, 2, 7, 13, 3],
    ['Kamara', true, 2, 18, 13, 3], ['Brandt', true, 245, 21, 10, 0], ['Mateta', false, 1799, 18, 13, 0],
    ['Kean', true, 1745, 27, 31, 0], ['Godts', true, 73, 7, 16, 1],
  ];
  const squad = real.map(([name, inPos, club, nation, league], i) =>
    normalizePlayer({ id: `r${i}`, name, rating: 80, positions: [inPos ? F433[i] : 'CDM'], club, nation, league }));
  const c = chemistryFor(squad, F433);
  assert.deepEqual(c.perPlayer.map((p) => p.chem), real.map((r) => r[5]));
  assert.equal(c.total, 10);
});

// Points SBCs (FC 27 Work Area). Scores are EA's sbsScore values seen on the real Web App.
test('points: cheapest fodder first, best cards kept, stops at the target', () => {
  const c = (id, o) => normalizePlayer({ id, rating: 82, positions: ['CM'], price: 900, ...o });
  const pool = [
    c('dup', { duplicate: true, untradeable: true }),
    c('untr', { untradeable: true }),
    c('trade', {}),
    c('star', { rating: 88, untradeable: true }),
    c('promo', { special: true, untradeable: true }),
  ];
  const scores = { dup: 340, untr: 280, trade: 410, star: 900, promo: 500 };
  const res = selectForScore(pool, scores, { target: 600, limit: 30 });
  assert.deepEqual(res.cards.map((p) => p.id), ['dup', 'untr']);
  assert.equal(res.score, 620);
  assert.equal(res.reached, true);
  assert.equal(res.candidates, 3); // 88-rated and special cards are protected
});

test('points: respects the card limit and reports a partial batch', () => {
  const pool = Array.from({ length: 40 }, (_, i) => normalizePlayer({ id: `p${i}`, rating: 80, positions: ['ST'], untradeable: true }));
  const scores = Object.fromEntries(pool.map((p) => [p.id, 180]));
  const res = selectForScore(pool, scores, { target: 17000, limit: 30 });
  assert.equal(res.cards.length, 30);
  assert.equal(res.score, 5400);
  assert.equal(res.reached, false);
});

test('points: drops cards the target does not need', () => {
  const pool = [
    normalizePlayer({ id: 'a', rating: 75, positions: ['ST'], untradeable: true, price: 100 }),
    normalizePlayer({ id: 'b', rating: 83, positions: ['ST'], untradeable: true, price: 1200 }),
  ];
  // Per point, a (100/90) is cheaper than b (1200/410), so a goes in first; b alone covers 300.
  const res = selectForScore(pool, { a: 90, b: 410 }, { target: 300 });
  assert.deepEqual(res.cards.map((p) => p.id), ['b']);
  assert.equal(res.score, 410);
});

test('favourites are kept by default and can be released', () => {
  const pool = Array.from({ length: 12 }, (_, i) => card({ positions: [F442[i % 11]], favorite: i === 0, price: i === 0 ? 1 : 500 }));
  const sbc = { requirements: [{ kind: 'teamRating', min: 80 }] };
  const kept = solve(pool, sbc);
  assert.equal(kept.feasible, true);
  assert.ok(!kept.squad.some((p) => p.id === pool[0].id), 'the favourite is not used even though it is cheapest');
  const released = solve(pool, sbc, { protectFavorites: false });
  assert.ok(released.squad.some((p) => p.id === pool[0].id));
});

test('points: says how many submissions the target takes, or how far short the club is', () => {
  const pool = Array.from({ length: 40 }, (_, i) => normalizePlayer({ id: `b${i}`, rating: 80, positions: ['ST'], untradeable: true }));
  const scores = Object.fromEntries(pool.map((p) => [p.id, 180]));
  const ok = planBatches(pool, scores, { target: 6000, limit: 30 });
  assert.deepEqual([ok.reachable, ok.batches, ok.cards], [true, 2, 34]);
  const short = planBatches(pool, scores, { target: 17000, limit: 30 });
  assert.deepEqual([short.reachable, short.score, short.shortBy], [false, 7200, 9800]);
});
