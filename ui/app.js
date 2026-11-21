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
  view: 'bible',           // 열려 있는 화면 탭
  // 패널별 캐시
  panelData: {},
};

// ---- 마지막 화면 상태(책·장·절·번역본·열린 탭) 저장·복원(localStorage theolib.ui.v1)
function saveView() {
  UIStore.write({ lastView: { bk: state.bk, ch: state.ch, curVerse: state.curVerse, vers: [...state.vers], view: state.view } });
}
function restoreView() {
  const lv = UIStore.read().lastView;
  if (!lv) return;
  const b = state.books.find((x) => x.n === lv.bk) || state.books[0];
  if (b) state.bk = b.n;
  const ch = Math.min(lv.ch || 1, (state.books.find((x) => x.n === state.bk) || {}).ch || 1);
  state.ch = Math.max(1, ch);
  if (Array.isArray(lv.vers)) state.vers = lv.vers.filter((id) => state.versions.some((v) => v.id === id));
  if (lv.curVerse != null) state.curVerse = lv.curVerse;
  if (lv.view && ['bible', 'search', 'articles', 'sources'].includes(lv.view)) state.view = lv.view;
}
const fmtB = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');
const bookName = (n) => (state.books.find((b) => b.n === n) || {}).name || n;

// ============================================================ 탭 전환
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  state.view = v;
  if (v === 'sources') loadSources();
  if (v === 'articles') loadArticles();
  if (v === 'search') idxNote();
  saveView();
}

