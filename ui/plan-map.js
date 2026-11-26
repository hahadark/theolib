/* plan-map.js — 설교 설계도의 마인드맵 보기.
   - 전역은 window.SermonPlanMap 하나. SermonPlanMap.mount(el, core) -> { refresh(), setNarrow(bool), destroy() }
   - 자료는 읽기만 한다. 고치는 일(moveItem, putClip, 고침 칸)은 모두 core(plan.js)가 한다.
   - 색·크기는 plan.css 가 정한다. 여기서는 좌표(left top width height transform)와 .pl-pop 자리만 인라인으로 둔다.
   - 설계: docs/PLAN_UI.md 9·10·11절, docs/PLAN_DESIGN.md 6절. */
(function () {
  'use strict';

  var CW = 280;          // 가운데 카드 폭
  var NW = 260;          // 가지 카드 폭
  var PAD = 40;          // 캔버스 여백
  var ROW_MAX = 4;       // 접힌 카드에 보이는 줄 수
  var MIN_S = 0.25, MAX_S = 2;
  var NS = 'http://www.w3.org/2000/svg';
  var T_ITEM = 'application/x-pl-item';
  var T_CLIP = 'application/x-pl-clip';

  // 고른 배치는 설계도가 아니라 화면 기억으로만 둔다(저장소 없음). 같은 쪽 안에서 다시 열어도 이어진다.
  var rememberedLayout = 'ring';

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function r2(v) { return Math.round(v * 100) / 100; }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;   // 사용자 글은 늘 textContent 로
    return e;
  }

  // 아이콘은 path 를 그 자리에 직접 넣는다(이모지·외부 파일 없음)
  function icon(d) {
    var s = document.createElementNS(NS, 'svg');
    s.setAttribute('class', 'pl-ic');
    s.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }

  function mount(root, core) {
    var destroyed = false;
    var narrow = !!core.narrow();
    var layoutKind = rememberedLayout;
    var openSet = {};              // 더 보기로 편 카드(보기를 떠날 때까지 기억)
    var s = 1, tx = 0, ty = 0;     // 확대·이동
    var W = 0, H = 0;              // 캔버스 크기
    var center = { x: 0, y: 0 };   // 가운데 카드 가운데의 캔버스 좌표(다시 배치할 때 화면 자리를 지키려고)
    var cLeft = 0;
    var fitted = false;            // 처음 맞춤을 했는가
    var touched = false;           // 사용자가 움직이거나 확대했는가(했다면 글꼴 뒤 재배치에서 맞춤을 다시 하지 않는다)
    var pending = false;           // 보이지 않는 동안 못 그린 것이 있음
    var pop = null;                // 열려 있는 고침 칸
    var dragItem = null;           // 맵 안에서 끌고 있는 항목 { id, branchId }
    var dropNode = null;
    var skipOpenId = null;
    var suppressClick = false;
    var offs = [];                 // 듣기를 풀 함수들

    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push(function () { target.removeEventListener(type, fn, opts); });
    }

    // 맞춤·확대는 transition 없이 한 번에 옮기므로 움직임 줄이기 설정과 늘 맞는다.

    /* ---------- 뼈대 ---------- */
    root.textContent = '';
    var map = el('div', 'pl-map');
    var view = el('div', 'pl-map-view');
    view.tabIndex = 0;
    view.setAttribute('aria-label', '마인드맵. 끌어서 움직이고 휠로 확대합니다.');
    var canvas = el('div', 'pl-map-canvas');
    view.appendChild(canvas);
    map.appendChild(view);

    var barLayout = el('div', 'pl-map-bar pl-map-bar-layout');
    var seg = el('div', 'pl-seg pl-layouts');
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', '배치');
    var segBtns = {};
    [['ring', '둘레로'], ['sides', '좌우로']].forEach(function (a) {
      var b = el('button', null, a[1]);
      b.type = 'button';
      b.setAttribute('role', 'radio');
      b.setAttribute('data-layout', a[0]);
      segBtns[a[0]] = b;
      seg.appendChild(b);
    });
    barLayout.appendChild(seg);
    map.appendChild(barLayout);

    var barZoom = el('div', 'pl-map-bar pl-map-bar-zoom');
    var bOut = el('button', 'pl-ib pl-zoom-out'); bOut.type = 'button';
    bOut.setAttribute('aria-label', '작게'); bOut.title = '작게';
    bOut.appendChild(icon('M5 12h14'));
    var zval = el('span', 'pl-zoom-val', '100%');
    zval.setAttribute('aria-live', 'polite');
    var bIn = el('button', 'pl-ib pl-zoom-in'); bIn.type = 'button';
    bIn.setAttribute('aria-label', '크게'); bIn.title = '크게';
    bIn.appendChild(icon('M5 12h14M12 5v14'));
    var bFit = el('button', 'pl-btn pl-btn-quiet pl-btn-sm pl-zoom-fit', '한눈에');
    bFit.type = 'button';
    barZoom.appendChild(bOut); barZoom.appendChild(zval); barZoom.appendChild(bIn); barZoom.appendChild(bFit);
    map.appendChild(barZoom);
    root.appendChild(map);

    /* ---------- 자료 읽기 ---------- */
    function effLayout() { return narrow ? 'sides' : layoutKind; }   // 좁은 화면은 좌우로만

    function findItem(plan, id) {
      for (var i = 0; i < plan.branches.length; i++) {
        var b = plan.branches[i];
        var its = b.items || [];
        for (var j = 0; j < its.length; j++) {
          if (its[j].id === id) return { item: its[j], branch: b };
          var ch = its[j].children || [];
          for (var k = 0; k < ch.length; k++) if (ch[k].id === id) return { item: ch[k], branch: b };
        }
      }
      return null;
    }

    function visibleSize() { return view.clientWidth > 0 && view.clientHeight > 0; }

    /* ---------- 그리기 ---------- */
    function renderNode(b, scrolls) {
      var info = core.branchInfo(b.id) || {};
      var node = el('div', 'pl-map-node');
      node.setAttribute('data-kind', b.kind);
      if (b.kind === 'point' && info.pt) node.setAttribute('data-pt', String(info.pt));
      node.setAttribute('data-id', b.id);
      var isOpen = !!openSet[b.id];
      if (isOpen) node.classList.add('pl-open');

      var head = el('div', 'pl-map-node-head');
      head.appendChild(el('span', 'pl-map-no', String(info.no != null ? info.no : '')));
      head.appendChild(el('span', 'pl-map-kind', info.kindLabel || ''));
      // 이름을 붙이지 않은 서론·결론은 종류 글귀만 두 번 보이지 않게 한다
      if ((b.name || '').trim()) head.appendChild(el('b', 'pl-map-name', b.name));
      node.appendChild(head);

      if ((b.thesis || '').trim()) node.appendChild(el('p', 'pl-map-thesis', b.thesis));

      // 윗단계와 아래 단계를 설계도 차례대로 편 줄
      var rows = [];
      (b.items || []).forEach(function (it) {
        rows.push({ it: it, sub: false });
        (it.children || []).forEach(function (c) { rows.push({ it: c, sub: true }); });
      });

      if (!rows.length) {
        node.appendChild(el('p', 'pl-map-node-empty', '비어 있습니다'));
      } else {
        var ul = el('ul', 'pl-map-items');
        var shown = isOpen ? rows : rows.slice(0, ROW_MAX);
        shown.forEach(function (r) {
          var li = el('li', 'pl-map-item' + (r.sub ? ' pl-sub' : ''));
          li.setAttribute('data-id', r.it.id);
          if (!narrow) li.draggable = true;   // 좁은 화면은 끌기를 쓰지 않는다
          li.tabIndex = 0;
          li.appendChild(el('span', 'pl-item-no', core.itemNo(r.it.id)));
          li.appendChild(el('span', 'pl-map-item-text', r.it.text || ''));
          ul.appendChild(li);
        });
        node.appendChild(ul);
        if (rows.length > ROW_MAX) {
          var more = el('button', 'pl-map-more', isOpen ? '접기' : (rows.length - ROW_MAX) + '개 더 보기');
          more.type = 'button';
          more.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
          node.appendChild(more);
        }
        if (scrolls && scrolls[b.id]) ul.dataset.st = scrolls[b.id];   // 붙인 뒤에 되돌린다
      }
      return node;
    }

    var nodeEls = [], centerEl = null, lineEls = [];

    function render() {
      if (!visibleSize()) { pending = true; return false; }
      var plan = core.plan();
      var scrolls = {};
      Array.prototype.forEach.call(canvas.querySelectorAll('.pl-map-node.pl-open'), function (n) {
        var u = n.querySelector('.pl-map-items');
        if (u) scrolls[n.getAttribute('data-id')] = u.scrollTop;
      });
      // 다시 그려도 초점을 잃지 않게
      var act = document.activeElement, focusKey = null;
      if (act && canvas.contains(act)) {
        if (act.classList.contains('pl-map-item')) focusKey = 'i:' + act.getAttribute('data-id');
        else if (act.classList.contains('pl-map-more')) focusKey = 'm:' + act.closest('.pl-map-node').getAttribute('data-id');
      }
      if (pendingFocus) { focusKey = pendingFocus; pendingFocus = null; }

      // 없어진 가지의 '편 카드' 기억은 버린다
      var ids = {};
      plan.branches.forEach(function (b) { ids[b.id] = 1; });
      Object.keys(openSet).forEach(function (k) { if (!ids[k]) delete openSet[k]; });

      canvas.textContent = '';
      var svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'pl-map-lines');
      svg.setAttribute('aria-hidden', 'true');
      canvas.appendChild(svg);   // 선은 카드 아래에 깔린다(먼저 온다)

      centerEl = el('div', 'pl-map-center');
      centerEl.appendChild(el('div', 'pl-map-title', (plan.title || '').trim() || '제목 없는 설계도'));
      centerEl.appendChild(el('div', 'pl-map-ref', (plan.ref || '').trim() || '본문 없음'));
      if ((plan.big || '').trim()) {
        var big = el('div', 'pl-map-big');
        big.setAttribute('data-kind', 'big');
        big.appendChild(el('span', 'pl-map-big-label', '중심 사상'));
        big.appendChild(document.createTextNode(plan.big));
        centerEl.appendChild(big);
      }
      canvas.appendChild(centerEl);

      nodeEls = plan.branches.map(function (b) {
        var n = renderNode(b, scrolls);
        canvas.appendChild(n);
        var u = n.querySelector('.pl-map-items');
        if (u && u.dataset.st) { u.scrollTop = +u.dataset.st; delete u.dataset.st; }
        return n;
      });

      lineEls = plan.branches.map(function (b, i) {
        var p = document.createElementNS(NS, 'path');
        p.setAttribute('class', 'pl-map-line');
        p.setAttribute('data-kind', b.kind);
        var pt = nodeEls[i].getAttribute('data-pt');
        if (pt) p.setAttribute('data-pt', pt);
        p.setAttribute('data-to', b.id);
        svg.appendChild(p);
        return p;
      });
      canvas._svg = svg;

      // 고침 칸이 떠 있던 항목 표시를 되살린다
      if (pop) markPopItem();

      if (focusKey) {
        var sel = focusKey.charAt(0) === 'i'
          ? '.pl-map-item[data-id="' + cssEsc(focusKey.slice(2)) + '"]'
          : '.pl-map-node[data-id="' + cssEsc(focusKey.slice(2)) + '"] .pl-map-more';
        var f = canvas.querySelector(sel);
        if (f) f.focus({ preventScroll: true });
      }

      // 드롭 표시는 다시 그리면 사라진다
      dropNode = null;
      return true;
    }
    var pendingFocus = null;

    function cssEsc(v) {
      return window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/["\\]/g, '\\$&');
    }

    /* ---------- 자리 잡기 ---------- */
    // 두 네모 사이의 가장 가까운 틈(가로·세로 중 큰 쪽). 둘 다 m 보다 좁으면 "붙었다".
    function gap(a, b) {
      var gx = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
      var gy = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
      return Math.max(gx, gy);
    }

    function ringRects(hs, ch) {
      var n = hs.length;
      var cr = { x: -CW / 2, y: -ch / 2, w: CW, h: ch };
      var rects = [];
      for (var k = 1; ; k += 0.06) {
        rects = hs.map(function (h, i) {
          var th = (-90 + (i + 0.5) * 360 / n) * Math.PI / 180;
          var cx = 440 * k * Math.cos(th), cy = 310 * k * Math.sin(th);
          return { x: cx - NW / 2, y: cy - h / 2, w: NW, h: h };
        });
        var bad = false;
        for (var i = 0; i < n && !bad; i++) {
          if (gap(rects[i], cr) < 40) bad = true;
          for (var j = i + 1; j < n && !bad; j++) if (gap(rects[i], rects[j]) < 24) bad = true;
        }
        if (!bad || k > 2.5 - 1e-9) break;   // 2.5 까지 올려 보고도 겹치면 그대로 둔다
      }
      return rects;
    }

    function sidesRects(hs) {
      var n = hs.length, r = Math.ceil(n / 2);
      var rects = new Array(n);
      function col(from, to, left) {
        var tot = 0, i;
        for (i = from; i < to; i++) tot += hs[i];
        tot += 20 * Math.max(0, to - from - 1);
        var y = -tot / 2;
        for (i = from; i < to; i++) {
          rects[i] = { x: left ? -(CW / 2 + 110) - NW : CW / 2 + 110, y: y, w: NW, h: hs[i] };
          y += hs[i] + 20;
        }
      }
      col(0, r, false);
      col(r, n, true);
      return rects;
    }

    function linePath(r, ch) {
      var cx = r.x + r.w / 2, cy = r.y + r.h / 2;
      var right = cx >= 0;
      var gx = right ? r.x - CW / 2 : -CW / 2 - (r.x + r.w);
      var x1, y1, x2, y2, d;
      if (gx >= 40) {                         // 옆으로 잇기
        x1 = right ? CW / 2 : -CW / 2; y1 = 0;
        x2 = right ? r.x : r.x + r.w; y2 = r.y + 22;   // 머리 줄 높이
        d = (x2 - x1) / 2;
        return [x1, y1, x1 + d, y1, x2 - d, y2, x2, y2];
      }
      var below = cy >= 0;                    // 위아래로 잇기
      x2 = cx; y2 = below ? r.y : r.y + r.h;
      x1 = clamp(x2 * 0.35, -CW / 2 + 24, CW / 2 - 24);
      y1 = below ? ch / 2 : -ch / 2;
      d = (y2 - y1) / 2;
      return [x1, y1, x1, y1 + d, x2, y2 - d, x2, y2];
    }

    function place() {
      var ch = centerEl.offsetHeight;
      var hs = nodeEls.map(function (n) { return n.offsetHeight; });
      var rects = hs.length ? (effLayout() === 'ring' ? ringRects(hs, ch) : sidesRects(hs)) : [];
      var cr = { x: -CW / 2, y: -ch / 2, w: CW, h: ch };
      var minX = cr.x, minY = cr.y, maxX = cr.x + cr.w, maxY = cr.y + cr.h;
      rects.forEach(function (r) {
        minX = Math.min(minX, r.x); minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x + r.w); maxY = Math.max(maxY, r.y + r.h);
      });
      // 가장 왼쪽·위쪽이 (40,40)이 되게 한꺼번에 민다
      var ox = PAD - minX, oy = PAD - minY;
      W = Math.ceil(maxX - minX + PAD * 2);
      H = Math.ceil(maxY - minY + PAD * 2);
      canvas.style.width = W + 'px';
      canvas.style.height = H + 'px';
      canvas._svg.style.width = W + 'px';
      canvas._svg.style.height = H + 'px';

      cLeft = Math.round(cr.x + ox);
      centerEl.style.left = cLeft + 'px';
      centerEl.style.top = Math.round(cr.y + oy) + 'px';
      center = { x: cLeft + CW / 2, y: Math.round(cr.y + oy) + ch / 2 };

      rects.forEach(function (r, i) {
        nodeEls[i].style.left = Math.round(r.x + ox) + 'px';
        nodeEls[i].style.top = Math.round(r.y + oy) + 'px';
        var p = linePath(r, ch);
        // 좌표는 정수로 둥글리고, 한꺼번에 민 만큼(ox, oy)을 더한다
        var q = p.map(function (v, k) { return Math.round(v + (k % 2 === 0 ? ox : oy)); });
        lineEls[i].setAttribute('d', 'M' + q[0] + ' ' + q[1] + ' C' + q[2] + ' ' + q[3] + ' ' + q[4] + ' ' + q[5] + ' ' + q[6] + ' ' + q[7]);
      });
    }
    /* ---------- 확대·이동 ---------- */
    function applyT() {
      canvas.style.transform = 'translate(' + r2(tx) + 'px,' + r2(ty) + 'px) scale(' + r2(s * 1000) / 1000 + ')';
      zval.textContent = Math.round(s * 100) + '%';
    }

    function fit(first) {
      var vw = view.clientWidth, vh = view.clientHeight - (narrow ? 48 : 0);   // 좁은 화면은 자료함 머리 48px 을 뺀다
      if (first && narrow) {
        // 가운데 카드와 오른쪽 줄이 들어오게. 왼쪽 줄은 밀어서 본다.
        s = clamp((vw - 24) / (CW + 110 + NW), MIN_S, 1);
        tx = 12 - cLeft * s;
        ty = vh / 2 - center.y * s;
      } else {
        s = Math.max(MIN_S, Math.min(1, (vw - 32) / W, (vh - 32) / H));
        tx = (vw - W * s) / 2;
        ty = (vh - H * s) / 2;
      }
      fitted = true;
      applyT();
    }

    function zoomAt(ns, ax, ay) {
      ns = clamp(ns, MIN_S, MAX_S);
      if (ns === s) return;
      tx = ax - (ax - tx) * ns / s;   // 축 아래의 점이 그대로 있게
      ty = ay - (ay - ty) * ns / s;
      s = ns;
      touched = true;
      applyT();
    }

    // 다시 그리고 배치한다. keep 이면 가운데 카드가 화면의 같은 자리에 남도록 tx·ty 를 고친다.
    function redraw(mode) {
      var before = { x: tx + center.x * s, y: ty + center.y * s };
      if (!render()) return;
      pending = false;
      place();
      if (mode === 'fit' || !fitted) fit(true);
      else {
        tx = before.x - center.x * s;
        ty = before.y - center.y * s;
        applyT();
      }
      if (pop) positionPop();
    }

    function syncSeg() {
      var e = effLayout();
      map.setAttribute('data-layout', e);
      Object.keys(segBtns).forEach(function (k) {
        var on = k === e;
        segBtns[k].classList.toggle('pl-on', on);
        segBtns[k].setAttribute('aria-checked', on ? 'true' : 'false');
      });
    }

    /* ---------- 고침 칸 ---------- */
    function itemEl(id) { return canvas.querySelector('.pl-map-item[data-id="' + cssEsc(id) + '"]'); }

    function markPopItem() {
      Array.prototype.forEach.call(canvas.querySelectorAll('.pl-map-item.pl-on'), function (n) { n.classList.remove('pl-on'); });
      var e = itemEl(pop.itemId);
      if (e) e.classList.add('pl-on');
    }

    function positionPop() {
      if (!pop) return;
      var it = itemEl(pop.itemId);
      if (!it) return;
      var ir = it.getBoundingClientRect(), mr = map.getBoundingClientRect();
      var pw = pop.el.offsetWidth || 340, ph = pop.el.offsetHeight;
      var x = ir.left - mr.left, y = ir.bottom - mr.top + 6;   // 항목 아래 6px, 왼쪽 맞춤
      x = Math.max(8, Math.min(x, mr.width - pw - 8));
      if (y + ph > mr.height - 8) {                            // 아래가 모자라면 항목 위로
        var y2 = ir.top - mr.top - 6 - ph;
        y = y2 >= 8 ? y2 : Math.max(8, mr.height - ph - 8);
      }
      pop.el.style.left = Math.round(x) + 'px';
      pop.el.style.top = Math.round(y) + 'px';
    }

    function endPop(p) {
      if (p.done) return;
      p.done = true;
      if (ro) ro.unobserve(p.el);
      var act = document.activeElement;
      var hadFocus = !act || act === document.body || p.el.contains(act);
      if (p.el.parentNode) p.el.parentNode.removeChild(p.el);
      if (pop === p) pop = null;
      var it = itemEl(p.itemId);
      Array.prototype.forEach.call(canvas.querySelectorAll('.pl-map-item.pl-on'), function (n) { n.classList.remove('pl-on'); });
      if (it && hadFocus && !destroyed) it.focus({ preventScroll: true });   // 다른 곳에 초점이 있으면 뺏지 않는다
    }

    function closePop(commit) {
      var p = pop;
      if (!p) return;
      if (p.ctrl && p.ctrl.close) { try { p.ctrl.close(commit); } catch (e) { /* plan.js 쪽 오류가 맵을 막지 않게 */ } }
      endPop(p);
    }

    function openPop(itemId) {
      if (pop && pop.itemId === itemId) return;
      if (pop) closePop(true);
      var plan = core.plan();
      var f = findItem(plan, itemId);
      if (!f) return;
      var info = core.branchInfo(f.branch.id) || {};
      var pe = el('div', 'pl-pop');
      pe.setAttribute('data-kind', f.branch.kind);
      if (f.branch.kind === 'point' && info.pt) pe.setAttribute('data-pt', String(info.pt));
      pe.setAttribute('role', 'dialog');
      pe.setAttribute('aria-label', '항목 고치기');
      map.appendChild(pe);
      var p = { itemId: itemId, el: pe, ctrl: null, done: false };
      pop = p;
      markPopItem();
      var ctrl = core.mountEditor(pe, itemId, function () { endPop(p); });
      p.ctrl = ctrl;
      if (p.done) return;
      if (ro) ro.observe(pe);
      positionPop();
    }

    // 다시 그린 뒤 고침 칸의 항목이 아직 있는지 살핀다
    function syncPop() {
      if (!pop) return;
      var f = findItem(core.plan(), pop.itemId);
      if (!f) { closePop(false); return; }
      var it = itemEl(pop.itemId);
      if (!it) { closePop(true); return; }   // 접힌 카드 안으로 들어간 경우
      var info = core.branchInfo(f.branch.id) || {};
      pop.el.setAttribute('data-kind', f.branch.kind);
      if (f.branch.kind === 'point' && info.pt) pop.el.setAttribute('data-pt', String(info.pt));
      else pop.el.removeAttribute('data-pt');
      markPopItem();
      positionPop();
    }

    /* ---------- 누름 ---------- */
    on(canvas, 'click', function (e) {
      if (suppressClick) { suppressClick = false; return; }   // 끌거나 두 손가락으로 만진 뒤의 click 은 무시
      var t = e.target;
      var more = t.closest('.pl-map-more');
      if (more) {
        var id = more.closest('.pl-map-node').getAttribute('data-id');
        closePop(true);
        if (openSet[id]) delete openSet[id]; else openSet[id] = true;
        pendingFocus = 'm:' + id;
        redraw('keep');   // 높이가 달라지므로 다시 배치. 화면이 튀지 않게 가운데 카드 자리를 지킨다
        return;
      }
      var it = t.closest('.pl-map-item');
      if (it) {
        var iid = it.getAttribute('data-id');
        if (skipOpenId === iid) { skipOpenId = null; return; }   // 열려 있던 같은 항목을 눌러 닫은 경우
        openPop(iid);
        return;
      }
      var hd = t.closest('.pl-map-node-head, .pl-map-thesis');
      if (hd) {
        closePop(true);
        core.gotoOutline({ branchId: hd.closest('.pl-map-node').getAttribute('data-id') });
        return;
      }
      if (t.closest('.pl-map-center')) { closePop(true); core.gotoOutline({ big: true }); }
    });

    on(canvas, 'keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var it = e.target.closest && e.target.closest('.pl-map-item');
      if (it && e.target === it) {
        e.preventDefault();
        openPop(it.getAttribute('data-id'));
      }
    });

    // 고침 칸 밖을 누르면 고친 것을 두고 닫는다
    on(document, 'pointerdown', function (e) {
      skipOpenId = null;
      if (!pop || pop.el.contains(e.target)) return;
      var it = e.target.closest && e.target.closest('.pl-map-item');
      if (it && it.getAttribute('data-id') === pop.itemId) skipOpenId = pop.itemId;
      closePop(true);
    }, true);

    /* ---------- 바탕 끌기·두 손가락 확대 ---------- */
    var ptrs = {};        // 눌려 있는 손가락(터치)
    var pan = null, pinch = null;

    function viewPt(e) {
      var r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function pinchState() {
      var ids = Object.keys(ptrs);
      var a = ptrs[ids[0]], b = ptrs[ids[1]];
      return { d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    }

    on(view, 'pointerdown', function (e) {
      suppressClick = false;
      if (e.pointerType === 'touch') {
        ptrs[e.pointerId] = viewPt(e);
        if (Object.keys(ptrs).length === 2) {
          var st = pinchState();
          pinch = { d0: st.d, s0: s, px: (st.x - tx) / s, py: (st.y - ty) / s };
          pan = null;
          view.classList.remove('pl-panning');
          closePop(true);
          return;
        }
      } else if (e.button !== 0) return;
      // 카드 위에서 시작한 끌기는 화면을 움직이지 않는다
      if (e.target.closest('.pl-map-node, .pl-map-center')) return;
      pan = { id: e.pointerId, x: e.clientX, y: e.clientY, tx0: tx, ty0: ty, moved: false, mouse: e.pointerType !== 'touch' };
      if (pan.mouse) { try { view.setPointerCapture(e.pointerId); } catch (x) { /* 무시 */ } }
    });

    on(view, 'pointermove', function (e) {
      if (e.pointerType === 'touch' && ptrs[e.pointerId]) ptrs[e.pointerId] = viewPt(e);
      if (pinch && Object.keys(ptrs).length >= 2) {
        var st = pinchState();
        var ns = clamp(pinch.s0 * st.d / pinch.d0, MIN_S, MAX_S);
        s = ns;
        tx = st.x - pinch.px * ns;   // 처음 잡은 점이 두 손가락 가운데를 따라가게
        ty = st.y - pinch.py * ns;
        touched = true; suppressClick = true;
        applyT();
        return;
      }
      if (!pan || pan.id !== e.pointerId) return;
      var dx = e.clientX - pan.x, dy = e.clientY - pan.y;
      if (!pan.moved) {
        if (Math.abs(dx) + Math.abs(dy) < 4) return;   // 그냥 누른 것과 가르는 문턱
        pan.moved = true;
        view.classList.add('pl-panning');
        closePop(true);
      }
      tx = pan.tx0 + dx; ty = pan.ty0 + dy;
      touched = true; suppressClick = true;
      applyT();
    });

    function endPtr(e) {
      delete ptrs[e.pointerId];
      if (Object.keys(ptrs).length < 2) pinch = null;
      if (pan && pan.id === e.pointerId) {
        pan = null;
        view.classList.remove('pl-panning');
      }
    }
    on(view, 'pointerup', endPtr);
    on(view, 'pointercancel', endPtr);

    // 휠: 한 칸에 x1.1, 포인터 자리를 축으로. 겹쳐 오는 작은 값은 비례해서 쓴다.
    on(view, 'wheel', function (e) {
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1);
      if (!dy) return;
      closePop(true);
      var p = viewPt(e);
      zoomAt(s * Math.pow(1.1, clamp(-dy / 100, -3, 3)), p.x, p.y);
    }, { passive: false });

    // 보이지 않는 카드에 Tab 으로 초점이 가면 브라우저가 overflow:hidden 칸을 스크롤해 버린다.
    // 이동은 transform 한 곳에서만 하므로 스크롤을 되돌리고, 대신 그 항목이 보이게 옮긴다.
    on(view, 'scroll', function () { view.scrollLeft = 0; view.scrollTop = 0; });
    on(canvas, 'focusin', function (e) {
      var it = e.target.closest && e.target.closest('.pl-map-item, .pl-map-more');
      if (!it) return;
      var vr = view.getBoundingClientRect(), ir = it.getBoundingClientRect();
      var dx = 0, dy = 0;
      if (ir.left < vr.left + 8) dx = vr.left + 8 - ir.left; else if (ir.right > vr.right - 8) dx = vr.right - 8 - ir.right;
      if (ir.top < vr.top + 8) dy = vr.top + 8 - ir.top; else if (ir.bottom > vr.bottom - 8) dy = vr.bottom - 8 - ir.bottom;
      if (dx || dy) { tx += dx; ty += dy; touched = true; applyT(); if (pop) positionPop(); }
    });

    on(view, 'keydown', function (e) {
      if (e.target !== view || e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key, used = true;
      if (k === 'ArrowLeft') tx += 40;
      else if (k === 'ArrowRight') tx -= 40;
      else if (k === 'ArrowUp') ty += 40;
      else if (k === 'ArrowDown') ty -= 40;
      else if (k === '+' || k === '=') zoomAt(s + 0.1, view.clientWidth / 2, view.clientHeight / 2);
      else if (k === '-' || k === '_') zoomAt(s - 0.1, view.clientWidth / 2, view.clientHeight / 2);
      else if (k === '0') fit(false);
      else used = false;
      if (!used) return;
      e.preventDefault();
      closePop(true);
      touched = true;
      applyT();
    });

    on(bOut, 'click', function () { closePop(true); zoomAt(r2(s - 0.1), view.clientWidth / 2, view.clientHeight / 2); });
    on(bIn, 'click', function () { closePop(true); zoomAt(r2(s + 0.1), view.clientWidth / 2, view.clientHeight / 2); });
    on(bFit, 'click', function () { closePop(true); touched = true; fit(false); });

    on(seg, 'click', function (e) {
      var b = e.target.closest('button[data-layout]');
      if (!b || narrow) return;
      var k = b.getAttribute('data-layout');
      if (k === layoutKind) return;
      layoutKind = rememberedLayout = k;
      closePop(true);
      syncSeg();
      touched = true;
      redraw('fit');   // 배치를 바꾸면 한눈에로 다시 맞춘다
    });

    /* ---------- 끌어 놓기 ---------- */
    function dragKind(dt) {
      var ty2 = dt && dt.types ? Array.prototype.slice.call(dt.types) : [];
      if (ty2.indexOf(T_ITEM) >= 0) return 'item';
      if (ty2.indexOf(T_CLIP) >= 0) return 'clip';
      return null;
    }

    function setDrop(node) {
      if (dropNode === node) return;
      if (dropNode) {
        dropNode.classList.remove('pl-drop');
        var e0 = dropNode.querySelector('.pl-map-node-empty');
        if (e0) e0.textContent = '비어 있습니다';
      }
      dropNode = node;
      if (node) {
        node.classList.add('pl-drop');
        var e1 = node.querySelector('.pl-map-node-empty');
        if (e1) {
          var info = core.branchInfo(node.getAttribute('data-id')) || {};
          e1.textContent = '여기에 놓으면 ' + (info.name || info.kindLabel || '') + '에 들어갑니다';
        }
      }
    }

    function clearDrag() {
      setDrop(null);
      Array.prototype.forEach.call(canvas.querySelectorAll('.pl-dragging'), function (n) { n.classList.remove('pl-dragging'); });
      dragItem = null;
    }

    on(canvas, 'dragstart', function (e) {
      var it = e.target.closest && e.target.closest('.pl-map-item');
      if (!it || narrow) { e.preventDefault(); return; }
      var id = it.getAttribute('data-id');
      var f = findItem(core.plan(), id);
      dragItem = { id: id, branchId: f ? f.branch.id : null };
      e.dataTransfer.setData(T_ITEM, id);
      e.dataTransfer.effectAllowed = 'move';
      closePop(true);
      it.classList.add('pl-dragging');
    });

    on(view, 'dragover', function (e) {
      var kind = dragKind(e.dataTransfer);
      if (!kind || narrow) return;
      var node = e.target.closest && e.target.closest('.pl-map-node');
      if (!node) { setDrop(null); return; }   // 가지 카드 밖은 놓을 수 없다
      var bid = node.getAttribute('data-id');
      if (kind === 'item') {
        if (dragItem && dragItem.branchId === bid) { setDrop(null); e.dataTransfer.dropEffect = 'none'; return; }   // 같은 가지는 차례를 바꾸지 않는다
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setDrop(node);
      } else {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        // 한도에 닿았으면 표시를 붙이지 않는다(놓으면 알림만)
        setDrop(core.canAdd() ? node : null);
      }
    });

    on(view, 'dragleave', function (e) {
      if (!e.relatedTarget || !view.contains(e.relatedTarget)) setDrop(null);
    });

    on(view, 'drop', function (e) {
      var kind = dragKind(e.dataTransfer);
      var node = e.target.closest && e.target.closest('.pl-map-node');
      if (!kind || !node || narrow) { clearDrag(); return; }
      e.preventDefault();
      var bid = node.getAttribute('data-id');
      var id = e.dataTransfer.getData(kind === 'item' ? T_ITEM : T_CLIP);
      clearDrag();
      if (!id) return;
      if (kind === 'item') {
        var f = findItem(core.plan(), id);
        if (f && f.branch.id !== bid) core.moveItem(id, bid);
      } else if (core.canAdd()) {
        core.putClip(id, bid);
      } else {
        core.toast('설계도 하나에 항목은 400개까지 넣을 수 있습니다');
      }
    });

    // 끌기가 어디서 끝나든(맵 밖 포함) 표시를 뗀다
    on(document, 'dragend', clearDrag, true);
    on(document, 'drop', function () { setDrop(null); }, true);

    /* ---------- 크기 살피기·글꼴 ---------- */
    var ro = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(function () {
        if (destroyed) return;
        if (pending || !fitted) {
          if (visibleSize()) redraw('fit');   // 보이지 않던 동안 못 한 처음 그리기·맞춤
        } else if (pop) positionPop();
      });
      ro.observe(map);
    }

    // 글꼴이 늦게 뜨면 카드 높이가 달라지므로 한 번 더 배치한다
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (destroyed) return;
        redraw(touched ? 'keep' : 'fit');
      });
    }

    /* ---------- 바깥에 내놓는 것 ---------- */
    syncSeg();
    redraw('fit');

    return {
      refresh: function () {
        if (destroyed) return;
        redraw('keep');
        syncPop();
      },
      setNarrow: function (b) {
        b = !!b;
        if (b === narrow || destroyed) return;
        narrow = b;
        syncSeg();
        redraw('fit');   // 배치가 달라질 수 있어 다시 맞춘다. 고침 칸은 닫지 않고 자리만 다시 잡는다
        syncPop();
      },
      destroy: function () {
        if (destroyed) return;
        if (pop) closePop(false);
        destroyed = true;
        if (ro) { ro.disconnect(); ro = null; }
        offs.forEach(function (f) { f(); });
        offs = [];
        root.textContent = '';
      }
    };
  }

  window.SermonPlanMap = { mount: mount };
})();
