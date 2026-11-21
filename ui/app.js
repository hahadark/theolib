// app.js — 신학 서재 화면(성경 보기·검색·소논문·자료 출처).
// 성경 보기 화면은 layout.js 의 패널 시스템을 쓴다(자유 배치·여러 자료·글 서식).
// 최초 두 줄은 dev-mock.js(브라우저) 또는 실제 Tauri 가 채운 window.__TAURI__ 를 쓴다.
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const state = {
  books: [], versions: [], vers: [], bk: 44, ch: 1,
  curVerse: null,          // 현재(연동) 구절
  sel: new Set(), last: null,
  notes: [], comm: null,   // 연동 주석 캐시
  parseRow: [],            // 연동 원전 분해 캐시
  rows: [],                // 연동 본문 캐시
  url: null,
  // 패널별 캐시
  panelData: {},
};
const fmtB = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');
const bookName = (n) => (state.books.find((b) => b.n === n) || {}).name || n;

// ============================================================ 탭 전환
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  if (v === 'sources') loadSources();
  if (v === 'articles') loadArticles();
  if (v === 'search') idxNote();
}

// ============================================================ 자료 출처 (다른 작업자가 고침 — 그대로 둠)
const FILENAMES = { 'bible-ko': '한국어 성경 번역본', 'bible-en': '영어 성경 번역본', 'bible-etc': '그 밖의 번역본(원어 본문 등)', orig: '원어 번호 본문·원전 분해·원어 사전 2종', comm: '주석 6종·소논문' };
async function loadSources() {
  const list = await invoke('sources');
  const box = $('#srclist');
  box.innerHTML = list.length ? '' : '<p class="muted">설치된 출처가 없습니다.</p>';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'note';
    const total = s.decl.files.filter((f) => s.installed.includes(f.id)).reduce((a, f) => a + f.db_bytes, 0);
    d.innerHTML = `<b>${esc(s.origin || '자료 출처')}</b><div class="muted">받은 파일: ${esc(s.installed.map((i) => FILENAMES[i] || i).join(', '))} · 푼 크기 ${fmtB(total)}</div><div class="muted">${esc(s.decl.updated)} ${esc(s.decl.note)}</div>`;
    const sync = Object.assign(document.createElement('button'), { textContent: '갱신 확인' });
    const rm = Object.assign(document.createElement('button'), { textContent: '삭제' });
    sync.onclick = async () => run(async () => { $('#progress').hidden = false; const u = await invoke('sync_source'); msg(u.length ? '갱신: ' + u.join(', ') : '바뀐 파일이 없습니다.'); await boot(); });
    rm.onclick = async () => { if (!confirm('이 출처의 받은 자료와 검색 색인을 모두 지웁니다. 계속할까요?')) return; await run(async () => { await invoke('remove_source'); msg('지웠습니다.'); await boot(); loadSources(); }); };
    d.append(sync, ' ', rm);
    box.append(d);
  }
}
const msg = (t, err) => { const m = $('#srcmsg'); m.textContent = t; m.className = err ? 'err' : 'muted'; };
async function run(f) { try { await f(); } catch (x) { msg(String(x), true); } finally { $('#progress').hidden = true; } }
$('#srcshow').onclick = () => { const i = $('#srcurl'); i.type = i.type === 'password' ? 'text' : 'password'; };
$('#srccheck').onclick = () => run(async () => {
  const url = $('#srcurl').value.trim();
  if (!url) return;
  msg('선언 파일을 확인하는 중…');
  const d = await invoke('preview_source', { url });
  msg('');
  state.url = url;
  const p = $('#srcpreview');
  p.innerHTML = `<div class="note"><b>${esc(d.origin || '자료 출처')}</b><div class="muted">${esc(d.updated)}</div><div class="muted">${esc(d.note)}</div></div>`;
  for (const f of d.files) {
    const l = document.createElement('label');
    l.className = 'file';
    l.innerHTML = `<input type="checkbox" checked value="${esc(f.id)}"> <span>${esc(FILENAMES[f.id] || f.id)} (${esc(f.id)})</span> <span class="muted">${fmtB(f.bytes)} 받기 · 풀면 ${fmtB(f.db_bytes)}</span>`;
    p.append(l);
  }
  const go = Object.assign(document.createElement('button'), { textContent: '받기' });
  go.onclick = () => run(async () => {
    const files = [...p.querySelectorAll('input:checked')].map((i) => i.value);
    if (!files.length) return msg('받을 파일을 고르세요.', true);
    $('#progress').hidden = false;
    msg('받는 중… (중간에 끊겨도 다시 누르면 이어받습니다)');
    await invoke('add_source', { url: state.url, files });
    $('#srcurl').value = ''; state.url = null; p.innerHTML = '';
    msg('받기를 마쳤습니다. 검색 색인은 백그라운드에서 만드는 중입니다(성경 보기는 바로 쓸 수 있습니다).');
    await boot(); loadSources();
  });
  p.append(go);
});
listen('progress', (ev) => {
  const { label, done, total } = ev.payload;
  $('#progress').hidden = false;
  $('#fill').style.width = (total ? Math.min(100, (done * 100) / total) : 0) + '%';
  const idx = /색인/.test(label);
  $('#ptext').textContent = ` ${label} ${idx ? done.toLocaleString() + ' / ' + total.toLocaleString() + '건' : fmtB(done) + ' / ' + fmtB(total)}`;
  if (idx) { state.indexing = true; idxNote(label + ' ' + (total ? Math.floor((done * 100) / total) : 0) + '%'); }
});
listen('index-done', (ev) => { state.indexing = false; $('#progress').hidden = true; idxNote(); if (ev.payload) msg('색인 오류: ' + ev.payload, true); else if ($('#srcmsg').textContent.includes('색인')) msg('검색 색인까지 모두 마쳤습니다.'); });
async function idxNote(t) {
  const st = await invoke('index_status').catch(() => null);
  const n = $('#idxnote');
  if (!st || st.ready) { n.hidden = true; return; }
  if (!st.running && !state.indexing) invoke('resume_index');
  n.hidden = false;
  n.textContent = t || '검색 색인을 만드는 중입니다…';
}