// ============================================================ 자료 출처 (다른 작업자가 고침 — 그대로 둠)
const FILENAMES = { 'bible-ko': '한국어 성경 번역본', 'bible-en': '영어 성경 번역본', 'bible-etc': '그 밖의 번역본(원어 본문 등)', orig: '원어 번호 본문·원전 분해·원어 사전 2종', comm: '주석 6종·소논문' };
async function loadSources() {
  const list = await invoke('sources');
  const box = $('#srclist');
  box.innerHTML = list.length ? '' : '<p class="muted">설치된 출처가 없습니다.</p>';
  $('#firstrun').hidden = list.length > 0;
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'note';
    const total = s.decl.files.filter((f) => s.installed.includes(f.id)).reduce((a, f) => a + f.db_bytes, 0) + (s.items || []).reduce((a, r) => a + r.db_bytes, 0);
    const ni = (s.items || []).length;
    d.innerHTML = `<b>${esc((s.sources || []).map((x) => x.origin || x.title || '자료 출처').join(' + ') || s.origin || '자료 출처')}</b><div class="muted">${ni ? `받은 항목 ${ni}개` : `받은 파일: ${esc(s.installed.map((i) => FILENAMES[i] || i).join(', '))}`} · 푼 크기 ${fmtB(total)}</div><div class="muted">${esc(s.decl.updated)} ${esc(s.decl.note)}</div>`;
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
const KIND = { bible: '번역본', code: '원어 번호 본문', lex: '사전', comm: '주석' };

// ---- 항목 숨기기 (화면에서만 끔, 지우지 않고 localStorage theolib.ui.v1 에 키만 저장)
// 숨김 키는 코어와 맞춘다: v:<번역본/원어 id>, d:<사전 id>, s:<주석 시리즈 id>
function hiddenList() {
  const arr = (window.UIStore && window.UIStore.read().hiddenItems) || [];
  return Array.isArray(arr) ? arr : [];
}
// 화면의 숨김 목록을 코어에 전달(검색 결과에서도 빠지게)
function syncHidden() { return invoke('set_hidden', { hidden: hiddenList() }).catch(() => {}); }
function isHidden(key) { return hiddenList().includes(key); }
function setHidden(key, on) {
  const set = new Set(hiddenList());
  if (on) set.add(key); else set.delete(key);
  window.UIStore.write({ hiddenItems: [...set] });
  syncHidden();
}
// 항목(ItemRec) → 숨김 키. name 이 번역본 id·사전 id·시리즈 id 역할을 한다.
function itemHiddenKey(f) {
  if (!f) return null;
  if (f.kind === 'bible' || f.kind === 'code') return 'v:' + f.name;
  if (f.kind === 'lex') return 'd:' + f.name;
  if (f.kind === 'comm') return 's:' + (f.series || f.name);
  return null;
}
const KORD = { bible: 0, code: 1, lex: 2, comm: 3 };
const GORD = { '한국어': 0, '영어': 1, '원어': 2, '외국어': 3 };
const DEFAULT_NAMES = ['개역개정', '개역한글', '새번역', 'ESV', 'NIV2011', 'KJV1769'];
const itemState = { url: null, files: [], sel: new Set(), sort: 'default', dir: 1, q: '', installed: [], filter: 'all', collapsed: {}, focusKind: null };
async function previewUrl(url) {
  msg('선언 파일을 확인하는 중…');
  let d;
  try { d = await invoke('preview_source', { url }); } catch (x) {
    if (url === state.freeUrl && /404/.test(String(x))) { msg('기본 자료가 아직 준비되지 않았습니다.', true); return; }
    throw x;
  }
  msg('');
  state.url = url;
  if (d.layout === 'items') { if (d.size) msg(`압축 파일 목록을 읽었습니다(받은 바이트 ${fmtB(d.fetched)} / 전체 ${fmtB(d.size)}).`); return showItems(d, url); }
  $('#itemsbox').innerHTML = '';
  const p = $('#srcpreview');
  p.innerHTML = `<div class="note"><b>${esc(d.title || d.origin || '자료 출처')}</b><div class="muted">${esc(d.updated)}</div><div class="muted">${esc(d.note)}</div></div>`;
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
}
$('#srccheck').onclick = () => run(async () => { const url = $('#srcurl').value.trim(); if (url) await previewUrl(url); });
$('#freebtn').onclick = () => run(async () => { state.freeUrl = await invoke('free_url'); await previewUrl(state.freeUrl); });
$('#cancel').onclick = () => invoke('cancel_download');

// ---- 파일로 추가(자료 파일 .bdb .sdb .dct .cdb): 같은 항목 목록 화면, 출처 "내 파일"
async function handlePaths(paths) {
  if (!paths || !paths.length) return;
  showView('sources');
  await run(async () => {
    msg('파일을 확인하는 중…');
    const r = await invoke('scan_local', { paths });
    if (r.declaration) { msg(''); state.url = r.declaration; return previewUrl(r.declaration); }
    const ok = r.items.filter((i) => !i.skip), bad = r.items.filter((i) => i.skip);
    if (!r.items.length) return msg('가져올 수 있는 자료 파일(.bdb .sdb .dct .cdb)이 없습니다.', true);
    const src = await invoke('sources');
    itemState.installed = src.length ? src[0].items || [] : [];
    itemState.local = true; itemState.rawLocal = ok;
    itemState.files = ok.map((i) => ({ ...i, license: i.desc, sha256: '' }));
    itemState.sel = new Set(itemState.files.map((f) => f.id)); itemState.q = ''; itemState.sort = 'default'; itemState.dir = 1;
    $('#srcpreview').innerHTML = `<div class="note"><b>내 파일</b> <span class="muted">${ok.length}개 인식</span>${bad.length ? `<div class="err">건너뜀 ${bad.length}개: ${bad.map((b) => esc(b.name + ' (' + b.skip + ')')).join(', ')}</div>` : ''}</div>`;
    msg(`${ok.length}개를 인식했습니다.`);
    drawItems();
  });
}
function drawLocalButtons() {
  const { files, sel } = itemState;
  $('#itgo').textContent = '선택한 파일 가져오기';
  $('#itgo').onclick = () => run(async () => {
    const chosen = files.filter((f) => sel.has(f.id));
    if (!chosen.length) return msg('가져올 항목을 고르세요.', true);
    const dup = chosen.filter((f) => statusOf(f) === '받음');
    let replace = false;
    if (dup.length) replace = confirm(`이미 있는 항목 ${dup.length}개(${dup.slice(0, 3).map((d) => d.name).join(', ')}…)를 바꿉니다. [확인]=바꾸기, [취소]=건너뛰기`);
    $('#progress').hidden = false;
    const [done, skipped] = await invoke('import_local', { items: chosen.map(({ license, sha256, ...rest }) => rest), replace });
    msg(`가져왔습니다 ${done.length}개${skipped.length ? `, 건너뜀 ${skipped.length}개` : ''}. 검색 색인은 백그라운드에서 만드는 중입니다.`);
    itemState.local = false; $('#itemsbox').innerHTML = ''; $('#srcpreview').innerHTML = '';
    await boot(); await loadSources();
  });
  $('#itdel').onclick = () => run(async () => {
    const ids = files.filter((f) => sel.has(f.id) && statusOf(f) === '받음').map((f) => f.id);
    if (!ids.length) return msg('삭제할 항목을 고르세요.', true);
    if (!confirm(`${ids.length}개 항목을 지웁니다. 계속할까요?`)) return;
    await invoke('remove_items', { ids }); msg('지웠습니다.'); await boot(); await loadSources(); drawItems();
  });
}
$('#pickfiles').onclick = async () => handlePaths(await invoke('pick_paths', { folder: false }));
$('#pickfolder').onclick = async () => handlePaths(await invoke('pick_paths', { folder: true }));
listen('tauri://drag-drop', (ev) => handlePaths(ev.payload && ev.payload.paths));

// ---- 항목별 받기: 종류별 상자(카드), 칩/타일, 영역·Shift·상자 선택
const KINDS_ORDER = ['bible', 'code', 'lex', 'comm'];
let itemFrontier = []; // 화면에 그려진 타일 순서(id) → Shift 범위 선택
async function showItems(d, url) {
  d.files = (d.files || []).filter((f) => !f.skip);
  $('#srcpreview').innerHTML = `<div class="note"><b>${esc(d.title || d.origin || '자료 출처')}</b> <span class="muted">${esc(d.origin)}</span><div class="muted">${esc(d.updated)} ${esc(d.note)}</div>${(d.links || []).map((l) => `<div><span>${esc(l.title || l.url)}</span> <button data-link="${esc(l.url)}">추가</button></div>`).join('')}</div>`;
  $('#srcpreview').querySelectorAll('button[data-link]').forEach((b) => (b.onclick = () => run(async () => previewUrl(b.dataset.link))));
  const src = await invoke('sources');
  itemState.installed = src.length ? src[0].items || [] : [];
  itemState.local = false; itemState.url = url; itemState.files = d.files; itemState.q = ''; itemState.sort = 'default'; itemState.dir = 1;
  itemState.filter = 'all'; itemState.collapsed = {}; itemState.focusKind = null; itemState.anchorId = null;
  itemState.sel = new Set(d.files.filter(defaultSelected).map((f) => f.id));
  drawItems();
}
// 기본 선택: default 힌트를 따르되, 주석(kind=comm)은 크기와 무관하게 기본 선택.
function defaultSelected(f) {
  if (statusOf(f) === '받음') return false;
  if (f.kind === 'comm') return true;
  if (f.default != null) return !!f.default;
  return f.kind === 'bible' ? DEFAULT_NAMES.includes(f.name) : true;
}
function statusOf(f) {
  if (itemState.local) return itemState.installed.some((x) => x.id === f.id) ? '받음' : '안 받음'; const r = itemState.installed.find((x) => x.id === f.id); return !r ? '안 받음' : r.sha256 === f.sha256 ? '받음' : '새 판 있음'; }
// 검색어·빠른 거르기 단추를 반영해 화면에 보여줄 항목만 골라낸다.
function visibleFiles() {
  const { files, q, filter } = itemState;
  const ql = q.trim().toLowerCase();
  return files.filter((f) => {
    if (ql && !(f.name + ' ' + f.grp + ' ' + (KIND[f.kind] || '') + ' ' + (f.license || '')).toLowerCase().includes(ql)) return false;
    const st = statusOf(f);
    if (filter === 'have' && st !== '받음') return false;
    if (filter === 'none' && st !== '안 받음') return false;
    if (filter === 'new' && st !== '새 판 있음') return false;
    return true;
  });
}
// 종류별 묶음. 번역본(kind=bible)은 분류(한국어·영어·원어·외국어)별 작은 구역으로 나눈다.
function groupPanels() {
  const vis = visibleFiles();
  const panels = [];
  for (const kind of KINDS_ORDER) {
    const its = vis.filter((f) => f.kind === kind);
    if (kind === 'bible') {
      for (const grp of ['한국어', '영어', '원어', '외국어']) {
        const arr = its.filter((f) => f.grp === grp);
        if (arr.length) panels.push({ kind, grp, items: arr });
      }
      const etc = its.filter((f) => !['한국어', '영어', '원어', '외국어'].includes(f.grp));
      if (etc.length) panels.push({ kind, grp: '기타', items: etc });
    } else if (its.length) {
      panels.push({ kind, grp: null, items: its });
    }
  }
  return panels;
}
function tileHtml(f, inSeries) {
  const key = inSeries ? null : itemHiddenKey(f);
  const hid = key && isHidden(key);
  const on = itemState.sel.has(f.id);
  const st = statusOf(f);
  const stCls = st === '받음' ? 'st-have' : st === '새 판 있음' ? 'st-new' : '';
  const stTxt = st === '받음' ? '✓ 받음' : st === '새 판 있음' ? '새 판 있음' : '';
  const grpSel = itemState.local && f.kind === 'bible'
    ? `<select class="it-grp" data-grp="${esc(f.id)}">${['한국어', '영어', '원어', '외국어'].map((g) => `<option ${g === f.grp ? 'selected' : ''}>${g}</option>`).join('')}</select>`
    : '';
  const grp = f.kind === 'bible' && !grpSel ? `<span class="it-grp muted">${esc(f.grp)}</span>` : '';
  return `<button type="button" class="it-tile${on ? ' on' : ''}${hid ? ' hidden' : ''}" data-id="${esc(f.id)}" data-kind="${esc(f.kind)}">
    <span class="it-tile-top"><span class="it-name">${esc(inSeries ? f.book : f.name)}</span>${key ? `<span class="it-hide" role="button" data-key="${esc(key)}" data-on="${hid ? 0 : 1}" title="${hid ? '화면에 다시 보이기' : '화면에서만 숨기기 (지우지 않음)'}">${hid ? '👁 보임' : '👁 숨김'}</span>` : ''}</span>
    <span class="it-tile-meta">${grpSel}${grp}${stTxt ? `<span class="it-status ${stCls}">${stTxt}</span>` : ''}<span class="it-bytes muted">${fmtB(f.bytes)}</span></span>
    ${f.license ? `<span class="it-license muted">${esc(f.license)}</span>` : ''}
    <span class="it-progress"></span>
  </button>`;
}
// ── 책별로 나눠 받는 주석 시리즈: 시리즈 타일 하나 + 펼치면 구약/신약 책 타일 ──
const isSplit = (f) => f.kind === 'comm' && !!f.series && f.bk != null;
function idsOf(id) {
  if (!String(id).startsWith('series:')) return [id];
  const sid = id.slice(7);
  return visibleFiles().filter((f) => isSplit(f) && f.series === sid).map((f) => f.id);
}
const allSelected = (ids) => ids.length > 0 && ids.every((x) => itemState.sel.has(x));
function seriesHtml(sid, vis) {
  const all = itemState.files.filter((f) => isSplit(f) && f.series === sid);
  const head = all[0];
  const name = head.series_name || String(head.name).split(' · ')[0];
  const ids = vis.map((f) => f.id);
  const nOn = vis.filter((f) => itemState.sel.has(f.id)).length;
  const onBytes = vis.filter((f) => itemState.sel.has(f.id)).reduce((a, f) => a + f.bytes, 0);
  const st = all.map(statusOf), have = st.filter((s) => s !== '안 받음').length;
  const stTxt = !have ? '' : st.some((s) => s === '새 판 있음') ? '새 판 있음' : have === all.length ? '✓ 받음' : `${have}책 받음`;
  const stCls = stTxt === '새 판 있음' ? 'st-new' : stTxt ? 'st-have' : '';
  const open = !!(itemState.expanded && itemState.expanded[sid]);
  const key = itemHiddenKey(head), hid = key && isHidden(key);
  const tileOn = allSelected(ids);
  const total = head.series_bytes != null ? head.series_bytes : all.reduce((a, f) => a + f.bytes, 0);
  let h = `<button type="button" class="it-tile it-series${tileOn ? ' on' : ''}${hid ? ' hidden' : ''}" data-id="series:${esc(sid)}" data-kind="comm">
    <span class="it-tile-top"><span class="it-name">${esc(name)}</span><span class="it-sexp" role="button" data-sid="${esc(sid)}" title="책별로 펼치기·접기">${open ? '▾ 책 접기' : '▸ 책 고르기'}</span>${key ? `<span class="it-hide" role="button" data-key="${esc(key)}" data-on="${hid ? 0 : 1}" title="${hid ? '화면에 다시 보이기' : '화면에서만 숨기기 (지우지 않음)'}">${hid ? '👁 보임' : '👁 숨김'}</span>` : ''}</span>
    <span class="it-tile-meta">${all.length}/66책 · 고른 ${nOn}책<span class="it-bytes muted">${fmtB(onBytes)} / ${fmtB(total)}</span>${stTxt ? `<span class="it-status ${stCls}">${stTxt}</span>` : ''}</span>
    <span class="it-progress"></span>
  </button>`;
  if (open) {
    const sec = (lab, arr0) => { const arr = [...arr0].sort((x, y) => x.bk - y.bk); return arr.length ? `<div class="it-sub it-bookset"><div class="it-subh">${lab} <span class="muted">${arr.length}</span></div><div class="it-tiles">${arr.map((f) => tileHtml(f, true)).join('')}</div></div>` : ''; };
    h += `<div class="it-books" style="grid-column:1/-1">${sec('구약', vis.filter((f) => f.bk >= 1 && f.bk <= 39))}${sec('신약', vis.filter((f) => f.bk >= 40))}${sec('공통', vis.filter((f) => f.bk < 1))}</div>`;
  }
  return h;
}
function tilesHtml(items) {
  const out = [], seen = new Set();
  for (const f of items) {
    if (!isSplit(f)) { out.push(tileHtml(f)); continue; }
    if (seen.has(f.series)) continue;
    seen.add(f.series);
    out.push(seriesHtml(f.series, items.filter((x) => isSplit(x) && x.series === f.series)));
  }
  return out.join('');
}
function drawItems() {
  const { files, sel } = itemState;
  const vis = visibleFiles();
  const chosen = files.filter((f) => sel.has(f.id));
  const total = chosen.reduce((a, f) => a + f.bytes, 0);
  const panels = groupPanels();

  let filterBar = '<div class="it-bar">';
  for (const [k, lab] of [['all', '전체'], ['have', '받은 것'], ['none', '안 받은 것'], ['new', '새 판 있음']])
    filterBar += `<button type="button" class="it-fbtn${itemState.filter === k ? ' on' : ''}" data-filter="${k}">${lab}</button>`;
  filterBar += `<input id="itq" placeholder="이름·분류·근거로 검색" value="${esc(itemState.q)}"><span class="muted">${vis.length}/${files.length}항목</span></div>`;

  let body = '';
  for (const kind of KINDS_ORDER) {
    const parts = panels.filter((p) => p.kind === kind);
    if (!parts.length) continue;
    const all = vis.filter((f) => f.kind === kind);
    const n = all.length, m = all.filter((f) => sel.has(f.id)).length;
    const mb = all.filter((f) => sel.has(f.id)).reduce((a, f) => a + f.bytes, 0);
    const ck = 'kind:' + kind;
    const collapsed = !!(itemState.collapsed && itemState.collapsed[ck]);
    const allOn = m === n;
    let inner = '';
    for (const p of parts) {
      if (p.grp) inner += `<div class="it-sub" data-kind="${kind}"><div class="it-subh">${esc(p.grp)} <span class="muted">${p.items.length}</span></div><div class="it-tiles">${tilesHtml(p.items)}</div></div>`;
      else inner += `<div class="it-tiles" data-kind="${kind}">${tilesHtml(p.items)}</div>`;
    }
    body += `<section class="it-card" data-kind="${kind}" tabindex="0">
      <header class="it-head">
        <button type="button" class="it-cfold" data-cfold="${ck}" aria-expanded="${!collapsed}">${collapsed ? '▸' : '▾'} <b>${esc(KIND[kind] || kind)}</b></button>
        <span class="it-stats muted">${n}개 · 고른 것 ${m}개 · ${fmtB(mb)}</span>
        <span class="spacer"></span>
        <button type="button" class="it-selall" data-kind="${kind}" data-on="${allOn ? 0 : 1}">${allOn ? '해제' : '모두 선택'}</button>
      </header>
      ${collapsed ? '' : inner}
    </section>`;
  }
  if (!body) body = '<p class="muted it-empty">조건에 맞는 항목이 없습니다.</p>';

  $('#itemsbox').innerHTML = `<div class="it-bar">${filterBar}</div><div class="it-scroll">${body}</div>
  <div class="it-foot"><b id="itsum">${chosen.length}개 선택 · 받는 용량 ${fmtB(total)}</b><span class="spacer"></span><button type="button" id="itgo">받기</button><button type="button" id="itdel">고른 것 삭제</button><button type="button" id="ithide">숨기기/보이기</button></div>`;

  itemFrontier = [...$('#itemsbox').querySelectorAll('.it-tile')].map((t) => t.dataset.id);

  const qi = $('#itq'); qi.oninput = () => { itemState.q = qi.value; drawItems(); };
  $('#itemsbox').querySelectorAll('.it-fbtn').forEach((b) => (b.onclick = () => { itemState.filter = b.dataset.filter; itemState.focusKind = null; drawItems(); }));
  $('#itemsbox').querySelectorAll('.it-cfold').forEach((b) => (b.onclick = () => { const k = b.dataset.cfold; itemState.collapsed[k] = !itemState.collapsed[k]; drawItems(); itemState.focusKind = k.slice(5); }));
  $('#itemsbox').querySelectorAll('.it-selall').forEach((b) => (b.onclick = () => { const kind = b.dataset.kind, on = b.dataset.on === '1'; for (const f of vis) if (f.kind === kind) on ? sel.add(f.id) : sel.delete(f.id); itemState.focusKind = kind; drawItems(); }));
  $('#itemsbox').querySelectorAll('.it-card').forEach((c) => (c.onclick = (ev) => { if (ev.target.closest('button') || ev.target.closest('.it-tile')) return; itemState.focusKind = c.dataset.kind; }));
  bindTiles();

  if (itemState.local) return drawLocalButtons();
  $('#itgo').onclick = () => run(async () => {
    const ids = files.filter((f) => sel.has(f.id) && statusOf(f) !== '받음').map((f) => f.id);
    if (!ids.length) return msg('받을 항목을 고르세요(이미 받은 항목은 건너뜁니다).', true);
    state.plan = files.filter((f) => ids.includes(f.id)); state.planDone = {};
    $('#progress').hidden = false; msg('받는 중… (중간에 끊겨도 다시 누르면 이어받습니다)');
    await invoke('add_items', { url: itemState.url, ids });
    msg('받기를 마쳤습니다. 검색 색인은 백그라운드에서 만드는 중입니다(성경 보기는 바로 쓸 수 있습니다).');
    state.plan = null; await boot(); await loadSources(); await showItems({ files, title: '', origin: '', updated: '', note: '' }, itemState.url);
  });
  $('#itdel').onclick = () => run(async () => {
    const ids = files.filter((f) => sel.has(f.id) && statusOf(f) !== '안 받음').map((f) => f.id);
    if (!ids.length) return msg('삭제할 받은 항목을 고르세요.', true);
    if (!confirm(`${ids.length}개 항목을 지웁니다. 계속할까요?`)) return;
    await invoke('remove_items', { ids });
    msg('지웠습니다.'); await boot(); await loadSources(); await showItems({ files, title: '', origin: '', updated: '', note: '' }, itemState.url);
  });
  $('#ithide').onclick = () => {
    const withKey = files.filter((f) => sel.has(f.id) && itemHiddenKey(f));
    const anyHidden = withKey.some((f) => isHidden(itemHiddenKey(f)));
    for (const f of withKey) setHidden(itemHiddenKey(f), !anyHidden);
    drawItems();
  };
}
// 타일 선택(클릭 토글·Shift 범위), 상자 단축키(⌘/Ctrl+A), 영역 드래그 선택 (모두 #itemsbox 위임)
function bindTiles() {
  const box = $('#itemsbox');
  if (!box || box._bound) return;
  box._bound = true;
  box.addEventListener('click', (ev) => {
    const t = ev.target.closest('.it-tile');
    const ex = ev.target.closest('.it-sexp');
    if (ex) { itemState.expanded = itemState.expanded || {}; itemState.expanded[ex.dataset.sid] = !itemState.expanded[ex.dataset.sid]; drawItems(); return; }
    if (t && !ev.target.closest('.it-hide') && !ev.target.closest('.it-grp')) {
      const id = t.dataset.id, sel = itemState.sel;
      if (ev.shiftKey && itemState.anchorId != null && itemState.anchorId !== id) {
        const a = itemFrontier.indexOf(itemState.anchorId), b = itemFrontier.indexOf(id);
        if (a >= 0 && b >= 0) { const lo = Math.min(a, b), hi = Math.max(a, b), on = allSelected(idsOf(itemState.anchorId)); for (let i = lo; i <= hi; i++) for (const x of idsOf(itemFrontier[i])) on ? sel.delete(x) : sel.add(x); }
      } else if (!ev.shiftKey) { const ids = idsOf(id), on = allSelected(ids); for (const x of ids) on ? sel.delete(x) : sel.add(x); }
      itemState.anchorId = id;
      drawItems();
    }
    const h = ev.target.closest('.it-hide');
    if (h) { setHidden(h.dataset.key, h.dataset.on === '1'); drawItems(); }
  });
  document.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 'a' || ev.key === 'A') && itemState.focusKind) {
      const kind = itemState.focusKind;
      ev.preventDefault();
      const vis = visibleFiles().filter((f) => f.kind === kind);
      const allOn = vis.every((f) => itemState.sel.has(f.id));
      for (const f of vis) allOn ? itemState.sel.delete(f.id) : itemState.sel.add(f.id);
      drawItems();
    }
  });
  // 영역 선택(pointer): 빈 곳에서 드래그 → 직사각형, 걸친 타일 선택(Alt/Option=해제)
  let drag = null;
  box.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    if (ev.target.closest('.it-tile') || ev.target.closest('button') || ev.target.closest('input') || ev.target.closest('select')) return;
    const sc = box.querySelector('.it-scroll');
    const rect = (sc || box).getBoundingClientRect();
    drag = { add: !ev.altKey, moved: false, sx: ev.clientX, sy: ev.clientY, rect, last: new Set() };
    const r = document.createElement('div'); r.className = 'it-rect'; r.id = 'it-rect'; document.body.appendChild(r);
    box.classList.add('dragging');
    ev.preventDefault();
  });
  window.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.abs(ev.clientX - drag.sx) > 4 || Math.abs(ev.clientY - drag.sy) > 4) drag.moved = true;
    if (!drag.moved) return;
    const r = $('#it-rect'); if (!r) return;
    // 사각형은 .it-scroll 좌표 기준으로 고정 위치로 그린다.
    r.style.left = Math.min(ev.clientX, drag.sx) + 'px';
    r.style.top = Math.min(ev.clientY, drag.sy) + 'px';
    r.style.width = Math.abs(ev.clientX - drag.sx) + 'px';
    r.style.height = Math.abs(ev.clientY - drag.sy) + 'px';
    const rx1 = Math.min(ev.clientX, drag.sx), ry1 = Math.min(ev.clientY, drag.sy);
    const rx2 = Math.max(ev.clientX, drag.sx), ry2 = Math.max(ev.clientY, drag.sy);
    const hitIds = new Set();
    box.querySelectorAll('.it-tile').forEach((t) => {
      const tr = t.getBoundingClientRect();
      const hit = !(tr.right < rx1 || tr.left > rx2 || tr.bottom < ry1 || tr.top > ry2);
      const ids = idsOf(t.dataset.id);
      hitIds.add(t.dataset.id);
      if (hit) for (const id of ids) drag.add ? itemState.sel.add(id) : itemState.sel.delete(id);
      t.classList.toggle('on', allSelected(ids));
    });
    // 요약줄 즉시 갱신
    const c = itemState.files.filter((f) => itemState.sel.has(f.id));
    const itsum = $('#itsum');
    if (itsum) itsum.textContent = `${c.length}개 선택 · 받는 용량 ${fmtB(c.reduce((a, f) => a + f.bytes, 0))}`;
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    const r = $('#it-rect'); if (r) r.remove();
    box.classList.remove('dragging');
    drawItems();
  });
}

