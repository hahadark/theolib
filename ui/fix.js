/* fix.js — 주석 글 AI 보정 창.
   주석 패널의 [보정] 단추로 연다. 처음에는 지금 보는 주석의 지금 장이 골라져 있고, 주석(여러 개)·범위(장·절)·풀이를 바꿔 고를 수 있다.
   보정본은 받은 자료를 고치지 않고 따로 보관되므로 언제든 원문으로 되돌릴 수 있다.
   적용된 보정본은 서재에 올라가 다른 사용자와 함께 쓰고, 다른 사용자가 올린 보정본도 받아 합친다(서재가 풀이마다 하나를 정해 준다).
   숫자가 달라졌거나 많이 바뀐 풀이는 바로 적용하지 않고, 원문과 견주어 본 뒤 적용한다.
   바깥에 내놓는 것은 window.NoteFix = { open, compare } 뿐이다. app.js 의 state·bookName·esc·ic·invalidateCache 를 쓴다. */
(function () {
  'use strict';

  const KEY = 'theolib.fix.ai';
  // 보정에 쓰는 모델(엔진 id → [모델, 표시 이름]). 맨 앞이 그 엔진의 기본.
  const MODELS = {
    // 견본 시험(2026-11-24)에서 규칙을 지키고 쓸 만했던 것만 둔다. '@' 뒤는 추론 강도(클로드는 비워 두면 기본 생각 모드).
    codex: [['gpt-6-sol@low', 'GPT-6 Sol'], ['gpt-6-astra@low', 'GPT-6 Astra']],
    claude: [['sonnet@', 'Sonnet (꼼꼼하지만 느림)']],
    deepseek: [['deepseek-flash', 'Flash (줄바꿈만, 가장 빠름)']],
  };
  // 기본으로 고르는 차례(쓸 수 있는 것 가운데 앞선 것)와 추천 표시를 다는 모델.
  const PREFER = ['codex', 'claude', 'deepseek'];
  const RECOMMEND = 'codex|gpt-6-sol@low';
  // 1초에 처리하는 글자 수(견본 시험에서 잰 값, 예상 시간 안내용).
  const SPEED = { codex: 420, claude: 80, deepseek: 1100 };
  const FLAG = { num: '숫자가 달라짐', big: '많이 바뀜', script: '원어 글자가 새로 들어감', md: '기호가 들어감', part: '일부는 원문 그대로' };
  const STATE = { on: '보정됨', ok: '보정됨', pending: '확인 필요', review: '확인 필요', same: '고칠 곳 없음', fail: '원문 유지', stale: '원문이 바뀜', off: '꺼 둠' };
  // 목록에 적는 상태 말: 서재에서 받은 것, 내가 올린 것, 서재가 받지 않은 것을 가른다.
  function stateLabel(t) {
    const st = t.fix || '';
    if (st === 'on' && t.origin === 'server') return '서재 보정본';
    if (st === 'on' && t.up === 1) return '보정됨 · 서재에 올림';
    if (st === 'on' && t.up === 2) return '보정됨 · 이 PC만';
    return STATE[st] || '';
  }

  const $ = (s, r) => (r || document).querySelector(s);
  const tauri = () => window.__TAURI__;
  const call = (cmd, args) => tauri().core.invoke(cmd, args);
  const num = (n) => Number(n || 0).toLocaleString();

  const S = { el: null, panel: null, sel: new Set(), seriesList: [], bk: 0, lo: 0, hi: 0, list: [], picked: new Set(), engines: [], running: false, done: 0, total: 0, drag: null, anchor: null, summary: null, unlisten: [], esc: null };

  // 풀이를 가리키는 열쇠: 주석 id + 차례(여러 주석을 한 목록에 담으므로 차례만으로는 겹친다).
  const keyOf = (series, seq) => series + '|' + seq;
  const rowOf = (k) => S.el && [...S.el.querySelectorAll('.fx-row')].find((r) => r.dataset.k === k);
  const nameOf = (id) => (S.seriesList.find((s) => s.id === id) || {}).name || id;

  // ---- 범위 표기(주석 패널과 같은 규칙)
  function range(t) {
    const sk = t.start_key, ek = t.end_key;
    const c1 = Math.floor(sk / 1000), v1 = sk % 1000, c2 = Math.floor(ek / 1000), v2 = ek % 1000;
    if (!c1 && !c2 && !v1 && !v2) return '개관';
    if (sk === ek) return v1 ? `${c1}:${v1}` : `${c1}장`;
    if (!v1 && v2 === 999) return `${c1}장 전체`;
    const head = v1 ? `${c1}:${v1}` : `${c1}장`;
    if (c1 !== c2) return `${head}-${v2 ? `${c2}:${v2}` : `${c2}장`}`;
    return `${head}-${v2 === 999 ? '끝' : v2}`;
  }

  function saved() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function flagsText(f) {
    return String(f || '').split(',').filter(Boolean).map((x) => FLAG[x] || x).join(' · ');
  }

  // ---- 창
  function close() {
    if (!S.el) return;
    S.unlisten.forEach((u) => { try { u(); } catch (e) { /* 이미 풀림 */ } });
    S.unlisten = [];
    document.removeEventListener('keydown', S.esc);
    document.removeEventListener('mouseup', endDrag);
    S.el.remove();
    S.el = null;
  }

  function shell(title, sub, wide) {
    close();
    const el = document.createElement('div');
    el.className = 'dialog-backdrop fx-backdrop';
    el.innerHTML = `<div class="dialog fx-dlg${wide ? ' fx-wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">`
      + `<div class="dialog-head"><b>${esc(title)}</b><span class="muted fx-sub">${esc(sub || '')}</span><span class="spacer"></span><button class="btn btn-quiet fx-x" title="닫기">${ic('x', 16)}</button></div>`
      + '<div class="dialog-body fx-body"></div><div class="dialog-actions fx-actions"></div></div>';
    document.body.appendChild(el);
    S.el = el;
    $('.fx-x', el).onclick = close;
    el.addEventListener('mousedown', (ev) => { if (ev.target === el && !S.running) close(); });
    S.esc = (ev) => { if (ev.key === 'Escape' && !S.running) close(); };
    document.addEventListener('keydown', S.esc);
    document.addEventListener('mouseup', endDrag);
    return el;
  }

  // 주석 패널을 다시 그린다(보정본이 켜지거나 꺼졌을 때).
  function refreshPanels() {
    invalidateCache();
    for (const p of Layout.panels()) if (p.kind === 'comm') { p._commQk = null; renderComm(p); }
  }

  // ---- 목록 화면
  async function open(panel, o) {
    Object.assign(S, { panel, sel: new Set(o.sel && o.sel.length ? o.sel : [o.series]), seriesList: o.seriesList || [], bk: o.bk, list: [], picked: new Set(), summary: null, anchor: null, running: false, done: 0, total: 0, drag: null, touched: false });
    const el = shell('주석 글 AI 보정', '', false);
    const b = state.books.find((x) => x.n === o.bk) || { ch: 1 };
    const chOpts = (sel) => Array.from({ length: b.ch }, (_, i) => `<option value="${i + 1}"${i + 1 === sel ? ' selected' : ''}>${i + 1}장</option>`).join('');
    const chips = S.seriesList.map((s) => `<button type="button" class="chip fx-chip${S.sel.has(s.id) ? ' on' : ''}" data-s="${esc(s.id)}" aria-pressed="${S.sel.has(s.id)}">${esc(s.name)}</button>`).join('');
    $('.fx-body', el).innerHTML = '<p class="fx-lead">줄바꿈과 문단, 띄어쓰기, 분명한 글자 오류만 바로잡습니다. 원문은 그대로 보관되어 언제든 되돌릴 수 있고, 적용된 보정본은 서재에 올라가 다른 사용자와 함께 씁니다.</p>'
      + '<div class="fx-range">'
      + `<div class="fx-f"><span>주석</span><span class="fx-chips" title="여러 개를 함께 고를 수 있습니다">${chips}</span></div>`
      + `<label class="fx-f"><span>범위</span><span class="fx-span"><b>${esc(bookName(o.bk))}</b>`
      + `<select class="fx-c1">${chOpts(o.ch)}</select><input class="fx-v1" type="number" min="1" max="200" placeholder="처음" title="시작 절(비우면 장의 처음)"><span class="muted">절부터</span>`
      + `<select class="fx-c2">${chOpts(o.ch)}</select><input class="fx-v2" type="number" min="1" max="200" placeholder="끝" title="끝 절(비우면 장의 끝)"><span class="muted">절까지</span></span></label>`
      + '</div>'
      + '<div class="fx-listhead"><label class="fx-all"><input type="checkbox" class="fx-allbox"> 모두</label><span class="fx-count muted"></span><span class="spacer"></span><span class="muted fx-hint">끌거나 Shift+클릭으로 여러 개</span></div>'
      + '<div class="fx-list" tabindex="0"><p class="muted">불러오는 중…</p></div>'
      + '<div class="fx-ai"><label class="fx-f"><span>AI</span><select class="fx-engine"></select></label><span class="fx-est muted"></span></div>'
      + '<div class="fx-prog" hidden><div class="fx-bar"><i></i></div><span class="fx-progtext muted"></span></div>'
      + '<p class="fx-msg" role="status"></p>';
    $('.fx-actions', el).innerHTML = '<span class="muted fx-note">숫자가 달라졌거나 많이 바뀐 풀이는 확인 뒤에 적용합니다.</span><span class="spacer"></span>'
      + `<button class="btn fx-stop" hidden>${ic('stop', 14)}멈춤</button><button class="btn btn-primary fx-go">${ic('sparkles', 14)}보정 시작</button>`;

    const reload = () => { S.anchor = null; loadList(true); };
    // 주석은 여러 개를 함께 고를 수 있다. 새로 켠 주석은 그 주석의 기본 선택만 더하고, 다른 주석에서 고른 것은 그대로 둔다.
    $('.fx-chips', el).onclick = (ev) => {
      const b = ev.target.closest('.fx-chip');
      if (!b || S.running) return;
      const id = b.dataset.s, on = !S.sel.has(id);
      if (!on && S.sel.size === 1) { say('주석을 하나는 골라야 합니다.'); return; }
      if (on) S.sel.add(id); else S.sel.delete(id);
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
      S.anchor = null; say('');
      loadList(on ? new Set([id]) : false);
    };
    for (const c of ['.fx-c1', '.fx-c2', '.fx-v1', '.fx-v2']) $(c, el).onchange = () => {
      if (+$('.fx-c2', el).value < +$('.fx-c1', el).value) $(c === '.fx-c1' ? '.fx-c2' : '.fx-c1', el).value = $(c, el).value;
      reload();
    };
    $('.fx-allbox', el).onchange = (ev) => { S.picked = new Set(ev.target.checked ? S.list.filter((t) => t.chars > 0).map((t) => t.k) : []); S.touched = true; paintList(); };
    $('.fx-engine', el).onchange = (ev) => { const [engine, model] = ev.target.value.split('|'); try { localStorage.setItem(KEY, JSON.stringify({ engine, model })); } catch (e) { /* 저장 못 해도 계속 */ } paintCount(); };
    $('.fx-go', el).onclick = start;
    $('.fx-stop', el).onclick = () => { call('fix_stop'); say('멈추는 중입니다. 보내 둔 요청이 끝나면 멈춥니다.'); };
    bindList($('.fx-list', el));

    S.unlisten.push(await tauri().event.listen('fix-progress', (ev) => onProgress(ev.payload)));
    S.unlisten.push(await tauri().event.listen('fix-done', (ev) => onDone(ev.payload)));
    loadEngines();
    await loadList(true);
    // 서재와 맞춘다(남은 것 올리기 + 이 책에서 다른 사용자가 올린 것 받기). 바뀐 것이 있으면 목록과 주석 창을 다시 그린다.
    call('fix_sync', { bk: S.bk }).then((r) => {
      if (S.el !== el || !r || S.running) return;
      if (r.pulled) refreshPanels();
      if (r.pulled || r.sent || r.rejected || r.removed) loadList(!S.touched);
    }).catch(() => {});
    // 창을 닫았다 다시 열었을 때 돌고 있던 작업을 이어서 보여 준다.
    const st = await call('fix_state').catch(() => null);
    if (st && st.running && st.bk === S.bk) {
      S.running = true; S.done = st.done; S.total = st.total;
      for (const n of st.notes || []) mark(n);
      paintList(); paintRun();
    }
  }

  function say(msg, err) {
    const m = S.el && $('.fx-msg', S.el);
    if (m) { m.textContent = msg || ''; m.className = 'fx-msg' + (err ? ' err' : ''); }
  }

  async function loadEngines() {
    // 이 PC에 깔려 있는 구독 명령줄 도구와 저장된 API 키(계정 등급과 상관없이 회원도 쓴다).
    S.engines = await call('fix_engines').catch(() => []);
    const sel = S.el && $('.fx-engine', S.el);
    if (!sel) return;
    if (!S.engines.length) {
      sel.innerHTML = '<option value="">쓸 수 있는 AI가 없습니다</option>';
      sel.disabled = true; $('.fx-go', S.el).disabled = true;
      say('이 PC에 보정에 쓸 AI가 없습니다. 챗GPT(Codex)나 클로드 Code 명령줄 도구를 설치해 로그인하거나, 설정의 AI 갈래에서 API 키를 넣어 주세요. 다른 사용자가 올린 보정본은 그대로 받아 봅니다.', true);
      return;
    }
    const sorted = [...S.engines].sort((a, b) => ((PREFER.indexOf(a.id) + 99) % 99) - ((PREFER.indexOf(b.id) + 99) % 99));
    const opts = [];
    for (const e of sorted) for (const [m, label] of (MODELS[e.id] || (e.models || []).map((x) => [x, x]))) opts.push({ v: `${e.id}|${m}`, t: `${e.name} · ${label}` });
    const sv = saved();
    const want = `${sv.engine}|${sv.model}`;
    sel.innerHTML = opts.map((o) => `<option value="${esc(o.v)}"${o.v === want ? ' selected' : ''}>${esc(o.t)}${o.v === RECOMMEND ? ' (추천)' : ''}</option>`).join('');
    paintCount();
  }

  async function loadList(repick) {
    const el = S.el;
    if (!el) return;
    const c1 = +$('.fx-c1', el).value, c2 = +$('.fx-c2', el).value;
    S.lo = c1 * 1000 + (+$('.fx-v1', el).value || 0);
    S.hi = c2 * 1000 + (+$('.fx-v2', el).value || 999);
    const ids = S.seriesList.filter((s) => S.sel.has(s.id)).map((s) => s.id);
    const name = ids.length > 2 ? `${nameOf(ids[0])} 외 ${ids.length - 1}개` : ids.map(nameOf).join(' · ');
    $('.fx-sub', el).textContent = `${name} · ${bookName(S.bk)} ${c1 === c2 ? c1 + '장' : c1 + '–' + c2 + '장'}`;
    const want = [ids.join(','), S.lo, S.hi].join('|');
    S.want = want;
    const parts = await Promise.all(ids.map((id) => call('fix_targets', { series: id, bk: S.bk, lo: S.lo, hi: S.hi }).catch((x) => { say(String(x), true); return []; })));
    if (S.el !== el || S.want !== want) return;
    const list = parts.flat();
    for (const t of list) t.k = keyOf(t.series, t.seq);
    // 방금 돌린 결과 가운데 저장되지 않는 것(고칠 곳 없음·원문 유지)은 목록을 다시 받아도 그대로 보여 준다.
    for (const t of list) { const k = S.kept && S.kept.get(t.k); if (k && !t.fix) Object.assign(t, k); }
    S.list = list;
    // 처음에는 이 범위에서 시작하는 풀이 가운데 아직 보정하지 않은 것을 고른다(앞 장부터 이어지는 큰 단락·서론은 빼 둔다).
    // repick: true 면 모두 다시 고르고, 주석 id 묶음이면 그 주석만 기본 선택을 더한다. 목록에서 빠진 것은 선택에서도 뺀다.
    const base = list.filter((t) => t.chars > 0 && t.start_key >= S.lo && t.start_key <= S.hi && !t.fix && (repick === true || (repick && repick.has(t.series)))).map((t) => t.k);
    if (repick === true) S.picked = new Set(base); else for (const k of base) S.picked.add(k);
    const have = new Set(list.map((t) => t.k));
    S.picked = new Set([...S.picked].filter((k) => have.has(k)));
    paintList();
  }

  function rowHtml(t) {
    const st = t.fix || '';
    const cls = st === 'on' || st === 'ok' ? 'ok' : st === 'pending' || st === 'review' ? 'warn' : st === 'fail' ? 'err' : '';
    const tip = [t.origin === 'server' && t.who ? `올린 이: ${t.who}` : '', flagsText(t.flags), t.error, t.up === 2 ? `서재가 받지 않음: ${t.msg || ''}` : ''].filter(Boolean).join(' · ');
    const canCmp = st === 'on' || st === 'ok' || st === 'pending' || st === 'review' || st === 'off';
    return `<div class="fx-row${S.picked.has(t.k) ? ' on' : ''}${t.chars ? '' : ' empty'}" data-k="${esc(t.k)}">`
      + `<input type="checkbox" tabindex="-1"${S.picked.has(t.k) ? ' checked' : ''}${t.chars ? '' : ' disabled'}>`
      + `<span class="cr">${esc(range(t))}</span><span class="fx-title">${esc(t.title || t.ref || '')}</span>`
      + `<span class="fx-len">${num(t.chars)}자</span>`
      + `<span class="fx-st ${cls}"${tip ? ` title="${esc(tip)}"` : ''}>${t.busy ? '보정 중…' : esc(stateLabel(t))}${st && t.change ? ` <i>${(t.change * 100).toFixed(1)}%</i>` : ''}</span>`
      + `<button class="btn btn-quiet fx-cmp"${canCmp ? '' : ' disabled'} title="원문과 견주어 보기">비교</button></div>`;
  }

  function paintList() {
    const box = S.el && $('.fx-list', S.el);
    if (!box) return;
    const top = box.scrollTop;
    // 주석을 여러 개 골랐으면 주석마다 머리줄을 둔다(누르면 그 주석의 풀이를 모두 고르거나 푼다).
    const many = S.sel.size > 1;
    let html = '', last = null;
    for (const t of S.list) {
      if (many && t.series !== last) {
        const n = S.list.filter((x) => x.series === t.series).length;
        html += `<div class="fx-group" data-s="${esc(t.series)}" title="누르면 이 주석의 풀이를 모두 고르거나 풉니다"><b>${esc(nameOf(t.series))}</b><span class="muted">${n}개</span><span class="spacer"></span><span class="fx-gpick muted"></span></div>`;
        last = t.series;
      }
      html += rowHtml(t);
    }
    box.innerHTML = S.list.length ? html : '<p class="muted">이 범위에 보정할 풀이가 없습니다.</p>';
    box.scrollTop = top;
    paintCount();
  }

  function paintCount() {
    const el = S.el;
    if (!el) return;
    const rows = S.list.filter((t) => S.picked.has(t.k));
    const chars = rows.reduce((a, t) => a + t.chars, 0);
    for (const g of el.querySelectorAll('.fx-group')) {
      const mine = rows.filter((t) => t.series === g.dataset.s);
      $('.fx-gpick', g).textContent = mine.length ? `${mine.length}개 고름 · ${num(mine.reduce((a, t) => a + t.chars, 0))}자` : '고른 것 없음';
    }
    const pend = S.list.filter((t) => t.fix === 'pending' || t.fix === 'review').length;
    $('.fx-count', el).innerHTML = `${S.list.length}개 가운데 <b>${rows.length}개</b> 고름 · ${num(chars)}자${pend ? ` · <span class="fx-pend">확인 필요 ${pend}개</span>` : ''}`;
    const all = S.list.filter((t) => t.chars > 0);
    const box = $('.fx-allbox', el);
    box.checked = all.length > 0 && rows.length === all.length;
    box.indeterminate = rows.length > 0 && rows.length < all.length;
    const eng = ($('.fx-engine', el).value || '').split('|')[0];
    const secs = chars / (SPEED[eng] || 200);
    $('.fx-est', el).textContent = chars ? `예상 시간 약 ${secs < 90 ? Math.max(10, Math.round(secs / 10) * 10) + '초' : Math.round(secs / 60) + '분'}` : '';
    if (!S.running) $('.fx-go', el).disabled = !rows.length || !S.engines.length;
  }

  // ---- 고르기: 클릭, Shift+클릭 범위, 끌어서 여러 개
  function setPick(k, on) {
    const t = S.list.find((x) => x.k === k);
    if (!t || !t.chars) return;
    if (on) S.picked.add(k); else S.picked.delete(k);
    const row = rowOf(k);
    if (row) { row.classList.toggle('on', on); $('input', row).checked = on; }
  }
  function endDrag() { S.drag = null; }
  function bindList(box) {
    box.addEventListener('mousedown', (ev) => {
      const grp = ev.target.closest('.fx-group');
      if (grp && !S.running && ev.button === 0) {
        // 주석 머리줄: 하나라도 안 골랐으면 그 주석의 풀이를 모두 고르고, 다 골랐으면 모두 푼다.
        ev.preventDefault();
        const mine = S.list.filter((t) => t.series === grp.dataset.s && t.chars > 0);
        const on = mine.some((t) => !S.picked.has(t.k));
        for (const t of mine) setPick(t.k, on);
        S.touched = true; S.anchor = null;
        paintCount();
        return;
      }
      const row = ev.target.closest('.fx-row');
      if (!row || ev.target.closest('.fx-cmp') || S.running || ev.button !== 0) return;
      ev.preventDefault();
      const seq = row.dataset.k;
      if (ev.shiftKey && S.anchor != null) {
        const ids = S.list.map((t) => t.k), a = ids.indexOf(S.anchor), b = ids.indexOf(seq);
        if (a < 0 || b < 0) return;
        const on = S.picked.has(S.anchor);
        for (let i = Math.min(a, b); i <= Math.max(a, b); i++) setPick(ids[i], on);
      } else {
        const on = !S.picked.has(seq);
        setPick(seq, on);
        S.anchor = seq;
        S.drag = { on };
      }
      S.touched = true;
      paintCount();
    });
    box.addEventListener('mouseover', (ev) => {
      if (!S.drag) return;
      const row = ev.target.closest('.fx-row');
      if (row) { setPick(row.dataset.k, S.drag.on); paintCount(); }
    });
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('.fx-cmp');
      const t = b && S.list.find((x) => x.k === b.closest('.fx-row').dataset.k);
      if (t && !b.disabled) compare(S.panel, { series: t.series, bk: S.bk, seq: t.seq, back: backArgs() });
    });
  }
  function backArgs() {
    const el = S.el;
    return { sel: [...S.sel], seriesList: S.seriesList, bk: S.bk, ch: +$('.fx-c1', el).value, c2: +$('.fx-c2', el).value, v1: $('.fx-v1', el).value, v2: $('.fx-v2', el).value, picked: [...S.picked] };
  }

  // ---- 실행
  function mark(n) {
    const t = S.list.find((x) => x.k === keyOf(n.series, n.seq));
    if (!t) return;
    Object.assign(t, { fix: n.state, change: n.change, flags: n.flags, error: n.error, busy: false, origin: 'me', up: 0, who: '', msg: '' });
    S.picked.delete(t.k);
  }

  function paintRun() {
    const el = S.el;
    if (!el) return;
    $('.fx-prog', el).hidden = !S.running && !S.summary;
    $('.fx-stop', el).hidden = !S.running;
    $('.fx-go', el).disabled = S.running;
    for (const c of ['.fx-c1', '.fx-c2', '.fx-v1', '.fx-v2', '.fx-engine', '.fx-allbox']) $(c, el).disabled = S.running;
    for (const c of el.querySelectorAll('.fx-chip')) c.disabled = S.running;
    $('.fx-bar i', el).style.width = (S.total ? Math.round((S.done / S.total) * 100) : 0) + '%';
    if (S.running) $('.fx-progtext', el).textContent = `${S.done} / ${S.total}개 끝남`;
  }

  async function start() {
    const el = S.el;
    const [engine, model] = ($('.fx-engine', el).value || '').split('|');
    const rows = S.list.filter((t) => S.picked.has(t.k));
    if (!engine || !rows.length) return;
    // 주석마다 고른 차례를 묶어 한 번에 맡긴다(여러 주석이 한 작업으로 함께 돈다).
    const by = new Map();
    for (const t of rows) { if (!by.has(t.series)) by.set(t.series, []); by.get(t.series).push(t.seq); }
    const picks = [...by].map(([series, seqs]) => ({ series, seqs }));
    say('');
    S.summary = null;
    try {
      S.total = await call('fix_start', { bk: S.bk, picks, engine, model });
    } catch (x) { say(String(x), true); return; }
    S.running = true; S.done = 0;
    for (const t of rows) t.busy = true;
    paintList(); paintRun();
  }

  function onProgress(p) {
    if (!S.el || !p || !p.note) return;
    S.done = p.done; S.total = p.total;
    mark(p.note);
    const k = keyOf(p.note.series, p.note.seq);
    const row = rowOf(k);
    const t = S.list.find((x) => x.k === k);
    if (row && t) row.outerHTML = rowHtml(t);
    paintCount(); paintRun();
  }

  function onDone(sum) {
    if (!S.el) return;
    S.running = false; S.summary = sum;
    for (const t of S.list) t.busy = false;
    S.kept = S.kept || new Map();
    for (const t of S.list) if (t.fix === 'same' || t.fix === 'fail') S.kept.set(t.k, { fix: t.fix, error: t.error || '' });
    const why = [...new Set(S.list.filter((t) => t.fix === 'fail' && t.error).map((t) => t.error))].slice(0, 2).join(', ');
    paintList(); paintRun();
    const parts = [`보정 ${sum.ok}개`, sum.review ? `확인 필요 ${sum.review}개` : '', sum.same ? `고칠 곳 없음 ${sum.same}개` : '', sum.fail ? `원문 유지 ${sum.fail}개` : ''].filter(Boolean).join(' · ');
    $('.fx-progtext', S.el).textContent = `${sum.stopped ? '멈춤' : '끝'} · ${parts} · ${Math.round(sum.secs)}초`;
    const sh = sum.share || {};
    const shared = sh.sent ? ` ${sh.sent}개를 서재에 올려 다른 사용자와 나눕니다.` : '';
    const notShared = sh.error ? ` 서재에는 아직 올리지 못했습니다(${sh.error}). 다음에 다시 올립니다.` : sh.rejected ? ` 서재가 받지 않은 것이 ${sh.rejected}개 있습니다(목록에 마우스를 올리면 까닭이 보입니다).` : '';
    const failed = sum.fail ? ` 원문을 그대로 둔 ${sum.fail}개는 AI가 준 글을 받아들일 수 없었습니다${why ? '(' + why + ')' : ''}. 다시 골라 한 번 더 돌려 볼 수 있습니다.` : '';
    if (sum.error) say(sum.error, true);
    else if (sum.review) say('확인 필요로 남은 풀이는 [비교]로 원문과 견주어 본 뒤 적용해 주세요.' + shared + notShared + failed);
    else say((sum.ok ? '보정본을 주석 창에 반영했습니다.' : '') + shared + notShared + failed);
    refreshPanels();
    loadList(false);
  }

  // ---- 견주어 보기(원문 | 보정본)
  // 낱말 단위로 달라진 곳을 찾는다. 너무 길면(표가 커지면) 강조 없이 보여 준다.
  function wordDiff(a, b) {
    const A = a.split(/\s+/).filter(Boolean), B = b.split(/\s+/).filter(Boolean);
    const n = A.length, m = B.length;
    if (n * m > 3e7) return null;
    const W = m + 1, t = new Uint16Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * W + j] = A[i] === B[j] ? t[(i + 1) * W + j + 1] + 1 : Math.max(t[(i + 1) * W + j], t[i * W + j + 1]);
    const del = new Set(), ins = new Set();
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { i++; j++; } else if (t[(i + 1) * W + j] >= t[i * W + j + 1]) del.add(i++); else ins.add(j++);
    }
    while (i < n) del.add(i++);
    while (j < m) ins.add(j++);
    return { del, ins };
  }
  function paintText(text, marks, cls) {
    let k = 0;
    return text.split(/(\s+)/).map((tok) => {
      if (!tok) return '';
      if (/^\s+$/.test(tok)) return esc(tok);
      const hit = marks && marks.has(k);
      k++;
      return hit ? `<mark class="${cls}">${esc(tok)}</mark>` : esc(tok);
    }).join('');
  }

  async function compare(panel, o) {
    S.panel = panel || S.panel;
    const el = shell('원문과 보정본', '', true);
    $('.fx-body', el).innerHTML = '<p class="muted">불러오는 중…</p>';
    const p = await call('fix_pair', { series: o.series, bk: o.bk, seq: o.seq }).catch((x) => { $('.fx-body', el).innerHTML = `<p class="err">${esc(String(x))}</p>`; return null; });
    if (!p || S.el !== el) return;
    const f = p.fix;
    $('.fx-sub', el).textContent = [bookName(o.bk), p.ref, p.title].filter(Boolean).join(' · ');
    const back = () => { if (o.back) reopen(o.back); else close(); };
    if (!f) {
      $('.fx-body', el).innerHTML = '<p class="muted">이 풀이에는 보정본이 없습니다.</p>';
      $('.fx-actions', el).innerHTML = '<span class="spacer"></span><button class="btn fx-back">닫기</button>';
      $('.fx-back', el).onclick = back;
      return;
    }
    const d = wordDiff(p.orig, f.text);
    const brk = (t) => (t.match(/\n/g) || []).length;
    const server = f.origin === 'server';
    const share = server ? `서재에서 받은 보정본${f.who ? '(올린 이: ' + f.who + ')' : ''}` : f.up === 1 ? '서재에 올림' : f.up === 2 ? `서재가 받지 않음(${f.msg || '까닭 없음'}), 이 PC에서만 보임` : f.state === 'on' ? '서재에 올릴 차례를 기다림' : '적용하면 서재에도 올림';
    const info = [f.state === 'on' ? '주석 창에 보여 주는 중' : f.state === 'off' ? '이 PC에서 꺼 둠' : '확인 기다리는 중', share, `바뀐 글자 ${(f.change * 100).toFixed(1)}%`, `줄바꿈 ${brk(p.orig)}곳 → ${brk(f.text)}곳`, flagsText(f.flags), f.model ? `${f.model}` : '', f.created || ''].filter(Boolean);
    $('.fx-body', el).innerHTML = `<p class="fx-info${f.flags ? ' warn' : ''}">${info.map(esc).join(' · ')}</p>`
      + (p.stale ? '<p class="fx-info warn">받은 자료의 원문이 바뀌어 이 보정본은 쓰이지 않습니다. 버리고 다시 보정해 주세요.</p>' : '')
      + `<div class="fx-cols"><div><h5>원문</h5><div class="fx-text">${paintText(p.orig, d && d.del, 'fx-del')}</div></div>`
      + `<div><h5>보정본</h5><div class="fx-text">${paintText(f.text, d && d.ins, 'fx-ins')}</div></div></div>`;
    // 내 보정본은 되돌리면 지워지고(서재에서도 내린다), 서재에서 받은 것은 이 PC에서만 끈다.
    const dropLabel = server ? '이 PC에서 끄기(원문 보기)' : f.state === 'on' ? '원문으로 되돌리기' : '보정본 버리기';
    $('.fx-actions', el).innerHTML = (server && f.state === 'off' ? '' : `<button class="btn btn-danger fx-drop">${ic('trash', 14)}${dropLabel}</button>`) + '<span class="spacer"></span>'
      + (f.state !== 'on' && !p.stale ? `<button class="btn btn-primary fx-ok">${ic('check', 14)}${f.state === 'off' ? '다시 켜기' : '이 보정본 적용'}</button>` : '')
      + `<button class="btn fx-back">${o.back ? '목록으로' : '닫기'}</button>`;
    $('.fx-back', el).onclick = back;
    const drop = $('.fx-drop', el);
    if (drop) drop.onclick = async () => { await call('fix_discard', { series: o.series, bk: o.bk, seqs: [o.seq] }).catch(() => 0); refreshPanels(); back(); };
    const ok = $('.fx-ok', el);
    if (ok) ok.onclick = async () => { await call('fix_approve', { series: o.series, bk: o.bk, seqs: [o.seq] }).catch(() => 0); refreshPanels(); back(); };
  }

  // 견주어 보기에서 목록으로 돌아갈 때: 범위와 고른 것을 그대로 되살린다.
  async function reopen(b) {
    await open(S.panel, { series: b.sel[0], sel: b.sel, seriesList: b.seriesList, bk: b.bk, ch: b.ch });
    const el = S.el;
    if (!el) return;
    $('.fx-c2', el).value = b.c2; $('.fx-v1', el).value = b.v1; $('.fx-v2', el).value = b.v2;
    await loadList(false);
    S.picked = new Set(b.picked.filter((q) => S.list.some((t) => t.k === q && t.chars > 0)));
    paintList();
  }

  // 다른 사용자가 올린 보정본을 뒤에서 받아 왔으면, 그 책을 보고 있는 주석 창을 다시 그린다.
  tauri().event.listen('fix-synced', (ev) => {
    const bk = ev && ev.payload && ev.payload.bk;
    if (Layout.panels().some((p) => p.kind === 'comm' && panelRef(p).bk === bk)) refreshPanels();
    if (S.el && S.bk === bk && !S.running && $('.fx-list', S.el)) loadList(false);
  });

  window.NoteFix = { open, compare };
})();