// ============================================================ 성경 보기 (패널 시스템)
const VNAME = () => Object.fromEntries(state.versions.map((v) => [v.id, v.name]));

async function boot() {
  const list = await invoke('sources');
  const inst = list.length ? list[0].installed : [];
  const has = inst.some((i) => i.startsWith('bible-')) || inst.includes('orig');
  if (!has) { state.versions = []; $('#vers').innerHTML = ''; $('#panes').innerHTML = '<p class="muted" style="padding:12px 16px">성경 자료가 없습니다. 「자료 출처」에서 주소를 넣고 받으세요.</p>'; showView('sources'); return; }
  state.books = await invoke('books');
  state.versions = (await invoke('versions')).filter((v) => v.kind !== 'parse');
  state.vers = state.vers.filter((id) => state.versions.some((v) => v.id === id));
  if (!state.vers.length) { const t = state.versions.filter((v) => v.kind === 'text'); const k = t.find((v) => v.id === '개역개정') || t[0] || state.versions[0]; state.vers = k ? [k.id] : []; }
  $('#book').innerHTML = state.books.map((b) => `<option value="${b.n}">${esc(b.name)}</option>`).join('');
  let g = null, hv = '';
  for (const v of state.versions) { const gg = (v.kind === 'code' ? '원어 번호 본문' : v.file + ' · ' + (v.grp || '')); if (gg !== g) { g = gg; hv += `<div class="g">${esc(g)}</div>`; } hv += `<label title="${esc(v.desc)}"><input type="checkbox" value="${esc(v.id)}" ${state.vers.includes(v.id) ? 'checked' : ''}>${esc(v.name)}</label>`; }
  $('#vers').innerHTML = hv;
  $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`;
  $('#vers').onchange = () => { state.vers = [...document.querySelectorAll('#vers input:checked')].map((i) => i.value); $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`; syncBodyPanels(); };
  fillChap();
  await openChapter(false);
}

function fillChap() {
  const b = state.books.find((x) => x.n === state.bk);
  $('#chap').innerHTML = Array.from({ length: b ? b.ch : 1 }, (_, i) => `<option value="${i + 1}">${i + 1}장</option>`).join('');
  $('#book').value = state.bk; $('#chap').value = state.ch;
}

// 본문 패널들이 고른 번역본을 전역 선택에 맞춘다(기본). 패널 자체 vers 는 유지 허용.
function syncBodyPanels() {
  for (const p of Layout.panels()) if (p.kind === 'body') { p.settings.vers = [...state.vers]; }
  Layout.refreshPanes();
}

// 현재 연동 구절(전역) 읽기
function currentRef() { return { bk: state.bk, ch: state.ch, v: state.curVerse }; }

// 패널이 "지금 보여야 할" 구절
function panelRef(panel) {
  if (panel.linked) return currentRef();
  if (panel.ref) return panel.ref;
  return currentRef();
}

// ---- 자료 로드(전역 캐시, key 로 나눔)
async function loadRows(vers) {
  if (!vers.length) return [];
  return invoke('chapter', { bk: state.bk, ch: state.ch, vers });
}
async function loadNotes(bk, ch, v) {
  return invoke('notes', { bk, ch, v }).catch(() => []);
}
async function loadParse(bk, ch, v) {
  return invoke('parse', { bk, ch, v }).catch(() => []);
}

