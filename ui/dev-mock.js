// dev-mock.js — 브라우저에서 화면만 시험하기 위한 가짜 Tauri.
// window.__TAURI__ 가 없을 때만(순수 브라우저) 아래 mock 을 넣는다.
// 실제 Tauri 앱에서는 __TAURI__ 가 이미 있으므로 아무 일도 하지 않는다.
// 자료는 직접 지어낸 짧은 문장뿐이다(실제 성경·주석 본문 없음).
(function () {
  'use strict';
  if (window.__TAURI__) return;

  const BOOKS = [
    { n: 1, name: '창세기', abbr: '창', en: 'Genesis', ch: 3, alias: [] },
    { n: 44, name: '사도행전', abbr: '행', en: 'Acts', ch: 2, alias: [] },
  ];

  const VERSIONS = [
    { id: '개역개정', name: '개역개정', grp: '한국어', ord: 1, desc: '시험용', kind: 'text', file: 'bible-ko' },
    { id: 'KJV', name: 'KJV', grp: '영어', ord: 2, desc: '시험용', kind: 'text', file: 'bible-en' },
    { id: 'KJV_S', name: 'KJV 원어 번호', grp: '원어 번호 본문', ord: 3, desc: '시험용', kind: 'code', file: 'orig' },
    { id: 'parse', name: '원전 분해', grp: '원어', ord: 4, desc: '시험용', kind: 'parse', file: 'orig' },
  ];

  const VERSES = { 1: ['시험 본문 1절', '시험 본문 2절', '시험 본문 3절'], 44: ['시험 본문 24장 1절', '시험 본문 24장 2절'] };

  function textsFor(bk, ch, vers) {
    const v = VERSES[bk] || ['시험 본문'];
    return v.map((txt, i) => ({
      v: i + 1,
      texts: vers.map((ver) => ({ ver, html: txt + ' <span class="mock">' + ver + '</span>' })),
    }));
  }

  // 주석 가짜 데이터: 장 전체 개요 1개 + 절범위 1개 + 단일절 1개를 섞었다.
  // start_key·end_key 는 장*1000+절.
  const NOTES = [
    { id: 1, comm: 'karis', comm_name: '카리스종합주석', kind: '강해', title: '행 24장 전체 흐름', ref: '24장', fmt: 'text', html: '시험용 장 개요. 지어낸 짧은 문장입니다.', start_key: 24000, end_key: 24999, ch1: 24, ch2: 24 },
    { id: 2, comm: 'karis', comm_name: '카리스종합주석', kind: '주해', title: '바울의 변론', ref: '행 24:10-21', fmt: 'text', html: '시험용 절범위 해설. 짧은 설명입니다.', start_key: 24010, end_key: 24021, ch1: 24, ch2: 24 },
    { id: 3, comm: 'karis', comm_name: '카리스종합주석', kind: '원어', title: '고개를 끄덕이는', ref: '행 24:10', fmt: 'text', html: '시험용 단일절 해설. <a class="sc" data-c="G5012">G5012</a> 같은 낱말.', start_key: 24010, end_key: 24010, ch1: 24, ch2: 24 },
    { id: 4, comm: 'ivp', comm_name: 'IVP 성경주석', kind: '주해', title: '시험 주석 2', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 둘째.', start_key: 24010, end_key: 24010, ch1: 24, ch2: 24 },
    { id: 5, comm: 'esv', comm_name: 'ESV 주석', kind: '주해', title: '시험 주석 3', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 셋째.', start_key: 24010, end_key: 24010, ch1: 24, ch2: 24 },
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

  // ---- 자료 출처(항목 목록)용 가짜 데이터
  const MOCK_FILES = [
    { id: 'bible:개역개정', kind: 'bible', name: '개역개정', grp: '한국어', bytes: 102400, sha256: 'a1', license: '시험 근거', db_bytes: 204800 },
    { id: 'bible:새번역', kind: 'bible', name: '새번역', grp: '한국어', bytes: 204800, sha256: 'a2', license: '시험 근거', db_bytes: 409600 },
    { id: 'code:KJV_S', kind: 'code', name: 'KJV 원어 번호', grp: '원어', bytes: 51200, sha256: 'a3', license: '시험 근거', db_bytes: 102400 },
    { id: 'lex:HebGrkKo', kind: 'lex', name: 'HebGrkKo', grp: '한글', bytes: 25600, sha256: 'a4', license: '시험 근거', db_bytes: 51200 },
    { id: 'comm:카리스', kind: 'comm', name: '카리스', grp: '주석', bytes: 307200, sha256: 'a5', license: '시험 근거', db_bytes: 614400 },
    { id: 'comm:IVP', kind: 'comm', name: 'IVP', grp: '주석', bytes: 12800, sha256: 'a6', license: '시험 근거', db_bytes: 25600 },
  ];

  let mockInstalledFiles = ['bible-ko', 'orig', 'comm'];
  let mockItems = [
    { id: 'bible:개역개정', kind: 'bible', name: '개역개정', grp: '한국어', sha256: 'a1', bytes: 102400, db_bytes: 204800, license: '시험 근거' },
  ];

  function mockSources() { return [{
    origin: 'mock://시험',
    decl: { updated: '시험일', note: '시험용 자료입니다.', files: [] },
    installed: mockInstalledFiles,
    sources: [{ origin: 'mock://시험', title: '시험 자료', files: [] }],
    items: mockItems,
  }]; }

  const FREE_URL = 'mock://free-bundle';

  function mockInvoke(cmd, args) {
    args = args || {};
    let r;
    switch (cmd) {
      case 'sources': r = mockSources(); break;

      case 'free_url': r = FREE_URL; break;

      case 'preview_source': {
        const url = args.url;
        if (url === FREE_URL) {
          r = { layout: 'items', title: '기본 자료(저작권 자유)', origin: 'mock', updated: '시험일', note: '지어낸 항목 목록입니다.', links: [{ title: '추가 목록(시험)', url: 'mock://bundle-2' }], files: MOCK_FILES.slice(0, 4) };
        } else if (url === 'mock://bundle-2') {
          r = { layout: 'items', title: '추가 목록', origin: 'mock', updated: '시험일', note: '', links: [], files: MOCK_FILES.slice(4) };
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
        for (const x of f) if (!mockItems.some((i) => i.id === x.id)) mockItems.push({ id: x.id, kind: x.kind, name: x.name, grp: x.grp, sha256: x.sha256, bytes: x.bytes, db_bytes: x.db_bytes, license: x.license });
        r = null; break;
      }

      case 'add_items': {
        const ids = args.ids || [];
        for (const id of ids) { const x = MOCK_FILES.find((m) => m.id === id); if (x && !mockItems.some((i) => i.id === id)) mockItems.push({ id: x.id, kind: x.kind, name: x.name, grp: x.grp, sha256: x.sha256, bytes: x.bytes, db_bytes: x.db_bytes, license: x.license }); }
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
          mockItems.push({ id: it.id, kind: it.kind, name: it.name, grp: it.grp, sha256: it.sha256, bytes: it.bytes, db_bytes: it.bytes * 2, license: it.license || '' });
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
      case 'notes': r = NOTES; break;
      case 'parse': r = PARSE; break;
      case 'lex': r = LEX[args.code] || []; break;
      case 'search_text': r = [{ area: 'bible', src: '개역개정', bk: 44, ch: 24, v: 10, ref_: '행 24:10', note_id: 0, snippet: '시험 [본문] 검색 결과' }]; break;
      case 'goto_ref': r = args.input && /\d/.test(args.input) ? [44, 24, 10] : null; break;
      case 'articles': r = ARTICLES; break;
      case 'article_body': r = '시험 소논문 본문입니다.<br>둘째 줄.'; break;

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
