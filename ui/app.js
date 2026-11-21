const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (s) => document.querySelector(s);
const state = { sid: null, books: [], versions: [], vers: [], bk: 44, ch: 1, sel: new Set(), last: null, notes: [], comm: null, rows: [], url: null };
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
}

// ---- 자료 출처
async function loadSources() {
  const list = await invoke('sources');
  const box = $('#srclist');
  box.innerHTML = list.length ? '' : '<p class="muted">설치된 출처가 없습니다.</p>';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'note';
    d.innerHTML = `<b>${esc(s.decl.title)}</b><div class="muted">${esc(s.decl.scope)} · 받은 파일: ${esc(s.installed.join(', '))}</div><div class="muted">${esc(s.decl.notice)}</div>`;
    const sync = Object.assign(document.createElement('button'), { textContent: '갱신 확인' });
    const rm = Object.assign(document.createElement('button'), { textContent: '삭제' });
    sync.onclick = async () => run(async () => { const u = await invoke('sync_source', { sid: s.decl.id }); msg(u.length ? '갱신: ' + u.join(', ') : '바뀐 파일이 없습니다.'); await boot(); });
    rm.onclick = async () => { if (!confirm('이 출처의 받은 자료와 검색 색인을 모두 지웁니다. 계속할까요?')) return; await run(async () => { await invoke('remove_source', { sid: s.decl.id }); msg('지웠습니다.'); await boot(); loadSources(); }); };
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
  const d = await invoke('preview_source', { url });
  state.url = url;
  const p = $('#srcpreview');
  p.innerHTML = `<div class="note"><b>${esc(d.title)}</b><div class="muted">${esc(d.scope)}</div><div class="muted">${esc(d.notice)}</div></div>`;
  const names = { bible: '성경 번역본·원어 번호 본문', orig: '원전 분해·원어 사전', comm: '주석·소논문' };
  for (const f of d.files) {
    const l = document.createElement('label');
    l.className = 'file';
    l.innerHTML = `<input type="checkbox" checked value="${esc(f.id)}"> <span>${esc(names[f.id] || f.id)} (${esc(f.id)})</span> <span class="muted">${fmtB(f.bytes)} 받기 · 풀면 ${fmtB(f.db_bytes)}</span>`;
    p.append(l);
  }
  const go = Object.assign(document.createElement('button'), { textContent: '받기' });
  go.onclick = () => run(async () => {
    const files = [...p.querySelectorAll('input:checked')].map((i) => i.value);
    if (!files.length) return msg('받을 파일을 고르세요.', true);
    $('#progress').hidden = false;
    msg('받는 중…');
    await invoke('add_source', { url: state.url, files });
    $('#srcurl').value = ''; state.url = null; p.innerHTML = '';
    msg('완료했습니다.');
    await boot(); loadSources();
  });
  p.append(go);
});
listen('progress', (ev) => {
  const { file, done, total } = ev.payload;
  $('#fill').style.width = (total ? Math.min(100, (done * 100) / total) : 0) + '%';
  $('#ptext').textContent = ` ${file} ${fmtB(done)} / ${fmtB(total)}`;
});

