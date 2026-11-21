// dev-mock.js — 브라우저에서 화면만 시험하기 위한 가짜 Tauri.
// window.__TAURI__ 가 없을 때만(순수 브라우저) 아래 mock 을 넣는다.
// 실제 Tauri 앱에서는 __TAURI__ 가 이미 있으므로 아무 일도 하지 않는다.
// 자료는 직접 지어낸 짧은 문장뿐이다(실제 성경·주석 본문 없음).
(function () {
  'use strict';
  if (window.__TAURI__) return;

  const BOOKS = [
    { n: 1, name: '창세기', abbr: '창', en: 'Genesis', ch: 3, alias: [] },
    { n: 44, name: '사도행전', abbr: '행', en: 'Acts', ch: 26, alias: [] },
  ];

  const VERSIONS = [
    { id: '개역개정', name: '개역개정', grp: '한국어', ord: 1, desc: '시험용', kind: 'text', file: 'bible-ko' },
    { id: 'KJV', name: 'KJV', grp: '영어', ord: 2, desc: '시험용', kind: 'text', file: 'bible-en' },
    { id: 'KJV_S', name: 'KJV 원어 번호', grp: '원어 번호 본문', ord: 3, desc: '시험용', kind: 'code', file: 'orig' },
    { id: 'parse', name: '원전 분해', grp: '원어', ord: 4, desc: '시험용', kind: 'parse', file: 'orig' },
  ];

  const VERSES = { 1: ['시험 본문 1절', '시험 본문 2절', '시험 본문 3절'] };

  function textsFor(bk, ch, vers) {
    // 사도행전은 장별로 26절까지 지어낸 본문을 만든다(장 전체 주석 시험용).
    const v = bk === 44 ? Array.from({ length: 26 }, (_, i) => `시험 본문 ${ch}장 ${i + 1}절`) : (VERSES[bk] || ['시험 본문']);
    return v.map((txt, i) => ({
      v: i + 1,
      texts: vers.map((ver) => ({ ver, html: txt + ' <span class="mock">' + ver + '</span>' })),
    }));
  }

  // 주석 가짜 데이터: 장 전체 개요 1개 + 절범위 1개 + 단일절 1개를 섞었다.
  // start_key·end_key 는 장*1000+절.
  const NOTES = [
    // 24장: 장 전체 개요 · 절범위 · 단일절을 같은 절(10절)에 섞었다. start_key·end_key 는 장*1000+절.
    { id: 1, comm: 'karis', comm_name: '카리스종합주석', kind: '강해', title: '24장 전체 흐름', ref: '24장', fmt: 'text', html: '시험용 장 전체 개요. 지어낸 짧은 문장입니다.', start_key: 24000, end_key: 24999, ch1: 24, ch2: 24 },
    { id: 2, comm: 'karis', comm_name: '카리스종합주석', kind: '주해', title: '앞부분 해설', ref: '행 24:1-9', fmt: 'text', html: '시험용 1-9절 해설. 짧은 문장입니다.', start_key: 24001, end_key: 24009, ch1: 24, ch2: 24 },
    { id: 3, comm: 'karis', comm_name: '카리스종합주석', kind: '원어', title: '고개를 끄덕이는', ref: '행 24:10', fmt: 'text', html: '시험용 10절 단일절 해설. <a class="sc" data-c="G5012">G5012</a> 같은 낱말.', start_key: 24010, end_key: 24010, ch1: 24, ch2: 24 },
    { id: 4, comm: 'karis', comm_name: '카리스종합주석', kind: '주해', title: '변론의 흐름', ref: '행 24:10-21', fmt: 'text', html: '시험용 10-21절 해설. 지어낸 문장입니다.', start_key: 24010, end_key: 24021, ch1: 24, ch2: 24 },
    { id: 5, comm: 'karis', comm_name: '카리스종합주석', kind: '주해', title: '가운데 대목', ref: '행 24:11-13', fmt: 'text', html: '시험용 11-13절 해설. 짧습니다.', start_key: 24011, end_key: 24013, ch1: 24, ch2: 24 },
    { id: 6, comm: 'karis', comm_name: '카리스종합주석', kind: '주해', title: '뒷부분 해설', ref: '행 24:22-26', fmt: 'text', html: '시험용 22-26절 해설. 지어낸 문장입니다.', start_key: 24022, end_key: 24026, ch1: 24, ch2: 24 },
    { id: 7, comm: 'ivp', comm_name: 'IVP 성경주석', kind: '주해', title: '시험 주석 둘째 시리즈', ref: '행 24:9-12', fmt: 'text', html: '시험 주석 본문 둘째 시리즈.', start_key: 24009, end_key: 24012, ch1: 24, ch2: 24 },
    { id: 8, comm: 'ivp', comm_name: 'IVP 성경주석', kind: '주해', title: '시험 주석 단일절', ref: '행 24:15', fmt: 'text', html: '시험 주석 15절.', start_key: 24015, end_key: 24015, ch1: 24, ch2: 24 },
    { id: 9, comm: 'esv', comm_name: 'ESV 주석', kind: '주해', title: '시험 주석 셋째 시리즈', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 셋째 시리즈.', start_key: 24010, end_key: 24010, ch1: 24, ch2: 24 },
  ];

  const PARSE = [
    { i: 1, w: 'ταπεινο', code: 'G5012', lemma: 'ταπεινοφροσύνη', tr: 'tapeinophrosynē', parse: 'N-NSF', gloss: '견손' },
    { i: 2, w: 'ἐν', code: 'G1722', lemma: 'ἐν', tr: 'en', parse: 'PREP', gloss: '~안에' },
  ];

  const LEX = {
    G5012: [
      { dict: 'HebGrkKo', code: 'G5012', head: 'ταπεινοφροσύνη', html: '시험 사전 뜻. 겸손한 마음.' },
      { dict: 'HebGrkEn', code: 'G5012', head: 'ταπεινοφροσύνη', html: '시험 사전 뜻. a humble mind.' },
    ],
    G1722: [{ dict: 'HebGrkEn', code: 'G1722', head: 'ἐν', html: '시험 사전 뜻. in, by.' }],
  };

  const ARTICLES = [{ id: 1, series: '시험시리즈', src_name: '시험 출처', section: '신약', title: '시험 소논문 제목', kind: 'article', chars: 12 }];

  // ---- 자료 출처(항목 목록)용 가짜 데이터 (실제와 같은 규모: 총 191항목)
  // 번역본 82(한국어 16·영어 31·원어 3·외국어 32) · 원어 번호 본문 4 · 사전 2 · 주석(작은 시리즈 4 + 책별 33책·66책).
  // 이름은 전부 지어낸 가짜다(실제 성경·주석 본문은 없다).
  function fakeBytes(seed) { return 80000 + ((Math.abs(seed) * 7919) % 90000); }
  function genBible(grp, count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const bytes = fakeBytes(grp.length * 1000 + i);
      const id = 'bible:' + grp + ':' + (i + 1);
      // 기본 선택 힌트: 한국어·영어 앞 3종씩(대표 번역본 흉내)
      const def = (grp === '한국어' && i < 3) || (grp === '영어' && i < 3) ? 1 : 0;
      arr.push({ id, kind: 'bible', name: '가짜 번역본 ' + grp + ' ' + (i + 1), grp, bytes, sha256: id, license: '가짜 근거', db_bytes: Math.round(bytes * 2), default: def });
    }
    return arr;
  }
  function genCode(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const bytes = fakeBytes(50000 + i);
      arr.push({ id: 'code:원어번호:' + (i + 1), kind: 'code', name: '가짜 원어 번호 본문 ' + (i + 1), grp: '원어', bytes, sha256: 'code' + i, license: '가짜 근거', db_bytes: Math.round(bytes * 2) });
    }
    return arr;
  }
  function genLex(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const bytes = 25000 + i * 5000;
      arr.push({ id: 'lex:사전:' + (i + 1), kind: 'lex', name: '가짜 사전 ' + (i + 1), grp: i % 2 ? '원어' : '한글', bytes, sha256: 'lex' + i, license: '가짜 근거', db_bytes: Math.round(bytes * 2) });
    }
    return arr;
  }
  // 작은 주석 시리즈(책별로 나뉘지 않음): 각 1개 항목.
  function genSmallSeries(count) {
    const arr = [];
    for (let i = 0; i < count; i++) {
      const bytes = 100000 + i * 15000;
      arr.push({ id: 'comm:가짜주석:' + (i + 1), kind: 'comm', name: '가짜 주석 ' + (i + 1), grp: '주석', bytes, sha256: 'comm' + i, license: '가짜 근거', db_bytes: Math.round(bytes * 2) });
    }
    return arr;
  }
  // 책별 주석 시리즈: 항목마다 series, bk, book, series_bytes 를 담는다.
  function genBookSeries(sid, name, bkCount) {
    const items = [];
    let total = 0;
    for (let bk = 1; bk <= bkCount; bk++) {
      const bytes = 100000 + ((bk * 6151) % 2000000);
      total += bytes;
      items.push({ id: 'comm:' + sid + ':' + bk, kind: 'comm', name: name + ' · 가짜책 ' + bk, series: sid, series_name: name, bk, book: '가짜책 ' + bk, bytes, sha256: sid + bk, license: '가짜 근거', db_bytes: bytes * 2, series_bytes: 0 });
    }
    for (const it of items) it.series_bytes = total;
    return items;
  }
  const MOCK_FILES = (function build() {
    const out = [];
    out.push(...genBible('한국어', 16), ...genBible('영어', 31), ...genBible('원어', 3), ...genBible('외국어', 32));
    out.push(...genCode(4));
    out.push(...genLex(2));
    out.push(...genSmallSeries(4));
    out.push(...genBookSeries('가짜책별33', '가짜 책별 주석 33', 33));
    out.push(...genBookSeries('가짜책별66', '가짜 책별 주석 66', 66));
    return out;
  })();

  let mockInstalledFiles = ['bible-ko', 'orig', 'comm'];
  // ItemRec 모양(코어 source.rs 와 동일): series·bk·series_name·book 은 ItemRec 에 없다.
  // '받은 자료' 화면 시험용으로 몇 개 받은 상태를 미리 넣는다(일부는 sha256 이 달라 '새 판 있음').
  let mockItems = [
    { id: 'bible:한국어:1', kind: 'bible', name: '가짜 번역본 한국어 1', grp: '한국어', sha256: 'bible:한국어:1', bytes: 80000, db_bytes: 160000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'bible:한국어:2', kind: 'bible', name: '가짜 번역본 한국어 2', grp: '한국어', sha256: 'bible:한국어:2', bytes: 90000, db_bytes: 180000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'bible:영어:1', kind: 'bible', name: '가짜 번역본 영어 1', grp: '영어', sha256: 'bible:영어:1', bytes: 85000, db_bytes: 170000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'code:원어번호:1', kind: 'code', name: '가짜 원어 번호 본문 1', grp: '원어', sha256: 'code0', bytes: 80000, db_bytes: 160000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'lex:사전:1', kind: 'lex', name: '가짜 사전 1', grp: '한글', sha256: 'lex0', bytes: 25000, db_bytes: 50000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'comm:가짜책별66:44', kind: 'comm', name: '가짜 책별 주석 66 · 가짜책 44', grp: '주석', sha256: 'old-sha', bytes: 100000, db_bytes: 200000, license: '가짜 근거', source: 'mock', fts: false },
    { id: 'comm:가짜책별66:45', kind: 'comm', name: '가짜 책별 주석 66 · 가짜책 45', grp: '주석', sha256: '가짜책별6645', bytes: 106000, db_bytes: 212000, license: '가짜 근거', source: 'mock', fts: false },
  ];

  // 마지막 갱신 시각 흉내(브라우저에서 보기 좋게 고정값)
  let mockUpdated = '2026-11-21 23:00';
  function mockSources() { return [{
    origin: 'mock://시험',
    decl: { updated: mockUpdated, note: '시험용 자료입니다.', files: [] },
    installed: mockInstalledFiles,
    sources: [{ origin: 'mock://시험', title: '시험 자료', files: [] }],
    items: mockItems,
  }]; }

  // ---- 책갈피·메모·하이라이트 가짜 저장소(메모리). 코어 user.rs 와 같은 모양을 돌려준다.
  let USER = { bookmarks: [], memos: [], highlights: {} }; // highlights: "bk:ch:v" -> color
  let userSeq = 1;
  function hlRows(bk, ch) {
    const out = [];
    for (const k in USER.highlights) {
      const [b, c, v] = k.split(':').map(Number);
      if (b === bk && c === ch) out.push({ id: 0, bk: b, ch: c, v, color: USER.highlights[k] });
    }
    return out.sort((a, b) => a.v - b.v);
  }

  const FREE_URL = 'mock://free-bundle';

  function mockInvoke(cmd, args) {
    args = args || {};
    let r;
    switch (cmd) {
      case 'sources': r = mockSources(); break;

      case 'free_url': r = FREE_URL; break;

      case 'free_status': r = { installed: mockInstalledFiles.some((f) => f.startsWith('bible')) }; break;

      case 'reinstall_free': {
        // 기본 자료(저작권 만료)를 다시 받는 흉내: 갱신 시각만 바꾼다.
        mockUpdated = '2026-11-21 ' + new Date().toTimeString().slice(0, 5);
        r = null; break;
      }

      case 'preview_source': {
        const url = args.url;
        if (url === FREE_URL) {
          r = { layout: 'items', title: '기본 자료(저작권 자유)', origin: 'mock', updated: '시험일', note: '지어낸 항목 목록입니다.', links: [{ title: '추가 목록(시험)', url: 'mock://bundle-2' }], files: MOCK_FILES };
        } else if (url === 'mock://bundle-2') {
          r = { layout: 'items', title: '추가 목록', origin: 'mock', updated: '시험일', note: '', links: [], files: MOCK_FILES.slice(4, 8) };
        } else {
          r = { layout: '', title: '시험 자료', origin: 'mock', updated: '시험일', note: '', links: [], files: [
            { id: 'bible-ko', bytes: 102400, db_bytes: 204800 },
            { id: 'comm', bytes: 307200, db_bytes: 614400 },
          ] };
        }
        break;
      }

      case 'add_source': {
        const f = MOCK_FILES.filter((x) => (args.files || []).includes(x.id));
        for (const x of f) if (!mockItems.some((i) => i.id === x.id)) mockItems.push({ id: x.id, kind: x.kind, name: x.name, grp: x.grp, sha256: x.sha256, bytes: x.bytes, db_bytes: x.db_bytes, license: x.license, source: 'mock', fts: false });
        r = null; break;
      }

      case 'add_items': {
        const ids = args.ids || [];
        for (const id of ids) { const x = MOCK_FILES.find((m) => m.id === id); if (x && !mockItems.some((i) => i.id === id)) mockItems.push({ id: x.id, kind: x.kind, name: x.name, grp: x.grp, sha256: x.sha256, bytes: x.bytes, db_bytes: x.db_bytes, license: x.license, source: 'mock', fts: false }); }
        mockUpdated = '2026-11-21 ' + new Date().toTimeString().slice(0, 5);
        r = null; break;
      }

      case 'remove_items': {
        const ids = args.ids || [];
        mockItems = mockItems.filter((i) => !ids.includes(i.id));
        r = null; break;
      }

      case 'sync_source': r = []; break;

      case 'remove_source': {
        mockItems = []; mockInstalledFiles = [];
        r = null; break;
      }

      case 'scan_local': {
        r = { items: [
          { id: 'bible:개역개정', kind: 'bible', name: '개역개정', grp: '한국어', bytes: 102400, sha256: 'l1', desc: '내 파일 근거', skip: '' },
          { id: 'comm:내주석', kind: 'comm', name: '내주석', grp: '주석', bytes: 5120, sha256: 'l2', desc: '내 파일 근거', skip: '' },
          { id: 'lex:내사전', kind: 'lex', name: '내사전', grp: '사전', bytes: 2048, sha256: 'l3', desc: '내 파일 근거', skip: '' },
          { id: 'bible:깨진파일', kind: 'bible', name: '깨진파일', grp: '한국어', bytes: 1, sha256: 'l4', desc: '', skip: '형식 오류' },
        ] };
        break;
      }

      case 'import_local': {
        const items = args.items || [];
        const done = [], skipped = [];
        for (const it of items) {
          if (mockItems.some((i) => i.id === it.id) && !args.replace) { skipped.push(it.id); continue; }
          mockItems = mockItems.filter((i) => i.id !== it.id);
          mockItems.push({ id: it.id, kind: it.kind, name: it.name, grp: it.grp, sha256: it.sha256, bytes: it.bytes, db_bytes: it.bytes * 2, license: it.license || '', source: 'mock', fts: false });
          done.push(it.id);
        }
        r = [done, skipped]; break;
      }

      case 'pick_paths': {
        // 브라우저에서 파일 대화상자를 열 수 없으므로, 미리 정해둔 가짜 경로를 돌려준다.
        // (실제 자료 본문은 없고, 화면 흐름만 시험한다)
        r = args.folder ? ['/tmp/가짜-폴더'] : ['/tmp/가짜-자료.bdb'];
        break;
      }

      case 'cancel_download': r = null; break;
      case 'resume_index': r = null; break;
      case 'index_status': r = { ready: true, pending: 0, running: false }; break;

      case 'books': r = BOOKS; break;
      case 'versions': r = VERSIONS; break;
      case 'chapter': r = textsFor(args.bk, args.ch, args.vers || []); break;
      case 'notes': {
        // 실제 코어와 같게: v 가 없으면 장 전체, 있으면 그 절을 포함하는 해설만.
        const ch = args.ch || 24;
        if (args.v == null) { const lo = ch * 1000, hi = lo + 999; r = NOTES.filter((n) => n.start_key <= hi && n.end_key >= lo).map((n) => ({ ...n })); }
        else { const k = args.ch * 1000 + args.v; r = NOTES.filter((n) => n.start_key <= k && n.end_key >= k).map((n) => ({ ...n })); }
        break;
      }
      case 'comm_series': r = [{ id: '카리스종합주석', name: '카리스 종합주석', books: [1,2,3,4,5,6,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66], have: [44] }]; break;
      case 'parse': r = PARSE; break;
      case 'lex': r = LEX[args.code] || []; break;
      case 'set_hidden': r = null; break;
      case 'search_text': r = [{ area: 'bible', src: '개역개정', bk: 44, ch: 24, v: 10, ref_: '행 24:10', note_id: 0, snippet: '시험 [본문] 검색 결과' }]; break;
      case 'goto_ref': r = args.input && /\d/.test(args.input) ? [44, 24, 10] : null; break;
      case 'articles': r = ARTICLES; break;
      case 'article_body': r = '시험 소논문 본문입니다.<br>둘째 줄.'; break;

      case 'user_list': {
        // 코어와 같은 모양: 책갈피는 전부, 메모는 bk(및 ch>0 이면 ch)로 거르고, 하이라이트는 bk·ch 정확히.
        r = {
          bookmarks: USER.bookmarks.slice(),
          memos: USER.memos.filter((x) => x.bk === args.bk && (args.ch === 0 || x.ch === args.ch)),
          highlights: hlRows(args.bk, args.ch),
        };
        break;
      }
      case 'bookmark_add': {
        const id = userSeq++;
        USER.bookmarks.push({ id, bk: args.bk, ch: args.ch, v: args.v, label: args.label || '', created: '시험시각' });
        r = id; break;
      }
      case 'bookmark_delete': {
        const before = USER.bookmarks.length;
        USER.bookmarks = USER.bookmarks.filter((x) => x.id !== args.id);
        r = USER.bookmarks.length < before; break;
      }
      case 'memo_save': {
        if (args.id && USER.memos.some((x) => x.id === args.id)) {
          const m = USER.memos.find((x) => x.id === args.id);
          m.body = args.body; m.updated = '시험시각';
          r = m.id;
        } else {
          const id = userSeq++;
          USER.memos.push({ id, bk: args.bk, ch: args.ch, v: args.v, body: args.body, updated: '시험시각' });
          r = id;
        }
        break;
      }
      case 'memo_delete': {
        const before = USER.memos.length;
        USER.memos = USER.memos.filter((x) => x.id !== args.id);
        r = USER.memos.length < before; break;
      }
      case 'highlight_set': {
        const key = args.bk + ':' + args.ch + ':' + args.v;
        if (!args.color) delete USER.highlights[key];
        else USER.highlights[key] = args.color;
        r = null; break;
      }

      default: r = null;
    }
    return Promise.resolve(r);
  }

  // progress / index-done 이벤트를 듣는 코드에 빈 리스너를 제공한다.
  const listeners = {};
  function listen(ev, fn) {
    listeners[ev] = fn;
    return Promise.resolve(() => { delete listeners[ev]; });
  }

  window.__TAURI__ = {
    core: { invoke: mockInvoke },
    event: {
      listen,
      once: (ev, fn) => listen(ev, fn),
    },
  };

  // 받기 시험을 돕는 진행 이벤트 방출기(콘솔에서 mockProgress() 로 호출 가능)
  window.__mock = {
    progress: (label, done, total) => { if (listeners['progress']) listeners['progress']({ payload: { label, done, total } }); },
    indexDone: () => { if (listeners['index-done']) listeners['index-done']({ payload: null }); },
  };
})();
