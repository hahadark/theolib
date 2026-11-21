// format.js — 글 서식. CSS 변수로 적용하고, 묶음(프리셋)을 localStorage `theolib.ui.v1` 에 저장한다.
// 본문·주소는 저장하지 않는다(설정은 전부 서식·배치 메타데이터뿐).
// 공용 저장소 UIStore(로컬 키 theolib.ui.v1)를 여기서 정의한다. layout.js 가 먼저? 아니,
// 이 파일이 index.html 에서 layout.js 보다 먼저 로드되므로 여기서 정의하고 전역에 노출한다.
(function () {
  'use strict';

  const STORE_KEY = 'theolib.ui.v1';
  window.UIStore = (function () {
    let memo = null;
    return {
      read() {
        if (memo) return memo;
        let o = null;
        try { o = JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch (e) { o = {}; }
        memo = (o && typeof o === 'object') ? o : {};
        return memo;
      },
      write(patch) {
        const o = Object.assign({}, this.read(), patch);
        memo = o;
        try { localStorage.setItem(STORE_KEY, JSON.stringify(o)); } catch (e) { /* 무시 */ }
      },
    };
  })();

  // 앱에 내장한 글꼴(ui/fonts.css). 설치 여부와 상관없이 늘 목록에 나온다.
  const APP_FONTS = ['나눔고딕', '나눔명조', '나눔바른고딕', '나눔스퀘어', '서울한강체', '서울남산체'];

  // 같은 글꼴이 컴퓨터에 영어 이름 등으로 설치돼 있으면 '이 컴퓨터 글꼴'에 또 내보이지 않는다.
  const APP_FONT_ALIASES = {
    '나눔고딕': ['nanumgothic', 'nanumgothicotf', 'nanumgothiclight', 'nanumgothicbold'],
    '나눔명조': ['nanummyeongjo'],
    '나눔바른고딕': ['nanumbarungothic', 'nanumbarungothicotf'],
    '나눔스퀘어': ['nanumsquare'],
    '서울한강체': ['seoulhangang', 'seoulhangangb', 'seoulhangangm'],
    '서울남산체': ['seoulnamsan', 'seoulnamsanb', 'seoulnamsanm'],
  };

  function normFontName(s) {
    return String(s || '').toLowerCase().replace(/[\s_.-]/g, '');
  }

  // 이 이름이 앱 내장 글꼴과 같은 글꼴인가(중복 표시 방지)
  function appFontOf(name) {
    const n = normFontName(name);
    if (!n) return null;
    for (const f of APP_FONTS) {
      if (normFontName(f) === n) return f;
      const al = APP_FONT_ALIASES[f] || [];
      if (al.some((a) => normFontName(a) === n)) return f;
    }
    return null;
  }

  const FONT_CANDIDATES = [
    // 맥·윈도우 공통 시스템 글꼴
    '-apple-system', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Droid Sans Fallback',
    // 흔한 한글 글꼴
    'Nanum Gothic', 'Nanum Myeongjo', 'Noto Sans KR', 'Noto Serif KR', 'Noto Sans CJK KR',
    'KoPub Batang', 'KoPub Dotum', 'Gulim', 'Dotum', 'Batang', 'Gungsuh', 'Gothic', 'Bahnschrift',
    // 서양 글꼴
    'Arial', 'Helvetica', 'Helvetica Neue', 'Times New Roman', 'Georgia', 'Palatino', 'Courier New', 'Verdana', 'Tahoma', 'Trebuchet MS',
    // 헬라어·히브리어(원어) 글꼴
    'Times New Roman', 'SBL Greek', 'SBL BibLit', 'Ezra SIL', 'Ezra SIL SR', 'Cardo', 'Gentium', 'Gentium Plus', 'New Athena Unicode', 'Galatia SIL',
    'SBL Hebrew', 'Noto Sans Hebrew', 'David', 'Frank Ruehl', 'Georgia',
    // 범용
    'serif', 'sans-serif', 'monospace',
  ];

  // 설치 여부: 같은 문자열을 '후보 글꼴'과 '고정폭(fallback)'으로 재어 폭이 다르면 설치된 것으로 본다.
  // 설치 안 된 글꼴은 브라우저가 폴백(fallback)으로 처리하므로 폭이 같게 나온다.
  const _fontProbes = ['mmmmmmmmmmlli', 'iiiiiiiiii', 'WWWWWWWWWW', '가나다라마바사아자차', 'αβγδεζηθικλμν', 'אבגדהוזחטיכלמ'];
  const _fontCanvas = document.createElement('canvas');
  function fontInstalled(name) {
    if (!name) return false;
    if (name === 'serif' || name === 'sans-serif' || name === 'monospace' || name === '-apple-system') return true;
    const ctx = _fontCanvas.getContext('2d');
    let diff = false;
    for (const probe of _fontProbes) {
      ctx.font = '72px monospace';
      const base = ctx.measureText(probe).width;
      ctx.font = '72px ' + JSON.stringify(name) + ', monospace';
      const w = ctx.measureText(probe).width;
      if (Math.abs(w - base) > 0.5) { diff = true; break; }
    }
    return diff;
  }

  // 실제 설치된 글꼴만(중복 제거, 순서 유지). 앱 내장 글꼴과 같은 것은 빼고 돌려준다.
  function availableFonts() {
    const seen = new Set();
    const out = [];
    for (const name of FONT_CANDIDATES) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (appFontOf(name)) continue; // 앱 글꼴로 한 번만 보여 준다
      if (fontInstalled(name)) out.push(name);
    }
    return out;
  }

  // 앱 내장 글꼴 목록(항상 보임)
  function appFonts() { return APP_FONTS.slice(); }

  const TARGETS = [
    { id: 'body', name: '본문' },
    { id: 'note', name: '주석' },
    { id: 'orig', name: '원어(헬라어·히브리어)' },
    { id: 'ui', name: '화면 글자(UI)' },
  ];

  // 절 번호 모양: superscript | bracket | hidden
  const VN_MODES = [
    { id: 'super', name: '위첨자' },
    { id: 'bracket', name: '괄호' },
    { id: 'hidden', name: '숨김' },
  ];

  const DEFAULTS = {
    theme: 'system',   // light | dark | sepia | system
    accent: '#264678', // 검색어 강조색
    searchHl: '#ffe08a',
    lineBreak: true,   // 절마다 줄바꿈
    target: {
      body: { font: '-apple-system', size: 16, line: 1.6, letter: '0em', para: '0.5em', maxW: '46em', align: 'left', vn: 'super' },
      note: { font: '-apple-system', size: 14, line: 1.5, letter: '0em', para: '0.4em', maxW: '40em', align: 'left', vn: 'super' },
      orig: { font: 'Palatino', size: 17, line: 1.7, letter: '0em', para: '0.4em', maxW: '46em', align: 'left', vn: 'super' },
      ui: { font: '-apple-system', size: 15, line: 1.6, letter: '0em', para: '0.5em', maxW: 'none', align: 'left', vn: 'super' },
    },
  };

  function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

  function normalize(s) {
    const d = deepClone(DEFAULTS);
    if (!s || typeof s !== 'object') return d;
    d.theme = s.theme || d.theme;
    d.accent = s.accent || d.accent;
    d.searchHl = s.searchHl || d.searchHl;
    d.lineBreak = !!s.lineBreak;
    for (const t of TARGETS) {
      const src = (s.target && s.target[t.id]) || {};
      const dst = d.target[t.id];
      if (src.font) dst.font = src.font;
      dst.size = +src.size || dst.size;
      dst.line = +src.line || dst.line;
      dst.letter = src.letter != null ? src.letter : dst.letter;
      dst.para = src.para != null ? src.para : dst.para;
      dst.maxW = src.maxW != null ? src.maxW : dst.maxW;
      dst.align = src.align || dst.align;
      dst.vn = src.vn || dst.vn;
    }
    return d;
  }

  const store = {
    fmt: normalize(UIStore.read().fmt),
    presets: {},
    current: '',
    _listeners: [],
  };
  loadPresets();

  function loadPresets() { store.presets = (UIStore.read().fmtPresets) || {}; }

  function svc() {
    UIStore.write({ fmt: store.fmt, fmtPresets: store.presets });
    apply();
    store._listeners.forEach((f) => f());
  }

  function onChange(f) { store._listeners.push(f); }
  function emit() { store._listeners.forEach((f) => f()); }

  // ---- 테마
  function applyTheme() {
    const t = store.fmt.theme;
    document.documentElement.classList.toggle('sepia', false);
    document.documentElement.classList.toggle('dark', false);
    document.documentElement.classList.toggle('light', false);
    if (t === 'dark') document.documentElement.classList.add('dark');
    else if (t === 'sepia') document.documentElement.classList.add('sepia');
    else if (t === 'light') document.documentElement.classList.add('light');
    // system: 클래스 없음 → CSS 는 prefers-color-scheme 을 따른다.
  }

  // ---- CSS 변수
  function apply() {
    const t = store.fmt;
    const r = document.documentElement.style;
    const ui = t.target.ui;
    const cv = {
      // --acc(강조색)는 테마 클래스(:root / html.dark / html.sepia)가 정한다.
      // 여기서 고정값을 덮으면 어두운/세피아 테마에서 강조 글자 대비가 깨진다.
      '--hl': t.searchHl,
      '--ui-font': fontStack(ui.font, 'ui'),
      '--ui-size': ui.size + 'px',
      '--ui-line': ui.line,
      '--ui-letter': ui.letter,
    };
    const TARGET_CLASS = { body: '.fmt-body', note: '.fmt-note', orig: '.fmt-orig' };
    for (const [tgt, cls] of Object.entries(TARGET_CLASS)) {
      const c = t.target[tgt];
      cv['--' + tgt + '-font'] = fontStack(c.font, tgt);
      cv['--' + tgt + '-size'] = c.size + 'px';
      cv['--' + tgt + '-line'] = c.line;
      cv['--' + tgt + '-letter'] = c.letter;
      cv['--' + tgt + '-para'] = c.para;
      cv['--' + tgt + '-maxw'] = c.maxW === 'none' ? 'none' : c.maxW;
      cv['--' + tgt + '-align'] = c.align;
    }
    for (const [k, v] of Object.entries(cv)) r.setProperty(k, v);
    // 저장된 서식이 내장 글꼴이면 곧바로 불러 둔다(기본값은 건드리지 않는다).
    for (const n of [ui.font, t.target.body.font, t.target.note.font, t.target.orig.font]) preloadFont(n);
    applyTheme();
    // 절마다 줄바꿈
    const panes = document.querySelector('#panes');
    if (panes) panes.classList.toggle('fmt-no-lb', !t.lineBreak);
  }

  // 내장 글꼴에는 한글만 들어 있어 그리스어·히브리어 글자가 없다.
  // 그래서 고른 글꼴 뒤에 시스템 대체 글꼴을 이어 붙인다(원어는 특히 그대로 남긴다).
  const FONT_FALLBACKS = {
    body: '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Times New Roman", "SBL Greek", "SBL Hebrew", serif',
    note: '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", "Times New Roman", "SBL Greek", "SBL Hebrew", serif',
    ui: '-apple-system, "Apple SD Gothic Neo", "Malgun Gothic", serif',
    orig: '"Times New Roman", "SBL Greek", "SBL BibLit", "Ezra SIL", "SBL Hebrew", "Noto Sans Hebrew", serif',
  };

  function fontStack(f, targetId) {
    if (!f) return 'sans-serif';
    const f2 = f.trim();
    if (APP_FONTS.includes(f2)) {
      const fb = FONT_FALLBACKS[targetId] || FONT_FALLBACKS.body;
      return `"${f2}", ${fb}`;
    }
    if (/^['"]/.test(f2) || f2 === 'sans-serif' || f2 === 'serif' || f2 === 'monospace') return f2;
    return `'${f2}', sans-serif`;
  }

  // 웹글꼴을 아직 안 불렀어도 고르는 즉시 모양이 바뀌도록 미리 불러 둔다.
  function preloadFont(name) {
    const f = String(name || '').trim();
    const app = appFontOf(f);
    if (!app || !document.fonts || !document.fonts.load) return Promise.resolve();
    return Promise.all([
      document.fonts.load(`16px "${app}"`, '가나다라마바사 ABC abc'),
      document.fonts.load(`700 16px "${app}"`, '가나다라마바사 ABC abc'),
    ]).catch(() => {});
  }

  // ---- 접근자 (패널에서 쓴다)
  function value() { return deepClone(store.fmt); }
  function set(patch) { store.fmt = normalize(Object.assign(store.fmt, patch)); svc(); }
  function target(id) { return deepClone(store.fmt.target[id]); }
  function setTarget(id, patch) { Object.assign(store.fmt.target[id], patch); svc(); }

  // ---- 본문 크기 단축키(패널별)
  function bump(panel, delta) {
    const p = panel && panel.settings && panel.settings.fontScale != null ? panel : null;
    if (p) {
      const cur = p.settings.fontScale || 1;
      p.settings.fontScale = Math.round((cur + delta) * 100) / 100;
      p.saveSettings();
      if (window.UI) window.UI.renderAll();
    } else {
      const t = store.fmt.target.body;
      t.size = Math.max(8, Math.min(72, Math.round(t.size + delta)));
      svc();
    }
    return true;
  }
  function resetSize(panel) {
    const p = panel && panel.settings && panel.settings.fontScale != null ? panel : null;
    if (p) { p.settings.fontScale = 1; p.saveSettings(); if (window.UI) window.UI.renderAll(); }
    else { store.fmt.target.body.size = DEFAULTS.target.body.size; svc(); }
  }

  // ---- 서식 묶음
  function savePreset(name) {
    name = String(name || '').trim();
    if (!name) return false;
    store.presets[name] = deepClone(store.fmt);
    svc();
    return true;
  }
  function loadPreset(name) {
    const p = store.presets[name];
    if (!p) return false;
    store.fmt = normalize(p);
    svc();
    return true;
  }
  function deletePreset(name) { if (store.presets[name]) { delete store.presets[name]; svc(); return true; } return false; }
  function presetNames() { return Object.keys(store.presets); }
  function resetToDefault() { store.fmt = normalize(null); svc(); }

  window.Fmt = {
    FONT_CANDIDATES, APP_FONTS, TARGETS, VN_MODES, DEFAULTS, availableFonts, appFonts, appFontOf, preloadFont,
    value, set, target, setTarget,
    savePreset, loadPreset, deletePreset, presetNames, resetToDefault,
    bump, resetSize, apply, applyTheme, onChange, emit,
  };
})();
