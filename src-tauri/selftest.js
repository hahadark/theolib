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
    q('#srcurl').value = window.__SELFTEST_URL;
    q('#srccheck').click();
    out.push('미리보기 파일 수=' + (await until(() => q('#srcpreview input[type=checkbox]')) ? document.querySelectorAll('#srcpreview input[type=checkbox]').length : 'timeout'));
    out.push('미리보기 제목=' + (q('#srcpreview b') || {}).textContent);
    [...document.querySelectorAll('#srcpreview button')].find((b) => b.textContent === '받기').click();
    out.push('설치 완료=' + (await until(() => /완료/.test(q('#srcmsg').textContent))) + ' 메시지=' + q('#srcmsg').textContent);
    await sleep(500);
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
    out.push('SCREENSHOT_READY');
  } catch (e) { out.push('오류 ' + e); }
  await invoke('selftest_report', { text: out.join('\n') });
})();
