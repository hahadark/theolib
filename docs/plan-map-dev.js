/* plan-map-dev.js — 가짜 core 로 SermonPlanMap 을 혼자 돌려 보는 시험용. 앱에는 들어가지 않는다. */
(function () {
  'use strict';

  var LABEL = { intro: '서론', outro: '결론', more: '더 공부할 것' };
  var seq = 100;
  var plan, map = null, full = false, narrow = false;

  var SAMPLES = [
    '바쁘게 섬겼는데 기쁨은 줄어든 한 주를 떠올리게 하기',
    '나는 참포도나무요 내 아버지는 농부라',
    '구약에서 포도나무는 이스라엘을 가리키는 그림이었다. 예수께서 "참"이라 하신 것은 그 자리를 자신이 채우신다는 뜻이다.',
    '주께서 한 포도나무를 애굽에서 가져다가 민족들을 쫓아내시고 그것을 심으셨나이다',
    '내 안에 거하라 나도 너희 안에 거하리라',
    '"거하다"는 머물다, 떠나지 않는다는 뜻이다. 이 단락에서 거듭 나오는 낱말이다.',
    '기도와 말씀을 "해야 할 일"이 아니라 "머무는 자리"로 말하기',
    '4절부터 7절까지 "거하다"가 여러 번 되풀이된다. 명령은 "맺으라"가 아니라 "거하라"이다.',
    '무릇 열매를 맺는 가지는 더 열매를 맺게 하려 하여 그것을 깨끗하게 하시느니라'
  ];

  function item(text, kids) {
    return { id: 'i' + (++seq), text: text, src: '직접', kind: 'own', link: null, note: '', children: (kids || []).map(function (t) { return item(t); }) };
  }

  // 가지 수 n: 1 = 서론만, 2 = 서론·결론, 3 이상 = 서론 + 대지 (n-2) + 결론
  function makePlan(n) {
    var kinds = ['intro'];
    if (n >= 2) { for (var q = 0; q < n - 2; q++) kinds.push('point'); kinds.push('outro'); }
    var bi = 0;
    var branches = kinds.map(function (k, i) {
      var b = { id: 'b' + (i + 1), kind: k, name: '', thesis: '', items: [] };
      if (k === 'point') {
        bi++;
        b.name = ['참포도나무는 예수님이십니다', '붙어 있는 것이 먼저입니다', '아버지는 열매를 위해 손질하십니다'][(bi - 1) % 3];
        b.thesis = '이 대지에서 말할 한 문장 ' + bi;
      }
      if (k === 'intro') b.thesis = '열심히 사는데도 메마른 까닭을 묻습니다';
      if (k === 'outro') b.thesis = '이번 주에 머물 자리 하나를 정합시다';
      return b;
    });
    // 항목 12개쯤: 서론 2, 대지 1 에 2(아래 1 포함), 대지 2 에 5(넘침), 대지 3 에 1, 결론은 비움
    function put(i, arr) { if (branches[i]) arr.forEach(function (a) { branches[i].items.push(a); }); }
    put(0, [item(SAMPLES[0]), item(SAMPLES[1])]);
    put(1, [item(SAMPLES[2], [SAMPLES[3]])]);
    put(2, [item(SAMPLES[4]), item(SAMPLES[5], [SAMPLES[6]]), item(SAMPLES[7]), item('거하는 삶의 모양 하나'), item('마무리 질문')]);
    put(3, [item(SAMPLES[8])]);
    if (n >= 7) put(5, [item('긴 글 시험: ' + new Array(12).join('길게 이어지는 문장입니다 '))]);
    return { id: 'p1', title: '가지는 붙어 있을 때 삽니다', ref: '요 15:1-8', info: {}, big: '열매는 애써 짜내는 것이 아니라 예수님께 붙어 있을 때 맺힙니다', branches: branches, updated: Date.now() };
  }

  function total() { var c = 0; plan.branches.forEach(function (b) { b.items.forEach(function (i) { c += 1 + i.children.length; }); }); return c; }
  function branchOf(id) { return plan.branches.filter(function (b) { return b.id === id; })[0]; }
  function locate(id) {
    for (var i = 0; i < plan.branches.length; i++) {
      var its = plan.branches[i].items;
      for (var j = 0; j < its.length; j++) {
        if (its[j].id === id) return { b: plan.branches[i], list: its, idx: j, it: its[j], top: true };
        for (var k = 0; k < its[j].children.length; k++) {
          if (its[j].children[k].id === id) return { b: plan.branches[i], list: its[j].children, idx: k, it: its[j].children[k], top: false };
        }
      }
    }
    return null;
  }
  function log(t) { document.getElementById('dev-log').textContent = t; }

  var core = {
    plan: function () { return plan; },
    narrow: function () { return narrow; },
    branchInfo: function (id) {
      var n = 0, pt = 0, info = null;
      plan.branches.forEach(function (b) {
        n++;
        if (b.kind === 'point') pt++;
        if (b.id === id) {
          info = { no: n, kind: b.kind, pt: b.kind === 'point' ? pt : 0, kindLabel: b.kind === 'point' ? '대지 ' + pt : LABEL[b.kind] };
          info.name = b.name || info.kindLabel;
        }
      });
      return info;
    },
    itemNo: function (id) {
      for (var i = 0; i < plan.branches.length; i++) {
        var its = plan.branches[i].items;
        for (var j = 0; j < its.length; j++) {
          if (its[j].id === id) return (i + 1) + '.' + (j + 1);
          for (var k = 0; k < its[j].children.length; k++) {
            if (its[j].children[k].id === id) return (i + 1) + '.' + (j + 1) + '.' + (k + 1);
          }
        }
      }
      return '';
    },
    canAdd: function () { return !full && total() < 400; },
    // 가짜 core 는 실제로 반영한 뒤 refresh 를 부른다(plan.js 가 하는 일)
    moveItem: function (id, branchId) {
      var f = locate(id), to = branchOf(branchId);
      if (!f || !to) return;
      f.list.splice(f.idx, 1);
      to.items.push(f.it);   // 아래 단계였던 항목은 윗단계가 된다
      log('moveItem ' + id + ' -> ' + branchId);
      map.refresh();
    },
    putClip: function (clipId, branchId) {
      var to = branchOf(branchId);
      if (!to) return;
      to.items.push(item('자료함에서 넣은 글 (' + clipId + ')'));
      log('putClip ' + clipId + ' -> ' + branchId);
      map.refresh();
    },
    mountEditor: function (pop, id, onClose) {
      var f = locate(id);
      var wrap = document.createElement('div');
      wrap.className = 'dev-ed';
      var head = document.createElement('div');
      head.className = 'pl-pop-head';
      var b = document.createElement('b'); b.textContent = core.itemNo(id);
      var sp = document.createElement('span'); sp.textContent = core.branchInfo(f.b.id).kindLabel;
      var gr = document.createElement('span'); gr.className = 'pl-grow';
      head.appendChild(b); head.appendChild(sp); head.appendChild(gr);
      var edit = document.createElement('div');
      edit.className = 'pl-edit';
      var ta = document.createElement('textarea');
      ta.className = 'pl-input pl-edit-text';
      ta.value = f.it.text;
      ta.setAttribute('aria-label', '글');
      var act = document.createElement('div'); act.className = 'pl-edit-actions';
      var cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'pl-btn pl-btn-quiet pl-edit-cancel'; cancel.textContent = '취소';
      var done = document.createElement('button'); done.type = 'button'; done.className = 'pl-btn pl-edit-done'; done.textContent = '마침';
      var grow = document.createElement('span'); grow.className = 'pl-grow';
      act.appendChild(grow); act.appendChild(cancel); act.appendChild(done);
      edit.appendChild(ta); edit.appendChild(act);
      wrap.appendChild(head); wrap.appendChild(edit);
      pop.appendChild(wrap);
      var closed = false;
      function close(commit) {
        if (closed) return;
        closed = true;
        var g = locate(id);
        if (commit && g && ta.value !== g.it.text) { g.it.text = ta.value; log('고침 ' + id); map.refresh(); }
        onClose();
      }
      done.addEventListener('click', function () { close(true); });
      cancel.addEventListener('click', function () { close(false); });
      ta.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') close(false);
        if (e.key === 'Enter' && e.ctrlKey) close(true);
      });
      ta.focus();
      return { close: close };
    },
    gotoOutline: function (t) { log('gotoOutline ' + JSON.stringify(t)); },
    toast: function (m) { log('toast: ' + m); }
  };

  var main = document.getElementById('dev-main');
  var rootEl = document.getElementById('dev-root');
  var stage = document.getElementById('dev-stage');

  function mountMap() {
    if (map) map.destroy();
    map = window.SermonPlanMap.mount(main, core);
    window.__map = map;
  }

  // plan.js 처럼 뿌리 폭 760px 이하를 "좁음"으로 본다
  var ro = new ResizeObserver(function () {
    var nw = rootEl.clientWidth <= 760;
    if (nw !== narrow) { narrow = nw; if (map) map.setNarrow(nw); }
  });
  ro.observe(rootEl);
  narrow = rootEl.clientWidth <= 760;

  var nBox = document.getElementById('dev-n');
  for (var i = 1; i <= 9; i++) {
    (function (n) {
      var b = document.createElement('button');
      b.type = 'button'; b.textContent = String(n); b.setAttribute('data-n', String(n));
      b.addEventListener('click', function () { setBranches(n); });
      nBox.appendChild(b);
    })(i);
  }
  function setBranches(n) {
    plan = makePlan(n);
    log('가지 ' + n + '개');
    if (map) map.refresh();
  }
  window.__setBranches = setBranches;

  function toggle(btn, fn) {
    btn.addEventListener('click', function () {
      var on = btn.getAttribute('aria-pressed') !== 'true';
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      fn(on);
    });
  }
  // 뿌리 폭이 바뀌면 위의 ResizeObserver 가 setNarrow 를 부른다
  toggle(document.getElementById('dev-narrow'), function (on) { stage.classList.toggle('dev-narrow', on); });
  toggle(document.getElementById('dev-dark'), function (on) { document.documentElement.classList.toggle('dark', on); });
  toggle(document.getElementById('dev-full'), function (on) { full = on; });
  document.getElementById('dev-chip').addEventListener('dragstart', function (e) {
    e.dataTransfer.setData('application/x-pl-clip', 'c1');
    e.dataTransfer.effectAllowed = 'copy';
  });
  document.getElementById('dev-destroy').addEventListener('click', function () { if (map) { map.destroy(); map = null; log('destroy'); } });
  document.getElementById('dev-remount').addEventListener('click', mountMap);

  plan = makePlan(5);
  mountMap();
})();
