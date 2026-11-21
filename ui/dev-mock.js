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

  const NOTES = [
    { id: 1, comm: '카리스', comm_name: '카리스종합주석', kind: '주해', title: '시험 주석 1', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 첫째. 짧은 설명입니다.' },
    { id: 2, comm: 'IVP', comm_name: 'IVP 성경주석', kind: '주해', title: '시험 주석 2', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 둘째. <a class="sc" data-c="G5012">G5012</a> 같은 낱말.' },
    { id: 3, comm: 'ESV', comm_name: 'ESV 주석', kind: '주해', title: '시험 주석 3', ref: '행 24:10', fmt: 'text', html: '시험 주석 본문 셋째.' },
  ];

  const PARSE = [
    { i: 1, w: 'ταπεινο', code: 'G5012', lemma: 'ταπεινοφροσύνη', tr: 'tapeinophrosynē', parse: 'N-NSF', gloss: '견손' },
    { i: 2, w: 'ἐν', code: 'G1722', lemma: 'ἐν', tr: 'en', parse: 'PREP', gloss: '~안에' },
  ];

  const LEX = {
    G5012: [{ dict: 'HebGrkKo', code: 'G5012', head: 'ταπεινοφροσύνη', html: '시험 사전 뜻. 겸손한 마음.' }],
    G1722: [{ dict: 'HebGrkEn', code: 'G1722', head: 'ἐν', html: '시험 사전 뜻. in, by.' }],
  };

  const ARTICLES = [{ id: 1, series: '시험시리즈', src_name: '시험 출처', section: '신약', title: '시험 소논문 제목', kind: 'article', chars: 12 }];

  function mockInvoke(cmd, args) {
    args = args || {};
    let r;
    switch (cmd) {
      case 'sources': r = [{ origin: 'mock://시험', decl: { updated: '시험일', note: '시험용', files: [] }, installed: ['bible-ko', 'orig', 'comm'] }]; break;
      case 'preview_source': r = { origin: 'mock', updated: '시험', note: '', files: [] }; break;
      case 'add_source':
      case 'sync_source': r = []; break;
      case 'remove_source':
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

  window.__TAURI__ = {
    core: { invoke: mockInvoke },
    event: {
      listen: () => Promise.resolve(() => {}),
      once: () => Promise.resolve(() => {}),
    },
  };
})();