const cache = {};
function cacheKey(...a) { return JSON.stringify(a); }
async function cached(fn, ...args) {
  const k = cacheKey(...args);
  if (k in cache) return cache[k];
  const r = await fn(...args);
  cache[k] = r;
  return r;
}
function invalidateCache() { for (const k in cache) delete cache[k]; }

// ---- 패널 본문 렌더
function renderBody(panel) {
  const ref = panelRef(panel);
  const vers = panel.settings.vers && panel.settings.vers.length ? panel.settings.vers : [...state.vers];
  const el = panel.body;
  el.innerHTML = '<p class="muted">불러오는 중…</p>';
  cached(loadRows, vers).then((rows) => {
    if (panel !== panelByIdLive(panel.id)) return;
    // 패널별 글자 크기 배율/글 폭(전역 따르기 끄면) 적용
    const useGlobal = panel.settings.useGlobal !== false;
    let inline = '';
    if (!useGlobal && panel.settings.fontScale) inline += `font-size:calc(var(--body-size) * ${panel.settings.fontScale});`;
    if (!useGlobal && panel.settings.maxW) inline += `max-width:${panel.settings.maxW};`;
    el.style.cssText = inline;
    const ownSel = panel.linked ? state.sel : new Set(panel.ref && panel.ref.v != null ? [panel.ref.v] : []);
    el.innerHTML = rows.map((r) => {
      const sel = ownSel.has(+r.v);
      return `<div class="vrow ${sel ? 'sel' : ''}" data-v="${r.v}" data-bk="${ref.bk}" data-ch="${ref.ch}">` +
        `<span class="n vnum ${Fmt.value().target.body.vn}">${r.v}</span>` +
        `<div class="t">${r.texts.map((t) => `<div>${vers.length > 1 ? `<span class="vn">${esc(VNAME()[t.ver] || t.ver)}</span>` : ''}${t.html}</div>`).join('')}</div></div>`;
    }).join('') || '<p class="muted">이 장의 본문이 없습니다.</p>';
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}
function panelByIdLive(id) { return Layout.panelById(id); }

function renderComm(panel) {
  const ref = panelRef(panel);
  const el = panel.body;
  el.innerHTML = '<p class="muted">불러오는 중…</p>';
  cached(loadNotes, ref.bk, ref.ch, ref.v).then((notes) => {
    if (panel !== panelByIdLive(panel.id)) return;
    const comms = [...new Set(notes.map((n) => n.comm_name))];
    let cur = panel.settings.series;
    if (!comms.includes(cur)) cur = comms[0] || null;
    panel.settings.series = cur; panel.saveSettings();
    const tabs = comms.length ? comms.map((c) => `<button class="${c === cur ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('') : '';
    const body = notes.filter((n) => n.comm_name === cur).map((n) =>
      `<div class="note"><h4>${n.kind ? `<span class="tag">${esc(n.kind)}</span>` : ''}${esc(n.title)} <span class="muted">${esc(n.ref)}</span></h4><div>${n.html}</div></div>`).join('') || '<span class="muted">이 자리의 주석이 없습니다.</span>';
    el.innerHTML = tabs ? `<div class="subtabs">${tabs}</div><div class="notes">${body}</div>` : `<div class="notes">${body}</div>`;
    const tb = el.querySelector('.subtabs');
    if (tb) tb.onclick = (ev) => { const b = ev.target.closest('button'); if (b) { panel.settings.series = b.dataset.c; panel.saveSettings(); Layout.refreshPanelMeta(panel.id); renderComm(panel); } };
    el.querySelector('.notes').onclick = (ev) => { const a = ev.target.closest('a.sc'); if (a) showLex(a.dataset.c, panel); };
    Layout.refreshPanelMeta(panel.id);
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}

function renderParse(panel) {
  const ref = panelRef(panel);
  const el = panel.body;
  el.innerHTML = '<p class="muted">불러오는 중…</p>';
  cached(loadParse, ref.bk, ref.ch, ref.v).then((words) => {
    if (panel !== panelByIdLive(panel.id)) return;
    el.innerHTML = words.length ? '<table class="parse"><tr><th>원어</th><th>번호</th><th>원형</th><th>음역</th><th>문법</th><th>뜻</th></tr>' + words.map((w) => `<tr data-c="${esc(w.code)}"><td>${esc(w.w)}</td><td>${esc(w.code)}</td><td>${esc(w.lemma)}</td><td>${esc(w.tr)}</td><td>${esc(w.parse)}</td><td>${esc(w.gloss)}</td></tr>`).join('') + '</table>' : '<span class="muted">원전 분해 자료가 없습니다.</span>';
    el.querySelector('table').onclick = (ev) => { const tr = ev.target.closest('tr[data-c]'); if (tr && tr.dataset.c) showLex(tr.dataset.c, panel); };
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}

function renderLex(panel) {
  const el = panel.body;
  if (!panel.settings.code) { el.innerHTML = '<span class="muted">본문·주석·원전 분해에서 번호를 누르면 사전이 나옵니다.</span>'; return; }
  showLex(panel.settings.code, panel);
}

function renderSearch(panel) {
  const el = panel.body;
  const q = panel.settings.q || '';
  el.innerHTML = `<div class="bar" style="border:none;padding:0 0 6px"><input class="p-search-q" placeholder="검색어" value="${esc(q)}" style="flex:1"><button class="p-search-go">검색</button></div><div class="p-search-result"></div>`;
  const inp = el.querySelector('.p-search-q');
  const go = el.querySelector('.p-search-go');
  const result = el.querySelector('.p-search-result');
  const doIt = () => {
    const qq = inp.value.trim();
    panel.settings.q = qq; panel.saveSettings();
    if (!qq) { result.innerHTML = ''; return; }
    result.innerHTML = '<p class="muted">검색 중…</p>';
    cached(doSearchRaw, qq).then((hits) => {
      if (panel !== panelByIdLive(panel.id)) return;
      const vname = VNAME();
      result.innerHTML = (hits.length ? '' : '<p class="muted">결과가 없습니다.</p>') + hits.map((h, i) => `<div class="hit" data-i="${i}"><b>${h.area === 'article' ? '소논문 ' + esc(h.ref_) : esc(bookName(h.bk)) + ' ' + h.ch + (h.v ? ':' + h.v : '')}</b> <span class="tag">${esc(h.area === 'bible' ? vname[h.src] || h.src : h.src)}</span><div>${esc(h.snippet).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>')}</div></div>`).join('');
      result.onclick = (ev) => { const d = ev.target.closest('.hit'); if (!d) return; const h = hits[+d.dataset.i]; if (h.area === 'article') { showView('articles'); openArticle(h.note_id, h.ref_); return; } state.bk = h.bk || state.bk; state.ch = h.ch || 1; fillChap(); openChapter(h.v || null); };
    }).catch((x) => { result.innerHTML = `<p class="err">${esc(x)}</p>`; });
  };
  go.onclick = doIt;
  inp.addEventListener('keydown', (ev) => ev.key === 'Enter' && doIt());
}
async function doSearchRaw(q) {
  return invoke('search_text', { q, area: 'bible', vers: state.vers });
}

function renderArticlePanel(panel) {
  const el = panel.body;
  el.innerHTML = '<p class="muted">불러오는 중…</p>';
  invoke('articles').then((list) => {
    if (panel !== panelByIdLive(panel.id)) return;
    el.innerHTML = list.length ? list.map((a) => `<div class="hit" data-id="${a.id}" data-t="${esc(a.title)}"><b>${esc(a.title)}</b> <span class="tag">${esc(a.src_name)}</span> <span class="muted">${esc(a.section)} · ${a.chars.toLocaleString()}자</span></div>`).join('') : '<p class="muted">소논문 자료가 없습니다.</p>';
    el.onclick = (ev) => { const d = ev.target.closest('.hit'); if (d) openArticleBody(d.dataset.id, d.dataset.t, el); };
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}
async function openArticleBody(id, title, el) {
  const body = await invoke('article_body', { id }).catch((x) => `<p class="err">${esc(x)}</p>`);
  el.innerHTML = `<div id="article-title">${esc(title || '')}</div>${body}`;
}

function renderPanel(panel) {
  switch (panel.kind) {
    case 'body': renderBody(panel); break;
    case 'comm': renderComm(panel); break;
    case 'parse': renderParse(panel); break;
    case 'lex': renderLex(panel); break;
    case 'search': renderSearch(panel); break;
    case 'article': renderArticlePanel(panel); break;
  }
}

function panelTitle(panel) {
  const s = panel.settings;
  if (panel.kind === 'body') {
    const vers = (s.vers && s.vers.length ? s.vers : state.vers);
    return vers.map((id) => VNAME()[id] || id).join(', ') || '번역본 없음';
  }
  if (panel.kind === 'comm') return s.series || '주석';
  if (panel.kind === 'search') return s.q || '';
  return '';
}

// ---- 사전 팝업(패널 내부)
async function showLex(code, panel) {
  panel.settings.code = code; panel.saveSettings();
  const el = panel.body;
  const es = await invoke('lex', { code }).catch(() => []);
  if (panel !== panelByIdLive(panel.id)) return;
  el.innerHTML = es.length ? es.map((e) => `<div class="lex"><b>${esc(e.code)} ${esc(e.head)}</b> <span class="tag">${esc(e.dict === 'HebGrkKo' ? '한글 원어사전' : e.dict === 'HebGrkEn' ? '영어 원어사전' : e.dict)}</span><div>${e.html}</div></div>`).join('') : `<div class="lex muted">${esc(code)}: 사전에 이 낱말이 없습니다.</div>`;
}

// ---- 전역 렌더
function renderAll() {
  for (const p of Layout.panels()) renderPanel(p);
}

// ---- 장 열기(연동 갱신)
async function openChapter(focusV) {
  fillChap();
  if (!state.vers.length) { $('#panes').innerHTML = '<p class="muted" style="padding:12px 16px">번역본을 하나 이상 고르세요.</p>'; return; }
  invalidateCache();
  state.curVerse = focusV != null ? focusV : null;
  state.sel.clear(); state.last = null;
  state.panelData = {};
  renderAll();
}

// ---- 패널 본문에서 절 클릭 시 연동 갱신
function panelFromEvent(ev) {
  const pane = ev.target.closest('.p-pane');
  return pane ? Layout.panelById(pane.dataset.pid) : null;
}

function onBodyClick(ev) {
  const a = ev.target.closest('a.sc');
  if (a) { const p = panelFromEvent(ev); if (p) showLex(a.dataset.c, p); return; }
  const row = ev.target.closest('.vrow');
  if (!row) return;
  const v = +row.dataset.v;
  const panel = panelFromEvent(ev);
  if (!panel) return;
  const bk = +row.dataset.bk || state.bk, ch = +row.dataset.ch || state.ch;
  if (panel.linked) {
    selectVerse(v, ev.shiftKey);
  } else {
    panel.ref = { bk, ch, v };
    renderPanel(panel);
  }
}

function selectVerse(v, extend) {
  if (extend && state.last && state.last >= 0) { state.sel.clear(); for (let i = Math.min(v, state.last); i <= Math.max(v, state.last); i++) state.sel.add(i); }
  else { state.sel = new Set([v]); state.last = v; }
  state.curVerse = v;
  // 연동 패널만 다시 그린다(선택 강조·주석·원전 연동)
  for (const p of Layout.panels()) if (p.linked) renderPanel(p);
}

// ---- 패널 body 클릭 위임(렌더 때마다 교체되므로 위임은 #panes 에 두고 이벤트로 분기)
function attachPanelEvents() {
  document.querySelector('#panes').addEventListener('click', (ev) => {
    const pane = ev.target.closest('.p-pane');
    if (!pane) return;
    const panel = Layout.panelById(pane.dataset.pid);
    if (!panel) return;
    if (panel.kind === 'body') onBodyClick(ev);
  });
}

// ---- 상단 내비게이션
$('#book').onchange = () => { state.bk = +$('#book').value; state.ch = 1; openChapter(false); };
$('#chap').onchange = () => { state.ch = +$('#chap').value; openChapter(false); };
$('#prev').onclick = () => { if (state.ch > 1) { state.ch--; openChapter(false); } };
$('#next').onclick = () => { const b = state.books.find((x) => x.n === state.bk); if (b && state.ch < b.ch) { state.ch++; openChapter(false); } };

// ---- 배치/서식 툴바
function toolbarName() {
  const names = Layout.layoutNames();
  $('#layout-name').textContent = '';
}

// 패널 추가: 종류 고르는 간단한 prompt(목록)
function choosePanelKind() {
  const kinds = Object.keys(Layout.PANEL_META);
  const names = kinds.map((k, i) => `${i + 1}. ${Layout.PANEL_META[k].name}`).join('\n');
  const s = prompt('추가할 패널 종류(번호):\n' + names);
  if (s == null) return null;
  const n = parseInt(s, 10);
  if (n >= 1 && n <= kinds.length) return kinds[n - 1];
  // 한글 이름으로도 허용
  const found = kinds.find((k) => Layout.PANEL_META[k].name === s.trim());
  return found || null;
}

$('#add-panel').onclick = () => {
  const kind = choosePanelKind();
  if (kind) { Layout.addPanel(kind); toolbarName(); }
};

$('#layout-save').onclick = () => {
  const name = prompt('배치 이름:');
  if (!name) return;
  const root = Layout.currentRoot();
  const existing = Layout.layoutNames().includes(name);
  if (existing && !confirm(`"${name}" 배치를 덮어씁니다. 계속할까요?`)) return;
  Layout.saveLayout(name, root, true);
  toolbarName();
};

$('#layout-load').onclick = () => {
  const names = Layout.layoutNames();
  if (!names.length) return alert('저장된 배치가 없습니다.');
  const s = prompt('불러올 배치 이름 (기본 포함):\n' + names.map((n, i) => `${i + 1}. ${n}`).join('\n'));
  if (!s) return;
  const n = parseInt(s, 10);
  const name = (n >= 1 && n <= names.length) ? names[n - 1] : s.trim();
  const root = Layout.loadLayout(name, true);
  if (root) { Layout.setRoot(root); toolbarName(); }
};

$('#layout-default').onclick = () => {
  const s = prompt('기본 배치 선택:\n1. 본문만\n2. 본문+주석\n3. 본문·주석·원어');
  if (!s) return;
  const defs = Layout.defaults();
  const key = s.trim() === '1' ? '본문만' : s.trim() === '2' ? '본문+주석' : (s.trim() === '3' ? '본문·주석·원어' : s.trim());
  if (defs[key]) { Layout.setRoot(defs[key].root); toolbarName(); }
};

// ---- 서식 UI (간단한 팝오버)
function buildFormatUI() {
  const host = document.createElement('div');
  host.id = 'format-pop';
  host.className = 'format-pop';
  host.hidden = true;
  document.body.appendChild(host);
  return host;
}

let formatHost = null;
let formatTarget = 'all'; // 'all' | panel id

function fmtOpts(targetId) {
  const f = Fmt.target(targetId);
  const fonts = Fmt.FONT_CANDIDATES.map((x) => `<option value="${esc(x)}" ${x === f.font ? 'selected' : ''}>${esc(x)}</option>`).join('');
  const vns = Fmt.VN_MODES.map((m) => `<label><input type="radio" name="vn" value="${m.id}" ${f.vn === m.id ? 'checked' : ''}>${m.name}</label>`).join(' ');
  return {
    f, fonts, vns,
  };
}

function openFormat() {
  if (!formatHost) formatHost = buildFormatUI();
  formatHost.hidden = false;
  formatTarget = 'all';
  renderFormatHost();
}

function openPanelFormat(panel) {
  if (!formatHost) formatHost = buildFormatUI();
  formatHost.hidden = false;
  formatTarget = panel; // Panel 객체
  renderFormatHost();
}

function renderFormatHost() {
  const isPanel = formatTarget !== 'all';
  const panel = isPanel ? formatTarget : null;
  // 패널 서식: 폰트 크기 배율과 전체 따르기 여부. 전체 서식은 공통.
  formatHost.innerHTML = `<div class="fp-head"><b>${isPanel ? (panel.name() + ' 서식') : '글 서식'}</b> <span class="fp-close" title="닫기">✕</span></div>`;
  const body = document.createElement('div');
  body.className = 'fp-body';

  if (isPanel) {
    const useGlobal = panel.settings.useGlobal !== false;
    body.innerHTML = `
      <label><input type="checkbox" id="fp-global" ${useGlobal ? 'checked' : ''}> 전체 서식 따르기</label>
      <div id="fp-panel" ${useGlobal ? 'style="opacity:.5;pointer-events:none"' : ''}>
        <div>글자 크기 배율: <input id="fp-scale" type="number" step="0.1" min="0.5" max="3" value="${panel.settings.fontScale || 1}"></div>
        <div>글 폭: <input id="fp-maxw" value="${esc(panel.settings.maxW || '')}" placeholder="예: 46em (비우면 공통)"></div>
      </div>`;
    const apply = document.createElement('button');
    apply.textContent = '적용';
    body.appendChild(apply);
    apply.onclick = () => {
      panel.settings.useGlobal = body.querySelector('#fp-global').checked;
      panel.settings.fontScale = parseFloat(body.querySelector('#fp-scale').value) || 1;
      panel.settings.maxW = body.querySelector('#fp-maxw').value.trim() || null;
      panel.saveSettings();
      renderAll();
      formatHost.hidden = true;
    };
  } else {
    const targets = Fmt.TARGETS;
    const tb = document.createElement('div');
    tb.className = 'fp-tabs';
    let activeTarget = 'body';
    const content = document.createElement('div');
    content.className = 'fp-content';
    function showTarget(tid) {
      activeTarget = tid;
      [...tb.children].forEach((b) => b.classList.toggle('on', b.dataset.t === tid));
      const o = fmtOpts(tid);
      content.innerHTML = `
        <div class="fp-row"><label>글꼴</label><select class="fp-font">${o.fonts}</select></div>
        <div class="fp-row"><label>크기</label><input class="fp-size" type="number" min="8" max="72" value="${o.f.size}">px</div>
        <div class="fp-row"><label>줄 간격</label><input class="fp-line" type="number" step="0.1" min="1" max="3" value="${o.f.line}"></div>
        <div class="fp-row"><label>자간</label><input class="fp-letter" value="${esc(o.f.letter)}"></div>
        <div class="fp-row"><label>문단 간격</label><input class="fp-para" value="${esc(o.f.para)}"></div>
        <div class="fp-row"><label>글 폭</label><input class="fp-maxw" value="${esc(o.f.maxW)}" placeholder="46em / none"></div>
        <div class="fp-row"><label>정렬</label><select class="fp-align"><option value="left" ${o.f.align === 'left' ? 'selected' : ''}>왼쪽</option><option value="justify" ${o.f.align === 'justify' ? 'selected' : ''}>양쪽</option></select></div>
        <div class="fp-row"><label>절 번호</label><span class="fp-vn">${o.vns}</span></div>
        <button class="fp-apply">적용</button>`;
      content.querySelector('.fp-apply').onclick = () => {
        const patch = {
          font: content.querySelector('.fp-font').value,
          size: +content.querySelector('.fp-size').value,
          line: +content.querySelector('.fp-line').value,
          letter: content.querySelector('.fp-letter').value.trim(),
          para: content.querySelector('.fp-para').value.trim(),
          maxW: content.querySelector('.fp-maxw').value.trim(),
          align: content.querySelector('.fp-align').value,
          vn: content.querySelector('.fp-vn input:checked').value,
        };
        Fmt.setTarget(tid, patch);
        renderAll();
      };
    }
    // 탭
    for (const t of targets) {
      const b = document.createElement('button');
      b.dataset.t = t.id; b.textContent = t.name;
      b.classList.toggle('on', t.id === 'body');
      tb.appendChild(b);
    }
    tb.onclick = (ev) => { const b = ev.target.closest('button'); if (b) showTarget(b.dataset.t); };
    body.appendChild(tb);

    // 공통 + 테마 + 절 줄바꿈
    const common = document.createElement('div');
    common.className = 'fp-common';
    const f = Fmt.value();
    common.innerHTML = `
      <div class="fp-row"><label>색 테마</label><select id="fp-theme">
        <option value="system" ${f.theme === 'system' ? 'selected' : ''}>시스템 따라가기</option>
        <option value="light" ${f.theme === 'light' ? 'selected' : ''}>밝게</option>
        <option value="dark" ${f.theme === 'dark' ? 'selected' : ''}>어둡게</option>
        <option value="sepia" ${f.theme === 'sepia' ? 'selected' : ''}>세피아</option>
      </select></div>
      <div class="fp-row"><label>검색어 강조색</label><input id="fp-hl" type="color" value="${esc(f.searchHl)}"></div>
      <label><input id="fp-lb" type="checkbox" ${f.lineBreak ? 'checked' : ''}> 절마다 줄바꿈</label>
      <div class="fp-row"><label>서식 묶음</label>
        <select id="fp-preset"><option value="">—</option>${Fmt.presetNames().map((n) => `<option>${esc(n)}</option>`).join('')}</select>
        <input id="fp-preset-name" placeholder="이름" size="12">
        <button id="fp-save">저장</button><button id="fp-load">불러오기</button><button id="fp-del">삭제</button>
        <button id="fp-default" title="기본값으로">기본값으로</button>
      </div>`;
    body.appendChild(common);
    body.appendChild(content);

    const refreshPreset = () => {
      const s = common.querySelector('#fp-preset');
      s.innerHTML = `<option value="">—</option>` + Fmt.presetNames().map((n) => `<option>${esc(n)}</option>`).join('');
    };
    common.querySelector('#fp-theme').onchange = (ev) => { Fmt.set({ theme: ev.target.value }); };
    common.querySelector('#fp-hl').oninput = (ev) => { Fmt.set({ searchHl: ev.target.value }); };
    common.querySelector('#fp-lb').onchange = (ev) => { Fmt.set({ lineBreak: ev.target.checked }); };
    common.querySelector('#fp-save').onclick = () => { const n = common.querySelector('#fp-preset-name').value.trim(); if (n) { Fmt.savePreset(n); refreshPreset(); } };
    common.querySelector('#fp-load').onclick = () => { const n = common.querySelector('#fp-preset').value; if (n) { Fmt.loadPreset(n); renderFormatHost(); renderAll(); } };
    common.querySelector('#fp-del').onclick = () => { const n = common.querySelector('#fp-preset').value; if (n && confirm(`"${n}" 묶음을 지웁니다.`)) { Fmt.deletePreset(n); refreshPreset(); } };
    common.querySelector('#fp-default').onclick = () => { Fmt.resetToDefault(); renderFormatHost(); renderAll(); };

    showTarget('body');
  }

  const head = formatHost.querySelector('.fp-head');
  head.querySelector('.fp-close').onclick = () => { formatHost.hidden = true; };
  head.parentNode.insertBefore(body, head.nextSibling);
}

$('#format-btn').onclick = openFormat;
Layout.setOpenPanelFormat(openPanelFormat);

// ---- 단축키: ⌘+ / ⌘- / ⌘0 (활성 패널 우선, 없으면 본문 공통)
function activePanel() {
  const el = document.activeElement;
  const pane = el && el.closest ? el.closest('.p-pane') : null;
  return pane ? Layout.panelById(pane.dataset.pid) : null;
}
window.addEventListener('keydown', (ev) => {
  if (!(ev.metaKey || ev.ctrlKey)) return;
  if (ev.key === '=' || ev.key === '+') { ev.preventDefault(); Fmt.bump(activePanel(), 1); }
  else if (ev.key === '-') { ev.preventDefault(); Fmt.bump(activePanel(), -1); }
  else if (ev.key === '0') { ev.preventDefault(); Fmt.resetSize(activePanel()); }
});

// ---- 인용 복사 (2,000자 제한)
$('#cite').onclick = async () => {
  if (!state.sel.size) return alert('복사할 절을 누르세요. (Shift+누르기로 범위 선택)');
  const vs = [...state.sel].sort((a, b) => a - b);
  const first = state.vers[0];
  const vname = (state.versions.find((v) => v.id === first) || {}).name || first;
  const rows = await cached(loadRows, state.vers);
  const tmp = document.createElement('div');
  let text = vs.map((v) => { const r = rows.find((x) => x.v === v); const t = r && (r.texts.find((x) => x.ver === first) || r.texts[0]); tmp.innerHTML = t ? t.html : ''; return `${v} ${tmp.textContent.trim()}`; }).join('\n');
  const range = vs.length > 1 ? `${vs[0]}-${vs[vs.length - 1]}` : vs[0];
  const cite = `\n— ${bookName(state.bk)} ${state.ch}:${range} (${vname})`;
  if (text.length + cite.length > 2000) text = text.slice(0, 2000 - cite.length - 1) + '…';
  await navigator.clipboard.writeText(text + cite);
  $('#cite').textContent = '복사했습니다'; setTimeout(() => ($('#cite').textContent = '인용 복사'), 1500);
};

// ---- 구절 이동·검색
async function go(input) {
  if (!state.books.length) return false;
  const r = await invoke('goto_ref', { input });
  if (!r) return false;
  [state.bk, state.ch] = r; showView('bible'); await openChapter(r[2] || null); return true;
}
$('#goto').addEventListener('keydown', async (ev) => { if (ev.key === 'Enter' && !(await go($('#goto').value))) $('#goto').style.borderColor = '#c0392b'; else $('#goto').style.borderColor = ''; });
async function doSearch() {
  const q = $('#q').value.trim(); if (!q) return;
  if (await go(q)) return;
  const area = $('#area').value;
  const hits = await invoke('search_text', { q, area, vers: state.vers }).catch((x) => { $('#results').innerHTML = `<p class="err">${esc(x)}</p>`; return null; });
  if (!hits) return;
  const vname = VNAME();
  $('#results').innerHTML = (hits.length ? '' : '<p class="muted">결과가 없습니다.</p>') + hits.map((h, i) => `<div class="hit" data-i="${i}"><b>${h.area === 'article' ? '소논문 ' + esc(h.ref_) : esc(bookName(h.bk)) + ' ' + h.ch + (h.v ? ':' + h.v : '')}</b> <span class="tag">${esc(h.area === 'bible' ? vname[h.src] || h.src : h.src)}</span><div>${esc(h.snippet).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>')}</div></div>`).join('');
  $('#results').onclick = (ev) => { const d = ev.target.closest('.hit'); if (!d) return; const h = hits[+d.dataset.i]; if (h.area === 'article') { showView('articles'); openArticle(h.note_id, h.ref_); return; } state.bk = h.bk || state.bk; state.ch = h.ch || 1; showView('bible'); openChapter(h.v || null); };
}
$('#dosearch').onclick = doSearch;
$('#q').addEventListener('keydown', (ev) => ev.key === 'Enter' && doSearch());

// ---- 소논문 (좌측 목록은 기존 화면, 우측은 소논문 화면)
async function loadArticles() {
  const list = await invoke('articles').catch(() => []);
  $('#articlelist').innerHTML = list.length ? list.map((a) => `<div class="hit" data-id="${a.id}" data-t="${esc(a.title)}"><b>${esc(a.title)}</b> <span class="tag">${esc(a.src_name)}</span> <span class="muted">${esc(a.section)} · ${a.chars.toLocaleString()}자</span></div>`).join('') : '<p class="muted">소논문 자료가 없습니다.</p>';
}
$('#articlelist').addEventListener('click', (ev) => { const d = ev.target.closest('.hit'); if (d) openArticle(+d.dataset.id, d.dataset.t); });
async function openArticle(id, title) {
  const body = await invoke('article_body', { id }).catch((x) => `<p class="err">${esc(x)}</p>`);
  $('#articlebody').innerHTML = `<div id="article-title">${esc(title || '')}</div>${body}`;
}

// ---- 초기화
attachPanelEvents();
Layout.init(document.querySelector('#panes'), {
  renderAll,
  renderPanel,
  panelTitle,
  onLinkChange: (panel) => { if (panel.kind === 'body') renderBody(panel); else renderPanel(panel); },
});
Fmt.apply();
toolbarName();
boot();