// ---- 성경 보기
async function boot() {
  const list = await invoke('sources');
  state.sid = list.length ? list[0].decl.id : null;
  const has = list.length && list[0].installed.includes('bible');
  if (!has) { $('#text').innerHTML = '<p class="muted">성경 자료가 없습니다. 「자료 출처」에서 주소를 넣고 받으세요.</p>'; showView(list.length ? 'bible' : 'sources'); return; }
  state.books = await invoke('books', { sid: state.sid });
  state.versions = await invoke('versions', { sid: state.sid });
  if (!state.vers.length) { const t = state.versions.filter((v) => v.kind === 'text'); const k = t.find((v) => v.id === '개역개정') || t[0]; state.vers = k ? [k.id] : []; }
  $('#book').innerHTML = state.books.map((b) => `<option value="${b.n}">${esc(b.name)}</option>`).join('');
  $('#vers').innerHTML = state.versions.map((v) => `<label title="${esc(v.desc)}"><input type="checkbox" value="${esc(v.id)}" ${state.vers.includes(v.id) ? 'checked' : ''}>${esc(v.name)}</label>`).join('');
  $('#vers').onchange = () => { state.vers = [...document.querySelectorAll('#vers input:checked')].map((i) => i.value); openChapter(); };
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
  try { rows = await invoke('chapter', { sid: state.sid, bk: state.bk, ch: state.ch, vers: state.vers }); } catch (x) { $('#text').innerHTML = `<p class="err">${esc(x)}</p>`; return; }
  state.rows = rows;
  const vname = Object.fromEntries(state.versions.map((v) => [v.id, v.name]));
  $('#text').innerHTML = rows.map((r) => `<div class="vrow" data-v="${r.v}"><span class="n">${r.v}</span><div class="t">${r.texts.map((t) => `<div>${state.vers.length > 1 ? `<span class="vn">${esc(vname[t.ver] || t.ver)}</span>` : ''}${t.html}</div>`).join('')}</div></div>`).join('') || '<p class="muted">이 장의 본문이 없습니다. (견본은 사도행전만 있습니다)</p>';
  state.sel.clear();
  if (focusV) selectVerse(focusV, false);
  else { $('#text').scrollTop = 0; clearSide(); }
}
function clearSide() { $('#side-head').textContent = '절을 누르면 주석이 나옵니다.'; $('#notes').innerHTML = ''; $('#comm-tabs').innerHTML = ''; $('#parse').innerHTML = ''; $('#lexbox').innerHTML = ''; }
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
  $('#side-head').textContent = `${bookName(state.bk)} ${state.ch}:${v}`;
  state.notes = await invoke('notes', { sid: state.sid, bk: state.bk, ch: state.ch, v }).catch(() => []);
  const comms = [...new Set(state.notes.map((n) => n.comm_name))];
  if (!comms.includes(state.comm)) state.comm = comms[0] || null;
  renderNotes();
  const words = await invoke('parse', { sid: state.sid, bk: state.bk, ch: state.ch, v }).catch(() => []);
  $('#parse').innerHTML = words.length ? '<table class="parse"><tr><th>원어</th><th>번호</th><th>원형</th><th>음역</th><th>문법</th><th>뜻</th></tr>' + words.map((w) => `<tr data-c="${esc(w.code)}"><td>${esc(w.w)}</td><td>${esc(w.code)}</td><td>${esc(w.lemma)}</td><td>${esc(w.tr)}</td><td>${esc(w.parse)}</td><td>${esc(w.gloss)}</td></tr>`).join('') + '</table>' : '<span class="muted">원전 분해 자료가 없습니다.</span>';
}
$('#parse').addEventListener('click', (ev) => { const tr = ev.target.closest('tr[data-c]'); if (tr && tr.dataset.c) showLex(tr.dataset.c); });
function renderNotes() {
  const comms = [...new Set(state.notes.map((n) => n.comm_name))];
  $('#comm-tabs').innerHTML = comms.map((c) => `<button class="${c === state.comm ? 'on' : ''}" data-c="${esc(c)}">${esc(c)}</button>`).join('') || '<span class="muted">이 구절의 주석이 없습니다.</span>';
  $('#notes').innerHTML = state.notes.filter((n) => n.comm_name === state.comm).map((n) => `<div class="note"><h4>${n.kind ? `<span class="tag">${esc(n.kind)}</span>` : ''}${esc(n.title)} <span class="muted">${esc(n.ref)}</span></h4><div>${n.html}</div></div>`).join('');
}
$('#comm-tabs').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { state.comm = b.dataset.c; renderNotes(); } });
$('#notes').addEventListener('click', (ev) => { const a = ev.target.closest('a.sc'); if (a) showLex(a.dataset.c); });
async function showLex(code) {
  const es = await invoke('lex', { sid: state.sid, code }).catch(() => []);
  $('#lexbox').innerHTML = es.length ? es.map((e) => `<div class="lex"><b>${esc(e.code)} ${esc(e.head)}</b> <span class="tag">${esc(e.dict)}</span><div>${e.html}</div></div>`).join('') : `<div class="lex muted">${esc(code)}: 견본 사전에 이 낱말이 없습니다.</div>`;
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
  if (!state.sid) return false;
  const r = await invoke('goto_ref', { sid: state.sid, input });
  if (!r) return false;
  [state.bk, state.ch] = r; showView('bible'); await openChapter(r[2] || null); return true;
}
$('#goto').addEventListener('keydown', async (ev) => { if (ev.key === 'Enter' && !(await go($('#goto').value))) $('#goto').style.borderColor = '#c0392b'; else $('#goto').style.borderColor = ''; });
async function doSearch() {
  const q = $('#q').value.trim(); if (!q || !state.sid) return;
  if (await go(q)) return;
  const area = $('#area').value;
  const hits = await invoke('search_text', { sid: state.sid, q, area }).catch((x) => { $('#results').innerHTML = `<p class="err">${esc(x)}</p>`; return null; });
  if (!hits) return;
  const vname = Object.fromEntries(state.versions.map((v) => [v.id, v.name]));
  $('#results').innerHTML = (hits.length ? '' : '<p class="muted">결과가 없습니다.</p>') + hits.map((h, i) => `<div class="hit" data-i="${i}"><b>${esc(bookName(h.bk))} ${h.ch}${h.v ? ':' + h.v : ''}</b> <span class="tag">${esc(area === 'comm' ? h.src.replace(/^lib:/, '') : vname[h.src] || h.src)}</span><div>${esc(h.snippet).replace(/\[([^\]]*)\]/g, '<mark>$1</mark>')}</div></div>`).join('');
  $('#results').onclick = (ev) => { const d = ev.target.closest('.hit'); if (!d) return; const h = hits[+d.dataset.i]; state.bk = h.bk; state.ch = h.ch || 1; showView('bible'); openChapter(h.v || null); };
}
$('#dosearch').onclick = doSearch;
$('#q').addEventListener('keydown', (ev) => ev.key === 'Enter' && doSearch());

// ---- 소논문 목록
async function loadArticles() {
  if (!state.sid) return;
  const list = await invoke('articles', { sid: state.sid }).catch(() => []);
  $('#articlelist').innerHTML = list.length ? list.map((a) => `<div class="hit"><b>${esc(a.title)}</b> <span class="tag">${esc(a.src_name)}</span> <span class="muted">${esc(a.section)} · ${a.chars.toLocaleString()}자</span></div>`).join('') : '<p class="muted">소논문 자료가 없습니다.</p>';
}

boot();
