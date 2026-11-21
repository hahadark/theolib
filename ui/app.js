const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (s) => document.querySelector(s);
const state = { books: [], versions: [], vers: [], bk: 44, ch: 1, sel: new Set(), last: null, notes: [], comm: null, rows: [], url: null };
const fmtB = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.ceil(n / 1024) + ' KB');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bookName = (n) => (state.books.find((b) => b.n === n) || {}).name || n;

// ---- 탭 전환
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => showView(b.dataset.view)));
function showView(v) {
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
  document.querySelectorAll('main > section').forEach((s) => (s.hidden = s.id !== 'view-' + v));
  if (v === 'sources') loadSources();
  if (v === 'articles') loadArticles();
  if (v === 'search') idxNote();
}

// ---- 자료 출처
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
const KORD = { bible: 0, code: 1, lex: 2, comm: 3 };
const GORD = { '한국어': 0, '영어': 1, '원어': 2, '외국어': 3 };
const DEFAULT_NAMES = ['개역개정', '개역한글', '새번역', 'ESV', 'NIV2011', 'KJV1769'];
const itemState = { url: null, files: [], sel: new Set(), sort: 'default', dir: 1, q: '', installed: [] };
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

// ---- 항목별 받기: 한 목록, 정렬·거르기·분류별 선택
async function showItems(d, url) {
  d.files = (d.files || []).filter((f) => !f.skip);
  $('#srcpreview').innerHTML = `<div class="note"><b>${esc(d.title || d.origin || '자료 출처')}</b> <span class="muted">${esc(d.origin)}</span><div class="muted">${esc(d.updated)} ${esc(d.note)}</div>${(d.links || []).map((l) => `<div><span>${esc(l.title || l.url)}</span> <button data-link="${esc(l.url)}">추가</button></div>`).join('')}</div>`;
  $('#srcpreview').querySelectorAll('button[data-link]').forEach((b) => (b.onclick = () => run(async () => previewUrl(b.dataset.link))));
  const src = await invoke('sources');
  itemState.installed = src.length ? src[0].items || [] : [];
  itemState.local = false; itemState.url = url; itemState.files = d.files; itemState.q = ''; itemState.sort = 'default'; itemState.dir = 1;
  itemState.sel = new Set(d.files.filter((f) => (f.kind === 'bible' ? DEFAULT_NAMES.includes(f.name) : true) && statusOf(f) !== '받음').map((f) => f.id));
  drawItems();
}
function statusOf(f) {
  if (itemState.local) return itemState.installed.some((x) => x.id === f.id) ? '받음' : '안 받음'; const r = itemState.installed.find((x) => x.id === f.id); return !r ? '안 받음' : r.sha256 === f.sha256 ? '받음' : '새 판 있음'; }