listen('progress', (ev) => {
  const { label, done, total } = ev.payload;
  $('#progress').hidden = false;
  $('#fill').style.width = (total ? Math.min(100, (done * 100) / total) : 0) + '%';
  const idx = /색인/.test(label);
  $('#ptext').textContent = ` ${label} ${idx ? done.toLocaleString() + ' / ' + total.toLocaleString() + '건' : fmtB(done) + ' / ' + fmtB(total)}`;
  if (state.plan) { state.planDone[label.split(' ')[0]] = Math.max(state.planDone[label.split(' ')[0]] || 0, label.includes('받는 중') ? done : 0); const tot = state.plan.reduce((a, f) => a + f.bytes, 0), got = state.plan.reduce((a, f) => a + Math.min(f.bytes, state.planDone[f.id] || 0), 0); $('#pitems').textContent = `전체 남은 용량 ${fmtB(Math.max(0, tot - got))} (항목 ${state.plan.length}개)`; }
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
  const has = inst.some((i) => i.startsWith('bible') || i.startsWith('orig'));
  if (!has) { state.versions = []; $('#vers').innerHTML = ''; $('#panes').innerHTML = '<p class="muted" style="padding:12px 16px">성경 자료가 없습니다. 「자료 출처」에서 주소를 넣고 받으세요.</p>'; showView('sources'); return; }
  await syncHidden();
  state.books = await invoke('books');
  state.versions = (await invoke('versions')).filter((v) => v.kind !== 'parse' && !isHidden('v:' + v.id));
  restoreView();
  state.vers = state.vers.filter((id) => state.versions.some((v) => v.id === id));
  if (!state.vers.length) { const t = state.versions.filter((v) => v.kind === 'text'); const k = t.find((v) => v.id === '개역개정') || t[0] || state.versions[0]; state.vers = k ? [k.id] : []; }
  $('#book').innerHTML = state.books.map((b) => `<option value="${b.n}">${esc(b.name)}</option>`).join('');
  let g = null, hv = '';
  for (const v of state.versions) { const gg = (v.kind === 'code' ? '원어 번호 본문' : v.file + ' · ' + (v.grp || '')); if (gg !== g) { g = gg; hv += `<div class="g">${esc(g)}</div>`; } hv += `<label title="${esc(v.desc)}"><input type="checkbox" value="${esc(v.id)}" ${state.vers.includes(v.id) ? 'checked' : ''}>${esc(v.name)}</label>`; }
  $('#vers').innerHTML = hv;
  $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`;
  $('#vers').onchange = () => { state.vers = [...document.querySelectorAll('#vers input:checked')].map((i) => i.value); $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`; syncBodyPanels(); saveView(); };
  fillChap();
  const backV = state.curVerse;
  await openChapter(null);
  if (backV != null && backV !== false) selectVerse(backV);
  if (state.view && state.view !== 'bible') showView(state.view);
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
// 장 전체 주석(코어는 v 가 없으면 그 장 전체를 절 순서대로 돌려준다)
async function loadNotesChapter(bk, ch) {
  return invoke('notes', { bk, ch }).catch(() => []);
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
  const side = panel.settings.versLayout === 'side' && vers.length > 1;
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
    // 번역본 표시 방식 토글 줄(여러 번역본일 때만)
    const toggle = vers.length > 1
      ? `<div class="vers-layout"><button type="button" class="${side ? '' : 'on'}" data-vl="stack">위아래</button><button type="button" class="${side ? 'on' : ''}" data-vl="side">나란히</button></div>`
      : '';
    const content = rows.map((r) => {
      const sel = ownSel.has(+r.v);
      return `<div class="vrow ${sel ? 'sel' : ''}${side ? ' side' : ''}" data-v="${r.v}" data-bk="${ref.bk}" data-ch="${ref.ch}"${side ? ` style="--side-cols:${vers.length}"` : ''}>` +
        `<span class="n vnum ${Fmt.value().target.body.vn}">${r.v}</span>` +
        `<div class="t">${r.texts.map((t) => `<span class="tline">${vers.length > 1 ? `<span class="vn">${esc(VNAME()[t.ver] || t.ver)}</span>` : ''}${t.html}</span>`).join('')}</div></div>`;
    }).join('') || '<p class="muted">이 장의 본문이 없습니다.</p>';
    el.innerHTML = toggle + content;
    const vl = el.querySelector('.vers-layout');
    if (vl) vl.onclick = (ev) => {
      const b = ev.target.closest('button[data-vl]');
      if (!b) return;
      panel.settings.versLayout = b.dataset.vl;
      panel.saveSettings();
      renderBody(panel);
    };
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}
function panelByIdLive(id) { return Layout.panelById(id); }

// 주석 한 항목을 화면 조각으로(절 범위 배지를 머리에 붙이고, 선택 절 항목은 왼쪽 색 띠).
function noteHtml(n, current) {
  const band = current ? ' current' : '';
  return `<div class="note${band}"><h4><span class="cr">${esc(noteRange(n))}</span>${n.kind ? `<span class="tag">${esc(n.kind)}</span>` : ''}${esc(n.title)} <span class="muted">${esc(n.ref)}</span></h4><div>${n.html}</div></div>`;
}

// 주석 목록을 대표 1개 / 다른 해설 / 장 단위 개요 3층으로 가른다.
// start_key·end_key = 장*1000+절. 대표는 그 절에서 시작하는 가장 넓은 범위.
function commLayers(notes, ref, chapview) {
  const ch = ref.ch;
  const v = ref.v;
  const key = v ? ch * 1000 + v : null;
  const items = notes.map((n) => {
    const sk = Number.isFinite(n.start_key) ? n.start_key : (n.ch1 || ch) * 1000;
    const ek = Number.isFinite(n.end_key) ? n.end_key : sk;
    const ch1 = Number.isFinite(n.ch1) ? n.ch1 : ch;
    const ch2 = Number.isFinite(n.ch2) ? n.ch2 : ch;
    const r = String(n.ref || '').trim();
    // 여러 장에 걸친 장 단위 단락, 또는 '24장' 같은 장 표기, 서론(키 0)
    const multiChapWhole = ch1 !== ch2 && sk % 1000 === 0 && (ek % 1000 === 0 || ek % 1000 === 999);
    const overview = /^\d+장$/.test(r) || multiChapWhole || (sk === 0 && ek === 0);
    return { n, sk, ek, overview };
  });
  const narrow = (a, b) => (a.ek - a.sk) - (b.ek - b.sk);
  let rep = null;
  if (chapview) {
    const lo = ch * 1000, hi = ch * 1000 + 999;
    const inside = items.filter((x) => x.sk <= lo && x.ek >= hi);
    rep = inside.filter((x) => x.overview).sort(narrow)[0] || inside.sort((a, b) => narrow(b, a))[0] || null;
  } else if (key === null) {
    rep = items.filter((x) => x.overview).sort((a, b) => narrow(b, a))[0] || items[0] || null;
  } else {
    const cover = items.filter((x) => x.sk <= key && x.ek >= key);
    const cand = cover.filter((x) => !x.overview);
    const same = cand.filter((x) => x.sk === key);
    if (same.length) rep = same.sort((a, b) => narrow(b, a))[0];
    else if (cand.length) rep = cand.sort((a, b) => b.sk - a.sk)[0];
    if (!rep) rep = cover.sort(narrow)[0] || null; // 대표가 없으면 가장 좁은 포함 항목
  }
  const rest = items.filter((x) => x !== rep);
  return { rep: rep ? rep.n : null, others: rest.filter((x) => !x.overview).map((x) => x.n), overviews: rest.filter((x) => x.overview).map((x) => x.n) };
}

// 주석 항목의 절 범위 표시("24:10", "24:11-13", "24장 전체"). start_key = 장*1000+절.
function noteRange(n) {
  const sk = Number.isFinite(n.start_key) ? n.start_key : null;
  if (sk == null) return String(n.ref || '');
  const ek = Number.isFinite(n.end_key) ? n.end_key : sk;
  const c1 = Math.floor(sk / 1000), v1 = sk % 1000;
  const c2 = Math.floor(ek / 1000), v2 = ek % 1000;
  if (sk === ek) return v1 ? `${c1}:${v1}` : `${c1}장`;
  if (!v1 && v2 === 999) return `${c1}장 전체`;
  const head = v1 ? `${c1}:${v1}` : `${c1}장`;
  if (c1 !== c2) return `${head}-${v2 ? `${c2}:${v2}` : `${c2}장`}`;
  return `${head}-${v2 === 999 ? '끝' : v2}`;
}

// 절 순서(시작 절 → 끝 절 → 원래 차례)로 정렬한다.
function inVerseOrder(list) {
  return list
    .map((n, i) => ({ n, i, sk: Number.isFinite(n.start_key) ? n.start_key : Infinity, ek: Number.isFinite(n.end_key) ? n.end_key : Infinity }))
    .sort((a, b) => a.sk - b.sk || a.ek - b.ek || a.i - b.i)
    .map((x) => x.n);
}

// 장 전체 보기 한 항목: 머리에 절 범위, 단일절 해설은 그 절의 앵커를 단다.
function commItemHtml(n) {
  const sk = Number.isFinite(n.start_key) ? n.start_key : null;
  const ek = Number.isFinite(n.end_key) ? n.end_key : sk;
  const single = sk != null && ek === sk && sk % 1000 > 0;
  const anchor = single ? ` data-anchor="${sk % 1000}" id="comm-v-${sk % 1000}"` : '';
  return `<div class="note cnote" data-sk="${sk == null ? '' : sk}" data-ek="${ek == null ? '' : ek}"${anchor}>` +
    `<h4><span class="cr">${esc(noteRange(n))}</span>${n.kind ? `<span class="tag">${esc(n.kind)}</span>` : ''}${esc(n.title)}</h4><div>${n.html}</div></div>`;
}

// 선택한 절의 해설 위치로 스크롤하고 잠깐 강조한다(패널 다시 그리지 않음).
function commScroll(panel, ref) {
  const box = panel.body;
  const list = box.querySelector('.comm-list');
  if (!list) return;
  if (ref.v == null) { box.scrollTop = 0; return; }
  const key = ref.ch * 1000 + ref.v;
  const items = [...list.querySelectorAll('.cnote')];
  const sk = (x) => Number(x.dataset.sk), ek = (x) => Number(x.dataset.ek);
  // 정확히 그 절에서 시작하는 항목 → 그 절을 포함하는 항목(가장 가까이 시작한 것) 순서로 찾는다.
  const exact = items.find((x) => sk(x) === key);
  const cover = items.filter((x) => sk(x) <= key && ek(x) >= key).sort((a, b) => sk(b) - sk(a) || ek(a) - ek(b));
  const target = exact || cover[0];
  if (!target) return;
  target.scrollIntoView({ block: 'start' });
  list.querySelectorAll('.cnote.hl').forEach((x) => x.classList.remove('hl')); // 앞서 켜 둔 강조는 끈다
  target.classList.add('hl');
  clearTimeout(panel._hlT);
  panel._hlT = setTimeout(() => target.classList.remove('hl'), 1600);
}

// 지금 화면에 그려 둔 내용이 그대로 쓸 수 있는지 판단하는 빠른 키(구절만 바뀌면 스크롤만 한다).
function commQuickKey(panel, ref) {
  const whole = panel.settings.chapview !== false;
  return [ref.bk, ref.ch, whole ? 'chap' : 'v' + (ref.v == null ? '' : ref.v), panel.settings.multi === true ? 'multi' : 'one', panel.settings.series || ''].join('|');
}

function renderComm(panel) {
  const ref = panelRef(panel);
  const el = panel.body;
  const whole = panel.settings.chapview !== false; // 장 전체 모드가 기본
  // 이미 같은 장·같은 시리즈로 그려 두었으면 다시 그리지 않고 그 절로만 스크롤한다.
  const qk = commQuickKey(panel, ref);
  if (panel._commQk === qk && el.querySelector('.comm-wrap')) { if (whole) commScroll(panel, ref); return; }
  el.innerHTML = '<p class="muted">불러오는 중…</p>';
  Promise.all([whole ? cached(loadNotesChapter, ref.bk, ref.ch) : cached(loadNotes, ref.bk, ref.ch, ref.v), invoke('comm_series').catch(() => [])]).then(([notes, splitInfo]) => {
    if (panel !== panelByIdLive(panel.id)) return;
    if (commQuickKey(panel, panelRef(panel)) !== qk) return; // 그 사이 설정이 바뀌었으면 버린다
    // 이름 → 주석 코드 매핑 후, 숨긴 시리즈(코드 기준)를 걸러낸다.
    const commCode = new Map();
    for (const n of notes) if (!commCode.has(n.comm_name)) commCode.set(n.comm_name, n.comm);
    // 책별로 나눠 받는 시리즈: 이 책을 아직 안 받았어도 탭은 두고 안내 문구를 보여 준다.
    const missing = new Map();
    for (const s of splitInfo || []) if (s.books.includes(ref.bk) && !s.have.includes(ref.bk)) { missing.set(s.name, s); if (!commCode.has(s.name)) commCode.set(s.name, s.id); }
    const missMsg = (name) => { const last = [...name].pop().charCodeAt(0); const josa = last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 ? '은' : '는'; return `<p class="muted comm-miss">이 책의 ${esc(name)}${josa} 받지 않았습니다(자료 출처에서 받기).</p>`; };
    const comms = [...commCode.keys()].filter((name) => !isHidden('s:' + commCode.get(name)));
    let cur = panel.settings.series;
    if (!comms.includes(cur)) cur = comms[0] || null;
    panel.settings.series = cur; panel.saveSettings();
    const multi = panel.settings.multi === true && comms.length > 1;
    const seriesRows = (multi ? comms : [cur]).filter(Boolean);
    const tabs = comms.map((c) => `<button class="${!multi && c === cur ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('') +
      (whole && comms.length > 1 ? `<button class="${multi ? 'on' : ''}" data-multi="1" title="모든 주석을 절 순서대로 이어서 보기">이어 보기</button>` : '');
    const cvBtn = (m, label) => `<button data-cv="${m}" class="${(whole ? m === 'chap' : m === 'verse') ? 'on' : ''}">${label}</button>`;
    const top = `<div class="comm-top"><div class="subtabs">${tabs}</div><div class="cv">${cvBtn('verse', '절')}${cvBtn('chap', '장 전체')}</div></div>`;
    let body = '';
    if (whole) {
      // 장 전체를 절 순서대로 그대로 다 보여준다(접지 않는다). 여러 시리즈면 시리즈마다 이어서.
      body = seriesRows.map((name) => {
        const items = inVerseOrder(notes.filter((n) => n.comm_name === name && !isHidden('s:' + n.comm)));
        const head = multi ? `<div class="csec">${esc(name)}</div>` : '';
        return head + (items.length ? items.map(commItemHtml).join('') : missing.has(name) ? missMsg(name) : '<p class="muted">이 장의 주석이 없습니다.</p>');
      }).join('');
    } else {
      const mine = notes.filter((n) => n.comm_name === cur && !isHidden('s:' + n.comm));
      const { rep, others, overviews } = commLayers(mine, ref, ref.v == null);
      body = rep ? noteHtml(rep, true) : '';
      if (others.length) body += `<details class="note-more"><summary><span class="mo">이 절을 포함한 다른 해설 ${others.length}개</span><span class="mo-sub">${esc(inVerseOrder(others).map(noteRange).join(' · '))}</span></summary>${others.map((n) => noteHtml(n)).join('')}</details>`;
      if (overviews.length) body += `<details class="note-more"><summary><span class="mo">여러 장에 걸친 큰 단락 개요 ${overviews.length}개</span><span class="mo-sub">${esc(inVerseOrder(overviews).map(noteRange).join(' · '))}</span></summary>${overviews.map((n) => noteHtml(n)).join('')}</details>`;
      if (!body) body = missing.has(cur) ? missMsg(cur) : '<span class="muted">이 자리의 주석이 없습니다.</span>';
    }
    if (!body) body = '<p class="muted">이 장의 주석이 없습니다.</p>';
    el.innerHTML = `<div class="comm-wrap">${top}<div class="notes${whole ? ' comm-list' : ''}">${body}</div></div>`;
    el.querySelector('.comm-top').onclick = (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.cv) {
        const want = b.dataset.cv === 'chap';
        if ((panel.settings.chapview !== false) === want) return;
        panel.settings.chapview = want; panel.saveSettings(); panel._commQk = null;
        renderComm(panel);
      } else if (b.dataset.multi) {
        panel.settings.multi = panel.settings.multi !== true; panel.saveSettings(); panel._commQk = null;
        renderComm(panel);
      } else if (b.dataset.c) {
        panel.settings.series = b.dataset.c; panel.saveSettings(); panel._commQk = null;
        Layout.refreshPanelMeta(panel.id); renderComm(panel);
      }
    };
    el.querySelector('.notes').onclick = (ev) => { const a = ev.target.closest('a.sc'); if (a) showLex(a.dataset.c, panel); };
    panel._commQk = qk;
    Layout.refreshPanelMeta(panel.id);
    if (whole) requestAnimationFrame(() => commScroll(panel, panelRef(panel)));
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
    el.onclick = (ev) => { const d = ev.target.closest('.hit'); if (d) openArticleBody(d.dataset.id, d.dataset.t, el, panel); };
  }).catch((x) => { el.innerHTML = `<p class="err">${esc(x)}</p>`; });
}
async function openArticleBody(id, title, el, panel) {
  const body = await invoke('article_body', { id }).catch((x) => `<p class="err">${esc(x)}</p>`);
  el.innerHTML = `<button class="p-btn" id="art-back" title="목록으로">◀ 목록</button><div id="article-title">${esc(title || '')}</div><div class="art-body fmt-body">${body}</div>`;
  const back = el.querySelector('#art-back');
  if (back && panel) back.onclick = () => renderArticlePanel(panel);
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
  const es = (await invoke('lex', { code }).catch(() => [])).filter((e) => !isHidden('d:' + e.dict));
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
  state.curVerse = (focusV != null && focusV !== false) ? focusV : null;
  state.sel.clear(); state.last = null;
  state.panelData = {};
  renderAll();
  saveView();
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
  saveView();
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

// ---- 서식 UI (오른쪽 서랍)
function buildFormatUI() {
  const host = document.createElement('div');
  host.id = 'format-pop';
  host.className = 'format-pop';
  host.hidden = true;
  const ws = document.querySelector('#workspace') || document.body;
  ws.appendChild(host);
  return host;
}

let formatHost = null;
let formatTarget = 'all'; // 'all' | panel id

function fmtOpts(targetId) {
  const f = Fmt.target(targetId);
  const avail = Fmt.availableFonts ? Fmt.availableFonts() : Fmt.FONT_CANDIDATES;
  // 맨 위는 '시스템 기본'(-apple-system). 실제 설치된 글꼴만 나열한다.
  const list = avail.filter((x) => x !== '-apple-system');
  const option = (val, label, cur) => `<option value="${esc(val)}" ${val === cur ? 'selected' : ''}>${esc(label)}</option>`;
  let fonts = option('-apple-system', '시스템 기본', f.font) + list.map((x) => option(x, x, f.font)).join('');
  // 현재값이 목록에 없으면(예: 이전 저장 글꼴이 지금 미설치) 그대로 보여준다.
  if (f.font && !avail.includes(f.font) && f.font !== '-apple-system') fonts = option(f.font, f.font, f.font) + fonts;
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
    // 값이 바뀌면 바로 반영
    const applyPanel = () => {
      panel.settings.useGlobal = body.querySelector('#fp-global').checked;
      panel.settings.fontScale = parseFloat(body.querySelector('#fp-scale').value) || 1;
      panel.settings.maxW = body.querySelector('#fp-maxw').value.trim() || null;
      panel.saveSettings();
      renderAll();
    };
    body.querySelector('#fp-global').onchange = () => {
      const u = body.querySelector('#fp-global').checked;
      body.querySelector('#fp-panel').style.cssText = u ? 'opacity:.5;pointer-events:none' : '';
      applyPanel();
    };
    body.querySelector('#fp-scale').oninput = applyPanel;
    body.querySelector('#fp-maxw').oninput = applyPanel;
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
        <div class="fp-row"><label>절 번호</label><span class="fp-vn">${o.vns}</span></div>`;
      // 값이 바뀌면 바로 반영
      const applyNow = () => {
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
      content.querySelector('.fp-font').onchange = applyNow;
      content.querySelector('.fp-size').oninput = applyNow;
      content.querySelector('.fp-line').oninput = applyNow;
      content.querySelector('.fp-letter').oninput = applyNow;
      content.querySelector('.fp-para').oninput = applyNow;
      content.querySelector('.fp-maxw').oninput = applyNow;
      content.querySelector('.fp-align').onchange = applyNow;
      content.querySelector('.fp-vn input:checked') && (content.querySelector('.fp-vn').onchange = applyNow);
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

$('#format-btn').onclick = () => { if (formatHost && !formatHost.hidden) formatHost.hidden = true; else openFormat(); };
Layout.setOpenPanelFormat(openPanelFormat);

// Esc 로 서식 서랍 닫기
function closeFormat() { if (formatHost) formatHost.hidden = true; }
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && formatHost && !formatHost.hidden) closeFormat(); });

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

// ---- 단축키: ⌘L 구절 이동, ⌘F 검색 탭, ⌘1~4 탭 전환, ←/→ 이전·다음 장
function editingFocus() {
  const a = document.activeElement;
  return a && (a.matches('input,textarea,select') || a.isContentEditable);
}
window.addEventListener('keydown', (ev) => {
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod) {
    const k = ev.key.toLowerCase();
    if (k === 'l') { ev.preventDefault(); showView('bible'); $('#goto').focus(); $('#goto').select(); return; }
    if (k === 'f') { ev.preventDefault(); showView('search'); $('#q').focus(); $('#q').select(); return; }
    if (/^[1-4]$/.test(ev.key)) {
      ev.preventDefault();
      const v = { '1': 'bible', '2': 'search', '3': 'articles', '4': 'sources' }[ev.key];
      showView(v);
      return;
    }
    return;
  }
  // ←/→: 입력 칸에 초점이 없을 때만 이전·다음 장
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
    if (editingFocus()) return;
    if (state.view !== 'bible') return;
    ev.preventDefault();
    if (ev.key === 'ArrowLeft') $('#prev').click(); else $('#next').click();
  }
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
  renderSearchHits($('#results'), hits, q, area);
}
$('#dosearch').onclick = doSearch;
$('#q').addEventListener('keydown', (ev) => ev.key === 'Enter' && doSearch());

// ---- 검색 결과 화면: 검색어 강조(서식 강조색)·책별 건수·책으로 거르기·빈 결과 안내
// 검색어를 여러 낱말로 나눠 부분 일치도 강조한다(정규식 특수문자는 문자로).
function hlWords(text, q) {
  let html = esc(text).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>'); // 백엔드가 [..] 로 표시한 일치 구간
  const words = String(q || '').trim().split(/\s+/).filter((w) => w.length > 1);
  if (!words.length) return html;
  // 이미 <mark> 안은 건너뛰고 텍스트 부분만 다시 강조한다.
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  return html.replace(/(<mark>.*?<\/mark>)|([\s\S]*?)(?=<mark>|<\/mark>|$)/g, (m, mark, txt) => {
    if (mark) return mark;
    return txt.replace(re, (s) => `<mark>${s}</mark>`);
  });
}
function bookSummary(hits) {
  const m = new Map();
  for (const h of hits) {
    if (h.area === 'article') { const k = '소논문'; m.set(k, (m.get(k) || 0) + 1); continue; }
    const name = bookName(h.bk);
    m.set(name, (m.get(name) || 0) + 1);
  }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}
function renderSearchHits(container, hits, q, area) {
  container.textContent = '';
  const vname = VNAME();
  if (!hits.length) {
    container.innerHTML = `<div class="sr-empty"><p>결과가 없습니다.</p><p class="muted">다른 검색어로 다시 시도하거나, 검색 범위를 바꿔 보세요.</p></div>`;
    return;
  }
  const summary = bookSummary(hits);
  const bookBtns = `<button class="sr-filter on" data-filter="__all">전체 ${hits.length}</button>` +
    summary.map(([name, n]) => `<button class="sr-filter" data-filter="${esc(name)}">${esc(name)} ${n}</button>`).join('');
  container.innerHTML = `<div class="sr-summary mutable">${esc(summary.map(([name, n]) => `${name} ${n}건`).join(' · '))}</div>` +
    `<div class="sr-filter-bar">${bookBtns}</div><div class="sr-list"></div>`;
  const list = container.querySelector('.sr-list');
  const draw = (filter) => {
    const show = hits.filter((h) => filter === '__all' || (h.area === 'article' ? '소논문' : bookName(h.bk)) === filter);
    const frag = document.createDocumentFragment();
    hits.forEach((h, i) => {
      if (filter !== '__all' && (h.area === 'article' ? '소논문' : bookName(h.bk)) !== filter) return;
      const d = document.createElement('div');
      d.className = 'hit';
      d.dataset.i = i; d.dataset.bk = h.area === 'article' ? '' : String(h.bk);
      d.innerHTML = `<b>${h.area === 'article' ? '소논문 ' + esc(h.ref_) : esc(bookName(h.bk)) + ' ' + h.ch + (h.v ? ':' + h.v : '')}</b> <span class="tag">${esc(h.area === 'bible' ? vname[h.src] || h.src : h.src)}</span><div>${hlWords(h.snippet, q)}</div>`;
      frag.appendChild(d);
    });
    list.innerHTML = ''; list.appendChild(frag);
  };
  draw('__all');
  container.querySelector('.sr-filter-bar').onclick = (ev) => {
    const b = ev.target.closest('.sr-filter'); if (!b) return;
    container.querySelectorAll('.sr-filter').forEach((x) => x.classList.toggle('on', x === b));
    draw(b.dataset.filter);
  };
  list.onclick = (ev) => {
    const d = ev.target.closest('.hit'); if (!d) return;
    const h = hits[+d.dataset.i];
    if (h.area === 'article') { showView('articles'); openArticle(h.note_id, h.ref_); return; }
    state.bk = h.bk || state.bk; state.ch = h.ch || 1; showView('bible'); openChapter(h.v || null);
  };
  void area;
}

// ---- 소논문 (좌측 목록, 우측 본문)
let _articles = [];
let _articleSel = null;
async function loadArticles() {
  _articles = await invoke('articles').catch(() => []);
  const listEl = $('#articlelist');
  listEl.innerHTML = _articles.length ? _articles.map((a) => `<div class="hit" data-id="${a.id}" data-t="${esc(a.title)}" data-src="${esc(a.src_name)}" data-sec="${esc(a.section)}" data-chars="${a.chars}"><b>${esc(a.title)}</b> <span class="tag">${esc(a.src_name)}</span> <span class="muted">${esc(a.section)} · ${a.chars.toLocaleString()}자</span></div>`).join('') : '<p class="muted">소논문 자료가 없습니다. 「자료 출처」에서 주석·소논문 자료를 받으면 이곳에 목록이 나옵니다.</p>';
  listEl.querySelectorAll('.hit').forEach((h) => h.classList.toggle('sel', +h.dataset.id === _articleSel));
}
$('#articlelist').addEventListener('click', (ev) => { const d = ev.target.closest('.hit'); if (d) openArticle(+d.dataset.id, d.dataset.t, { src: d.dataset.src, sec: d.dataset.sec, chars: +d.dataset.chars }); });
async function openArticle(id, title, meta) {
  _articleSel = id;
  const listEl = $('#articlelist');
  listEl.querySelectorAll('.hit').forEach((h) => h.classList.toggle('sel', +h.dataset.id === id));
  const body = await invoke('article_body', { id }).catch((x) => `<p class="err">${esc(x)}</p>`);
  const metaHtml = meta ? `<div id="article-meta">${esc(meta.src || '')}${meta.sec ? ' · ' + esc(meta.sec) : ''}${meta.chars ? ' · ' + meta.chars.toLocaleString() + '자' : ''}</div>` : '';
  $('#articlebody').innerHTML = `<div id="article-title">${esc(title || '')}</div>${metaHtml}<div class="art-body fmt-body">${body}</div>`;
}


// ---- 주석 패널의 '장 전체' 보기에만 쓰는 작은 스타일(화면 파일 하나로 끝내려고 여기서 넣는다)
(function injectCommStyle() {
  const st = document.createElement('style');
  st.textContent = [
    // 패널 본문(.p-body, overflow:auto)이 스크롤 컨테이너이므로 그 기준으로 상단에 붙인다.
    // 위아래 여백을 본문 padding(8px 12px)만큼 음수로 당겨 스크롤한 내용이 옆·위로 비치지 않게 한다.
    '.comm-top{position:sticky;top:-8px;z-index:2;display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:-8px -12px 6px;padding:8px 12px 6px;background:var(--bg);border-bottom:1px solid var(--line)}',
    '.comm-top .subtabs{flex:1;margin:0}',
    '.comm-top .cv{display:flex;flex:none}',
    '.comm-top .cv button{font-size:12px;padding:1px 8px;border-radius:0}',
    '.comm-top .cv button:first-child{border-radius:6px 0 0 6px}',
    '.comm-top .cv button:last-child{border-radius:0 6px 6px 0;border-left:none}',
    '.cnote{scroll-margin-top:46px;padding-left:8px;border-left:3px solid transparent}',
    '.cr{display:inline-block;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;font-weight:600;color:var(--acc);border:1px solid var(--line);border-radius:4px;padding:0 6px;margin-right:7px;background:var(--bg)}',
    '.cnote .cr{color:var(--acc)}',
    '.cnote.hl{border-left:3px solid var(--acc);background:var(--sel);transition:background .3s,border-color .3s}',
    '.csec{font-weight:600;color:var(--acc);margin:10px 0 2px;padding-top:6px;border-top:1px solid var(--line)}',
    // 절 모드: 선택 절의 대표 항목은 왼쪽 색 띠 + 살짝 배경, 접힌 묶음은 한 줄 요약처럼
    '.note.current{border-left:3px solid var(--acc);padding-left:10px;background:var(--sel);border-radius:0 6px 6px 0;margin-left:-3px}',
    '.note.current .cr{font-weight:700}',
    'details.note-more{display:flex;flex-direction:column;border-top:1px solid var(--line);padding:4px 0;margin-top:2px}',
    'details.note-more>summary{list-style:none;cursor:pointer;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}',
    'details.note-more>summary::-webkit-details-marker{display:none}',
    'details.note-more>summary::before{content:"▸";font-size:12px;color:var(--acc);flex:none}',
    'details.note-more[open]>summary::before{content:"▾"}',
    'details.note-more>summary .mo{color:var(--acc);font-weight:600}',
    'details.note-more>summary .mo-sub{color:var(--mut);font-size:12px;font-family:ui-monospace,Menlo,Consolas,monospace}',
    'details.note-more .note{margin-left:6px}',
  ].join('\n');
  document.head.appendChild(st);
})();

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
