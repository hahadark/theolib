/* plan-host.js — 설교 설계도(plan.js)를 신학 서재 앱에 잇는다.
   - 저장: 회원으로 로그인했으면 웹 서재 계정에(웹 신학서재와 같은 설계도·자료함), 아니면 이 PC에.
   - 바깥 화면과 잇기: 출처 열기(절·책 쪽·연구), AI 본문연구로 보내기, 내 설교 자료실에 넣기, 파일 저장.
   - 어디서나 담기: 고른 글 곁의 단추(plan-clip.js)와 위 도구줄의 [담기](고른 절).
   app.js 의 state·bookName·fillChap·openChapter·showView·VNAME·cached·loadRows 를 쓴다. 바깥에 내놓는 것은 window.PlanHost 뿐이다. */
(function () {
  'use strict';

  const LS_PLANS = 'theolib.plan.plans';
  const LS_CLIPS = 'theolib.plan.clips';
  const invoke = (c, a) => window.__TAURI__.core.invoke(c, a);
  const $ = (s, r) => (r || document).querySelector(s);

  // ---- 작은 알림(3초). welcome.css 의 .toast 모양을 쓴다.
  let toastEl = null, toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3000);
  }

  // ---- 어디에 저장하나: 회원·특별 계정으로 로그인했을 때만 계정에 둔다(게스트·로그인 안 함은 이 PC).
  let who = { at: 0, remote: false };
  async function remote() {
    if (Date.now() - who.at < 30000) return who.remote;
    let st = null;
    try { st = await invoke('web_status'); } catch (e) { st = null; }
    who = { at: Date.now(), remote: !!(st && st.logged_in && (st.role === 'special' || st.role === 'member')) };
    return who.remote;
  }
  window.addEventListener('theolib:account', () => { who.at = 0; });

  async function api(method, path, body) {
    const r = await invoke('web_api', { method, path, body: body || null });
    if (r.status === 401) { who = { at: Date.now(), remote: false }; throw new Error('로그인이 필요합니다'); }
    if (r.status >= 400) throw new Error((r.body && r.body.error) || `서재 응답 ${r.status}`);
    return r.body || {};
  }

  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]') || []; } catch (e) { return []; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } };

  // 로그인하기 전에 이 PC에 만들어 둔 설계도·자료가 있으면 계정으로 한 번 옮긴다.
  let moved = false;
  async function moveLocal() {
    if (moved) return;
    moved = true;
    const plans = lsGet(LS_PLANS), clips = lsGet(LS_CLIPS);
    if (!plans.length && !clips.length) return;
    try {
      for (const p of plans) await api('POST', '/api/me/plans', { action: 'save', plan: p });
      if (clips.length) {
        const cur = (await api('GET', '/api/me/clips')).items || [];
        const have = new Set(cur.map((c) => c.text + '\n' + c.src));
        await api('POST', '/api/me/clips', { items: cur.concat(clips.filter((c) => !have.has(c.text + '\n' + c.src))) });
      }
      localStorage.removeItem(LS_PLANS);
      localStorage.removeItem(LS_CLIPS);
    } catch (e) { moved = false; }
  }

  // 웹의 '자료 바구니'에 담아 둔 것도 자료함에 함께 보인다(id 가 bk: 로 시작). 원래 칸은 여기 들고 있다가 지우기·메모를 되돌려 쓴다.
  let basket = [];
  const basketId = (x) => `bk:${x.book}:${x.page}:${x.at}`;

  const host = {
    kind: 'app',
    defaults: { preacher: '', service: '' },
    toast,
    confirm: (msg) => Promise.resolve(window.confirm(msg)),
    copy: (text) => navigator.clipboard.writeText(text),
    async download(name, text) {
      const p = await invoke('save_text', { name, text });
      return !!p;
    },

    async listPlans() {
      if (await remote()) { await moveLocal(); return (await api('GET', '/api/me/plans')).items || []; }
      return lsGet(LS_PLANS).map((p) => ({ id: p.id, title: p.title, ref: p.ref, updated: p.updated })).sort((a, b) => (b.updated || 0) - (a.updated || 0));
    },
    async getPlan(id) {
      if (await remote()) return (await api('GET', '/api/me/plans/' + encodeURIComponent(id))).plan || null;
      return lsGet(LS_PLANS).find((p) => p.id === id) || null;
    },
    async savePlan(plan) {
      if (await remote()) { await api('POST', '/api/me/plans', { action: 'save', plan }); return { ok: true }; }
      const all = lsGet(LS_PLANS).filter((p) => p.id !== plan.id);
      all.push(Object.assign({}, plan, { updated: Date.now() }));
      if (!lsSet(LS_PLANS, all)) throw new Error('이 PC에 저장하지 못했습니다');
      return { ok: true };
    },
    async deletePlan(id) {
      if (await remote()) { await api('POST', '/api/me/plans', { action: 'delete', id }); return { ok: true }; }
      lsSet(LS_PLANS, lsGet(LS_PLANS).filter((p) => p.id !== id));
      return { ok: true };
    },
    async getClips() {
      if (!(await remote())) return lsGet(LS_CLIPS);
      await moveLocal();
      const [c, b] = await Promise.all([api('GET', '/api/me/clips'), api('GET', '/api/me/basket').catch(() => ({ items: [] }))]);
      basket = (b.items || []).filter((x) => x && x.book);
      return (c.items || []).concat(basket.map((x) => Object.assign(window.SermonPlan.basketToClip(x), { id: basketId(x) })));
    },
    async setClips(clips) {
      if (!(await remote())) { if (!lsSet(LS_CLIPS, clips)) throw new Error('이 PC에 저장하지 못했습니다'); return { ok: true }; }
      const mine = clips.filter((c) => !String(c.id).startsWith('bk:'));
      await api('POST', '/api/me/clips', { items: mine });
      // 바구니에서 온 칸: 자료함에서 지웠거나 메모를 고쳤으면 바구니에도 그대로 적는다.
      const keep = new Map(clips.filter((c) => String(c.id).startsWith('bk:')).map((c) => [c.id, c]));
      const next = basket.filter((x) => keep.has(basketId(x))).map((x) => Object.assign({}, x, { note: keep.get(basketId(x)).note || '' }));
      if (next.length !== basket.length || next.some((x, i) => x.note !== (basket[i] && basket[i].note))) {
        await api('POST', '/api/me/basket', { items: next });
        basket = next;
      }
      return { ok: true };
    },

    openLink(link) {
      if (!link) return;
      if (link.t === 'ref' && link.bk) {
        state.bk = link.bk; state.ch = link.ch || 1;
        fillChap();
        showView('bible');
        openChapter(link.v || null);
      } else if (link.t === 'page' && link.book) {
        showView('study');
        if (window.Study) window.Study.openRead(link.book, link.page || 1);
      } else if (link.t === 'study' && link.id) {
        if (window.Study && window.Study.open) window.Study.open(link.id).then(() => showView('study'));
      } else if (link.t === 'url' && link.url) {
        navigator.clipboard.writeText(link.url).then(() => toast('주소를 복사했습니다. 브라우저에 붙여 넣어 여세요.'));
      }
    },
    async sendToStudy(o) {
      if (!window.Study || !window.Study.prefill) { toast('AI 본문연구 화면을 열지 못했습니다'); return; }
      await window.Study.prefill(o);
      showView('study');
      toast('본문과 요청을 채워 두었습니다. AI를 고르고 시작해 주세요.');
    },
    async saveSermon(s) {
      if (!(await remote())) return { ok: false, error: '내 설교 자료실은 회원으로 로그인한 뒤에 쓸 수 있습니다' };
      try {
        // 같은 날짜·같은 예배의 설교가 있으면 덮어쓰게 되므로 먼저 묻는다.
        const list = (await api('GET', '/api/me/sermons')).items || [];
        const same = list.find((x) => x.date === s.date && x.service === s.service);
        if (same && !window.confirm(`${s.date} ${s.service}에 이미 '${same.title || '제목 없음'}' 설교가 있습니다. 이 설계도로 덮어쓸까요?`)) return { ok: false, error: '' };
        const r = await api('POST', '/api/me/sermons', { action: 'save', date: s.date, service: s.service, title: s.title, passage: s.ref, summary: s.summary || '', text: s.text });
        return { ok: !!r.ok, error: r.error || '' };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },
  };

  // ---- 화면
  let view = null;
  function show() {
    const root = $('#plan-root');
    if (!root || !window.SermonPlan) return;
    if (!view) view = window.SermonPlan.mount(root, host);
  }

  // ---- 고른 글이 어떤 자료인지(출처·종류·돌아갈 자리)
  function resolve(node) {
    const note = node.closest('.cnote, .note');
    if (note && note.dataset.cn) {
      const sk = +note.dataset.sk || 0, bk = +note.dataset.bk || state.bk;
      const cr = $('.cr', note);
      return { kind: 'comm', src: `${note.dataset.cn} · ${bookName(bk)} ${cr ? cr.textContent : ''}`.trim(), link: { t: 'ref', bk, ch: Math.floor(sk / 1000) || 1, v: sk % 1000 || 0 } };
    }
    const row = node.closest('.vrow');
    if (row && row.dataset.v) {
      const bk = +row.dataset.bk, ch = +row.dataset.ch, v = +row.dataset.v;
      const line = node.closest('.tline');
      const vn = line && $('.vn', line) ? $('.vn', line).textContent : (VNAME()[state.vers[0]] || state.vers[0] || '');
      return { kind: 'verse', src: `${bookName(bk)} ${ch}:${v}${vn ? ` (${vn})` : ''}`, link: { t: 'ref', bk, ch, v } };
    }
    const lex = node.closest('.lex');
    if (lex) return { kind: 'lex', src: `원어 사전 · ${($('b', lex) || {}).textContent || ''}`.trim() };
    const art = node.closest('.art-body');
    if (art) {
      const t = art.parentElement && $('#article-title', art.parentElement);
      return { kind: 'article', src: `소논문 · ${t ? t.textContent : ''}`.trim() };
    }
    const cur = window.Study && window.Study.current ? window.Study.current() : null;
    if (node.closest('#study-reader') && cur && cur.reading) {
      const r = cur.reading;
      return { kind: 'page', src: `《${r.title || '서재 책'}》 p.${r.page}`, link: { t: 'page', book: r.book, page: r.page } };
    }
    if (node.closest('.sturn') && cur && cur.job) return { kind: 'ai', src: `AI 본문연구 · ${cur.job.ref || ''}`.trim(), link: { t: 'study', id: cur.job.id } };
    return null;
  }

  // ---- 위 도구줄의 [담기]: 고른 절을 출처와 함께 자료함에 담는다(인용 복사와 같은 글).
  async function clipVerses() {
    if (!state.sel.size) { toast('담을 절을 먼저 누르세요. (Shift+누르기로 범위 선택)'); return; }
    const vs = [...state.sel].sort((a, b) => a - b);
    const first = state.vers[0];
    const vname = (state.versions.find((v) => v.id === first) || {}).name || first;
    const rows = await cached(loadRows, state.vers);
    const tmp = document.createElement('div');
    const text = vs.map((v) => {
      const r = rows.find((x) => x.v === v);
      const t = r && (r.texts.find((x) => x.ver === first) || r.texts[0]);
      tmp.innerHTML = t ? t.html : '';
      return (vs.length > 1 ? v + ' ' : '') + tmp.textContent.trim();
    }).join('\n').slice(0, 4000);
    const range = vs.length > 1 ? `${vs[0]}-${vs[vs.length - 1]}` : vs[0];
    await window.SermonPlanClip.clipNow({ kind: 'verse', text, src: `${bookName(state.bk)} ${state.ch}:${range} (${vname})`, link: { t: 'ref', bk: state.bk, ch: state.ch, v: vs[0] } });
  }

  function boot() {
    if (!window.SermonPlan || !window.SermonPlanClip) return;
    window.SermonPlanClip.install({ host, resolve });
    const b = $('#clip');
    if (b) b.onclick = clipVerses;
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  window.PlanHost = { show, host };
})();