function drawItems() {
  const { files, sel, sort, dir, q } = itemState;
  const cmp = {
    default: (a, b) => (KORD[a.kind] ?? 9) - (KORD[b.kind] ?? 9) || (GORD[a.grp] ?? 9) - (GORD[b.grp] ?? 9) || a.name.localeCompare(b.name, 'ko'),
    name: (a, b) => a.name.localeCompare(b.name, 'ko'), grp: (a, b) => (KIND[a.kind] + a.grp).localeCompare(KIND[b.kind] + b.grp, 'ko'),
    bytes: (a, b) => a.bytes - b.bytes, status: (a, b) => statusOf(a).localeCompare(statusOf(b), 'ko'),
    sel: (a, b) => Number(sel.has(b.id)) - Number(sel.has(a.id)),
  }[sort];
  const ql = q.trim().toLowerCase();
  const rows = files.filter((f) => !ql || (f.name + ' ' + f.grp + ' ' + (KIND[f.kind] || '') + ' ' + (f.license || '')).toLowerCase().includes(ql)).sort((a, b) => dir * cmp(a, b));
  const groups = [...new Set(files.map((f) => f.kind + '|' + f.grp))];
  const gbtn = groups.map((g) => { const [k, gr] = g.split('|'); return `<span class="gsel">${esc(KIND[k] || k)}·${esc(gr)} <a href="#" data-g="${esc(g)}" data-on="1">모두 선택</a>/<a href="#" data-g="${esc(g)}" data-on="0">해제</a></span>`; }).join(' ');
  const chosen = files.filter((f) => sel.has(f.id));
  const total = chosen.reduce((a, f) => a + f.bytes, 0);
  $('#itemsbox').innerHTML = `<div class="bar"><input id="itq" placeholder="이름·분류·근거로 거르기" size="30" value="${esc(q)}"> <span class="muted">${rows.length}/${files.length}항목</span></div><div class="muted">${gbtn}</div>
  <div class="itemscroll"><table class="items"><tr><th data-s="sel">선택</th><th data-s="name">이름</th><th data-s="grp">분류</th><th data-s="bytes">크기</th><th data-s="status">상태</th><th>근거</th></tr>${rows.map((f) => `<tr><td><input type="checkbox" data-id="${esc(f.id)}" ${sel.has(f.id) ? 'checked' : ''}></td><td>${esc(f.name)}</td><td>${esc(KIND[f.kind] || f.kind)}·${itemState.local && f.kind === 'bible' ? `<select data-grp="${esc(f.id)}">${['한국어', '영어', '원어', '외국어'].map((g) => `<option ${g === f.grp ? 'selected' : ''}>${g}</option>`).join('')}</select>` : esc(f.grp)}</td><td>${fmtB(f.bytes)}</td><td>${statusOf(f)}</td><td class="muted">${esc(f.license || '')}</td></tr>`).join('')}</table></div>
  <div class="bar"><b id="itsum">${chosen.length}개 선택 · 받는 용량 ${fmtB(total)}</b> <button id="itgo">선택한 항목 받기</button> <button id="itdel">선택한 항목 삭제(받은 것만)</button></div>`;
  const qi = $('#itq'); qi.oninput = () => { itemState.q = qi.value; drawItems(); const n = $('#itq'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); };
  $('#itemsbox').querySelectorAll('th[data-s]').forEach((th) => (th.onclick = () => { if (itemState.sort === th.dataset.s) itemState.dir *= -1; else { itemState.sort = th.dataset.s; itemState.dir = 1; } drawItems(); }));
  $('#itemsbox').querySelectorAll('input[data-id]').forEach((c) => (c.onchange = () => { c.checked ? sel.add(c.dataset.id) : sel.delete(c.dataset.id); drawItems(); }));
  $('#itemsbox').querySelectorAll('a[data-g]').forEach((a) => (a.onclick = (ev) => { ev.preventDefault(); for (const f of files) if (f.kind + '|' + f.grp === a.dataset.g) a.dataset.on === '1' ? sel.add(f.id) : sel.delete(f.id); drawItems(); }));
  $('#itemsbox').querySelectorAll('select[data-grp]').forEach((s) => (s.onchange = () => { const f = files.find((x) => x.id === s.dataset.grp); if (f) f.grp = s.value; }));
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

// ---- 성경 보기
async function boot() {
  const list = await invoke('sources');
  const inst = list.length ? list[0].installed : [];
  const has = inst.some((i) => i.startsWith('bible') || i.startsWith('orig'));
  if (!has) { state.versions = []; $('#vers').innerHTML = ''; $('#text').innerHTML = '<p class="muted">성경 자료가 없습니다. 「자료 출처」에서 주소를 넣고 받으세요.</p>'; showView('sources'); return; }
  state.books = await invoke('books');
  state.versions = (await invoke('versions')).filter((v) => v.kind !== 'parse');
  state.vers = state.vers.filter((id) => state.versions.some((v) => v.id === id));
  if (!state.vers.length) { const t = state.versions.filter((v) => v.kind === 'text'); const k = t.find((v) => v.id === '개역개정') || t[0] || state.versions[0]; state.vers = k ? [k.id] : []; }
  $('#book').innerHTML = state.books.map((b) => `<option value="${b.n}">${esc(b.name)}</option>`).join('');
  let g = null, hv = '';
  for (const v of state.versions) { const gg = (v.kind === 'code' ? '원어 번호 본문' : v.file + ' · ' + (v.grp || '')); if (gg !== g) { g = gg; hv += `<div class="g">${esc(g)}</div>`; } hv += `<label title="${esc(v.desc)}"><input type="checkbox" value="${esc(v.id)}" ${state.vers.includes(v.id) ? 'checked' : ''}>${esc(v.name)}</label>`; }
  $('#vers').innerHTML = hv;
  $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`;
  $('#vers').onchange = () => { state.vers = [...document.querySelectorAll('#vers input:checked')].map((i) => i.value); $('#vers-sum').textContent = `번역본 (${state.versions.length}종 중 ${state.vers.length}개)`; openChapter(); };
  await openChapter();
}
function fillChap() {
  const b = state.books.find((x) => x.n === state.bk);
  $('#chap').innerHTML = Array.from({ length: b ? b.ch : 1 }, (_, i) => `<option value="${i + 1}">${i + 1}장</option>`).join('');
  $('#book').value = state.bk; $('#chap').value = state.ch;
}
async function openChapter(focusV) {
  fillChap();
  if (!state.vers.length) { $('#text').innerHTML = '<p class="muted">번역본을 하나 이상 고르세요.</p>'; return; }
  let rows = [];
  try { rows = await invoke('chapter', { bk: state.bk, ch: state.ch, vers: state.vers }); } catch (x) { $('#text').innerHTML = `<p class="err">${esc(x)}</p>`; return; }
  state.rows = rows;
  const vname = Object.fromEntries(state.versions.map((v) => [v.id, v.name]));
  $('#text').innerHTML = rows.map((r) => `<div class="vrow" data-v="${r.v}"><span class="n">${r.v}</span><div class="t">${r.texts.map((t) => `<div>${state.vers.length > 1 ? `<span class="vn">${esc(vname[t.ver] || t.ver)}</span>` : ''}${t.html}</div>`).join('')}</div></div>`).join('') || '<p class="muted">이 장의 본문이 없습니다. (고른 번역본에 이 장이 없을 수 있습니다)</p>';
  state.sel.clear(); state.last = null;
  if (focusV) selectVerse(focusV, false);
  else { $('#text').scrollTop = 0; await showChapterNotes(); }
}
async function showChapterNotes() {
  document.querySelectorAll('.vrow').forEach((r) => r.classList.remove('sel'));
  $('#side-head').textContent = `${bookName(state.bk)} ${state.ch}장 전체`; $('#whole').hidden = true;
  $('#parse').innerHTML = ''; $('#lexbox').innerHTML = '';
  state.notes = await invoke('notes', { bk: state.bk, ch: state.ch, v: null }).catch(() => []);
  pickComm(); renderNotes();
}
function pickComm() { const comms = [...new Set(state.notes.map((n) => n.comm_name))]; if (!comms.includes(state.comm)) state.comm = comms[0] || null; }
$('#whole').onclick = () => showChapterNotes();
$('#book').onchange = () => { state.bk = +$('#book').value; state.ch = 1; openChapter(); };
$('#chap').onchange = () => { state.ch = +$('#chap').value; openChapter(); };
$('#prev').onclick = () => { if (state.ch > 1) { state.ch--; openChapter(); } };
$('#next').onclick = () => { const b = state.books.find((x) => x.n === state.bk); if (b && state.ch < b.ch) { state.ch++; openChapter(); } };

$('#text').addEventListener('click', (ev) => {
  const a = ev.target.closest('a.sc');
  if (a) { showLex(a.dataset.c); return; }
  const row = ev.target.closest('.vrow');
  if (row) selectVerse(+row.dataset.v, ev.shiftKey);
});
async function selectVerse(v, extend) {
  if (extend && state.last) { state.sel.clear(); for (let i = Math.min(v, state.last); i <= Math.max(v, state.last); i++) state.sel.add(i); }
  else { state.sel = new Set([v]); state.last = v; }
  document.querySelectorAll('.vrow').forEach((r) => r.classList.toggle('sel', state.sel.has(+r.dataset.v)));
  const el = document.querySelector(`.vrow[data-v="${v}"]`); if (el) el.scrollIntoView({ block: 'nearest' });
  $('#side-head').textContent = `${bookName(state.bk)} ${state.ch}:${v}`; $('#whole').hidden = false;
  state.notes = await invoke('notes', { bk: state.bk, ch: state.ch, v }).catch(() => []);
  pickComm(); renderNotes();
  const words = await invoke('parse', { bk: state.bk, ch: state.ch, v }).catch(() => []);
  $('#parse').innerHTML = words.length ? '<table class="parse"><tr><th>원어</th><th>번호</th><th>원형</th><th>음역</th><th>문법</th><th>뜻</th></tr>' + words.map((w) => `<tr data-c="${esc(w.code)}"><td>${esc(w.w)}</td><td>${esc(w.code)}</td><td>${esc(w.lemma)}</td><td>${esc(w.tr)}</td><td>${esc(w.parse)}</td><td>${esc(w.gloss)}</td></tr>`).join('') + '</table>' : '<span class="muted">원전 분해 자료가 없습니다.</span>';
}
$('#parse').addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-c]'); if (tr && tr.dataset.c) showLex(tr.dataset.c); });
function renderNotes() {
  const comms = [...new Set(state.notes.map((n) => n.comm_name))];
  $('#comm-tabs').innerHTML = comms.map((c) => `<button class="${c === state.comm ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('') || '<span class="muted">이 자리의 주석이 없습니다.</span>';
  $('#notes').innerHTML = state.notes.filter((n) => n.comm_name === state.comm).map((n) => `<div class="note"><h4>${n.kind ? `<span class="tag">${esc(n.kind)}</span>` : ''}${esc(n.title)} <span class="muted">${esc(n.ref)}</span></h4><div>${n.html}</div></div>`).join('');
}
$('#comm-tabs').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { state.comm = b.dataset.c; renderNotes(); } });
$('#notes').addEventListener('click', (ev) => { const a = ev.target.closest('a.sc'); if (a) showLex(a.dataset.c); });
async function showLex(code) {
  const es = await invoke('lex', { code }).catch(() => []);
  $('#lexbox').innerHTML = es.length ? es.map((e) => `<div class="lex"><b>${esc(e.code)} ${esc(e.head)}</b> <span class="tag">${esc(e.dict === 'HebGrkKo' ? '한글 원어사전' : e.dict === 'HebGrkEn' ? '영어 원어사전' : e.dict)}</span><div>${e.html}</div></div>`).join('') : `<div class="lex muted">${esc(code)}: 사전에 이 낱말이 없습니다.</div>`;
  $('#lexbox').scrollIntoView({ block: 'nearest' });
}

