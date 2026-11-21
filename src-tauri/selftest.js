(async () => {
  if (window.__st) return; window.__st = 1;
  const { invoke } = window.__TAURI__.core;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { if (f()) return true; await sleep(200); } return false; };
  const q = (s) => document.querySelector(s);
  const out = [];
  try {
    await sleep(1500);
    document.querySelector('#tabs button[data-view=sources]').click();
    const free = (await invoke('free_url')) === window.__SELFTEST_URL;
    if (free) q('#freebtn').click(); else { q('#srcurl').value = window.__SELFTEST_URL; q('#srccheck').click(); }
    out.push('항목 목록 행=' + (await until(() => q('#itemsbox table.items tr td')) ? document.querySelectorAll('#itemsbox table.items tr').length - 1 : 'timeout'));
    out.push('선택 요약=' + (q('#itsum') || {}).textContent);
    q('#itgo').click();
    out.push('설치 완료=' + (await until(() => /받기를 마쳤습니다/.test(q('#srcmsg').textContent), 120000)) + ' 메시지=' + q('#srcmsg').textContent);
    await sleep(500);
    out.push('색인 완료=' + (await until(() => /모두 마쳤/.test(q('#srcmsg').textContent), 120000)));
    out.push('출처 목록=' + q('#srclist').textContent.slice(0, 80));
    document.querySelector('#tabs button[data-view=bible]').click();
    q('#goto').value = '행 24:10';
    q('#goto').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    out.push('24:10 선택=' + await until(() => document.querySelector('.vrow.sel[data-v="10"]')));
    await until(() => document.querySelector('#parse table'));
    await sleep(500);
    const row = document.querySelector('.vrow.sel');
    out.push('본문=' + (row ? row.textContent.slice(0, 80) : 'none'));
    out.push('장=' + q('#book').selectedOptions[0].textContent + ' ' + q('#chap').value);
    out.push('주석 탭=' + [...document.querySelectorAll('#comm-tabs button')].map((b) => b.textContent).join('|'));
    const car = [...document.querySelectorAll('#comm-tabs button')].find((b) => /카리스/.test(b.textContent));
    if (car) { car.click(); await sleep(200); }
    out.push('카리스 주석 표시=' + (q('#notes').textContent.trim().slice(0, 60)));
    out.push('선택 번역본 수=' + document.querySelectorAll('#vers input').length);
    out.push('매튜헨리 탭=' + !![...document.querySelectorAll('#comm-tabs button')].find((b) => /매튜헨리/.test(b.textContent)));
    out.push('원전 분해 행=' + document.querySelectorAll('#parse tr[data-c]').length);
    const r = [...document.querySelectorAll('#parse tr[data-c]')].find((t) => t.dataset.c === 'G611');
    if (r) r.click();
    await sleep(500);
    out.push('사전=' + q('#lexbox').textContent.slice(0, 60));
    // 번호 본문
    const s = document.querySelector('#vers input[value="개역개정S"]'); if (s) { s.checked = true; s.dispatchEvent(new Event('change', { bubbles: true })); }
    await sleep(800);
    out.push('번호 단추 수=' + document.querySelectorAll('#text a.sc').length);
    const sc = document.querySelector('#text a.sc'); if (sc) { sc.click(); await sleep(400); out.push('번호 클릭 사전=' + q('#lexbox').textContent.slice(0, 50)); }
    document.querySelector('.vrow[data-v="10"]').click();
    document.querySelector('#orig-box').open = true;
    q('#side-head').scrollIntoView();
    q('#q').value = '뉴산토스'; q('#area').value = 'comm'; document.querySelector('#tabs button[data-view=search]').click(); q('#dosearch').click();
    await until(() => document.querySelector('#results .hit'), 20000);
    out.push('주석 검색 결과=' + document.querySelectorAll('#results .hit').length);
    q('#q').value = '총독'; q('#area').value = 'bible'; q('#dosearch').click(); await sleep(1500);
    out.push('성경 검색 결과=' + document.querySelectorAll('#results .hit').length);
    document.querySelector('#tabs button[data-view=bible]').click();
    if (window.__SELFTEST_LOCAL) {
      await handlePaths([window.__SELFTEST_LOCAL]);
      out.push('파일로 추가 목록 행=' + document.querySelectorAll('#itemsbox table.items tr').length);
      const orig = window.confirm; window.confirm = () => false;
      q('#itgo').click();
      out.push('가져오기=' + (await until(() => /가져왔습니다/.test(q('#srcmsg').textContent), 60000)) + ' ' + q('#srcmsg').textContent.slice(0, 40));
      window.confirm = orig;
      await sleep(3000);
      document.querySelector('#tabs button[data-view=bible]').click();
      out.push('내 파일 번역본=' + !!document.querySelector('#vers input[value="WEB"]'));
    }
    out.push('SCREENSHOT_READY');
  } catch (e) { out.push('오류 ' + e); }
  await invoke('selftest_report', { text: out.join('\n') });
})();
