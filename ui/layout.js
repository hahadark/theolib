// layout.js — 성경 보기 화면의 자유 배치(패널 트리·끌어 놓기·경계선·배치 저장).
// 설정은 localStorage 키 `theolib.ui.v1` 하나에 저장한다(본문·주소 없음).
// 전역 UIStore(저장), Fmt(서식) 에 의존한다. format.js 가 먼저 로드돼야 한다.
/* global UIStore, Fmt */
(function () {
  'use strict';

  const SPLIT_MIN = 160; // px
  // UIStore 는 format.js 가 정의해 전역에 둔다.

  // ---- 패널 종류별 메타 + 기본 설정
  const PANEL_META = {
    body: { name: '본문', defaultSettings: { vers: [], versLayout: 'stack' } },
    // series: 이 패널이 보는 주석 시리즈. chapview: 장 전체를 절 순서로 나열(기본). multi: 여러 시리즈를 이어 보기.
    comm: { name: '주석', defaultSettings: { series: null, chapview: true, multi: false } },
    parse: { name: '원전 분해', defaultSettings: {} },
    lex: { name: '사전', defaultSettings: {} },
    search: { name: '검색', defaultSettings: {} },
    article: { name: '소논문', defaultSettings: {} },
    records: { name: '내 기록', defaultSettings: { q: '' } },
  };

  // 패널 id → 종류. id 는 `kind` 또는 `kind2`, `kind3` … 꼴.
  function kindOfId(id) { return String(id).replace(/\d+$/, ''); }

  // ---- 기본 배치 3종
  function defaultLayouts() {
    return {
      '본문만': { root: { panel: 'body' } },
      '본문+주석': { root: { split: 'row', ratio: 0.6, a: { panel: 'body' }, b: { panel: 'comm' } } },
      '본문·주석·원어': { root: { split: 'row', ratio: 0.5, a: { panel: 'body' }, b: { split: 'col', ratio: 0.5, a: { panel: 'comm' }, b: { panel: 'parse' } } } },
    };
  }

  // ---- 트리 유틸
  function panelsOf(node, acc) {
    acc = acc || [];
    if (!node) return acc;
    if (node.panel) acc.push({ panel: node.panel, settings: node.settings || {} });
    else { panelsOf(node.a, acc); panelsOf(node.b, acc); }
    return acc;
  }
  function nodeOf(node, pid) {
    if (!node) return null;
    if (node.panel) return node.panel === pid ? node : null;
    return nodeOf(node.a, pid) || nodeOf(node.b, pid);
  }

  // ---- 저장된 배치
  const layouts = { saved: {}, last: null };

  function initLayouts() {
    layouts.saved = defaultLayouts();
    const saved = UIStore.read().layouts || {};
    for (const k in saved) if (saved[k] && saved[k].root) layouts.saved[k] = saved[k];
    layouts.last = UIStore.read().lastLayout || null;
  }
  function saveLayout(name, root, markLast) {
    name = String(name || '').trim();
    if (!name) return false;
    layouts.saved[name] = { root: JSON.parse(JSON.stringify(root)) };
    const patch = { layouts: layouts.saved };
    if (markLast) patch.lastLayout = root;
    UIStore.write(patch);
    return true;
  }
  function loadLayout(name, markLast) {
    const l = layouts.saved[name];
    if (!l) return false;
    const patch = {};
    if (markLast) patch.lastLayout = l.root;
    UIStore.write(patch);
    return JSON.parse(JSON.stringify(l.root));
  }
  function deleteLayout(name) {
    if (!layouts.saved[name]) return false;
    delete layouts.saved[name];
    UIStore.write({ layouts: layouts.saved });
    return true;
  }
  function setLast(root) { layouts.last = root; UIStore.write({ lastLayout: root }); }

  // ---- Panel
  class Panel {
    constructor(id, kind, settings) {
      this.id = id;
      this.kind = kind;
      // 기본 설정을 먼저 깔고 저장된 값을 덮어쓴다(예전 배치에 없던 chapview·multi 도 기본값을 갖는다).
      this.settings = Object.assign({}, JSON.parse(JSON.stringify(PANEL_META[kind].defaultSettings || {})), JSON.parse(JSON.stringify(settings || {})));
      this.linked = true; // 구절 연동 고리
      this.ref = null;    // 연동 끊겼을 때 고정할 {bk,ch,v}
      this.el = null; this.head = null; this.body = null; this.resEl = null; this.linkBtn = null;
    }
    name() { return PANEL_META[this.kind].name; }
    saveSettings() {
      const root = rootFromDOM();
      const node = nodeOf(root, this.id);
      if (node) node.settings = JSON.parse(JSON.stringify(this.settings));
      setLast(root); // 즉시 localStorage 에 반영(주석 시리즈·번역본·서식 등 바뀌는 대로 저장)
    }
  }

  // ---- 런타임 상태
  let container = null;
  let current = { root: null, panes: [], byId: {} };
  let provider = null; // app.js 가 { renderPanel, renderAll, onLinkChange, panelTitle } 를 채움

  function currentRoot() { return current.root; }

  // ---- DOM 구축
  function makeSplitEl(dir) {
    const el = document.createElement('div');
    el.className = 'p-split ' + (dir === 'col' ? 'vertical' : 'horizontal');
    el.dataset.split = dir;
    return el;
  }

  function buildNode(node) {
    if (node.panel) {
      const id = node.panel, kind = kindOfId(id);
      if (!current.byId[id]) {
        current.byId[id] = new Panel(id, kind, node.settings);
        current.panes.push(current.byId[id]);
      }
      return makePaneEl(current.byId[id]);
    }
    const split = makeSplitEl(node.split);
    const a = buildNode(node.a), b = buildNode(node.b);
    split.appendChild(a);
    split.appendChild(makeGrip(split));
    split.appendChild(b);
    applyRatio(split, node.ratio);
    return split;
  }

  function makeGrip(split) {
    const g = document.createElement('div');
    g.className = 'p-grip';
    return g;
  }

  function applyRatio(split, ratio) {
    const r = Math.min(0.9, Math.max(0.1, ratio == null ? 0.5 : +ratio));
    split.style.setProperty('--ratio', String(r));
  }

  function makePaneEl(panel) {
    const el = document.createElement('div');
    const kindCls = panel.kind === 'body' ? 'body' : (panel.kind === 'comm' ? 'note' : (panel.kind === 'parse' || panel.kind === 'lex' ? 'orig' : 'note'));
    el.className = 'p-pane fmt-' + kindCls;
    el.dataset.pid = panel.id;
    el.dataset.kind = panel.kind;

    const head = document.createElement('div');
    head.className = 'p-head';

    const kind = document.createElement('span');
    kind.className = 'p-kind';
    kind.textContent = panel.name();

    const res = document.createElement('span');
    res.className = 'p-res';

    const linkBtn = document.createElement('button');
    linkBtn.className = 'p-link on';
    linkBtn.title = '구절 연동 (끄면 이 패널은 다른 구절에 머문다)';
    linkBtn.textContent = '🔗';
    linkBtn.onclick = () => setLinked(panel, !panel.linked);

    const dupBtn = mkBtn('＋', '같은 종류 복제', () => duplicate(panel));
    const fmtBtn = mkBtn('Aa', '이 패널 서식', () => openPanelFormat(panel));
    const closeBtn = mkBtn('✕', '닫기', () => closePanel(panel));

    head.append(kind, res, linkBtn, dupBtn, fmtBtn, closeBtn);

    const body = document.createElement('div');
    body.className = 'p-body';

    el.append(head, body);
    panel.el = el; panel.head = head; panel.body = body; panel.resEl = res; panel.linkBtn = linkBtn;
    return el;
  }
  function mkBtn(txt, title, fn) {
    const b = document.createElement('button');
    b.className = 'p-btn'; b.textContent = txt; b.title = title; b.onclick = fn;
    return b;
  }

  function setLinked(panel, v) {
    panel.linked = v;
    if (v) panel.ref = null;
    panel.linkBtn.className = 'p-link' + (v ? ' on' : '');
    panel.linkBtn.textContent = v ? '🔗' : '🔓';
    if (provider && provider.onLinkChange) provider.onLinkChange(panel);
  }

  function refreshPanelMeta(id) {
    const p = current.byId[id];
    if (p && p.resEl && provider && provider.panelTitle) p.resEl.textContent = provider.panelTitle(p);
    refreshNarrow();
  }

  // ---- 렌더
  function renderRoot(root) {
    container.innerHTML = '';
    current.root = sanitize(root);
    current.panes = [];
    current.byId = {};
    container.appendChild(buildNode(current.root));
    setLast(current.root);
    if (provider && provider.renderAll) provider.renderAll();
    refreshNarrow();
  }

  function setRoot(root) { renderRoot(root); }
  function refreshPanes() { if (provider && provider.renderAll) provider.renderAll(); }

  function sanitize(node) {
    if (!node || (!node.panel && (!node.a || !node.b))) return { panel: 'body' };
    if (node.panel) return { panel: String(node.panel), settings: node.settings || {} };
    const s = node.split === 'col' ? 'col' : 'row';
    return { split: s, ratio: node.ratio == null ? 0.5 : node.ratio, a: sanitize(node.a), b: sanitize(node.b) };
  }

  function rootFromDOM() {
    function build(el) {
      if (el.classList.contains('p-pane')) {
        const p = current.byId[el.dataset.pid];
        return { panel: p.id, settings: JSON.parse(JSON.stringify(p.settings)) };
      }
      const kids = [...el.children].filter((c) => c.classList.contains('p-pane') || c.classList.contains('p-split'));
      if (!kids.length) return { panel: 'body' };
      if (kids.length === 1) return build(kids[0]);
      const split = el.dataset.split || 'row';
      const ratio = parseFloat(el.style.getPropertyValue('--ratio')) || 0.5;
      return { split, ratio, a: build(kids[0]), b: build(kids[kids.length - 1]) };
    }
    const kids = [...container.children].filter((c) => c.classList.contains('p-pane') || c.classList.contains('p-split'));
    if (!kids.length) return { panel: 'body' };
    return build(kids[0]);
  }

  // ---- 패널 추가 / 복제 / 닫기
  function uniqueKindId(kind) {
    const used = new Set(current.panes.map((p) => p.id));
    if (!used.has(kind)) return kind;
    let n = 2;
    while (used.has(kind + n)) n++;
    return kind + n;
  }

  function addPanel(kind) {
    const id = uniqueKindId(kind);
    const node = { panel: id, settings: PANEL_META[kind].defaultSettings || {} };
    const root = rootFromDOM();
    const newRoot = (root.panel && !root.split) ? { split: 'row', ratio: 0.5, a: root, b: node }
      : insertBeside(root, lastPanelId(root), node, 'after');
    renderRoot(newRoot);
  }

  function lastPanelId(root) {
    if (root.panel) return root.panel;
    return lastPanelId(root.b);
  }

  function duplicate(panel) {
    const id = uniqueKindId(panel.kind);
    const node = { panel: id, settings: JSON.parse(JSON.stringify(panel.settings)) };
    const root = rootFromDOM();
    renderRoot(insertBeside(root, panel.id, node, 'after'));
  }

  function closePanel(panel) {
    const root = rootFromDOM();
    if (panelsOf(root).length <= 1) return;
    renderRoot(removePanel(root, panel.id));
  }

  function findParentOf(root, pid) {
    if (!root || root.panel) return null;
    if (root.a && root.a.panel === pid) return { node: root, side: 'a' };
    if (root.b && root.b.panel === pid) return { node: root, side: 'b' };
    return findParentOf(root.a, pid) || findParentOf(root.b, pid);
  }

  function insertBeside(root, targetPid, newNode, side) {
    const p = findParentOf(root, targetPid);
    if (!p) return root;
    const parent = p.node;
    const same = parent.split || 'row';
    if (p.side === 'a') parent.a = { split: same, ratio: 0.5, a: parent.a, b: newNode };
    else parent.b = { split: same, ratio: 0.5, a: parent.b, b: newNode };
    return root;
  }

  function removePanel(root, pid) {
    function go(node) {
      if (!node) return null;
      if (node.panel) return node.panel === pid ? null : node;
      const a = go(node.a), b = go(node.b);
      if (!a) return b;
      if (!b) return a;
      node.a = a; node.b = b; return node;
    }
    return go(root);
  }

  function swapPanels(root, aId, bId) {
    function go(node) {
      if (!node) return null;
      if (node.panel) {
        if (node.panel === aId) return { panel: bId, settings: node.settings };
        if (node.panel === bId) return { panel: aId, settings: node.settings };
        return node;
      }
      node.a = go(node.a); node.b = go(node.b); return node;
    }
    return go(root);
  }

  function insertPanel(root, targetPid, srcNode, side) {
    const dir = (side === 'left' || side === 'right') ? 'row' : 'col';
    function go(node) {
      if (!node) return null;
      if (node.panel && node.panel === targetPid) {
        const first = (side === 'left' || side === 'top') ? srcNode : node;
        const second = (side === 'left' || side === 'top') ? node : srcNode;
        return { split: dir, ratio: 0.5, a: first, b: second };
      }
      if (node.panel) return node;
      node.a = go(node.a); node.b = go(node.b); return node;
    }
    return go(root);
  }

  function extractNode(root, pid) {
    let extracted = null;
    const remaining = (function go(node) {
      if (!node) return null;
      if (node.panel) {
        if (node.panel === pid) { extracted = { panel: node.panel, settings: node.settings || {} }; return null; }
        return node;
      }
      const a = go(node.a), b = go(node.b);
      if (!a) return b;
      if (!b) return a;
      node.a = a; node.b = b; return node;
    })(root) || { panel: 'body' };
    return { extracted, remaining };
  }

  // ---- 드래그 앤 드롭 (포인터 이벤트 기반: 데스크톱 WebView 에서 파일 끌어놓기와 충돌하지 않도록 HTML5 DnD 대신 쓴다)
  function initDrag() {
    let drag = null; // { id, startX, startY, moved }

    function clearHints() {
      container.querySelectorAll('.drop-edge, .drop-center, .dragging, .drop-edge-t, .drop-edge-b, .drop-edge-l, .drop-edge-r').forEach((x) => x.classList.remove('drop-edge', 'drop-center', 'dragging', 'drop-edge-t', 'drop-edge-b', 'drop-edge-l', 'drop-edge-r'));
      container.querySelectorAll('.p-pane').forEach((p) => { delete p.dataset.dropZone; });
    }

    function zoneOf(pane, clientX, clientY) {
      const r = pane.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return null;
      const x = (clientX - r.left) / r.width, y = (clientY - r.top) / r.height;
      if (x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7) return 'center';
      if (x < 0.3 && y >= 0.3 && y <= 0.7) return 'left';
      if (x > 0.7 && y >= 0.3 && y <= 0.7) return 'right';
      if (y < 0.3) return 'top';
      return 'bottom';
    }

    function decorate(pane, zone) {
      pane.classList.remove('drop-edge', 'drop-center', 'drop-edge-t', 'drop-edge-b', 'drop-edge-l', 'drop-edge-r');
      if (zone === 'center') pane.classList.add('drop-center');
      else if (zone) pane.classList.add('drop-edge', 'drop-edge-' + zone.charAt(0));
    }

    function endDrag() { clearHints(); drag = null; document.body.classList.remove('p-dragging'); }

    container.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.p-head');
      if (!head) return;
      // 머리줄의 단추(닫기·복제·연동·서식)는 끌지 않는다.
      if (e.target.closest('.p-btn, .p-link')) return;
      const pane = head.closest('.p-pane');
      if (!pane) return;
      drag = { id: pane.dataset.pid, startX: e.clientX, startY: e.clientY, moved: false };
      // 끌기 중 텍스트 선택 방지
      try { head.setPointerCapture(e.pointerId); } catch (err) {}
    });

    container.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY;
      if (!drag.moved && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        const src = container.querySelector(`.p-pane[data-pid="${CSS.escape(drag.id)}"]`);
        if (src) src.classList.add('dragging');
        document.body.classList.add('p-dragging');
      }
      e.preventDefault();
      clearHints();
      // 끌리는 패널은 흐리게 유지한다(clearHints 가 지워도 다시 표시).
      const srcEl = container.querySelector(`.p-pane[data-pid="${CSS.escape(drag.id)}"]`);
      if (srcEl) srcEl.classList.add('dragging');
      // 포인터 캡처 때문에 e.target 이 캡처된(끌리는) 머리줄로 고정될 수 있다.
      // 실제 커서 아래 요소는 elementFromPoint 로 찾는다.
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under ? under.closest('.p-pane') : null;
      if (target && target.dataset.pid !== drag.id) {
        const zone = zoneOf(target, e.clientX, e.clientY);
        decorate(target, zone);
        target.dataset.dropZone = zone || '';
      }
    });

    container.addEventListener('pointerup', (e) => {
      if (!drag) return;
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under ? under.closest('.p-pane') : null;
      if (drag.moved && target && target.dataset.pid !== drag.id && target.dataset.dropZone) {
        const zone = target.dataset.dropZone;
        const srcId = drag.id, dstId = target.dataset.pid;
        let root;
        if (zone === 'center') {
          root = swapPanels(rootFromDOM(), srcId, dstId);
        } else {
          const side = zone === 'top' || zone === 'bottom' ? zone : zone; // left/right/top/bottom 그대로
          const { extracted, remaining } = extractNode(rootFromDOM(), srcId);
          root = extracted ? insertPanel(remaining, dstId, extracted, side) : rootFromDOM();
        }
        endDrag();
        renderRoot(root);
        return;
      }
      endDrag();
    });

    container.addEventListener('pointercancel', () => { if (drag) endDrag(); });

    // Esc 로 취소
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drag) endDrag(); });
  }

  // ---- 경계선 끌어 크기 조절 (포인터 이벤트)
  function initResize() {
    container.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.p-grip');
      if (!grip) return;
      e.preventDefault();
      const split = grip.parentNode;
      const vertical = split.dataset.split === 'col';
      const kids = [...split.children].filter((c) => c.classList.contains('p-pane') || c.classList.contains('p-split'));
      if (kids.length < 2) return;
      const total = vertical ? split.clientHeight : split.clientWidth;
      const startRatio = parseFloat(split.style.getPropertyValue('--ratio')) || 0.5;
      const startPos = vertical ? e.clientY : e.clientX;
      const onMove = (ev) => {
        const d = (vertical ? ev.clientY : ev.clientX) - startPos;
        if (total <= 0) return;
        applyRatio(split, Math.min(0.9, Math.max(0.1, startRatio + d / total)));
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        setLast(rootFromDOM());
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  // ---- 패널별 서식 팝업 (app.js 가 오버라이드)
  let openPanelFormatFn = () => {};
  function openPanelFormat(panel) { openPanelFormatFn(panel); }
  function setOpenPanelFormat(fn) { openPanelFormatFn = fn || (() => {}); }

  function panels() { return current.panes; }
  function panelById(id) { return current.byId[id]; }

  // ---- 좁은 화면(<720px): 패널을 세로로 쌓고 한 번에 하나씩 넘겨 보는 탭 줄
  let narrowActive = null;
  function refreshNarrow() {
    const bar = document.querySelector('#narrow-bar');
    if (!bar) return;
    bar.textContent = '';
    const ps = current.panes;
    if (ps.length <= 1) { bar.classList.remove('on'); return; }
    narrowActive = ps.some((p) => p.id === narrowActive) ? narrowActive : ps[0].id;
    for (const p of ps) {
      const b = document.createElement('button');
      b.className = 'narrow-tab' + (p.id === narrowActive ? ' on' : '');
      b.dataset.pid = p.id;
      b.textContent = p.name();
      b.onclick = () => { narrowActive = p.id; refreshNarrow(); };
      bar.appendChild(b);
    }
    bar.classList.add('on');
    for (const p of ps) p.el.classList.toggle('narrow-active', p.id === narrowActive);
  }
  function setNarrowActive(pid) { if (current.byId[pid]) { narrowActive = pid; refreshNarrow(); } }

  function init(rootEl, prov) {
    container = rootEl;
    provider = prov || {};
    initLayouts();
    initDrag();
    initResize();
    const last = layouts.last;
    const root = (last && panelsOf(last).length) ? last : defaultLayouts()['본문+주석'].root;
    renderRoot(root);
  }

  window.Layout = {
    init, setRoot, renderRoot, refreshPanes, refreshPanelMeta,
    panels, panelById, PANEL_META, defaults: defaultLayouts,
    saveLayout, loadLayout, deleteLayout, last: () => layouts.last,
    layoutNames: () => Object.keys(layouts.saved).filter((n) => layouts.saved[n]),
    addPanel, duplicate, closePanel, setLinked,
    currentRoot,
    setOpenPanelFormat,
  };
})();
