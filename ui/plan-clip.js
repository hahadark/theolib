/* plan-clip.js — 어디서나 "설계도에 담기".
   글을 골라 놓으면 그 곁에 작은 단추가 뜬다. 누르면 자료함에 담고, 옆의 ▾ 로 설계도의 가지를 골라 바로 넣는다.
   어떤 글인지(출처·종류·돌아갈 자리)는 화면마다 다르므로 host 쪽이 주는 resolve(node, text) 가 정한다.
   앱(plan-host.js)과 웹(sermon-plan-host.js)이 같이 쓴다. 바깥에 내놓는 것은 window.SermonPlanClip 뿐이다. */
(function () {
  'use strict';

  const IC_IN = '<svg class="pl-clipbar-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>';
  const IC_DOWN = '<svg class="pl-clipbar-ic" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  let cfg = null;      // { host, resolve(node, text) -> clip | null }
  let bar = null;      // 떠 있는 단추 줄
  let cur = null;      // 지금 고른 글로 만든 자료
  let timer = 0;

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function hide() {
    cur = null;
    if (bar) { bar.remove(); bar = null; }
  }

  function place(rect) {
    // 고른 글의 끝 아래에 둔다. 화면 밖으로 나가면 안으로 민다(아래가 모자라면 위로).
    const w = bar.offsetWidth, h = bar.offsetHeight;
    let x = Math.min(Math.max(8, rect.right - w), window.innerWidth - w - 8);
    let y = rect.bottom + 8;
    if (y + h > window.innerHeight - 8) y = Math.max(8, rect.top - h - 8);
    bar.style.left = Math.round(x) + 'px';
    bar.style.top = Math.round(y) + 'px';
  }

  function show(rect) {
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'pl-clipbar' + (cfg.host.kind === 'web' ? ' pl-clipbar-web' : '');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', '설계도에 담기');
      // 단추를 눌러도 고른 글이 풀리지 않게 한다.
      bar.addEventListener('mousedown', (ev) => ev.preventDefault());
      bar.addEventListener('click', onClick);
      document.body.appendChild(bar);
    }
    bar.innerHTML = `<button type="button" class="pl-clipbar-go" data-act="tray">${IC_IN}<span>설계도에 담기</span></button>`
      + `<button type="button" class="pl-clipbar-more" data-act="more" aria-label="넣을 가지 고르기" title="넣을 가지 고르기">${IC_DOWN}</button>`;
    place(rect);
  }

  async function put(target, label) {
    const clip = cur;
    if (!clip || !window.SermonPlan) return;
    hide();
    try { window.getSelection().removeAllRanges(); } catch (e) { /* 고른 글 풀기는 못 해도 된다 */ }
    let r = null;
    try { r = await window.SermonPlan.clip(cfg.host, clip, target || undefined); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    if (r && r.ok) cfg.host.toast(target ? `'${label}'에 넣었습니다` : '자료함에 담았습니다');
    else cfg.host.toast((r && r.error) || '담지 못했습니다');
  }

  async function onClick(ev) {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'tray') return put(null);
    if (b.dataset.act === 'branch') return put({ planId: b.dataset.plan, branchId: b.dataset.branch }, b.dataset.label);
    if (b.dataset.act === 'more') {
      // 가지 목록은 누를 때 읽는다(설계도를 바꿨을 수 있다).
      let ts = [];
      try { ts = await window.SermonPlan.targets(cfg.host); } catch (e) { ts = []; }
      if (!bar || !cur) return;
      const rect = bar.getBoundingClientRect();
      const rows = ts.map((t) => `<button type="button" data-act="branch" data-plan="${esc(t.planId)}" data-branch="${esc(t.branchId)}" data-label="${esc(t.label)}">${esc(t.label)}</button>`).join('');
      bar.classList.add('pl-clipbar-open');
      bar.innerHTML = `<div class="pl-clipbar-label">어디에 넣을까요</div><button type="button" data-act="tray">자료함에만 담기</button>`
        + (rows || '<div class="pl-clipbar-note">열어 둔 설계도가 없습니다. 설계도를 만들면 가지를 고를 수 있습니다.</div>');
      place({ right: rect.right, bottom: rect.top - 8, top: rect.top - 8 });
    }
  }

  function check() {
    if (!cfg || !window.SermonPlan) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return hide();
    const text = sel.toString().replace(/[ \t]+\n/g, '\n').trim();
    if (text.length < 2) return hide();
    const a = sel.anchorNode;
    const node = a && (a.nodeType === 1 ? a : a.parentElement);
    // 설계도 화면 안, 입력칸 안에서 고른 글에는 띄우지 않는다.
    if (!node || node.closest('.pl-root, .pl-clipbar, input, textarea, [contenteditable="true"]')) return hide();
    let clip = null;
    try { clip = cfg.resolve(node, text); } catch (e) { clip = null; }
    if (!clip) return hide();
    cur = Object.assign({ kind: 'own', src: '', link: null, note: '' }, clip, { text: text.slice(0, 4000) });
    const rs = sel.getRangeAt(0).getClientRects();
    const rect = rs.length ? rs[rs.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return hide();
    if (bar) bar.classList.remove('pl-clipbar-open');
    show(rect);
  }

  function later() {
    clearTimeout(timer);
    timer = setTimeout(check, 180);
  }

  function install(c) {
    if (cfg) { cfg = c; return; }
    cfg = c;
    // 마우스로 고를 때는 손을 뗀 뒤에, 터치·키보드로 고를 때는 고른 것이 바뀐 뒤에 살핀다.
    document.addEventListener('selectionchange', () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) { if (bar && !bar.classList.contains('pl-clipbar-open')) hide(); return; }
      later();
    });
    document.addEventListener('mouseup', (ev) => { if (!ev.target.closest || !ev.target.closest('.pl-clipbar')) later(); });
    document.addEventListener('mousedown', (ev) => { if (bar && !ev.target.closest('.pl-clipbar')) hide(); });
    document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
    window.addEventListener('scroll', () => { if (bar) hide(); }, true);
    window.addEventListener('resize', hide);
  }

  // 단추로 바로 담을 때(고른 절 담기 등). clip 에는 text 가 들어 있어야 한다.
  async function clipNow(clip, target) {
    if (!cfg || !window.SermonPlan) return { ok: false, error: '설계도를 불러오지 못했습니다' };
    const r = await window.SermonPlan.clip(cfg.host, Object.assign({ kind: 'own', src: '', link: null, note: '' }, clip), target || undefined);
    if (r && r.ok) cfg.host.toast('자료함에 담았습니다');
    else cfg.host.toast((r && r.error) || '담지 못했습니다');
    return r;
  }

  window.SermonPlanClip = { install, clipNow, hide };
})();
