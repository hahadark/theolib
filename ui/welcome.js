/* welcome.js — 앱을 켜면 한 번 뜨는 회원 로그인 창.
   신학 서재는 회원용 프로그램이므로, 로그인하지 않았으면 가운데 대화 상자로 안내한다.
   - 서재 주소(web_base)가 비어 있으면 띄우지 않는다(설정의 계정 갈래에서 먼저 넣어야 한다).
   - 로그인하면 창을 닫고 theolib:account 이벤트를 쏜다(설정·AI 연구 화면이 다시 그린다).
   - [로그인 없이 성경만 보기]·Esc 로 닫힌다. '다시 묻지 않기'를 체크했으면 localStorage 에 기억한다.
   바깥에 내놓는 것은 window.Welcome = { open, close } 뿐이다. */
(function () {
  'use strict';

  const KEY = 'theolib.ui.welcome';      // "off" 이면 다음부터 띄우지 않는다
  const ROLE_LABEL = { owner: '관리자', special: '특별 계정', member: '회원', guest: '게스트' };

  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ico = (n, sz) => (window.Icon ? window.Icon(n, sz || 16) : '');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const S = { el: null, busy: false, closedThisRun: false, keydown: null };

  function invoke(cmd, args) {
    const core = window.__TAURI__ && window.__TAURI__.core;
    if (!core) return Promise.reject('앱 연결이 아직 준비되지 않았습니다.');
    return core.invoke(cmd, args);
  }

  function welcomeOff() {
    try { return localStorage.getItem(KEY) === 'off'; } catch (e) { return false; }
  }

  // 작은 알림 한 줄(3초). study.js 의 .stoast 와 같은 모양이되 이 파일만으로도 뜨게 한다.
  let toastEl = null;
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3000);
  }

  function say(msg, err) {
    const m = S.el && $('#wel-msg', S.el);
    if (!m) return;
    m.textContent = msg || '';
    m.className = 'wel-msg' + (err ? ' err' : '');
  }

  // ---- 무늬
  function markup(base) {
    const brand = '<div class="wel-head">'
      + '<span class="wel-mark" aria-hidden="true">' + ico('book-open', 28) + '</span>'
      + '<div class="wel-brand">신학 서재</div>'
      + '<p class="wel-lead">회원용 프로그램입니다. 로그인하면 AI 본문연구와 서재 자료를 쓸 수 있습니다.</p>'
      + '</div>';
    if (!base) {
      // 주소가 없으면 로그인 자체가 안 되므로 설정으로 보낸다.
      return brand
        + '<div class="dialog-body">'
        + '<p class="wel-note">서재 주소가 설정되지 않았습니다. 설정의 계정에서 서재 주소를 넣어 주세요.</p>'
        + '</div>'
        + '<div class="dialog-actions">'
        + '<button type="button" class="btn btn-quiet" id="wel-close">닫기</button>'
        + '<span class="spacer"></span>'
        + '<button type="button" class="btn btn-primary" id="wel-gosetup">설정 열기</button>'
        + '</div>';
    }
    return brand
      + '<div class="dialog-body">'
      + '<label class="field"><span>아이디</span><input id="wel-id" autocomplete="username" spellcheck="false" autocapitalize="off"></label>'
      + '<label class="field"><span>비밀번호</span><input id="wel-pw" type="password" autocomplete="current-password"></label>'
      + '<div class="wel-go"><button type="button" class="btn btn-primary" id="wel-login">로그인</button></div>'
      + '<div id="wel-msg" class="wel-msg" role="status"></div>'
      + '<div class="wel-signup"><span class="muted">아직 회원이 아니신가요?</span>'
      + '<button type="button" class="btn btn-quiet wel-mini" id="wel-signup">' + ico('external', 14) + '신학서재에서 가입하기</button></div>'
      + '<p id="wel-signup-note" class="wel-note" hidden>브라우저에서 가입을 마친 다음, 이 창으로 돌아와 가입한 아이디로 로그인하세요. (가입에는 서재에서 안내받은 공통 비밀번호가 필요합니다.)</p>'
      + '</div>'
      + '<div class="dialog-actions">'
      + '<button type="button" class="btn btn-quiet" id="wel-skip">로그인 없이 성경만 보기</button>'
      + '<span class="spacer"></span>'
      + '<label class="wel-ck"><input type="checkbox" id="wel-never"> 다시 묻지 않기</label>'
      + '</div>';
  }

  function close(reason) {
    if (!S.el) return;
    const never = $('#wel-never', S.el);
    // 로그인 없이 닫을 때만 '다시 묻지 않기'를 기억한다.
    if (reason !== 'login' && never && never.checked) {
      try { localStorage.setItem(KEY, 'off'); } catch (e) {}
      // 설정의 계정 갈래에 '다시 보이기' 단추가 바로 보이게 한다.
      try { window.dispatchEvent(new CustomEvent('theolib:welcome-off')); } catch (e) {}
    }
    if (S.keydown) { document.removeEventListener('keydown', S.keydown, true); S.keydown = null; }
    const el = S.el;
    S.el = null;
    S.busy = false;
    S.closedThisRun = true;
    el.remove();
  }

  async function onLogin() {
    const idEl = $('#wel-id', S.el);
    const pwEl = $('#wel-pw', S.el);
    const btn = $('#wel-login', S.el);
    const id = idEl ? idEl.value.trim() : '';
    const pw = pwEl ? pwEl.value : '';
    if (!id || !pw) { say('아이디와 비밀번호를 넣어 주세요.', true); (id ? pwEl : idEl).focus(); return; }
    S.busy = true;
    if (btn) btn.disabled = true;
    say('로그인하는 중…');
    try {
      const st = await invoke('web_login', { id, pw });
      if (pwEl) pwEl.value = '';
      close('login');
      // 설정 화면과 AI 연구 화면을 다시 그린다(둘 다 이 이벤트를 듣거나 직접 새로 읽는다).
      try { window.dispatchEvent(new CustomEvent('theolib:account')); } catch (e) {}
      if (window.Settings && window.Settings.refresh) { try { await window.Settings.refresh(); } catch (e) {} }
      const role = ROLE_LABEL[(st && st.role) || (st && st.owner ? 'owner' : '')] || '';
      toast((st && st.user ? st.user : id) + '님, 로그인했습니다.' + (role ? ' (' + role + ')' : ''));
    } catch (e) {
      S.busy = false;
      if (btn) btn.disabled = false;
      say((typeof e === 'string' ? e : (e && e.message)) || '로그인하지 못했습니다.', true);
      if (pwEl) { pwEl.value = ''; pwEl.focus(); }
    }
  }

  // 대화 상자 안에서만 Tab 이 돌게 한다.
  function trapTab(ev) {
    if (!S.el || ev.key !== 'Tab') return;
    const items = Array.from(S.el.querySelectorAll('input,button,select,textarea,a[href]'))
      .filter((x) => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  }

  function open() {
    if (S.el) return;
    S.closedThisRun = false;
    // 그리기 전에 한 번 더 확인한다(로그인되어 있으면 띄우지 않는다).
    Promise.all([
      invoke('web_status').catch(() => null),
      invoke('web_base_get').catch(() => null),
    ]).then(([st, info]) => {
      if (S.el) return;
      if (st && st.logged_in) { toast('이미 ' + (st.user || '서재') + '님으로 로그인되어 있습니다.'); return; }
      const base = (info && info.base) || (st && st.base) || '';
      paint(base);
    });
  }

  function paint(base) {
    const back = document.createElement('div');
    back.className = 'dialog-backdrop wel-backdrop';
    const dlg = document.createElement('div');
    dlg.className = 'dialog wel-dlg';
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-labelledby', 'wel-brand');
    dlg.innerHTML = markup(base);
    // 상표 글에 id 를 준다(aria-labelledby).
    const brand = $('.wel-brand', dlg);
    if (brand) brand.id = 'wel-brand';
    back.appendChild(dlg);
    document.body.appendChild(back);
    S.el = back;
    hydrate(back);

    // 뒤 화면은 눌리지 않는다(바깥을 누르면 아무 일도 하지 않는다).
    back.addEventListener('mousedown', (ev) => { if (ev.target === back) ev.preventDefault(); });

    const go = $('#wel-login', back);
    if (go) go.onclick = onLogin;
    const idEl = $('#wel-id', back);
    const pwEl = $('#wel-pw', back);
    if (idEl) {
      idEl.onkeydown = (ev) => { if (ev.key === 'Enter' && pwEl) { ev.preventDefault(); pwEl.focus(); } };
      idEl.focus();
    }
    if (pwEl) pwEl.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); onLogin(); } };

    const skip = $('#wel-skip', back);
    if (skip) skip.onclick = () => close('skip');

    const join = $('#wel-signup', back);
    if (join) join.onclick = async () => {
      try {
        await invoke('web_open', { path: '/signup' });
        const note = $('#wel-signup-note', back);
        if (note) note.hidden = false;
      } catch (e) {
        say((typeof e === 'string' ? e : (e && e.message)) || '브라우저를 열지 못했습니다.', true);
      }
    };

    const setup = $('#wel-gosetup', back);
    if (setup) setup.onclick = () => {
      close('setup');
      if (window.Settings) window.Settings.open('account');
      else if (window.AppShowView) window.AppShowView('settings', 'account');
    };
    const shut = $('#wel-close', back);
    if (shut) shut.onclick = () => close('skip');

    // Esc = 로그인 없이 보기
    S.keydown = (ev) => {
      if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); close('skip'); return; }
      trapTab(ev);
    };
    document.addEventListener('keydown', S.keydown, true);
  }

  function hydrate(root) {
    Array.from(root.querySelectorAll('[data-icon]')).forEach((el) => {
      const svg = ico(el.dataset.icon, +(el.dataset.size || 20));
      if (svg) el.innerHTML = svg;
    });
  }

  // ---- 시작: 앱(또는 dev-mock)이 준비된 뒤 스스로 돈다. app.js 의 boot 흐름은 건드리지 않는다.
  async function waitTauri() {
    for (let i = 0; i < 50; i += 1) {
      const core = window.__TAURI__ && window.__TAURI__.core;
      if (core && typeof core.invoke === 'function') return true;
      await sleep(100);
    }
    return false;
  }

  async function start() {
    if (welcomeOff()) return;
    if (!(await waitTauri())) return;
    await sleep(60);
    let st = null;
    let info = null;
    try { st = await invoke('web_status'); } catch (e) { st = null; }
    try { info = await invoke('web_base_get'); } catch (e) { info = null; }
    if (st && st.logged_in) return;
    const base = (info && info.base) || (st && st.base) || '';
    if (!base) return;      // 주소부터 넣어야 하므로 설정의 계정 갈래에 맡긴다
    paint(base);
  }

  function boot() {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { start(); }, { once: true });
    else start();
  }

  window.Welcome = { open, close };
  boot();
})();