// ---- 인용 복사 (2,000자 제한)
$('#cite').onclick = async () => {
  if (!state.sel.size) return alert('복사할 절을 누르세요. (Shift+누르기로 범위 선택)');
  const vs = [...state.sel].sort((a, b) => a - b);
  const first = state.vers[0];
  const vname = (state.versions.find((v) => v.id === first) || {}).name || first;
  const tmp = document.createElement('div');
  let text = vs.map((v) => { const r = state.rows.find((x) => x.v === v); const t = r && (r.texts.find((x) => x.ver === first) || r.texts[0]); tmp.innerHTML = t ? t.html : ''; return `${v} ${tmp.textContent.trim()}`; }).join('\n');
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
  const vname = Object.fromEntries(state.versions.map((v) => [v.id, v.name]));
  $('#results').innerHTML = (hits.length ? '' : '<p class="muted">결과가 없습니다.</p>') + hits.map((h, i) => `<div class="hit" data-i="${i}"><b>${h.area === 'article' ? '소논문 ' + esc(h.ref_) : esc(bookName(h.bk)) + ' ' + h.ch + (h.v ? ':' + h.v : '')}</b> <span class="tag">${esc(h.area === 'bible' ? vname[h.src] || h.src : h.src)}</span><div>${esc(h.snippet).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>')}</div></div>`).join('');
  $('#results').onclick = (ev) => { const d = ev.target.closest('.hit'); if (!d) return; const h = hits[+d.dataset.i]; if (h.area === 'article') { showView('articles'); openArticle(h.note_id, h.ref_); return; } state.bk = h.bk || state.bk; state.ch = h.ch || 1; showView('bible'); openChapter(h.v || null); };
}
$('#dosearch').onclick = doSearch;
$('#q').addEventListener('keydown', (ev) => ev.key === 'Enter' && doSearch());

// ---- 소논문
async function loadArticles() {
  const list = await invoke('articles').catch(() => []);
  $('#articlelist').innerHTML = list.length ? list.map((a) => `<div class="hit" data-id="${a.id}" data-t="${esc(a.title)}"><b>${esc(a.title)}</b> <span class="tag">${esc(a.src_name)}</span> <span class="muted">${esc(a.section)} · ${a.chars.toLocaleString()}자</span></div>`).join('') : '<p class="muted">소논문 자료가 없습니다.</p>';
}
$('#articlelist').addEventListener('click', (ev) => { const d = ev.target.closest('.hit'); if (d) openArticle(+d.dataset.id, d.dataset.t); });
async function openArticle(id, title) {
  const body = await invoke('article_body', { id }).catch((x) => `<p class="err">${esc(x)}</p>`);
  $('#articlebody').innerHTML = `<div id="article-title">${esc(title || '')}</div>${body}`;
}

boot();
