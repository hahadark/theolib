/* settings.js — 설정 화면(계정 · AI 연결 · 자료 · 서식 · 앱 정보).
   설계: docs/SETTINGS_DESIGN.md 3.2~3.5. 모양: docs/UI_DESIGN.md.
   바깥에 내놓는 것은 window.Settings = { show(tab?), open(tab) } 뿐이다.
   - 갈래 이동은 화면 안 상태로만 한다(해시를 쓰지 않는다). */
(function () {
  'use strict';

  const { invoke } = window.__TAURI__.core;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ico = (n, sz) => (window.Icon ? window.Icon(n, sz || 16) : '');
  function hydrate(root) { if (window.IconHydrate) window.IconHydrate(root); }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const TABS = ['account', 'ai', 'data', 'format', 'about'];
  const LAST_KEY = 'settingsTab';
  const SCOPE_LABEL = { owner: '관리자', special: '특별 계정', member: '회원', guest: '게스트', localmcp: '이 PC 연결', none: '로그인 안 함' };
  const LOCAL_IDS = ['deepseek', 'claude', 'codex'];

  const S = {
    tab: 'account',
    loaded: false,
    web: null,          // web_status
    webBase: null,      // web_base_get(서재 주소 상태)
    scope: null,        // ai_scope
    engines: [],
    mcp: null,          // mcp_status
    info: null,         // app_info
    pref: null,         // /api/me/ai-pref (회원)
    prefBusy: false,
    guide: {},          // engine id -> CliGuide
    guideBusy: {},
    draft: {},          // engine id -> {key, model, save, url}
    msg: {},            // engine id -> {t, err}
    cli: {},            // engine id -> {win, logged, busy, hint}
    test: {},           // engine id -> {busy, ok, t}
    cli_ok: {},         // engine id -> 연결 시험 성공한 버전(claude/codex)
    app: { can: false, busy: false, done: false, msg: '', err: false },
    awaitFocus: false,
  };

  // ------------------------------------------------------------ 작은 도구
  function paneEl(id) { return $('#view-settings .set-pane[data-pane="' + id + '"]'); }
  function engine(id) { return S.engines.find((e) => e.id === id) || null; }
  function draftOf(id) {
    if (!S.draft[id]) {
      const e = engine(id) || {};
      S.draft[id] = { key: '', model: e.model || ((e.models && e.models[0]) || ''), save: true, url: '' };
    }
    return S.draft[id];
  }
  function setMsg(id, t, err) { S.msg[id] = { t: t || '', err: !!err }; }
  function msgHtml(id, cls) {
    const m = S.msg[id];
    if (!m || !m.t) return '<span class="set-msg ' + (cls || '') + '"></span>';
    return '<span class="set-msg ' + (m.err ? 'err' : 'ok') + ' ' + (cls || '') + '">' + esc(m.t) + '</span>';
  }
  // 클립보드: 복사가 안 되는 환경(권한·초점 없음)에서도 화면이 멈지 않게 한다.
  function copyLegacy(txt) {
    try {
      const a = document.createElement('textarea');
      a.value = txt; a.setAttribute('readonly', '');
      a.style.position = 'fixed'; a.style.top = '-1000px';
      document.body.appendChild(a); a.select();
      const ok = document.execCommand('copy');
      a.remove();
      return ok;
    } catch (e) { return false; }
  }
  async function copyText(t) {
    const txt = String(t == null ? '' : t);
    if (copyLegacy(txt)) return true;
    try {
      // 권한 대화상자가 뜰 수 있는 환경에서 끝없이 기다리지 않는다.
      await Promise.race([navigator.clipboard.writeText(txt), sleep(1500)]);
      return true;
    } catch (e) { return false; }
  }
  function readLast() {
    try { const v = localStorage.getItem('theolib.ui.settings.tab'); return TABS.includes(v) ? v : 'account'; }
    catch (e) { return 'account'; }
  }
  function writeLast(t) {
    try { localStorage.setItem('theolib.ui.settings.tab', t); } catch (e) {}
  }

  // ------------------------------------------------------------ 계정
  function canRows(scope) {
    const s = scope || 'none';
    const ai = {
      owner: ['이 PC의 AI와 서재 서버의 구독 AI', true],
      localmcp: ['이 PC의 AI (서재 연결 주소를 넣은 경우)', true],
      special: ['서재 서버의 구독 AI', true],
      member: ['내가 받은 API 키', true],
      guest: ['연구할 때마다 넣는 API 키', true],
      none: ['없음 — 먼저 로그인해 주세요', false],
    }[s];
    const data = (s === 'owner' || s === 'special')
      ? ['전체 (번역본·원어·주석)', true]
      : ['기본 자료만', false];
    const read = (s === 'none')
      ? ['로그인하면 쓸 수 있습니다', false]
      : ['계정 권한대로 읽을 수 있습니다', true];
    return [['AI 연구', ai[0], ai[1]], ['서재 자료 받기', data[0], data[1]], ['서재 읽기', read[0], read[1]]];
  }

  function renderAccount() {
    const box = paneEl('account');
    if (!box) return;
    const web = S.web || {};
    const sc = S.scope || {};
    const wb = S.webBase || { base: '', default: false, has_default: false };
    const base = wb.base || '';
    const noBase = !base;
    const out = ['<h1 class="set-h1">계정</h1>'];

    // 서재 주소가 없으면 먼저 넣게 한다. 로그인 칸은 주소를 넣은 뒤에 쓸 수 있다.
    if (noBase) {
      out.push('<section class="card">'
        + '<h2 class="card-title">서재 주소</h2>'
        + '<p class="card-desc">서재 관리자에게 받은 주소를 넣어 주세요.</p>'
        + '<div class="set-form">'
        + '<label class="field"><span>서재 주소</span><input id="set-base" autocomplete="off" spellcheck="false" placeholder="https://…"></label>'
        + '<button type="button" class="btn btn-primary" id="set-base-go">저장</button>'
        + '</div>'
        + '<div id="set-base-msg" class="set-msg"></div>'
        + '</section>');
    }

    if (!web.logged_in) {
      out.push('<section class="card">'
        + '<h2 class="card-title">서재 계정으로 로그인</h2>'
        + '<p class="card-desc">온라인 신학서재와 같은 계정입니다. 비밀번호는 저장하지 않고, 로그인 상태만 이 컴퓨터의 보안 저장소에 둡니다.</p>'
        + (noBase ? '<p class="set-note">서재 주소를 먼저 넣어 주세요.</p>' : '')
        + '<div class="set-form">'
        + '<label class="field"><span>아이디</span><input id="set-id" autocomplete="username" spellcheck="false"' + (noBase ? ' disabled' : '') + '></label>'
        + '<label class="field"><span>비밀번호</span><input id="set-pw" type="password" autocomplete="current-password"' + (noBase ? ' disabled' : '') + '></label>'
        + '<button type="button" class="btn btn-primary" id="set-login"' + (noBase ? ' disabled' : '') + '>로그인</button>'
        + '</div>'
        + '<div id="set-login-msg" class="set-msg"></div>'
        + '</section>');
      out.push('<section class="card">'
        + '<details class="src-help"><summary class="disclosure">게스트로 들어가기</summary>'
        + '<p class="card-desc">공통 비밀번호를 넣으면 게스트로 들어갑니다. 연구 기록은 남지 않습니다.</p>'
        + '<div class="set-form">'
        + '<label class="field"><span>공통 비밀번호</span><input id="set-guest" type="password" autocomplete="off"' + (noBase ? ' disabled' : '') + '></label>'
        + '<button type="button" class="btn" id="set-guest-go"' + (noBase ? ' disabled' : '') + '>게스트 입장</button>'
        + '</div>'
        + '<div id="set-guest-msg" class="set-msg"></div>'
        + '</details></section>');
    } else {
      const label = sc.label || SCOPE_LABEL[sc.scope] || '';
      const bcls = sc.scope === 'owner' ? 'ok' : sc.scope === 'special' ? 'acc' : sc.scope === 'member' ? 'acc' : 'mut';
      out.push('<section class="card">'
        + '<div class="set-who"><b>' + esc(web.user || '서재') + '</b>'
        + '<span class="badge ' + bcls + '">' + esc(label) + '</span>'
        + '<span class="spacer"></span>'
        + '<button type="button" class="btn" id="set-logout">' + ico('log-out', 16) + '로그아웃</button></div>'
        + '<ul class="set-can">' + canRows(sc.scope).map((r) =>
          '<li><span class="can-ico ' + (r[2] ? 'yes' : 'no') + '">' + (r[2] ? '✓' : '–') + '</span>'
          + '<span><b>' + esc(r[0]) + '</b> · ' + esc(r[1]) + '</span></li>').join('') + '</ul>'
        + '</section>');
    }
    if (web.pc_off) {
      out.push('<div class="callout warn">집 PC가 꺼져 있습니다. 자료 종류 건수·원본 그림·서재 서버의 AI 는 쉬고, 이 PC의 AI 는 온라인 사본으로 연구합니다.</div>');
    }
    // 주소가 있으면 접힘 안에서 바꾼다.
    if (!noBase) {
      out.push('<section class="card"><details class="src-help"><summary class="disclosure">서재 주소 바꾸기 (고급)</summary>'
        + '<p class="card-desc">지금 주소: <code>' + esc(base) + '</code></p>'
        + '<div class="set-form"><label class="field"><span>서재 주소</span><input id="set-base" autocomplete="off" spellcheck="false" placeholder="https://…" value="' + esc(base) + '"></label>'
        + '<button type="button" class="btn btn-primary" id="set-base-go">저장</button>'
        + (wb.has_default ? '<button type="button" class="btn btn-danger" id="set-base-default">기본값으로</button>' : '')
        + '</div>'
        + '<p class="set-note">주소를 바꾸면 로그인이 풀립니다.</p>'
        + '<div id="set-base-msg" class="set-msg"></div>'
        + '</details></section>');
    }
    box.innerHTML = out.join('');
    hydrate(box);
    wireAccount(box);
  }

  function wireAccount(box) {
    const idEl = $('#set-id', box);
    const pwEl = $('#set-pw', box);
    const goBtn = $('#set-login', box);
    const say = (t, err) => {
      const m = $('#set-login-msg', box);
      if (m) { m.textContent = t || ''; m.className = 'set-msg ' + (err ? 'err' : 'ok'); }
    };
    const login = async () => {
      const id = idEl ? idEl.value.trim() : '';
      const pw = pwEl ? pwEl.value : '';
      if (!id || !pw) { say('아이디와 비밀번호를 넣어 주세요.', true); return; }
      goBtn.disabled = true;
      say('로그인하는 중…');
      try {
        S.web = await invoke('web_login', { id, pw });
        if (pwEl) pwEl.value = '';
        await afterAccount();
      } catch (e) {
        say(typeof e === 'string' ? e : (e && e.message) || '로그인하지 못했습니다.', true);
        goBtn.disabled = false;
      }
    };
    if (goBtn) goBtn.onclick = login;
    if (pwEl) pwEl.onkeydown = (e) => { if (e.key === 'Enter') login(); };
    if (idEl) idEl.onkeydown = (e) => { if (e.key === 'Enter' && pwEl) pwEl.focus(); };

    // 서재 주소 저장(비었을 때는 로그인 전, 있을 때는 접힘 안에서). 저장하면 계정 상태를 다시 읽는다.
    const bEl = $('#set-base', box);
    const bGo = $('#set-base-go', box);
    const bsay = (t, err) => {
      const m = $('#set-base-msg', box);
      if (m) { m.textContent = t || ''; m.className = 'set-msg ' + (err ? 'err' : 'ok'); }
    };
    const saveBase = async (val) => {
      if (bGo) bGo.disabled = true;
      bsay('저장하는 중…');
      try {
        S.web = await invoke('web_base_set', { url: val });
        S.webBase = await invoke('web_base_get').catch(() => null);
        S.pref = null;
        await afterAccount();
      } catch (e) {
        bsay(typeof e === 'string' ? e : (e && e.message) || '저장하지 못했습니다.', true);
        if (bGo) bGo.disabled = false;
      }
    };
    if (bGo) bGo.onclick = () => saveBase(bEl ? bEl.value.trim() : '');
    if (bEl) bEl.onkeydown = (e) => { if (e.key === 'Enter') saveBase(bEl.value.trim()); };
    const bDef = $('#set-base-default', box);
    if (bDef) bDef.onclick = () => saveBase('');
    const gEl = $('#set-guest', box);
    const gBtn = $('#set-guest-go', box);
    const gsay = (t, err) => {
      const m = $('#set-guest-msg', box);
      if (m) { m.textContent = t || ''; m.className = 'set-msg ' + (err ? 'err' : 'ok'); }
    };
    const guest = async () => {
      const pw = gEl ? gEl.value : '';
      if (!pw) { gsay('공통 비밀번호를 넣어 주세요.', true); return; }
      gBtn.disabled = true;
      gsay('들어가는 중…');
      try {
        S.web = await invoke('web_guest_login', { pw });
        if (gEl) gEl.value = '';
        await afterAccount();
      } catch (e) {
        gsay(typeof e === 'string' ? e : (e && e.message) || '게스트로 들어가지 못했습니다.', true);
        gBtn.disabled = false;
      }
    };
    if (gBtn) gBtn.onclick = guest;
    if (gEl) gEl.onkeydown = (e) => { if (e.key === 'Enter') guest(); };

    const out = $('#set-logout', box);
    if (out) out.onclick = async () => {
      try { await invoke('web_logout'); } catch (e) {}
      S.web = { logged_in: false };
      S.pref = null;
      await afterAccount();
    };
  }

  // 로그인·로그아웃·게스트 입장 뒤: 권한과 엔진을 다시 읽고 모든 갈래를 다시 그린다.
  async function afterAccount() {
    await refreshAll();
    try { window.dispatchEvent(new CustomEvent('theolib:account')); } catch (e) {}
  }

  // ------------------------------------------------------------ AI 연결
  function scopeId() { return (S.scope && S.scope.scope) || 'none'; }

  function apiCard(e) {
    const d = draftOf(e.id);
    const ok = !!(e.saved || e.ready);
    const hint = e.hint ? ' ' + e.hint : '';
    const models = (Array.isArray(e.models) && e.models.length) ? e.models : (e.model ? [e.model] : []);
    const modelSel = models.length
      ? '<label class="field"><span>모델</span><select data-kf="model" data-eng="' + esc(e.id) + '">'
        + models.map((m) => '<option value="' + esc(m) + '"' + (m === (d.model || e.model) ? ' selected' : '') + '>' + esc(m) + '</option>').join('')
        + '</select></label>'
      : '';
    const urlField = e.id === 'custom'
      ? '<label class="field"><span>주소</span><input data-kf="url" data-eng="custom" value="' + esc(d.url || '') + '" placeholder="https://…" spellcheck="false"></label>'
      : '';
    const t = S.test[e.id] || {};
    return '<div class="ai-card">'
      + '<div class="ai-head"><b>' + esc(e.name) + '</b>'
      + (ok ? '<span class="badge ok">연결됨' + esc(hint) + '</span>' : '<span class="badge mut">키 없음</span>')
      + (e.allowed === false ? '<span class="badge warn">이 계정에서는 못 씀</span>' : '')
      + '</div>'
      + (e.note ? '<p class="ai-desc">' + esc(e.note) + '</p>' : '')
      + '<div class="ai-fields">'
      + '<label class="field"><span>API 키 <span class="muted">(AI 회사에서 받는 비밀번호 같은 글자)</span></span>'
      + '<input data-kf="key" data-eng="' + esc(e.id) + '" type="password" autocomplete="off" spellcheck="false" value="' + esc(d.key || '') + '" placeholder="' + (ok ? '바꾸려면 새 키를 넣으세요' : '키를 붙여 넣으세요') + '"></label>'
      + modelSel + urlField
      + '</div>'
      + '<div class="ai-acts">'
      + '<button type="button" class="btn btn-primary" data-act="save" data-eng="' + esc(e.id) + '">저장</button>'
      + '<button type="button" class="btn" data-act="test" data-eng="' + esc(e.id) + '">' + (t.busy ? '시험하는 중…' : '연결 시험') + '</button>'
      + '<button type="button" class="btn btn-danger" data-act="del" data-eng="' + esc(e.id) + '">키 지우기</button>'
      + msgHtml(e.id) + '</div>'
      + (e.keyurl ? '<div class="ai-keyurl">키 받는 곳: <code>' + esc(e.keyurl) + '</code><button type="button" class="btn btn-quiet" data-act="copyurl" data-eng="' + esc(e.id) + '">' + ico('copy', 14) + '주소 복사</button></div>' : '')
      + '</div>';
  }

  function chkRow(state, num, title, desc, actions) {
    const mark = state === 'done' ? '✓' : state === 'fail' ? '!' : state === 'now' ? '●' : '○';
    return '<li class="chk-row ' + state + '"><span class="chk-ic" aria-hidden="true">' + mark + '</span>'
      + '<div class="chk-body"><div class="chk-t">' + num + '. ' + esc(title) + '</div>'
      + (desc || '') + (actions || '') + '</div></li>';
  }

  function cliCard(e) {
    const g = S.guide[e.id] || null;
    const c = S.cli[e.id] || {};
    const t = S.test[e.id] || {};
    const found = g ? !!g.found : !!e.found;
    const version = g ? (g.version || '') : (e.version || '');
    const path = g ? (g.path || '') : '';
    const logged = g ? g.logged_in : null;
    const installCmd = g ? (g.install_cmd || '') : '';
    const loginCmd = g ? (g.login_cmd || '') : '';
    const plan = g ? (g.plan || '') : (e.note || '');

    // 이전에 연결 시험에 성공한 버전(study_settings.cli_ok[id]). 버전이 같으면 성공한 것으로 본다.
    const okVersion = S.cli_ok && S.cli_ok[e.id] ? String(S.cli_ok[e.id]) : '';
    const testedOk = (okVersion !== '') && (!version || version === okVersion);

    const s1 = found ? 'done' : (c.win === 'install' ? 'now' : 'todo');
    const s2 = logged === true ? 'done' : (found ? (c.win === 'login' ? 'now' : (c.logged ? 'done' : 'todo')) : 'todo');
    // 3단계(연결 시험): 이번에 성공(t.ok) 또는 이전 성공 버전과 현재 버전이 같으면 ✓ 로 본다.
    const s3 = t.ok === true ? 'done' : testedOk ? 'done' : t.ok === false ? 'fail' : (t.busy ? 'now' : 'todo');
    // 지금 할 차례인 단계 하나에만 채운 단추를 쓴다.
    const step = !found ? 1 : (logged !== true ? 2 : (t.ok !== true && !testedOk ? 3 : 0));

    // 배지 규칙: 프로그램 없음 → 설치 필요, 찾았지만 로그인 안 됨 → 로그인 필요,
    // 찾음+로그인 → 준비됨, logged_in 이 null 이고 이전에 성공 → 준비됨, 그 외 → 확인 필요.
    const badge = !found
      ? '<span class="badge warn">설치 필요</span>'
      : (logged === false ? '<span class="badge warn">로그인 필요</span>'
        : (found && logged === true ? '<span class="badge ok">준비됨</span>'
          : (logged === null && testedOk ? '<span class="badge ok">준비됨</span>'
            : '<span class="badge mut">확인 필요</span>')));

    const d1 = found
      ? '<div class="chk-d">찾음' + (path ? ' · <code>' + esc(path) + '</code>' : '') + (version ? ' · 버전 ' + esc(version) : '') + '</div>'
      : '<div class="chk-d">이 PC에 아직 설치되어 있지 않습니다. 아래 단추로 설치 창을 열거나 명령을 직접 실행하세요.</div>'
        + '<div class="chk-acts"><button type="button" class="btn' + (step === 1 ? ' btn-primary' : '') + '" data-act="install" data-eng="' + esc(e.id) + '">설치 창 열기</button>'
        + '<button type="button" class="btn btn-quiet" data-act="copycmd" data-eng="' + esc(e.id) + '">' + ico('copy', 14) + '명령 복사</button></div>'
        + (installCmd ? '<div class="cmdbox"><code>' + esc(installCmd) + '</code></div>' : '')
        + '<div class="chk-d">설치가 끝나면 그 창을 닫고 [다시 확인]을 누릅니다.</div>';

    const d2 = '<div class="chk-d">'
      + (logged === true ? '로그인되어 있습니다.'
        : e.id === 'codex' ? '브라우저에서 Sign in with ChatGPT 로 로그인합니다.'
          : '검은 창이 뜨면 <b>' + esc(loginCmd || '/login') + '</b> 을 치고 Enter → 브라우저가 열리면 구독 계정으로 로그인 → "Login successful" 이 보이면 창을 닫습니다.')
      + '</div>'
      + '<div class="chk-acts"><button type="button" class="btn' + (step === 2 ? ' btn-primary' : '') + '" data-act="login" data-eng="' + esc(e.id) + '" ' + (found ? '' : 'disabled') + '>로그인 창 열기</button></div>';

    const d3 = '<div class="chk-acts"><button type="button" class="btn' + (step === 3 ? ' btn-primary' : '') + '" data-act="clitest" data-eng="' + esc(e.id) + '"' + (t.busy ? ' disabled' : '') + '>'
      + (t.busy ? '시험하는 중… (최대 60초)' : '연결 시험') + '</button>'
      + (t.t ? '<span class="set-msg ' + (t.ok ? 'ok' : 'err') + '">' + esc(t.t) + '</span>' : '') + '</div>';

    const hint1 = c.win === 'install' ? '<div class="chk-hint">창에서 설치를 끝낸 다음 [다시 확인]을 눌러 주세요.</div>' : '';
    const hint2 = c.win === 'login' ? '<div class="chk-hint">창에서 로그인을 끝낸 다음 [다시 확인]을 눌러 주세요.</div>' : '';

    const models = (Array.isArray(e.models) && e.models.length) ? e.models : [];
    const modelPick = s3 === 'done' && models.length
      ? '<div class="chk-model"><span>모델</span><select data-kf="model" data-eng="' + esc(e.id) + '">'
        + models.map((m) => '<option value="' + esc(m) + '"' + (m === draftOf(e.id).model ? ' selected' : '') + '>' + esc(m) + '</option>').join('')
        + '</select></div>'
      : '';

    return '<div class="ai-card">'
      + '<div class="ai-head"><b>' + esc(e.name) + '</b>'
      + badge
      + '<span class="spacer"></span>'
      + msgHtml(e.id)
      + '<button type="button" class="btn btn-quiet" data-act="refresh" data-eng="' + esc(e.id) + '">' + ico('refresh', 14) + '다시 확인</button></div>'
      + '<p class="ai-desc">이 PC에 설치된 ' + esc(e.name.replace(' 구독', '')) + ' 프로그램을 통해 구독으로 연구합니다. API 요금이 들지 않습니다.</p>'
      + '<ol class="chk">'
      + chkRow(s1, '1', '프로그램 설치', d1, hint1)
      + chkRow(s2, '2', '구독 계정으로 로그인', d2, hint2)
      + chkRow(s3, '3', '연결 시험', d3)
      + '</ol>'
      + modelPick
      + (plan ? '<p class="ai-foot">' + esc(plan) + '</p>' : '')
      + '</div>';
  }

  function serverCard(e) {
    const on = !!(S.web && S.web.logged_in);
    const pcOff = !!(S.web && S.web.pc_off);
    return '<div class="ai-card">'
      + '<div class="ai-head"><b>서재 서버의 구독 AI</b>'
      + (pcOff ? '<span class="badge warn">집 PC 꺼짐</span>' : on ? '<span class="badge ok">사용 가능</span>' : '<span class="badge mut">로그인 필요</span>')
      + '</div>'
      + '<p class="ai-desc">집 PC에서 서재 계정의 구독으로 돌립니다. 집 PC가 켜져 있어야 합니다.</p>'
      + (e && e.note ? '<p class="ai-foot">' + esc(e.note) + '</p>' : '')
      + '</div>';
  }

  function memberCard() {
    const pf = S.pref;
    if (!pf) {
      return '<section class="card"><h2 class="card-title">내 AI</h2><p class="card-desc">'
        + (S.prefBusy ? 'AI 연결 정보를 불러오는 중…' : 'AI 연결 정보를 불러오지 못했습니다. 잠시 뒤 다시 열어 주세요.')
        + '</p><div class="ai-acts"><button type="button" class="btn" data-act="pref-reload">다시 불러오기</button></div></section>';
    }
    const ens = (pf.engines || []).filter((e) => e.id !== 'sub');
    if (!ens.length) return '<section class="card"><h2 class="card-title">내 AI</h2><p class="card-desc">쓸 수 있는 AI 가 없습니다.</p></section>';
    const cur = (S.memberPick && ens.some((e) => e.id === S.memberPick)) ? S.memberPick : (ens[0] && ens[0].id);
    const e = ens.find((x) => x.id === cur) || ens[0];
    const d = draftOf('mem:' + e.id);
    if (!d.model) d.model = e.model || ((e.models && e.models[0]) || '');
    const canSave = !!pf.can_save;
    const chips = '<div class="set-chips">' + ens.map((x) =>
      '<button type="button" class="chip' + (x.id === cur ? ' on' : '') + '" data-act="mem-pick" data-eng="' + esc(x.id) + '">'
      + esc(x.name) + (x.saved ? '<small>저장됨</small>' : '') + '</button>').join('') + '</div>';
    const st = e.saved
      ? '키 저장됨 ' + esc(e.hint || '') + ' · 모델 ' + esc(e.model || '')
      : (pf.role === 'guest' ? '연구를 시작할 때 키를 넣어 씁니다.' : '키 없음 · ' + esc(e.note || ''));
    return '<section class="card">'
      + '<h2 class="card-title">내 AI</h2>'
      + '<p class="card-desc">본인 API 키로 연구합니다. AI 사용료는 본인 계정에서 나갑니다. 키는 서재 계정에 암호화해 저장되고, 화면에는 끝 4자리만 보입니다.</p>'
      + chips
      + '<div class="ai-card" style="margin-top:var(--s3)">'
      + '<div class="ai-head"><b>' + esc(e.name) + '</b>' + (e.saved ? '<span class="badge ok">저장됨</span>' : '<span class="badge mut">키 없음</span>') + '</div>'
      + '<p class="ai-desc">' + st + '</p>'
      + '<div class="ai-fields">'
      + '<label class="field"><span>모델</span><select data-kf="model" data-eng="mem:' + esc(e.id) + '">'
      + (e.models || []).map((m) => '<option value="' + esc(m) + '"' + (m === d.model ? ' selected' : '') + '>' + esc(m) + '</option>').join('')
      + '</select></label>'
      + '<label class="field"><span>API 키</span>'
      + '<input data-kf="key" data-eng="mem:' + esc(e.id) + '" type="password" autocomplete="off" spellcheck="false" value="' + esc(d.key || '') + '" placeholder="' + (e.saved ? '저장된 키 사용 중 (' + esc(e.hint || '') + ') · 바꾸려면 새 키' : '여기에 키를 붙여 넣기') + '"></label>'
      + '</div>'
      + (e.keyurl ? '<div class="ai-keyurl">키 받는 곳: <a href="' + esc(e.keyurl) + '" target="_blank" rel="noopener">키 받기 ↗</a></div>' : '')
      + (canSave ? '<label class="set-check"><input type="checkbox" data-kf="save" data-eng="mem:' + esc(e.id) + '"' + (d.save !== false ? ' checked' : '') + '> 이 키를 내 계정에 암호화해 저장 (다음부터 다시 넣지 않아도 됨)</label>' : '')
      + '<div class="ai-acts">'
      + '<button type="button" class="btn" data-act="mem-test" data-eng="' + esc(e.id) + '">연결 시험</button>'
      + '<button type="button" class="btn btn-primary" data-act="mem-save" data-eng="' + esc(e.id) + '">저장</button>'
      + (e.saved ? '<button type="button" class="btn btn-danger" data-act="mem-del" data-eng="' + esc(e.id) + '">키 지우기</button>' : '')
      + msgHtml('mem:' + e.id) + '</div>'
      + '</div>'
      + '<div class="ai-default"><b style="font-size:13px">기본으로 쓸 AI</b>'
      + ens.map((x) => '<label><input type="radio" name="mem-def" value="' + esc(x.id) + '" data-act="mem-def" data-eng="' + esc(x.id) + '"'
        + (pf.default === x.id ? ' checked' : '') + (x.ready ? '' : ' disabled') + '>' + esc(x.name) + (pf.default === x.id ? ' · 기본' : '') + '</label>').join('')
      + '</div>'
      + '</section>';
  }

  function advancedMcp(e) {
    const has = !!(S.mcp && S.mcp.has);
    const m = S.msg.mcp || {};
    return '<details class="src-help"><summary class="disclosure">서재 연결 주소 (고급)</summary>'
      + '<p class="card-desc">관리자 계정으로 로그인하면 자동으로 들어옵니다. 직접 넣어 둔 PC는 로그인하지 않아도 이 PC의 AI 를 쓸 수 있습니다.</p>'
      + '<div class="ai-keyurl">상태: ' + (has ? '<span class="badge ok">있음</span>' : '<span class="badge mut">없음</span>') + '</div>'
      + '<div class="set-form"><label class="field"><span>주소</span><input id="set-mcp" type="password" autocomplete="off" spellcheck="false" placeholder="https://… (서재가 준 연결 주소)"></label></div>'
      + '<div class="ai-acts"><button type="button" class="btn" data-act="mcp-save">저장</button>'
      + '<button type="button" class="btn" data-act="mcp-test">연결 시험</button>'
      + '<button type="button" class="btn btn-danger" data-act="mcp-clear">지우기</button>'
      + '<span class="set-msg ' + (m.err ? 'err' : 'ok') + '">' + esc(m.t || '') + '</span></div>'
      + '</details>';
  }

  function renderAi() {
    const box = paneEl('ai');
    if (!box) return;
    const sc = S.scope || {};
    const sid = scopeId();
    const out = ['<h1 class="set-h1">AI 연결</h1>'];
    out.push('<p class="set-lead">' + esc(sc.note || defaultNote(sid)) + '</p>');

    const local = S.engines.filter((e) => e.kind === 'api' || e.kind === 'cli');
    const main = local.filter((e) => LOCAL_IDS.includes(e.id));
    const rest = local.filter((e) => !LOCAL_IDS.includes(e.id));
    const srv = S.engines.filter((e) => e.kind === 'server');

    if (sid === 'owner' || sid === 'localmcp') {
      out.push('<section class="set-group"><h3>이 PC에서 돌리는 AI</h3>'
        + main.map((e) => (e.kind === 'cli' ? cliCard(e) : apiCard(e))).join('')
        + (rest.length ? '<details class="src-help"><summary class="disclosure">그 밖의 API</summary>'
          + rest.map(apiCard).join('') + '</details>' : '')
        + '</section>');
      out.push('<section class="set-group"><h3>서재 서버의 구독 AI</h3>' + (srv.length ? srv.map(serverCard).join('') : serverCard(null)) + '</section>');
      const okEng = S.engines.filter((e) => e.ready && e.allowed !== false);
      if (okEng.length) {
        out.push('<section class="card"><div class="ai-fields">'
          + '<label class="field"><span>기본으로 쓸 AI</span><select id="set-def">'
          + okEng.map((e) => '<option value="' + esc(e.id) + '"' + (e.id === S.defaultEng ? ' selected' : '') + '>' + esc(e.name) + '</option>').join('')
          + '</select></label>'
          + '<label class="field"><span>한도에 걸리면 이어서 쓸 AI</span><select id="set-fb">'
          + '<option value="">넘기지 않음</option>'
          + S.engines.filter((e) => e.allowed !== false).map((e) => '<option value="' + esc(e.id) + '"' + (e.id === S.fallbackEng ? ' selected' : '') + '>' + esc(e.name) + '</option>').join('')
          + '</select></label></div></section>');
      }
      out.push(advancedMcp());
    } else if (sid === 'special') {
      out.push('<section class="set-group"><h3>서재 구독 AI</h3>'
        + '<div class="ai-card"><div class="ai-head"><b>서재 구독 AI</b><span class="badge ok">이 계정 전용</span></div>'
        + '<p class="ai-desc">이 계정은 서재의 구독 AI 로 연구합니다. 따로 넣을 것이 없습니다.</p>'
        + '<p class="ai-foot">' + (S.web && S.web.pc_off ? '지금은 집 PC가 꺼져 있어 연구를 시작할 수 없습니다.' : '집 PC가 켜져 있으면 바로 연구할 수 있습니다.') + '</p></div>'
        + '</section>');
    } else if (sid === 'member') {
      out.push(memberCard());
    } else if (sid === 'guest') {
      out.push('<section class="card"><h2 class="card-title">게스트</h2>'
        + '<p class="card-desc">게스트는 키를 저장할 수 없습니다. 연구를 시작할 때 키를 넣으면 12시간 동안만 씁니다.</p>'
        + '<p class="set-note">계속 쓰시려면 계정 갈래에서 회원 계정으로 로그인해 주세요(회원가입은 온라인 신학서재에서 합니다).</p>'
        + '<div class="ai-acts" style="margin-top:var(--s3)"><button type="button" class="btn" data-act="go-account">계정으로 가기</button></div></section>');
    } else {
      out.push('<section class="card"><h2 class="card-title">아직 로그인하지 않았습니다</h2>'
        + '<p class="card-desc">먼저 계정 갈래에서 로그인해 주세요. 로그인하면 계정 권한에 맞는 AI 가 여기에 나옵니다.</p>'
        + '<div class="ai-acts" style="margin-top:var(--s3)"><button type="button" class="btn btn-primary" data-act="go-account">계정으로 가기</button></div></section>');
    }
    box.innerHTML = out.join('');
    hydrate(box);
    wireAi(box);
  }

  function defaultNote(sid) {
    return {
      owner: '관리자 계정입니다. 이 PC의 AI(딥시크·클로드 구독·챗GPT 구독·그 밖의 API)와 서재 서버의 구독 AI 를 모두 쓸 수 있습니다.',
      localmcp: '로그인하지 않았지만 서재 연결 주소가 있어 이 PC의 AI 를 쓸 수 있습니다.',
      special: '특별 계정입니다. 서재 서버의 구독 AI 로 연구하며 따로 비용이 들지 않습니다.',
      member: '회원 계정입니다. 본인 API 키로 연구하고, 키는 서재 계정에 저장합니다.',
      guest: '게스트입니다. 연구할 때마다 API 키를 넣어 씁니다.',
      none: '로그인하지 않았습니다. 먼저 계정 갈래에서 로그인해 주세요.',
    }[sid] || '';
  }

  // AI 연결 갈래: 입력값은 초안(S.draft)에 담고, 누름은 한 번만 붙인 위임 리스너가 받는다.
  function wireAi(box) {
    $$('[data-kf]', box).forEach((el) => {
      const key = el.dataset.eng, f = el.dataset.kf;
      const upd = () => { const d = draftOf(key); d[f] = el.type === 'checkbox' ? el.checked : el.value; };
      el.oninput = upd;
      el.onchange = upd;
    });
    if (!box._aiBound) { box._aiBound = true; box.addEventListener('click', onAiClick); }

    const def = $('#set-def', box);
    if (def) def.onchange = () => { S.defaultEng = def.value; savePref('engine', def.value); };
    const fb = $('#set-fb', box);
    if (fb) fb.onchange = () => { S.fallbackEng = fb.value; savePref('fallback', fb.value); };
  }

  // 기본 AI·이어서 쓸 AI 는 AI 본문연구 양식과 같은 설정에 적어 둔다.
  function savePref(key, val) {
    invoke('study_settings_set', { settings: { [key]: val } }).catch(() => {});
  }

  // AI 연결 갈래의 누름을 한 곳에서 받는다(다시 그려도 리스너가 쌓이지 않는다).
  async function onAiClick(ev) {
    const b = ev.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    const id = b.dataset.eng;

    if (act === 'go-account') { setTab('account'); return; }
    if (act === 'refresh') { await refreshGuide(id, true); return; }
    if (act === 'copyurl') {
      const e = engine(id);
      if (e && e.keyurl) { await copyText(e.keyurl); setMsg(id, '주소를 복사했습니다.'); renderAi(); }
      return;
    }
    if (act === 'copycmd') {
      const g = S.guide[id];
      if (g && g.install_cmd) { await copyText(g.install_cmd); setMsg(id, '명령을 복사했습니다.'); renderAi(); }
      return;
    }
    if (act === 'install') {
      try { await invoke('ai_cli_install', { engine: id }); S.cli[id] = Object.assign({}, S.cli[id], { win: 'install' }); S.awaitFocus = true; }
      catch (e) { setMsg(id, '설치 창을 열지 못했습니다.', true); }
      renderAi();
      return;
    }
    if (act === 'login') {
      try { await invoke('ai_cli_login', { engine: id }); S.cli[id] = Object.assign({}, S.cli[id], { win: 'login' }); S.awaitFocus = true; }
      catch (e) { setMsg(id, '로그인 창을 열지 못했습니다.', true); }
      renderAi();
      return;
    }
    if (act === 'clitest') return cliTest(id);
    if (act === 'save') return saveKey(id);
    if (act === 'test') return testKey(id);
    if (act === 'del') return delKey(id);
    if (act === 'pref-reload') { await loadPref(); renderAi(); return; }
    if (act === 'mem-pick') { S.memberPick = id; renderAi(); return; }
    if (act === 'mem-test') return memTest(id);
    if (act === 'mem-save') return memSave(id);
    if (act === 'mem-del') return memDel(id);
    if (act === 'mem-def') { await memDefault(id); return; }
    if (act === 'mcp-save') {
      const inp = $('#set-mcp');
      const v = inp ? inp.value.trim() : '';
      if (!v) { S.msg.mcp = { t: '주소를 넣어 주세요.', err: true }; renderAi(); return; }
      try {
        await invoke('mcp_set', { url: v });
        if (inp) inp.value = '';
        S.mcp = await invoke('mcp_status').catch(() => S.mcp);
        S.msg.mcp = { t: '저장했습니다.', err: false };
      } catch (e) { S.msg.mcp = { t: '저장하지 못했습니다.', err: true }; }
      await refreshEngines();
      renderAi();
      return;
    }
    if (act === 'mcp-test') {
      S.msg.mcp = { t: '시험하는 중…', err: false }; renderAi();
      try {
        const r = await invoke('mcp_test');
        S.msg.mcp = r && r.ok ? { t: '연결됐습니다 · 도구 ' + (r.tools || 0) + '개', err: false } : { t: '연결되지 않았습니다' + (r && r.error ? ' · ' + r.error : ''), err: true };
      } catch (e) { S.msg.mcp = { t: '연결되지 않았습니다.', err: true }; }
      renderAi();
      return;
    }
    if (act === 'mcp-clear') {
      try {
        await invoke('mcp_set', { url: '' });
        S.mcp = await invoke('mcp_status').catch(() => S.mcp);
        S.msg.mcp = { t: '연결 주소를 지웠습니다.', err: false };
        await refreshEngines();
      } catch (e) { S.msg.mcp = { t: '지우지 못했습니다.', err: true }; }
      renderAi();
      return;
    }
  }

  async function refreshEngines() {
    try { S.engines = (await invoke('ai_engines')) || []; } catch (e) { S.engines = []; }
  }

  async function saveKey(id) {
    const e = engine(id); if (!e) return;
    const d = draftOf(id);
    if (!d.key) { setMsg(id, '키를 넣으면 저장할 수 있습니다.', true); renderAi(); return; }
    setMsg(id, '저장하는 중…');
    renderAi();
    try {
      await invoke('ai_key_save', { provider: id, key: d.key, model: d.model || e.model || null, url: d.url || e.url || null });
      d.key = '';
      setMsg(id, '저장했습니다.');
      await refreshEngines();
    } catch (err) { setMsg(id, (err && err.message) || String(err) || '저장하지 못했습니다.', true); }
    renderAi();
  }

  async function delKey(id) {
    try {
      await invoke('ai_key_delete', { provider: id });
      setMsg(id, '키를 지웠습니다.');
      await refreshEngines();
    } catch (e) { setMsg(id, '키를 지우지 못했습니다.', true); }
    renderAi();
  }

  async function testKey(id) {
    const e = engine(id); if (!e) return;
    const d = draftOf(id);
    S.test[id] = { busy: true };
    renderAi();
    try {
      const r = await invoke('ai_test', { engine: id, model: d.model || e.model || null, key: d.key || null, url: d.url || e.url || null });
      S.test[id] = r && r.ok ? { ok: true, t: '연결됐습니다' + (r.detail ? ' · ' + r.detail : '') } : { ok: false, t: (r && r.error) || '연결되지 않았습니다' };
    } catch (err) { S.test[id] = { ok: false, t: (err && err.message) || '연결되지 않았습니다' }; }
    renderAi();
  }

  async function cliTest(id) {
    const e = engine(id); if (!e) return;
    const d = draftOf(id);
    S.test[id] = { busy: true };
    renderAi();
    try {
      const r = await invoke('ai_test', { engine: id, model: d.model || e.model || null, key: null, url: null });
      if (r && r.ok) {
        S.test[id] = { ok: true, t: '연결됐습니다' + (r.detail ? ' · ' + r.detail : '') };
        // 연결 시험에 성공한 버전을 cli_ok 에 적어 둔다(버전이 같으면 준비됨으로 본다).
        const cur = (S.guide[id] && S.guide[id].version) || e.version || '';
        if (cur) {
          S.cli_ok[id] = cur;
          invoke('study_settings_set', { settings: { cli_ok: S.cli_ok } }).catch(() => {});
        }
      }
      else {
        const raw = String((r && r.error) || '');
        let t = raw.slice(0, 200);
        if (/로그인|login|auth/i.test(raw)) { t = '로그인이 필요합니다. 2단계 [로그인 창 열기]를 눌러 구독 계정으로 로그인해 주세요.'; S.cli[id] = Object.assign({}, S.cli[id], { logged: false }); }
        else if (/한도|limit|quota|rate/i.test(raw)) t = '구독 사용 한도에 걸렸습니다. 한도가 풀린 뒤 다시 하거나 다른 AI 를 고르세요.';
        else if (/찾지|없|not found|ENOENT/i.test(raw)) { t = '프로그램을 찾지 못했습니다. 1단계 설치를 다시 해 주세요.'; }
        else t = (raw.slice(0, 200) || '연결되지 않았습니다') + ' 프로그램을 최신으로 올려 보세요(설치 명령을 다시 실행).';
        S.test[id] = { ok: false, t };
      }
    } catch (err) { S.test[id] = { ok: false, t: (err && err.message) || '연결되지 않았습니다' }; }
    await refreshGuide(id, false);
  }

  async function loadGuides() {
    const clis = S.engines.filter((e) => e.kind === 'cli');
    await Promise.all(clis.map((e) => refreshGuide(e.id, false)));
  }

  async function refreshGuide(id, doRefresh) {
    const e = engine(id);
    if (!e || e.kind !== 'cli') return;
    S.guideBusy[id] = true;
    if (doRefresh) renderAi();
    try {
      if (doRefresh) await invoke('ai_cli_refresh').catch(() => {});
      S.guide[id] = await invoke('ai_cli_guide', { engine: id });
      S.cli[id] = Object.assign({}, S.cli[id], { win: null });
    } catch (err) { /* 안내를 읽지 못하면 엔진 정보만 보여 준다 */ }
    S.guideBusy[id] = false;
    renderAi();
  }

  // ------------------------------------------------------------ 회원(내 계정 키)
  async function loadPref() {
    S.prefBusy = true;
    try {
      const out = await invoke('web_api', { method: 'GET', path: '/api/me/ai-pref', body: null });
      const b = out && out.status ? out.body : out;
      S.pref = b && b.engines ? b : null;
    } catch (e) { S.pref = null; }
    S.prefBusy = false;
  }

  function prefEngine(id) { return (S.pref && (S.pref.engines || []).find((e) => e.id === id)) || null; }

  async function memTest(id) {
    const e = prefEngine(id); if (!e) return;
    const d = draftOf('mem:' + id);
    setMsg('mem:' + id, '시험하는 중…');
    renderAi();
    try {
      const r = await invoke('web_api', { method: 'POST', path: '/api/me/aitest', body: { provider: id, key: d.key || undefined, model: d.model } });
      const b = (r && r.status ? r.body : r) || {};
      setMsg('mem:' + id, b.ok ? '키가 정상입니다' : '안 됩니다: ' + (b.error || ''), !b.ok);
    } catch (err) { setMsg('mem:' + id, '연결되지 않았습니다.', true); }
    renderAi();
  }

  async function memSave(id) {
    const e = prefEngine(id); if (!e) return;
    const d = draftOf('mem:' + id);
    if (!d.key && !e.saved) { setMsg('mem:' + id, 'API 키를 넣어 주세요.', true); renderAi(); return; }
    setMsg('mem:' + id, '저장하는 중…');
    renderAi();
    let done = false;
    try {
      const t = await invoke('web_api', { method: 'POST', path: '/api/me/aitest', body: { provider: id, key: d.key || undefined, model: d.model } });
      const tb = (t && t.status ? t.body : t) || {};
      if (!tb.ok) { setMsg('mem:' + id, '시험 실패: ' + (tb.error || ''), true); renderAi(); return; }
      const r = await invoke('web_api', { method: 'POST', path: '/api/me/aikeys', body: { provider: id, key: d.key || undefined, model: d.model } });
      const rb = (r && r.status ? r.body : r) || {};
      if (!rb.ok) { setMsg('mem:' + id, rb.error || '저장하지 못했습니다.', true); renderAi(); return; }
      d.key = '';
      await loadPref();
      const pf = S.pref || {};
      if (!pf.default || !(pf.engines || []).some((x) => x.id === pf.default)) {
        await invoke('web_api', { method: 'POST', path: '/api/me/ai-pref', body: { default: id } }).catch(() => {});
        await loadPref();
      }
      done = true;
      setMsg('mem:' + id, '저장했습니다.');
    } catch (err) { setMsg('mem:' + id, '연결이 끊겼습니다.', true); }
    renderAi();
    if (done) try { window.dispatchEvent(new CustomEvent('theolib:account')); } catch (e) {}
  }

  async function memDel(id) {
    if (!confirm('이 키를 삭제할까요?')) return;
    try {
      await invoke('web_api', { method: 'POST', path: '/api/me/aikeys', body: { provider: id, delete: true } });
      draftOf('mem:' + id).key = '';
      await loadPref();
      setMsg('mem:' + id, '키를 지웠습니다.');
    } catch (e) { setMsg('mem:' + id, '키를 지우지 못했습니다.', true); }
    renderAi();
    try { window.dispatchEvent(new CustomEvent('theolib:account')); } catch (e) {}
  }

  async function memDefault(id) {
    try {
      const r = await invoke('web_api', { method: 'POST', path: '/api/me/ai-pref', body: { default: id } });
      const b = (r && r.status ? r.body : r) || {};
      if (b.error) { setMsg('mem:' + id, b.error, true); renderAi(); return; }
      await loadPref();
      setMsg('mem:' + id, '기본 AI 를 바꿨습니다.');
    } catch (e) { setMsg('mem:' + id, '바꾸지 못했습니다.', true); }
    renderAi();
    try { window.dispatchEvent(new CustomEvent('theolib:account')); } catch (e) {}
  }

  // ------------------------------------------------------------ 자료: 서재 자료 받기
  function renderAppSrc() {
    const box = $('#appsrc-body');
    if (!box) return;
    const sid = scopeId();
    const can = sid === 'owner' || sid === 'special';
    if (!can) {
      // 권한이 바뀌면 앞서 불러온 목록을 화면에 남기지 않는다.
      const ib = $('#itemsbox');
      if (ib) ib.innerHTML = '';
      const sp = $('#srcpreview');
      if (sp) sp.innerHTML = '';
      box.innerHTML = '<p class="card-desc">번역본·주석 등 저작권 자료는 특별 계정만 받을 수 있습니다. 기본 자료로 성경 보기·검색·원어 사전을 쓸 수 있습니다.</p>'
        + (sid === 'none' ? '<div class="ai-acts" style="margin-top:var(--s2)"><button type="button" class="btn" data-act="go-account">계정으로 가기</button></div>' : '');
      const b = $('[data-act="go-account"]', box);
      if (b) b.onclick = () => setTab('account');
      return;
    }
    const a = S.app;
    box.innerHTML = '<p class="card-desc">계정에 열린 번역본·원어·주석을 목록에서 골라 받습니다. 주소는 화면에 남기지 않습니다.</p>'
      + '<div class="ai-acts"><button type="button" class="btn btn-primary" id="appsrc-load"' + (a.busy ? ' disabled' : '') + '>'
      + (a.busy ? '불러오는 중…' : (a.done ? '서재 자료 목록 다시 불러오기' : '서재 자료 목록 불러오기')) + '</button>'
      + '<span class="set-msg ' + (a.err ? 'err' : 'ok') + '">' + esc(a.msg || '') + '</span></div>';
    const b = $('#appsrc-load', box);
    if (b) b.onclick = () => loadAppSource();
  }

  async function loadAppSource() {
    S.app.busy = true; S.app.msg = '불러오는 중…'; S.app.err = false;
    renderAppSrc();
    try {
      const r = await invoke('web_app_source');
      if (!r || !r.can) {
        S.app.err = true;
        S.app.msg = '이 계정에는 서재 자료를 받을 권한이 없습니다.';
        return;
      }
      const url = r.url || '';   // 비밀값: 변수로만 들고 다니며 화면·입력칸·기록에 남기지 않는다.
      if (!url) { S.app.err = true; S.app.msg = '받을 수 있는 주소를 받지 못했습니다. 잠시 뒤 다시 해 주세요.'; return; }
      if (!window.AppPreviewUrl) { S.app.err = true; S.app.msg = '앱 화면이 아직 준비되지 않았습니다.'; return; }
      await window.AppPreviewUrl(url);
      if (window.AppExpandItems) window.AppExpandItems();
      S.app.done = true;
      S.app.msg = '목록을 불러왔습니다. 아래에서 받을 항목을 고르세요.';
      const items = $('#itemsbox');
      if (items && items.scrollIntoView) items.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      S.app.err = true;
      S.app.msg = srcErrorText(e);
    } finally {
      S.app.busy = false;
      renderAppSrc();
    }
  }

  function srcErrorText(e) {
    const t = String((e && e.message) || e || '');
    if (/권한|403|forbidden|forbid/i.test(t)) return '이 계정에는 서재 자료를 받을 권한이 없습니다.';
    if (/503|꺼|pc.?off|집 ?PC|사용할 수 없/i.test(t)) return '집 PC가 꺼져 있어 지금은 받을 수 없습니다. 잠시 뒤 다시 해 주세요.';
    return '서재에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 해 주세요.';
  }

  // ------------------------------------------------------------ 앱 정보
  function renderAbout() {
    const box = $('#appinfo');
    if (!box) return;
    const i = S.info;
    if (!i) { box.innerHTML = '<p class="card-desc">불러오는 중…</p>'; return; }
    box.innerHTML = '<div class="info-row"><span>버전</span><b>v' + esc(i.version || '') + '</b></div>'
      + '<div class="info-row"><span>판</span><span>' + (i.portable ? '포터블판 (자료를 함께 들고 다니는 판)' : '설치판') + '</span></div>'
      + '<div class="info-row"><span>운영체제</span><span>' + esc(i.platform || '') + '</span></div>'
      + '<div class="info-row"><span>자료 폴더</span><code>' + esc(i.data_dir || '') + '</code>'
      + '<button type="button" class="btn" id="set-opendir">' + ico('external', 14) + '폴더 열기</button></div>';
    const b = $('#set-opendir', box);
    if (b) b.onclick = async () => {
      try { await invoke('open_data_dir'); } catch (e) {}
    };
    // 업데이트 카드의 버전 줄이 비어 있으면(app_info 만 있는 경우) 여기서 채운다.
    const uv = $('#updver');
    if (uv && !uv.textContent.trim() && i.version) uv.textContent = '지금 버전 v' + i.version;
    hydrate(box);
  }

  // ------------------------------------------------------------ 서식
  function renderFormat() {
    const host = $('#settings-format');
    if (!host) return;
    if (!window.FormatUI) return;
    if (host.dataset.built === '1') return;
    host.innerHTML = '';
    // 서랍과 같은 부품(.format-pop .fp-*)을 그대로 쓰되, 자리만 흐름 안에 둔다(settings.css).
    host.classList.add('format-pop');
    window.FormatUI.render(host);
    host.dataset.built = '1';
  }

  // ------------------------------------------------------------ 갈래 전환
  function setTab(t, opts) {
    if (!TABS.includes(t)) t = 'account';
    S.tab = t;
    writeLast(t);
    $$('#set-nav button').forEach((b) => {
      const on = b.dataset.tab === t;
      b.classList.toggle('on', on);
      b.setAttribute('aria-current', on ? 'true' : 'false');
    });
    $$('#view-settings .set-pane').forEach((p) => { p.hidden = p.dataset.pane !== t; });
    const sc = $('#set-scroll');
    if (sc) sc.scrollTop = 0;
    renderPane(t, opts);
    if (t === 'format') renderFormat();
    if (t === 'about') loadInfo();
  }

  function renderPane(t, opts) {
    const load = !opts || opts.load !== false;
    if (t === 'account') renderAccount();
    else if (t === 'ai') renderAi();
    else if (t === 'data') { renderAppSrc(); if (load && window.AppLoadSources) window.AppLoadSources(); }
    else if (t === 'about') renderAbout();
  }

  function renderAll() {
    renderAccount();
    renderAi();
    renderAppSrc();
    if (S.info) renderAbout();
  }

  async function loadInfo() {
    if (S.info) { renderAbout(); return; }
    try { S.info = await invoke('app_info'); } catch (e) { S.info = null; }
    renderAbout();
  }

  async function refreshAll() {
    const [web, scope, engines, mcp, webBase] = await Promise.all([
      invoke('web_status').catch(() => null),
      invoke('ai_scope').catch(() => null),
      invoke('ai_engines').catch(() => []),
      invoke('mcp_status').catch(() => null),
      invoke('web_base_get').catch(() => null),
    ]);
    S.web = web || { logged_in: false };
    S.scope = scope || { scope: 'none', label: '로그인 안 함', local_allowed: false, note: '' };
    S.engines = (engines || []).map((e) => Object.assign({}, e));
    S.mcp = mcp || { has: false };
    S.webBase = webBase || { base: '', default: false, has_default: false };
    const st = await invoke('study_settings_get').catch(() => null);
    if (st) { S.defaultEng = st.engine || null; S.fallbackEng = st.fallback || ''; S.cli_ok = st.cli_ok || {}; }
    S.loaded = true;
    if (scopeId() === 'member' || scopeId() === 'guest') await loadPref();
    renderAll();
    await loadGuides();
  }

  // ------------------------------------------------------------ 처음 연결
  function initNav() {
    const nav = $('#set-nav');
    if (!nav) return;
    nav.addEventListener('click', (ev) => {
      const b = ev.target.closest('button[data-tab]');
      if (b) setTab(b.dataset.tab);
    });
    nav.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp' && ev.key !== 'Home' && ev.key !== 'End') return;
      const btns = $$('#set-nav button');
      const i = btns.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      let n = i;
      if (ev.key === 'ArrowDown') n = Math.min(btns.length - 1, i + 1);
      if (ev.key === 'ArrowUp') n = Math.max(0, i - 1);
      if (ev.key === 'Home') n = 0;
      if (ev.key === 'End') n = btns.length - 1;
      btns[n].focus();
      setTab(btns[n].dataset.tab);
    });
  }

  // 다른 창(설치·로그인)에서 돌아오면 한 번 다시 확인한다.
  window.addEventListener('focus', async () => {
    if (!S.awaitFocus) return;
    S.awaitFocus = false;
    const clis = S.engines.filter((e) => e.kind === 'cli');
    if (!clis.length) return;
    await invoke('ai_cli_refresh').catch(() => {});
    await Promise.all(clis.map((e) => refreshGuide(e.id, false)));
    if (S.tab === 'ai') renderAi();
  });

  async function show(tab) {
    const t = TABS.includes(tab) ? tab : S.tab || readLast();
    setTab(t);
    if (!S.loaded) {
      await refreshAll();
      // 첫 호출에서 이미 모든 갈래를 그렸으므로, 자료 목록은 한 번만 불러온다.
      setTab(t, { load: false });
      if (t === 'data' && window.AppLoadSources) window.AppLoadSources();
    } else {
      if (t === 'ai') { renderAi(); loadGuides(); }
      if (t === 'data') { renderAppSrc(); if (window.AppLoadSources) window.AppLoadSources(); }
      if (t === 'about') loadInfo();
    }
    return t;
  }

  function open(tab) {
    if (window.AppShowView) window.AppShowView('settings', tab);
    else { setTab(tab || S.tab); }
  }

  window.Settings = { show, open, refresh: refreshAll, state: S };
  initNav();
  setTab(readLast());
})();
