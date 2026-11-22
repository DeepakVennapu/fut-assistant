// FUT Assistant – the panel in the Web App's bottom-left corner.
//
// One job: find cards for the SBC that's open, show them, and place them when you say so.
// It reads what's on screen once a second (local reads only, no network) so the button and
// the line above it always match what's open. Settings and troubleshooting tools are folded
// away. It never submits.

(() => {
  'use strict';
  const POLL_MS = 1000;
  const H = () => window.__futAssistantExport;
  const OC = () => window.__futAssistantOneClick;
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString();
  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };

  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    * { box-sizing: border-box; }
    .box { font: 13px/1.45 system-ui, -apple-system, sans-serif; background: #13161d; color: #e6e8ec;
      border: 1px solid #2a2f39; border-radius: 12px; width: 300px; max-height: calc(100vh - 24px);
      display: flex; flex-direction: column; box-shadow: 0 8px 28px rgba(0,0,0,.45); overflow: hidden; }
    .scroll { overflow: auto; padding: 10px 12px 12px; }
    header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; border-bottom: 1px solid #222733; }
    header b { flex: 1; font-size: 13px; letter-spacing: .2px; }
    .icon { background: none; border: 0; color: #9aa3af; font-size: 16px; line-height: 1; cursor: pointer; padding: 2px 6px; border-radius: 6px; width: auto; }
    .icon:hover { background: #222733; color: #e6e8ec; }
    .pill { font: 600 12px system-ui, sans-serif; background: #4c8dff; color: #fff; border: 0; border-radius: 999px;
      padding: 8px 14px; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.4); }
    .context { margin-bottom: 10px; }
    .context .name { font-weight: 600; }
    .context .sub { color: #9aa3af; font-size: 12px; }
    button { font: inherit; cursor: pointer; border: 0; border-radius: 8px; }
    .primary { width: 100%; padding: 9px; background: #4c8dff; color: #fff; font-weight: 600; }
    .primary.warn { background: #b7791f; }
    .secondary { width: 100%; padding: 8px; background: #252b37; color: #e6e8ec; margin-top: 6px; }
    button:disabled { opacity: .5; cursor: default; }
    .link { background: none; color: #9aa3af; text-decoration: underline; padding: 0; font-size: 12px; }
    .progress { margin-top: 8px; font-size: 12px; color: #9aa3af; display: flex; gap: 8px; align-items: center; }
    .spin { width: 12px; height: 12px; border: 2px solid #3a4150; border-top-color: #4c8dff; border-radius: 50%; animation: s 0.8s linear infinite; }
    @keyframes s { to { transform: rotate(360deg); } }
    .card { margin-top: 10px; padding: 10px; border: 1px solid #2a2f39; border-radius: 10px; background: #181c25; }
    .card.ok { border-color: #2f6f52; } .card.warn { border-color: #8a6420; } .card.bad { border-color: #8a3a3a; } .card.info { border-color: #34507f; }
    .card h3 { margin: 0 0 6px; font-size: 13px; }
    .card p { margin: 4px 0; font-size: 12px; color: #c4cad3; }
    .card .next { margin-top: 8px; padding: 7px 8px; background: #20252f; border-radius: 6px; color: #e6e8ec; font-size: 12px; }
    .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin: 6px 0; }
    .stat { background: #20252f; border-radius: 6px; padding: 5px 6px; }
    .stat .k { color: #9aa3af; font-size: 11px; } .stat .v { font-weight: 600; font-size: 13px; }
    .meter { display: flex; height: 8px; border-radius: 4px; overflow: hidden; background: #2a2f39; margin: 6px 0 2px; }
    .meter .done { background: #2f6f52; } .meter .batch { background: #3ecf8e; }
    .verdict { margin: 8px 0 4px; padding: 7px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
    .verdict.ok { background: #183a2b; color: #7ee2b0; } .verdict.bad { background: #3a1d1d; color: #ff9a9a; }
    .list { margin: 8px 0 4px; max-height: 170px; overflow: auto; border-top: 1px solid #262b36; }
    .listhead { font-size: 11px; color: #9aa3af; margin-top: 8px; }
    .row { display: grid; grid-template-columns: 16px 24px 1fr; gap: 6px; align-items: center;
      padding: 4px 0; border-bottom: 1px solid #222733; font-size: 12px; }
    .row input { margin: 0; }
    .row .r { font-weight: 700; font-size: 13px; }
    .row .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .row .m { color: #9aa3af; font-size: 11px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    .row .m b { color: #7ee2b0; font-weight: 600; }
    .row.off { opacity: .45; }
    .tag { font-size: 10px; padding: 1px 5px; border-radius: 4px; background: #262b36; color: #c4cad3; white-space: nowrap; }
    .tag.Storage { background: #183a2b; color: #7ee2b0; } .tag.Tradeable { background: #3b2f17; color: #f5c56b; }
    .tag.Active { background: #3a1d1d; color: #ff9a9a; }
    .note { font-size: 11px; color: #9aa3af; margin-top: 4px; }
    .opts { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #c4cad3; margin: 6px 0; }
    .opts input[type=number] { width: 52px; background: #0f1115; color: #e6e8ec; border: 1px solid #2a2f39; border-radius: 4px; padding: 2px 4px; }
    details { margin-top: 10px; border-top: 1px solid #222733; padding-top: 8px; }
    summary { cursor: pointer; color: #9aa3af; font-size: 12px; list-style: none; }
    summary::-webkit-details-marker { display: none; }
    summary::before { content: '▸ '; } details[open] summary::before { content: '▾ '; }
    .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 10px; font-size: 11px; color: #9aa3af; }
    .status { margin-top: 6px; color: #9aa3af; font-size: 12px; }
    hr { border: 0; border-top: 1px solid #222733; margin: 10px 0; }
    textarea { width: 100%; height: 54px; margin: 6px 0; background: #0f1115; color: #e6e8ec; border: 1px solid #2a2f39;
      border-radius: 6px; font: 11px ui-monospace, monospace; resize: vertical; }
  `;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function mount() {
    if (document.getElementById('fut-assistant-export')) return;
    const host = document.createElement('div');
    host.id = 'fut-assistant-export';
    // Sits just right of the Web App's 96px left nav so it never covers Store/Club.
    host.style.cssText = 'position:fixed;left:108px;bottom:12px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <button id="pill" class="pill" hidden>FUT Assistant ▴</button>
      <div class="box" id="box">
        <header><b>FUT Assistant</b><button id="min" class="icon" title="Minimise">–</button></header>
        <div class="scroll">
          <div class="context" id="context"><div class="name">Loading…</div></div>
          <button id="find" class="primary" disabled>Find cards</button>
          <div class="progress" id="progress" hidden><span class="spin"></span><span id="progressText"></span></div>
          <div id="result" data-state="idle"></div>
          <details id="settings">
            <summary id="settingsSummary"></summary>
            <label class="opts">Keep cards rated <input id="protect" type="number" min="50" max="99"> and up</label>
            <label class="opts"><input id="keepFavs" type="checkbox"> Keep my favourites</label>
            <label class="opts"><input id="keepSquad" type="checkbox"> Keep my active squad</label>
            <label class="opts"><input id="previewOn" type="checkbox"> Show me the cards before placing them</label>
            <button id="clearKept" class="link" hidden></button>
          </details>
          <div class="foot"><span id="clubInfo"></span><button id="refreshClub" class="link">Re-read</button></div>
          <details id="advanced">
            <summary>Troubleshooting tools</summary>
            <button id="export" class="secondary">Export club (read-only)</button>
            <div class="status" id="exportStatus">Saves your club and SBC storage to a file.</div>
            <hr>
            <button id="readSbc" class="secondary">Copy SBC requirements</button>
            <div class="status" id="readStatus">Copies the open SBC's rules as FUT Assistant read them.</div>
            <hr>
            <textarea id="code" placeholder="Paste a pre-fill code from the local page" spellcheck="false"></textarea>
            <button id="prefill" class="secondary">Pre-fill open SBC</button>
            <div class="status" id="prefillStatus">Places a squad from a code. You check and submit yourself.</div>
          </details>
        </div>
      </div>`;
    const $ = (id) => root.getElementById(id);

    // ---- State ----
    let busy = false;
    let plan = null;           // the cards found, waiting for "Place"
    let excluded = [];         // cards unticked in this search ("Swap out unticked")
    let oneOff = {};           // options for this search only (e.g. allow active squad)
    let current = { kind: 'none' };
    let shownFor = null;      // the SBC the result area is about

    // ---- Settings (remembered in this browser only) ----
    const cfg = () => H()?.settings?.() ?? { protectMinRating: 87, preview: true, protectFavorites: true, protectSquad: true };
    const save = (patch) => H()?.saveSettings?.(patch);
    const kept = () => H()?.protectedCards?.() ?? {};
    const showSettings = () => {
      const c = cfg();
      $('protect').value = c.protectMinRating;
      $('keepFavs').checked = c.protectFavorites;
      $('keepSquad').checked = c.protectSquad;
      $('previewOn').checked = c.preview;
      const n = Object.keys(kept()).length;
      const parts = [`${c.protectMinRating}+`, c.protectFavorites && 'favourites', c.protectSquad && 'active squad', n && `${n} chosen`].filter(Boolean);
      $('settingsSummary').textContent = `Keeping: ${parts.join(' · ')}`;
      $('clearKept').hidden = n === 0;
      $('clearKept').textContent = `Stop keeping the ${n} card(s) I chose`;
    };
    $('protect').addEventListener('change', () => { save({ protectMinRating: Number($('protect').value) || 87 }); showSettings(); });
    $('keepFavs').addEventListener('change', () => { save({ protectFavorites: $('keepFavs').checked }); showSettings(); });
    $('keepSquad').addEventListener('change', () => { save({ protectSquad: $('keepSquad').checked }); showSettings(); });
    $('previewOn').addEventListener('change', () => { save({ preview: $('previewOn').checked }); showSettings(); });
    $('clearKept').addEventListener('click', () => { H()?.store?.set('protected', {}); showSettings(); });
    const options = () => {
      const c = cfg();
      return {
        protectMinRating: c.protectMinRating, protectFavorites: c.protectFavorites, protectSquad: c.protectSquad,
        protectIds: Object.keys(kept()), excludeIds: excluded, ...oneOff,
      };
    };

    // ---- Minimise ----
    const setCollapsed = (on) => { $('box').hidden = on; $('pill').hidden = !on; save({ collapsed: on }); };
    $('min').addEventListener('click', () => setCollapsed(true));
    $('pill').addEventListener('click', () => { setCollapsed(false); tick(); });

    // ---- What's on screen, and the main button ----
    const setContext = (name, sub) => {
      const c = $('context');
      c.textContent = '';
      c.append(el('div', 'name', name), el('div', 'sub', sub));
    };
    const setMain = (label, enabled, warn = false) => {
      $('find').textContent = label;
      $('find').disabled = !enabled;
      $('find').classList.toggle('warn', warn);
    };
    function readScreen() {
      try { return OC()?.screen() ?? { kind: 'none' }; } catch { return { kind: 'none' }; }
    }
    function tick() {
      if ($('box').hidden) return;
      const info = H()?.clubState;
      $('clubInfo').textContent = info?.clubComplete && info.readAt
        ? `Club: ${fmt(H().itemCache.size)} cards · read ${ago(info.readAt)}`
        : 'Club: read when a squad SBC needs it (about 10 s)';
      if (busy) return;
      if (!H()?.webAppReady?.()) { setContext('Waiting for the Web App', 'Let it finish loading.'); setMain('Find cards', false); return; }
      // Logged out, EA's user lookup is empty (read-only check).
      if (H().tryCall(() => window.services.User.getUser()) == null) {
        setContext('Not logged in', 'Log in to the Web App to start.');
        setMain('Log in first', false);
        return;
      }
      current = readScreen();
      // A different SBC is open than the result is about: drop it (cards, messages, all).
      if (result.dataset.state !== 'idle' && shownFor !== null && (current.kind === 'none' || current.name !== shownFor)) clearResult();
      if (current.kind === 'none') {
        setContext('No SBC open', 'Open an SBC in the Web App to start.');
        setMain('Open an SBC first', false);
        return;
      }
      if (current.kind === 'points') {
        const sel = current.selectedCount ? ` · ${current.selectedCount} selected (${fmt(current.selectedScore)} pts)` : '';
        setContext(current.name, `Points SBC · ${fmt(current.submitted)} / ${fmt(current.target)} submitted${sel}`);
      } else {
        const draft = current.filled
          ? ` · draft ${current.filled}/${current.slots}` + (current.met === true ? ' · EA: requirements met ✔' : current.met === false ? ' · EA: not met' : '')
          : '';
        setContext(current.name, `Squad SBC${draft}`);
      }
      const wait = OC()?.cooldownLeft?.() ?? 0;
      if (wait > 0) { setMain(`Wait ${Math.ceil(wait / 1000)} s`, false); return; }
      if (current.kind === 'points' && current.selectedCount > 0) { setMain('Cards already selected', false); return; }
      setMain(plan ? 'Search again' : current.kind === 'points' ? 'Find cards for this SBC' : 'Find cards for this squad', true);
    }

    // ---- Result area ----
    const result = $('result');
    const clearResult = () => { plan = null; result.textContent = ''; result.dataset.state = 'idle'; };
    const progress = (text) => { $('progress').hidden = !text; $('progressText').textContent = text ?? ''; };

    function showMessage({ tone = 'info', title, lines = [], next, action }, state) {
      clearResult();
      shownFor = current.kind === 'none' ? null : current.name;
      const card = el('div', `card ${tone}`);
      const icon = { ok: '✔ ', bad: '✖ ', warn: '⚠ ', info: '' }[tone] ?? '';
      card.append(el('h3', null, icon + title));
      for (const l of lines) if (l) card.append(el('p', null, l));
      if (next) card.append(el('div', 'next', `Next: ${next}`));
      if (action) {
        const b = el('button', 'secondary', action.label);
        b.addEventListener('click', () => search({ retry: action.retry }));
        card.append(b);
      }
      result.append(card);
      result.dataset.state = state;
    }

    function stat(k, v) { const s = el('div', 'stat'); s.append(el('div', 'k', k), el('div', 'v', v)); return s; }

    function showPlan(p) {
      clearResult();
      plan = p;
      shownFor = p.name;
      const card = el('div', 'card');
      card.append(el('h3', null, p.kind === 'points' ? 'Cards for this batch' : `${p.cards.length} cards for this squad`));
      let unreachable = false;

      if (p.kind === 'points') {
        const x = p.points;
        const meter = el('div', 'meter');
        const done = el('div', 'done'); done.style.width = `${(100 * x.submitted) / x.target}%`;
        const batch = el('div', 'batch'); batch.style.width = `${(100 * Math.min(x.batch, x.remaining)) / x.target}%`;
        meter.append(done, batch);
        const stats = el('div', 'stats');
        stats.append(stat('Target', fmt(x.target)), stat('This batch', `+${fmt(x.batch)}`), stat('Left after', fmt(x.after)));
        card.append(meter, stats);
        unreachable = !x.reachable;
        const v = el('div', `verdict ${x.reachable ? 'ok' : 'bad'}`);
        v.textContent = x.reachable
          ? (x.batches > 1 ? `✔ Your club can finish this: ${x.batches} submissions, ${x.cardsNeeded} cards.` : '✔ This batch finishes it.')
          : `✖ Your club can't finish this yet: ${fmt(x.shortBy)} points short.`;
        card.append(v);
        if (unreachable) {
          card.append(el('p', null, x.squadWouldHelp
            ? 'Allowing active-squad cards would make it possible.'
            : 'Submitted cards only count if you reach the target before it expires. Consider waiting for more cards.'));
        }
        if (p.action) {
          const b = el('button', 'secondary', p.action.label);
          b.addEventListener('click', () => search({ retry: p.action.retry }));
          card.append(b);
        }
      } else {
        const x = p.squad;
        const stats = el('div', 'stats');
        stats.append(stat('Rating', x.rating), stat('Chemistry', x.chemistry ?? '–'), stat('Requirements', `${x.met}/${x.total}`));
        card.append(stats);
        for (const c of x.check) card.append(el('p', null, `⚠ Check yourself: ${c}`));
      }

      card.append(el('div', 'listhead', `${p.cards.length} cards · value ${fmt(p.value)} coins · untick any you want to keep`));
      const list = el('div', 'list');
      list.id = 'previewList';
      for (const c of p.cards) {
        const row = el('label', 'row');
        const box = el('input'); box.type = 'checkbox'; box.checked = true; box.dataset.id = c.id;
        box.addEventListener('change', () => { row.classList.toggle('off', !box.checked); syncPlanButtons(); });
        // Two lines: the name, then what matters for this SBC (points or position), the tags and the value.
        const text = el('span');
        const meta = el('span', 'm');
        if (p.kind === 'points') meta.append(el('b', null, `+${fmt(c.score)} pts`));
        else if (c.pos) meta.append(el('span', null, c.pos));
        for (const t of c.tags) meta.append(el('span', `tag ${t.split(' ')[0]}`, t));
        meta.append(el('span', null, `${fmt(c.value)} coins`));
        text.append(el('div', 'n', c.name), meta);
        row.append(box, el('span', 'r', c.rating), text);
        row.title = `${c.name}: ${c.tags.join(', ')}, worth about ${fmt(c.value)} coins`;
        list.append(row);
      }
      card.append(list);
      const n = (k, word) => `${k} ${word}${k === 1 ? '' : 's'}`;
      const names = p.leftOut.draftNames ?? [];
      const where = names.length === 1 ? `your "${names[0]}" draft` : `${names.length || 'other'} other SBC drafts`;
      const left = [p.leftOut.squad && `${n(p.leftOut.squad, 'active-squad card')}`, p.leftOut.drafts && `${n(p.leftOut.drafts, 'card')} in ${where}`].filter(Boolean);
      if (left.length) {
        const note = el('div', 'note', `Kept out: ${left.join(' · ')}`);
        if (p.leftOut.drafts) note.title = 'Cards in other SBC drafts stay out for a week, or until you press Re-read.';
        card.append(note);
      }

      const keep = el('label', 'opts');
      const keepBox = el('input'); keepBox.type = 'checkbox'; keepBox.id = 'rememberKeep';
      keep.append(keepBox, document.createTextNode(' Always keep the cards I untick'));
      keep.hidden = true;
      const swap = el('button', 'secondary', 'Swap out unticked cards'); swap.id = 'resolvePlan'; swap.hidden = true;
      swap.addEventListener('click', () => {
        const off = untickedNow();
        if (keepBox.checked) H()?.protectCards?.(plan.cards.filter((c) => off.includes(String(c.id))));
        excluded = [...new Set([...excluded, ...off])];
        showSettings();
        search({ keepExclusions: true });
      });
      const apply = el('button', `primary${unreachable ? ' warn' : ''}`,
        p.kind === 'points' ? (unreachable ? 'Select anyway' : 'Select in Work Area') : 'Place in squad');
      apply.id = 'applyPlan';
      apply.style.marginTop = '8px';
      apply.addEventListener('click', () => place());
      const cancel = el('button', 'link', 'Cancel'); cancel.id = 'cancelPlan'; cancel.style.marginTop = '8px';
      cancel.addEventListener('click', () => { clearResult(); excluded = []; oneOff = {}; showMessage({ tone: 'info', title: 'Cancelled', lines: ['Nothing was placed.'] }, 'notice'); });
      card.append(keep, apply, swap, cancel);
      result.append(card);
      result.dataset.state = 'plan';
      syncPlanButtons();
    }
    const untickedNow = () => [...result.querySelectorAll('#previewList input:not(:checked)')].map((b) => b.dataset.id);
    function syncPlanButtons() {
      const off = untickedNow().length;
      const swap = root.getElementById('resolvePlan');
      if (!swap) return;
      swap.hidden = off === 0;
      swap.textContent = `Swap out ${off} unticked card${off === 1 ? '' : 's'}`;
      root.getElementById('rememberKeep').parentElement.hidden = off === 0;
      root.getElementById('applyPlan').disabled = off > 0 || busy;
    }

    // ---- Actions ----
    async function run(fn) {
      if (busy) return;
      busy = true;
      setMain('Working…', false);
      root.querySelectorAll('#result button').forEach((b) => { b.disabled = true; });
      try {
        await fn((t) => progress(t));
      } catch (e) {
        showMessage({ tone: e.tone ?? 'bad', title: e.title ?? 'Stopped', lines: e.title ? e.lines : [e.message], action: e.action }, 'notice');
      } finally {
        busy = false;
        progress(null);
        root.querySelectorAll('#result button').forEach((b) => { b.disabled = false; });
        syncPlanButtons();
        tick();
      }
    }

    function search({ retry, keepExclusions } = {}) {
      if (!keepExclusions) excluded = [];
      oneOff = retry ?? (keepExclusions ? oneOff : {});
      return run(async (set) => {
        if (!OC()) throw new Error('Some extension scripts did not load. Reload the Web App.');
        clearResult();
        set('Finding cards…');
        const p = await OC().plan(options(), set);
        if (!cfg().preview) { plan = p; await place(true); return; }
        showPlan(p);
      });
    }

    function place(inline = false) {
      const go = async (set) => {
        if (!plan) return;
        // Never place cards found for one SBC into another.
        const now = readScreen();
        if (now.kind === 'none' || now.name !== plan.name) {
          clearResult();
          throw H().notice('The open SBC changed', { lines: ['Nothing was placed. Press Find cards again.'], tone: 'info' });
        }
        const p = plan;
        set(p.kind === 'points' ? 'Selecting cards…' : 'Placing cards…');
        const out = await p.apply(set);
        excluded = []; oneOff = {};
        showMessage(out, 'outcome');
      };
      return inline ? go((t) => progress(t)) : run(go);
    }

    $('find').addEventListener('click', () => search());
    $('refreshClub').addEventListener('click', () => run(async (set) => {
      clearResult();
      const out = await OC().refreshClub(set);
      showMessage(out, 'outcome');
    }));

    // ---- Troubleshooting tools ----
    const exportStatus = $('exportStatus');
    $('export').addEventListener('click', async () => {
      if (busy) return;
      const h = H();
      if (!h?.webAppReady()) { exportStatus.textContent = 'Log in and wait for the Web App to finish loading, then try again.'; return; }
      busy = true; $('export').disabled = true;
      try {
        const set = (t) => { exportStatus.textContent = t; };
        const clubItems = await h.readClubPlayers(set);
        await h.pause();
        set('Reading SBC storage…');
        const storage = await h.readStorage().catch((e) => ({ items: [], note: e.message }));
        const data = h.buildExport(clubItems, storage.items, storage.note ? [storage.note] : []);
        h.download(data);
        set(`Saved ${data.meta.clubCards} club + ${data.meta.storageCards} storage cards.`);
      } catch (e) {
        exportStatus.textContent = `Stopped: ${e.message}`;
      } finally {
        busy = false; $('export').disabled = false;
      }
    });

    $('readSbc').addEventListener('click', async () => {
      const readStatus = $('readStatus');
      try {
        const reader = window.__futAssistantSbc;
        if (!reader) throw new Error('SBC reader script did not load.');
        const data = reader.readOpenSbc();
        const text = JSON.stringify(data);
        try { await navigator.clipboard.writeText(text); } catch { window.prompt('Copy these SBC requirements:', text); }
        const n = data.sbc.requirements.filter((r) => r.kind !== 'unsupported').length;
        const warn = [data.unsupported && `${data.unsupported} not understood`, data.uncertain && `${data.uncertain} to double-check`]
          .filter(Boolean).join(', ');
        readStatus.textContent = `Copied ${n} requirement(s) for "${data.sbc.name}"${warn ? ` (${warn})` : ''}. Paste it in FUT Assistant.`;
      } catch (e) {
        readStatus.textContent = `Stopped: ${e.message}`;
      }
    });

    $('prefill').addEventListener('click', async () => {
      if (busy) return;
      const prefillStatus = $('prefillStatus');
      const pf = window.__futAssistantPrefill;
      if (!pf) { prefillStatus.textContent = 'Pre-fill script did not load.'; return; }
      if (!H()?.webAppReady()) { prefillStatus.textContent = 'Log in and wait for the Web App to finish loading.'; return; }
      busy = true; $('prefill').disabled = true;
      try {
        prefillStatus.textContent = await pf.run($('code').value, (t) => { prefillStatus.textContent = t; });
      } catch (e) {
        prefillStatus.textContent = `Stopped: ${e.message}`;
      } finally {
        busy = false; $('prefill').disabled = false;
      }
    });

    showSettings();
    document.body.appendChild(host);
    if (cfg().collapsed) setCollapsed(true);
    tick();
    setInterval(tick, POLL_MS);
  }

  window.__futAssistantPanel = { mount };
  if (document.body) mount();
  else window.addEventListener('DOMContentLoaded', mount);
})();
