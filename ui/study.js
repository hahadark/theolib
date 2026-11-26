/* study.js — AI 본문연구 화면 (앱판).
   구성·문구는 온라인 신학서재 웹판(static/index.html 의 AI 본문 연구)을 그대로 옮기고,
   서버 호출만 앱 명령(web_api / study_*)으로 바꾼다. 설계: docs/AI_STUDY_DESIGN.md 3·4절.
   바깥에 내놓는 것은 window.Study = { show(), openRead(bookId, page), prefill({ref, notes}) } 뿐이다. */
(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const { listen } = window.__TAURI__.event;

  // ------------------------------------------------------------ 작은 도구
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ico = (n, sz) => (window.Icon ? window.Icon(n, sz || 16) : '');
  function hydrate(root) { if (window.IconHydrate) window.IconHydrate(root); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let toastEl = null;
  let toastTimer = 0;
  function toast(m) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'stoast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = m;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 1800);
  }

  async function copyText(t) {
    const txt = String(t == null ? '' : t);
    try { await navigator.clipboard.writeText(txt); }
    catch (e) {
      const a = document.createElement('textarea');
      a.value = txt;
      document.body.appendChild(a);
      a.select();
      try { document.execCommand('copy'); } catch (_) {}
      a.remove();
    }
    toast('복사했습니다');
    return txt.length;
  }

  async function copyRich(el, plain) {
    const c = el.cloneNode(true);
    c.querySelectorAll('.secp,.no-print,button').forEach((x) => x.remove());
    c.querySelectorAll('a').forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
    const html = '<div style="font-family:\'맑은 고딕\',sans-serif;font-size:11pt;line-height:1.6">' + c.innerHTML + '</div>';
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plain], { type: 'text/plain' }),
      })]);
      toast('서식째 복사했습니다 (한글·워드·노션에 붙여 넣기)');
    } catch (e) { copyText(plain); }
  }

  // 웹판과 같은 상수
  const SPUR = ['금요기도회 설교', '주일 설교', '새벽기도 설교', '수요예배 설교', '성경공부(소그룹)', '강해 연구', '개인 묵상'];
  const SDEP = [['quick', '빠르게', '약 3~6분'], ['normal', '보통', '약 6~12분'], ['deep', '깊게', '약 12~25분']];
  const SSTAT = { queued: ['대기 중', 'queued'], running: ['연구 중', 'running'], done: ['완료', 'done'], error: ['오류', 'error'], stopped: ['멈춤', 'stopped'] };
  const ENGINE_LABEL = { codex: '챗GPT', claude: '클로드', gemini: '제미나이', openai: '챗GPT', anthropic: '클로드', deepseek: '딥시크', server: '서재 서버', custom: '직접 넣기' };
  const SERVER_MODELS = [['sonnet', '클로드 Sonnet (기본)'], ['opus', '클로드 Opus (더 깊게, 사용량 많음)']];
  const LAST_KEY = 'theolib.study.last';

  const sdur = (s) => (s == null ? '' : s < 60 ? s + '초' : Math.floor(s / 60) + '분 ' + (s % 60) + '초');
  const since = (t) => {
    if (!t) return '';
    const d = Math.max(0, Math.round((Date.now() - new Date(String(t).replace(' ', 'T')).getTime()) / 1000));
    return sdur(d);
  };
  const depthLabel = (v) => (SDEP.find((d) => d[0] === v) || [, ''])[1];

  // ------------------------------------------------------------ 상태
  const S = {
    ready: false,
    page: 'home',          // home | view
    id: null,              // 보고 있는 연구 id
    engines: [],
    eng: null,             // 고른 엔진 id
    model: '',             // 고른 모델
    settings: {},
    web: { logged_in: false },  // WebStatus
    scope: null,           // ai_scope (권한 요약)
    keyDraft: {},          // webkey 엔진의 키 칸 초안(메모리에만 둔다)
    mcp: { has: false },
    pcOff: false,
    cats: null,            // SC_LIST (종류 표)
    catsOn: null,          // 고른 종류 (null = 서버 기본)
    catsInfo: null,        // /api/study/sources 응답
    j: null,               // 지금 보고 있는 연구 기록
    turnsKey: '',
    timer: 0,
    lastId: '',
    booted: false,
    scTimer: 0,
    scSeq: 0,
    pref: null,            // 선호 설교자 {saved, names}
    prefDirty: 0,
    prefQuery: '',
    srData: null,
    srInfo: null,
    srSearch: '',
    srDrag: null,
    srAnchor: null,
    srNoClick: 0,
    reading: null,         // 서재 읽기 서랍 상태
    my: { n: 0, total: 0, ok: false },   // 내 설교 자료실: 이 본문(장)을 다룬 내 설교 수, 전체 수, 본문 인식 여부
  };
  const srDefaults = () => ({ preachers: null, church: '', status: 'all', source_type: 'all', match: 'main', max_items: 5, use: ['interpretation', 'outline', 'application'] });

  // ------------------------------------------------------------ 호출
  // path·opts 는 웹판 api() 와 같다. 돌려주는 값도 웹판과 같게(JSON).
  function engObj() { return S.engines.find((e) => e.id === S.eng) || null; }

  function studyName(path) { return path.split('?')[0].replace('/api/study/', ''); }

  function isLocalStudy(path, opts) {
    if (!/^\/api\/study\/(start|ask|stop|delete|get|list)/.test(path)) return false;
    const name = studyName(path);
    const body = (opts && opts.body) || {};
    if (name === 'get') {
      const q = new URLSearchParams((path.split('?')[1] || ''));
      return String(q.get('id') || '').startsWith('app-');
    }
    if (name === 'start') {
      // 이 PC의 AI(api·cli)로 돌릴 때만 앱 명령으로 간다. 서재 서버·서버 키(webkey)는 서버 경로.
      const id = String(body.engine || S.eng || '');
      const e = S.engines.find((x) => x.id === id);
      if (e) return e.kind !== 'server' && e.kind !== 'webkey';
      return id !== 'server' && !/^web-/.test(id);
    }
    return String(body.id || '').startsWith('app-');
  }

  async function localStudy(path, opts) {
    opts = opts || {};
    const name = studyName(path);
    if (name === 'list') return invoke('study_list');
    if (name === 'get') {
      const q = new URLSearchParams((path.split('?')[1] || ''));
      const j = await invoke('study_get', { id: q.get('id') });
      if (!j) throw new Error('없는 연구입니다.');
      return j;
    }
    const cmd = { start: 'study_start', ask: 'study_ask', stop: 'study_stop', delete: 'study_delete' }[name];
    const out = await invoke(cmd, { d: opts.body || {} });
    const body = (out && out.body) || {};
    if (out && out.status === 401) throw new Error(body.error || '로그인이 풀렸습니다. 다시 로그인해 주세요.');
    if (out && out.status >= 500) throw new Error(body.error || '앱에서 연구를 처리하지 못했습니다.');
    return body;
  }

  async function api(path, opts) {
    opts = opts || {};
    if (isLocalStudy(path, opts)) return localStudy(path, opts);
    const method = (opts.method || 'GET').toUpperCase();
    let body = opts.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) {} }
    let out;
    try {
      out = await invoke('web_api', { method, path, body: body === undefined ? null : body });
    } catch (e) {
      throw new Error(typeof e === 'string' ? e : (e && e.message) || '서재 서버에 연결하지 못했습니다.');
    }
    if (!out || typeof out.status !== 'number') return out && out.body;
    const b = (out.body && typeof out.body === 'object') ? out.body : {};
    if (out.status === 401) { S.web.logged_in = false; throw new Error(b.error || '로그인이 풀렸습니다. 다시 로그인해 주세요.'); }
    if (out.status === 503 && b.pc_off) { S.pcOff = true; }
    if (out.status >= 400) {
      if (b.ok === false) return b;          // 웹판처럼 호출한 쪽이 ok·error 를 본다
      throw new Error(b.error || ('서재 오류 ' + out.status));
    }
    return b;
  }
  const post = (p, d) => api(p, { method: 'POST', body: d });

  // ------------------------------------------------------------ 마크다운 (웹판 그대로)
  function mdInline(s) {
    s = esc(s);
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, t, u) => {
      u = u.replace(/&amp;/g, '&');
      if (/^#\/(read|view)\/[\w-]+\/\d+$/.test(u)) return '<a class="cite" href="' + u + '">' + t + '</a>';
      if (/^https?:\/\/[^"<>]+$/.test(u)) return '<a class="ext" href="' + u + '" rel="noopener">' + t + '</a>';
      return t;
    });
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<i>$2</i>');
    return s;
  }

  function mdHtml(md) {
    const L = (md || '').replace(/\r/g, '').split('\n');
    let out = '';
    let i = 0;
    const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
    while (i < L.length) {
      const l = L[i];
      if (!l.trim()) { i++; continue; }
      let m = l.match(/^(#{1,4})\s+(.*)$/);
      if (m) { const n = Math.min(6, m[1].length); out += '<h' + n + '>' + mdInline(m[2]) + '</h' + n + '>'; i++; continue; }
      if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(l)) { out += '<hr>'; i++; continue; }
      if (/^\s*>/.test(l)) {
        const b = [];
        while (i < L.length && /^\s*>/.test(L[i])) { b.push(L[i].replace(/^\s*>\s?/, '')); i++; }
        out += '<blockquote>' + mdHtml(b.join('\n')) + '</blockquote>';
        continue;
      }
      if (/^\s*\|/.test(l)) {
        const rows = [];
        while (i < L.length && /^\s*\|/.test(L[i])) { rows.push(L[i].trim()); i++; }
        const cells = (r) => r.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
        let h = '<div class="tblw"><table>';
        rows.forEach((r, k) => {
          if (/^\|?\s*:?-{2,}/.test(r)) return;
          const tg = k === 0 ? 'th' : 'td';
          h += '<tr>' + cells(r).map((c) => '<' + tg + '>' + mdInline(c) + '</' + tg + '>').join('') + '</tr>';
        });
        out += h + '</table></div>';
        continue;
      }
      if (isList(l)) {
        const st = [];
        let h = '';
        while (i < L.length && (isList(L[i]) || (L[i].trim() && /^\s{2,}/.test(L[i]) && st.length))) {
          const x = L[i];
          if (!isList(x)) { h += '<br>' + mdInline(x.trim()); i++; continue; }
          const ind = x.match(/^\s*/)[0].length;
          const ord = /^\s*\d/.test(x);
          const txt = x.replace(/^\s*([-*+]|\d+[.)])\s+/, '');
          while (st.length && ind < st[st.length - 1].ind) h += '</li></' + st.pop().tag + '>';
          const top = st[st.length - 1];
          if (!top || ind > top.ind) { const tag = ord ? 'ol' : 'ul'; st.push({ ind, tag }); h += '<' + tag + '><li>'; }
          else h += '</li><li>';
          h += mdInline(txt);
          i++;
        }
        while (st.length) h += '</li></' + st.pop().tag + '>';
        out += h;
        continue;
      }
      const p = [];
      while (i < L.length && L[i].trim() && !/^(#{1,4}\s|\s*>|\s*\||\s*(-{3,})\s*$)/.test(L[i]) && !isList(L[i])) { p.push(L[i].trim()); i++; }
      out += '<p>' + p.map(mdInline).join('<br>') + '</p>';
    }
    return out;
  }

  function mdPlain(md) {
    return (md || '').replace(/\r/g, '').split('\n').filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l)).map((l) => {
      l = l.replace(/\[([^\]]+)\]\((#\/[^)]*)\)/g, '$1').replace(/\[([^\]]+)\]\((https?:[^)]*)\)/g, '$1 ($2)');
      l = l.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2').replace(/`([^`]+)`/g, '$1');
      if (/^\s*\|.*\|\s*$/.test(l)) return l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim()).filter(Boolean).join(' / ');
      const h = l.match(/^(#{1,6})\s+(.*)$/);
      if (h) return (h[1].length <= 2 ? '\n' : '') + h[2].trim();
      return l.replace(/^>\s?/, '').replace(/^(\s*)[-*]\s+/, '$1· ');
    }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  function mdSections(md) {
    const out = [];
    let cur = null;
    for (const l of (md || '').replace(/\r/g, '').split('\n')) {
      const h = l.match(/^(#{2,3})\s+(.*)$/);
      if (h) { cur = { lv: h[1].length, title: h[2].replace(/\*\*/g, '').trim(), lines: [l] }; out.push(cur); }
      else if (cur) cur.lines.push(l);
    }
    return out.map((s, i) => {
      if (s.lv === 2) {
        const sub = [];
        for (let k = i + 1; k < out.length && out[k].lv > 2; k++) sub.push(...out[k].lines);
        return { ...s, md: [...s.lines, ...sub].join('\n') };
      }
      return { ...s, md: s.lines.join('\n') };
    });
  }

  function mdSources(md) {
    const seen = new Set();
    const out = [];
    for (const m of (md || '').matchAll(/\[([^\]]*《[^》]+》[^\]]*)\]\(#\/(?:read|view)\/([\w-]+)\/(\d+)\)/g)) {
      const k = m[1].trim();
      if (!seen.has(k)) { seen.add(k); out.push('· ' + k); }
    }
    return out.join('\n');
  }

  function splitChoices(md) {
    const m = (md || '').match(/```choices\s*\n([\s\S]*?)```/);
    if (!m) return [md || '', null];
    let c = null;
    try { c = JSON.parse(m[1]); } catch (e) {}
    return [(md || '').replace(m[0], '').trim(), c];
  }

  function choicesHtml(c) {
    if (!c) return '';
    const qs = (c.questions || []).filter((q) => q && q.q && Array.isArray(q.options) && q.options.length);
    const nx = (c.next || []).filter((x) => typeof x === 'string' && x.trim());
    if (!qs.length && !nx.length) return '';
    let h = '<div class="chs">';
    if (qs.length) {
      h += '<div class="chs-h">설교를 더 맞추기 위한 질문</div>'
        + '<div class="muted">버튼으로 고르고 \'이 답으로 다듬기\'를 누르세요. 맞는 보기가 없으면 직접 쓰셔도 됩니다.</div>'
        + qs.map((q, k) => '<div class="chq" data-multi="' + (q.multi ? 1 : 0) + '" data-q="' + esc(q.q) + '">'
          + '<div class="chqt">' + (k + 1) + '. ' + esc(q.q) + (q.multi ? ' <span class="muted">(여러 개 선택 가능)</span>' : '') + '</div>'
          + '<div class="chos">' + q.options.map((o) => '<button type="button" class="chip" data-v="' + esc(String(o)) + '">' + esc(String(o)) + '</button>').join('')
          + '<input class="chin" placeholder="직접 입력"></div></div>').join('')
        + '<div class="chs-go"><button type="button" class="btn btn-primary" data-chgo>이 답으로 다듬기</button><span class="muted" data-chmsg></span></div>';
    }
    if (nx.length) {
      h += '<div class="chnx"><div class="muted">다음에 할 만한 것 (누르면 바로 요청)</div>'
        + nx.map((x) => '<button type="button" class="btn" data-nx="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>';
    }
    return h + '</div>';
  }

  // ------------------------------------------------------------ 설정 저장
  let setTimer = 0;
  function saveSettings(patch) {
    S.settings = Object.assign({}, S.settings, patch);
    clearTimeout(setTimer);
    setTimer = setTimeout(() => {
      invoke('study_settings_set', { settings: S.settings }).catch(() => {});
    }, 250);
  }
  const srGet = () => Object.assign(srDefaults(), (S.settings.sermon_options && typeof S.settings.sermon_options === 'object') ? S.settings.sermon_options : {});
  function srSet(p) {
    S.settings.sermon_options = Object.assign(srGet(), p);
    saveSettings({ sermon_options: S.settings.sermon_options });
    srPaint(S.srData, S.srInfo);
    refreshCatsDebounced();
  }

  // ------------------------------------------------------------ 참고 자료 종류 칩
  const scGet = () => (Array.isArray(S.catsOn) ? S.catsOn : (Array.isArray(S.settings.cats) ? S.settings.cats : (S.cats || []).filter((c) => c.default).map((c) => c.id)));
  function scSet(a) {
    S.catsOn = a;
    saveSettings({ cats: a });
    scPaint(S.catsInfo && S.catsInfo.bible_book ? S.catsInfo : null);
  }

  function scPaint(info) {
    const box = $('#scats');
    if (!box) return;
    if (!S.cats || !S.cats.length) {
      box.innerHTML = S.web.logged_in
        ? '<div class="muted s-note">참고 자료 종류를 불러오지 못했습니다. 본문을 넣으면 다시 시도합니다.</div>'
        : '<div class="muted s-note">서재에 로그인하면 참고할 자료 종류를 고를 수 있습니다.</div>';
      return;
    }
    const on = new Set(scGet());
    const groups = [...new Set(S.cats.map((c) => c.group))];
    box.innerHTML = groups.map((g) => '<div class="scg"><span class="scgl">' + esc(g) + '</span><div class="scchips">'
      + S.cats.filter((c) => c.group === g).map((c) => '<button type="button" class="chip ' + (on.has(c.id) ? 'on' : '') + (info && !c.n ? ' zero' : '') + '" data-sc="' + esc(c.id) + '" title="' + esc(c.desc || '') + (c.sample && c.sample.length ? '\n예: ' + esc(c.sample.join(' / ')) : '') + '">'
        + esc(c.name) + (info ? ' <span class="n">' + c.n + '</span>' : '') + '</button>').join('') + '</div></div>').join('')
      + '<div class="scb"><button type="button" class="lnk" data-sx="def">기본으로</button> · <button type="button" class="lnk" data-sx="all">모두</button> · <button type="button" class="lnk" data-sx="cm">주석만</button> · <button type="button" class="lnk" data-sx="sm">설교·강해만</button></div>';
    const msg = $('#scmsg');
    if (msg) msg.textContent = info ? info.bible_book + ' 기준, 종류마다 이 본문을 다룬 자료 수 · 버튼에 마우스를 올리면 설명' : '본문을 넣으면 종류마다 몇 개가 있는지 보입니다';
    $$('[data-sc]', box).forEach((b) => (b.onclick = () => {
      const s = new Set(scGet());
      if (s.has(b.dataset.sc)) s.delete(b.dataset.sc); else s.add(b.dataset.sc);
      scSet([...s]);
    }));
    $$('[data-sx]', box).forEach((b) => (b.onclick = () => {
      const k = b.dataset.sx;
      scSet(k === 'def' ? S.cats.filter((c) => c.default).map((c) => c.id)
        : k === 'all' ? S.cats.map((c) => c.id)
          : S.cats.filter((c) => c.group === (k === 'cm' ? '주석' : '설교·강해')).map((c) => c.id));
    }));
    srSync();
  }

  // ------------------------------------------------------------ 내 설교 자료실 (선택 항목)
  // 웹 서재의 '내 설교 자료실'에서 같은 장을 다룬 내 설교를 지시문에 함께 넣는다. 켠 상태는 설정에 저장한다.
  const smyOn = () => S.settings.my_sermons === true;
  async function myFor(ref, full) {
    try {
      const r = await api('/api/me/sermons?ref=' + encodeURIComponent(ref) + (full ? '&full=1' : ''));
      return r && Array.isArray(r.items) ? r : { items: [] };
    } catch (e) { return { items: [] }; }
  }
  async function myPack(ref) {
    return (await myFor(ref, true)).items.map((x) => ({
      date: x.date, service: x.service, title: x.title, passage: x.passage,
      summary: String(x.summary || '').slice(0, 1500), text: String(x.text || '').slice(0, 12000),
    }));
  }
  function smyPaint() {
    const box = $('#smybox');
    if (!box) return;
    const scope = S.scope && S.scope.scope;
    if (!S.web.logged_in || scope === 'guest') { box.innerHTML = ''; return; }
    const m = S.my;
    const note = !m.total ? '웹 서재의 내 설교 자료실에 설교를 넣으면 여기서 고를 수 있습니다.'
      : !smyOn() ? ''
        : !m.ok ? '본문을 넣으면 편수가 보입니다.'
          : m.n ? '이 본문(장)을 다룬 내 설교 ' + m.n + '편을 최근 것부터 함께 읽습니다 (깊이에 따라 2~5편).'
            : '이 본문(장)을 다룬 내 설교가 없습니다.';
    box.innerHTML = '<div class="scg"><span class="scgl">내 자료</span><div class="scchips">'
      + '<button type="button" class="chip ' + (smyOn() ? 'on' : '') + (m.ok && !m.n ? ' zero' : '') + '" id="smy" title="내 설교 자료실에서 같은 장을 다룬 내 설교를 함께 읽고, 이어 갈 점과 이미 쓴 내용을 정리해 줍니다">내 설교 자료실'
      + (m.ok ? ' <span class="n">' + m.n + '</span>' : '') + '</button>'
      + '<button type="button" class="lnk" id="smyopen" title="웹 서재의 내 설교 자료실을 브라우저로 엽니다(설교 넣기·찾기·AI 지침)">자료실 열기</button>'
      + '</div></div>' + (note ? '<div class="muted s-note smy-note">' + esc(note) + '</div>' : '');
    $('#smy').onclick = () => { saveSettings({ my_sermons: !smyOn() }); smyPaint(); };
    $('#smyopen').onclick = async () => {
      try { await invoke('web_open', { path: '/#/me/sermons' }); } catch (e) { toast(typeof e === 'string' ? e : '브라우저를 열지 못했습니다'); }
    };
  }

  function srSync() {
    const el = $('#srpanel');
    if (el) el.hidden = !scGet().includes('ref_sermons');
  }

  let scTimer = 0;
  function refreshCatsDebounced() {
    clearTimeout(scTimer);
    scTimer = setTimeout(scLoad, 250);
  }

  async function scLoad() {
    if (!S.web.logged_in) return;
    const seq = ++S.scSeq;
    const v = ($('#sref') && $('#sref').value.trim()) || '';
    myFor(v).then((m) => {
      if (seq !== S.scSeq) return;
      S.my = { n: m.match || 0, total: m.total || 0, ok: !!m.ref_ok };
      smyPaint();
    });
    let r;
    try {
      r = await api('/api/study/sources?ref=' + encodeURIComponent(v) + '&sermon_options=' + encodeURIComponent(JSON.stringify(srGet())));
    } catch (e) { return; }
    if (seq !== S.scSeq || !$('#scats')) return;
    if (r && Array.isArray(r.cats)) {
      S.cats = r.cats;
      if (!Array.isArray(S.catsOn) && !Array.isArray(S.settings.cats)) S.catsOn = r.cats.filter((c) => c.default).map((c) => c.id);
    }
    S.catsInfo = r;
    scPaint(v && r.bible_book ? r : null);
    srPaint(r && r.sermons, r);
    if (S.pref && S.pref.saved) maybeApplyPref();
  }

  // ------------------------------------------------------------ 참고 설교 세부 설정
  // 끌어서 여러 명 고르기: 손을 떼면 그때 저장하고, 뒤따르는 click 은 삼킨다.
  document.addEventListener('mouseup', () => {
    const d = S.srDrag;
    S.srDrag = null;
    if (!d || !d.moved) return;
    S.srNoClick = Date.now();
    S.srAnchor = { name: d.endName, on: d.on };
    S.prefDirty++;
    srSet({ preachers: [...d.set] });
  });

  function srPaint(data, info) {
    if (data) S.srData = data;
    if (info) S.srInfo = info;
    const box = $('#sermon-options');
    if (!box) return;
    if (!S.srData) { box.innerHTML = ''; return; }
    const scroller = $('#sbody');
    const keepY = scroller ? scroller.scrollTop : 0;
    const o = srGet();
    const R = S.srData.preachers || [];
    const selected = o.preachers === null ? R.map((x) => x.preacher) : o.preachers;
    const matching = (S.srInfo && S.srInfo.cats ? S.srInfo.cats.find((x) => x.id === 'ref_sermons') : null);
    const nMatch = matching ? matching.n : 0;
    const opts = (a, val) => a.map(([v, t]) => '<option value="' + v + '" ' + (String(v) === String(val) ? 'selected' : '') + '>' + t + '</option>').join('');
    box.innerHTML = '<details class="srpanel" id="srpanel" open>'
      + '<summary><b>참고 설교 세부 설정</b> <span class="muted">설교자 ' + selected.length + '명 · 최대 ' + o.max_items + '편</span></summary>'
      + '<p class="muted s-note">선택한 설교자의 자료만 보조 자료로 사용합니다. 이름 옆 숫자는 주 본문이 일치하는 설교 / 전체 연결 편수입니다. 마우스로 끌거나 Shift를 누르고 클릭하면 여러 명을 한 번에 선택·해제합니다.</p>'
      + '<div class="field-row"><label class="field sr-f"><span>교회</span><select id="srchurch"><option value="">전체 교회</option>'
      + (S.srData.churches || []).map((c) => '<option ' + (o.church === c ? 'selected' : '') + '>' + esc(c) + '</option>').join('') + '</select></label>'
      + '<label class="field sr-f"><span>설교자 찾기</span><input id="srsearch" placeholder="이름 또는 교회 이름" value="' + esc(S.srSearch) + '"></label></div>'
      + '<div class="sr-tools"><button type="button" class="btn btn-quiet" id="srall">전체 선택</button><button type="button" class="btn btn-quiet" id="srnone">선택 해제</button><span class="muted" id="srselected">' + selected.length + '명 선택</span></div>'
      + '<div id="srpeople" class="sr-people">' + R.map((x) => '<label class="srp" data-sr-person="' + esc(x.preacher + ' ' + x.church) + '">'
        + '<input type="checkbox" data-srp="' + esc(x.preacher) + '" ' + (selected.includes(x.preacher) ? 'checked' : '') + '>'
        + '<span><b>' + esc(x.preacher) + '</b> <small class="muted">' + (S.srData.has_ref ? x.matching + ' / ' : '') + x.n + '편</small><br><small class="muted">' + esc(x.church || '교회 미확인') + '</small></span></label>').join('') + '</div>'
      + '<div class="field-row"><label class="field sr-f"><span>자료 상태</span><select id="srstatus">' + opts([['all', '전체 · 상태 표시'], ['summary', '검증된 요약이 있는 자료만'], ['source', '원문만 있는 자료']], o.status) + '</select></label>'
      + '<label class="field sr-f"><span>원문 종류</span><select id="srtype">' + opts([['all', '전체'], ['official', '공식 설교 원고'], ['transcript', '자막 자료']], o.source_type) + '</select></label></div>'
      + '<div class="field-row"><label class="field sr-f"><span>본문 일치 범위</span><select id="srmatch">' + opts([['main', '이 본문을 주 본문으로 다룬 설교'], ['any', '본문을 언급한 설교도 포함']], o.match) + '</select></label>'
      + '<label class="field sr-f"><span>참고할 최대 편수</span><select id="srmax">' + opts([[3, '3편'], [5, '5편'], [8, '8편'], [12, '12편'], [20, '20편']], o.max_items) + '</select></label></div>'
      + '<div class="sr-uses"><span class="s-lbl">활용 방식</span> <span class="muted">여러 개 선택 가능</span>'
      + '<div class="sr-use-row">' + Object.entries(S.srData.uses || {}).map(([v, t]) => '<label class="ck"><input type="checkbox" data-sru="' + v + '" ' + (o.use.includes(v) ? 'checked' : '') + '>' + esc(t) + '</label>').join('') + '</div></div>'
      + '<div class="muted sr-preview" id="srpreview">' + (!S.srData.has_ref ? '본문을 입력하면 조건에 맞는 편수가 표시됩니다.'
        : (S.srInfo && nMatch === 0
          ? (o.match === 'main'
            ? '<b class="err">선택한 설교자 중 이 본문을 주 본문으로 다룬 설교가 없습니다.</b> 이대로 연구하면 참고 설교 없이 진행됩니다. <button type="button" class="btn" id="sralt">본문을 언급한 설교도 포함하기</button>'
            : '<b class="err">선택한 설교자·조건에 맞는 설교가 없습니다.</b> 설교자나 교회, 자료 상태 조건을 바꿔 보세요.')
          : '현재 조건에 맞는 설교 ' + nMatch + '편 · 최대 ' + o.max_items + '편을 설교자별로 골고루 참고합니다.')) + '</div>'
      + srPrefHtml()
      + '<p class="muted s-note">선택한 자료가 없으면 다른 설교자로 대체하지 않습니다. 문장·말투를 모방하지 않고 성경 본문과 주석의 해석을 우선합니다.</p>'
      + '</details>';

    const filter = () => {
      const text = S.srSearch.toLowerCase();
      $$('[data-sr-person]', box).forEach((el) => {
        const person = el.dataset.srPerson;
        el.style.display = (person.toLowerCase().includes(text) && (!o.church || person.endsWith(' ' + o.church))) ? '' : 'none';
      });
    };
    $('#srsearch').oninput = (e) => { S.srSearch = e.target.value; filter(); };
    filter();
    $('#srall').onclick = () => srSet({ preachers: null });
    $('#srnone').onclick = () => srSet({ preachers: [] });

    const ppl = $('#srpeople');
    const vis = () => $$('[data-sr-person]', ppl).filter((l) => l.style.display !== 'none');
    const nm = (l) => $('[data-srp]', l).dataset.srp;
    const spanSel = (a, b, onFlag) => {
      const v = vis();
      const i = v.indexOf(a);
      const jj = v.indexOf(b);
      if (i < 0 || jj < 0) return null;
      const s = new Set(selected);
      v.slice(Math.min(i, jj), Math.max(i, jj) + 1).forEach((l) => (onFlag ? s.add(nm(l)) : s.delete(nm(l))));
      return s;
    };
    ppl.addEventListener('click', (e) => {
      if (Date.now() - S.srNoClick < 400) { e.preventDefault(); e.stopPropagation(); return; }
      const l = e.target.closest('[data-sr-person]');
      if (!l || !e.shiftKey || !S.srAnchor) return;
      const a = vis().find((x) => nm(x) === S.srAnchor.name);
      if (!a) return;
      e.preventDefault(); e.stopPropagation();
      const s = spanSel(a, l, S.srAnchor.on);
      if (s) srSet({ preachers: [...s] });
    }, true);
    ppl.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.shiftKey) return;
      const l = e.target.closest('[data-sr-person]');
      if (!l) return;
      S.srDrag = { start: l, on: !$('input', l).checked, moved: false, set: null, endName: nm(l) };
    });
    ppl.addEventListener('mouseover', (e) => {
      const d = S.srDrag;
      if (!d) return;
      const l = e.target.closest('[data-sr-person]');
      if (!l || (l === d.start && !d.moved)) return;
      const s = spanSel(d.start, l, d.on);
      if (!s) return;
      d.moved = true; d.set = s; d.endName = nm(l);
      vis().forEach((x) => ($('input', x).checked = s.has(nm(x))));
    });
    $$('[data-srp]', box).forEach((el) => (el.onchange = () => {
      const s = new Set(selected);
      if (el.checked) s.add(el.dataset.srp); else s.delete(el.dataset.srp);
      S.srAnchor = { name: el.dataset.srp, on: el.checked };
      S.prefDirty++;
      srSet({ preachers: [...s] });
    }));
    [['srchurch', 'church'], ['srstatus', 'status'], ['srtype', 'source_type'], ['srmatch', 'match'], ['srmax', 'max_items']]
      .forEach(([id, key]) => { $('#' + id).onchange = (e) => srSet({ [key]: key === 'max_items' ? +e.target.value : e.target.value }); });
    $$('[data-sru]', box).forEach((el) => (el.onchange = () => srSet({ use: $$('[data-sru]:checked', box).map((x) => x.dataset.sru) })));
    const alt = $('#sralt');
    if (alt) alt.onclick = () => srSet({ match: 'any' });
    srSync();
    paintPref();
    if (scroller && scroller.scrollTop !== keepY) scroller.scrollTop = keepY;
  }

  // ------------------------------------------------------------ 선호 설교자 (서버 저장)
  function srPrefHtml() {
    const pf = S.pref;
    const names = pf && pf.saved ? pf.names : null;
    const status = !pf ? '선호를 불러오는 중…' : !pf.saved ? '저장된 선호 없음'
      : names === null ? '저장된 선호: 모든 설교자'
        : names.length === 0 ? '저장된 선호: 선택 없음' : '저장된 선호 ' + names.length + '명';
    const list = (names || []).filter((n) => !S.prefQuery || n.toLowerCase().includes(S.prefQuery.toLowerCase()));
    const avail = {};
    ((S.srData && S.srData.preachers) || []).forEach((x) => (avail[x.preacher] = 1));
    return '<div class="sr-pref" id="spref">'
      + '<div><b>선호 설교자</b> <span class="muted">' + esc(status) + (S.web.logged_in ? '' : ' (로그인하면 서버에 저장)') + '</span></div>'
      + '<label class="field sr-f"><span>선호 이름 검색</span><input id="sp-q" placeholder="저장된 선호 이름 검색" value="' + esc(S.prefQuery) + '"></label>'
      + '<div class="sp-chips">' + list.map((n) => {
        const ok = avail[n];
        return '<button type="button" class="chip" data-spn="' + esc(n) + '" title="' + (ok ? '현재 선택에 추가/제거' : '현재 조건에 자료 없음') + '"' + (ok ? '' : ' style="opacity:.55"') + '>' + esc(n) + (ok ? '' : ' (자료 없음)') + '</button>';
      }).join('') + '</div>'
      + '<div class="row"><button type="button" class="btn btn-quiet" id="sp-save">현재 선택을 선호로 저장</button>'
      + '<button type="button" class="btn btn-quiet" id="sp-load"' + (pf && pf.saved ? '' : ' disabled') + '>선호 불러오기</button>'
      + '<button type="button" class="btn btn-quiet" id="sp-clear"' + (pf && pf.saved ? '' : ' disabled') + '>저장 초기화</button></div>'
      + '<div class="muted" id="sp-msg"></div>'
      + '<div class="muted s-note">저장 버튼을 누를 때만 선호가 바뀝니다. 선호 설교자의 자료가 없으면 다른 설교자로 대체하지 않습니다.</div>'
      + '</div>';
  }

  function paintPref() {
    const box = $('#spref');
    if (!box) return;
    const msg = box.querySelector('#sp-msg');
    const keep = msg ? msg.textContent : '';
    const html = srPrefHtml();
    box.outerHTML = html;
    const b2 = $('#spref');
    if (!b2) return;
    if (keep) { const m = b2.querySelector('#sp-msg'); if (m) m.textContent = keep; }
    const q = b2.querySelector('#sp-q');
    if (q) q.oninput = (e) => {
      S.prefQuery = e.target.value;
      const v = S.prefQuery;
      paintPref();
      const q2 = $('#sp-q');
      if (q2) { q2.focus(); q2.setSelectionRange(v.length, v.length); }
    };
    const say = (t) => { const m = b2.querySelector('#sp-msg'); if (m) m.textContent = t; };
    b2.querySelectorAll('[data-spn]').forEach((b) => (b.onclick = () => {
      const n = b.dataset.spn;
      let cur = srGet().preachers;
      if (cur === null) cur = ((S.srData && S.srData.preachers) || []).map((x) => x.preacher);
      S.prefDirty++;
      srSet({ preachers: cur.includes(n) ? cur.filter((x) => x !== n) : cur.concat([n]) });
    }));
    b2.querySelector('#sp-save').onclick = async () => {
      if (!S.web.logged_in) { say('서재에 로그인하면 선호 설교자를 서버에 저장합니다.'); return; }
      try {
        const r = await post('/api/me/sermon-preferences', { action: 'save', names: prefNames() });
        S.pref = prefNorm(r); S.prefDirty++;
        toast('선호 설교자를 저장했습니다');
        paintPref();
      } catch (e) { say('저장하지 못했습니다'); }
    };
    b2.querySelector('#sp-load').onclick = () => {
      if (!S.pref || !S.pref.saved) return;
      S.prefDirty++;
      srSet({ preachers: S.pref.names === null ? null : S.pref.names.slice() });
      toast('선호를 적용했습니다');
    };
    b2.querySelector('#sp-clear').onclick = async () => {
      if (!S.web.logged_in) { say('서재에 로그인하면 서버의 선호를 지울 수 있습니다.'); return; }
      try {
        const r = await post('/api/me/sermon-preferences', { action: 'clear' });
        S.pref = prefNorm(r); S.prefDirty++;
        toast('저장된 선호를 지웠습니다. 현재 선택은 그대로입니다');
        paintPref();
      } catch (e) { say('초기화하지 못했습니다'); }
    };
  }

  function cleanNames(names) {
    if (!Array.isArray(names)) return null;
    const out = [];
    const seen = Object.create(null);
    names.forEach((x) => {
      if (typeof x !== 'string') return;
      x = x.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (x && !seen[x] && out.length < 64) { seen[x] = 1; out.push(x); }
    });
    return out;
  }
  function prefNorm(r) { return r && r.saved ? { saved: true, names: cleanNames(r.names) } : { saved: false, names: null }; }
  function prefNames() {
    const cur = srGet().preachers;
    if (cur !== null) return cur;
    return ((S.srData && S.srData.preachers) || []).map((x) => x.preacher);
  }
  async function loadPref() {
    if (!S.web.logged_in) { S.pref = prefNorm(null); return; }
    const epoch = S.prefDirty;
    try {
      const r = await api('/api/me/sermon-preferences');
      S.pref = prefNorm(r);
    } catch (e) { S.pref = prefNorm(null); }
    if (S.pref.saved) {
      if (epoch !== S.prefDirty) return;      // 사용자가 먼저 손댔으면 적용하지 않는다
      maybeApplyPref();
    }
    paintPref();
  }
  function maybeApplyPref() {
    if (!S.pref || !S.pref.saved) return;
    if (!S.srData) return;
    const cur = S.settings.sermon_options;
    if (cur && 'preachers' in cur && Array.isArray(cur.preachers)) return;   // 이미 고른 적이 있으면 그대로
    if (cur && cur.preachers === null) return;
    S.settings.sermon_options = Object.assign(srGet(), { preachers: S.pref.names === null ? null : S.pref.names.slice() });
    saveSettings({ sermon_options: S.settings.sermon_options });
    srPaint(S.srData, S.srInfo);
  }

  // ------------------------------------------------------------ 서재 연결 상태 띠 · AI 고르기
  // 로그인 상자·AI 설정 대화 상자 대신 한 줄 상태 띠를 두고, 모든 설정은 설정 화면에서 한다.
  function openSettings(tab) {
    if (window.Settings) window.Settings.open(tab || 'ai');
    else if (window.AppShowView) window.AppShowView('settings', tab || 'ai');
  }

  function scopeLabel() {
    const sc = S.scope || {};
    if (sc.label) return sc.label;
    return { owner: '관리자', special: '특별 계정', member: '회원', guest: '게스트', localmcp: '이 PC 연결', none: '로그인 안 함' }[sc.scope] || '';
  }

  function connHtml() {
    const logged = !!(S.web && S.web.logged_in);
    if (!logged) {
      // 로그인은 환영 창에서, 가입은 웹 서재에서 한다.
      return '<div class="s-status"><span class="s-status-t">회원 로그인이 필요합니다</span>'
        + '<span class="spacer"></span>'
        + '<button type="button" class="btn btn-quiet" id="sset">' + ico('log-in', 16) + '로그인</button>'
        + '<button type="button" class="btn btn-quiet" id="sjoin">' + ico('external', 16) + '가입하기</button></div>';
    }
    const e = engObj();
    const engTxt = e ? (e.name + (e.ready ? ' 준비됨' : ' (설정 필요)')) : '쓸 수 있는 AI 없음';
    return '<div class="s-status">'
      + '<b class="s-status-u">' + esc(S.web.user || '서재') + '</b>'
      + '<span class="s-dot" aria-hidden="true">·</span><span class="s-status-r">' + esc(scopeLabel()) + '</span>'
      + '<span class="s-dot" aria-hidden="true">·</span><span class="muted s-status-e">' + esc(engTxt) + '</span>'
      + (S.pcOff ? '<span class="badge warn">집 PC 꺼짐</span>' : '')
      + '<span class="spacer"></span>'
      + '<button type="button" class="btn btn-quiet" id="sset">' + ico('settings', 16) + '설정</button></div>';
  }

  // 지금 권한에서 쓸 수 있는 AI 만 고른다.
  function allowedEngines() { return S.engines.filter((e) => e.allowed !== false); }

  // 특별 계정은 서재 구독 AI 의 기본 모델(클로드 Sonnet)만 쓴다(오퍼스는 관리자만).
  function serverModels() {
    const owner = (S.scope && S.scope.scope === 'owner') || (S.web && S.web.owner);
    return SERVER_MODELS.filter(([v]) => owner || v === 'sonnet');
  }

  function engineOptions() {
    const list = allowedEngines();
    if (!list.length) return '<option value="">쓸 수 있는 AI가 없습니다</option>';
    return list.map((e) => '<option value="' + esc(e.id) + '"' + (e.id === S.eng ? ' selected' : '') + '>' + esc(e.name) + (e.ready ? '' : ' (설정 필요)') + '</option>').join('');
  }

  function modelOptions() {
    const e = engObj();
    if (!e) return '';
    if (e.id === 'server') return serverModels().map(([v, t]) => '<option value="' + v + '"' + (v === S.model ? ' selected' : '') + '>' + t + '</option>').join('');
    const list = Array.isArray(e.models) && e.models.length ? e.models : (e.model ? [e.model] : []);
    if (!list.length) return '<option value="">모델 없음</option>';
    return list.map((m) => '<option value="' + esc(m) + '"' + (m === S.model ? ' selected' : '') + '>' + esc(m) + '</option>').join('');
  }

  // 회원·게스트: 연구 양식 안에서 키를 넣고 고른다(웹판 aiPick 을 옮김).
  function paintAiKey() {
    const box = $('#saikey');
    if (!box) return;
    const e = engObj();
    if (!e || e.kind !== 'webkey') { box.innerHTML = ''; return; }
    const sid = (S.scope && S.scope.scope) || '';
    const isMember = sid === 'member';
    const d = S.keyDraft[e.id] || (S.keyDraft[e.id] = { key: '', save: true });
    box.innerHTML = '<label class="field"><span>' + esc(e.name) + ' API 키 <span class="muted-inline">(AI 회사에서 받는 비밀번호 같은 글자)</span>'
      + (e.keyurl ? ' <a class="lnk" href="' + esc(e.keyurl) + '" target="_blank" rel="noopener">키 받기 ↗</a>' : '') + '</span>'
      + '<input id="saikeyin" type="password" autocomplete="off" spellcheck="false" value="' + esc(d.key || '') + '" placeholder="'
      + (e.saved ? '저장된 키 사용 중 (' + esc(e.hint || '') + ') · 바꾸려면 새 키 입력' : '여기에 키를 붙여 넣기') + '"></label>'
      + (isMember
        ? '<label class="ck"><input type="checkbox" id="saikeysave"' + (d.save !== false ? ' checked' : '') + '> 이 키를 내 계정에 암호화해 저장</label>'
        : '<div class="muted s-note">게스트가 넣은 키는 저장하지 않고, 12시간 뒤 자동으로 지웁니다.</div>');
    const inp = $('#saikeyin');
    if (inp) inp.oninput = () => { d.key = inp.value; updateStartArea(); };
    const ck = $('#saikeysave');
    if (ck) ck.onchange = () => { d.save = ck.checked; };
  }

  // ------------------------------------------------------------ 홈(양식)
  function homeHtml() {
    return '<div class="shome">'
      + '<div class="sform">'
      + '<h1 class="s-h1">AI 본문 연구</h1>'
      + '<p class="s-lead">본문을 넣고 참고할 자료와 AI를 고르면, 그 AI가 서재의 주석·설교를 직접 찾아 읽고 출처(책·쪽)가 달린 본문 연구 보고서를 씁니다. AI 사용료는 고른 AI의 계정에서 나갑니다.</p>'
      + '<div id="sconn">' + connHtml() + '</div>'
      + '<label class="field"><span>본문</span><input id="sref" placeholder="예: 사사기 6:11-24, 롬 8:14-17, 시 23" enterkeyhint="go" value="' + esc(S.settings.ref || '') + '"></label>'
      + '<div class="field-row s-2col">'
      + '<label class="field"><span>목적</span><select id="spur">' + SPUR.map((x) => '<option' + (x === (S.settings.purpose || SPUR[0]) ? ' selected' : '') + '>' + x + '</option>').join('') + '</select></label>'
      + '<label class="field"><span>깊이</span><select id="sdep">' + SDEP.map(([v, l, t]) => '<option value="' + v + '"' + (v === (S.settings.depth || 'normal') ? ' selected' : '') + '>' + l + ' (' + t + ')</option>').join('') + '</select></label>'
      + '</div>'
      + '<div class="field"><span>AI</span><div class="s-ai"><select id="seng" aria-label="AI">' + engineOptions() + '</select>'
      + (modelOptions() ? '<select id="smodel" aria-label="모델">' + modelOptions() + '</select>' : '') + '</div></div>'
      + '<div id="saikey"></div>'
      + '<label class="field"><span>요청·청중 <span class="muted-inline">(선택)</span></span><textarea id="snote" rows="3" placeholder="예: 청중은 50~70대 중심. 기도에 대한 도전으로 마무리하고 싶음. 기드온의 두려움을 중심으로.">' + esc(S.settings.notes || '') + '</textarea></label>'
      + '<div class="field"><span>참고할 자료 <span class="muted" id="scmsg">본문을 넣으면 종류마다 몇 개가 있는지 보입니다</span></span><div id="scats"></div><div id="smybox"></div></div>'
      + '<div id="sermon-options"></div>'
      + '<div class="sstart"><div id="sgo-wrap"></div><span class="muted" id="smsg"></span></div>'
      + '</div>'
      + '<div class="slist-col"><div class="s-h2">지난 연구</div><div id="snotice"></div><div id="slist"><div class="muted">불러오는 중…</div></div>'
      + '<div class="muted s-note">앱에서 돌린 연구는 이 PC에, 서재 서버에서 돌린 연구는 계정에 저장됩니다.</div></div>'
      + '</div>';
  }

  function startBlock() {
    const e = engObj();
    if (!e) return { text: '지금 권한으로 쓸 수 있는 AI 가 없습니다. 설정의 AI 연결을 확인해 주세요.', fix: '설정', act: 'settings' };
    if (e.kind === 'webkey') {
      const d = S.keyDraft[e.id] || {};
      if (!e.saved && !d.key) {
        return { text: e.name + ' API 키를 넣어 주세요. 키는 그 AI 회사에서 받을 수 있습니다(제미나이는 무료).', fix: '설정', act: 'settings' };
      }
      return null;
    }
    if (!e.ready) {
      const why = e.kind === 'cli' ? '이 PC에 설치·로그인되어 있지 않습니다.' : e.kind === 'api' ? 'API 키가 없습니다.' : '서재에 로그인되어 있지 않습니다.';
      return { text: e.name + ' — ' + why + (e.hint ? ' ' + e.hint : ''), fix: '설정', act: 'settings' };
    }
    if (e.id !== 'server' && !S.mcp.has && !S.web.logged_in) {
      return { text: '서재에 로그인하거나 설정에서 서재 연결 주소를 넣어 주세요. 그래야 AI가 서재 자료를 읽을 수 있습니다.', fix: '설정', act: 'settings' };
    }
    return null;
  }

  function updateStartArea() {
    const box = $('#sgo-wrap');
    if (!box) return;
    const b = startBlock();
    // 지금 쓸 AI 한 줄(시험 실수 방지용): 엔진·모델 select 와 같은 값으로 다시 보여 준다.
    const aiLine = aiLineHtml();
    if (!b) {
      box.innerHTML = (aiLine ? aiLine : '') + '<button type="button" class="btn btn-primary" id="sgo">연구 시작</button>';
      $('#sgo').onclick = () => startStudy();
    } else {
      box.innerHTML = (aiLine ? aiLine : '') + '<div class="sblock"><div class="callout warn">' + esc(b.text) + '</div>'
        + '<button type="button" class="btn" id="sfix">' + ico('settings', 16) + esc(b.fix) + '</button></div>';
      $('#sfix').onclick = () => openSettings('ai');
    }
  }

  // 지금 고른 AI(엔진·모델)를 한 줄로 보여 준다. 모델은 job.rs 시작 info 와 같은 표기(Opus/Sonnet).
  function aiLineHtml() {
    const e = engObj();
    if (!e) return '';
    let name = e.name || '';
    let model = S.model || '';
    let label = model;
    if (e.kind === 'cli') {
      // claude: sonnet/opus -> Sonnet/Opus, codex 는 그대로.
      if (e.id === 'claude') {
        if (model === 'opus') label = 'Opus';
        else if (model === 'sonnet') label = 'Sonnet';
      }
    } else if (e.id === 'server') {
      if (model === 'opus') label = 'Opus';
      else if (model === 'sonnet') label = 'Sonnet';
    }
    const isClaudeSub = e.id === 'claude';
    const opusNote = (isClaudeSub && model === 'opus') ? ' <span class="muted-inline">(사용량이 많습니다)</span>' : '';
    return '<div class="s-ai-line">' + esc(name) + ' · ' + esc(label) + ' 로 연구합니다' + opusNote + '</div>';
  }

  function setMsg(t, err) {
    const m = $('#smsg');
    if (!m) return;
    m.textContent = t || '';
    m.className = err ? 'err' : 'muted';
  }

  function paintHome(preserve) {
    S.page = 'home';
    S.id = null;
    S.j = null;
    S.homeTouched = true;
    S.turnsKey = '';
    const bar = $('#sback');
    if (bar) bar.hidden = true;
    const t = $('#sbar-title');
    if (t) t.textContent = 'AI 본문 연구';
    const body = $('#sbody');
    const keep = preserve && body ? body.scrollTop : 0;
    body.innerHTML = homeHtml();
    hydrate(body);
    wireConn();
    wireHome();
    paintAiKey();
    scPaint(S.catsInfo && S.catsInfo.bible_book ? S.catsInfo : null);
    if (S.srData) srPaint();
    updateStartArea();
    if (preserve) body.scrollTop = keep;
    loadList();
    scLoad();
  }

  function wireConn() {
    const set = $('#sset');
    if (set) set.onclick = () => {
      // 로그인 전이면 환영 창을 다시 연다(설정의 계정 갈래보다 짧다).
      if (!(S.web && S.web.logged_in) && window.Welcome) { window.Welcome.open(); return; }
      openSettings(S.web && S.web.logged_in ? 'ai' : 'account');
    };
    const join = $('#sjoin');
    if (join) join.onclick = async () => {
      try { await invoke('web_open', { path: '/signup' }); }
      catch (e) { toast((typeof e === 'string' ? e : (e && e.message)) || '브라우저를 열지 못했습니다.'); }
    };
  }

  function wireHome() {
    const ref = $('#sref');
    if (ref) {
      ref.oninput = () => {
        clearTimeout(S.scTimer);
        S.scTimer = setTimeout(scLoad, 700);
      };
      ref.onkeydown = (e) => { if (e.key === 'Enter') startStudy(); };
    }
    const pur = $('#spur');
    if (pur) pur.onchange = () => saveSettings({ purpose: pur.value });
    const dep = $('#sdep');
    if (dep) dep.onchange = () => saveSettings({ depth: dep.value });
    const note = $('#snote');
    if (note) note.oninput = () => saveSettings({ notes: note.value });
    const eng = $('#seng');
    if (eng) eng.onchange = () => {
      S.eng = eng.value;
      const e = engObj();
      S.model = e ? (S.settings.models && S.settings.models[S.eng]) || e.model || (e.models && e.models[0]) || '' : '';
      if (e && e.id === 'server' && !serverModels().some(([v]) => v === S.model)) S.model = serverModels()[0][0];
      saveSettings({ engine: S.eng, models: Object.assign({}, S.settings.models, { [S.eng]: S.model }) });
      const ms = $('#smodel');
      if (ms) ms.innerHTML = modelOptions();
      paintAiKey();
      updateStartArea();
    };
    const mod = $('#smodel');
    if (mod) mod.onchange = () => {
      S.model = mod.value;
      saveSettings({ models: Object.assign({}, S.settings.models, { [S.eng]: S.model }) });
      updateStartArea();
    };
  }

  async function startStudy() {
    const r = $('#sref') ? $('#sref').value.trim() : '';
    if (!r) { if ($('#sref')) $('#sref').focus(); return; }
    const block = startBlock();
    if (block) { updateStartArea(); setMsg(block.text, true); return; }
    const cats = scGet();
    const preacherSel = srGet().preachers;
    if (cats.includes('ref_sermons') && Array.isArray(preacherSel) && preacherSel.length === 0) { setMsg('설교자를 한 명 이상 선택하거나 전체 선택을 눌러 주세요', true); return; }
    if (S.cats && S.cats.length && !cats.length) { setMsg('참고할 자료를 하나 이상 골라 주세요', true); return; }
    const e = engObj();
    const btn = $('#sgo');
    if (btn) btn.disabled = true;
    setMsg('보내는 중…');
    saveSettings({ purpose: $('#spur').value, depth: $('#sdep').value, notes: $('#snote').value, ref: r });
    try {
      const base = {
        ref: r, purpose: $('#spur').value, depth: $('#sdep').value, notes: $('#snote').value,
        cats, sermon_options: srGet(),
      };
      if (smyOn()) base.my_sermons = await myPack(r);
      let body;
      if (e.kind === 'webkey') {
        // 회원·게스트: 웹판과 같은 본문(ai 안에 provider·model·key·save).
        const d = S.keyDraft[e.id] || {};
        const ai = { provider: e.provider || String(e.id).replace(/^web-/, ''), model: S.model };
        if (d.key) {
          ai.key = d.key;
          if ((S.scope && S.scope.scope) === 'member') ai.save = d.save !== false;
        }
        body = Object.assign(base, { ai });
      } else {
        body = Object.assign(base, { engine: e.id, model: S.model });
      }
      const x = await post('/api/study/start', body);
      if (x && x.ok) { setMsg(''); openView(x.id); } else { setMsg((x && x.error) || '시작하지 못했습니다', true); if (btn) btn.disabled = false; }
    } catch (err) {
      setMsg(err && err.message ? err.message : '서재 서버에 연결하지 못했습니다', true);
      if (btn) btn.disabled = false;
    }
  }

  // ------------------------------------------------------------ 지난 연구
  async function loadList() {
    const box = $('#slist');
    if (!box) return;
    let app = { items: [], queue: 0 };
    let web = { items: [], queue: 0 };
    try { app = (await invoke('study_list')) || app; } catch (e) {}
    if (S.web.logged_in) { try { web = (await api('/api/study/list')) || web; } catch (e) {} }
    const notice = $('#snotice');
    if (notice) {
      const msgs = [];
      if (web && web.claude_backoff) msgs.push('클로드 사용량이 잠시 다 되어 한도가 풀릴 때까지 챗GPT가 연구합니다. 결과 형식은 같습니다.');
      const qn = (app.queue || 0) + (web.queue || 0);
      if (qn) msgs.push('앱에서 이어서 처리할 연구 ' + qn + '건이 기다리고 있습니다.');
      notice.innerHTML = msgs.length ? '<div class="callout warn s-note">' + msgs.map(esc).join('<br>') + '</div>' : '';
    }
    const items = [].concat(
      (app.items || []).map((x) => Object.assign({}, x, { src: 'app' })),
      (web.items || []).filter((x) => !String(x.id || '').startsWith('app-')).map((x) => Object.assign({}, x, { src: 'web' })),
    ).sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')));
    if (!box.isConnected) return;
    if (!items.length) {
      box.innerHTML = '<div class="empty"><span class="empty-ico">' + ico('sparkles', 32) + '</span><p>아직 연구한 본문이 없습니다.</p></div>';
      hydrate(box);
      return;
    }
    box.innerHTML = '<div class="scard">' + items.map((x) => {
      const st = SSTAT[x.status] || [x.status, ''];
      const meta = [x.purpose, depthLabel(x.depth), String(x.created || '').slice(5, 16), (x.turns > 1 ? '이어서 묻기 ' + (x.turns - 1) + '번' : '')]
        .filter(Boolean).join(' · ');
      return '<div class="list-row srow" data-open="' + esc(x.id) + '">'
        + '<div class="srow-t"><span class="row-title">' + esc(x.ref) + '</span><span class="chip chip-sm ssrc">' + (x.src === 'app' ? '앱' : '웹') + '</span></div>'
        + '<div class="row-sub">' + esc(meta) + '</div>'
        + '<div class="srow-r"><span class="chip chip-sm st-' + esc(st[1]) + '">' + esc(st[0]) + '</span>'
        + '<button type="button" class="icon-btn" data-del="' + esc(x.id) + '" title="삭제" aria-label="삭제">' + ico('trash', 16) + '</button></div></div>';
    }).join('') + '</div>';
    hydrate(box);
    box.querySelectorAll('[data-open]').forEach((el) => (el.onclick = () => openView(el.dataset.open)));
    box.querySelectorAll('[data-del]').forEach((el) => (el.onclick = async (ev) => {
      ev.stopPropagation();
      const id = el.dataset.del;
      if (!confirm('이 연구를 삭제할까요?')) return;
      try {
        const r = await post('/api/study/delete', { id });
        if (r && r.ok) { toast('삭제했습니다'); loadList(); }
        else toast((r && r.error) || '삭제하지 못했습니다');
      } catch (e) { toast('삭제하지 못했습니다'); }
    }));
    return items;
  }

  // ------------------------------------------------------------ 보기(보고서)
  function stepsHtml(steps) {
    const list = steps || [];
    if (!list.length) return '<div class="muted">아직 단계가 없습니다.</div>';
    return '<ol class="steps">' + list.map((x) => '<li class="k-' + esc(x.k) + '"><span class="tm">' + esc(String(x.t || '').slice(0, 5)) + '</span>'
      + (x.k === 'think' ? '<i>' + esc(x.x) + '</i>' : esc(x.x)) + '</li>').join('') + '</ol>';
  }

  function progressHtml(t) {
    const steps = t.steps || [];
    const shown = steps.filter((x) => x.k !== 'write' || x === steps[steps.length - 1]);
    const tools = steps.filter((x) => x.k === 'tool').length;
    return '<div class="sprog" data-live data-turn="' + esc(t.status) + '">'
      + '<div class="sprog-h"><span class="sdot" aria-hidden="true"></span><b>' + (t.status === 'queued' ? '차례를 기다리는 중' : '서재를 읽으며 연구하는 중') + '</b>'
      + '<span class="muted">' + (t.started ? since(t.started) + ' 지남' : '') + (tools ? ' · 자료 찾기·읽기 ' + tools + '번' : '') + '</span>'
      + '<span class="spacer"></span>'
      + '<button type="button" class="btn btn-quiet" data-stop' + (S.id && String(S.id).startsWith('app-') ? '' : '') + '>' + ico('stop', 16) + '멈추기</button></div>'
      + (shown.length ? stepsHtml(shown.slice(-14)) : '<div class="muted s-note">서재를 펼치는 중…</div>')
      + '</div>';
  }

  function turnHtml(t, i, j) {
    const st = SSTAT[t.status] || [t.status, ''];
    let h = '<section class="sturn" id="st' + i + '">';
    if (t.q) {
      h += /^\[(버튼|이용자) 답\]/.test(t.q)
        ? '<div class="sq"><span class="chip chip-sm">버튼으로 답함</span><div class="sqa">' + esc(t.q.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).join('\n')) + '</div></div>'
        : '<div class="sq"><span class="chip chip-sm">이어서 묻기</span> ' + esc(t.q) + '</div>';
    }
    if (t.status === 'running' || t.status === 'queued') {
      h += progressHtml(t);
    } else if (t.status === 'done') {
      const parts = splitChoices(t.md);
      const body = parts[0];
      const ch = parts[1];
      const steps = t.steps || [];
      const tools = steps.filter((x) => x.k === 'tool').length;
      h += '<details class="prog"><summary>단계 ' + steps.length + '개</summary>' + stepsHtml(steps) + '</details>';
      h += '<div class="scpbar no-print"><button type="button" class="btn btn-primary" data-cp="plain">서식 없이 복사</button>'
        + '<button type="button" class="btn" data-cp="rich">서식째 복사(한글·워드·노션)</button>'
        + '<button type="button" class="btn" data-cp="outline">설교 개요만</button>'
        + '<button type="button" class="btn" data-cp="src">출처 목록</button></div>';
      h += '<article class="md">' + mdHtml(body) + '</article>';
      if (i === j.turns.length - 1) h += choicesHtml(ch);
      h += '<div class="sfoot muted">' + (ENGINE_LABEL[t.engine] || '') + ' ' + esc(t.model || '') + ' · ' + sdur(t.seconds)
        + ' · 자료 찾기·읽기 ' + tools + '번'
        + (t.cost ? ' · 정가 환산 $' + (+t.cost).toFixed(2) + ' (구독 사용량, 실제 청구 아님)' : '') + '</div>';
    } else {
      h += '<div class="callout ' + (t.status === 'error' ? 'err' : '') + '"><span class="chip chip-sm">' + esc(st[0]) + '</span> ' + esc(t.error || '') + '</div>';
      if (i === 0) h += '<div class="srow-btns"><button type="button" class="btn" data-retry>다시 시도</button></div>';
    }
    return h + '</section>';
  }

  function metaHtml(j) {
    const meta = [j.purpose, depthLabel(j.depth), String(j.created || '').slice(0, 16), (j.notes ? '요청: ' + String(j.notes).slice(0, 80) : '')]
      .filter(Boolean).map(esc).join(' · ');
    const cats = (j.cats && j.cats.length)
      ? '<div>참고 자료: ' + j.cats.map((c) => esc(((S.cats || []).find((x) => x.id === c) || { name: c }).name)).join(', ') + '</div>'
      : '';
    return '<div>' + meta + '</div>' + cats;
  }

  function viewHtml(j) {
    return '<div class="sview">'
      + '<div class="s-main"><div class="s-head"><div class="s-head-l"><h1 class="s-h1" id="sview-ref">' + esc(j.ref) + '</h1>'
      + '<div class="muted s-meta" id="sview-meta">' + metaHtml(j) + '</div></div>'
      + '<div class="s-acts no-print"><button type="button" class="btn" id="scopy">전체 복사(서식 없이)</button>'
      + '<button type="button" class="btn" id="sprint">' + ico('printer', 16) + '인쇄</button>'
      + '<button type="button" class="btn btn-danger" id="sdel">' + ico('trash', 16) + '삭제</button></div></div>'
      + '<div id="sturns"></div></div>'
      + '<aside class="sask no-print" id="sask">'
      + '<div class="sask-h"><b>이어서 묻기</b></div>'
      + '<textarea id="sq" rows="4" placeholder="예: 2대지를 더 자세히 풀어 줘 / 청년부 성경공부 질문 10개로 바꿔 줘"></textarea>'
      + '<div class="sqc">' + ['예화를 더 찾아 줘', '원어 설명을 보강해 줘', '설교 원고 초안으로 써 줘', '소그룹 나눔 질문 만들어 줘']
        .map((x) => '<button type="button" class="chip chip-sm" data-qx="' + esc(x) + '">' + esc(x) + '</button>').join('') + '</div>'
      + '<div class="sask-go"><button type="button" class="btn btn-primary" id="sqgo">묻기</button><span class="muted" id="sqmsg">Ctrl+Enter로 보내기</span></div>'
      + '<div id="sqlist"></div></aside></div>';
  }

  async function openView(id) {
    S.page = 'view';
    S.id = id;
    S.lastId = id;
    S.j = null;
    S.turnsKey = '';
    try { localStorage.setItem(LAST_KEY, id); } catch (e) {}
    if ($('#sback')) $('#sback').hidden = false;
    if ($('#sbar-title')) $('#sbar-title').textContent = '연구 보기';
    const body = $('#sbody');
    if (body) body.innerHTML = '<div class="muted s-loading">불러오는 중…</div>';
    try {
      S.j = await api('/api/study/get?id=' + encodeURIComponent(id));
    } catch (e) {
      if (body) {
        body.innerHTML = '<div class="empty"><span class="empty-ico">' + ico('alert', 32) + '</span><p>' + esc((e && e.message) || '연구를 불러오지 못했습니다.') + '</p><button type="button" class="btn" id="serrback">← AI 본문 연구</button></div>';
        hydrate(body);
        if ($('#serrback')) $('#serrback').onclick = () => paintHome();
      }
      return false;
    }
    if (!S.j || S.j.error) {
      if (body) {
        body.innerHTML = '<div class="empty"><p>없는 연구입니다.</p><button type="button" class="btn" id="serrback">← AI 본문 연구</button></div>';
        if ($('#serrback')) $('#serrback').onclick = () => paintHome();
      }
      return false;
    }
    paintView(true);
    if (!S.cats && S.web.logged_in) {
      // 참고 자료 종류 이름을 보여 주려면 종류 표가 필요하다.
      try {
        const r = await api('/api/study/sources?ref=' + encodeURIComponent(S.j.ref || '') + '&sermon_options=' + encodeURIComponent(JSON.stringify(S.j.sermon_options || {})));
        if (r && Array.isArray(r.cats)) { S.cats = r.cats; paintView(false); const me = $('#sview-meta'); if (me) me.innerHTML = metaHtml(S.j); }
      } catch (e) {}
    }
    return true;
  }

  function paintView(fresh) {
    const j = S.j;
    if (!j) return;
    const body = $('#sbody');
    if (fresh || !$('#sturns')) {
      body.innerHTML = viewHtml(j);
      hydrate(body);
      wireViewActions();
    }
    paintTurns(!!fresh);
    schedulePoll();
  }

  function turnsSig() {
    return ((S.j && S.j.turns) || []).map((t) => t.status + '|' + ((t.md || '').length) + '|' + (t.error || '') + '|' + (t.q || '')).join(';');
  }

  function paintTurns(force) {
    const j = S.j;
    const box = $('#sturns');
    if (!j || !box) return;
    const sig = turnsSig();
    if (!force && sig === S.turnsKey) { paintLive(); return; }
    S.turnsKey = sig;
    const scroller = $('#sbody');
    const y = scroller ? scroller.scrollTop : 0;
    const ta = $('#sq');
    const val = ta ? ta.value : '';
    const s0 = ta ? ta.selectionStart : 0;
    const s1 = ta ? ta.selectionEnd : 0;
    const focused = !!(ta && document.activeElement === ta);
    box.innerHTML = (j.turns || []).map((t, i) => turnHtml(t, i, j)).join('');
    hydrate(box);
    wireTurns();
    const ta2 = $('#sq');
    if (ta2) {
      ta2.value = val;
      if (focused) { ta2.focus(); try { ta2.setSelectionRange(s0, s1); } catch (e) {} }
    }
    if (scroller) scroller.scrollTop = y;
    paintAskState();
    paintQList();
  }

  // 진행 중인 turn 만 다시 그린다(스크롤·이어 묻기 글이 날아가지 않게)
  function paintLive() {
    const j = S.j;
    const box = $('#sturns');
    if (!j || !box) return;
    (j.turns || []).forEach((t, i) => {
      const host = box.querySelector('#st' + i + ' [data-live]');
      if (!host) return;
      const tmp = document.createElement('div');
      tmp.innerHTML = progressHtml(t);
      host.replaceWith(tmp.firstElementChild);
    });
    wireTurns();
    paintAskState();
  }

  function paintAskState() {
    const j = S.j;
    if (!j) return;
    const busy = j.status === 'running' || j.status === 'queued';
    const go = $('#sqgo');
    if (go) go.disabled = busy;
    const m = $('#sqmsg');
    if (m) m.textContent = busy ? '답을 쓰는 중입니다. 끝나면 이어서 물을 수 있습니다.' : 'Ctrl+Enter로 보내기';
  }

  function paintQList() {
    const j = S.j;
    const box = $('#sqlist');
    if (!j || !box) return;
    if (!(j.turns || []).length || j.turns.length < 2) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="sql"><div class="muted">이 연구의 질문들</div>'
      + j.turns.map((t, i) => '<button type="button" class="sql-i" data-go="' + i + '" title="' + esc(t.q || '본문 연구 보고서') + '">'
        + (i ? (/^\[(버튼|이용자) 답\]/.test(t.q) ? '버튼 답: ' + esc((t.q.split('\n').find((l) => l.startsWith('- ')) || '').replace(/^- .*?→\s*/, '')) : esc(t.q))
          : '본문 연구 보고서')
        + ((t.status === 'running' || t.status === 'queued') ? ' <span class="chip chip-sm">진행 중</span>' : '') + '</button>').join('') + '</div>';
    box.querySelectorAll('[data-go]').forEach((a) => (a.onclick = () => {
      const el = $('#st' + a.dataset.go);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }));
  }

  function wireViewActions() {
    const back = $('#sback');
    if (back) back.onclick = () => { S.id = null; paintHome(); };
    const del = $('#sdel');
    if (del) del.onclick = async () => {
      if (!confirm('이 연구를 삭제할까요?')) return;
      try {
        const r = await post('/api/study/delete', { id: S.id });
        if (r && r.ok) { toast('삭제했습니다'); S.id = null; paintHome(); }
        else toast((r && r.error) || '삭제하지 못했습니다');
      } catch (e) { toast('삭제하지 못했습니다'); }
    };
    const cp = $('#scopy');
    if (cp) cp.onclick = () => {
      const j = S.j;
      if (!j) return;
      copyText(j.turns.filter((t) => t.status === 'done').map((t) => (t.q ? '\n\n[이어서 묻기] ' + t.q + '\n\n' : '') + mdPlain(splitChoices(t.md)[0])).join('\n').trim());
    };
    const pr = $('#sprint');
    if (pr) pr.onclick = () => window.print();
    const ta = $('#sq');
    if (ta) {
      ta.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); const b = $('#sqgo'); if (b && !b.disabled) b.click(); } };
    }
    const sg = $('#sqgo');
    if (sg) sg.onclick = async () => {
      const q = $('#sq').value.trim();
      if (!q) return;
      if (await sendAsk(q)) $('#sq').value = '';
    };
    $$('#sask [data-qx]').forEach((a) => (a.onclick = () => { const t2 = $('#sq'); t2.value = a.dataset.qx; t2.focus(); }));
  }

  async function sendAsk(q) {
    const go = $('#sqgo');
    if (go) go.disabled = true;
    try {
      const r = await post('/api/study/ask', { id: S.id, q });
      if (r && r.ok) {
        await refreshNow();
        const el = $('#st' + (S.j.turns.length - 1));
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return true;
      }
      toast((r && r.error) || '보내지 못했습니다');
    } catch (e) {
      toast((e && e.message) || '보내지 못했습니다');
    }
    if (go) go.disabled = false;
    return false;
  }

  async function refreshNow() {
    try {
      const j = await api('/api/study/get?id=' + encodeURIComponent(S.id));
      if (j && !j.error) S.j = j;
    } catch (e) {}
    paintView(false);
  }

  // ------------------------------------------------------------ 보고서 단추·링크
  function wireTurns() {
    const box = $('#sturns');
    if (!box) return;
    box.querySelectorAll('[data-stop]').forEach((b) => (b.onclick = async () => {
      b.disabled = true;
      try { await post('/api/study/stop', { id: S.id }); } catch (e) {}
      refreshNow();
    }));
    box.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = async () => {
      const j = S.j;
      try {
        const r = await post('/api/study/start', {
          ref: j.ref, purpose: j.purpose, depth: j.depth, notes: j.notes, cats: j.cats,
          sermon_options: j.sermon_options, engine: (j.engine || S.eng), model: j.model || S.model,
          my_sermons: (j.my_sermons && j.my_sermons.length) ? await myPack(j.ref) : [],
        });
        if (r && r.ok) openView(r.id);
      } catch (e) { toast('다시 시작하지 못했습니다'); }
    }));
    wireCopy(box);
    wireChoices(box);
    box.querySelectorAll('a.cite').forEach((a) => (a.onclick = (ev) => {
      ev.preventDefault();
      const m = String(a.getAttribute('href')).match(/^#\/(?:read|view)\/([\w-]+)\/(\d+)$/);
      if (m) openRead(m[1], +m[2]);
    }));
    box.querySelectorAll('a.ext').forEach((a) => (a.onclick = async (ev) => {
      ev.preventDefault();
      const u = a.getAttribute('href');
      if (!/^https?:\/\//.test(u)) return;
      try { await navigator.clipboard.writeText(u); } catch (e) {}
      toast('주소를 복사했습니다');
    }));
  }

  function wireCopy(box) {
    box.querySelectorAll('.sturn').forEach((sec) => {
      const i = +String(sec.id).slice(2);
      const t = S.j && S.j.turns[i];
      if (!t || t.status !== 'done') return;
      const md = splitChoices(t.md)[0];
      const art = sec.querySelector('article.md');
      if (!art) return;
      const head = (i ? '[이어서 묻기] ' + t.q + '\n\n' : '');
      sec.querySelectorAll('[data-cp]').forEach((b) => (b.onclick = () => {
        const k = b.dataset.cp;
        if (k === 'plain') copyText(head + mdPlain(md));
        else if (k === 'rich') copyRich(art, head + mdPlain(md));
        else if (k === 'src') { const s = mdSources(md); if (s) copyText(s); else toast('출처 표시가 없습니다'); }
        else if (k === 'outline') {
          const o = mdSections(md).find((x) => /설교 개요|개요 제안|설교 원고|원고/.test(x.title));
          if (o) copyText(mdPlain(o.md)); else toast('설교 개요 부분을 찾지 못했습니다');
        }
      }));
      const secs = mdSections(md);
      art.querySelectorAll('h2,h3').forEach((h, n) => {
        if (h.querySelector('.secp')) return;
        const s = secs.find((x) => x.title === h.textContent.trim()) || secs[n];
        if (!s) return;
        const b = document.createElement('button');
        b.className = 'secp no-print';
        b.type = 'button';
        b.textContent = '이 부분 복사';
        b.onclick = () => copyText(mdPlain(s.md));
        h.appendChild(b);
      });
    });
  }

  function wireChoices(root) {
    const box = $('#sturns .chs');
    if (!box || !root) return;
    box.querySelectorAll('.chos .chip').forEach((b) => (b.onclick = () => {
      const g = b.closest('.chq');
      if (g.dataset.multi !== '1') g.querySelectorAll('.chip').forEach((x) => { if (x !== b) x.classList.remove('on'); });
      b.classList.toggle('on');
    }));
    box.querySelectorAll('[data-nx]').forEach((b) => (b.onclick = () => { b.disabled = true; sendAsk(b.dataset.nx); }));
    const go = box.querySelector('[data-chgo]');
    if (go) go.onclick = () => {
      const lines = [];
      box.querySelectorAll('.chq').forEach((g) => {
        const v = Array.from(g.querySelectorAll('.chip.on')).map((x) => x.dataset.v);
        const t = g.querySelector('.chin').value.trim();
        if (t) v.push(t);
        if (v.length) lines.push('- ' + g.dataset.q + ' → ' + v.join(', '));
      });
      if (!lines.length) { box.querySelector('[data-chmsg]').textContent = '하나 이상 골라 주세요'; return; }
      go.disabled = true;
      sendAsk('[버튼 답]\n' + lines.join('\n') + '\n\n이 답을 반영해 설교 개요를 중심으로 필요한 부분을 다시 다듬어 주세요.');
    };
  }

  // ------------------------------------------------------------ 진행 갱신(이벤트·폴링)
  function visible() {
    const sec = document.getElementById('view-study');
    return !!(sec && !sec.hidden);
  }

  function schedulePoll() {
    clearTimeout(S.timer);
    S.timer = 0;
    if (!S.j || S.page !== 'view') return;
    if (!(S.j.status === 'running' || S.j.status === 'queued')) return;
    const isApp = String(S.id || '').startsWith('app-');
    S.timer = setTimeout(async () => {
      if (!visible() || S.page !== 'view') return;
      if (isApp) { schedulePoll(); return; }      // 앱 연구는 study 이벤트로 받는다
      try {
        const j = await api('/api/study/get?id=' + encodeURIComponent(S.id));
        if (j && !j.error) S.j = j;
      } catch (e) {}
      if (S.page === 'view') paintView(false);
    }, 2000);
  }

  let evQueued = 0;
  let evLast = 0;
  function onStudyEvent(payload) {
    const p = payload && payload.payload ? payload.payload : payload;
    if (!p || !p.id || p.id !== S.id) return;
    if (S.page !== 'view' || !visible()) return;
    // 이벤트가 몰릴 때(초당 여러 번) study_get 을 250ms 로 묶는다.
    // 마지막 이벤트는 반드시 반영되도록 마지막 것 기준으로 타이머를 다시 건다.
    const wait = Math.max(0, 250 - (Date.now() - evLast));
    clearTimeout(evQueued);
    evQueued = setTimeout(() => { evLast = Date.now(); refreshNow(); }, wait);
  }

  function stopTimers() {
    clearTimeout(S.timer);
    S.timer = 0;
    clearTimeout(evQueued);
    evLast = 0;
  }

  // ------------------------------------------------------------ 서재 읽기 서랍
  function cleanTable(html) {
    try {
      const d = new DOMParser().parseFromString(String(html || ''), 'text/html');
      const ok = new Set(['TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH']);
      const walk = (n) => {
        let s = '';
        for (const c of n.childNodes) {
          if (c.nodeType === 3) s += esc(c.textContent);
          else if (c.nodeType === 1) {
            const inner = walk(c);
            if (ok.has(c.tagName)) {
              const sp = ['TD', 'TH'].includes(c.tagName)
                ? ['colspan', 'rowspan'].filter((a) => /^\d+$/.test(c.getAttribute(a) || '')).map((a) => ' ' + a + '="' + c.getAttribute(a) + '"').join('')
                : '';
              const tag = c.tagName.toLowerCase();
              s += '<' + tag + sp + '>' + inner + '</' + tag + '>';
            } else s += inner;
          }
        }
        return s;
      };
      return walk(d.body);
    } catch (e) { return esc(String(html || '')); }
  }

  function pageBlockHtml(b) {
    const label = String(b.label || '');
    const t = esc(b.text || '');
    if (['header', 'footer', 'number', 'image'].includes(label)) return '';
    if (['footnote', 'vision_footnote'].includes(label)) return '<div class="rfn">[각주] ' + t + '</div>';
    if (['figure_title', 'chart_title', 'table_title'].includes(label)) return '<p class="rcap">' + t + '</p>';
    if (['paragraph_title', 'doc_title'].includes(label)) return '<h3 class="rh">' + t + '</h3>';
    if (label === 'table' && /<t[dhr]/i.test(b.text || '')) return '<div class="rtbl">' + cleanTable(b.text) + '</div>';
    return '<p>' + t + '</p>';
  }

  let readerEl = null;
  function readerRoot() {
    if (!readerEl || !document.body.contains(readerEl)) {
      readerEl = document.createElement('div');
      readerEl.id = 'study-reader';
      readerEl.className = 'drawer drawer-wide sreader';
      readerEl.hidden = true;
      document.body.appendChild(readerEl);
    }
    return readerEl;
  }

  function closeReader() {
    const el = readerRoot();
    el.hidden = true;
    el.innerHTML = '';
    S.reading = null;
  }

  function openRead(bookId, page) {
    if (!bookId) return;
    S.reading = { book: String(bookId), page: Math.max(1, +page || 1), book_: null, q: '', showImg: false, mcp: false, total: 0 };
    const el = readerRoot();
    el.hidden = false;
    el.innerHTML = '<div class="sreader-head"><div class="sreader-title"><b id="rtitle">불러오는 중…</b><div class="muted" id="rsub"></div></div>'
      + '<button type="button" class="icon-btn" id="rclose" title="닫기" aria-label="닫기">' + ico('x', 16) + '</button></div>'
      + '<div class="sreader-bar"><button type="button" class="icon-btn" id="rprev" title="이전 쪽" aria-label="이전 쪽">' + ico('chevron-left', 16) + '</button>'
      + '<input id="rpg" type="number" min="1" aria-label="쪽"><span class="muted" id="rtot"></span>'
      + '<button type="button" class="icon-btn" id="rnext" title="다음 쪽" aria-label="다음 쪽">' + ico('chevron-right', 16) + '</button>'
      + '<span class="spacer"></span>'
      + '<button type="button" class="btn btn-quiet" id="rtoc">' + ico('book-open', 16) + '목차</button>'
      + '<button type="button" class="btn btn-quiet" id="rcopy">' + ico('copy', 16) + '이 쪽 복사</button>'
      + '<button type="button" class="btn btn-quiet" id="rimg">' + ico('file-text', 16) + '원본 그림</button></div>'
      + '<div class="sreader-find"><input id="rq" placeholder="이 책에서 찾기"><button type="button" class="btn" id="rfind">찾기</button></div>'
      + '<div id="rside" class="sreader-side" hidden></div>'
      + '<div id="rbody" class="sreader-body"></div>';
    hydrate(el);
    $('#rclose').onclick = closeReader;
    $('#rprev').onclick = () => loadReadPage(S.reading.page - 1);
    $('#rnext').onclick = () => loadReadPage(S.reading.page + 1);
    $('#rpg').onchange = (e) => loadReadPage(+e.target.value || 1);
    $('#rcopy').onclick = copyPage;
    $('#rimg').onclick = togglePageImage;
    $('#rtoc').onclick = showToc;
    $('#rfind').onclick = () => findInBook(($('#rq').value || '').trim());
    $('#rq').onkeydown = (e) => { if (e.key === 'Enter') findInBook(($('#rq').value || '').trim()); };
    loadReadPage(S.reading.page);
  }

  // read_pages 도구 글 → { title, folder, total, pages: [{n, html}] }
  // 첫 줄 `《제목》 (폴더, 전체 N쪽)`, 그 뒤 `=== p.N ===` 줄로 쪽이 나뉜다.
  function parseMcpText(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = { title: '', folder: '', total: 0, pages: [] };
    let i = 0;
    const first = (lines[0] || '').trim();
    const m = first.match(/^《([^》]*)》\s*(?:\((.*)\))?\s*$/);
    if (m) {
      out.title = (m[1] || '').trim();
      const meta = (m[2] || '').trim();
      const tm = meta.match(/전체\s*([\d,]+)\s*쪽/);
      if (tm) out.total = +tm[1].replace(/,/g, '');
      out.folder = meta.replace(/,\s*전체\s*[\d,]+\s*쪽\s*$/, '').trim();
      i = 1;
    }
    let cur = null;
    let para = [];
    const flushP = () => {
      if (cur && para.length) cur.html += '<p>' + para.join(' ') + '</p>';
      para = [];
    };
    for (; i < lines.length; i++) {
      const ln = lines[i];
      const head = ln.match(/^\s*={2,}\s*p\.?\s*(\d+)\s*={2,}\s*$/i);
      if (head) {
        flushP();
        cur = { n: +head[1], html: '' };
        out.pages.push(cur);
        continue;
      }
      const t = ln.trim();
      if (!cur) {
        if (!t) continue;
        cur = { n: 1, html: '' };
        out.pages.push(cur);
      }
      if (!t) { flushP(); continue; }
      if (/^\[각주\]/.test(t)) { flushP(); cur.html += '<div class="rfn">' + esc(t) + '</div>'; continue; }
      if (/^#{2,3}\s+/.test(t)) { flushP(); cur.html += '<h3 class="rh">' + esc(t.replace(/^#+\s*/, '')) + '</h3>'; continue; }
      para.push(esc(t));
    }
    flushP();
    return out;
  }

  // 서재 연결(MCP)로 읽는 동안은 목차·찾기·원본 그림을 막아 둔다.
  function lockReaderTools(on) {
    const note = '서재에 로그인하면 쓸 수 있습니다';
    const btns = { '#rtoc': '목차', '#rimg': '원본 그림' };
    Object.keys(btns).forEach((sel) => {
      const b = $(sel);
      if (!b) return;
      b.classList.toggle('is-locked', !!on);
      b.disabled = !!on;
      b.title = on ? note : btns[sel];
    });
    ['#rq', '#rfind'].forEach((sel) => {
      const e = $(sel);
      if (!e) return;
      e.classList.toggle('is-locked', !!on);
      e.disabled = !!on;
      e.title = on ? note : '';
    });
  }

  function setReaderHead(title, sub, total, p) {
    if ($('#rtitle')) $('#rtitle').textContent = title;
    if ($('#rsub')) $('#rsub').textContent = sub || '';
    if ($('#rtot')) $('#rtot').textContent = total ? '/ ' + total : '';
    if ($('#rpg')) { $('#rpg').value = p; if (total) $('#rpg').max = total; }
  }

  async function loadReadPage(p) {
    const st = S.reading;
    if (!st) return;
    if (p < 1) return;
    const body = $('#rbody');
    if (!body) return;
    const canMcp = !!(S.mcp && S.mcp.has);
    if (!S.web.logged_in && !canMcp) {
      lockReaderTools(false);
      body.innerHTML = '<div class="callout">서재에 로그인하면 이 쪽을 읽을 수 있습니다.</div>';
      return;
    }
    body.innerHTML = '<div class="muted">불러오는 중…</div>';
    let out = null;
    if (S.web.logged_in) {
      try {
        out = await invoke('web_api', { method: 'GET', path: '/api/pages?book=' + encodeURIComponent(st.book) + '&page=' + p + '&count=1', body: null });
      } catch (e) { out = null; }
    }
    const status = out && typeof out.status === 'number' ? out.status : 0;
    const b = (out && out.body && typeof out.body === 'object') ? out.body : {};
    if (status === 401) S.web.logged_in = false;
    if (status === 503 && b.pc_off) S.pcOff = true;
    if (out && status >= 200 && status < 400 && b.ok !== false) { drawWebPage(st, p, b); return; }
    // 로그인 안 됨(401)·집 PC 꺼짐(503)·서버 오류면 서재 연결(MCP)로 이어 읽는다.
    if (canMcp && (!out || !S.web.logged_in || status === 401 || status === 503 || status >= 500 || b.ok === false)) {
      await mcpReadPage(p);
      return;
    }
    lockReaderTools(false);
    body.innerHTML = '<div class="callout err">' + esc(b.error || '쪽을 불러오지 못했습니다.') + '</div>';
  }

  // 서재 서버로 읽은 쪽을 그린다(로그인 상태).
  function drawWebPage(st, p, r) {
    const body = $('#rbody');
    if (!body) return;
    const it = r && r.items && r.items[0];
    if (!it) { lockReaderTools(false); body.innerHTML = '<div class="empty"><p>이 쪽 뒤로는 내용이 없습니다.</p></div>'; return; }
    st.page = p;
    st.mcp = false;
    st.book_ = it.book || st.book_;
    const bk = it.book || {};
    setReaderHead(bk.title || '제목 없음', [bk.folder, bk.pages ? bk.pages + '쪽' : ''].filter(Boolean).join(' · '), bk.pages, p);
    lockReaderTools(false);
    const blocks = it.blocks || [];
    const txt = blocks.length ? blocks.map(pageBlockHtml).join('') : '<div class="empty"><p>이 쪽은 아직 글자를 읽지 않았습니다. [원본 그림]을 눌러 스캔을 보세요.</p></div>';
    body.innerHTML = '<div class="rpage"><div class="rpage-n">' + p + '쪽</div>' + txt + '</div><div id="rimgbox"></div>';
    if (st.showImg) togglePageImage();
  }

  // 로그인 없이 서재 연결(MCP)로 읽는 대체 경로.
  async function mcpReadPage(p) {
    const st = S.reading;
    const body = $('#rbody');
    if (!st || !body) return;
    body.innerHTML = '<div class="muted">서재 연결로 불러오는 중…</div>';
    let res;
    try {
      res = await invoke('mcp_read', { book: st.book, page: p, count: 1 });
    } catch (e) {
      lockReaderTools(true);
      body.innerHTML = '<div class="callout err">' + esc(typeof e === 'string' ? e : (e && e.message) || '쪽을 불러오지 못했습니다.') + '</div>';
      return;
    }
    const text = String((res && res.text) || '');
    if (!text.trim()) { body.innerHTML = '<div class="empty"><p>이 쪽 뒤로는 내용이 없습니다.</p></div>'; return; }
    const par = parseMcpText(text);
    st.mcp = true;
    st.page = p;
    st.total = par.total || st.total || 0;
    setReaderHead(par.title || '제목 없음', [par.folder, par.total ? par.total + '쪽' : ''].filter(Boolean).join(' · '), par.total || 0, p);
    lockReaderTools(true);
    const page = par.pages.find((x) => x.n === p) || par.pages[0];
    const inner = page && page.html
      ? page.html
      : '<div class="empty"><p>이 쪽은 글이 없습니다. 서재에 로그인하면 원본 그림을 볼 수 있습니다.</p></div>';
    body.innerHTML = '<div class="rpage"><div class="rpage-n">' + (page ? page.n : p) + '쪽</div>' + inner + '</div>';
  }

  async function copyPage() {
    const st = S.reading;
    if (!st) return;
    const bk = st.book_ || {};
    const txt = $$('#rbody .rpage p, #rbody .rpage .rh, #rbody .rpage .rcap, #rbody .rpage .rfn').map((x) => x.textContent.trim()).filter(Boolean).join('\n');
    if (!txt) { toast('이 쪽에 복사할 글이 없습니다'); return; }
    copyText('《' + (bk.title || '책') + '》 ' + st.page + '쪽\n\n' + txt);
  }

  async function togglePageImage() {
    const st = S.reading;
    if (!st) return;
    if (st.mcp) { toast('서재에 로그인하면 원본 그림을 볼 수 있습니다'); return; }
    const box = $('#rimgbox');
    if (!box) return;
    if (st.showImg) { st.showImg = false; box.innerHTML = ''; return; }
    st.showImg = true;
    box.innerHTML = '<div class="muted">원본 그림을 불러오는 중…</div>';
    try {
      const src = await invoke('web_image', { book: st.book, page: st.page });
      if (!src) throw new Error('no image');
      box.innerHTML = '<figure class="rimg"><img alt="원본 ' + st.page + '쪽" src="' + esc(src) + '"><figcaption class="muted">원본 스캔 · ' + st.page + '쪽</figcaption></figure>';
    } catch (e) {
      box.innerHTML = '';
      st.showImg = false;
      toast('원본 그림을 불러오지 못했습니다');
    }
  }

  async function showToc() {
    const st = S.reading;
    if (!st) return;
    if (st.mcp) { toast('서재에 로그인하면 목차를 볼 수 있습니다'); return; }
    const side = $('#rside');
    if (!side) return;
    if (!side.hidden && side.dataset.k === 'toc') { side.hidden = true; return; }
    side.hidden = false;
    side.dataset.k = 'toc';
    side.innerHTML = '<div class="muted">목차를 불러오는 중…</div>';
    let r;
    try { r = await api('/api/toc?book=' + encodeURIComponent(st.book)); } catch (e) { side.innerHTML = '<div class="callout err">목차를 불러오지 못했습니다.</div>'; return; }
    const items = (r && r.items) || [];
    side.innerHTML = '<div class="rside-h"><b>목차</b><button type="button" class="icon-btn" data-sideclose title="닫기" aria-label="닫기">' + ico('x', 16) + '</button></div>'
      + (items.length ? items.map((x) => '<button type="button" class="rtoc-i l' + x.level + '" data-page="' + x.page + '"><span>' + esc(x.text) + '</span><small>' + x.page + '</small></button>').join('')
        : '<div class="muted">제목으로 인식된 줄이 없습니다. 쪽 번호로 이동하세요.</div>');
    hydrate(side);
    side.querySelector('[data-sideclose]').onclick = () => { side.hidden = true; };
    side.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => { side.hidden = true; loadReadPage(+b.dataset.page); }));
  }

  async function findInBook(q) {
    const st = S.reading;
    if (!st || !q) return;
    if (st.mcp) { toast('서재에 로그인하면 책 안에서 찾을 수 있습니다'); return; }
    const side = $('#rside');
    if (!side) return;
    side.hidden = false;
    side.dataset.k = 'find';
    side.innerHTML = '<div class="muted">찾는 중…</div>';
    let r;
    try { r = await api('/api/search?q=' + encodeURIComponent(q) + '&book=' + encodeURIComponent(st.book) + '&limit=50'); }
    catch (e) { side.innerHTML = '<div class="callout err">찾지 못했습니다.</div>'; return; }
    const items = (r && r.items) || [];
    side.innerHTML = '<div class="rside-h"><b>' + esc(q) + ' ' + (r && r.total != null ? r.total : items.length) + '곳</b><button type="button" class="icon-btn" data-sideclose title="닫기" aria-label="닫기">' + ico('x', 16) + '</button></div>'
      + (items.length ? items.map((i) => '<button type="button" class="rtoc-i" data-page="' + i.page + '"><span>' + esc(i.snippet || '') + '</span><small>' + i.page + '</small></button>').join('')
        : '<div class="muted">이 책에서 찾지 못했습니다.</div>');
    hydrate(side);
    side.querySelector('[data-sideclose]').onclick = () => { side.hidden = true; };
    side.querySelectorAll('[data-page]').forEach((b) => (b.onclick = () => { side.hidden = true; loadReadPage(+b.dataset.page); }));
  }

  // ------------------------------------------------------------ 켜기
  async function refreshEngines() {
    try { S.engines = (await invoke('ai_engines')) || []; } catch (e) { S.engines = []; }
    // 이 권한에서 쓸 수 없는 AI 가 고른 채로 남아 있으면 그 권한의 첫 번째 준비된 AI 로 바꿉니다.
    const allowed = allowedEngines();
    const cur = S.engines.find((x) => x.id === S.eng);
    if (!cur || cur.allowed === false) {
      // 설정에서 고른 기본 AI → 그 권한에서 처음으로 준비된 AI 순서로 고른다.
      const want = allowed.find((x) => x.id === (S.settings && S.settings.engine));
      const pick = want || allowed.find((x) => x.ready) || allowed[0];
      S.eng = pick ? pick.id : null;
    }
    const e = engObj();
    const saved = S.settings.models && S.settings.models[S.eng];
    S.model = saved || (e && e.model) || '';
    if (e && e.id === 'server' && !serverModels().some(([v]) => v === S.model)) S.model = serverModels()[0][0];
    if (e && Array.isArray(e.models) && e.models.length && !e.models.includes(S.model)) S.model = e.models[0];
  }

  // 권한을 새로 읽는다(로그인·로그아웃·게스트 입장 뒤).
  async function refreshAccount() {
    const [web, scope] = await Promise.all([
      invoke('web_status').catch(() => ({ logged_in: false })),
      invoke('ai_scope').catch(() => null),
    ]);
    S.web = web || { logged_in: false };
    S.pcOff = !!(S.web && S.web.pc_off);
    S.scope = scope || null;
    if (S.scope) S.scope.scope = S.scope.scope || 'none';
    await refreshEngines();
  }

  async function boot() {
    const [settings, mcp] = await Promise.all([
      invoke('study_settings_get').catch(() => ({})),
      invoke('mcp_status').catch(() => ({ has: false })),
    ]);
    S.settings = settings || {};
    S.mcp = mcp || { has: false };
    S.catsOn = Array.isArray(S.settings.cats) ? S.settings.cats : null;
    await refreshAccount();
    try { S.lastId = localStorage.getItem(LAST_KEY) || ''; } catch (e) { S.lastId = ''; }
    S.booted = true;
  }

  // 설정 화면에서 로그인·로그아웃·게스트 입장을 하면 양식을 다시 그린다.
  window.addEventListener('theolib:account', async () => {
    try {
      await refreshAccount();
      if (S.page === 'home') { paintHome(true); loadPref(); }
    } catch (e) { /* 화면이 아직 없으면 다음에 열 때 반영된다 */ }
  });

  let shellBuilt = false;
  function ensureShell() {
    const sec = document.getElementById('view-study');
    if (!sec) return;
    if (shellBuilt && $('#sbody', sec)) return;
    sec.innerHTML = '<div class="bar sbar"><button type="button" class="btn btn-quiet" id="sback" hidden>' + ico('chevron-left', 16) + 'AI 본문 연구</button>'
      + '<span class="sbar-title" id="sbar-title">AI 본문 연구</span><span class="spacer"></span></div>'
      + '<div class="sbody" id="sbody"></div>';
    hydrate(sec);
    const back = $('#sback', sec);
    if (back) back.onclick = () => { S.id = null; paintHome(); };
    // 탭을 떠나면(섹션이 hidden 이 되면) 진행 타이머를 바로 끈다.
    try {
      const mo = new MutationObserver(() => { if (sec.hidden) stopTimers(); });
      mo.observe(sec, { attributes: true, attributeFilter: ['hidden'] });
    } catch (e) {}
    shellBuilt = true;
  }

  let showing = false;
  async function show() {
    ensureShell();
    if (showing) { if (S.page === 'view' && S.j) schedulePoll(); return; }
    showing = true;
    try {
      if (!S.booted) await boot();
      if (S.id) await openView(S.id);
      else if (!S.id && !S.homeTouched && S.lastId) { const ok = await openView(S.lastId); if (!ok) { S.id = null; S.lastId = ''; try { localStorage.removeItem(LAST_KEY); } catch (e) {} paintHome(); } S.homeTouched = true; }
      else paintHome();
      loadPref();
      loadList();
    } catch (e) {
      const body = $('#sbody');
      if (body) body.innerHTML = '<div class="callout err">' + esc((e && e.message) || '화면을 열지 못했습니다.') + '</div>';
    } finally { showing = false; }
  }

  // 처음 열 때 한 번만 듣는다.
  try { listen('study', onStudyEvent); } catch (e) {}
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const r = document.getElementById('study-reader');
    if (r && !r.hidden) closeReader();
  });

  // 설교 설계도에서 넘어올 때: 본문과 요청 글을 채운 시작 화면을 연다. AI는 사용자가 고르고 시작한다.
  async function prefill(o) {
    ensureShell();
    if (!S.booted) await boot();
    saveSettings({ ref: (o && o.ref) || '', notes: (o && o.notes) || '' });
    S.id = null;
    paintHome();
    loadPref();
    loadList();
  }

  // 설계도의 출처에서 돌아올 때: 그 연구를 연다.
  async function open(id) {
    ensureShell();
    if (!S.booted) await boot();
    return openView(id);
  }
  // 지금 보고 있는 것(담기 단추가 출처를 붙일 때 쓴다).
  function current() {
    const t = document.getElementById('rtitle');
    return {
      job: S.page === 'view' && S.j ? { id: S.id, ref: S.j.ref || '' } : null,
      reading: S.reading ? { book: S.reading.book, page: S.reading.page, title: t ? t.textContent : '' } : null,
    };
  }

  window.Study = { show, openRead, prefill, open, current };
})();




