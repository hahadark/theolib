/* plan-dev-host.js — 시험용 host. 이 기기 저장소(localStorage)로 앱·웹 host 를 흉내 낸다. */
(function () {
  'use strict';
  var KP = 'plandev.plans', KC = 'plandev.clips', KS = 'plandev.sermons';
  function rd(k, d) { try { return JSON.parse(localStorage.getItem(k)) || d; } catch (e) { return d; } }
  function wr(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
  var web = /[?&]web=1/.test(location.search);

  function seed() {
    if (localStorage.getItem(KP) !== null) return;
    var now = Date.now();
    function it(id, text, src, kind, extra) { return Object.assign({ id: id, text: text, src: src, kind: kind, link: null, note: '', children: [] }, extra || {}); }
    wr(KP, [{
      id: 'p' + now, title: '가지는 붙어 있을 때 삽니다', ref: '요 15:1-8',
      info: { date: '2026-11-27', place: '', service: '금요기도회', preacher: '' },
      big: '열매는 애써 짜내는 것이 아니라 예수님께 붙어 있을 때 맺힙니다', updated: now,
      branches: [
        { id: 'b1', kind: 'intro', name: '', thesis: '열심히 사는데도 메마른 까닭을 묻습니다', items: [it('i1', '바쁘게 섬겼는데 기쁨은 줄어든 한 주를 떠올리게 하기', '직접', 'own')] },
        { id: 'b2', kind: 'point', name: '참포도나무는 예수님이십니다', thesis: '붙어 있을 곳은 한 분뿐입니다', items: [
          it('i2', '나는 참포도나무요 내 아버지는 농부라', '요 15:1 · 개역개정', 'verse', { link: { t: 'ref', bk: 43, ch: 15, v: 1 } }),
          it('i3', '지어낸 주석 글입니다. 포도나무는 이스라엘의 그림이었다.', '시험 주석 · 요 15:1', 'comm', { children: [it('i4', '시 80:8 의 포도나무', '시 80:8', 'verse')] })] },
        { id: 'b3', kind: 'point', name: '', thesis: '', items: [] },
        { id: 'b4', kind: 'point', name: '', thesis: '', items: [] },
        { id: 'b5', kind: 'outro', name: '', thesis: '', items: [] }
      ]
    }]);
    var c = function (id, text, src, kind, n) { return { id: id, text: text, src: src, kind: kind, link: null, note: '', at: now - n * 1000 }; };
    wr(KC, [
      c('c1', '나는 포도나무요 너희는 가지라 그가 내 안에 거하면 열매를 많이 맺나니', '요 15:5 · 개역개정', 'verse', 1),
      c('c2', '지어낸 주석 글입니다. 포도나무는 이스라엘의 그림이었다.', '시험 주석 · 요 15:1', 'comm', 2),
      c('c3', '메노: 머물다, 거하다, 남아 있다.', '헬라어 사전(시험) · μένω', 'lex', 3),
      c('c4', '"거하다"는 떠나지 않는다는 뜻이다.', '《시험 강해》 p.212', 'page', 4),
      c('c5', '겨울에 가지를 치지 않은 포도나무는 잎만 무성하다.', '포도원 농사(시험)', 'article', 5),
      c('c6', '교회 마당 포도 덩굴, 꺾인 가지가 며칠 만에 말랐다.', '직접', 'memo', 6)
    ]);
  }
  seed();

  function toast(m) {
    var d = document.createElement('div');
    d.className = 'dev-toast'; d.setAttribute('role', 'status'); d.textContent = m;
    document.body.appendChild(d);
    window.__toasts = (window.__toasts || []).concat(m);
    setTimeout(function () { d.remove(); }, 2600);
  }
  window.PLAN_DEV_HOST = {
    kind: web ? 'web' : 'app',
    listPlans: function () { return Promise.resolve(rd(KP, []).map(function (p) { return { id: p.id, title: p.title, ref: p.ref, updated: p.updated }; }).sort(function (a, b) { return b.updated - a.updated; })); },
    getPlan: function (id) { return Promise.resolve(rd(KP, []).filter(function (p) { return p.id === id; })[0] || null); },
    savePlan: function (plan) {
      if (window.__failSave) return Promise.reject(new Error('fail'));
      var l = rd(KP, []), i = l.findIndex(function (p) { return p.id === plan.id; });
      if (i < 0) l.push(plan); else l[i] = plan;
      wr(KP, l); return Promise.resolve({ ok: true });
    },
    deletePlan: function (id) { wr(KP, rd(KP, []).filter(function (p) { return p.id !== id; })); return Promise.resolve({ ok: true }); },
    getClips: function () { return Promise.resolve(rd(KC, [])); },
    setClips: function (c) { wr(KC, c); return Promise.resolve({ ok: true }); },
    openLink: function (l) { window.__lastLink = l; toast('출처 열기: ' + JSON.stringify(l)); },
    sendToStudy: function (o) { window.__lastStudy = o; toast('AI 본문연구로 보냄(' + o.notes.length + '자)'); },
    saveSermon: function (o) { window.__lastSermon = o; wr(KS, rd(KS, []).concat([o])); return Promise.resolve({ ok: true }); },
    download: function (name, text) {
      window.__lastDownload = { name: name, text: text };
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' })); a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      return Promise.resolve(true);
    },
    copy: function (text) { window.__lastCopy = text; return (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).catch(function () { return true; }); },
    toast: toast,
    confirm: function (m) { window.__lastConfirm = m; return Promise.resolve(window.confirm(m)); },
    defaults: { preacher: '', service: '금요기도회' }
  };
})();
