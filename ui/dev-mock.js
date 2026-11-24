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
  const APP_SRC_URL = 'mock://app-source';
  window.__mockAppSrc = APP_SRC_URL;   // 설정 화면(web_app_source)도 같은 가짜 주소를 쓴다

  // 주석 글 AI 보정 시험용 상태. 원문은 일부러 줄이 문장 중간에서 끊기게 지어낸다.
  const mockFix = {};
  const mockRun = { running: false, series: '', bk: 0, engine: '', model: '', done: 0, total: 0, notes: [], summary: null };
  const plain = (n) => String(n.html || '').replace(/<[^>]+>/g, '');
  const mockOrig = (n) => `${plain(n)} 시험용으로 지어낸 둘째 문장은 줄이 중간에
서 끊겨 있고 띄어쓰기 도 어긋나 있습니다. 표제어. 표제어 풀이가 한 줄에 붙어 있습니다(행 24:10).`;
  const mockFixed = (n, num) => `${plain(n)} 시험용으로 지어낸 둘째 문장은 줄이 중간에서 끊겨 있고 띄어쓰기도 어긋나 있습니다.
표제어. 표제어 풀이가 한 줄에 붙어 있습니다(행 24:${num ? '11' : '10'}).`;

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
        } else if (url === APP_SRC_URL) {
          // 서재 자료(계정) 목록: 권한이 있을 때만 이 주소가 온다.
          r = { layout: 'items', title: '서재 자료 (계정)', origin: 'mock://서재', updated: '2026-11-22 09:10', note: '', links: [], files: MOCK_FILES.slice(0, 46) };
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
        // 보정본이 켜진 풀이는 보정본 글과 fixed 표시를 단다(코어와 같은 약속: bk·seq·fixed).
        const dress = (n) => { const f = mockFix[n.id]; const on = f && f.state === 'on'; return { ...n, bk: args.bk, seq: n.comm === 'mh' ? -1 : n.id, fixed: !!on, html: on ? f.text.replace(/\n/g, '<br>') : n.html }; };
        if (args.v == null) { const lo = ch * 1000, hi = lo + 999; r = NOTES.filter((n) => n.start_key <= hi && n.end_key >= lo).map(dress); }
        else { const k = args.ch * 1000 + args.v; r = NOTES.filter((n) => n.start_key <= k && n.end_key >= k).map(dress); }
        break;
      }
      // ---- 주석 글 AI 보정(fix.js). 지어낸 글로 진행·확인 필요·되돌리기를 흉내 낸다.
      case 'fix_targets': {
        r = NOTES.filter((n) => n.comm === args.series && n.start_key <= args.hi && n.end_key >= args.lo).map((n) => {
          const f = mockFix[n.id];
          return { id: n.id, series: n.comm, series_name: n.comm_name, bk: args.bk, seq: n.id, ref: n.ref, title: n.title, start_key: n.start_key, end_key: n.end_key, chars: mockOrig(n).length, fix: f ? f.state : '', flags: f ? f.flags : '', change: f ? f.change : 0, model: f ? 'gpt-6-sol@low' : '', origin: f ? (f.origin || 'me') : '', up: f ? (f.up || 0) : 0, who: f ? (f.who || '') : '', msg: '' };
        });
        break;
      }
      case 'fix_engines': r = [{ id: 'codex', name: '챗GPT 구독', kind: 'cli', models: [] }, { id: 'claude', name: '클로드 구독', kind: 'cli', models: [] }, { id: 'deepseek', name: '딥시크', kind: 'api', models: ['deepseek-flash', 'deepseek-v4-pro'] }]; break;
      // 서재와 맞추기: 처음 한 번은 다른 사용자가 올린 보정본 하나(24:22-26)를 받아 온 것처럼 흉내 낸다.
      case 'fix_sync': { let pulled = 0; if (!mockFix[6] && !mockRun.synced) { mockRun.synced = true; mockFix[6] = { state: 'on', text: mockFixed(NOTES.find((x) => x.id === 6), false), change: 0.004, flags: '', origin: 'server', who: '관리자', up: 0 }; pulled = 1; } r = { sent: 0, rejected: 0, removed: 0, pulled, error: '' }; break; }
      case 'fix_state': r = Object.assign({}, mockRun); break;
      case 'fix_stop': mockRun.stop = true; r = null; break;
      case 'fix_start': {
        const seqs = (args.picks || []).flatMap((p) => p.seqs || []);
        Object.assign(mockRun, { running: true, series: (args.picks || []).map((p) => p.series).join(', '), bk: args.bk, done: 0, total: seqs.length, notes: [], stop: false });
        const sum = { total: seqs.length, ok: 0, review: 0, same: 0, fail: 0, stopped: false, error: '', requests: 0, tok_in: 0, tok_out: 0, cost: 0, secs: 0, chars: 0 };
        const t0 = Date.now();
        const step = (i) => {
          if (i >= seqs.length || mockRun.stop) {
            mockRun.running = false; sum.stopped = !!mockRun.stop; sum.secs = (Date.now() - t0) / 1000;
            for (const k in mockFix) if (mockFix[k].state === 'on' && mockFix[k].origin !== 'server') mockFix[k].up = 1;
            if (listeners['fix-done']) listeners['fix-done']({ payload: Object.assign({ share: { sent: sum.ok, rejected: 0, removed: 0, pulled: 0, error: '' } }, sum) });
            return;
          }
          const n = NOTES.find((x) => x.id === seqs[i]);
          // 세 번째마다 '확인 필요'(숫자가 달라진 것처럼), 다섯 번째마다 '고칠 곳 없음'으로 흉내 낸다.
          const state = i % 5 === 4 ? 'same' : i % 3 === 2 ? 'review' : 'ok';
          const out = { id: n.id, series: n.comm, bk: args.bk, seq: n.id, state, change: state === 'same' ? 0 : state === 'review' ? 0.021 : 0.004, flags: state === 'review' ? 'num' : '', error: '' };
          if (state !== 'same') mockFix[n.id] = { state: state === 'ok' ? 'on' : 'pending', text: mockFixed(n, state === 'review'), change: out.change, flags: out.flags };
          sum[state]++; sum.requests++;
          mockRun.done = i + 1; mockRun.notes.push(out);
          if (listeners['fix-progress']) listeners['fix-progress']({ payload: { note: out, done: i + 1, total: seqs.length } });
          setTimeout(() => step(i + 1), 350);
        };
        setTimeout(() => step(0), 350);
        r = seqs.length;
        break;
      }
      case 'fix_pair': {
        const n = NOTES.find((x) => x.id === args.seq);
        const f = n && mockFix[n.id];
        r = n ? { ref: n.ref, title: n.title, orig: mockOrig(n), stale: false, fix: f ? { orig_hash: 'x', text: f.text, state: f.state, flags: f.flags, change: f.change, engine: 'codex', model: 'gpt-6-sol@low', created: '2026-11-24 10:00:00', origin: f.origin || 'me', up: f.up || 0, who: f.who || '', msg: '' } : null } : null;
        break;
      }
      case 'fix_approve': r = 0; for (const q of args.seqs || []) if (mockFix[q]) { mockFix[q].state = 'on'; r++; } break;
      case 'fix_discard': r = 0; for (const q of args.seqs || []) if (mockFix[q]) { if (mockFix[q].origin === 'server') mockFix[q].state = 'off'; else delete mockFix[q]; r++; } break;
      case 'comm_series': r = [{ id: '카리스종합주석', name: '카리스 종합주석', books: [1,2,3,4,5,6,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,65,66], have: [44] }]; break;
      case 'parse': r = PARSE; break;
      case 'lex': r = LEX[args.code] || []; break;
      case 'set_hidden': r = null; break;
      case 'search_text': r = [{ area: 'bible', src: '개역개정', bk: 44, ch: 24, v: 10, ref_: '행 24:10', note_id: 0, snippet: '시험 [본문] 검색 결과' }]; break;
      case 'goto_ref': r = args.input && /\d/.test(args.input) ? [44, 24, 10] : null; break;
      case 'articles': r = ARTICLES; break;
      case 'article_body': r = '마가복음 2:18-22 소논문(시험용).<br>## 1. 금식 논쟁의 자리<br>지어낸 첫 문단입니다. 본문 첫 줄부터 소제목이 나옵니다.<br>둘째 줄입니다.<br><br>### 1.1 원어 낱말<br>## 표시가 세 개면 더 작은 소제목입니다.<br>마지막 문단입니다.'; break;

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
    // 받은 자료 카드 시험: 받은 항목만 비우고 묶음 설치(설치된 출처)는 남긴다.
    clearItems: () => { mockItems.length = 0; mockUpdated = '2026-11-21 23:00'; },
  };
})();

