/* plan.js — 설교 설계도 화면 본체(목록·순서 보기·자료함·내보내기). 마인드맵은 plan-map.js 에 맡긴다.
   명세: docs/PLAN_DESIGN.md, docs/PLAN_UI.md, docs/plan-mock.html. 전역은 window.SermonPlan 하나.
   바깥 저장·알림·복사는 모두 host 를 거친다(fetch·localStorage·invoke 직접 호출 없음). */
(function () {
  'use strict';

  var MAX_ITEMS = 400, MAX_TEXT = 4000, MAX_PLANS = 100, MAX_CLIPS = 500, MAX_POINTS = 7;
  var SAVE_DELAY = 800, NARROW_W = 760;

  /* ------------------------------------------------------------ 아이콘(Lucide 모양, 견본과 같다) */
  var P = {
    left: '<path d="m15 18-6-6 6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    plus: '<path d="M5 12h14M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    grip: '<circle cx="9" cy="5" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="9" cy="19" r="1"/><circle cx="15" cy="5" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="15" cy="19" r="1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    book: '<path d="M12 7v14M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"/>',
    share: '<path d="M12 2v13M16 6l-4-4-4 4M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    up: '<path d="m5 12 7-7 7 7M12 19V5"/>',
    dn: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    move: '<path d="m21 16-4 4-4-4M17 20V4M3 8l4-4 4 4M7 4v16"/>',
    copy: '<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
    shelf: '<path d="m16 6 4 14M12 6v14M8 8v12M4 4v16"/>',
    spark: '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0zM20 3v4M22 5h-4"/>'
  };
  function ic(name, cls) {
    return '<svg class="pl-ic' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" aria-hidden="true">' + P[name] + '</svg>';
  }

  /* ------------------------------------------------------------ 작은 도구 */
  var KINDS = { verse: '성경', comm: '주석', lex: '사전', article: '소논문', page: '책', ai: 'AI 연구', memo: '메모', web: '웹', own: '직접' };
  var BRANCH_LABEL = { intro: '서론', outro: '결론', more: '더 공부할 것' };
  var seq = 0;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function uid(p) { seq += 1; return p + Date.now().toString(36) + seq.toString(36) + Math.floor(Math.random() * 1296).toString(36); }
  function P_(v) { return Promise.resolve(v); }           // host 가 동기값을 줘도 Promise 로 맞춘다
  function str(v, n) { v = v == null ? '' : String(v); return n ? v.slice(0, n) : v; }
  function num(n) { return Number(n).toLocaleString('ko-KR'); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtWhen(ms) {
    var d = new Date(ms), n = new Date();
    if (isNaN(d.getTime())) return '';
    if (d.toDateString() === n.toDateString()) return '오늘 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (d.getFullYear() === n.getFullYear()) return (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
    return d.getFullYear() + '년 ' + (d.getMonth() + 1) + '월 ' + d.getDate() + '일';
  }
  function fmtDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return s || '';
    var y = +m[1], mo = +m[2], d = +m[3];
    return y === new Date().getFullYear() ? mo + '월 ' + d + '일' : y + '년 ' + mo + '월 ' + d + '일';
  }
  function hl(text, q) {                                  // 찾은 글자를 <mark> 로 싼다(조각마다 이스케이프)
    if (!q) return esc(text);
    var low = text.toLowerCase(), ql = q.toLowerCase(), out = '', i = 0, j;
    while ((j = low.indexOf(ql, i)) !== -1) {
      out += esc(text.slice(i, j)) + '<mark>' + esc(text.slice(j, j + q.length)) + '</mark>';
      i = j + q.length;
    }
    return out + esc(text.slice(i));
  }
  function autosize(el) {                                 // field-sizing 을 모르는 브라우저용
    if (!el || !el.scrollHeight) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }

  /* ------------------------------------------------------------ 자료 모델 */
  function newItem(o) {
    o = o || {};
    return { id: o.id || uid('i'), text: str(o.text, MAX_TEXT), src: str(o.src, 200), kind: KINDS[o.kind] ? o.kind : 'own',
      link: o.link || null, note: str(o.note, 200), children: [] };
  }
  function newBranch(kind) { return { id: uid('b'), kind: kind, name: '', thesis: '', items: [] }; }
  function defaultBranches() {
    return [newBranch('intro'), newBranch('point'), newBranch('point'), newBranch('point'), newBranch('outro')];
  }
  function normItem(it, top) {
    var o = newItem(it);
    o.id = (it && it.id) || o.id;
    if (top && it && Array.isArray(it.children)) {
      it.children.forEach(function (c) {
        var cc = normItem(c, false); o.children.push(cc);
        // 손자는 두 단계까지만 허용하므로 부모 아래로 편다
        if (c && Array.isArray(c.children)) c.children.forEach(function (g) { o.children.push(normItem(g, false)); });
      });
    }
    return o;
  }
  function normPlan(p) {
    p = p || {};
    var info = p.info || {};
    var plan = {
      id: p.id || ('p' + Date.now()), title: str(p.title), ref: str(p.ref),
      info: { date: str(info.date), place: str(info.place), service: str(info.service), preacher: str(info.preacher) },
      big: str(p.big), branches: [], updated: p.updated || Date.now()
    };
    (Array.isArray(p.branches) ? p.branches : []).forEach(function (b) {
      var kind = BRANCH_LABEL[b && b.kind] || (b && b.kind === 'point') ? b.kind : 'point';
      var nb = { id: (b && b.id) || uid('b'), kind: kind, name: str(b && b.name), thesis: str(b && b.thesis), items: [] };
      ((b && b.items) || []).forEach(function (it) { nb.items.push(normItem(it, true)); });
      plan.branches.push(nb);
    });
    if (!plan.branches.length) plan.branches = defaultBranches();
    return plan;
  }
  function serialize(plan) {                              // 새로 쓰는 중인 빈 항목(_new)은 저장하지 않는다
    function ser(it) {
      return { id: it.id, text: it.text, src: it.src, kind: it.kind, link: it.link, note: it.note,
        children: it.children.filter(function (c) { return !c._new; }).map(ser) };
    }
    return {
      id: plan.id, title: plan.title, ref: plan.ref, info: JSON.parse(JSON.stringify(plan.info)), big: plan.big, updated: plan.updated,
      branches: plan.branches.map(function (b) {
        return { id: b.id, kind: b.kind, name: b.name, thesis: b.thesis, items: b.items.filter(function (i) { return !i._new; }).map(ser) };
      })
    };
  }
  function normClip(c) {
    if (!c) return null;
    var text = str(c.text).trim();
    if (!text) return null;
    return { id: c.id || uid('c'), text: text.slice(0, MAX_TEXT), src: str(c.src, 200), kind: KINDS[c.kind] ? c.kind : 'memo',
      link: c.link || null, note: str(c.note, 200), at: c.at || Date.now() };
  }
  function countItems(plan) {
    var n = 0;
    plan.branches.forEach(function (b) { b.items.forEach(function (i) { n += 1 + i.children.length; }); });
    return n;
  }
  function ptOf(plan, b) {
    var n = 0;
    for (var i = 0; i < plan.branches.length; i++) {
      if (plan.branches[i].kind === 'point') n++;
      if (plan.branches[i] === b) return b.kind === 'point' ? n : 0;
    }
    return 0;
  }
  function kindLabel(plan, b) { return b.kind === 'point' ? '대지 ' + ptOf(plan, b) : BRANCH_LABEL[b.kind]; }
  function dispName(plan, b) { return (b.name || '').trim() || kindLabel(plan, b); }
  function locate(plan, id) {
    for (var bi = 0; bi < plan.branches.length; bi++) {
      var b = plan.branches[bi];
      for (var i = 0; i < b.items.length; i++) {
        var it = b.items[i];
        if (it.id === id) return { b: b, bi: bi, list: b.items, index: i, item: it, parent: null };
        for (var j = 0; j < it.children.length; j++) {
          if (it.children[j].id === id) return { b: b, bi: bi, list: it.children, index: j, item: it.children[j], parent: it };
        }
      }
    }
    return null;
  }
  function itemNo(plan, id) {
    var l = locate(plan, id);
    if (!l) return '';
    if (!l.parent) return (l.bi + 1) + '.' + (l.index + 1);
    return (l.bi + 1) + '.' + (l.b.items.indexOf(l.parent) + 1) + '.' + (l.index + 1);
  }
  function flatIds(plan) {
    var out = [];
    plan.branches.forEach(function (b) { b.items.forEach(function (i) { out.push(i.id); i.children.forEach(function (c) { out.push(c.id); }); }); });
    return out;
  }
  function branchAttrs(plan, b) {
    return 'data-kind="' + b.kind + '"' + (b.kind === 'point' ? ' data-pt="' + ptOf(plan, b) + '"' : '');
  }
  function clipToItem(c) { return newItem({ text: c.text, src: c.src, kind: c.kind, link: c.link, note: c.note }); }
  function sameText(it, c) { return it.text === c.text && it.src === c.src; }

  /* ------------------------------------------------------------ 내보내기 글 */
  function toMarkdown(plan, opt) {
    var max = opt && opt.max;
    var L = [];
    L.push('# ' + (plan.title || '제목 없는 설계도'));
    if (plan.ref) L.push('본문: ' + plan.ref);
    var inf = plan.info || {};
    var parts = [inf.date, inf.service, inf.place, inf.preacher].filter(function (x) { return x; });
    if (parts.length) L.push('설교 정보: ' + parts.join(' · '));
    L.push('');
    if (plan.big) { L.push('**중심 사상**: ' + plan.big); L.push(''); }
    function line(it, no, indent) {
      if (it._new && !it.text) return;
      var t = String(it.text || '').replace(/\s*\n\s*/g, ' ').trim();
      if (max && t.length > max) t = t.slice(0, max) + '…';
      L.push(indent + no + ' ' + t + (it.src ? ' (' + it.src + ')' : ''));
      if (it.note) L.push(indent + '  - 메모: ' + it.note);
    }
    plan.branches.forEach(function (b, bi) {
      var base = kindLabel(plan, b);
      var nm = (b.name || '').trim();
      L.push('## ' + (bi + 1) + '. ' + (nm ? base + ' · ' + nm : base));
      if (b.thesis) L.push(b.thesis);
      b.items.forEach(function (it, i) {
        line(it, (bi + 1) + '.' + (i + 1), '');
        it.children.forEach(function (c, j) { line(c, (bi + 1) + '.' + (i + 1) + '.' + (j + 1), '  '); });
      });
      L.push('');
    });
    return L.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
  }
  var ASK_FIND = '아래 설교 설계도에서 비어 있거나 약한 가지에 넣을 서재 자료(주석·설교·예화)를 가지별로 찾아 출처와 함께 제안해 주세요. 이미 넣은 자료는 되풀이하지 마세요.';
  var ASK_DRAFT = '아래 설교 설계도를 따라 설교 원고 초안을 써 주세요. 설계도의 차례와 자료를 지키고, 넣은 자료의 출처를 밝혀 주세요.';
  function studyNotes(plan, ask) {
    var n = ask + '\n\n' + toMarkdown(plan);
    if (n.length > 6000) n = ask + '\n\n' + toMarkdown(plan, { max: 120 });   // 항목 글을 줄여 다시 만든다
    return n;
  }

  /* ------------------------------------------------------------ 화면 하나(mount 한 번) */
  var current = null;      // 지금 mount 된 화면(clip()이 화면도 고치려고 쓴다)
  var lastPlanId = '';     // mount 된 동안 마지막으로 연 설계도

  function create(root, host) {
    var S = {
      alive: true, view: 'list', plan: null, plans: null, listState: 'loading',
      clips: [], clipsReady: null, tray: null, narrow: false, infoOpen: false,
      save: 'saved', dirty: false, timer: 0, saving: false, savingP: null,
      menu: null, editor: null, drag: null, q: '', draftClip: null, map: null, infoId: uid('pl-info-'),
      mapViewOn: false, clipChain: Promise.resolve(), ro: null, pendingFocus: null
    };
    var web = host && host.kind === 'web';
    root.classList.add('pl-root');
    if (web) root.classList.add('pl-web');
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    function toast(m) { try { host.toast(m); } catch (e) { /* 알림 실패는 무시 */ } }
    function $(sel, from) { return (from || root).querySelector(sel); }
    function $$(sel, from) { return Array.prototype.slice.call((from || root).querySelectorAll(sel)); }
    function announce(msg) {
      var sr = $('.pl-sr');
      if (!sr) return;
      sr.textContent = '';
      setTimeout(function () { sr.textContent = msg; }, 30);
    }
    function trayDefault() { return S.narrow ? 'closed' : 'open'; }
    function setTray(v) {
      S.tray = v;
      root.dataset.tray = v;
      var tg = $('.pl-tray-toggle');
      if (tg) {
        tg.classList.toggle('pl-on', v === 'open');
        tg.setAttribute('aria-pressed', v === 'open' ? 'true' : 'false');
        tg.title = v === 'open' ? '자료함 접기' : '자료함 펴기';
      }
      var cl = $('.pl-tray-close');
      if (cl) {
        cl.setAttribute('aria-expanded', v === 'open' ? 'true' : 'false');
        var t = v === 'open' ? '자료함 접기' : '자료함 펴기';
        cl.setAttribute('aria-label', t); cl.title = t.replace('자료함 ', '');
      }
    }

    /* ---------------------------------------------------- 저장 */
    function saveHTML() {
      if (S.save === 'saving') return '저장 중…';
      if (S.save === 'failed') return '저장하지 못했습니다<button type="button" class="pl-link pl-save-retry">다시 하기</button>';
      return ic('check') + '저장됨';
    }
    function setSave(st) {
      S.save = st;
      var el = $('.pl-save');
      if (el) { el.dataset.state = st; el.innerHTML = saveHTML(); }
    }
    function touch() {                                    // 고친 표시 + 0.8초 뒤 저장
      if (!S.plan) return;
      S.plan.updated = Date.now();
      lastPlanId = S.plan.id;
      S.dirty = true;
      clearTimeout(S.timer);
      S.timer = setTimeout(function () { save(); }, SAVE_DELAY);
    }
    function save() {
      if (S.saving) return S.savingP;
      S.savingP = run();
      return S.savingP;
    }
    async function run() {
      S.saving = true; clearTimeout(S.timer); S.timer = 0;
      var ok = true;
      setSave('saving');
      while (S.dirty && S.plan) {
        S.dirty = false;
        try {
          var r = await P_(host.savePlan(serialize(S.plan)));
          if (r && r.ok === false) throw new Error('save');
        } catch (e) { ok = false; S.dirty = true; break; }
      }
      S.saving = false;
      if (S.alive) setSave(ok ? 'saved' : 'failed');
      return ok;
    }
    async function flush() {
      if (S.saving) await S.savingP;
      if (S.dirty) return save();
      return S.save !== 'failed';
    }

    /* ---------------------------------------------------- 그리기: 목록 */
    function listHTML() {
      var h = '<div class="pl-list"><div class="pl-list-in"><div class="pl-list-head"><div class="pl-grow">' +
        '<h1 class="pl-list-title">설교 설계도</h1><p class="pl-list-sub">찾은 자료를 설교 차례대로 엮습니다.</p></div>';
      var empty = S.listState === 'ok' && !S.plans.length;
      if (S.listState === 'ok' && !empty) h += '<button type="button" class="pl-btn pl-btn-primary pl-new">' + ic('plus') + '새 설계도</button>';
      h += '</div>';
      if (S.listState === 'loading') h += '<p class="pl-list-foot">불러오는 중…</p>';
      else if (S.listState === 'fail') h += '<p class="pl-list-foot">설계도를 불러오지 못했습니다. <button type="button" class="pl-link pl-list-retry">다시 하기</button></p>';
      else if (empty) {
        h += '<div class="pl-empty">' + ic('file') + '<p>아직 설계도가 없습니다. 본문을 정하고 서론·대지·결론에 자료를 놓아 보세요.</p>' +
          '<button type="button" class="pl-btn pl-btn-primary pl-new">' + ic('plus') + '새 설계도</button></div>';
      } else {
        h += '<ul class="pl-plans">';
        S.plans.forEach(function (p) {
          h += '<li class="pl-plan" data-id="' + esc(p.id) + '"><button type="button" class="pl-plan-open">' +
            '<span class="pl-plan-title">' + esc(p.title || '제목 없는 설계도') + '</span>' +
            '<span class="pl-plan-meta"><span class="pl-plan-ref">' + esc(p.ref || '본문 없음') + '</span>' +
            '<span class="pl-plan-when">' + esc(fmtWhen(p.updated)) + ' 고침</span></span></button>' +
            '<button type="button" class="pl-ib pl-ib-danger pl-plan-del" aria-label="설계도 지우기" title="지우기">' + ic('trash') + '</button></li>';
        });
        h += '</ul><p class="pl-list-foot">설계도 ' + S.plans.length + '개</p>';
      }
      return h + '</div></div>';
    }
    function srHTML() { return '<span class="pl-sr" role="status"></span>'; }
    function showList() {
      destroyMap();
      S.view = 'list'; S.plan = null; S.editor = null; S.menu = null; S.listState = 'loading';
      root.dataset.view = 'list';
      root.removeAttribute('data-tray');
      root.innerHTML = listHTML() + srHTML();
      loadList();
    }
    function loadList(force) {
      S.listState = 'loading';
      var token = (S.listToken = (S.listToken || 0) + 1);
      P_(host.listPlans()).then(function (arr) {
        if (!S.alive || token !== S.listToken || S.view !== 'list') return;
        S.plans = (arr || []).slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); });
        S.listState = 'ok';
        root.innerHTML = listHTML() + srHTML();
      }, function () {
        if (!S.alive || token !== S.listToken || S.view !== 'list') return;
        S.listState = 'fail';
        root.innerHTML = listHTML() + srHTML();
      });
      if (S.listState === 'loading') root.innerHTML = listHTML() + srHTML();
    }

    /* ---------------------------------------------------- 그리기: 설계도 */
    function infoSum() {
      var i = S.plan.info;
      if (S.narrow) return i.date ? fmtDate(i.date) : '적어 두기';
      var p = [];
      if (i.date) p.push(fmtDate(i.date));
      if (i.service) p.push(i.service);
      if (i.place) p.push(i.place);
      if (i.preacher) p.push(i.preacher);
      return p.length ? p.join(' · ') : '적어 두기';
    }
    function docHTML() {
      var p = S.plan, i = p.info;
      return '<div class="pl-doc" data-id="' + esc(p.id) + '"><div class="pl-head"><div class="pl-head-row">' +
        '<button type="button" class="pl-ib pl-back" aria-label="설계도 목록으로" title="설계도 목록">' + ic('left') + '</button>' +
        '<input class="pl-bare pl-title" type="text" value="' + esc(p.title) + '" placeholder="설교 제목" aria-label="설교 제목" maxlength="120">' +
        '<span class="pl-save" data-state="' + S.save + '" role="status">' + saveHTML() + '</span>' +
        '<div class="pl-seg pl-views" role="tablist" aria-label="보기">' +
        '<button type="button" role="tab" data-view="outline" class="' + (S.view === 'outline' ? 'pl-on' : '') + '" aria-selected="' + (S.view === 'outline') + '">순서 보기</button>' +
        '<button type="button" role="tab" data-view="map" class="' + (S.view === 'map' ? 'pl-on' : '') + '" aria-selected="' + (S.view === 'map') + '"' +
        (window.SermonPlanMap ? '' : ' aria-disabled="true"') + '>마인드맵</button></div>' +
        '<details class="pl-menu-wrap pl-export"><summary class="pl-btn" aria-label="내보내기">' + ic('share') + '<span>내보내기</span>' + ic('down', 'pl-chev') + '</summary></details>' +
        '<button type="button" class="pl-ib pl-tray-toggle" aria-pressed="false" aria-label="자료함" title="자료함 접기">' + ic('inbox') + '</button>' +
        '</div><div class="pl-head-sub"><label class="pl-ref-field">' + ic('book') +
        '<input class="pl-bare pl-ref" type="text" value="' + esc(p.ref) + '" placeholder="본문  예: 요 15:1-8" aria-label="설교 본문"></label>' +
        '<button type="button" class="pl-info-toggle" aria-expanded="' + S.infoOpen + '" aria-controls="' + S.infoId + '">설교 정보<span class="pl-info-sum">' + esc(infoSum()) + '</span>' + ic('down', 'pl-chev') + '</button></div>' +
        '<div class="pl-info" id="' + S.infoId + '"' + (S.infoOpen ? '' : ' hidden') + '>' +
        '<label class="pl-field"><span>일자</span><input class="pl-input" type="date" data-info="date" value="' + esc(i.date) + '"></label>' +
        '<label class="pl-field"><span>예배</span><input class="pl-input" type="text" data-info="service" value="' + esc(i.service) + '"></label>' +
        '<label class="pl-field"><span>장소</span><input class="pl-input" type="text" data-info="place" value="' + esc(i.place) + '" placeholder="예: 본당"></label>' +
        '<label class="pl-field"><span>설교자</span><input class="pl-input" type="text" data-info="preacher" value="' + esc(i.preacher) + '" placeholder="이름"></label>' +
        '</div></div><div class="pl-body"><div class="pl-main"></div><div class="pl-veil"></div>' + trayHTML() + '</div></div>';
    }
    function showDoc(plan, focusTitle) {
      destroyMap();
      S.plan = S.plan && S.plan.id === plan.id ? S.plan : plan;
      S.plan = plan;
      S.view = 'outline'; S.save = 'saved'; S.dirty = false; S.editor = null; S.menu = null; S.q = ''; S.draftClip = null;
      S.infoOpen = false;
      lastPlanId = plan.id;
      root.dataset.view = 'outline';
      root.innerHTML = docHTML() + srHTML();
      setTray(S.tray || trayDefault());
      renderMain();
      renderClips();
      if (focusTitle) { var t = $('.pl-title'); if (t) t.focus(); }
    }
    function renderMain() {
      if (!S.plan) return;
      destroyMap();
      var main = $('.pl-main');
      if (!main) return;
      if (S.view === 'map') {
        main.innerHTML = '';
        try {
          S.map = window.SermonPlanMap.mount(main, core);
        } catch (e) {
          S.map = null; S.view = 'outline'; toast('마인드맵을 불러오지 못했습니다');
        }
      }
      if (S.view === 'outline') { main.innerHTML = outlineHTML(); autosizeAll(); }
      root.dataset.view = S.view;
      $$('.pl-views > button').forEach(function (b) {
        var on = b.dataset.view === S.view;
        b.classList.toggle('pl-on', on); b.setAttribute('aria-selected', on ? 'true' : 'false');
      });
    }
    function destroyMap() {
      if (S.map) { try { S.map.destroy(); } catch (e) { /* 맵 정리 실패는 무시 */ } S.map = null; }
    }
    function autosizeAll() {
      $$('textarea.pl-bare, .pl-edit-text').forEach(autosize);
    }
    function emptyText() {
      return S.narrow
        ? '아직 넣은 자료가 없습니다. 자료함에서 [넣기]로 넣거나 아래에서 직접 쓰세요.'
        : '아직 넣은 자료가 없습니다. 자료함에서 끌어다 놓거나 아래에서 직접 쓰세요.';
    }
    function outlineHTML() {
      var p = S.plan, bigId = uid('pl-big-');
      var h = '<div class="pl-outline-scroll"><div class="pl-outline"><div class="pl-big" data-kind="big">' +
        '<label class="pl-big-label" for="' + bigId + '">중심 사상</label>' +
        '<textarea class="pl-bare pl-big-text" id="' + bigId + '" rows="1" placeholder="이 설교가 말하려는 한 문장" maxlength="300">' + esc(p.big) + '</textarea></div>';
      var points = p.branches.filter(function (b) { return b.kind === 'point'; }).length;
      p.branches.forEach(function (b, bi) { h += branchHTML(b, bi, points); });
      var hasMore = p.branches.some(function (b) { return b.kind === 'more'; });
      h += '<div class="pl-outline-foot"><button type="button" class="pl-btn pl-btn-quiet pl-add-point"' +
        (points >= MAX_POINTS ? ' disabled title="대지는 7개까지 둘 수 있습니다"' : '') + '>' + ic('plus') + '대지 더하기</button>' +
        '<button type="button" class="pl-btn pl-btn-quiet pl-toggle-more" aria-pressed="' + hasMore + '">' + ic(hasMore ? 'minus' : 'plus') +
        (hasMore ? '더 공부할 것 빼기' : '더 공부할 것 두기') + '</button></div></div></div>';
      return h;
    }
    function branchHTML(b, bi, points) {
      var p = S.plan, kl = kindLabel(p, b), pt = b.kind === 'point' ? ptOf(p, b) : 0;
      var tools = '';
      if (b.kind === 'point') {
        tools = '<button type="button" class="pl-ib pl-branch-up" aria-label="대지를 앞으로" title="앞으로"' + (pt === 1 ? ' disabled' : '') + '>' + ic('up') + '</button>' +
          '<button type="button" class="pl-ib pl-branch-down" aria-label="대지를 뒤로" title="뒤로"' + (pt === points ? ' disabled' : '') + '>' + ic('dn') + '</button>' +
          '<button type="button" class="pl-ib pl-ib-danger pl-branch-del" aria-label="대지 빼기" title="대지 빼기"' + (points <= 1 ? ' disabled' : '') + '>' + ic('trash') + '</button>';
      } else if (b.kind === 'more') {
        tools = '<button type="button" class="pl-ib pl-ib-danger pl-branch-del" aria-label="더 공부할 것 빼기" title="더 공부할 것 빼기">' + ic('trash') + '</button>';
      }
      var h = '<div class="pl-branch" ' + branchAttrs(p, b) + ' data-id="' + esc(b.id) + '"><div class="pl-branch-head">' +
        '<span class="pl-branch-no">' + (bi + 1) + '</span><span class="pl-branch-kind">' + esc(kl) + '</span>' +
        '<input class="pl-bare pl-branch-name" type="text" value="' + esc(b.name) + '" placeholder="이름을 붙여도 됩니다" aria-label="' + esc(kl) + ' 이름" maxlength="80">' +
        '<span class="pl-branch-tools">' + tools + '</span></div>' +
        '<textarea class="pl-bare pl-thesis" rows="1" placeholder="이 가지에서 말할 한 문장" aria-label="' + esc(kl) + '에서 말할 한 문장" maxlength="300">' + esc(b.thesis) + '</textarea>' +
        '<ol class="pl-items">';
      b.items.forEach(function (it, i) { h += itemLI(it, (bi + 1) + '.' + (i + 1), false); });
      h += '</ol>';
      if (!b.items.length) h += '<p class="pl-branch-empty">' + esc(emptyText()) + '</p>';
      return h + '<button type="button" class="pl-add">' + ic('plus') + '항목</button></div>';
    }
    function itemMeta(it) {
      var h = '<span class="pl-kind">' + esc(KINDS[it.kind] || '') + '</span>';
      if (it.src && !(it.kind === 'own' && it.src === '직접')) {
        h += it.link ? '<button type="button" class="pl-src" title="출처 열기">' + esc(it.src) + '</button>' : '<span class="pl-src">' + esc(it.src) + '</span>';
      }
      if (it.note) h += '<span class="pl-note">' + ic('pencil') + esc(it.note) + '</span>';
      return h;
    }
    function rowInner(it, no, editing) {
      var body;
      if (editing) body = editorHTML(it, {});
      else body = '<div class="pl-item-text" tabindex="0" role="button" aria-label="' + no + ' 고치기">' + esc(it.text) + '</div><div class="pl-item-meta">' + itemMeta(it) + '</div>';
      return '<button type="button" class="pl-grip" tabindex="-1" aria-hidden="true">' + ic('grip') + '</button>' +
        '<span class="pl-item-no">' + no + '</span><div class="pl-item-body">' + body + '</div>' +
        (editing ? '<span class="pl-item-tools"></span>' :
          '<span class="pl-item-tools"><details class="pl-menu-wrap pl-move"><summary class="pl-ib" aria-label="옮기기" title="옮기기">' + ic('move') + '</summary></details>' +
          '<button type="button" class="pl-ib pl-ib-danger pl-item-del" aria-label="항목 지우기" title="지우기">' + ic('trash') + '</button></span>');
    }
    function itemLI(it, no, sub) {
      var editing = S.editor && S.editor.type === 'item' && S.editor.id === it.id && !S.editor.pop;
      var h = '<li class="pl-item' + (editing ? ' pl-editing' : '') + '" data-id="' + esc(it.id) + '" data-kind="' + (KINDS[it.kind] ? it.kind : 'own') + '">' +
        '<div class="pl-item-row"' + (!S.narrow && !editing ? ' draggable="true"' : '') + '>' + rowInner(it, no, editing) + '</div>';
      if (!sub && it.children.length) {
        h += '<ol class="pl-items pl-sub">';
        it.children.forEach(function (c, j) { h += itemLI(c, no + '.' + (j + 1), true); });
        h += '</ol>';
      }
      return h + '</li>';
    }
    function editorHTML(m, o) {
      var pop = o && o.pop;
      var left = pop ? (m.link ? '<button type="button" class="pl-link pl-edit-open">출처 열기</button>' : '')
        : '<span class="pl-count' + (m.text.length >= MAX_TEXT ? ' pl-over' : '') + '">' + num(m.text.length) + ' / 4,000자</span>';
      return '<div class="pl-edit"><textarea class="pl-input pl-edit-text" aria-label="글" maxlength="4000" placeholder="여기에 쓰세요">' + esc(m.text) + '</textarea>' +
        '<div class="pl-edit-fields"><label class="pl-field"><span>출처</span><input class="pl-input pl-edit-src" type="text" maxlength="200" value="' + esc(m.src) + '"></label>' +
        '<label class="pl-field"><span>메모</span><input class="pl-input pl-edit-note" type="text" maxlength="200" value="' + esc(m.note) + '" placeholder="예: 예화로"></label></div>' +
        '<div class="pl-edit-actions">' + left + '<span class="pl-grow"></span>' +
        '<button type="button" class="pl-btn pl-btn-quiet pl-edit-cancel">취소</button><button type="button" class="pl-btn pl-edit-done">마침</button></div></div>';
    }

    /* ---------------------------------------------------- 자료함 */
    function trayHTML() {
      var full = S.clips.length >= MAX_CLIPS;
      var dis = full ? ' disabled title="자료함이 가득 찼습니다(500칸)"' : '';
      return '<div class="pl-tray" role="complementary" aria-label="자료함"><div class="pl-tray-head"><b class="pl-tray-title">자료함</b>' +
        '<span class="pl-tray-n">' + S.clips.length + '</span><span class="pl-grow"></span>' +
        '<button type="button" class="pl-ib pl-tray-close" aria-label="자료함 접기" title="접기" aria-expanded="true">' + ic('x', 'pl-when-wide').replace('<svg', S.narrow ? '<svg hidden' : '<svg') +
        ic('down', 'pl-when-narrow').replace('<svg', S.narrow ? '<svg' : '<svg hidden') + '</button></div>' +
        '<div class="pl-tray-tools"><label class="pl-search">' + ic('search') +
        '<input class="pl-input pl-tray-q" type="search" placeholder="자료함에서 찾기" aria-label="자료함에서 찾기" value="' + esc(S.q) + '"></label>' +
        '<div class="pl-tray-acts"><button type="button" class="pl-btn pl-btn-quiet pl-btn-sm pl-clip-new"' + dis + '>' + ic('pencil') + '직접 쓰기</button>' +
        '<button type="button" class="pl-btn pl-btn-quiet pl-btn-sm pl-clip-paste"' + dis + '>' + ic('copy') + '붙여넣기</button></div></div>' +
        '<ul class="pl-clips"></ul><p class="pl-tray-empty" hidden></p></div>';
    }
    function usedBranches(c) {
      var out = [];
      if (!S.plan) return out;
      S.plan.branches.forEach(function (b) {
        var hit = b.items.some(function (i) { return sameText(i, c) || i.children.some(function (k) { return sameText(k, c); }); });
        if (hit) out.push(b);
      });
      return out;
    }
    function usedText(c) {
      var u = usedBranches(c);
      if (!u.length) return { used: false, text: '넣음' };
      return { used: true, text: u.length === 1 ? '넣음 · ' + kindLabel(S.plan, u[0]) : '넣음 · ' + u.length + '곳' };
    }
    function clipLI(c, editing, isDraft) {
      var u = usedText(c);
      var k = KINDS[c.kind] ? c.kind : 'memo';
      var h = '<li class="pl-clip' + (u.used ? ' pl-used' : '') + (editing ? ' pl-editing' : '') + '" data-id="' + esc(c.id) + '" data-kind="' + k + '"' +
        (editing ? '' : ' tabindex="0"') + (!S.narrow && !editing ? ' draggable="true"' : '') + '>';
      if (editing) return h + editorHTML(c, {}) + '</li>';
      var q = S.q.trim();
      h += '<p class="pl-clip-text">' + hl(c.text, q) + '</p><div class="pl-clip-meta"><span class="pl-kind">' + esc(KINDS[k]) + '</span>' +
        '<span class="pl-clip-src">' + hl(c.src || '', q) + '</span></div><div class="pl-clip-foot">' +
        '<span class="pl-used-mark">' + ic('check') + esc(u.text) + '</span><span class="pl-grow"></span>' +
        '<details class="pl-menu-wrap pl-put"><summary class="pl-btn pl-btn-sm">넣기' + ic('down', 'pl-chev') + '</summary></details>' +
        '<button type="button" class="pl-ib pl-ib-danger pl-clip-del" aria-label="자료함에서 지우기" title="자료함에서 지우기">' + ic('trash') + '</button></div></li>';
      return h;
    }
    function renderClips() {
      var ul = $('.pl-clips');
      if (!ul) return;
      var q = S.q.trim(), ql = q.toLowerCase();
      var list = S.clips.slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      if (q) list = list.filter(function (c) { return (c.text + '\n' + c.src).toLowerCase().indexOf(ql) !== -1; });
      var h = '';
      if (S.draftClip) h += clipLI(S.draftClip, true, true);
      list.forEach(function (c) {
        var ed = S.editor && S.editor.type === 'clip' && S.editor.id === c.id;
        h += clipLI(c, ed);
      });
      ul.innerHTML = h;
      var n = $('.pl-tray-n'); if (n) n.textContent = S.clips.length;
      var empty = $('.pl-tray-empty');
      var none = !list.length && !S.draftClip;
      if (empty) {
        empty.hidden = !none;
        empty.textContent = S.clips.length ? '"' + q + '"이 들어간 자료가 없습니다.'
          : '담아 둔 자료가 없습니다. 성경·주석·사전·연구 보고서에서 글을 고르고 "설계도에 담기"를 누르면 여기에 모입니다.';
      }
      var full = S.clips.length >= MAX_CLIPS;
      ['.pl-clip-new', '.pl-clip-paste'].forEach(function (s) {
        var b = $(s); if (!b) return;
        b.disabled = full;
        if (full) b.title = '자료함이 가득 찼습니다(500칸)'; else b.removeAttribute('title');
      });
      $$('.pl-clips textarea').forEach(autosize);
    }
    function updateUsed() {                               // 자료함을 다시 그리지 않고 넣음 표시만 고친다
      $$('.pl-clip').forEach(function (li) {
        var c = S.clips.filter(function (x) { return x.id === li.dataset.id; })[0];
        if (!c) return;
        var u = usedText(c);
        li.classList.toggle('pl-used', u.used);
        var m = $('.pl-used-mark', li);
        if (m) m.innerHTML = ic('check') + esc(u.text);
      });
    }
    function persistClips() {
      var snap = S.clips.map(function (c) { return { id: c.id, text: c.text, src: c.src, kind: c.kind, link: c.link, note: c.note, at: c.at }; });
      S.clipChain = S.clipChain.then(function () { return P_(host.setClips(snap)); }).then(function (r) {
        if (r && r.ok === false) throw new Error('clips');
      }).catch(function () { toast('저장하지 못했습니다'); });
      return S.clipChain;
    }
    function addClipLocal(c) {                            // 같은 글·출처는 다시 넣지 않는다
      if (S.clips.some(function (x) { return x.text === c.text && x.src === c.src; })) return false;
      if (S.clips.length >= MAX_CLIPS) { toast('자료함이 가득 찼습니다(500칸). 쓰지 않는 자료를 지워 주세요.'); return false; }
      S.clips.unshift(c);
      persistClips();
      if (S.view !== 'list') renderClips();
      return true;
    }

    /* ---------------------------------------------------- 설계도 고치기(자료) */
    function refreshAfterChange(opt) {
      opt = opt || {};
      if (S.view === 'outline') {
        var sc = $('.pl-outline-scroll'), top = sc ? sc.scrollTop : 0;
        var main = $('.pl-main');
        main.innerHTML = outlineHTML();
        autosizeAll();
        sc = $('.pl-outline-scroll'); if (sc) sc.scrollTop = top;
      } else if (S.view === 'map' && S.map) {
        try { S.map.refresh(); } catch (e) { /* 맵 다시 그리기 실패는 무시 */ }
      }
      updateUsed();
    }
    function focusItem(id) {
      var el = $('.pl-item[data-id="' + id + '"] > .pl-item-row .pl-item-text');
      if (el) el.focus();
    }
    function limitHit() { toast('설계도 하나에 항목은 400개까지 넣을 수 있습니다'); }
    function removeItemRaw(id) {
      var l = locate(S.plan, id);
      if (!l) return null;
      l.list.splice(l.index, 1);
      return l;
    }
    function insertAt(loc, mode, it) {                    // loc: 기준 항목 위치. mode before|after|child
      if (mode === 'child') loc.item.children.push(it);
      else loc.list.splice(loc.index + (mode === 'after' ? 1 : 0), 0, it);
    }
    function isInside(dragItem, targetId) {
      return dragItem.id === targetId || dragItem.children.some(function (c) { return c.id === targetId; });
    }
    function moveItemTo(dragId, targetId, mode) {         // 항목을 다른 항목의 앞·뒤·아래 단계로
      var dl = locate(S.plan, dragId), tl = locate(S.plan, targetId);
      if (!dl || !tl || isInside(dl.item, targetId)) return false;
      if (mode === 'child' && (tl.parent || dl.item.children.length)) mode = 'after';
      if (tl.parent && dl.item.children.length) return false;
      var it = dl.item;
      dl.list.splice(dl.index, 1);
      tl = locate(S.plan, targetId);
      insertAt(tl, mode, it);
      return true;
    }
    function moveItemToBranch(id, branchId) {
      var l = locate(S.plan, id), b = S.plan.branches.filter(function (x) { return x.id === branchId; })[0];
      if (!l || !b) return false;
      l.list.splice(l.index, 1);
      b.items.push(l.item);
      return true;
    }
    function moveStep(id, dir, cross) {                   // 같은 단계에서 차례 바꾸기. cross 면 가지 끝에서 이웃 가지로
      var l = locate(S.plan, id);
      if (!l) return false;
      var j = l.index + dir;
      if (j >= 0 && j < l.list.length) {
        var t = l.list[j]; l.list[j] = l.item; l.list[l.index] = t;
        return true;
      }
      if (!cross || l.parent) return false;
      var nb = S.plan.branches[l.bi + dir];
      if (!nb) return false;
      l.list.splice(l.index, 1);
      if (dir < 0) nb.items.push(l.item); else nb.items.unshift(l.item);
      return true;
    }
    function canIndent(l) { return l && !l.parent && l.index > 0 && !l.item.children.length; }
    function indent(id) {
      var l = locate(S.plan, id);
      if (!canIndent(l)) return false;
      var prev = l.list[l.index - 1];
      l.list.splice(l.index, 1);
      prev.children.push(l.item);
      return true;
    }
    function outdent(id) {
      var l = locate(S.plan, id);
      if (!l || !l.parent) return false;
      var pl = locate(S.plan, l.parent.id);
      l.list.splice(l.index, 1);
      pl.list.splice(pl.index + 1, 0, l.item);
      return true;
    }
    function changed(focusId, msg) {                      // 차례·내용이 바뀐 뒤의 공통 마무리
      touch();
      refreshAfterChange();
      if (focusId) { focusItem(focusId); if (msg !== false) announce(itemNo(S.plan, focusId) + '으로 옮겼습니다'); }
    }
    async function deleteItem(id) {
      var l = locate(S.plan, id);
      if (!l) return;
      if (l.item.children.length && !(await P_(host.confirm('아래 항목 ' + l.item.children.length + '개도 함께 지워집니다. 지울까요?')))) return;
      var order = flatIds(S.plan), idx = order.indexOf(id);
      var gone = {}; gone[id] = 1; l.item.children.forEach(function (c) { gone[c.id] = 1; });
      var nb = null;
      for (var k = idx + 1; k < order.length && !nb; k++) if (!gone[order[k]]) nb = order[k];
      for (k = idx - 1; k >= 0 && !nb; k--) if (!gone[order[k]]) nb = order[k];
      var bid = l.b.id;
      if (S.editor && gone[S.editor.id]) closeEditorQuiet();
      removeItemRaw(id);
      touch();
      refreshAfterChange();
      toast('항목을 지웠습니다');
      if (S.view === 'outline') {
        if (nb) focusItem(nb);
        else { var a = $('.pl-branch[data-id="' + bid + '"] .pl-add'); if (a) a.focus(); }
      }
    }
    function putClipToBranch(clipId, branchId) {
      var c = S.clips.filter(function (x) { return x.id === clipId; })[0];
      var b = S.plan.branches.filter(function (x) { return x.id === branchId; })[0];
      if (!c || !b) return false;
      if (countItems(S.plan) >= MAX_ITEMS) { limitHit(); return false; }
      b.items.push(clipToItem(c));
      touch();
      refreshAfterChange();
      toast(dispName(S.plan, b) + '에 넣었습니다');
      return true;
    }

    /* ---------------------------------------------------- 고치는 중(항목·자료) */
    function editorFromHolder(h) { return S.editor && S.editor.holder === h ? S.editor : null; }
    function holderEl(el) { return el && el.closest ? el.closest('.pl-pop, .pl-item, .pl-clip') : null; }
    function startItemEdit(id) {
      if (S.editor) commitEditor(true);
      var l = locate(S.plan, id);
      if (!l) return;
      var li = $('.pl-item[data-id="' + id + '"]');
      if (!li) return;
      S.editor = { type: 'item', id: id, holder: li, isNew: !!l.item._new, pop: false };
      li.classList.add('pl-editing');
      var row = $(':scope > .pl-item-row', li) || li.querySelector('.pl-item-row');
      row.removeAttribute('draggable');
      row.innerHTML = rowInner(l.item, itemNo(S.plan, id), true);
      focusEdit(li);
    }
    function startClipEdit(id) {
      if (S.editor) commitEditor(true);
      var c = S.clips.filter(function (x) { return x.id === id; })[0];
      if (!c) return;
      var li = $('.pl-clip[data-id="' + id + '"]');
      if (!li) return;
      S.editor = { type: 'clip', id: id, holder: li, isNew: false };
      li.classList.add('pl-editing'); li.removeAttribute('draggable'); li.removeAttribute('tabindex');
      li.innerHTML = editorHTML(c, {});
      focusEdit(li);
    }
    function focusEdit(h) {
      var t = $('.pl-edit-text', h);
      if (!t) return;
      autosize(t); t.focus();
      t.setSelectionRange(t.value.length, t.value.length);
    }
    function readEdit(h) {
      return { text: $('.pl-edit-text', h).value.slice(0, MAX_TEXT), src: $('.pl-edit-src', h).value, note: $('.pl-edit-note', h).value };
    }
    function closeEditorQuiet() { S.editor = null; }
    function commitEditor(doSave) {                       // 마침(true)·취소(false)
      var ed = S.editor;
      if (!ed) return;
      S.editor = null;
      var onClose = ed.onClose;
      if (ed.type === 'clip') {
        var v = doSave && ed.holder.isConnected ? readEdit(ed.holder) : null;
        if (ed.isNew) {
          S.draftClip = null;
          if (v && v.text.trim()) {
            var nc = normClip({ text: v.text, src: v.src, kind: 'memo', note: v.note });
            S.clips.unshift(nc); persistClips();
          }
        } else if (v) {
          var c = S.clips.filter(function (x) { return x.id === ed.id; })[0];
          if (c) {
            if (!v.text.trim()) { S.clips = S.clips.filter(function (x) { return x !== c; }); persistClips(); toast('자료함에서 지웠습니다'); }
            else { c.text = v.text; c.src = v.src; c.note = v.note; persistClips(); }
          }
        }
        renderClips(); updateUsed();
        return;
      }
      var l = locate(S.plan, ed.id);
      if (!l) { if (onClose) onClose(); return; }
      var val = doSave && ed.holder.isConnected ? readEdit(ed.holder) : null;
      var removed = false;
      if (val) {
        if (!val.text.trim()) { removed = true; }
        else {
          if (val.text !== l.item.text || val.src !== l.item.src || val.note !== l.item.note) {
            l.item.text = val.text; l.item.src = val.src; l.item.note = val.note;
            delete l.item._new; touch();
          }
          delete l.item._new;
        }
      } else if (ed.isNew) removed = true;                // 취소한 새 항목은 조용히 버린다
      if (removed) {
        var existed = !l.item._new && !ed.isNew;
        removeItemRaw(ed.id);
        if (!ed.isNew) touch();
        if (val && existed) toast('항목을 지웠습니다');
        refreshAfterChange();
        if (onClose) onClose();
        return;
      }
      if (ed.pop) { if (S.map) { try { S.map.refresh(); } catch (e) { /* 무시 */ } } updateUsed(); if (onClose) onClose(); return; }
      // 같은 자리만 갈아 끼운다: 바깥을 누른 클릭이 다른 칸에 닿도록 전체를 다시 그리지 않는다
      var li = ed.holder;
      if (li.isConnected) {
        li.classList.remove('pl-editing');
        li.dataset.kind = KINDS[l.item.kind] ? l.item.kind : 'own';
        var row = li.querySelector('.pl-item-row');
        row.innerHTML = rowInner(l.item, itemNo(S.plan, l.item.id), false);
        if (!S.narrow) row.setAttribute('draggable', 'true');
      }
      updateUsed();
    }

    /* ---------------------------------------------------- 차림표 */
    function menuItem(attrs, inner, cls) {
      return '<button type="button" role="menuitem"' + (cls ? ' class="' + cls + '"' : '') + ' ' + attrs + '>' + inner + '</button>';
    }
    function branchRows(exceptId, planOnly) {
      var h = '';
      S.plan.branches.forEach(function (b, i) {
        h += menuItem('data-branch="' + esc(b.id) + '" data-kind="' + b.kind + '"' + (b.kind === 'point' ? ' data-pt="' + ptOf(S.plan, b) + '"' : '') +
          (b.id === exceptId ? ' disabled' : ''), '<i class="pl-dot"></i><span>' + (i + 1) + '. ' + esc(dispName(S.plan, b)) + '</span>');
      });
      return h;
    }
    function menuHTML(wrap) {
      if (wrap.classList.contains('pl-export')) {
        var h = '<div class="pl-menu" role="menu">' +
          menuItem('data-act="copy"', ic('copy') + '<span>글로 복사</span>') +
          menuItem('data-act="md"', ic('file') + '<span>Markdown 파일로 저장</span>');
        if (host.saveSermon) h += menuItem('data-act="sermon"', ic('shelf') + '<span>내 설교 자료실에 넣기</span>');
        h += '<div class="pl-menu-sep"></div><div class="pl-menu-label">AI 본문연구로 보내기</div>' +
          menuItem('data-act="ai-find"', ic('search') + '<span>빈 가지에 넣을 자료 찾기</span>') +
          menuItem('data-act="ai-draft"', ic('spark') + '<span>원고 초안 쓰기</span>') +
          '<div class="pl-menu-note">연구 화면이 열립니다. 거기서 시작을 눌러야 진행됩니다.</div></div>';
        return h;
      }
      if (wrap.classList.contains('pl-put')) {
        return '<div class="pl-menu" role="menu"><div class="pl-menu-label">어느 가지에 넣을까요</div>' + branchRows('') + '</div>';
      }
      var id = wrap.closest('.pl-item').dataset.id, l = locate(S.plan, id);
      if (!l) return '';
      var lastIdx = l.list.length - 1;
      return '<div class="pl-menu" role="menu">' +
        menuItem('data-act="up"' + (l.index === 0 ? ' disabled' : ''), ic('up') + '<span>위로</span>') +
        menuItem('data-act="down"' + (l.index === lastIdx ? ' disabled' : ''), ic('dn') + '<span>아래로</span>') +
        menuItem('data-act="in"' + (canIndent(l) ? '' : ' disabled'), ic('plus') + '<span>윗항목 아래 단계로</span>') +
        menuItem('data-act="out"' + (l.parent ? '' : ' disabled'), ic('left') + '<span>한 단계 밖으로</span>') +
        '<div class="pl-menu-sep"></div><div class="pl-menu-label">다른 가지로</div>' + branchRows(l.b.id) +
        '<div class="pl-menu-sep"></div>' + menuItem('data-act="del"', ic('trash') + '<span>지우기</span>', 'pl-danger') + '</div>';
    }
    function closeMenu(refocus) {
      var w = S.menu;
      if (!w) return;
      S.menu = null;
      var m = w.querySelector('.pl-menu');
      if (m) m.remove();
      w.open = false;
      if (refocus) { var s = w.querySelector('summary'); if (s) s.focus(); }
    }
    function openMenu(wrap) {
      if (S.menu === wrap) { closeMenu(true); return; }
      closeMenu(false);
      var html = menuHTML(wrap);
      if (!html) return;
      wrap.insertAdjacentHTML('beforeend', html);
      wrap.open = true;
      S.menu = wrap;
      var m = wrap.querySelector('.pl-menu');
      var sc = wrap.closest('.pl-outline-scroll, .pl-clips, .pl-map') || root;
      var mr = m.getBoundingClientRect(), sr = sc.getBoundingClientRect(), rr = root.getBoundingClientRect();
      if (mr.bottom > sr.bottom) {
        m.classList.add('pl-up');
        // 위로 열어도 잘리면(좁은 서랍) 아래로 열고 스크롤해서 보여 준다
        if (m.getBoundingClientRect().top < sr.top) { m.classList.remove('pl-up'); m.scrollIntoView({ block: 'nearest' }); }
      }
      if (mr.left < rr.left) m.classList.add('pl-left');
      var first = m.querySelector('button:not(:disabled)');
      if (first) first.focus();
    }
    function menuNav(e, m) {
      var btns = $$('button:not(:disabled)', m), i = btns.indexOf(document.activeElement);
      var n = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : btns.length - 1;
      n = Math.max(0, Math.min(btns.length - 1, n));
      if (btns[n]) btns[n].focus();
      e.preventDefault();
    }
    async function onMenuPick(btn) {
      var wrap = btn.closest('.pl-menu-wrap');
      var act = btn.dataset.act, bid = btn.dataset.branch;
      closeMenu(false);
      if (wrap.classList.contains('pl-export')) return exportAct(act);
      if (wrap.classList.contains('pl-put')) {
        putClipToBranch(wrap.closest('.pl-clip').dataset.id, bid);
        var s = wrap.querySelector('summary'); if (s) s.focus();
        return;
      }
      var id = wrap.closest('.pl-item').dataset.id;
      if (act === 'del') { deleteItem(id); return; }
      var ok = false;
      if (bid) ok = moveItemToBranch(id, bid);
      else if (act === 'up') ok = moveStep(id, -1, false);
      else if (act === 'down') ok = moveStep(id, 1, false);
      else if (act === 'in') ok = indent(id);
      else if (act === 'out') ok = outdent(id);
      if (ok) changed(id);
    }

    /* ---------------------------------------------------- 내보내기 */
    function fileName() {
      var t = (S.plan.title || '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
      return (t || '설교 설계도') + '.md';
    }
    async function exportAct(act) {
      var p = S.plan;
      if (act === 'copy') {
        try {
          var r = await P_(host.copy(toMarkdown(p)));
          toast(r === false ? '복사하지 못했습니다' : '설계도를 복사했습니다');
        } catch (e) { toast('복사하지 못했습니다'); }
      } else if (act === 'md') {
        try {
          var d = await P_(host.download(fileName(), toMarkdown(p)));
          if (d !== false) toast('파일로 저장했습니다');     // 사용자가 저장을 그만두면 false: 알림 없이 넘어간다
        } catch (e) { toast('저장하지 못했습니다'); }
      } else if (act === 'sermon') {
        if (!p.info.date || !p.info.service) {
          S.infoOpen = true; syncInfo();
          toast('설교 정보의 일자와 예배를 적은 뒤 다시 눌러 주세요');
          var f = $('[data-info="' + (!p.info.date ? 'date' : 'service') + '"]'); if (f) f.focus();
          return;
        }
        try {
          var s = await P_(host.saveSermon({ title: p.title, ref: p.ref, date: p.info.date, service: p.info.service, summary: p.big, text: toMarkdown(p) }));
          if (s && s.ok) toast('내 설교 자료실에 초안으로 넣었습니다');
          else if (s && s.error) toast('자료실에 넣지 못했습니다. ' + s.error);   // error 가 비면(덮어쓰기를 그만둠) 알리지 않는다
        } catch (e) { toast('자료실에 넣지 못했습니다. ' + (e && e.message ? e.message : '')); }
      } else if (act === 'ai-find' || act === 'ai-draft') {
        flush();
        try { host.sendToStudy({ ref: p.ref, notes: studyNotes(p, act === 'ai-find' ? ASK_FIND : ASK_DRAFT) }); } catch (e) { /* host 쪽 문제 */ }
      }
    }
    function syncInfo() {
      var t = $('.pl-info-toggle'), box = $('.pl-info');
      if (!t || !box) return;
      t.setAttribute('aria-expanded', S.infoOpen ? 'true' : 'false');
      box.hidden = !S.infoOpen;
      var sm = $('.pl-info-sum', t); if (sm) sm.textContent = infoSum();
    }

    /* ---------------------------------------------------- 마인드맵에 주는 것 */
    var core = {
      plan: function () { return S.plan; },
      narrow: function () { return S.narrow; },
      branchInfo: function (bid) {
        var b = S.plan.branches.filter(function (x) { return x.id === bid; })[0];
        if (!b) return null;
        return { no: S.plan.branches.indexOf(b) + 1, kindLabel: kindLabel(S.plan, b), name: dispName(S.plan, b), kind: b.kind, pt: ptOf(S.plan, b) };
      },
      itemNo: function (id) { return itemNo(S.plan, id); },
      canAdd: function () { return countItems(S.plan) < MAX_ITEMS; },
      moveItem: function (id, bid) {
        if (moveItemToBranch(id, bid)) { touch(); refreshAfterChange(); }
      },
      putClip: function (cid, bid) {
        if (!putClipToBranch(cid, bid)) return;
      },
      mountEditor: function (popEl, itemId, onClose) {
        if (S.editor) commitEditor(true);
        var l = locate(S.plan, itemId);
        if (!l) { if (onClose) onClose(); return { close: function () {} }; }
        var inf = core.branchInfo(l.b.id);
        popEl.innerHTML = '<div class="pl-pop-head"><b>' + esc(itemNo(S.plan, itemId)) + '</b><span>' + esc(inf.kindLabel) + '</span><span class="pl-grow"></span>' +
          '<button type="button" class="pl-ib pl-ib-danger pl-item-del" aria-label="항목 지우기" title="지우기">' + ic('trash') + '</button></div>' +
          editorHTML(l.item, { pop: true });
        var ed = S.editor = { type: 'item', id: itemId, holder: popEl, isNew: false, pop: true, onClose: onClose };
        focusEdit(popEl);
        return { close: function (commit) { if (S.editor === ed) commitEditor(!!commit); } };
      },
      gotoOutline: function (target) {
        if (S.editor) commitEditor(true);
        S.view = 'outline'; renderMain();
        if (target && target.branchId) {
          var br = $('.pl-branch[data-id="' + target.branchId + '"]');
          if (br) { br.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' }); var n = $('.pl-branch-name', br); if (n) n.focus(); }
        } else if (target && target.big) { var b = $('.pl-big-text'); if (b) b.focus(); }
      },
      toast: toast
    };

    /* ---------------------------------------------------- 끌어 놓기(넓은 화면, 순서 보기) */
    function clearDrop() {
      $$('.pl-drop-before, .pl-drop-after, .pl-drop-child').forEach(function (el) {
        el.classList.remove('pl-drop-before', 'pl-drop-after', 'pl-drop-child');
      });
      $$('.pl-branch.pl-drop').forEach(function (el) { el.classList.remove('pl-drop'); });
    }
    function computeDrop(e) {                             // 놓을 자리 하나(없으면 null)
      var d = S.drag;
      if (!d || S.view !== 'outline' || !S.plan) return null;
      if (d.type === 'clip' && countItems(S.plan) >= MAX_ITEMS) return null;
      var t = e.target;
      if (!t || !t.closest) return null;
      var br = t.closest('.pl-branch');
      if (!br) return null;
      var row = t.closest('.pl-item-row');
      var dragItem = d.type === 'item' ? (locate(S.plan, d.id) || {}).item : null;
      if (d.type === 'item' && !dragItem) return null;
      if (!row) return { kind: 'branch', branchId: br.dataset.id, el: br };
      var li = row.parentElement, tid = li.dataset.id, tl = locate(S.plan, tid);
      if (!tl) return null;
      if (dragItem && isInside(dragItem, tid)) return null;
      var r = row.getBoundingClientRect(), body = $('.pl-item-body', row), bl = body ? body.getBoundingClientRect().left : r.left;
      var mode = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
      var hasKids = dragItem && dragItem.children.length;
      if (mode === 'after' && e.clientX > bl + 32 && !tl.parent && !hasKids) mode = 'child';
      if (tl.parent && hasKids) return null;              // 아래 단계 자리에 아래 단계가 있는 항목은 못 놓는다
      return { kind: 'item', targetId: tid, mode: mode, el: li };
    }
    function onDragStart(e) {
      if (S.narrow || !e.target.closest) return;
      var clip = e.target.closest('.pl-clip'), row = e.target.closest('.pl-item-row');
      var type, id, el;
      if (clip && clip.draggable) { type = 'clip'; id = clip.dataset.id; el = clip; }
      else if (row && row.draggable) { type = 'item'; id = row.parentElement.dataset.id; el = row.parentElement; }
      else return;
      S.drag = { type: type, id: id };
      e.dataTransfer.effectAllowed = type === 'clip' ? 'copy' : 'move';
      e.dataTransfer.setData(type === 'clip' ? 'application/x-pl-clip' : 'application/x-pl-item', id);
      setTimeout(function () { el.classList.add('pl-dragging'); }, 0);
    }
    function onDragOver(e) {
      if (!S.drag) return;
      var sc = $('.pl-outline-scroll');
      if (sc && S.view === 'outline') {                   // 가장자리 40px 안이면 천천히 스크롤
        var r = sc.getBoundingClientRect();
        if (e.clientY < r.top + 40) sc.scrollTop -= 10; else if (e.clientY > r.bottom - 40) sc.scrollTop += 10;
      }
      var drop = computeDrop(e);
      clearDrop();
      if (!drop) { if (e.dataTransfer) e.dataTransfer.dropEffect = 'none'; return; }
      e.preventDefault();
      e.dataTransfer.dropEffect = S.drag.type === 'clip' ? 'copy' : 'move';
      if (drop.kind === 'item') drop.el.classList.add('pl-drop-' + drop.mode);
      else drop.el.classList.add('pl-drop');
    }
    function onDrop(e) {
      var d = S.drag, drop = computeDrop(e);
      clearDrop();
      if (!d || !drop) return;
      e.preventDefault();
      S.drag = null;
      if (d.type === 'item') {
        var ok = drop.kind === 'item' ? moveItemTo(d.id, drop.targetId, drop.mode) : moveItemToBranch(d.id, drop.branchId);
        if (ok) changed(d.id);
        return;
      }
      var c = S.clips.filter(function (x) { return x.id === d.id; })[0];
      if (!c) return;
      if (countItems(S.plan) >= MAX_ITEMS) { limitHit(); return; }
      var it = clipToItem(c), name = '';
      if (drop.kind === 'branch') {
        var b = S.plan.branches.filter(function (x) { return x.id === drop.branchId; })[0];
        b.items.push(it); name = dispName(S.plan, b);
      } else {
        var tl = locate(S.plan, drop.targetId);
        insertAt(tl, drop.mode === 'child' && tl.parent ? 'after' : drop.mode, it);
        name = dispName(S.plan, tl.b);
      }
      changed(it.id, false);
      toast(name + '에 넣었습니다');
    }
    function onDragEnd() {
      S.drag = null; clearDrop();
      $$('.pl-dragging').forEach(function (el) { el.classList.remove('pl-dragging'); });
    }

    /* ---------------------------------------------------- 가지 */
    function pointPositions() {
      return S.plan.branches.map(function (b, i) { return b.kind === 'point' ? i : -1; }).filter(function (i) { return i >= 0; });
    }
    function addPoint() {
      var pos = pointPositions();
      if (pos.length >= MAX_POINTS) { toast('대지는 7개까지 둘 수 있습니다'); return; }
      var nb = newBranch('point');
      S.plan.branches.splice(pos[pos.length - 1] + 1, 0, nb);
      touch(); refreshAfterChange();
      var n = $('.pl-branch[data-id="' + nb.id + '"] .pl-branch-name');
      if (n) n.focus();
    }
    async function removeBranch(id) {
      var b = S.plan.branches.filter(function (x) { return x.id === id; })[0];
      if (!b) return;
      var n = b.items.reduce(function (a, i) { return a + 1 + i.children.length; }, 0);
      if (n) {
        var q = b.kind === 'more' ? '더 공부할 것에 항목이 ' + n + '개 있습니다. 빼면 항목도 지워집니다. 뺄까요?'
          : dispName(S.plan, b) + '에 항목이 ' + n + '개 있습니다. 대지를 빼면 항목도 지워집니다. 뺄까요?';
        if (!(await P_(host.confirm(q)))) return;
      }
      if (S.editor) closeEditorQuiet();
      S.plan.branches = S.plan.branches.filter(function (x) { return x !== b; });
      touch(); refreshAfterChange();
    }
    function moveBranch(id, dir) {
      var br = S.plan.branches, pos = pointPositions();
      var i = br.findIndex(function (x) { return x.id === id; }), k = pos.indexOf(i);
      var j = pos[k + dir];
      if (k < 0 || j == null) return false;
      var t = br[i]; br[i] = br[j]; br[j] = t;
      touch(); refreshAfterChange();
      var n = $('.pl-branch[data-id="' + id + '"] .pl-branch-name'); if (n) n.focus();
      return true;
    }
    function toggleMore() {
      var at = S.plan.branches.findIndex(function (b) { return b.kind === 'more'; });
      if (at >= 0) { removeBranch(S.plan.branches[at].id); return; }
      var nb = newBranch('more');
      S.plan.branches.push(nb);
      touch(); refreshAfterChange();
      var n = $('.pl-branch[data-id="' + nb.id + '"] .pl-branch-name'); if (n) n.focus();
    }
    function addItem(branchId) {
      if (countItems(S.plan) >= MAX_ITEMS) { limitHit(); return; }
      var b = S.plan.branches.filter(function (x) { return x.id === branchId; })[0];
      if (!b) return;
      if (S.editor) commitEditor(true);
      var it = newItem({ kind: 'own', src: '직접' });
      it._new = true;
      b.items.push(it);
      refreshAfterChange();
      startItemEdit(it.id);
    }

    /* ---------------------------------------------------- 목록·설계도 열고 닫기 */
    async function openPlan(id, focusTitle) {
      var p = null;
      try { p = await P_(host.getPlan(id)); } catch (e) { p = null; }
      if (!S.alive) return;
      if (!p) { toast('설계도를 불러오지 못했습니다'); return; }
      showDoc(normPlan(p), focusTitle);
    }
    async function createPlan() {
      var list = [];
      try { list = (await P_(host.listPlans())) || []; } catch (e) { list = S.plans || []; }
      if (list.length >= MAX_PLANS) { toast('설계도는 100개까지 둘 수 있습니다. 쓰지 않는 것을 지워 주세요.'); return; }
      var d = host.defaults || {};
      var p = normPlan({ id: 'p' + Date.now(), title: '', ref: '', info: { date: '', place: '', service: d.service || '', preacher: d.preacher || '' },
        big: '', branches: defaultBranches(), updated: Date.now() });
      try {
        var r = await P_(host.savePlan(serialize(p)));
        if (r && r.ok === false) throw new Error('save');
      } catch (e) { toast('저장하지 못했습니다'); return; }
      S.plans = null;
      showDoc(p, true);
    }
    async function backToList() {
      if (S.editor) commitEditor(true);
      var ok = await flush();
      if (!ok && !(await P_(host.confirm('고친 내용을 아직 저장하지 못했습니다. 그래도 나갈까요?')))) return;
      S.dirty = false;
      S.plans = null;
      showList();
    }
    async function deletePlan(id) {
      var p = (S.plans || []).filter(function (x) { return x.id === id; })[0];
      var title = (p && p.title) || '제목 없는 설계도';
      if (!(await P_(host.confirm('"' + title + '" 설계도를 지울까요? 되돌릴 수 없습니다.')))) return;
      try { await P_(host.deletePlan(id)); } catch (e) { toast('지우지 못했습니다'); return; }
      if (lastPlanId === id) lastPlanId = '';
      S.plans = null;
      loadList(true);
    }

    /* ---------------------------------------------------- 이벤트 */
    function onClick(e) {
      var t = e.target;
      if (!t.closest) return;
      var b;
      if ((b = t.closest('summary')) && b.parentElement.classList.contains('pl-menu-wrap')) {
        e.preventDefault(); openMenu(b.parentElement); return;
      }
      if ((b = t.closest('.pl-menu button[role="menuitem"]'))) { if (!b.disabled) onMenuPick(b); return; }
      if (t.closest('.pl-new')) return void createPlan();
      if (t.closest('.pl-list-retry')) return void loadList(true);
      if ((b = t.closest('.pl-plan-del'))) return void deletePlan(b.closest('.pl-plan').dataset.id);
      if ((b = t.closest('.pl-plan-open'))) return void openPlan(b.closest('.pl-plan').dataset.id);
      if (t.closest('.pl-back')) return void backToList();
      if (t.closest('.pl-save-retry')) return void save();
      if ((b = t.closest('.pl-views > button'))) {
        var v = b.dataset.view;
        if (v === S.view) return;
        if (v === 'map' && !window.SermonPlanMap) { toast('마인드맵을 불러오지 못했습니다'); return; }
        if (S.editor) commitEditor(true);
        S.view = v; renderMain();
        return;
      }
      if (t.closest('.pl-info-toggle')) { S.infoOpen = !S.infoOpen; syncInfo(); return; }
      if (t.closest('.pl-tray-toggle')) { setTray(S.tray === 'open' ? 'closed' : 'open'); return; }
      if (t.closest('.pl-veil')) { setTray('closed'); return; }
      if ((b = t.closest('.pl-tray-head'))) {
        if (S.narrow || t.closest('.pl-tray-close')) setTray(S.tray === 'open' ? 'closed' : 'open');
        return;
      }
      if (t.closest('.pl-edit-done')) return void commitEditor(true);
      if (t.closest('.pl-edit-cancel')) return void commitEditor(false);
      if (t.closest('.pl-edit-open')) {
        var ed = S.editor, l = ed && locate(S.plan, ed.id);
        if (l && l.item.link) host.openLink(l.item.link);
        return;
      }
      if ((b = t.closest('.pl-item-del'))) {
        var pop = b.closest('.pl-pop');
        var id = pop ? (S.editor && S.editor.id) : b.closest('.pl-item').dataset.id;
        if (pop && S.editor) { var oc = S.editor.onClose; closeEditorQuiet(); deleteItem(id).then(function () { if (oc) oc(); }); }
        else if (id) deleteItem(id);
        return;
      }
      if ((b = t.closest('.pl-src')) && b.tagName === 'BUTTON') {
        var li = b.closest('.pl-item'), ll = li && locate(S.plan, li.dataset.id);
        if (ll && ll.item.link) host.openLink(ll.item.link);
        return;
      }
      if ((b = t.closest('.pl-item-text'))) {
        var sel = window.getSelection && window.getSelection();
        if (sel && !sel.isCollapsed && String(sel).length) return;    // 글을 긁어 고르는 중이면 고치기로 가지 않는다
        startItemEdit(b.closest('.pl-item').dataset.id);
        return;
      }
      if ((b = t.closest('.pl-add'))) return void addItem(b.closest('.pl-branch').dataset.id);
      if (t.closest('.pl-add-point')) return void addPoint();
      if (t.closest('.pl-toggle-more')) return void toggleMore();
      if ((b = t.closest('.pl-branch-up'))) return void moveBranch(b.closest('.pl-branch').dataset.id, -1);
      if ((b = t.closest('.pl-branch-down'))) return void moveBranch(b.closest('.pl-branch').dataset.id, 1);
      if ((b = t.closest('.pl-branch-del'))) return void removeBranch(b.closest('.pl-branch').dataset.id);
      if (t.closest('.pl-clip-new')) {
        if (S.clips.length >= MAX_CLIPS) { toast('자료함이 가득 찼습니다(500칸). 쓰지 않는 자료를 지워 주세요.'); return; }
        if (S.editor) commitEditor(true);
        S.q = ''; var q = $('.pl-tray-q'); if (q) q.value = '';
        S.draftClip = { id: uid('c'), text: '', src: '직접', kind: 'memo', link: null, note: '', at: Date.now() };
        S.editor = { type: 'clip', id: S.draftClip.id, holder: null, isNew: true };
        renderClips();
        S.editor.holder = $('.pl-clips .pl-clip'); focusEdit(S.editor.holder);
        return;
      }
      if (t.closest('.pl-clip-paste')) return void pasteClip();
      if ((b = t.closest('.pl-clip-del'))) {
        var cid = b.closest('.pl-clip').dataset.id;
        S.clips = S.clips.filter(function (c) { return c.id !== cid; });
        persistClips(); renderClips(); updateUsed(); toast('자료함에서 지웠습니다');
        return;
      }
    }
    async function pasteClip() {
      if (S.clips.length >= MAX_CLIPS) { toast('자료함이 가득 찼습니다(500칸). 쓰지 않는 자료를 지워 주세요.'); return; }
      var text = '';
      try { text = await navigator.clipboard.readText(); }
      catch (e) { toast('클립보드를 읽지 못했습니다. 자료함의 [직접 쓰기]에 붙여 넣어 주세요.'); return; }
      text = String(text || '').trim();
      if (!text) { toast('붙여넣을 글이 없습니다'); return; }
      if (text.length > MAX_TEXT) { text = text.slice(0, MAX_TEXT); toast('한 칸에는 4,000자까지 들어갑니다. 뒷부분을 잘랐습니다.'); }
      addClipLocal(normClip({ text: text, src: '붙여넣기', kind: 'memo' }));
    }
    function onDblClick(e) {
      var li = e.target.closest && e.target.closest('.pl-clip');
      if (!li || li.classList.contains('pl-editing') || e.target.closest('button, summary, .pl-menu')) return;
      startClipEdit(li.dataset.id);
    }
    function onInput(e) {
      var t = e.target;
      if (t.matches('textarea.pl-bare, textarea.pl-input')) autosize(t);
      if (t.classList.contains('pl-edit-text')) {
        var h = holderEl(t), cnt = h && $('.pl-count', h);
        if (cnt) { cnt.textContent = num(t.value.length) + ' / 4,000자'; cnt.classList.toggle('pl-over', t.value.length >= MAX_TEXT); }
        if (e.inputType === 'insertFromPaste' && t.value.length >= MAX_TEXT) toast('한 칸에는 4,000자까지 들어갑니다. 뒷부분을 잘랐습니다.');
        return;
      }
      if (t.classList.contains('pl-tray-q')) { S.q = t.value; renderClips(); return; }
      if (!S.plan) return;
      if (t.classList.contains('pl-title')) { S.plan.title = t.value; touch(); }
      else if (t.classList.contains('pl-ref')) { S.plan.ref = t.value; touch(); }
      else if (t.dataset && t.dataset.info) { S.plan.info[t.dataset.info] = t.value; touch(); syncInfoSum(); }
      else if (t.classList.contains('pl-big-text')) { S.plan.big = t.value; touch(); }
      else if (t.classList.contains('pl-branch-name') || t.classList.contains('pl-thesis')) {
        var b = S.plan.branches.filter(function (x) { return x.id === t.closest('.pl-branch').dataset.id; })[0];
        if (!b) return;
        if (t.classList.contains('pl-thesis')) b.thesis = t.value; else b.name = t.value;
        touch();
      }
    }
    function syncInfoSum() { var sm = $('.pl-info-sum'); if (sm) sm.textContent = infoSum(); }
    function nextAfterField(t) {                          // 한 문장 칸에서 Enter: 칸에서 나와 다음 자리로
      var nxt = null;
      if (t.classList.contains('pl-big-text')) nxt = $('.pl-branch-name');
      else { var br = t.closest('.pl-branch'); nxt = $('.pl-item-text', br) || $('.pl-add', br); }
      if (nxt) nxt.focus(); else t.blur();
    }
    function onKeyDown(e) {
      var t = e.target, k = e.key;
      // 차림표
      var menu = t.closest && t.closest('.pl-menu');
      if (menu) {
        if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') return menuNav(e, menu);
        if (k === 'Escape') { e.preventDefault(); closeMenu(true); return; }
        if (k === 'Tab') closeMenu(false);
        return;
      }
      if (t.matches && t.matches('summary') && t.parentElement.classList.contains('pl-menu-wrap')) {
        if (k === 'ArrowDown') { e.preventDefault(); if (S.menu !== t.parentElement) openMenu(t.parentElement); }
        else if (k === 'Escape' && S.menu) { e.preventDefault(); closeMenu(true); return; }
        else if (k !== 'Escape') return;
      }
      // 고치는 중
      var h = holderEl(t), ed = h && editorFromHolder(h);
      if (ed && t.closest('.pl-edit')) {
        if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); var oc = ed.holder; commitEditor(false); if (oc && oc.isConnected && oc.classList.contains('pl-pop') === false) { /* 초점은 아래에서 */ } focusAfterEdit(ed); return; }
        if (k === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitEditor(true); focusAfterEdit(ed); return; }
        return;
      }
      if (t.classList.contains('pl-tray-q') && k === 'Escape') { t.value = ''; S.q = ''; renderClips(); return; }
      if (k === 'Escape' && S.narrow && S.tray === 'open' && S.view !== 'list') { setTray('closed'); return; }
      if (!S.plan) return;
      if (t.classList.contains('pl-branch-name')) {
        var bid = t.closest('.pl-branch').dataset.id;
        if (k === 'Enter') { e.preventDefault(); var th = $('.pl-thesis', t.closest('.pl-branch')); if (th) th.focus(); }
        else if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) { e.preventDefault(); moveBranch(bid, k === 'ArrowUp' ? -1 : 1); }
        return;
      }
      if ((t.classList.contains('pl-thesis') || t.classList.contains('pl-big-text')) && k === 'Enter' && !e.isComposing) {
        e.preventDefault(); nextAfterField(t); return;
      }
      if (t.classList.contains('pl-item-text')) return itemKey(e, t);
      if (t.classList.contains('pl-clip')) {
        if (k === 'Enter') { e.preventDefault(); var s = $('.pl-put > summary', t); if (s) openMenu(s.parentElement); }
        else if (k === 'Delete') { e.preventDefault(); var d = $('.pl-clip-del', t); if (d) d.click(); }
      }
    }
    function focusAfterEdit(ed) {
      if (ed.pop) return;
      if (ed.type === 'item') focusItem(ed.id);
    }
    function itemKey(e, t) {
      var li = t.closest('.pl-item'), id = li.dataset.id, k = e.key;
      if (k === 'Enter' || k === 'F2') { e.preventDefault(); startItemEdit(id); return; }
      if (k === 'Delete') { e.preventDefault(); deleteItem(id); return; }
      if (k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        var dir = k === 'ArrowUp' ? -1 : 1;
        if (e.altKey) { if (moveStep(id, dir, true)) changed(id); return; }
        var all = $$('.pl-item-text'), i = all.indexOf(t);
        if (all[i + dir]) all[i + dir].focus();
        return;
      }
      if (k === 'Tab') {
        var l = locate(S.plan, id);
        if (!e.shiftKey && canIndent(l)) { e.preventDefault(); if (indent(id)) changed(id); }
        else if (e.shiftKey && l && l.parent) { e.preventDefault(); if (outdent(id)) changed(id); }
      }
    }
    function onDocMouseDown(e) {
      var t = e.target;
      if (S.menu && !(S.menu.contains(t))) closeMenu(false);
      if (S.editor && S.editor.holder && !S.editor.holder.contains(t) && root.contains(t) && !(t.closest && t.closest('.pl-menu'))) {
        // 맵에서는 다른 항목을 열면서 map 이 mountEditor 로 닫으므로 여기서는 열린 칸만 닫는다
        commitEditor(true);
      }
    }

    /* ---------------------------------------------------- 폭 살피기 */
    function applyNarrow(n) {
      if (n === S.narrow) return;
      S.narrow = n;
      if (S.view === 'list' || !S.plan) return;
      setTray(trayDefault());
      $$('.pl-branch-empty').forEach(function (p) { p.textContent = emptyText(); });
      $$('.pl-item-row').forEach(function (r) {
        var editing = r.parentElement.classList.contains('pl-editing');
        if (n || editing) r.removeAttribute('draggable'); else r.setAttribute('draggable', 'true');
      });
      $$('.pl-clip').forEach(function (c) {
        if (n || c.classList.contains('pl-editing')) c.removeAttribute('draggable'); else c.setAttribute('draggable', 'true');
      });
      syncInfoSum();
      var cw = $('.pl-tray-close .pl-when-wide'), cn = $('.pl-tray-close .pl-when-narrow');   // plan.css 의 .pl-ic 가 display 를 덮어 hidden 으로 가린다
      if (cw) cw.toggleAttribute('hidden', n);
      if (cn) cn.toggleAttribute('hidden', !n);
      if (S.map) { try { S.map.setNarrow(n); } catch (e) { /* 무시 */ } }
    }
    function measure() {
      var w = root.clientWidth;
      if (w > 0) applyNarrow(w <= NARROW_W);
    }

    /* ---------------------------------------------------- 연결 */
    var docMD = onDocMouseDown;
    root.addEventListener('click', onClick);
    root.addEventListener('dblclick', onDblClick);
    root.addEventListener('input', onInput);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('dragstart', onDragStart);
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('drop', onDrop);
    root.addEventListener('dragend', onDragEnd);
    root.addEventListener('dragleave', function (e) {
      if (!e.relatedTarget || !root.contains(e.relatedTarget)) clearDrop();
    });
    document.addEventListener('mousedown', docMD, true);
    if (window.ResizeObserver) { S.ro = new ResizeObserver(measure); S.ro.observe(root); }
    measure();

    S.clipsReady = P_(host.getClips()).then(function (arr) {
      S.clips = (arr || []).map(normClip).filter(Boolean);
      if (S.alive && S.view !== 'list') { var n = $('.pl-tray-n'); renderClips(); if (n) n.textContent = S.clips.length; }
    }, function () { S.clips = []; });

    S.api = {
      alive: true,
      open: function (id) { return openPlan(id); },
      unmount: function () {
        if (!S.alive) return;
        if (S.editor) commitEditor(true);
        if (S.dirty && S.plan) { try { host.savePlan(serialize(S.plan)); } catch (e) { /* 이미 떠나는 중 */ } }
        clearTimeout(S.timer);
        S.alive = false; S.api.alive = false;
        destroyMap();
        if (S.ro) S.ro.disconnect();
        document.removeEventListener('mousedown', docMD, true);
        root.removeEventListener('click', onClick); root.removeEventListener('dblclick', onDblClick);
        root.removeEventListener('input', onInput); root.removeEventListener('keydown', onKeyDown);
        root.removeEventListener('dragstart', onDragStart); root.removeEventListener('dragover', onDragOver);
        root.removeEventListener('drop', onDrop); root.removeEventListener('dragend', onDragEnd);
        root.innerHTML = '';
        root.classList.remove('pl-root', 'pl-web');
        root.removeAttribute('data-view'); root.removeAttribute('data-tray');
        if (current === S.api) current = null;
      },
      // clip() 이 화면도 고치도록 열어 주는 것
      ready: function () { return S.clipsReady; },
      getClips: function () { return S.clips; },
      addClip: function (c) { return addClipLocal(c); },
      planId: function () { return S.plan && S.plan.id; },
      putItem: function (branchId, c) {
        var b = S.plan.branches.filter(function (x) { return x.id === branchId; })[0];
        if (!b) return null;
        if (countItems(S.plan) >= MAX_ITEMS) { limitHit(); return null; }
        b.items.push(clipToItem(c));
        touch(); refreshAfterChange();
        return dispName(S.plan, b);
      },
      branches: function () { return S.plan ? S.plan.branches : null; },
      flush: flush
    };
    showList();
    return S.api;
  }

  /* ------------------------------------------------------------ 바깥으로 내놓는 것 */
  function mount(rootEl, host) {
    if (current) current.unmount();
    var api = create(rootEl, host);
    current = api;
    return { open: api.open, unmount: api.unmount };
  }

  async function clip(host, c, target) {
    var cl = normClip(c);
    if (!cl) return { ok: false, where: '' };
    var inst = current && current.alive ? current : null;
    var clips;
    if (inst) { await inst.ready(); clips = inst.getClips(); }
    else { try { clips = ((await P_(host.getClips())) || []).map(normClip).filter(Boolean); } catch (e) { clips = []; } }
    var dup = clips.some(function (x) { return x.text === cl.text && x.src === cl.src; });
    var canAdd = !dup && clips.length < MAX_CLIPS;
    if (!dup && !canAdd && !target) { host.toast('자료함이 가득 찼습니다(500칸). 쓰지 않는 자료를 지워 주세요.'); return { ok: false, where: '' }; }
    var where = 'tray';
    if (target && target.planId) {
      var name = null;
      if (inst && inst.planId() === target.planId) {
        name = inst.putItem(target.branchId, cl);
        if (name == null) return { ok: false, where: '' };
        await inst.flush();
      } else {
        var plan = null;
        try { plan = await P_(host.getPlan(target.planId)); } catch (e) { plan = null; }
        if (!plan) return { ok: false, where: '' };
        plan = normPlan(plan);
        var b = plan.branches.filter(function (x) { return x.id === target.branchId; })[0];
        if (!b) return { ok: false, where: '' };
        if (countItems(plan) >= MAX_ITEMS) { host.toast('설계도 하나에 항목은 400개까지 넣을 수 있습니다'); return { ok: false, where: '' }; }
        b.items.push(clipToItem(cl));
        plan.updated = Date.now();
        try {
          var r = await P_(host.savePlan(serialize(plan)));
          if (r && r.ok === false) throw new Error('save');
        } catch (e) { host.toast('저장하지 못했습니다'); return { ok: false, where: '' }; }
        name = dispName(plan, b);
      }
      where = target.branchId;
      host.toast(name + '에 넣었습니다');
    }
    if (canAdd) {
      if (inst) inst.addClip(cl);
      else { try { await P_(host.setClips([cl].concat(clips))); } catch (e) { if (!target) { host.toast('저장하지 못했습니다'); return { ok: false, where: '' }; } } }
    }
    if (!target) host.toast('자료함에 담았습니다');
    return { ok: true, where: where };
  }

  async function targets(host) {
    var id = current && current.alive && current.planId() || lastPlanId;
    if (!id) {
      try { var l = await P_(host.listPlans()); l = (l || []).slice().sort(function (a, b) { return (b.updated || 0) - (a.updated || 0); }); id = l[0] && l[0].id; }
      catch (e) { id = ''; }
    }
    if (!id) return [];
    var plan = null;
    try { plan = await P_(host.getPlan(id)); } catch (e) { plan = null; }
    if (!plan) return [];
    plan = normPlan(plan);
    return plan.branches.map(function (b, i) { return { planId: plan.id, branchId: b.id, label: (i + 1) + '. ' + dispName(plan, b) }; });
  }

  function basketToClip(item) {
    item = item || {};
    var at = item.at || Date.now();
    var text = String(item.quote || item.title || '').trim();
    var src = ('《' + (item.title || '') + '》 ' + (item.author || '') + ' p.' + item.page).replace(/\s+/g, ' ');
    return { id: 'bk:' + item.book + ':' + item.page + ':' + at, text: text, src: src, kind: 'page',
      link: { t: 'page', book: item.book, page: item.page }, note: item.note || '', at: at };
  }

  window.SermonPlan = {
    mount: mount, clip: clip, targets: targets, toMarkdown: toMarkdown, basketToClip: basketToClip,
    clipButtonLabel: '설계도에 담기'
  };
})();