// ============================================================ AI 본문연구(study) 가짜 응답
// localStorage.mockWeb = 'out' | 'in' | 'pcoff' 로 로그인 상태를,
// localStorage.mockEngine = 'deepseek,claude,server' 처럼 준비된 엔진 id 목록을 바꿔 볼 수 있다.
(function () {
  'use strict';
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const LS = window.localStorage;
  const prevInvoke = T.core.invoke.bind(T.core);

  // ---- 이벤트: 'study' 만 따로 받는다.
  const studyListeners = {};
  const prevListen = T.event.listen;
  T.event.listen = function (ev, fn) {
    if (ev === 'study') { studyListeners[ev] = fn; return Promise.resolve(() => { delete studyListeners[ev]; }); }
    return prevListen(ev, fn);
  };
  T.event.once = T.event.listen;
  function emit(payload) {
    if (payload && payload.type === 'step') mockCalls.step++;
    const fn = studyListeners['study'];
    if (fn) try { fn({ event: 'study', payload }); } catch (e) {}
  }
  // 시험용 호출 계기(단계 이벤트 몰림 때 study_get 이 얼마나 불리는지 본다).
  const mockCalls = { study_get: 0, step: 0, lastStart: null, lastOpen: null };

  const webMode = () => LS.getItem('mockWeb') || 'out';
  // 권한: localStorage.mockRole = owner|special|member|guest|none (없으면 mockWeb 에서 추정)
  const webRole = () => LS.getItem('mockRole') || (webMode() === 'out' ? 'none' : 'owner');
  const loggedIn = () => webRole() !== 'none';
  const readyList = () => {
    const v = LS.getItem('mockEngine');
    return v == null ? ['deepseek', 'claude', 'server'] : v.split(',').map((x) => x.trim()).filter(Boolean);
  };
  const hasMcp = () => LS.getItem('mockMcp') === '1';

  // ---- 엔진 표(설계서 3절 ai_engines 응답 순서)
  const ENGINES = [
    { id: 'deepseek', kind: 'api', name: '딥시크', model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'], note: '쓴 만큼 결제. 가장 저렴', hint: '····1a2b', keyurl: 'https://platform.deepseek.com/api_keys' },
    { id: 'claude', kind: 'cli', name: '클로드 구독', model: 'sonnet', models: ['sonnet', 'opus'], found: true, version: '2.1.0 (가짜)' },
    { id: 'codex', kind: 'cli', name: '챗GPT 구독', model: 'gpt-6-luna', models: ['gpt-6-luna'], found: false, version: '' },
    { id: 'server', kind: 'server', name: '서재 서버의 구독 AI (집 PC)', model: 'sonnet', models: ['sonnet', 'opus'] },
    { id: 'gemini', kind: 'api', name: '제미나이', model: 'gemini-3-pro', models: ['gemini-3-pro'], keyurl: 'https://aistudio.google.com/apikey' },
    { id: 'openai', kind: 'api', name: '챗GPT API', model: 'gpt-6-luna', models: ['gpt-6-luna'], keyurl: 'https://platform.openai.com/api-keys' },
    { id: 'anthropic', kind: 'api', name: '클로드 API', model: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'], keyurl: 'https://console.anthropic.com/settings/keys' },
    { id: 'custom', kind: 'api', name: '직접 넣기', model: '직접 넣은 모델', models: ['직접 넣은 모델'], note: '주소와 모델을 직접 넣습니다' },
  ];

  const CATS14 = [
    ['주석', 'korean', '한국어 종합 주석', '옥스퍼드 원어성경대전·카리스·그랜드·호크마·그레이스·페트라 등 절마다 풀이한 큰 주석', true],
    ['주석', 'reformed', '개혁주의·고전 주석', '칼빈·박윤선·매튜 헨리·핸드릭슨', true],
    ['주석', 'academic', '학술 주석', 'WBC·NICNT·신약의 구약 사용 등 학자들의 원문 주해', true],
    ['주석', 'apply', '적용·강해 주석', 'LAB·NIV 적용·엑스포지멘터리·바클레이·HOW·BST', true],
    ['주석', 'english', '영어 주석', 'NAC·Believers Church·Tyndale·NLT 등 영어 원서', true],
    ['주석', 'scholar', '한국 학자 주해·논문', '김희보·김지찬·김회권·이한수 주해, 성경과 신학 논문, 학술지', false],
    ['설교·강해', 'expo_books', '강해 설교집(책)', '로이드존스·스펄전·박영선·김홍전·송태근 등의 강해서', true],
    ['설교·강해', 'expo_docs', '강해 원고', '구약·신약 책별 강해 자료 (문서 파일)', true],
    ['설교·강해', 'sermons', '설교 원고', '책별·주제별 설교문, 유명 목사님 설교 모음 (문서 파일)', true],
    ['설교·강해', 'ref_sermons', '참고 설교', '외부 설교자 자료. 원문만·요약완료를 구분하며 종합검수 미완료 항목은 인용 전 원출처 확인', false],
    ['보조 자료', 'study', '성경공부·묵상·예화', '성경공부 교재, 묵상, 예화 (문서 파일)', false],
    ['보조 자료', 'theology', '조직신학·성경신학', '교리·신학 주제를 다루는 책', false],
    ['보조 자료', 'background', '성경 배경·원어 사전', '개론·배경·지리·고고학, 원어 사전', false],
    ['보조 자료', 'other', '그 밖의 자료', '위에 들지 않는 책·문서', false],
  ];

  const PREACHERS = [
    ['김준호', '대구사랑교회', 42, 12, 9], ['이성민', '동성교회', 31, 8, 4], ['박영선', '남포교회', 66, 30, 18],
    ['송태근', '삼일교회', 55, 21, 7], ['정현욱', '안산상록교회', 27, 10, 3], ['한상우', '부산제일교회', 19, 6, 2],
    ['오성호', '광주은혜교회', 12, 4, 0], ['문재현', '청주중앙교회', 8, 2, 1],
  ];

  const REF_BOOK = { '막': '마가복음', '요': '요한복음', '롬': '로마서', '시': '시편', '창': '창세기', '삿': '사사기', '마': '마태복음' };

  function sourcesBody(ref) {
    const book = (String(ref || '').trim().match(/^([가-힣]+)/) || [])[1] || '';
    const bible_book = REF_BOOK[book] || (book ? book + '서' : '');
    const hasRef = !!bible_book;
    const seed = bible_book.length + 3;
    const cats = CATS14.map((c, i) => ({
      group: c[0], id: c[1], name: c[2], desc: c[3], default: c[4],
      n: hasRef ? Math.max(0, (i * 7 + seed) % 23) : 0,
      sample: hasRef ? ['가짜 표본 ' + (i + 1) + '-1', '가짜 표본 ' + (i + 1) + '-2'] : [],
    }));
    return {
      ref: ref || '', bible_book,
      sermons: {
        preachers: PREACHERS.map((p) => ({ preacher: p[0], church: p[1], n: p[2], summaries: p[3], matching: hasRef ? p[4] : 0 })),
        churches: PREACHERS.map((p) => p[1]),
        uses: { interpretation: '해석·신학 관점 비교', outline: '설교 개요 참고', application: '적용·예화 참고', illustrations: '예화·예시 참고', style: '문장·말투 참고' },
        defaults: { preachers: null, church: '', status: 'all', source_type: 'all', match: 'main', max_items: 5, use: ['interpretation', 'outline', 'application'] },
        has_ref: hasRef,
      },
      cats,
    };
  }

  // ---- 앱 연구 기록
  const jobs = {};
  let seq = 0;
  function nowStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  const hhmm = () => nowStr().slice(11, 16);

  const REPORT = [
    '## 1. 본문의 자리',
    '',
    '이 비유는 새 포도주를 낡은 가죽 부대에 넣지 않는다는 짧은 그림으로, 새 시대의 형식과 옛 형식의 충돌을 말합니다.',
    '',
    '> 새 포도주는 새 부대에 넣어야 한다(막 2:22).',
    '',
    '## 2. 해석 비교',
    '',
    '| 관점 | 초점 | 근거 |',
    '|---|---|---|',
    '| 종말론적 | 새 시대의 도래 | 《가짜 종합주석》 23쪽 |',
    '| 공동체적 | 금식 규례의 재해석 | 《가짜 학술주석》 88쪽 |',
    '',
    '## 3. 설교 개요',
    '',
    '1. 낡은 부대의 자리',
    '2. 새 포도주가 깨뜨리는 것',
    '3. 새 부대에 담기는 교회',
    '',
    '- 첫째, 금식은 목적이 아니라 수단이다.',
    '- 둘째, 새 형식은 새 마음을 담는 그릇이다.',
    '',
    '출처: [《가짜 주석》 23쪽](#/read/abc123def456/23) · [《가짜 학술주석》 88쪽](#/read/abc123def456/88)',
    '',
    '```choices',
    JSON.stringify({
      questions: [
        { q: '설교의 중심을 어디에 둘까요?', options: ['새 포도주(새 시대)', '새 부대(공동체)', '금식의 의미'], multi: false },
        { q: '마무리 방식을 골라 주세요', options: ['도전', '위로', '기도 제안'], multi: true },
      ],
      next: ['청년부용 나눔 질문 5개로 바꿔 줘', '예화를 하나 더 찾아 줘'],
    }),
    '```',
  ].join('\n');

  const ASK_REPORT = [
    '## 다듬은 개요',
    '',
    '1. 금식이라는 질문',
    '2. 새 포도주, 새 부대',
    '3. 오늘의 교회에 주는 말',
    '',
    '출처: [《가짜 주석》 23쪽](#/read/abc123def456/23)',
  ].join('\n');

  function runSteps(id, turn, doneMd, isAsk) {
    const steps = isAsk
      ? [{ k: 'info', x: '이어서 묻는 요청을 반영합니다' }, { k: 'tool', x: '《가짜 종합주석》 23쪽 읽기' }, { k: 'write', x: '보고서 쓰기' }]
      : [
        { k: 'info', x: '서재 연결 확인 · 지시문 받기' },
        { k: 'tool', x: '본문 자료 찾기: ' + (jobs[id].ref || '') },
        { k: 'tool', x: '읽는 중: 책 af4193' },
        // 같은 index 로 문구만 다시 보내는 경우(책 제목을 알게 됨)
        { retitle: '읽는 중: 《가짜 종합주석》 23쪽', index: 2 },
        { k: 'think', x: '새 포도주 비유의 초점을 정리하는 중' },
        { k: 'write', x: '보고서 쓰기' },
      ];
    let k = 0;
    const tick = setInterval(() => {
      const j = jobs[id];
      if (!j || j.turns[turn].status !== 'running') { clearInterval(tick); return; }
      const s = steps[k];
      if (s) {
        const t = j.turns[turn];
        if (s.retitle != null) {
          const i = s.index;
          if (t.steps[i]) t.steps[i].x = s.retitle;
          emit({ type: 'step', id, turn, index: i, step: { t: hhmm(), k: (t.steps[i] || {}).k || 'tool', x: s.retitle } });
          k++;
          return;
        }
        t.steps.push({ t: hhmm(), k: s.k, x: s.x });
        emit({ type: 'step', id, turn, index: t.steps.length - 1, step: { t: hhmm(), k: s.k, x: s.x } });
        k++;
        return;
      }
      clearInterval(tick);
      const t = j.turns[turn];
      t.status = 'done';
      t.finished = nowStr();
      t.seconds = isAsk ? 18 : 42;
      t.md = doneMd;
      t.cost = 0.04;
      t.tokens = { input: 4210, output: 1830 };
      emit({ type: 'status', id, turn, status: 'done' });
    }, 2000);
  }

  function startJob(d) {
    seq++;
    const id = 'app-' + nowStr().replace(/[-: ]/g, '').slice(0, 14) + '-' + String(1000 + seq);
    const job = {
      id, created: nowStr(), ref: d.ref || '', purpose: d.purpose || '', depth: d.depth || 'normal',
      notes: d.notes || '', cats: d.cats || [], sermon_options: d.sermon_options || {},
      engine: d.engine || 'deepseek', model: d.model || '', session_id: null, status: 'running',
      turns: [{
        q: null, status: 'running', created: nowStr(), started: nowStr(), finished: null, seconds: 0,
        steps: [], md: '', error: null, engine: d.engine || 'deepseek', model: d.model || '', cost: null, tokens: {}, turns_used: null,
      }],
    };
    jobs[id] = job;
    runSteps(id, 0, REPORT, false);
    return id;
  }

  function fakeImage() {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="680">'
      + '<rect width="520" height="680" fill="#efece5"/>'
      + '<rect x="40" y="40" width="440" height="600" fill="#fffdf9" stroke="#cfc9bc"/>'
      + '<g fill="#767b84" font-family="sans-serif" font-size="16">'
      + '<text x="60" y="90">가짜 원본 스캔 (시험용)</text>'
      + '<text x="60" y="130">23쪽 · 지어낸 그림입니다</text></g>'
      + '<g stroke="#d8d2c6" stroke-width="2"><line x1="60" y1="160" x2="460" y2="160"/>'
      + '<line x1="60" y1="200" x2="460" y2="200"/><line x1="60" y1="240" x2="460" y2="240"/>'
      + '<line x1="60" y1="280" x2="380" y2="280"/></g></svg>';
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  function fakeMcpRead(book, page) {
    const p = Math.max(1, +page || 1);
    const lines = ['《가짜 주석 (시험용)》 (가짜 주석 폴더, 전체 120쪽)', '=== p.' + p + ' ==='];
    if (p === 1) {
      lines.push('## 마가복음 2:18-22 주해', '1. 금식 논쟁의 자리', '지어낸 본문입니다. 서재 연결로 읽은 쪽입니다.', '[각주] 가짜 각주: 서재 연결 시험용입니다.');
    } else if (p === 23) {
      lines.push('## 2. 새 부대의 의미', '새 포도주는 새 부대에 넣어야 한다는 말씀입니다.', '', '이어지는 둘째 문단입니다.', '[각주] 가짜 각주: 원어 표기는 생략했습니다.');
    } else {
      lines.push('가짜 ' + p + '쪽 본문입니다.', '[각주] 가짜 각주: ' + p + '쪽입니다.');
    }
    return lines.join('\n');
  }

  function fakePages(book, page) {
    const title = '가짜 주석 (시험용)';
    const pages = {
      1: {
        blocks: [
          { label: 'header', text: '가짜 주석 · 머리말' },
          { label: 'doc_title', text: '마가복음 2:18-22 주해' },
          { label: 'paragraph_title', text: '1. 금식 논쟁의 자리' },
          { label: 'text', text: '지어낸 본문입니다. 새 포도주 비유는 옛 형식과 새 시대의 긴장을 보여 줍니다.\n둘째 줄도 그대로 나옵니다.' },
          { label: 'footnote', text: '가짜 각주: 이 문장은 시험용입니다.' },
          { label: 'number', text: '1' },
        ],
      },
      23: {
        blocks: [
          { label: 'header', text: '가짜 주석 · 머리말' },
          { label: 'paragraph_title', text: '2. 새 부대의 의미' },
          { label: 'text', text: '새 포도주는 새 부대에 넣어야 한다는 말씀은 새 시대의 내용이 새 형식을 요구한다는 뜻으로 읽힙니다.' },
          { label: 'image', text: '' },
          { label: 'figure_title', text: '그림 1. 가짜 도해' },
          { label: 'text', text: '이어지는 본문입니다. 시험용으로 지어낸 짧은 문장입니다.' },
          { label: 'footnote', text: '가짜 각주: 원어 표기는 생략했습니다.' },
        ],
      },
      88: {
        blocks: [
          { label: 'paragraph_title', text: '3. 학술적 논의' },
          { label: 'text', text: '지어낸 학술 주석 본문입니다. 표와 함께 보여 줍니다.' },
          { label: 'table', text: '<table><tr><th>관점</th><th>쪽</th></tr><tr><td>종말론적</td><td>23</td></tr><tr><td>공동체적</td><td>24</td></tr></table>' },
        ],
      },
    };
    const bl = pages[page] || { blocks: [{ label: 'text', text: '가짜 ' + page + '쪽 본문입니다.' }] };
    return {
      items: [{
        book: { id: book || 'abc123def456', title, folder: '가짜 주석 폴더', rel: '가짜/주석.pdf', pages: 120, indexed_pages: 120, done: 1, kind: 'scan' },
        page: +page || 1, blocks: bl.blocks, engine: 'fake', hanja_dropped: false, sermon: null,
      }],
    };
  }

  const SERVER_JOBS = {
    '20261121-101500-ab12': {
      id: '20261121-101500-ab12', created: '2026-11-21 10:15:00', ref: '요 3:16-21', purpose: '주일 설교', depth: 'normal',
      notes: '', cats: ['korean', 'reformed'], sermon_options: {}, engine: 'claude', model: 'sonnet', status: 'done',
      turns: [{
        q: null, status: 'done', created: '2026-11-21 10:15:00', started: '2026-11-21 10:15:02', finished: '2026-11-21 10:19:10',
        seconds: 248, engine: 'claude', model: 'sonnet', cost: 0.31, tokens: {}, turns_used: 12,
        steps: [
          { t: '10:15', k: 'info', x: '본문 자료 찾기: 요 3:16-21' },
          { t: '10:16', k: 'tool', x: '《가짜 종합주석》 210쪽 읽기' },
          { t: '10:19', k: 'write', x: '보고서 쓰기' },
        ],
        md: '## 서버 연구 표본\n\n지어낸 서버 보고서입니다.\n\n출처: [《가짜 종합주석》 210쪽](#/read/abc123def456/1)',
        error: null,
      }],
    },
    '20261120-083000-cd34': {
      id: '20261120-083000-cd34', created: '2026-11-20 08:30:00', ref: '시 23', purpose: '새벽기도 설교', depth: 'quick',
      notes: '', cats: ['korean'], sermon_options: {}, engine: 'codex', model: 'gpt-6-luna', status: 'done',
      turns: [{
        q: null, status: 'done', created: '2026-11-20 08:30:00', started: '2026-11-20 08:30:02', finished: '2026-11-20 08:34:00',
        seconds: 238, engine: 'codex', model: 'gpt-6-luna', cost: null, tokens: {}, turns_used: 8,
        steps: [{ t: '08:31', k: 'tool', x: '《가짜 주석》 12쪽 읽기' }],
        md: '## 서버 연구 표본 둘째\n\n지어낸 짧은 보고서입니다.',
        error: null,
      }],
    },
  };

  // 서재 서버에서 돌리는 연구(엔진 server) 흉내: 2초마다 다시 읽을 때마다 단계가 하나씩 쌓인다.
  const SERVER_LIVE = {};
  const SERVER_STEPS = [
    ['info', '서버 작업대에 연구를 넣었습니다'],
    ['tool', '본문 자료 찾기: {ref}'],
    ['tool', '《가짜 종합주석》 23쪽 읽기'],
    ['think', '보고서 뼈대를 잡는 중'],
    ['write', '보고서 쓰기'],
  ];
  function serverTick(j) {
    const t = j.turns[j.turns.length - 1];
    if (t.status !== 'running') return;
    const waited = (Date.now() - t._t0) / 1000;
    const want = Math.min(SERVER_STEPS.length, Math.floor(waited / 2) + 1);
    while (t.steps.length < want) {
      const s = SERVER_STEPS[t.steps.length];
      t.steps.push({ t: hhmm(), k: s[0], x: s[1].replace('{ref}', j.ref) });
    }
    if (waited >= SERVER_STEPS.length * 2) {
      t.status = 'done';
      t.finished = nowStr();
      t.seconds = Math.round(waited);
      t.md = REPORT;
    }
  }
  function serverJob(d) {
    seq++;
    const id = nowStr().replace(/[-: ]/g, '').slice(0, 15) + '-' + String(9000 + seq);
    const j = {
      id, created: nowStr(), ref: d.ref || '', purpose: d.purpose || '', depth: d.depth || 'normal',
      notes: d.notes || '', cats: d.cats || [], sermon_options: d.sermon_options || {},
      engine: 'server', model: d.model || 'sonnet', session_id: null, status: 'running',
      turns: [{ q: null, status: 'running', created: nowStr(), started: nowStr(), finished: null, seconds: 0, steps: [], md: '', error: null, engine: 'claude', model: d.model || 'sonnet', cost: null, tokens: {}, turns_used: null, _t0: Date.now() }],
    };
    SERVER_LIVE[id] = j;
    return j;
  }

  let prefs = { saved: false, names: null };
  let settings = (function () {
    try { return JSON.parse(LS.getItem('mockStudySettings') || '{}') || {}; } catch (e) { return {}; }
  })();
  const savedKeys = { deepseek: true };

  // 서재 주소(가짜): localStorage.mockBase 가 없으면 기본 주소, 빈 문자열이면 '주소 없음' 상태.
  function baseState() {
    const b = LS.getItem('mockBase');
    const base = b == null ? 'https://theology.example' : b;
    return { base, default: base === 'https://theology.example', has_default: true };
  }

  function webStatus() {
    const role = webRole();
    const on = role !== 'none';
    const user = { owner: 'admin', special: 'special1', member: 'member7', guest: 'guest' }[role] || '';
    return {
      base: baseState().base, logged_in: on, user,
      role: (role === 'special' || role === 'member' || role === 'guest') ? role : '',
      owner: role === 'owner', pc_off: on && webMode() === 'pcoff', has_mcp: on,
    };
  }

  // ---- 권한 요약(설계서 1절 표의 말로)
  const SCOPE_NOTE = {
    owner: '관리자 계정입니다. 이 PC의 AI(딥시크·클로드 구독·챗GPT 구독·그 밖의 API)와 서재 서버의 구독 AI 를 모두 쓸 수 있습니다.',
    special: '특별 계정입니다. 서재 서버의 구독 AI 로 연구하며 따로 비용이 들지 않습니다.',
    member: '회원 계정입니다. 본인 API 키로 연구하고, 키는 서재 계정에 저장합니다.',
    guest: '게스트입니다. 연구할 때마다 API 키를 넣어 씁니다(12시간 뒤 지워집니다).',
    localmcp: '로그인하지 않았지만 서재 연결 주소가 있어 이 PC의 AI 를 쓸 수 있습니다.',
    none: '로그인하지 않았습니다. 먼저 계정 갈래에서 로그인해 주세요.',
  };
  function scopeId() {
    const r = webRole();
    if (r !== 'none') return r;
    return hasMcp() ? 'localmcp' : 'none';
  }

  // 회원·게스트가 서버에서 실행하는 엔진(서버가 키를 받아 돌린다)
  const WEBKEYS = [
    { id: 'web-gemini', kind: 'webkey', name: '제미나이', provider: 'gemini', model: 'gemini-3-pro', models: ['gemini-3-pro', 'gemini-3-flash'], keyurl: 'https://aistudio.google.com/apikey', note: '구글 AI 스튜디오에서 무료로 키를 받을 수 있습니다.' },
    { id: 'web-openai', kind: 'webkey', name: '챗GPT API', provider: 'openai', model: 'gpt-6-luna', models: ['gpt-6-luna'], keyurl: 'https://platform.openai.com/api-keys', note: '구독과 별도로 쓴 만큼 결제됩니다.' },
    { id: 'web-anthropic', kind: 'webkey', name: '클로드 API', provider: 'anthropic', model: 'claude-sonnet-4-6', models: ['claude-sonnet-4-6'], keyurl: 'https://console.anthropic.com/settings/keys', note: '구독과 별도로 쓴 만큼 결제됩니다.' },
  ];
  const savedWeb = { gemini: false, openai: false, anthropic: false };
  let webDefault = 'gemini';
  function prefBody() {
    const role = webRole();
    return {
      role, default: webDefault, can_save: role === 'member',
      engines: WEBKEYS.map((p) => ({
        id: p.provider, name: p.name, model: p.model, models: p.models, keyurl: p.keyurl, note: p.note,
        ready: !!savedWeb[p.provider], saved: !!savedWeb[p.provider],
        hint: savedWeb[p.provider] ? '····b4fb' : '',
      })),
    };
  }

  function studyMock(cmd, args) {
    args = args || {};
    switch (cmd) {
      case 'web_status': return Promise.resolve(webStatus());
      case 'web_base_get': return Promise.resolve(baseState());
      case 'web_base_set': {
        const u = String(args.url || '').trim().replace(/\/+$/, '');
        if (u && !/^https:\/\//.test(u) && !/^http:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u)) return Promise.reject('서재 주소는 https:// 로 시작해야 합니다.');
        if (u) LS.setItem('mockBase', u); else LS.removeItem('mockBase');
        // 주소를 바꾸면 로그인이 풀린다(진짜 앱과 같게).
        LS.setItem('mockRole', 'none');
        LS.setItem('mockWeb', 'out');
        return Promise.resolve(webStatus());
      }
      case 'web_login': {
        if (!baseState().base) return Promise.reject('서재 주소가 설정되지 않았습니다. 설정의 계정에서 서재 주소를 넣어 주세요.');
        if (!args.id || !args.pw) return Promise.reject('아이디나 비밀번호가 맞지 않습니다.');
        // 시험: 틀린 비밀번호는 거절한다(오류 문구 시험용).
        if (String(args.pw) === 'wrong') return Promise.reject('아이디나 비밀번호가 맞지 않습니다.');
        // 시험: 아이디로 권한을 고른다 — admin → 관리자, sp1 → 특별 계정, 그 밖 → 회원.
        const id = String(args.id);
        const r = id === 'admin' ? 'owner' : id === 'sp1' ? 'special' : 'member';
        LS.setItem('mockRole', r);
        LS.setItem('mockWeb', 'in');
        return Promise.resolve(webStatus());
      }
      case 'web_open': {
        // 진짜 앱은 기본 브라우저를 연다. 시험에서는 부른 경로만 기록한다.
        const p = String(args.path || '');
        const allowed = ['/signup', '/login', '/', '/#/profile', '/#/study', '/#/me/sermons'];
        if (!allowed.includes(p)) return Promise.reject('허용되지 않은 주소입니다.');
        mockCalls.lastOpen = p;
        return Promise.resolve(null);
      }
      case 'web_guest_login': {
        if (!args.pw) return Promise.reject('공통 비밀번호가 맞지 않습니다.');
        LS.setItem('mockRole', 'guest');
        LS.setItem('mockWeb', 'in');
        return Promise.resolve(webStatus());
      }
      case 'web_logout': LS.setItem('mockRole', 'none'); LS.setItem('mockWeb', 'out'); LS.setItem('mockMcp', ''); return Promise.resolve(null);
      case 'ai_scope': {
        const s = scopeId();
        const label = { owner: '관리자', special: '특별 계정', member: '회원', guest: '게스트', localmcp: '이 PC 연결', none: '로그인 안 함' }[s];
        return Promise.resolve({ scope: s, label, user: webStatus().user, local_allowed: s === 'owner' || s === 'localmcp', note: SCOPE_NOTE[s] });
      }
      case 'web_app_source': {
        const s = scopeId();
        const can = s === 'owner' || s === 'special';
        return Promise.resolve({ can, kind: can ? 'server' : '', url: can ? window.__mockAppSrc : '', files: can ? [{ id: 'bundle', bytes: 410000000, built_at: '2026-11-22 08:00' }] : [] });
      }
      case 'app_info': return Promise.resolve({ version: '0.5.0', portable: false, data_dir: 'C:\\Users\\Administrator\\AppData\\Roaming\\theolib', platform: 'windows 11 (가짜)' });
      case 'open_data_dir': return Promise.resolve(null);
      case 'ai_cli_refresh': return Promise.resolve(null);
      case 'ai_cli_install': return Promise.resolve(null);
      case 'ai_cli_guide': {
        const id = String(args.engine || 'claude');
        const mode = LS.getItem('mockCli') || 'ok';       // ok | nologin | missing
        const codex = id === 'codex';
        const found = mode !== 'missing';
        return Promise.resolve({
          id, name: codex ? '챗GPT 구독' : '클로드 구독',
          found, path: found ? (codex ? 'C:\\Users\\Administrator\\AppData\\Roaming\\npm\\codex.cmd' : 'C:\\Users\\Administrator\\.local\\bin\\claude.exe') : '',
          version: found ? (codex ? '0.9.1 (가짜)' : '2.1.278 (가짜)') : '',
          logged_in: found ? (mode === 'nologin' ? false : true) : null,
          install_cmd: codex
            ? 'powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"'
            : 'irm https://claude.ai/install.ps1 | iex',
          login_cmd: codex ? 'codex login' : 'claude',
          docs: codex ? 'https://developers.openai.com/codex/cli' : 'https://code.claude.com/docs/en/quickstart',
          plan: codex ? '챗GPT Plus·Pro 등 구독 계정으로 로그인합니다(Sign in with ChatGPT).'
            : '클로드 Pro·Max 구독 계정으로 로그인합니다. 구독 사용량에서 쓰이고 따로 요금이 붙지 않습니다.',
        });
      }
      case 'web_image': return Promise.resolve(fakeImage());
      case 'web_api': {
        const path = String(args.path || '');
        const base = path.split('?')[0];
        const q = new URLSearchParams(path.split('?')[1] || '');
        if (!loggedIn()) return Promise.resolve({ status: 401, body: { error: '로그인이 풀렸습니다. 다시 로그인해 주세요.' } });
        if (base === '/api/me/ai-pref') {
          if ((args.method || 'GET').toUpperCase() === 'POST') {
            const d = args.body || {};
            if (d.default) webDefault = d.default;
          }
          return Promise.resolve({ status: 200, body: prefBody() });
        }
        if (base === '/api/me/aikeys') {
          const d = args.body || {};
          if (d.provider) savedWeb[d.provider] = d.delete ? false : true;
          return Promise.resolve({ status: 200, body: { ok: true, saved: !!savedWeb[d.provider] } });
        }
        if (base === '/api/me/aitest') {
          const d = args.body || {};
          const has = !!d.key || !!savedWeb[d.provider];
          return Promise.resolve({ status: 200, body: has ? { ok: true } : { ok: false, error: 'API 키를 넣어 주세요' } });
        }
        if (base === '/api/study/sources') return Promise.resolve({ status: 200, body: sourcesBody(q.get('ref') || '') });
        if (base === '/api/me/sermons') {      // 내 설교 자료실: 본문이 있으면 2편이 맞는 것으로 흉내
          const ref = (q.get('ref') || '').trim();
          const full = q.get('full') === '1';
          const items = ref ? [
            { id: 1, date: '2026-11-20', service: '금요기도회', title: '성령 충만은 예수님 충만', passage: '사도행전 6:8-15', summary: '시험용 요약', ...(full ? { text: '시험용 설교 전문' } : {}) },
            { id: 2, date: '2026-10-30', service: '금요기도회', title: '원망이 섬김으로 바뀌는 교회', passage: '사도행전 6:1-7', summary: '시험용 요약', ...(full ? { text: '시험용 설교 전문' } : {}) },
          ] : [];
          mockCalls.lastMySermons = path;
          return Promise.resolve({ status: 200, body: { ref_ok: !!ref, match: items.length, total: 145, items } });
        }
        if (base === '/api/me/sermon-preferences') {
          if ((args.method || 'GET').toUpperCase() === 'POST') {
            const b = args.body || {};
            if (b.action === 'clear') prefs = { saved: false, names: null };
            else if (b.action === 'save') prefs = { saved: true, names: Array.isArray(b.names) ? b.names : null };
          }
          return Promise.resolve({ status: 200, body: { ok: true, saved: prefs.saved, names: prefs.names } });
        }
        if (base === '/api/pages') return Promise.resolve({ status: 200, body: fakePages(q.get('book'), +(q.get('page') || 1)) });
        if (base === '/api/toc') return Promise.resolve({ status: 200, body: { items: [
          { page: 1, level: 1, text: '마가복음 2:18-22 주해' },
          { page: 23, level: 2, text: '2. 새 부대의 의미' },
          { page: 88, level: 2, text: '3. 학술적 논의' },
        ] } });
        if (base === '/api/search') return Promise.resolve({ status: 200, body: { q: q.get('q') || '', total: 2, items: [
          { page: 23, snippet: '새 포도주는 새 부대에…' },
          { page: 88, snippet: '지어낸 학술 주석 본문입니다.' },
        ] } });
        if (base === '/api/study/list') {
          if (readyList().includes('server')) {
            const live = Object.values(SERVER_LIVE).map((j) => {
              serverTick(j);
              const t = j.turns[j.turns.length - 1];
              return { id: j.id, created: j.created, ref: j.ref, purpose: j.purpose, depth: j.depth, status: t.status, turns: j.turns.length, engine: 'claude', cost: t.cost };
            });
            return Promise.resolve({ status: 200, body: { items: live.concat(Object.values(SERVER_JOBS).map((j) => ({
              id: j.id, created: j.created, ref: j.ref, purpose: j.purpose, depth: j.depth, status: j.status,
              turns: j.turns.length, engine: j.engine, cost: j.turns[0].cost,
            }))), queue: 0, claude_backoff: false } });
          }
          return Promise.resolve({ status: 200, body: { items: [], queue: 0, claude_backoff: false } });
        }
        if (base === '/api/study/start' && (args.method || 'GET').toUpperCase() === 'POST') {
          const d = args.body || {};
          if (!d.ref) return Promise.resolve({ status: 400, body: { ok: false, error: '본문을 넣어 주세요' } });
          mockCalls.lastStart = d;   // ai 가 실렸는지 확인하려고 본문을 기억한다
          const j = serverJob(d);
          return Promise.resolve({ status: 200, body: { ok: true, id: j.id } });
        }
        if (base === '/api/study/stop') {
          const j = SERVER_LIVE[(args.body || {}).id];
          if (j) j.turns.forEach((t) => { if (t.status === 'running') { t.status = 'stopped'; t.finished = nowStr(); } });
          return Promise.resolve({ status: 200, body: { ok: true } });
        }
        if (base === '/api/study/delete') { delete SERVER_LIVE[(args.body || {}).id]; return Promise.resolve({ status: 200, body: { ok: true } }); }
        if (base === '/api/study/ask') {
          const j = SERVER_LIVE[(args.body || {}).id];
          if (!j) return Promise.resolve({ status: 404, body: { ok: false, error: '없는 연구입니다.' } });
          j.turns.push({ q: (args.body || {}).q || '', status: 'running', created: nowStr(), started: nowStr(), finished: null, seconds: 0, steps: [], md: '', error: null, engine: 'claude', model: j.model, cost: null, tokens: {}, turns_used: null, _t0: Date.now() });
          return Promise.resolve({ status: 200, body: { ok: true } });
        }
        if (base === '/api/study/get') {
          const id = q.get('id');
          if (SERVER_LIVE[id]) {
            serverTick(SERVER_LIVE[id]);
            const j = SERVER_LIVE[id];
            return Promise.resolve({ status: 200, body: Object.assign({}, j, { status: j.turns[j.turns.length - 1].status }) });
          }
          if (SERVER_JOBS[id]) return Promise.resolve({ status: 200, body: SERVER_JOBS[id] });
          return Promise.resolve({ status: 404, body: { error: '없는 연구입니다.' } });
        }
        return Promise.resolve({ status: 404, body: { error: 'not found (mock): ' + base } });
      }

      case 'mcp_status': return Promise.resolve({ has: hasMcp() });
      case 'mcp_read': {
        if (!hasMcp()) return Promise.reject('서재 연결 주소가 없습니다.');
        return Promise.resolve({ text: fakeMcpRead(args.book, args.page) });
      }
      case 'mcp_set': LS.setItem('mockMcp', args.url ? '1' : ''); return Promise.resolve(null);
      case 'mcp_test': return Promise.resolve(hasMcp() ? { ok: true, tools: 7 } : { ok: false, tools: 0, error: '연결 주소가 없습니다.' });

      case 'ai_engines': {
        const ready = readyList();
        const s = scopeId();
        const localOk = s === 'owner' || s === 'localmcp';
        const list = ENGINES.map((e) => {
          const isReady = ready.includes(e.id) && !(e.kind === 'server' && !loggedIn()) && !(e.kind === 'api' && e.id !== 'custom' && !savedKeys[e.id]);
          const allowed = e.kind === 'server' ? (s === 'owner' || s === 'special') : localOk;
          return Object.assign({}, e, {
            ready: !!isReady && allowed,
            allowed,
            found: e.kind === 'cli' ? !!e.found : undefined,
            hint: e.kind === 'api' && savedKeys[e.id] ? (e.hint || '····9f9f') : '',
            note: e.kind === 'cli' && !e.found ? '설치 안내: npm install -g @openai/codex' : (e.note || ''),
          });
        });
        const webOk = s === 'member' || s === 'guest';
        const webkeys = WEBKEYS.map((e) => Object.assign({}, e, {
          ready: !!savedWeb[e.provider] && webOk,
          allowed: webOk,
          saved: !!savedWeb[e.provider],
          hint: savedWeb[e.provider] ? '····b4fb' : '',
        }));
        return Promise.resolve(list.concat(webkeys));
      }
      case 'ai_key_save': savedKeys[args.provider] = true; return Promise.resolve(null);
      case 'ai_key_delete': delete savedKeys[args.provider]; return Promise.resolve(null);
      case 'ai_test': {
        const mode = LS.getItem('mockCli') || 'ok';
        const eng = (ENGINES.find((x) => x.id === args.engine) || {});
        if (eng.kind === 'cli' && mode !== 'ok') {
          return Promise.resolve({ ok: false, error: mode === 'missing' ? '프로그램을 찾지 못했습니다 (ENOENT)' : '로그인이 필요합니다: not logged in' });
        }
        return Promise.resolve({ ok: true, detail: '가짜 시험 통과' });
      }
      case 'ai_cli_login': return Promise.resolve(null);

      case 'study_settings_get': return Promise.resolve(settings);
      case 'study_settings_set': settings = Object.assign({}, settings, args.settings || {}); LS.setItem('mockStudySettings', JSON.stringify(settings)); return Promise.resolve(settings);

      case 'study_start': {
        const d = args.d || {};
        mockCalls.lastLocalStart = d;   // 앱에서 돌리는 연구에 무엇이 실렸는지 시험에서 확인
        if (!d.ref) return Promise.resolve({ status: 400, body: { ok: false, error: '본문을 넣어 주세요' } });
        const id = startJob(d);
        return Promise.resolve({ status: 200, body: { ok: true, id } });
      }
      case 'study_ask': {
        const id = args.d && args.d.id;
        const j = jobs[id];
        if (!j) return Promise.resolve({ status: 404, body: { ok: false, error: '없는 연구입니다.' } });
        const turn = j.turns.length;
        j.turns.push({ q: args.d.q || '', status: 'running', created: nowStr(), started: nowStr(), finished: null, seconds: 0, steps: [], md: '', error: null, engine: j.engine, model: j.model, cost: null, tokens: {}, turns_used: null });
        runSteps(id, turn, ASK_REPORT, true);
        return Promise.resolve({ status: 200, body: { ok: true } });
      }
      case 'study_stop': {
        const j = jobs[args.d && args.d.id];
        if (j) j.turns.forEach((t) => { if (t.status === 'running' || t.status === 'queued') { t.status = 'stopped'; t.finished = nowStr(); } });
        return Promise.resolve({ status: 200, body: { ok: true } });
      }
      case 'study_delete': delete jobs[args.d && args.d.id]; return Promise.resolve({ status: 200, body: { ok: true } });
      case 'study_list': {
        const items = Object.values(jobs).map((j) => ({
          id: j.id, created: j.created, ref: j.ref, purpose: j.purpose, depth: j.depth,
          status: j.turns[j.turns.length - 1].status, turns: j.turns.length, engine: j.engine,
        })).sort((a, b) => String(b.created).localeCompare(String(a.created)));
        return Promise.resolve({ items, queue: 0 });
      }
      case 'study_get': {
        mockCalls.study_get++;
        const j = jobs[args.id];
        if (!j) return Promise.resolve(null);
        return Promise.resolve(Object.assign({}, j, { status: j.turns[j.turns.length - 1].status }));
      }
      default: return undefined;
    }
  }

  T.core.invoke = function (cmd, args) {
    const r = studyMock(cmd, args);
    if (r !== undefined) return r;
    return prevInvoke(cmd, args);
  };

  // 콘솔에서 쓰기: __mockStudy.reset() / login() / pcoff() / engines('deepseek')
  window.__mockStudy = {
    reset: () => { LS.removeItem('mockBase'); LS.setItem('mockWeb', 'out'); LS.removeItem('mockRole'); LS.removeItem('mockEngine'); LS.setItem('mockMcp', '1'); settings = {}; LS.removeItem('mockStudySettings'); },
    login: () => { LS.setItem('mockWeb', 'in'); LS.setItem('mockRole', 'owner'); },
    base: (b) => { if (b) LS.setItem('mockBase', b); else LS.removeItem('mockBase'); },
    noBase: () => { LS.setItem('mockBase', ''); LS.setItem('mockRole', 'none'); LS.setItem('mockWeb', 'out'); },
    pcoff: () => { LS.setItem('mockWeb', 'pcoff'); LS.setItem('mockRole', 'owner'); },
    role: (r) => { LS.setItem('mockRole', r || 'none'); if (r === 'none') LS.setItem('mockWeb', 'out'); else LS.setItem('mockWeb', 'in'); },
    cli: (m) => LS.setItem('mockCli', m || 'ok'),
    engines: (list) => LS.setItem('mockEngine', list),
    emit: (payload) => emit(payload),
    calls: mockCalls,
    jobs,
  };
  if (LS.getItem('mockMcp') == null) LS.setItem('mockMcp', '1');
})();
