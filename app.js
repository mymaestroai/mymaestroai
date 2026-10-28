    // ── Session expiry: any same-origin API 401 means the login session is gone ──
    // The password-check endpoints answer 401 for a wrong password, so they keep their own error handling.
    (function installSessionGuard() {
      const nativeFetch = window.fetch.bind(window);
      const keepsOwn401 = (p) => p === '/api/auth/totp/disable' || p === '/api/auth/password' || p === '/api/auth/login';
      let redirecting = false;
      window.fetch = async function (input, init) {
        const res = await nativeFetch(input, init);
        if (res.status === 401 && !redirecting) {
          try {
            const u = new URL(typeof input === 'string' ? input : input.url, location.href);
            if (u.origin === location.origin && u.pathname.startsWith('/api/') && !keepsOwn401(u.pathname)) {
              redirecting = true;
              location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
            }
          } catch (e) { /* unparsable URL: leave the response alone */ }
        }
        return res;
      };
    })();

    // ── Multi-user: who am I, owner view, member gating, account menu ──
    window.hubMe = null;
    const hubEsc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const OWNER_VIEW_KEY = 'hub-owner-view';
    function ownerView() { return localStorage.getItem(OWNER_VIEW_KEY) || 'mine'; }
    function isHubAdmin() { return !window.hubMe || window.hubMe.isAdmin !== false; }
    const agentOwnerCache = new Map();   // agent name -> owner id, kept across owner-view switches so open tabs keep their suffix
    function agentOwnerSuffix(agentName) {
      const me = window.hubMe;
      if (!me || !me.isAdmin) return '';
      const ownerId = agentOwnerCache.get(agentName);
      if (!ownerId || ownerId === me.user.id) return '';
      const o = (me.owners || []).find(x => x.id === ownerId);
      return o ? ' · ' + o.name : '';
    }
    async function loadMe() {
      try {
        const r = await fetch('/api/me', { credentials: 'include' });
        if (r.ok) window.hubMe = await r.json();
        else if (r.status === 401) {
          // No session. On a hub with no accounts at all (updated from before multi-user) /api/me is refused too, so
          // ask the public auth status; hubMe stays undefined so the rest of the page behaves as before.
          try { const a = await (await fetch('/api/auth/status', { credentials: 'include' })).json(); window.hubNoAccounts = a && a.setupNeeded === true && !a.signedIn; } catch {}
        }
      } catch (e) { /* offline: behave as before */ }
      paintSetupNotice();
      paintNoAccountsNotice();
      paintReadinessBanner().catch(() => {});
      paintSecurityBanner().catch(() => {});
      paintUpdateCard().catch(() => {});
      paintVersionLabel().catch(() => {});
      if (!window.__hvTimer) window.__hvTimer = setInterval(() => paintVersionLabel().catch(() => {}), 5 * 60 * 1000);
      if (!window.__ucTimer) window.__ucTimer = setInterval(() => paintUpdateCard().catch(() => {}), 30 * 60 * 1000);
      return window.hubMe;
    }
    // The time zone this person's agents use follows the device they are using (lib/timezone). The page reports its
    // zone on the first tap or key after it opens or comes back into view, then at most every 10 minutes while in use,
    // so a page that reloads by itself where nobody is looking (after a restart) doesn't move it. The hub ignores the
    // reports while a zone is pinned in the Security dialog.
    const TZ_REPORT_EVERY_MS = 10 * 60 * 1000;
    let tzReportedAt = 0;
    let tzChoice = 0;   // counts choices in the Security dialog: an older report's late answer must not undo one
    function deviceTimeZone() { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch { return ''; } }
    function reportTimeZone() {
      const tz = deviceTimeZone();
      const me = window.hubMe;
      if (!tz || !me || !me.user || document.visibilityState !== 'visible') return;
      if (Date.now() - tzReportedAt < TZ_REPORT_EVERY_MS) return;
      tzReportedAt = Date.now();
      const choice = tzChoice;
      fetch('/api/me/timezone', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tz, auto: true }) })
        .then(r => { if (r.status >= 500) throw new Error(`HTTP ${r.status}`); return r.ok ? r.json() : null; })   // a hub error: try again at the next tap
        .then(d => { if (d && d.user && window.hubMe && choice === tzChoice) { window.hubMe.user = { ...window.hubMe.user, ...d.user }; window.hubMe.timeZone = d.timeZone; } })
        .catch(() => { tzReportedAt = 0; });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tzReportedAt = 0; });
    // A chat request carries the device's zone only when it carries a message the person just sent from this page (the
    // send functions set tzSentAt; one request per send, within a minute), never the page's own follow-ups: a group
    // discussion's next speaker, the synthesis, an orchestration's later calls, a retry.
    let tzSentAt = 0;
    function zoneHeader() {
      const tz = deviceTimeZone();
      if (!tz || !tzSentAt || Date.now() - tzSentAt > 60 * 1000) return {};
      tzSentAt = 0;
      return { 'X-Hub-Time-Zone': tz };
    }
    for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, reportTimeZone, { capture: true, passive: true });
    // An install updated from before multi-user has provider keys but no admin account, so the setup wizard never
    // asked for one: the hub runs with no login and every multi-user feature off. Say so, once per page, with the link.
    function paintNoAccountsNotice() {
      const me = window.hubMe;
      let bar = document.getElementById('hub-no-accounts-notice');
      const none = (me && me.accounts === false) || (!me && window.hubNoAccounts === true);
      if (!none) { if (bar) bar.remove(); return; }
      if (bar) return;
      bar = document.createElement('div');
      bar.id = 'hub-no-accounts-notice';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9997;background:#7a3b12;color:#fff;padding:6px 14px;font-weight:600;box-sizing:border-box';
      bar.innerHTML = 'This hub has no login yet: anyone who can reach it has full control, and multi-user features (members, sharing, the account menu, member sandboxes) stay off until an admin account exists. <a href="/welcome" style="color:#fff;text-decoration:underline">Create the admin account</a> (you will need the setup link: run mymaestro setup-link).';
      document.body.prepend(bar);
    }
    // No AI provider configured yet (fresh install after the first admin signed up): a one-line notice with the link
    // to the setup wizard. The wizard no longer takes over "/" once accounts exist, so the 2FA enrolment can finish.
    async function paintSetupNotice() {
      const me = window.hubMe;
      if (!me || !me.isAdmin) return;
      let needed = false;
      try { const r = await fetch('/api/setup/status', { credentials: 'include' }); if (r.ok) needed = !!(await r.json()).setupNeeded; } catch { return; }
      let bar = document.getElementById('hub-setup-notice');
      if (!needed) { if (bar) { bar.remove(); layoutBanners(); } return; }
      if (bar) return;
      bar = document.createElement('div');
      bar.id = 'hub-setup-notice';
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9998;background:#1f4e79;color:#fff;padding:6px 14px;font-weight:600;box-sizing:border-box';
      bar.innerHTML = 'No AI provider is configured yet, so agents cannot answer. <a href="/welcome" style="color:#fff;text-decoration:underline">Open the Welcome page</a> to connect a Claude subscription, an API key or a local model.';
      document.body.prepend(bar);
      layoutBanners();
    }
    function renderOwnerSwitcher() {
      const sel = document.getElementById('owner-view');
      if (!sel) return;
      const me = window.hubMe;
      if (!me || !me.isAdmin) { sel.style.display = 'none'; return; }
      const cur = ownerView();
      const opts = [['mine', 'Mine'], ['infra', 'Infrastructure']];
      for (const o of (me.owners || [])) {
        if (o.id === me.user.id) continue;
        opts.push([o.id, `${o.name} (${o.count})`]);
      }
      if (!opts.some(o => o[0] === cur)) localStorage.setItem(OWNER_VIEW_KEY, 'mine');
      sel.innerHTML = opts.map(([v, l]) => `<option value="${hubEsc(v)}">${hubEsc(l)}</option>`).join('');
      sel.value = ownerView();
      sel.style.display = '';
      sel.onchange = () => { localStorage.setItem(OWNER_VIEW_KEY, sel.value); loadAgents(); if (document.getElementById('files-panel')) openFilesPanel(''); };
    }
    // Members see none of the admin surfaces; the server enforces it too, this just hides dead controls.
    function applyMemberView() {
      const me = window.hubMe;
      if (!me || me.isAdmin) return;
      document.body.classList.add('member-view');
      // Every item of the ⋯ menu is an admin control, so the whole menu goes (more-wrap), not just its rows.
      for (const id of ['comms-btn', 'wallet-btn', 'dream-btn', 'git-sync-btn', 'restart-hub-btn', 'more-advanced', 'advanced-toggle',
                        'settings-btn', 'schedule-btn', 'credit-meter', 'spend-today', 'plan-warn', 'hub-halt-bar', 'halt-btn', 'more-wrap', 'update-chip']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const row = el.closest('.more-item, .more-row') || el;
        row.style.display = 'none';
      }
      // Tiger Team is admin-only and the Guide describes admin features (gear, New/Clone, Tiger Team modes);
      // with only Agents left the tab strip itself is noise.
      for (const t of ['group-chat', 'guide']) {
        const tab = document.querySelector(`.tab[data-tab="${t}"]`);
        if (tab) tab.style.display = 'none';
      }
      const tabs = document.querySelector('.sidebar .tabs');
      if (tabs) tabs.style.display = 'none';
      const menu = document.getElementById('more-menu');
      if (menu) menu.classList.remove('advanced');
    }
    function renderUserChip() {
      const chip = document.getElementById('user-chip');
      const me = window.hubMe;
      if (!chip || !me) return;
      // No accounts yet (an install that never ran the admin setup): nothing to show, and no error either.
      if (!me.user) { chip.style.display = 'none'; document.getElementById('user-chip-wrap').style.display = 'none'; return; }
      chip.style.display = '';
      document.getElementById('user-chip-wrap').style.display = '';
      chip.querySelector('.user-chip-name').textContent = me.user.name || me.user.login;
      chip.querySelector('.user-chip-role').textContent = me.user.role;
      const usersItem = document.getElementById('account-users');
      if (usersItem) usersItem.style.display = me.isAdmin ? '' : 'none';
      const modulesItem = document.getElementById('account-modules');
      if (modulesItem) modulesItem.style.display = me.isAdmin ? '' : 'none';
      const localItem = document.getElementById('account-local-models');
      if (localItem) localItem.style.display = me.isAdmin ? '' : 'none';
      const note = document.getElementById('account-2fa-note');
      if (note) note.style.display = (me.isAdmin && !me.user.totpEnabled) ? '' : 'none';
    }
    function toggleAccountMenu(force) {
      const menu = document.getElementById('account-menu');
      if (!menu) return;
      const open = typeof force === 'boolean' ? force : !menu.classList.contains('open');
      menu.classList.toggle('open', open);
    }
    async function signOut() {
      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (e) { /* go to login anyway */ }
      location.href = '/login';
    }
    async function authPost(url, body) {
      const r = await fetch(url, {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      let data = {};
      try { data = await r.json(); } catch (e) { /* empty body */ }
      if (!r.ok || data.ok === false || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    function loadQrScript() {
      if (window.qrcode) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = '/vendor/qrcode.min.js';
        s.onload = resolve;
        s.onerror = () => reject(new Error('QR script failed to load'));
        document.head.appendChild(s);
      });
    }
    function openSecurityDialog() {
      toggleAccountMenu(false);
      document.getElementById('security-overlay')?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'question-overlay';
      overlay.id = 'security-overlay';
      overlay.innerHTML = `
        <div class="question-modal security-modal">
          <h3>Security</h3>
          <div id="sec-2fa" class="sec-section"></div>
          <div class="sec-section">
            <div class="sec-title">Change password</div>
            <input type="password" id="sec-pw-current" placeholder="Current password" autocomplete="current-password">
            <input type="password" id="sec-pw-new" placeholder="New password (12+ characters)" autocomplete="new-password">
            <input type="password" id="sec-pw-new2" placeholder="New password again" autocomplete="new-password">
            <div class="sec-actions"><button class="sec-btn" onclick="changePassword()">Change password</button></div>
            <div class="sec-msg" id="sec-pw-msg"></div>
          </div>
          <div class="sec-section">
            <div class="sec-title">Time zone</div>
            <div class="sec-hint" id="sec-tz-hint"></div>
            <select id="sec-tz" onchange="chooseTimeZone(this)" aria-label="Time zone your agents use"></select>
            <div class="sec-msg" id="sec-tz-msg"></div>
          </div>
          <div class="sec-section">
            <div class="sec-title">Sessions</div>
            <div class="sec-hint" id="sec-sessions">Loading…</div>
            <div class="sec-actions"><button class="sec-btn danger" onclick="signOutEverywhere()">Sign out everywhere</button></div>
          </div>
          <div class="sec-actions"><button class="sec-btn" onclick="dialogRequestClose(this)">Close</button></div>
        </div>`;
      document.body.appendChild(overlay);
      paintTwoFactor();
      paintTimeZone();
      loadSessionsInfo();
    }
    // Which zone the agents use for "now" and every time they show: the device's (it follows you), or one pinned here.
    function paintTimeZone() {
      const sel = document.getElementById('sec-tz'), hint = document.getElementById('sec-tz-hint');
      const me = window.hubMe;
      if (!sel || !hint || !me || !me.user) return;
      const device = deviceTimeZone();
      const pinned = !!me.user.timeZonePinned;
      const zone = me.timeZone || me.user.timeZone || device || 'UTC';
      let zones = [];
      try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
      if (!zones.includes(zone)) zones.unshift(zone);
      let now = '';
      try { now = new Date().toLocaleTimeString([], { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); } catch { now = ''; }
      sel.innerHTML = `<option value="">Follow this device${device ? ` (${hubEsc(device.replace(/_/g, ' '))})` : ''}</option>`
        + zones.map(z => `<option value="${hubEsc(z)}">${hubEsc(z.replace(/_/g, ' '))}</option>`).join('');
      sel.value = pinned ? zone : '';
      sel.disabled = false;
      hint.textContent = `Your agents use ${zone.replace(/_/g, ' ')}${now ? ` (now ${now})` : ''}${pinned ? ', pinned wherever you are.' : ', following the device you use.'}`;
      try { dialogGuard.markLoaded(sel); } catch { /* no guard on this page */ }
    }
    async function chooseTimeZone(sel) {
      const tz = sel.value;
      tzChoice++;
      sel.disabled = true;   // one choice at a time: a second one waits until this is saved
      const body = tz ? { tz, pinned: true } : { tz: deviceTimeZone() || null, pinned: false };
      try {
        const r = await fetch('/api/me/timezone', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        window.hubMe.user = { ...window.hubMe.user, ...d.user };
        window.hubMe.timeZone = d.timeZone;
        paintTimeZone();
        secMsg('sec-tz-msg', 'Saved.', true);
      } catch (e) {
        paintTimeZone();
        secMsg('sec-tz-msg', `Not saved: ${e.message}`);
      }
    }
    function paintTwoFactor(stage) {
      const box = document.getElementById('sec-2fa');
      const me = window.hubMe;
      if (!box || !me) return;
      if (me.user.totpEnabled) {
        box.innerHTML = `
          <div class="sec-title">Two-factor authentication <span class="sec-badge on">on</span></div>
          <input type="password" id="sec-2fa-password" placeholder="Password (to turn it off)" autocomplete="current-password">
          <div class="sec-actions"><button class="sec-btn danger" onclick="disableTwoFactor()">Disable 2FA</button></div>
          <div class="sec-msg" id="sec-2fa-msg"></div>`;
      } else {
        box.innerHTML = `
          <div class="sec-title">Two-factor authentication <span class="sec-badge">off</span></div>
          <div class="sec-hint">${me.isAdmin ? 'Required for admins.' : 'Adds a 6-digit code from an authenticator app at sign-in.'}</div>
          <div class="sec-actions"><button class="sec-btn" onclick="beginTwoFactor()">Set up 2FA</button></div>
          <div class="sec-msg" id="sec-2fa-msg"></div>`;
      }
    }
    function secMsg(id, text, ok) {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = text || '';
      el.style.color = ok ? 'var(--green, #4caf50)' : 'var(--accent)';
    }
    async function beginTwoFactor() {
      try {
        const d = await authPost('/api/auth/totp/begin');
        await loadQrScript();
        const box = document.getElementById('sec-2fa');
        box.innerHTML = `
          <div class="sec-title">Scan with your authenticator app</div>
          <div class="sec-qr">${window.qrcode.svg(d.uri, { size: 180, margin: 2, dark: '#000', light: '#fff' })}</div>
          <div class="sec-hint">Or enter this key by hand:</div>
          <code class="sec-secret">${hubEsc(d.secret)}</code>
          <input type="text" id="sec-2fa-code" inputmode="numeric" maxlength="6" placeholder="6-digit code" autocomplete="one-time-code">
          <div class="sec-actions">
            <button class="sec-btn" onclick="confirmTwoFactor()">Confirm</button>
            <button class="sec-btn" onclick="paintTwoFactor()">Cancel</button>
          </div>
          <div class="sec-msg" id="sec-2fa-msg"></div>`;
        document.getElementById('sec-2fa-code').focus();
      } catch (e) { secMsg('sec-2fa-msg', e.message); }
    }
    async function confirmTwoFactor() {
      const code = (document.getElementById('sec-2fa-code').value || '').trim();
      try {
        const d = await authPost('/api/auth/totp/confirm', { code });
        window.hubMe.user.totpEnabled = true;
        renderUserChip();
        const codes = d.recoveryCodes || [];
        const box = document.getElementById('sec-2fa');
        box.innerHTML = `
          <div class="sec-title">Two-factor is on. Save your recovery codes</div>
          <div class="sec-hint">Each code works once if you lose your phone. They are shown only now.</div>
          <pre class="sec-codes" id="sec-recovery">${hubEsc(codes.join('\n'))}</pre>
          <div class="sec-actions">
            <button class="sec-btn" onclick="copyRecoveryCodes(this)">Copy</button>
            <button class="sec-btn" onclick="paintTwoFactor()">Done</button>
          </div>`;
      } catch (e) { secMsg('sec-2fa-msg', e.message); }
    }
    function copyRecoveryCodes(btn) {
      const text = document.getElementById('sec-recovery')?.textContent || '';
      const done = () => { btn.textContent = 'Copied'; };
      if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(done, () => {});
      else {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* user can select by hand */ }
        ta.remove();
      }
    }
    async function disableTwoFactor() {
      const password = document.getElementById('sec-2fa-password').value;
      if (!password) return secMsg('sec-2fa-msg', 'Enter your password to turn 2FA off.');
      try {
        await authPost('/api/auth/totp/disable', { password });
        window.hubMe.user.totpEnabled = false;
        renderUserChip();
        paintTwoFactor();
      } catch (e) { secMsg('sec-2fa-msg', e.message); }
    }
    async function changePassword() {
      const current = document.getElementById('sec-pw-current').value;
      const next = document.getElementById('sec-pw-new').value;
      const again = document.getElementById('sec-pw-new2').value;
      if (next.length < 12) return secMsg('sec-pw-msg', 'The new password needs at least 12 characters.');
      if (next !== again) return secMsg('sec-pw-msg', 'The two new passwords do not match.');
      try {
        await authPost('/api/auth/password', { current, next });
        for (const id of ['sec-pw-current', 'sec-pw-new', 'sec-pw-new2']) document.getElementById(id).value = '';
        dialogGuard.markLoaded(['sec-pw-current', 'sec-pw-new', 'sec-pw-new2'].map(id => document.getElementById(id)));   // done: nothing left to lose
        secMsg('sec-pw-msg', 'Password changed.', true);
      } catch (e) { secMsg('sec-pw-msg', e.message); }
    }
    async function loadSessionsInfo() {
      const el = document.getElementById('sec-sessions');
      try {
        const r = await fetch('/api/auth/sessions', { credentials: 'include' });
        const d = await r.json();
        const n = Array.isArray(d.sessions) ? d.sessions.length : null;
        el.textContent = n === null ? 'Signed in on this browser.' : `${n} active session${n === 1 ? '' : 's'}.`;
      } catch (e) { el.textContent = ''; }
    }
    async function signOutEverywhere() {
      if (!confirm('Sign out on every device, including this browser?')) return;
      try { await authPost('/api/auth/sessions/revoke'); } catch (e) { /* session may already be gone */ }
      location.href = '/login';
    }

    // ── Restart Hub Button ──
    async function restartHub() {
      if (!confirm('Restart My Maestro AI?\n\n• Conversation history is auto-saved (safe)\n• Memory & session notes are saved instantly (safe)\n• Active streaming responses will be flushed to disk\n• Agents mid-response will lose their last ~3 seconds of output')) return;
      const btn = document.getElementById('restart-hub-btn');
      btn.classList.add('restarting');
      btn.title = 'Restarting...';
      // The boot id proves a restart: the old server answering /api/health again is a FAILED restart, not success.
      let before = null;
      try { const h = await (await fetch('/api/health', { credentials: 'include' })).json(); before = h.bootId || null; } catch {}
      let started = null;
      try {
        const r = await fetch('/api/restart', { method: 'POST', credentials: 'include' });
        started = await r.json().catch(() => null);
        if (!r.ok) { restartFailed(btn, `The hub refused to restart: ${(started && started.error) || r.status}`); return; }
        if (started && started.bootId) before = started.bootId;
      } catch (e) { /* the server may already be going down */ }
      setTimeout(() => pollForRestart(btn, 0, before), 4000);
    }
    function pollForRestart(btn, attempts = 0, before = null) {
      // Up to ~2 minutes: skills take ~10 s to init, a cold Mac longer.
      if (attempts > 55) { restartFailed(btn, before ? 'The hub did not restart: the same server process is still answering.' : 'The hub did not come back.'); return; }
      fetch('/api/health', { credentials: 'include' })
        .then(r => r.ok ? r.json() : Promise.reject(new Error('not ready')))
        .then(h => {
          if (before && h.bootId && h.bootId === before) throw new Error('same process');   // still the old server: keep waiting
          btn.classList.remove('restarting');
          btn.title = 'Restart My Maestro AI';
          localStorage.setItem('hub-manual-restart', Date.now().toString());
          location.reload();
        })
        .catch(() => setTimeout(() => pollForRestart(btn, attempts + 1, before), 2000));
    }
    async function restartFailed(btn, why) {
      btn.classList.remove('restarting'); btn.classList.add('restart-failed');
      btn.title = 'Restart failed';
      let detail = '';
      try {
        const d = await (await fetch('/api/restart/log', { credentials: 'include' })).json();
        const part = (k, label) => d[k] && d[k].tail ? `\n\n${label} (${d[k].path}):\n${d[k].tail.split('\n').slice(-12).join('\n')}` : '';
        detail = part('restart', 'Restart log') + part('server', 'Server log') + part('serverData', 'Server log');
        if (!detail) detail = '\n\nNo restart log was written: the running server is an older version whose restart does nothing. Stop and start it by hand once; this version then restarts itself properly.';
      } catch { detail = '\n\n(could not read the restart log)'; }
      alert(`${why}${detail}`);
    }

    // ── Update from GitHub ──
    // Pull only. Refuses on a dirty tree rather than discarding work, so this
    // is safe to click on a machine where you also develop.
    /**
     * gsModal(inner)                  centred modal over a dimmed page (git sync, small dialogs).
     * gsModal(inner, { dock, title }) side panel docked right: the chat stays visible and usable,
     *                                 the panel keeps its width and scroll position when re-rendered,
     *                                 always-visible Close, drag the left edge to resize, Esc closes.
     */
    function gsModal(inner, { dock = false, title = '' } = {}) {
      let overlay = document.getElementById('gs-overlay');
      const prev = overlay && overlay.classList.contains('gs-dock') ? { scroll: overlay.firstElementChild.scrollTop, width: overlay.firstElementChild.style.getPropertyValue('--gs-dock-width') } : null;
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = 'gs-overlay';
      overlay.className = 'gs-overlay' + (dock ? ' gs-dock' : '');
      if (!dock) {
        overlay.innerHTML = `<div class="gs-modal">${inner}</div>`;
        document.body.appendChild(overlay);   // Esc, the backdrop and Close: dialogGuard
        return overlay;
      }
      overlay.innerHTML = `<div class="gs-modal"><div class="gs-dock-grip" title="Drag to resize"></div>
        <div class="gs-dock-head"><h3>${title}</h3><button class="gs-dock-close" onclick="dialogRequestClose(this)" title="Close (Esc)">✕ Close</button></div>${inner}</div>`;
      const panel = overlay.firstElementChild;
      if (prev && prev.width) panel.style.setProperty('--gs-dock-width', prev.width);
      const grip = panel.querySelector('.gs-dock-grip');
      grip.addEventListener('mousedown', (e) => {
        e.preventDefault(); const startX = e.clientX, startW = panel.getBoundingClientRect().width;
        const move = (ev) => panel.style.setProperty('--gs-dock-width', Math.max(360, Math.min(window.innerWidth - 80, startW + (startX - ev.clientX))) + 'px');
        const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
        document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
      });
      document.body.appendChild(overlay);   // Esc from inside the panel: dialogGuard (a docked panel is not modal)
      if (prev) panel.scrollTop = prev.scroll;
      return overlay;
    }

    const gsClose = `<button class="gs-btn secondary" onclick="dialogRequestClose(this)">Close</button>`;   // the same checks as the header ✕
    const esc = (s) => String(s).replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

    // ── Files: upload, download and browse the files agents can read (server: /api/files*) ──
    // The panel is rooted on the files folder of the agent in the active chat (query `agent=`); with no
    // chat open it falls back to the owner's general folder. `owner` is who the owner switcher shows
    // (admins, infra mapped to mine); members omit it.
    const filesState = { path: '', root: null, entries: [], maxUploadBytes: 0, uploads: [], agent: '' };
    function filesActiveAgent() {
      const c = window.__activeChatId ? chats[window.__activeChatId] : null;
      return c && !c.isGroup && c.agent ? String(c.agent) : '';
    }
    function filesOwnerParam() {
      const me = window.hubMe;
      if (!me || !me.isAdmin) return '';
      const v = ownerView();
      return 'owner=' + encodeURIComponent(v === 'infra' ? 'mine' : v) + '&';
    }
    function filesAgentParam(agent) { return agent ? 'agent=' + encodeURIComponent(agent) + '&' : ''; }
    function filesUrl(route, params, agent = filesState.agent) {
      const q = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
      return `/api/files${route}?${filesOwnerParam()}${filesAgentParam(agent)}${q}`;
    }
    async function filesApi(url, opts = {}) {
      const init = { credentials: 'include', ...opts };
      if (opts.json !== undefined) { init.method = init.method || 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opts.json); }
      let r; try { r = await fetch(url, init); } catch (e) { throw new Error('Could not reach the hub.'); }
      let data = {}; try { data = await r.json(); } catch (e) { /* no body */ }
      if (!r.ok || data.ok === false) throw new Error(data.error || `HTTP ${r.status}`);
      return data;
    }
    function filesOwnerBody() {
      const me = window.hubMe;
      const body = filesState.agent ? { agent: filesState.agent } : {};
      if (!me || !me.isAdmin) return body;
      const v = ownerView();
      return { ...body, owner: v === 'infra' ? 'mine' : v };
    }
    function humanSize(n) {
      n = Number(n) || 0;
      if (n < 1024) return `${n} B`;
      const u = ['KB', 'MB', 'GB', 'TB']; let i = -1;
      do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
      return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
    }
    function filesJoin(dir, name) { return dir ? `${dir}/${name}` : name; }
    function filesServerPath(rel) { const root = filesState.root ? filesState.root.absPath : ''; return rel ? `${root}/${rel}` : root; }
    function filesStatus(text, kind) {
      const el = document.getElementById('files-status'); if (!el) return;
      el.textContent = text || ''; el.className = 'files-status' + (kind ? ' ' + kind : '');
      if (text && kind === 'ok') setTimeout(() => { if (el.textContent === text) { el.textContent = ''; el.className = 'files-status'; } }, 4000);
    }
    async function openFilesPanel(path) {
      if (typeof path === 'string') filesState.path = path;
      const dock = { dock: true, title: '📁 Files' };
      if (!document.getElementById('files-panel')) {
        gsModal(`<div id="files-panel" data-no-dirty>
          <div class="files-root" id="files-root"></div>
          <div class="files-crumbs" id="files-crumbs"></div>
          <div class="files-tools">
            <button class="gs-btn" onclick="document.getElementById('files-upload-input').click()">⬆ Upload</button>
            <button class="gs-btn secondary" onclick="filesNewFolder()">New folder</button>
            <button class="gs-btn secondary" onclick="filesRefresh()">Refresh</button>
            <input type="file" id="files-upload-input" multiple style="display:none" onchange="filesUploadFiles(this.files); this.value = ''">
            <span class="gs-sub" style="margin:0" id="files-limit"></span>
          </div>
          <div class="files-progress" id="files-progress"></div>
          <div class="files-status" id="files-status"></div>
          <div class="files-drop" id="files-drop"><div id="files-list" class="files-empty">Loading…</div></div>
          <div class="gs-sub" style="margin:4px 0 0">Drop files anywhere in this list to upload them to the current folder. Agents read these files by path: use "Use in chat" to put the path in your message.</div>
        </div>`, dock);
        const drop = document.getElementById('files-drop');
        let depth = 0;
        drop.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; drop.classList.add('over'); });
        drop.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
        drop.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; drop.classList.remove('over'); } });
        drop.addEventListener('drop', (e) => { e.preventDefault(); depth = 0; drop.classList.remove('over'); if (e.dataTransfer && e.dataTransfer.files.length) filesUploadFiles(e.dataTransfer.files); });
      }
      await filesRefresh();
    }
    // Also called when the active chat changes: a different agent means a different root, so start at its top.
    async function filesRefresh() {
      const list = document.getElementById('files-list'); if (!list) return;
      const agent = filesActiveAgent();
      if (agent !== filesState.agent) { filesState.agent = agent; filesState.path = ''; }
      filesStatus('');
      let data;
      try { data = await filesApi(filesUrl('', { path: filesState.path })); }
      catch (e) {
        if (filesState.path && /not found|no such|404/i.test(e.message)) { filesState.path = ''; return filesRefresh(); }
        list.className = 'files-empty'; list.textContent = e.message; return;
      }
      filesState.root = data.root || null; filesState.entries = data.entries || []; filesState.maxUploadBytes = data.maxUploadBytes || 0;
      filesState.path = data.path || '';
      filesRenderHeader(); filesRenderList();
    }
    function filesRenderHeader() {
      const root = filesState.root || {};
      const h3 = document.querySelector('#gs-overlay .gs-dock-head h3');
      if (h3) h3.textContent = `📁 ${root.label || 'Files'}${filesState.agent ? '' : ' (no chat open)'}`;
      const rootEl = document.getElementById('files-root');
      if (rootEl) rootEl.innerHTML = `<strong style="color:var(--text)">${filesState.agent ? 'Only this agent sees these files.' : 'General folder: open a chat to see that agent\'s files.'}</strong>
        <code id="files-abs">${esc(root.absPath || '')}</code>
        <button class="files-copy" style="background:transparent;border:1px solid var(--border);color:var(--text-dim);border-radius:4px;padding:1px 6px;font-size:11px;cursor:pointer" title="Copy this folder path to paste into a chat" onclick="filesCopy(filesServerPath(filesState.path), this)">Copy path</button>`;
      const crumbs = document.getElementById('files-crumbs');
      if (crumbs) {
        const parts = filesState.path ? filesState.path.split('/') : [];
        let acc = '';
        crumbs.innerHTML = `<a onclick="openFilesPanel('')">Top</a>` + parts.map((p, i) => {
          acc = filesJoin(acc, p);
          return `<span class="sep">/</span>${i === parts.length - 1 ? `<span>${esc(p)}</span>` : `<a onclick="openFilesPanel('${esc(acc).replace(/'/g, '&#39;')}')">${esc(p)}</a>`}`;
        }).join('');
      }
      const lim = document.getElementById('files-limit');
      if (lim) lim.textContent = filesState.maxUploadBytes ? `up to ${humanSize(filesState.maxUploadBytes)} per file` : '';
    }
    function filesRenderList() {
      const list = document.getElementById('files-list'); if (!list) return;
      const entries = filesState.entries.slice().sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
      if (!entries.length) { list.className = 'files-empty'; list.textContent = filesState.path ? 'This folder is empty. Drop files here or use Upload.' : 'No files yet. Drop files here or use Upload.'; return; }
      list.className = '';
      const when = (t) => { if (!t) return ''; const d = new Date(t); return isNaN(d) ? esc(String(t)) : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); };
      list.innerHTML = `<table><thead><tr><th>Name</th><th style="text-align:right">Size</th><th>Modified</th><th></th></tr></thead><tbody>` + entries.map((e, i) => {
        const rel = filesJoin(filesState.path, e.name);
        const isDir = e.type === 'dir';
        const nameHtml = isDir ? `<a onclick="openFilesPanel(filesJoin(filesState.path, filesState.entries[${i}].name))">📁 ${esc(e.name)}</a>` : `📄 ${esc(e.name)}`;
        return `<tr data-i="${i}">
          <td class="name">${nameHtml}</td>
          <td class="num">${isDir ? '' : humanSize(e.size)}</td>
          <td class="num">${when(e.mtime)}</td>
          <td><div class="files-acts">
            ${isDir ? '' : `<button onclick="filesDownload(${i})" title="Download to this computer">Download</button>`}
            <button onclick="filesUseInChat(${i})" title="Put the server path of this ${isDir ? 'folder' : 'file'} into the open chat">Use in chat</button>
            <button onclick="filesRename(${i})">Rename</button>
            <button class="danger" onclick="filesDelete(${i})">Delete</button>
          </div></td></tr>`;
      }).join('') + '</tbody></table>';
      filesState.entries = entries;
    }
    async function filesCopy(text, btn) {
      let ok = false;
      try { await navigator.clipboard.writeText(text); ok = true; } catch (e) { /* no clipboard: an http:// address on the home network */ }
      if (!ok) {   // the older way (as copyMessageText); the textarea goes inside the button's dialog, so it can be selected there
        const back = document.activeElement;
        const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.tabIndex = -1; ta.style.position = 'fixed'; ta.style.opacity = '0';
        ((btn && btn.closest('dialog, .question-overlay')) || document.body).appendChild(ta);
        ta.select(); try { ok = document.execCommand('copy'); } catch { ok = false; } ta.remove();
        if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch {} }
      }
      if (btn) { const old = btn.textContent; btn.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(() => { btn.textContent = old; }, 1500); }
      return ok;
    }
    function filesDownload(i) {
      const e = filesState.entries[i]; if (!e) return;
      const a = document.createElement('a');
      a.href = filesUrl('/download', { path: filesJoin(filesState.path, e.name) }); a.download = e.name;
      document.body.appendChild(a); a.click(); a.remove();
    }
    // Inserts the server path into the active chat's textarea; with no chat open, copies it instead.
    function filesUseInChat(i) {
      const e = filesState.entries[i]; if (!e) return;
      insertPathIntoActiveChat(filesServerPath(filesJoin(filesState.path, e.name)), e.type === 'dir');
    }
    async function insertPathIntoActiveChat(absPath, isDir) {
      const chatId = window.__activeChatId;
      const ta = chatId ? document.getElementById(`input-${chatId}`) : null;
      const tag = isDir ? `[folder: ${absPath}]` : `[file: ${absPath}]`;
      if (ta) {
        ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + tag + ' ';
        if (typeof autoGrowTextarea === 'function') autoGrowTextarea(ta);
        ta.focus();
        filesStatus(`Added to the chat message: ${tag}`, 'ok');
      } else {
        const ok = await filesCopy(absPath);
        filesStatus(ok ? `No chat is open, so the path was copied instead: ${absPath}` : `No chat is open. Path: ${absPath}`, ok ? 'ok' : '');
      }
    }
    async function filesNewFolder() {
      const name = prompt('Name of the new folder:'); if (name === null) return;
      const n = name.trim(); if (!n) return;
      try { await filesApi('/api/files/mkdir', { json: { ...filesOwnerBody(), path: filesState.path, name: n } }); filesStatus(`Folder "${n}" created`, 'ok'); await filesRefresh(); }
      catch (e) { filesStatus(e.message, 'error'); }
    }
    async function filesRename(i) {
      const e = filesState.entries[i]; if (!e) return;
      const name = prompt(`New name for "${e.name}":`, e.name); if (name === null) return;
      const n = name.trim(); if (!n || n === e.name) return;
      try { await filesApi('/api/files/rename', { json: { ...filesOwnerBody(), path: filesJoin(filesState.path, e.name), newName: n } }); filesStatus(`Renamed to "${n}"`, 'ok'); await filesRefresh(); }
      catch (err) { filesStatus(err.message, 'error'); }
    }
    async function filesDelete(i) {
      const e = filesState.entries[i]; if (!e) return;
      const msg = e.type === 'dir' ? `Delete the folder "${e.name}" and everything inside it? This cannot be undone.` : `Delete "${e.name}"? This cannot be undone.`;
      if (!confirm(msg)) return;
      try { await filesApi(filesUrl('', { path: filesJoin(filesState.path, e.name) }), { method: 'DELETE' }); filesStatus(`Deleted "${e.name}"`, 'ok'); await filesRefresh(); }
      catch (err) { filesStatus(err.message, 'error'); }
    }
    // One request per file, raw bytes in the body, with upload progress. Resolves { entry, path, absPath }.
    function uploadFileToHub(file, dir, { overwrite = false, onProgress, agent = filesState.agent } = {}) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', filesUrl('/upload', { path: dir, name: file.name, overwrite: overwrite ? '1' : '' }, agent));
        xhr.withCredentials = true;
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        if (onProgress) xhr.upload.onprogress = (ev) => { if (ev.lengthComputable) onProgress(ev.loaded / ev.total); };
        xhr.onerror = () => reject(new Error('Upload failed: could not reach the hub.'));
        xhr.onload = () => {
          let data = {}; try { data = JSON.parse(xhr.responseText || '{}'); } catch (e) { /* not JSON */ }
          if (xhr.status === 401) { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); return reject(new Error('Signed out')); }
          if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) return resolve(data);
          const err = new Error(data.error || (xhr.status === 413 ? 'That file is too large.' : xhr.status === 409 ? 'A file with that name already exists.' : `HTTP ${xhr.status}`));
          err.status = xhr.status; reject(err);
        };
        xhr.send(file);
      });
    }
    async function filesUploadFiles(fileList) {
      const files = Array.from(fileList || []); if (!files.length) return;
      const box = document.getElementById('files-progress');
      const dir = filesState.path;
      const existing = new Set(filesState.entries.filter(e => e.type === 'file').map(e => e.name));
      let done = 0, failed = 0;
      for (const file of files) {
        if (filesState.maxUploadBytes && file.size > filesState.maxUploadBytes) { filesStatus(`${file.name}: too large (limit ${humanSize(filesState.maxUploadBytes)})`, 'error'); failed++; continue; }
        let overwrite = false;
        if (existing.has(file.name)) { if (!confirm(`"${file.name}" already exists here. Replace it?`)) continue; overwrite = true; }
        const row = document.createElement('div');
        row.innerHTML = `<div>${esc(file.name)} <span class="pct">0%</span></div><div class="bar"><i></i></div>`;
        if (box) box.appendChild(row);
        const pct = row.querySelector('.pct'), bar = row.querySelector('.bar i');
        try {
          await uploadFileToHub(file, dir, { overwrite, onProgress: (f) => { pct.textContent = `${Math.round(f * 100)}%`; bar.style.width = `${f * 100}%`; } });
          pct.textContent = 'done'; bar.style.width = '100%'; done++;
          setTimeout(() => row.remove(), 1500);
        } catch (e) {
          if (e.status === 409 && !overwrite && confirm(`"${file.name}" already exists here. Replace it?`)) {
            try { await uploadFileToHub(file, dir, { overwrite: true, onProgress: (f) => { pct.textContent = `${Math.round(f * 100)}%`; bar.style.width = `${f * 100}%`; } }); pct.textContent = 'done'; done++; setTimeout(() => row.remove(), 1500); continue; }
            catch (e2) { e = e2; }
          }
          pct.textContent = 'failed'; pct.style.color = 'var(--error, #FF4C4C)'; failed++;
          filesStatus(`${file.name}: ${e.message}`, 'error');
          setTimeout(() => row.remove(), 6000);
        }
      }
      if (done && !failed) filesStatus(done === 1 ? `Uploaded ${files.length === 1 ? files[0].name : '1 file'}` : `Uploaded ${done} files`, 'ok');
      await filesRefresh();
    }
    // Paperclip helper: a non-image file goes to the files root and its server path is appended to the chat message.
    function chatFileStatus(chatId, text, kind) {
      const area = document.getElementById(`image-preview-${chatId}`); if (!area) return;
      let el = area.querySelector('.chat-file-status');
      if (!text) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.className = 'chat-file-status'; area.appendChild(el); }
      el.textContent = text; el.className = 'chat-file-status' + (kind ? ' ' + kind : '');
      if (kind === 'ok') setTimeout(() => { if (el.textContent === text) el.remove(); }, 4000);
    }
    async function uploadFileForChat(chatId, file) {
      chatFileStatus(chatId, `Uploading ${file.name}…`);
      // The file lands in this chat's agent folder (group chats have no single agent: general folder).
      const agent = chats[chatId] && !chats[chatId].isGroup && chats[chatId].agent ? String(chats[chatId].agent) : '';
      try {
        const out = await uploadFileToHub(file, '', { agent, onProgress: (f) => chatFileStatus(chatId, `Uploading ${file.name}… ${Math.round(f * 100)}%`) });
        const abs = out.absPath || filesServerPath(out.path || file.name);
        const ta = document.getElementById(`input-${chatId}`);
        if (ta) { ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + `[file: ${abs}] `; if (typeof autoGrowTextarea === 'function') autoGrowTextarea(ta); ta.focus(); }
        chatFileStatus(chatId, `Uploaded ${file.name}. Its path is in your message so the agent can read it.`, 'ok');
        if (document.getElementById('files-list')) filesRefresh();
      } catch (e) {
        if (e.status === 409) {
          if (confirm(`"${file.name}" is already in your files. Replace it?`)) {
            try {
              const out = await uploadFileToHub(file, '', { overwrite: true, agent });
              const abs = out.absPath || filesServerPath(out.path || file.name);
              const ta = document.getElementById(`input-${chatId}`);
              if (ta) { ta.value = (ta.value && !/\s$/.test(ta.value) ? ta.value + ' ' : ta.value) + `[file: ${abs}] `; ta.focus(); }
              chatFileStatus(chatId, `Replaced ${file.name}. Its path is in your message.`, 'ok');
              return;
            } catch (e2) { e = e2; }
          } else { chatFileStatus(chatId, ''); return; }
        }
        chatFileStatus(chatId, `Could not upload ${file.name}: ${e.message}`, 'error');
        alert(`Could not upload ${file.name}: ${e.message}`);
      }
    }

    // ── Recall: search an agent's transcript archive (server: /api/recall, /api/recall/context) ──
    // Docked panel for one chat's agent (members see their own agents' history too). Hits come
    // newest-first with [brackets] around the matched words; those become <mark> after escaping.
    const recallState = { agent: '', chatId: null, hits: [], stats: null, q: '' };
    const RECALL_KINDS = [['user', 'user'], ['assistant', 'assistant'], ['tool_result', 'tool results'], ['tool_use', 'tool calls']];
    function recallFmtTime(ts) { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toLocaleString(); }
    function recallFmtDate(ts) { const d = new Date(ts); return isNaN(d) ? String(ts || '') : d.toLocaleDateString(); }
    function recallKindLabel(kind, tool) {
      const k = { user: 'user', assistant: 'assistant', tool_use: 'tool call', tool_result: 'tool result' }[kind] || String(kind || '');
      return tool ? `${k} · ${tool}` : k;
    }
    // "[word]" markers from the server become <mark>word</mark>; everything else is escaped.
    function recallSnippetHtml(snippet) {
      return esc(snippet || '').replace(/\[([^\[\]\n]+)\]/g, '<mark>$1</mark>');
    }
    function recallStatus(text, kind) {
      const el = document.getElementById('recall-status'); if (!el) return;
      el.textContent = text || ''; el.className = 'recall-status' + (kind ? ' ' + kind : '');
    }
    function openRecallPanel(chatId) {
      const chat = chatId && chats[chatId] ? chats[chatId] : (window.__activeChatId ? chats[window.__activeChatId] : null);
      const agent = chat && !chat.isGroup && chat.agent ? String(chat.agent) : '';
      if (!agent) { alert('Open a chat with an agent first: Recall searches that agent\'s history.'); return; }
      if (agent !== recallState.agent) { recallState.hits = []; recallState.stats = null; recallState.q = ''; }
      recallState.agent = agent; recallState.chatId = chat.id || chatId;
      const dock = { dock: true, title: `🔎 Recall · ${esc(chat.display || capName(agent))}` };
      const kinds = RECALL_KINDS.map(([v, label]) => `<label class="recall-kind"><input type="checkbox" class="recall-kind-box" value="${v}" checked> ${label}</label>`).join('');
      gsModal(`<div id="recall-panel" data-no-dirty>
        <div class="gs-sub" style="margin:0">Search everything this agent has said, heard and done. Words are matched anywhere in the archived transcript.</div>
        <div class="recall-tools">
          <input type="search" id="recall-q" placeholder="Search words… (Enter)" value="${esc(recallState.q).replace(/"/g, '&quot;')}" autocomplete="off">
          <button class="gs-btn" onclick="recallSearch()">Search</button>
        </div>
        <div class="recall-tools recall-filters">
          <label>From <input type="date" id="recall-from"></label>
          <label>To <input type="date" id="recall-to"></label>
          <span class="recall-kinds">${kinds}</span>
        </div>
        <div class="recall-archive" id="recall-archive"></div>
        <div class="recall-status" id="recall-status"></div>
        <div id="recall-list" class="recall-empty">Type a few words and press Enter to search this agent's history.</div>
      </div>`, dock);
      const q = document.getElementById('recall-q');
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); recallSearch(); } });
      q.focus();
      if (recallState.hits.length || recallState.stats) recallRender();
      else recallLoadStats();
    }
    // Stats come with every search; with nothing searched yet ask for them with an empty query.
    async function recallLoadStats() {
      try {
        const data = await filesApi(`/api/recall?agent=${encodeURIComponent(recallState.agent)}&q=&limit=1`);
        recallState.stats = data.stats || null;
        recallRenderArchive();
      } catch (e) { /* the archive line just stays empty */ }
    }
    function recallRenderArchive() {
      const el = document.getElementById('recall-archive'); if (!el) return;
      const s = recallState.stats;
      if (!s || !s.entries) { el.textContent = s ? 'Archive: no entries yet.' : ''; return; }
      el.textContent = `Archive: ${s.entries} entries from ${recallFmtDate(s.first)} to ${recallFmtDate(s.last)}` + (s.bytes ? ` (${humanSize(s.bytes)})` : '');
    }
    async function recallSearch() {
      const panel = document.getElementById('recall-panel'); if (!panel) return;
      const q = (document.getElementById('recall-q').value || '').trim();
      const from = document.getElementById('recall-from').value;
      const to = document.getElementById('recall-to').value;
      const kinds = Array.from(panel.querySelectorAll('.recall-kind-box:checked')).map(b => b.value);
      recallState.q = q;
      if (!q) { recallStatus('Type one or more words to search.'); return; }
      if (!kinds.length) { recallStatus('Tick at least one kind of entry.'); return; }
      const params = new URLSearchParams({ agent: recallState.agent, q, kinds: kinds.join(','), limit: '30' });
      if (from) params.set('from', new Date(from + 'T00:00:00').toISOString());
      if (to) params.set('to', new Date(to + 'T23:59:59.999').toISOString());
      recallStatus('Searching…');
      try {
        const data = await filesApi(`/api/recall?${params.toString()}`);
        recallState.hits = Array.isArray(data.hits) ? data.hits : [];
        recallState.stats = data.stats || recallState.stats;
        recallStatus(recallState.hits.length ? `${recallState.hits.length} hit${recallState.hits.length === 1 ? '' : 's'}, newest first.` : '');
        recallRender();
      } catch (e) {
        recallStatus(`Search failed: ${e.message}`, 'error');
      }
    }
    function recallRender() {
      recallRenderArchive();
      const list = document.getElementById('recall-list'); if (!list) return;
      const hits = recallState.hits;
      if (!hits.length) {
        list.className = 'recall-empty';
        list.textContent = recallState.q ? `No entries match "${recallState.q}".` : 'Type a few words and press Enter to search this agent\'s history.';
        return;
      }
      list.className = 'recall-hits';
      list.innerHTML = hits.map((h, i) => `<div class="recall-hit" data-i="${i}">
        <div class="recall-meta"><span class="recall-time">${esc(recallFmtTime(h.ts))}</span><span class="recall-kind ${esc(h.kind || '')}">${esc(recallKindLabel(h.kind, h.tool))}</span></div>
        <div class="recall-snippet">${recallSnippetHtml(h.snippet || h.text || '')}</div>
        <a class="recall-ctx-link" onclick="recallShowContext(${i})">Show context</a>
        <div class="recall-ctx" id="recall-ctx-${i}" style="display:none"></div>
      </div>`).join('');
    }
    // Expands the rows around one hit inline (oldest first, the hit itself highlighted); a second click folds them.
    async function recallShowContext(i) {
      const h = recallState.hits[i]; if (!h) return;
      const box = document.getElementById(`recall-ctx-${i}`); if (!box) return;
      const link = box.previousElementSibling;
      if (box.style.display !== 'none') { box.style.display = 'none'; if (link) link.textContent = 'Show context'; return; }
      box.style.display = ''; box.innerHTML = '<div class="recall-empty">Loading context…</div>';
      try {
        const data = await filesApi(`/api/recall/context?agent=${encodeURIComponent(recallState.agent)}&id=${encodeURIComponent(h.id)}&before=6&after=6`);
        const rows = Array.isArray(data.rows) ? data.rows : [];
        box.innerHTML = rows.length ? rows.map(r => `<div class="recall-row${r.hit ? ' hit' : ''}">
          <div class="recall-meta"><span class="recall-time">${esc(recallFmtTime(r.ts))}</span><span class="recall-kind ${esc(r.kind || '')}">${esc(recallKindLabel(r.kind, r.tool))}</span></div>
          <div class="recall-text">${esc(r.text || '')}</div>
        </div>`).join('') : '<div class="recall-empty">No surrounding entries.</div>';
        if (link) link.textContent = 'Hide context';
      } catch (e) {
        box.innerHTML = `<div class="recall-status error">Could not load context: ${esc(e.message)}</div>`;
      }
    }

    // ── Trading wallets (owner panel). Agents never see this; they only get wallet_* tools. ──
    async function walletApi(path, body) {
      const r = await fetch('/api/wallet/' + path, body === undefined ? { credentials: 'include' }
        : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
    }
    // ── Job pool: detached jobs agents run with run_job (survive the turn; owner woken when done) ──
    let jobsPanelLog = null;
    async function jobsApi(q, body) {
      const r = await fetch('/api/jobs' + (q || ''), body === undefined ? { credentials: 'include' }
        : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
    }
    // The job pool lives in the 📅 panel (bottom section); the badge there counts running jobs too.
    function refreshJobsBadge() { return refreshScheduleBadge(); }
    function openJobsPanel(flash) { return openSchedulePanel(flash); }
    async function jobsSectionHtml() {
      const esc = schedEsc;
      const v = schedView();
      if (v.hide.includes('jobs')) return '';
      let data; try { data = await jobsApi(); } catch (e) { return `<div class="gs-box"><h4>Background jobs</h4><p>${esc(e.message)}</p></div>`; }
      const now = Date.now();
      const shown = data.jobs.filter(j => schedKeep('job', j, v.scope, now));
      const when = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      const badge = (j) => {
        const c = { running: '#2e7d32', cancelling: '#ef6c00', finished: '#1565c0', failed: '#c62828', cancelled: '#616161', timed_out: '#c62828', lost: '#c62828' }[j.status] || '#616161';
        const extra = j.status === 'running' ? ` · ${j.runningFor}` : (j.exitCode !== null && j.exitCode !== undefined ? ` · exit ${j.exitCode}` : '');
        return `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;background:${c}">${j.status.replace('_', ' ')}${esc(extra)}</span>`;
      };
      const handoff = (j) => !j.reportTo ? (j.notifiedAt ? '<span title="owner woken with the result">woken ✓</span>' : '')
        : (j.reportedAt ? `<span title="owner woken, its report forwarded to ${esc(j.reportTo)}">reported to ${esc(j.reportTo)} ✓</span>`
          : j.notifiedAt ? `<span title="owner woken; waiting for its reply to forward">owner woken, report to ${esc(j.reportTo)} pending…</span>`
            : `<span>reports to ${esc(j.reportTo)}</span>`);
      const rows = shown.length ? shown.map(j => `<tr style="border-top:1px solid var(--border,#333)">
          <td><b>${esc(j.name)}</b><br><code style="font-size:11px">${esc(j.id)}</code></td>
          <td>${esc(j.owner)}${j.reportTo ? ` <span title="master agent">→ ${esc(j.reportTo)}</span>` : ''}</td>
          <td>${badge(j)}<br><small>${handoff(j)}</small></td>
          <td><small>${esc(when(j.startedAt))}${j.endedAt ? `<br>ended ${esc(when(j.endedAt))}` : ''}</small></td>
          <td style="white-space:nowrap"><button class="gs-btn secondary" onclick="jobsAct('log', '${esc(j.id)}')">Log</button>
            ${j.status === 'running' ? `<button class="gs-btn secondary" onclick="jobsAct('cancel', '${esc(j.id)}')">Cancel</button>` : ''}</td>
        </tr>`).join('') : `<tr><td colspan="5"><i>${!data.jobs.length ? 'No jobs yet. Agents start them with the run_job tool.'
          : v.scope === 'active' ? 'No jobs running.' : `No jobs ${schedScopeWords(v.scope)}.`}</i></td></tr>`;
      let logBox = '';
      if (jobsPanelLog) {
        try {
          const st = await jobsApi(`?id=${encodeURIComponent(jobsPanelLog)}&tail=120`);
          logBox = `<h4 style="margin-top:12px">Log: ${esc(st.name)} <small>(${esc(st.id)}, last 120 lines)</small></h4>
            <p><small>${esc(st.cwd)} · <code>${esc(st.command.length > 200 ? st.command.slice(0, 200) + '…' : st.command)}</code></small></p>
            <pre style="max-height:40vh;overflow:auto;font-size:12px;white-space:pre-wrap">${esc(st.outputTail || '(empty)')}</pre>
            <div class="gs-actions"><button class="gs-btn secondary" onclick="jobsAct('hidelog')">Hide log</button></div>`;
        } catch (e) { logBox = `<p>${esc(e.message)}</p>`; jobsPanelLog = null; }
      }
      return `<div class="gs-box"><h4>Background jobs <small>(run_job)</small></h4>
        <p><small>Commands agents run with <code>run_job</code>. They survive the agent's turn${data.mode === 'systemd' ? ' and hub restarts' : ''}; when one ends the hub wakes its owner with the result, and if the owner ran it for another agent, forwards the owner's report to that agent. Launcher: ${esc(data.mode)}.</small></p>
        <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr><th style="text-align:left">Job</th><th style="text-align:left">Owner → master</th><th style="text-align:left">Status</th><th style="text-align:left">Started</th><th></th></tr></thead><tbody>${rows}</tbody></table>${schedHiddenNote(data.jobs, shown)}${logBox}</div>`;
    }
    async function refreshJobsSection() {
      const box = document.getElementById('sched-jobs'); if (!box) return;
      const html = await jobsSectionHtml();
      if (document.getElementById('sched-jobs') === box) box.innerHTML = html;
    }
    async function jobsAct(action, id) {
      try {
        if (action === 'log') { jobsPanelLog = id; return refreshJobsSection(); }
        if (action === 'hidelog') { jobsPanelLog = null; return refreshJobsSection(); }
        if (action === 'cancel') { if (!confirm('Stop this job? The owner will be told it was cancelled.')) return; const j = await jobsApi('/cancel', { id }); refreshScheduleBadge(); return openSchedulePanel(`Job ${j.id} "${j.name}": ${j.status}.`); }
      } catch (e) { openSchedulePanel('Error: ' + e.message); }
    }
    // ── Task scheduler: one-off / recurring tasks that wake an agent later (schedule_task + TASKS.md) ──
    let schedPanelTimer = null, schedEditId = null;
    async function schedApi(p, body) {
      const r = await fetch('/api/scheduled-tasks' + (p || ''), body === undefined ? { credentials: 'include' }
        : { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json(); if (!r.ok) throw new Error(j.error || 'Request failed'); return j;
    }
    const schedEsc = (s) => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
    // What the 📅 panel shows ("Default should only be active jobs"), kept per browser: a time range ('active' = live
    // tasks and running jobs only; past runs appear under a time range) and the sections switched off.
    const SCHED_VIEW_KEY = 'hub-sched-view';
    const SCHED_SCOPES = { active: 'Active', day: 'Last 24 hours', week: 'Last 7 days', all: 'Everything' };
    const SCHED_SECTIONS = { tasks: 'Scheduled tasks', jobs: 'Background jobs', runs: 'Run history', md: 'TASKS.md' };
    let schedLast = null;   // last /api/scheduled-tasks answer: a view change repaints without waiting for the network
    function schedView() {
      let v = {}; try { v = JSON.parse(localStorage.getItem(SCHED_VIEW_KEY) || '{}') || {}; } catch {}
      return { scope: SCHED_SCOPES[v.scope] ? v.scope : 'active', hide: Array.isArray(v.hide) ? v.hide.filter(s => SCHED_SECTIONS[s]) : [] };
    }
    function schedSaveView(v) { try { localStorage.setItem(SCHED_VIEW_KEY, JSON.stringify(v)); } catch {} }
    const schedScopeWords = (scope) => ({ day: 'in the last 24 hours', week: 'in the last 7 days' }[scope] || '');
    // Live items (active or paused tasks, running jobs, enabled TASKS.md tasks) show in every view; finished ones when
    // their last activity falls inside the time range; everything under 'all'. kind: task | job | run | md | mdrun.
    function schedKeep(kind, x, scope, now) {
      const live = kind === 'task' ? (x.status === 'active' || x.status === 'paused' || !!x.queued)
        : kind === 'job' ? (x.status === 'running' || x.status === 'cancelling')
          : kind === 'md' ? !!x.enabled : false;
      if (live || scope === 'all') return true;
      if (scope === 'active' || kind === 'md') return false;
      const times = kind === 'task' ? [x.updatedAt, x.lastRunAt, x.lastRun && (x.lastRun.firedAt || x.lastRun.dueAt), x.createdAt]
        : kind === 'job' ? [x.endedAt, x.startedAt]
          : kind === 'run' ? [x.firedAt, x.dueAt] : [x.timestamp];
      const last = Math.max(...times.map(t => Date.parse(t || '')).filter(Number.isFinite));
      return Number.isFinite(last) && now - last <= (scope === 'day' ? 864e5 : 7 * 864e5);
    }
    // "Not shown: 16 done, 10 cancelled. Show everything" under a section the view trimmed.
    function schedHiddenNote(all, shown) {
      const keep = new Set(shown), by = {};
      for (const x of all) if (!keep.has(x)) { const s = String(x.status || (x.enabled === false ? 'disabled' : 'past')).replace(/_/g, ' '); by[s] = (by[s] || 0) + 1; }
      const parts = Object.entries(by).map(([s, n]) => `${n} ${schedEsc(s)}`);
      return parts.length ? `<p class="sched-more">Not shown: ${parts.join(', ')}. <a href="#" onclick="schedSetScope('all'); return false">Show everything</a></p>` : '';
    }
    function schedBarHtml(formOpen) {
      const v = schedView();
      const seg = Object.entries(SCHED_SCOPES).map(([k, label]) =>
        `<button type="button" class="${v.scope === k ? 'on' : ''}" aria-pressed="${v.scope === k}" onclick="schedSetScope('${k}')">${label}</button>`).join('');
      const boxes = Object.entries(SCHED_SECTIONS).filter(([k]) => k !== 'runs' || v.scope !== 'active').map(([k, label]) =>
        `<label><input type="checkbox" ${v.hide.includes(k) ? '' : 'checked'} onchange="schedToggleSection('${k}', this.checked)"> ${label}</label>`).join('');
      return `<div class="sched-seg" role="group" aria-label="Show">${seg}</div><div class="sched-sections">${boxes}</div>
        <button type="button" id="sched-form-btn" class="gs-btn${formOpen ? ' secondary' : ''}" onclick="schedToggleForm()">${formOpen ? 'Hide form' : '＋ New task'}</button>`;
    }
    function schedRepaint() {
      const bar = document.getElementById('sched-bar'); if (!bar) return;
      const form = document.getElementById('sched-form');
      bar.innerHTML = schedBarHtml(!!form && !form.hidden);
      const box = document.getElementById('sched-tables'); if (box && schedLast) box.innerHTML = schedTablesHtml(schedLast);
      refreshJobsSection();
    }
    function schedSetScope(scope) { const v = schedView(); v.scope = SCHED_SCOPES[scope] ? scope : 'active'; schedSaveView(v); schedRepaint(); }
    function schedToggleSection(key, on) { const v = schedView(); v.hide = v.hide.filter(s => s !== key); if (!on) v.hide.push(key); schedSaveView(v); schedRepaint(); }
    function schedToggleForm() {
      if (schedEditId) return schedAct('canceledit');
      const form = document.getElementById('sched-form'); if (!form) return;
      form.hidden = !form.hidden;
      const b = document.getElementById('sched-form-btn');
      if (b) { b.textContent = form.hidden ? '＋ New task' : 'Hide form'; b.classList.toggle('secondary', !form.hidden); }
      if (!form.hidden) document.getElementById('sched-when')?.focus();
    }
    async function refreshScheduleBadge() {
      const btn = document.getElementById('schedule-btn'); if (!btn) return;
      const [sched, jobs] = await Promise.all([schedApi().catch(() => null), jobsApi().catch(() => null)]);
      const tasks = sched?.tasks || [];
      const soon = tasks.filter(t => t.status === 'active' && t.nextRunAt && Date.parse(t.nextRunAt) - Date.now() < 3600000).length;
      const active = tasks.filter(t => t.status === 'active').length;
      const running = (jobs?.jobs || []).filter(j => j.status === 'running' || j.status === 'cancelling').length;
      const n = soon + running;
      btn.textContent = n ? `📅 ${n}` : '📅';
      btn.title = `Task scheduler: ${active} active task${active === 1 ? '' : 's'}${soon ? `, ${soon} due within the hour` : ''}; ${running} background job${running === 1 ? '' : 's'} running`;
      btn.classList.toggle('active', running > 0);
    }
    function schedTablesHtml(data) {
      schedLast = data;
      const esc = schedEsc;
      const v = schedView(), now = Date.now(), ranged = v.scope !== 'active', show = (k) => !v.hide.includes(k);
      const tasks = data.tasks.filter(t => schedKeep('task', t, v.scope, now));
      const runsShown = data.runs.filter(r => schedKeep('run', r, v.scope, now));
      const mdShown = data.tasksMd.filter(t => schedKeep('md', t, v.scope, now));
      const mdRunsShown = data.tasksMdRuns.filter(r => schedKeep('mdrun', r, v.scope, now));
      const when = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
      const col = { active: '#2e7d32', paused: '#ef6c00', done: '#1565c0', cancelled: '#616161', missed: '#c62828', failed: '#c62828' };
      const pill = (s, extra) => `<span style="display:inline-block;padding:1px 7px;border-radius:10px;font-size:11px;color:#fff;background:${col[s] || '#616161'}">${esc(s)}${extra ? esc(extra) : ''}</span>`;
      const btn = (a, id, label) => `<button class="gs-btn secondary" onclick="schedAct('${a}', '${esc(id)}')">${label}</button>`;
      const rows = tasks.length ? tasks.map(t => `<tr style="border-top:1px solid var(--border,#333)">
          <td><b>${esc(t.label)}</b><br><code style="font-size:11px">${esc(t.id)}</code></td>
          <td>${esc(t.agent)}<br><small>by ${esc(t.createdBy)}</small></td>
          <td><small>${esc(t.schedule)}</small>${t.nextRunLocal ? `<br><small>next: <b>${esc(t.nextRunLocal)}</b></small>` : ''}</td>
          <td>${pill(t.status, t.queued ? ' · due now' : '')}${t.lastRun ? `<br><small title="${esc(t.lastRun.replyPreview || t.lastRun.note || '')}">last: ${esc(when(t.lastRun.firedAt || t.lastRun.dueAt))} ${esc(t.lastRun.status)}${t.lastRun.late ? ' (late)' : ''}</small>` : ''}</td>
          <td style="white-space:nowrap">
            ${t.status === 'active' ? btn('pause', t.id, 'Pause') : ''}${t.status === 'paused' ? btn('resume', t.id, 'Resume') : ''}
            ${btn('edit', t.id, 'Edit')}${btn('run_now', t.id, 'Run now')}
            ${t.status === 'active' || t.status === 'paused' ? btn('cancel', t.id, 'Cancel') : btn('delete', t.id, 'Delete')}</td>
        </tr>`).join('') : `<tr><td colspan="5"><i>${!data.tasks.length ? 'No scheduled tasks yet. Add one with ＋ New task, or agents create them with schedule_task.'
          : v.scope === 'active' ? 'No active scheduled tasks.' : `No scheduled tasks ${schedScopeWords(v.scope)}.`}</i></td></tr>`;
      const runs = runsShown.length ? runsShown.map(r => `<tr style="border-top:1px solid var(--border,#333)"><td><small>${esc(when(r.firedAt || r.dueAt))}</small></td><td>${esc(r.agent)}</td><td>${esc(r.label)}</td>
          <td>${pill(r.status === 'replied' || r.status === 'delivered' ? 'done' : r.status === 'no_reply' ? 'paused' : 'failed', '')} <small>${esc(r.status)}${r.late ? ` · ${esc(r.lateNote || 'late')}` : ''}</small></td>
          <td><small>${esc((r.replyPreview || r.note || '').slice(0, 220))}</small></td></tr>`).join('')
        : `<tr><td colspan="5"><i>${data.runs.length && v.scope !== 'all' ? `No runs ${schedScopeWords(v.scope)}.` : 'No runs yet.'}</i></td></tr>`;
      const md = mdShown.length ? mdShown.map(t => `<tr style="border-top:1px solid var(--border,#333)"><td><b>${esc(t.id)}</b></td><td>${esc(t.agent)}</td>
          <td><small>${esc(t.trigger)}${t.expression ? ` <code>${esc(t.expression)}</code>` : ''}${t.nextRunLocal ? `<br>next: <b>${esc(t.nextRunLocal)}</b>` : ''}</small></td>
          <td>${pill(t.enabled ? 'active' : 'paused', '')}</td><td><small>${esc(t.action)}</small></td></tr>`).join('')
        : `<tr><td colspan="5"><i>${data.tasksMd.length ? 'No enabled TASKS.md tasks.' : 'No TASKS.md tasks.'}</i></td></tr>`;
      const mdRuns = mdRunsShown.length ? mdRunsShown.slice(0, 12).map(r => `<tr style="border-top:1px solid var(--border,#333)"><td><small>${esc(when(r.timestamp))}</small></td><td>${esc(r.agent)}</td><td>${esc(r.taskId)}</td>
          <td><small>${esc(r.status)}${r.error ? ': ' + esc(r.error) : ''}</small></td></tr>`).join('') : '<tr><td colspan="4"><i>No runs today or yesterday.</i></td></tr>';
      const th = (cols) => `<thead><tr>${cols.map(c => `<th style="text-align:left">${c}</th>`).join('')}</tr></thead>`;
      let html = '';
      if (show('tasks')) html += `<div class="gs-box"><h4>Scheduled tasks</h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px">${th(['Task', 'Agent', 'When', 'Status', ''])}<tbody>${rows}</tbody></table>${schedHiddenNote(data.tasks, tasks)}</div>`;
      if (show('runs') && ranged) html += `<div class="gs-box"><h4>Run history</h4><table style="width:100%;border-collapse:collapse;font-size:13px">${th(['Fired', 'Agent', 'Task', 'Result', 'Reply'])}<tbody>${runs}</tbody></table>${schedHiddenNote(data.runs, runsShown)}</div>`;
      if (show('md')) html += `<div class="gs-box"><h4>TASKS.md tasks <small>(read-only: edit the agent's workspace TASKS.md)</small></h4>
          <table style="width:100%;border-collapse:collapse;font-size:13px">${th(['Id', 'Agent', 'Trigger', 'Enabled', 'Action'])}<tbody>${md}</tbody></table>${schedHiddenNote(data.tasksMd, mdShown)}
          ${ranged ? `<p><small>Recent TASKS.md runs</small></p><table style="width:100%;border-collapse:collapse;font-size:13px">${th(['Fired', 'Agent', 'Task', 'Status'])}<tbody>${mdRuns}</tbody></table>` : ''}</div>`;
      if (!html && !show('jobs')) html = '<p class="sched-more">Every section is switched off: tick one above.</p>';
      return html;
    }
    async function openSchedulePanel(flash) {
      const dock = { dock: true, title: '📅 Task scheduler' };
      let data, agents = [];
      try { [data, agents] = await Promise.all([schedApi(), fetch('/api/agents', { credentials: 'include' }).then(r => r.json()).then(j => (j.agents || []).map(a => a.name)).catch(() => [])]); }
      catch (e) { return gsModal(`<div class="gs-box"><h4>Task scheduler</h4><p>${schedEsc(e.message)}</p></div>`, dock); }
      const edit = schedEditId ? data.tasks.find(t => t.id === schedEditId) : null;
      if (schedEditId && !edit) schedEditId = null;
      const esc = schedEsc;
      const opts = agents.map(a => `<option value="${esc(a)}" ${edit && edit.agent === a ? 'selected' : ''}>${esc(a)}</option>`).join('');
      gsModal(`<div id="sched-panel">${flash ? `<div class="gs-box" style="border-color:var(--accent)">${esc(flash)}</div>` : ''}
        <div id="sched-bar" class="sched-bar">${schedBarHtml(!!edit)}</div>
        <div class="gs-box" id="sched-form"${edit ? '' : ' hidden'}><h4>${edit ? `Edit ${esc(edit.id)}` : 'New task'}</h4>
          <p><small>When it comes due, the hub wakes the agent in a new turn with the prompt (marked as a scheduled task, not as you typing) and the reply lands in its chat. Times are ${esc(data.tz)} unless you say otherwise.
            One-off: <code>in 2 hours</code>, <code>tomorrow at 9am</code>, <code>2026-10-01 14:00 ET</code>. Recurring: <code>every day at 8:15 PM ET</code>, <code>weekdays at 9am</code>, <code>every monday at 10am</code>, <code>every 4 hours</code>, or cron. Limits: ${data.limits.perAgent} live tasks per agent, at most every ${data.limits.minIntervalMinutes} min.</small></p>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 10px;align-items:center;font-size:13px">
            <label>Agent</label><select id="sched-agent">${opts}</select>
            <label>When</label><div><input id="sched-when" style="width:100%" placeholder="tomorrow at 9am ET" value="${edit ? esc(edit.when) : ''}" oninput="schedPreview()"><br><small id="sched-preview"></small></div>
            <label>Label</label><input id="sched-label" placeholder="Follow up on …" value="${edit ? esc(edit.label) : ''}">
            <label>Prompt</label><textarea id="sched-prompt" rows="4" style="width:100%" placeholder="What the agent should do when it fires. Self-contained.">${edit ? esc(edit.prompt) : ''}</textarea>
          </div>
          <div class="gs-actions">${edit ? `<button class="gs-btn" onclick="schedSave()">Save changes</button><button class="gs-btn secondary" onclick="schedAct('canceledit')">Cancel edit</button>` : `<button class="gs-btn" onclick="schedSave()">Schedule</button>`}</div></div>
        <div id="sched-tables">${schedTablesHtml(data)}</div>
        <div id="sched-jobs">${await jobsSectionHtml()}</div></div>`, dock);
      if (schedPanelTimer) clearInterval(schedPanelTimer);
      let schedTick = 0;
      schedPanelTimer = setInterval(async () => {
        const box = document.getElementById('sched-tables');
        if (!box) { clearInterval(schedPanelTimer); schedPanelTimer = null; return; }
        refreshJobsSection();                                              // jobs every 5 s
        if (++schedTick % 2 === 0) try { box.innerHTML = schedTablesHtml(await schedApi()); } catch {}   // tasks every 10 s
      }, 5000);
      refreshScheduleBadge();
    }
    let schedPreviewTimer = null;
    function schedPreview() {
      clearTimeout(schedPreviewTimer);
      schedPreviewTimer = setTimeout(async () => {
        const el = document.getElementById('sched-preview'); const w = document.getElementById('sched-when')?.value.trim();
        if (!el) return; if (!w) { el.textContent = ''; return; }
        try { const p = await schedApi('/preview', { when: w }); el.textContent = `${p.type === 'once' ? 'Once' : 'Recurring'} · next run ${p.nextRunLocal}`; el.style.color = ''; }
        catch (e) { el.textContent = e.message; el.style.color = '#c62828'; }
      }, 350);
    }
    async function schedSave() {
      const v = (id) => document.getElementById(id)?.value;
      const body = { agent: v('sched-agent'), when: v('sched-when'), label: v('sched-label'), prompt: v('sched-prompt') };
      try {
        if (schedEditId) { const t = await schedApi('/update', { id: schedEditId, ...body }); schedEditId = null; return openSchedulePanel(`Saved ${t.id}: next run ${t.nextRunLocal || '—'}.`); }
        const t = await schedApi('', body); return openSchedulePanel(`Scheduled "${t.label}" for ${t.agent}: next run ${t.nextRunLocal}.`);
      } catch (e) { const el = document.getElementById('sched-preview'); if (el) { el.textContent = e.message; el.style.color = '#c62828'; } }
    }
    async function schedAct(action, id) {
      try {
        if (action === 'edit') { schedEditId = id; return openSchedulePanel(); }
        if (action === 'canceledit') { schedEditId = null; return openSchedulePanel(); }
        if (action === 'delete' && !confirm('Delete this task and its run history?')) return;
        if (action === 'cancel' && !confirm('Cancel this task? It will not run again.')) return;
        if (action === 'run_now' && !confirm('Wake the agent with this task now?')) return;
        const t = await schedApi('/action', { id, action });
        return openSchedulePanel(t.deleted ? `Deleted ${t.id}.` : `${t.id} "${t.label}": ${action.replace('_', ' ')} → ${t.status}${t.queued ? ' (delivering)' : ''}.`);
      } catch (e) { openSchedulePanel('Error: ' + e.message); }
    }
    setInterval(refreshScheduleBadge, 15000); setTimeout(refreshScheduleBadge, 1500);

    async function openWalletPanel(flash, extra = {}) {
      const dock = { dock: true, title: '👛 Trading wallets' }; const head = ''; const field = 'width:100%;padding:8px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;font:inherit;margin:6px 0';
      let s; try { s = await walletApi('status'); } catch (e) { return gsModal(`${head}<div class="gs-blocker">${esc(e.message)}</div><div class="gs-actions">${gsClose}</div>`, dock); }
      const note = (flash ? `<div class="gs-ok">${esc(flash)}</div>` : '') + (extra.token
        ? `<div class="gs-ok"><strong>New executor token, shown once.</strong> Only its hash is stored; if you lose it, generate another.<br>
            <code id="x-token-out" style="user-select:all;word-break:break-all">${esc(extra.token)}</code>
            <button class="gs-btn secondary" onclick="navigator.clipboard.writeText(document.getElementById('x-token-out').textContent).then(()=>{this.textContent='Copied'})">Copy</button></div>` : '');
      const alerts = (s.alerts || []).map(a => `<div class="gs-blocker"><strong>Security alert:</strong> ${esc(a.message)} (−${esc(a.droppedEth)} ETH)</div>`).join('');
      if (!s.keystore.exists) {
        return gsModal(`${head}${note}<p class="gs-sub">Create an encrypted keystore. The passphrase is the only thing protecting the keys on disk, and it cannot be recovered: if you lose it, move funds out first or the wallets are gone.</p>
          <input id="w-pass" type="password" placeholder="Passphrase (12+ characters)" style="${field}"><input id="w-pass2" type="password" placeholder="Repeat passphrase" style="${field}">
          <div class="gs-actions">${gsClose}<button class="gs-btn" onclick="walletAct('init')">Create keystore</button></div>`, dock);
      }
      const srcLabel = { generated: 'generated', 'imported-key': 'imported key', 'imported-seed': 'imported from seed' };
      const tierTag = w => w.tier === 'open'
        ? `<strong style="color:var(--danger,#e55)" title="Transactions from this wallet are NOT checked against the address book. Only theft primitives are blocked.">OPEN: no signing firewall</strong> · cap $${esc(String(w.fundingCapUsd))}${w.tierVerified === 'ok' ? '' : ' · <em>tier signature ' + esc(String(w.tierVerified)) + '</em>'}`
        : 'guarded (signing firewall)';
      const rows = s.wallets.map(w => `<div class="gs-commit"><strong>${esc(w.name)}</strong> — <code>${esc(w.address)}</code> <a href="https://basescan.org/address/${esc(w.address)}" target="_blank" rel="noopener">view</a>
          <span class="gs-sub" style="margin:0 6px">${esc(srcLabel[w.source] || w.source || '')}${w.hasSeed ? ' · has seed phrase' : ''} · ${tierTag(w)}${w.paused ? ' · <strong>PAUSED</strong>' : ''}</span>
          <button class="gs-btn secondary" style="padding:2px 8px;font-size:0.72rem" onclick="walletAct('pause', ${!w.paused}, '${esc(w.name)}')">${w.paused ? 'Resume' : 'Pause'}</button>
          <button class="gs-btn secondary" style="padding:2px 8px;font-size:0.72rem" onclick="walletAct('reveal', '${esc(w.name)}')">Reveal key</button></div>`).join('')
        || '<div class="gs-commit">No wallets yet.</div>';
      const revealOut = extra.reveal ? `<div class="gs-blocker"><strong>Secrets of "${esc(extra.reveal.name)}" (${esc(extra.reveal.address)}), shown once.</strong> Anyone with these controls the wallet. Store them in a password manager, then close this panel.<br>
          private key: <code id="w-reveal-pk" style="user-select:all;word-break:break-all">${esc(extra.reveal.privateKey)}</code> <button class="gs-btn secondary" style="padding:2px 8px" onclick="navigator.clipboard.writeText(document.getElementById('w-reveal-pk').textContent).then(()=>{this.textContent='Copied'})">Copy</button>
          ${extra.reveal.mnemonic ? `<br>seed phrase (${esc(extra.reveal.path || '')}): <code id="w-reveal-seed" style="user-select:all">${esc(extra.reveal.mnemonic)}</code> <button class="gs-btn secondary" style="padding:2px 8px" onclick="navigator.clipboard.writeText(document.getElementById('w-reveal-seed').textContent).then(()=>{this.textContent='Copied'})">Copy</button>` : ''}
          <div class="gs-actions"><button class="gs-btn secondary" onclick="openWalletPanel()">Hide</button></div></div>` : '';
      const lastBk = s.keystore.lastBackup;
      const recoveryBox = `<div class="gs-box"><h4>Recovery</h4>
        <div class="gs-sub" style="margin-bottom:6px">The encrypted keystore file is copied to <code>${esc(s.keystore.backupDir || '')}</code> after every change${lastBk ? ` (last: ${esc(lastBk.file.split('/').pop())}, ${lastBk.count} copies)` : ' (no copies yet)'}. A copy is useless without the passphrase, so keep copies anywhere. Without the hub: <code>node scripts/wallet-recover.js &lt;file&gt;</code> prints the keys.</div>
        <div class="gs-sub" style="margin-bottom:4px">"Reveal key" on a wallet needs the passphrase here every time, is audited, and is never available to agents.</div>
        <input id="w-reveal-pass" type="password" autocomplete="new-password" placeholder="Keystore passphrase (for Reveal key)" style="${field}">
        <div class="gs-actions"><button class="gs-btn secondary" onclick="walletAct('backup')">Back up now</button></div></div>`;
      const who = (s.walletAgents || []).join(', ');
      // Locked: the Unlock box comes FIRST, before the Executor and Hyperliquid boxes, which have passphrase fields of their own.
      const unlockBox = s.keystore.unlocked ? '' : `<div class="gs-box" style="border-color:var(--accent)"><h4>Unlock the keystore</h4>
        <div class="gs-sub" style="margin-bottom:4px">Locked since the hub last started. Type the keystore passphrase here (this box, not the Executor or Hyperliquid ones) and press Enter or Unlock.</div>
        <input id="w-pass" type="password" autocomplete="new-password" placeholder="Keystore passphrase" style="${field}" onkeydown="if(event.key==='Enter'){event.preventDefault();walletAct('unlock')}">
        <div class="gs-actions"><button class="gs-btn" onclick="walletAct('unlock')">Unlock</button></div></div>`;
      let html = `${head}${note}${alerts}<p class="gs-sub">Keystore: <strong>${s.keystore.unlocked ? 'unlocked' : 'locked'}</strong> · Trading: <strong>${s.paused ? 'PAUSED' : 'enabled'}</strong>${(s.pausedWallets || []).length ? ` (paused wallets: ${esc(s.pausedWallets.join(', '))})` : ''} · Agent with access: <strong>${esc(who)}</strong></p>
        ${unlockBox}${revealOut}<div class="gs-box"><h4>Wallets on Base</h4>${rows}</div>${recoveryBox}
        <p class="gs-sub">Fund a wallet by sending ETH on <strong>Base</strong> to its address. Whatever it holds is the most the agent can lose. Never import a seed phrase; these are fresh standalone keys.</p>`;
      let x = null; try { x = await walletApi('executor'); } catch { /* older server */ }
      if (x) {
        const opts = s.wallets.map(w => `<option value="${esc(w.name)}" ${x.wallet === w.name ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
        const actWallet = a => s.wallets.map(w => `<option value="${esc(w.name)}" ${a.wallet === w.name ? 'selected' : ''}>${esc(w.name)}${w.tier === 'open' ? ' (OPEN)' : ''}</option>`).join('');
        const acts = Object.entries(x.actions).map(([k, a]) => `<div class="gs-commit"><label><input type="checkbox" id="x-act-${k}" ${a.enabled ? 'checked' : ''}> <strong>${esc(k)}</strong></label>
          &nbsp; <label><input type="checkbox" id="x-dry-${k}" ${a.dryRun ? 'checked' : ''}> dry run only</label>
          &nbsp; wallet: <select id="x-wallet-${k}" style="padding:2px"><option value="">(executor default)</option>${actWallet(a)}</select><div class="gs-sub">${esc(a.description)}</div></div>`).join('');
        const recent = (x.recent || []).slice(0, 5).map(r => `<div class="gs-sub">${esc(new Date(r.ts).toLocaleTimeString())} ${esc(r.action)} ${r.dryRun ? '(dry run)' : '(REAL)'} ${r.ok ? 'ok' : 'refused: ' + esc(r.error || '')}</div>`).join('') || '<div class="gs-sub">No executions yet.</div>';
        html += `<div class="gs-box"><h4>Executor (scripts, no model in the loop)</h4>
          <p class="gs-sub">Lets a script run <em>registered actions only</em> within seconds, under these caps. Every agent shares this machine's user, so the token keeps out accidents, not a hostile local process: the action list and the caps are the real limit. Disabled = off switch.</p>
          <label><input type="checkbox" id="x-enabled" ${x.enabled ? 'checked' : ''}> <strong>Executor enabled</strong></label> &nbsp; wallet: <select id="x-wallet" style="padding:4px"><option value="">(none)</option>${opts}</select>
          ${acts}
          <div class="gs-sub">Caps: max $<input id="x-cap-usd" value="${esc(String(x.caps.maxUsdPerExecution))}" size="5"> per execution ·
            <input id="x-cap-hour" value="${esc(String(x.caps.maxPerHour))}" size="2"> per hour · <input id="x-cap-day" value="${esc(String(x.caps.maxPerDay))}" size="2"> per day
            · used: ${x.usedLastHour}/h, ${x.usedLastDay}/day · token: ${x.hasToken ? 'set ' + esc(String(x.tokenCreated || '').slice(0, 16)) : '<strong>none</strong>'}</div>
          ${recent}
          <input id="x-pass" type="password" autocomplete="off" placeholder="Keystore passphrase (required to save or make a token; never stored)" style="${field}">
          <div class="gs-sub">"New token" replaces the current token at once; scripts using the old one stop working.</div>
          <div class="gs-actions"><button class="gs-btn secondary" onclick="walletAct('xtoken')">New token</button><button class="gs-btn" onclick="walletAct('xsave')">Save executor settings</button></div></div>`;
      }
      let h = null; try { h = await walletApi('hl'); } catch { /* older server */ }
      if (h) {
        const wopts = s.wallets.filter(w => !/^hl-agent-/.test(w.name)).map(w => `<option value="${esc(w.name)}" ${h.wallet === w.name ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
        const tools = Object.entries(h.tools).map(([k, t]) => `<label style="margin-right:10px;white-space:nowrap"><input type="checkbox" id="h-act-${k}" ${t.enabled ? 'checked' : ''}> ${esc(k)}</label><label style="margin-right:14px;white-space:nowrap"><input type="checkbox" id="h-dry-${k}" ${t.dryRun ? 'checked' : ''}> dry run</label>`).join('');
        const acct = h.account ? (h.account.error ? `account: ${esc(h.account.error)}` : `account value $${(h.account.accountValueUsd || 0).toFixed(2)} · withdrawable $${(h.account.withdrawableUsd || 0).toFixed(2)} · ${h.account.openPositions} open position(s)`) : 'no wallet selected';
        const recent = (h.recent || []).slice(0, 5).map(r => `<div class="gs-sub">${esc(new Date(r.ts).toLocaleTimeString())} ${esc(r.kind)} $${esc(String(r.usd || 0))} ${r.dryRun ? '(dry run)' : '(REAL)'} ${r.ok ? 'ok' : 'failed'}</div>`).join('');
        html += `<div class="gs-box"><h4>Hyperliquid (perps, HLP vault)</h4>
          <p class="gs-sub">A separate exchange account controlled by the main wallet's key. Orders are signed by an <em>agent key</em> that cannot withdraw; withdrawals go only to the main wallet's own address, on Arbitrum. Isolated margin only. Start on testnet. The trading agent can change these settings by API with the executor token (header <code>X-Executor-Token</code>); the keystore must be unlocked for the agent-key setup either way.</p>
          <div class="gs-sub">env: <select id="h-env" style="padding:4px"><option value="testnet" ${h.env === 'testnet' ? 'selected' : ''}>testnet</option><option value="mainnet" ${h.env === 'mainnet' ? 'selected' : ''}>mainnet (REAL MONEY)</option></select>
            &nbsp; <label><input type="checkbox" id="h-enabled" ${h.enabled ? 'checked' : ''}> <strong>Enabled</strong></label> &nbsp; main wallet: <select id="h-wallet" style="padding:4px"><option value="">(none)</option>${wopts}</select></div>
          <div class="gs-sub">agent key (${esc(h.env)}): ${h.agent ? `<code>${esc(h.agent.address)}</code> approved ${esc(String(h.agent.approvedAt).slice(0, 16))}` : '<strong>not set up</strong>'} · ${acct}</div>
          <div class="gs-sub" style="margin:6px 0">${tools}</div>
          <div class="gs-sub">caps: deposit $<input id="h-cap-dep" value="${esc(String(h.caps.maxDepositPerCall))}" size="4">/call $<input id="h-cap-depday" value="${esc(String(h.caps.maxDepositPerDay))}" size="4">/day · order $<input id="h-cap-ntl" value="${esc(String(h.caps.maxOrderNotionalUsd))}" size="4"> · leverage <input id="h-cap-lev" value="${esc(String(h.caps.maxLeverage))}" size="2">x · positions <input id="h-cap-pos" value="${esc(String(h.caps.maxOpenPositions))}" size="2"> · withdraw $<input id="h-cap-wd" value="${esc(String(h.caps.maxWithdrawPerDay))}" size="5">/day</div>
          <div class="gs-sub">perps <input id="h-perps" value="${esc(h.perps.join(','))}" size="14"> · spot <input id="h-spot" value="${esc(h.spot.join(','))}" size="8"> · HLP vault <input id="h-hlp" value="${esc(h.hlpVault || '')}" size="24" readonly title="Pinned in code; shown for reference"></div>
          <div class="gs-sub">deposited today $${(h.depositedToday || 0).toFixed(2)} · withdrawn today $${(h.withdrawnToday || 0).toFixed(2)}</div>${recent}
          <div class="gs-sub" style="margin-top:6px"><strong>Agents the exchange lists on this account:</strong> ${Array.isArray(h.externalAgents) ? (h.externalAgents.length ? h.externalAgents.map(a => `<code>${esc(String(a.address))}</code> ${esc(String(a.name || '(unnamed)'))}`).join(' · ') : 'none') : '(not readable right now)'}</div>
          <div class="gs-sub" style="margin-top:4px">Authorize an <em>external</em> agent wallet (a bot's own key, kept outside the keystore). It can trade this account but cannot withdraw or transfer funds out. Signed by the main wallet's key; the hub's own agent is not touched.<br>
            address <input id="h-ext-addr" size="44" placeholder="0x…" autocomplete="off"> name <input id="h-ext-name" size="14" placeholder="e.g. trader-own" autocomplete="off"></div>
          <input id="h-pass" type="password" autocomplete="off" placeholder="Keystore passphrase (to save or set up the agent key from here; never stored)" style="${field}">
          <div class="gs-actions"><button class="gs-btn secondary" onclick="walletAct('hagent')">Set up Hyperliquid agent key</button><button class="gs-btn secondary" onclick="walletAct('hextagent')">Authorize external agent</button><button class="gs-btn" onclick="walletAct('hsave')">Save Hyperliquid settings</button></div></div>`;
      }
      let fw = null; try { fw = await walletApi('allowlist'); } catch { /* older server */ }
      if (fw && fw.roles) {
        walletFw = fw;
        const chainName = { 1: 'Ethereum', 8453: 'Base', 42161: 'Arbitrum', 10: 'Optimism' };
        const yes = b => b ? '✓' : '';
        // The file is readable by any local process: quote-escape attribute values and only wire buttons for strict hex addresses.
        const escA = x => esc(x).replace(/["']/g, c => c === '"' ? '&quot;' : '&#39;');
        const fwRows = [...fw.entries].sort((a, b) => (b.active - a.active) || String(b.addedAt || '').localeCompare(String(a.addedAt || ''))).map(e => {
          const ch = e.chainId === null || e.chainId === undefined ? 'any' : `${esc(chainName[e.chainId] || '')} ${esc(String(e.chainId))}`;
          const state = e.active ? 'active' : `<span title="${escA(e.deactivatedReason || '')}">off ${esc(String(e.deactivatedAt || '').slice(0, 16))}</span>`;
          const btn = e.active && e.role !== 'owner' && /^0x[0-9a-fA-F]{40}$/.test(String(e.address)) && /^[0-9]+$/.test(String(e.chainId))
            ? `<button class="gs-btn secondary" style="padding:2px 8px;font-size:0.72rem" onclick="walletAct('fwdeact', '${esc(e.address)}', '${esc(String(e.chainId))}')">Deactivate</button>` : '';
          return `<tr style="${e.active ? '' : 'opacity:0.55'}"><td>${esc(e.label || '')}${e.verified === 'bad' ? ' <em>(unsigned)</em>' : ''}</td><td><code style="font-size:11px">${esc(e.address)}</code></td><td>${ch}</td><td>${esc(e.role)}</td>
            <td>${yes(e.anySelector)}</td><td>${yes(e.allowValue)}</td><td>${state}</td><td><small>${esc(e.verifiedBy || e.source || '')}</small></td><td><small>${esc(String(e.addedAt || '').slice(0, 16))}</small></td><td>${btn}</td></tr>`;
        }).join('');
        const roleOpts = fw.roles.map(r => `<option value="${esc(r)}" ${r === 'contract' ? 'selected' : ''}>${esc(r)}</option>`).join('');
        const th = t => `<th style="text-align:left">${t}</th>`;
        html += `<div class="gs-box"><h4>Firewall (address book)</h4>
          <p class="gs-sub">Guarded wallets sign only calls to these addresses, and only the functions each role allows. Records are append-only and signed with the keystore passphrase. To change an entry, deactivate it and add it again; the newest active entry wins. File: <code>${esc(fw.file || '')}</code></p>
          <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px"><thead><tr>${['Label', 'Address', 'Chain', 'Role', 'Any selector', 'Allow value', 'State', 'Verified by', 'Added', ''].map(th).join('')}</tr></thead><tbody>${fwRows || '<tr><td colspan="10"><i>No entries.</i></td></tr>'}</tbody></table></div>
          <h4 style="margin-top:10px">Add an entry</h4>
          <input id="fw-address" placeholder="0x… contract address" autocomplete="off" spellcheck="false" style="${field}">
          <div class="gs-sub">chain: <select id="fw-chain" style="padding:4px" onchange="document.getElementById('fw-chain-other').style.display=this.value==='other'?'':'none'"><option value="8453" selected>Base 8453</option><option value="42161">Arbitrum 42161</option><option value="1">Ethereum 1</option><option value="10">Optimism 10</option><option value="other">other…</option></select>
            <input id="fw-chain-other" placeholder="chain id" size="8" style="display:none"> · role: <select id="fw-role" style="padding:4px" onchange="walletFwHint()">${roleOpts}</select>
            · <label><input type="checkbox" id="fw-any" onchange="walletFwHint()"> any selector</label> · <label><input type="checkbox" id="fw-value"> allow value</label></div>
          <div class="gs-sub" id="fw-hint" style="margin:4px 0"></div>
          <input id="fw-label" placeholder="label, e.g. Aerodrome Slipstream NPM (Base)" autocomplete="off" style="${field}">
          <input id="fw-verified" placeholder="verified by (required): report path or source" autocomplete="off" style="${field}">
          <input id="fw-pass" type="password" autocomplete="new-password" placeholder="Keystore passphrase (signs the record; never stored)" style="${field}">
          <div class="gs-sub">Deactivate also uses this passphrase field. "Allow value" only has an effect together with "any selector". Neither is allowed on an executor.</div>
          <div class="gs-actions"><button class="gs-btn" onclick="walletAct('fwadd')">Add to firewall</button></div></div>`;
      }
      if (!s.keystore.unlocked) {
        html += `<div class="gs-actions">${gsClose}<button class="gs-btn" onclick="document.getElementById('w-pass').scrollIntoView({block:'center'});document.getElementById('w-pass').focus()">Unlock (box at the top)</button></div>`;
      } else {
        html += `<div class="gs-box"><h4>Import a wallet</h4>
          <div class="gs-sub" style="margin-bottom:4px">Paste a private key (64 hex characters) or a seed phrase (12 or 24 words). From a seed phrase one account is derived (m/44'/60'/0'/0/&lt;index&gt;) and the phrase itself is <em>not</em> stored, so its other accounts stay out of reach of this machine. Whatever the wallet holds is what the agent can lose.</div>
          <input id="w-import-name" placeholder="wallet name, e.g. bot-two" autocomplete="off" style="${field}">
          <textarea id="w-import-secret" placeholder="private key or seed phrase" autocomplete="off" spellcheck="false" rows="2" style="${field}"></textarea>
          <div class="gs-sub">account index (seed phrase only): <input id="w-import-index" value="0" size="3"></div>
          <div class="gs-actions"><button class="gs-btn" onclick="walletAct('import')">Import wallet</button></div></div>
          <div class="gs-box"><h4>New wallet</h4>
          <input id="w-name" placeholder="new wallet name, e.g. bot-one" style="${field}">
          <div class="gs-sub" style="margin:4px 0">tier: <select id="w-tier" style="padding:4px" onchange="document.getElementById('w-cap-row').style.display=this.value==='open'?'':'none'"><option value="guarded" selected>guarded (signing firewall, default)</option><option value="open">OPEN: no signing firewall</option></select>
            <span id="w-cap-row" style="display:none"> · funding cap $<input id="w-cap" placeholder="100" size="6"></span></div>
          <div class="gs-sub">The tier cannot be changed later; create a new wallet instead. An <strong>open</strong> wallet skips the address book: anything goes except plain ETH or token transfers away from this keystore, and approvals to anything but an allow-listed router. It can only be funded from a guarded wallet up to its cap.</div></div>
          <div class="gs-actions">${gsClose}<a class="gs-btn secondary" href="/api/wallet/audit.csv">Audit log (CSV)</a>
          <button class="gs-btn secondary" onclick="walletAct('lock')">Lock</button>
          <button class="gs-btn secondary" onclick="walletAct('pause', ${!s.paused})">${s.paused ? 'Resume trading' : 'Pause all trading'}</button>
          <button class="gs-btn" onclick="walletAct('create')">Create wallet</button></div>`;
      }
      gsModal(html, dock);
      walletFwHint();
    }
    let walletFw = null;
    // Shows what the selected role lets a guarded wallet call, so "contract" is not mistaken for "anything".
    function walletFwHint() {
      const el = document.getElementById('fw-hint'); if (!el || !walletFw) return;
      const role = (document.getElementById('fw-role') || {}).value, any = !!(document.getElementById('fw-any') || {}).checked;
      const list = (walletFw.allowedFor || {})[role] || [];
      if (any && role !== 'executor') { el.innerHTML = `Any function on this address is allowed (the theft checks still apply).`; return; }
      el.innerHTML = `This role allows only: ${list.length ? list.map(x => `<code>${esc(x)}</code>`).join(', ') : '<em>nothing</em>'}.` + (role === 'contract' ? ` Tick "any selector" for other contracts.` : '');
    }
    async function walletAct(action, arg, arg2) {
      const v = id => (document.getElementById(id) || {}).value || '';
      // Read the executor passphrase field and clear it immediately: it lives only in this request.
      const takePass = () => { const el = document.getElementById('x-pass'); const p = el ? el.value : ''; if (el) el.value = ''; if (!p) alert('Enter the keystore passphrase in the Executor box first.'); return p; };
      try {
        if (action === 'init') { if (v('w-pass') !== v('w-pass2')) return alert('The two passphrases do not match.'); await walletApi('init', { passphrase: v('w-pass') }); return openWalletPanel('Keystore created and unlocked.'); }
        if (action === 'unlock') {
          const p = v('w-pass'); if (!p) { const el = document.getElementById('w-pass'); if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } return alert('Type the keystore passphrase in the "Unlock the keystore" box at the top of the panel.'); }
          await walletApi('unlock', { passphrase: p }); return openWalletPanel('Unlocked until the hub restarts.');
        }
        if (action === 'lock') { await walletApi('lock', {}); return openWalletPanel('Locked.'); }
        if (action === 'pause') {
          const wallet = arg2 || null;
          await walletApi('pause', { paused: !!arg, wallet });
          return openWalletPanel(wallet ? (arg ? `Wallet "${wallet}" paused. Dry runs still work.` : `Wallet "${wallet}" resumed.`) : (arg ? 'All trading paused. Dry runs still work.' : 'Trading resumed.'));
        }
        if (action === 'hsave' || action === 'hagent' || action === 'hextagent') {
          const el = document.getElementById('h-pass'); const passphrase = el ? el.value : ''; if (el) el.value = '';
          if (!passphrase) return alert('Enter the keystore passphrase in the Hyperliquid box first.');
          if (action === 'hagent') { const r = await walletApi('hl/agent', { passphrase }); return openWalletPanel(`Agent key approved on ${r.status.env}: ${r.agent.address}`); }
          if (action === 'hextagent') {
            const agentAddress = v('h-ext-addr').trim(), agentName = v('h-ext-name').trim();
            if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) return alert('Enter the external agent address (0x followed by 40 hex characters).');
            if (!agentName) return alert('Give the external agent a name.');
            if (!confirm(`Authorize ${agentAddress} ("${agentName}") to TRADE this Hyperliquid account on ${v('h-env')}? It cannot withdraw. This is signed with the main wallet's key.`)) return;
            const r = await walletApi('hl/approve-agent', { passphrase, agentAddress, agentName });
            return openWalletPanel(`External agent "${r.agent.name}" ${r.agent.address} approved on ${r.agent.env}${r.agent.verified === true ? ' and listed by the exchange' : r.agent.verified === false ? ' (not yet in the exchange listing; check again in a minute)' : ''}.`);
          }
          const chk = id => !!(document.getElementById(id) || {}).checked; const tools = {};
          document.querySelectorAll('[id^="h-act-"]').forEach(x => { const k = x.id.slice(6); tools[k] = { enabled: chk('h-act-' + k), dryRun: chk('h-dry-' + k) }; });
          await walletApi('hl/config', { passphrase, env: v('h-env'), enabled: chk('h-enabled'), wallet: v('h-wallet'), tools, perps: v('h-perps'), spot: v('h-spot'),
            caps: { maxDepositPerCall: Number(v('h-cap-dep')), maxDepositPerDay: Number(v('h-cap-depday')), maxOrderNotionalUsd: Number(v('h-cap-ntl')), maxLeverage: Number(v('h-cap-lev')), maxOpenPositions: Number(v('h-cap-pos')), maxWithdrawPerDay: Number(v('h-cap-wd')) } });
          return openWalletPanel('Hyperliquid settings saved.');
        }
        if (action === 'xsave') {
          const chk = id => !!(document.getElementById(id) || {}).checked; const actions = {};
          document.querySelectorAll('[id^="x-act-"]').forEach(el => { const k = el.id.slice(6); actions[k] = { enabled: chk('x-act-' + k), dryRun: chk('x-dry-' + k), wallet: v('x-wallet-' + k) }; });
          const passphrase = takePass(); if (!passphrase) return;
          await walletApi('executor/config', { passphrase, enabled: chk('x-enabled'), wallet: v('x-wallet'), actions, caps: { maxUsdPerExecution: Number(v('x-cap-usd')), maxPerHour: Number(v('x-cap-hour')), maxPerDay: Number(v('x-cap-day')) } });
          return openWalletPanel('Executor settings saved.');
        }
        if (action === 'xtoken') {
          const passphrase = takePass(); if (!passphrase) return;
          const r = await walletApi('executor/token', { passphrase }); return openWalletPanel('New token generated.', { token: r.token });
        }
        if (action === 'create') {
          const tier = v('w-tier') || 'guarded';
          if (tier === 'open' && !confirm(`Create an OPEN wallet? Its transactions are not checked against the address book. Funding cap: $${v('w-cap') || '?'}.`)) return;
          const r = await walletApi('create', { name: v('w-name'), tier, fundingCapUsd: tier === 'open' ? v('w-cap') : undefined });
          return openWalletPanel(`Created "${r.created.name}" (${r.created.tier === 'open' ? 'OPEN, no signing firewall, cap $' + r.created.fundingCapUsd : 'guarded'}) with a fresh seed phrase. Send ETH on Base to ${r.created.address}. Use "Reveal key" to back up its seed phrase now.`);
        }
        if (action === 'import') {
          const el = document.getElementById('w-import-secret'); const secret = el ? el.value : ''; if (el) el.value = '';
          if (!secret.trim()) return alert('Paste the private key or seed phrase first.');
          const tier = v('w-tier') || 'guarded';
          if (tier === 'open' && !confirm(`Import as an OPEN wallet? Its transactions are not checked against the address book. Funding cap: $${v('w-cap') || '?'}.`)) return;
          const r = await walletApi('import', { name: v('w-import-name'), secret, index: v('w-import-index'), tier, fundingCapUsd: tier === 'open' ? v('w-cap') : undefined });
          return openWalletPanel(`Imported "${r.imported.name}" (${r.imported.source.replace('-', ' ')}${r.imported.tier === 'open' ? ', OPEN, cap $' + r.imported.fundingCapUsd : ''}): ${r.imported.address}`);
        }
        if (action === 'reveal') {
          const el = document.getElementById('w-reveal-pass'); const passphrase = el ? el.value : ''; if (el) el.value = '';
          if (!passphrase) { if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } return alert('Type the keystore passphrase in the Recovery box first, then click Reveal key.'); }
          const r = await walletApi('reveal', { name: arg, passphrase }); return openWalletPanel('', { reveal: r });
        }
        if (action === 'backup') { const r = await walletApi('backup', {}); return openWalletPanel(`Keystore copied to ${r.file}`); }
        if (action === 'fwadd' || action === 'fwdeact') {
          const el = document.getElementById('fw-pass'); const passphrase = el ? el.value : ''; if (el) el.value = '';
          if (!passphrase) { if (el) { el.scrollIntoView({ block: 'center' }); el.focus(); } return alert('Type the keystore passphrase in the Firewall box first.'); }
          if (action === 'fwdeact') {
            const reason = prompt(`Deactivate ${arg} on chain ${arg2}? Guarded wallets stop signing calls to it at once. Reason (optional):`, '');
            if (reason === null) return;
            await walletApi('allowlist/deactivate', { address: arg, chainId: Number(arg2), reason, passphrase });
            return openWalletPanel(`Deactivated ${arg} on chain ${arg2}.`);
          }
          const chainRaw = v('fw-chain') === 'other' ? v('fw-chain-other').trim() : v('fw-chain');
          const chainId = Number(chainRaw); if (!Number.isInteger(chainId) || chainId <= 0) return alert('Chain id must be a positive whole number.');
          if (!v('fw-verified').trim()) return alert('"Verified by" is required: say where the address was checked.');
          const chk = id => !!(document.getElementById(id) || {}).checked;
          const r = await walletApi('allowlist/add', { address: v('fw-address').trim(), chainId, label: v('fw-label').trim(), role: v('fw-role'), anySelector: chk('fw-any'), allowValue: chk('fw-value'), verifiedBy: v('fw-verified').trim(), passphrase });
          return openWalletPanel(`Added ${r.record ? r.record.address : v('fw-address').trim()} on chain ${chainId} as ${v('fw-role')}.`);
        }
      } catch (e) { alert(e.message); }
    }

    async function openGitSync() {
      gsModal(`<h3>⬇️ Update from GitHub</h3>
        <p class="gs-sub">Checking for updates…</p>`);

      let s;
      try {
        const r = await fetch('/api/git-sync/status', { credentials: 'include' });
        s = await r.json();
      } catch (e) {
        gsModal(`<h3>⬇️ Update from GitHub</h3>
          <div class="gs-blocker">Could not reach the server: ${esc(e.message)}</div>
          <div class="gs-actions">${gsClose}</div>`);
        return;
      }

      if (!s.ok) {
        gsModal(`<h3>⬇️ Update from GitHub</h3>
          <div class="gs-blocker">${esc(s.error)}</div>
          <div class="gs-actions">${gsClose}</div>`);
        return;
      }

      // The channel is asked every time the dialog opens (the owner's rule): stable or experimental, the current
      // one preselected. Choosing the other switches branches and updates in one go.
      gsStatus = s;
      const ch = s.channels || { current: s.channel || null, channels: [] };
      const channelHtml = ch.channels.length ? `<div class="gs-box" id="gs-channels"><h4>Which channel?</h4>${ch.channels.map(c => {
        const note = !c.available ? (c.error || 'not on GitHub')
          : c.current ? (s.behind > 0 ? `${s.behind} new commit${s.behind === 1 ? '' : 's'} available` : 'up to date')
          : `${c.adds ? `adds ${c.adds} commit${c.adds === 1 ? '' : 's'}` : 'adds nothing'}${c.drops ? `, leaves ${c.drops} of the current commit${c.drops === 1 ? '' : 's'} behind` : ''}`;
        return `<label class="gs-sub" style="display:block;margin:4px 0;cursor:pointer"><input type="radio" data-no-dirty name="gs-channel" value="${esc(c.id)}" ${c.current ? 'checked' : ''} ${c.available ? '' : 'disabled'} onchange="gsChannelChanged()"> <strong>${esc(c.label)}</strong> (${esc(c.branch)})${c.current ? ' — current' : ''}: ${esc(c.blurb)}; ${esc(note)}</label>`;
      }).join('')}</div>` : '';

      let html = `<h3>⬇️ Update from GitHub</h3>
        <p class="gs-sub">Branch <strong>${esc(s.branch)}</strong>${s.upToDate ? '' : ` — ${s.behind} new commit${s.behind === 1 ? '' : 's'} available`}</p>${channelHtml}`;
      if (s.upToDate) html += `<div class="gs-ok">✓ Already up to date on this channel</div>`;

      if (s.rewritten) {
        html += `<div class="gs-box"><h4>GitHub's history was rewritten</h4><p class="gs-sub">The ${s.ahead} commit${s.ahead === 1 ? '' : 's'} this copy has that GitHub does not are the same changes under new ids (GitHub's history was rewritten, for example to remove personal details). Updating moves this copy to GitHub's history. Your data, agents and workspaces are not touched; the old position is kept as a backup branch${s.canRewriteUpdate ? '.' : '. Discard the uncommitted files below first.'}</p></div>`;
        if (s.localOnlyCount > 0) {
          html += `<div class="gs-blocker"><strong>${s.localOnlyCount} commit${s.localOnlyCount === 1 ? ' has' : 's have'} no copy on GitHub</strong><p class="gs-sub">A rewrite can drop a commit whose only change was removed by it. If one of these is your own work, push it first. Otherwise it stays on the backup branch.</p>${
            s.localOnly.map(c => `<div class="gs-commit">${esc(c)}</div>`).join('')
          }<label class="gs-sub" style="display:block;margin-top:6px"><input type="checkbox" id="gs-rewrite-ok" onchange="const b=document.getElementById('gs-rewrite'); if (b) b.disabled=!this.checked"> Move on; keep these on the backup branch</label></div>`;
        }
      }

      if (s.blockers.length > 0) {
        html += `<div class="gs-blocker"><strong>Update blocked</strong><ul>${
          s.blockers.map(b => `<li>${esc(b)}</li>`).join('')
        }</ul></div>`;
        if (s.dirty.length > 0) {
          html += `<div class="gs-box"><h4>Uncommitted files</h4>${
            s.dirty.map(d => `<div class="gs-file">${esc(d.status)} ${esc(d.file)}</div>`).join('')
          }</div>`;
        }
        if (s.canForce) {
          html += `<p class="gs-sub">These are application files, not your data. Safe to discard.</p>`;
        } else if (s.localOnly && s.localOnly.length) {
          html += `<div class="gs-box"><h4>Local commits not on GitHub</h4>${
            s.localOnly.map(c => `<div class="gs-commit">${esc(c)}</div>`).join('')
          }</div><p class="gs-sub">These look like your own work: push or save them first — nothing was changed.</p>`;
        } else {
          html += `<p class="gs-sub">Commit, stash, or discard these first — nothing was changed.</p>`;
        }
      }

      if (s.commits.length > 0) {
        html += `<div class="gs-box"><h4>Incoming commits</h4>${
          s.commits.map(c => `<div class="gs-commit">${esc(c)}</div>`).join('')
        }</div>`;
      }
      if (s.files.length > 0) {
        html += `<div class="gs-box"><h4>${s.files.length} file${s.files.length === 1 ? '' : 's'} changed</h4>${
          s.files.map(f => `<div class="gs-file">${esc(f)}</div>`).join('')
        }</div>`;
      }
      if (s.needsInstall) {
        html += `<p class="gs-sub">Packages changed: the update installs them first. If that fails, it puts everything back and nothing restarts.</p>`;
      }

      html += `<div class="gs-actions">${gsClose}`;
      const otherAvailable = ch.channels.some(c => !c.current && c.available);
      if (s.canUpdate || otherAvailable) {
        html += `<button class="gs-btn" id="gs-go" onclick="runGitSync()" ${s.canUpdate ? '' : 'disabled'}>${s.canUpdate ? 'Update &amp; Restart' : 'Up to date'}</button>`;
      }
      if (s.canForce) {
        html += `<button class="gs-btn" id="gs-force" onclick="runGitSync(true)">Discard Changes &amp; Update</button>`;
      }
      if (s.canRewriteUpdate) {
        html += `<button class="gs-btn" id="gs-rewrite" data-confirm="${s.localOnlyCount || 0}" ${s.localOnlyCount ? 'disabled' : ''} onclick="runGitSync('rewrite')">Move to GitHub's History &amp; Restart</button>`;
      }
      html += `</div>`;
      gsModal(html);
    }

    let gsStatus = null;   // the last /api/git-sync/status, for the channel radios
    // The chosen channel when it differs from the current one, else null.
    function gsChosenChannel() {
      const sel = document.querySelector('input[name="gs-channel"]:checked');
      const cur = gsStatus && gsStatus.channels ? gsStatus.channels.current : null;
      return sel && sel.value !== cur ? sel.value : null;
    }
    function gsChannelChanged() {
      const go = document.getElementById('gs-go');
      if (!go) return;
      const other = gsChosenChannel();
      const c = other && gsStatus && gsStatus.channels ? gsStatus.channels.channels.find(x => x.id === other) : null;
      if (c) { go.disabled = false; go.innerHTML = `Switch to ${esc(c.label)} &amp; Restart`; }
      else { go.disabled = !(gsStatus && gsStatus.canUpdate); go.innerHTML = gsStatus && gsStatus.canUpdate ? 'Update &amp; Restart' : 'Up to date'; }
      // Discarding updates the current channel only, so it is off while another channel is chosen.
      const force = document.getElementById('gs-force'); if (force) force.disabled = !!c;
    }

    async function runGitSync(force) {
      const btnId = force === 'rewrite' ? 'gs-rewrite' : force ? 'gs-force' : 'gs-go';
      const channel = force ? null : gsChosenChannel();
      for (const id of ['gs-go', 'gs-force', 'gs-rewrite']) {
        const b = document.getElementById(id);
        if (!b) continue;
        b.disabled = true;
        if (id === btnId) b.textContent = channel ? 'Switching…' : 'Updating…';
      }

      let r;
      try {
        const endpoint = force === 'rewrite' ? '/api/git-sync/rewrite-update' : force ? '/api/git-sync/force-update' : '/api/git-sync/update';
        const rw = force === 'rewrite' ? document.getElementById('gs-rewrite') : null;
        const resp = await fetch(endpoint, rw
          ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmLocalOnly: Number(rw.dataset.confirm) || 0 }) }
          : channel
            ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel }) }
            : { method: 'POST', credentials: 'include' });
        r = await resp.json();
      } catch (e) {
        gsModal(`<h3>⬇️ Update from GitHub</h3>
          <div class="gs-blocker">Update failed: ${esc(e.message)}</div>
          <div class="gs-actions">${gsClose}</div>`);
        return;
      }

      if (!r.success) {
        gsModal(`<h3>⬇️ Update from GitHub</h3>
          <div class="gs-blocker">${esc(r.error)}</div>
          <div class="gs-actions">${gsClose}</div>`);
        return;
      }

      gsModal(`<h3>⬇️ Update from GitHub</h3>
        <div class="gs-ok">✓ Updated to ${esc(r.head)}</div>
        <div class="gs-box"><h4>Steps</h4>${
          r.steps.map(s => `<div class="gs-commit">• ${esc(s)}</div>`).join('')
        }</div>
        <p class="gs-sub">Restarting the hub…</p>`);

      // Reuse the restart button's flush + poll path.
      const rbtn = document.getElementById('restart-hub-btn');
      try {
        await fetch('/api/restart', { method: 'POST', credentials: 'include' });
      } catch (e) { /* expected — server dies */ }
      setTimeout(() => pollForRestart(rbtn), 8000);
    }

    // ── Settings ──
    function stModal(inner) {
      let overlay = document.getElementById('st-overlay');
      if (overlay) overlay.remove();
      overlay = document.createElement('div');
      overlay.id = 'st-overlay';
      overlay.className = 'st-overlay';
      overlay.innerHTML = `<div class="st-modal">${inner}</div>`;
      document.body.appendChild(overlay);   // Esc, the backdrop and Close: dialogGuard
      return overlay;
    }

    const PROVIDERS = [
      { id: 'anthropic',  label: 'Anthropic', hasKey: true, hasUrl: false },
      { id: 'openai',     label: 'OpenAI', hasKey: true, hasUrl: false },
      { id: 'google',     label: 'Google (Gemini)', hasKey: true, hasUrl: false },
      { id: 'perplexity', label: 'Perplexity', hasKey: true, hasUrl: false },
      { id: 'openrouter', label: 'OpenRouter', hasKey: true, hasUrl: false },
      { id: 'lmstudio',   label: 'LM Studio', hasKey: false, hasUrl: true },
      { id: 'ollama',     label: 'Ollama', hasKey: false, hasUrl: true },
      { id: 'omlx',       label: 'oMLX (Apple Silicon)', hasKey: false, hasUrl: true },
    ];

    // Help (the ? button, top right): help.html in a side panel next to the chat. The same page works on its own at
    // /help (phone menu, sign-in page) and when the hub is unreachable the troubleshooting lives on the website too.
    function openHelpPanel() {
      gsModal(`<iframe src="/help?embed=1" title="Help" style="width:100%;height:calc(100vh - 90px);border:0;background:transparent"></iframe>
        <p style="margin:6px 0 0;font-size:12px"><a href="/help" target="_blank" rel="noopener">Open help in its own tab</a></p>`, { dock: true, title: '❓ Help' });
    }

    // Settings groups: openSettings() draws its sections in one column, then groupSettings() folds them into these
    // groups, closed until opened. Sections are matched by id; one this list doesn't know lands in the last group,
    // so a new section can't disappear. Which groups are open is kept per browser (localStorage hub-settings-open).
    const ST_GROUPS = [
      { id: 'status', title: '🩺 Status', sections: ['st-ready-section', 'st-sec-section', 'st-updates-section'] },
      { id: 'models', title: '🧠 AI models', sections: ['st-prov-section', 'st-or-section', 'st-plan-section', 'st-local-models-section', 'st-classifier-section'] },
      { id: 'agents', title: '🤖 Agents', sections: ['st-defaults-section', 'st-sb-section', 'st-mp-section', 'st-approvals-section'] },
      { id: 'notify', title: '🔔 Notifications', sections: ['st-notify-section'] },
      { id: 'tools', title: '🧰 Tools and data', sections: ['st-ws-section', 'st-cx-section', 'st-modules-section'] },
      { id: 'money', title: '💰 Money and safety', sections: ['st-spend-section', 'st-emergency-section'] },
    ];
    const stSumParts = {};   // group -> { key: { text, crit } }: the one-line summary on each group's header
    const stSandboxText = (sbd) => `Sandboxes: members' agents ${sbd.member || 'container'}, admin-side ${sbd.admin || 'off'}`;
    const stQuestionsText = (qa) => qa === null ? 'Question reminders off' : `Questions: ${qa === 0 ? 'right away' : `after ${qa === undefined ? 3 : qa} min`}`;
    let stSearchSnap = null;   // which groups were open before a search, put back when the search is cleared

    // Set one part of a group's summary line; the section loaders call this as their data arrives.
    function stSum(group, key, text, crit = false) {
      (stSumParts[group] ||= {})[key] = { text: text || '', crit: !!crit };
      const el = document.getElementById(`st-sum-${group}`);
      if (!el) return;
      const parts = Object.values(stSumParts[group]);
      el.textContent = parts.map(p => p.text).filter(Boolean).join(' · ');
      el.classList.toggle('st-sum-crit', parts.some(p => p.crit && p.text));
    }

    // Open or close a group without counting it as the person's choice (searches, deep links, a critical finding).
    function stSetOpen(g, open) {
      if (!g || g.open === open) return;
      g.dataset.auto = '1';
      if (open) g.dataset.autoOpen = '1';   // opened for them: not remembered unless they click it themselves
      g.open = open;
    }
    function stOpenGroup(groupId) {
      const g = document.getElementById(`st-group-${groupId}`);
      if (stSearchSnap) {   // a search is in progress: show the group now, and keep it open when the search is cleared
        stSearchSnap[groupId] = true;
        if (g) { g.style.display = ''; for (const s of g.querySelectorAll('.st-section')) s.style.display = ''; }
      }
      stSetOpen(g, true);
    }

    function stSaveOpen() {
      const open = {};
      for (const g of document.querySelectorAll('#st-groups details.st-group')) if (g.open && !g.dataset.autoOpen) open[g.dataset.group] = true;
      try { localStorage.setItem('hub-settings-open', JSON.stringify(open)); } catch {}
    }

    function groupSettings(data) {
      const modal = document.querySelector('#st-overlay .st-modal');
      if (!modal) return;
      const sections = [...modal.children].filter(el => el.classList.contains('st-section'));
      if (!sections.length) return;
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('hub-settings-open') || '{}') || {}; } catch {}
      for (const k of Object.keys(stSumParts)) delete stSumParts[k];
      stSearchSnap = null;
      const wrap = document.createElement('div');
      wrap.id = 'st-groups';
      wrap.innerHTML = `<div class="st-search"><input type="search" id="st-search" placeholder="Search settings: privacy, sandbox, push, spend…" autocomplete="off" aria-label="Search settings"><span id="st-search-none" hidden>Nothing matches.</span></div>`
        + ST_GROUPS.map(g => `<details class="st-group" id="st-group-${g.id}" data-group="${g.id}"${saved[g.id] ? ' open' : ''}><summary><span class="st-group-title">${esc(g.title)}</span><span class="st-group-sum" id="st-sum-${g.id}"></span></summary><div class="st-group-body"></div></details>`).join('');
      modal.insertBefore(wrap, sections[0]);
      const body = (id) => wrap.querySelector(`#st-group-${id} .st-group-body`);
      const placed = new Set();
      for (const g of ST_GROUPS) for (const id of g.sections) {
        const s = sections.find(el => el.id === id);
        if (s) { body(g.id).appendChild(s); placed.add(s); }
      }
      for (const s of sections) if (!placed.has(s)) body(ST_GROUPS[ST_GROUPS.length - 1].id).appendChild(s);
      for (const d of wrap.querySelectorAll('details.st-group')) d.addEventListener('toggle', () => {
        if (d.dataset.auto) { delete d.dataset.auto; return; }
        delete d.dataset.autoOpen;   // they clicked it: from now on it is their choice
        if (!stSearchSnap) stSaveOpen();   // during a search nothing is remembered
      });
      const input = wrap.querySelector('#st-search');
      input.addEventListener('input', () => stSearch(input.value));
      input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); input.value = ''; stSearch(''); } });

      // What the settings already say; the loaders fill in the rest (checks, plan, spend, search chain…).
      const pv = (data && data.providers) || {};
      const keys = PROVIDERS.filter(p => p.hasKey && pv[p.id] && pv[p.id].hasKey).length;   // server URLs always have a default, so they say nothing
      stSum('status', 'setup', 'Setup: checking…');
      stSum('status', 'security', 'Security: checking…');
      stSum('models', 'prov', keys ? `${keys} provider key${keys === 1 ? '' : 's'}` : 'no provider keys');
      for (const k of ['or', 'plan', 'local']) stSum('models', k, '');
      const sbd = (data && data.sandboxDefaults) || {};
      stSum('agents', 'sb', stSandboxText(sbd));
      stSum('agents', 'appr', `approval cards ${data && data.approvalsEnabled === true ? 'on' : 'off'}`);
      const qa = data && data.notify ? data.notify.questionAfterMinutes : undefined;
      stSum('notify', 'q', stQuestionsText(qa));
      stSum('notify', 'push', '');
      for (const k of ['search', 'cx']) stSum('tools', k, '');
      for (const k of ['spend', 'caps']) stSum('money', k, '');
    }

    // Search: show the sections whose words match (a group's title matching shows all of it), open their groups,
    // hide the rest. Clearing the box puts every group back the way it was.
    function stSearch(q) {
      q = String(q || '').trim().toLowerCase();
      const groups = [...document.querySelectorAll('#st-groups details.st-group')];
      const none = document.getElementById('st-search-none');
      if (!q) {
        for (const g of groups) {
          g.style.display = '';
          for (const s of g.querySelectorAll('.st-section')) { s.style.display = ''; s.classList.remove('st-match'); }
          if (stSearchSnap) stSetOpen(g, !!stSearchSnap[g.dataset.group]);
        }
        stSearchSnap = null;
        if (none) none.hidden = true;
        return;
      }
      if (!stSearchSnap) { stSearchSnap = {}; for (const g of groups) stSearchSnap[g.dataset.group] = g.open; }
      let any = false;
      for (const g of groups) {
        // a group whose summary is red (something critical) stays in view whatever is typed
        const titleHit = g.querySelector('.st-group-title').textContent.toLowerCase().includes(q) || !!g.querySelector('.st-group-sum.st-sum-crit');
        let n = 0;
        for (const s of g.querySelectorAll('.st-section')) {
          const hit = titleHit || s.textContent.toLowerCase().includes(q);
          s.style.display = hit ? '' : 'none';
          s.classList.toggle('st-match', hit && !titleHit);
          if (hit) n++;
        }
        g.style.display = n ? '' : 'none';
        if (n) stSetOpen(g, true);
        any = any || n > 0;
      }
      if (none) none.hidden = any;
    }

    // Links into Settings (the plan badge, the setup and security banners, today's spend) open the group that
    // holds the section, then scroll to it.
    async function openSettingsAt(sectionId) {
      await openSettings();
      const s = document.getElementById(sectionId);
      if (!s) return;
      stSetOpen(s.closest('details.st-group'), true);
      setTimeout(() => s.scrollIntoView({ behavior: 'smooth', block: 'start' }), 150);
    }

    async function openSettings() {
      stModal(`<h3>Loading settings...</h3>`);
      let data;
      try {
        const r = await fetch('/api/settings', { credentials: 'include' });
        data = await r.json();
      } catch (e) {
        stModal(`<h3>⚙️ Settings</h3><p style="color:var(--error)">Could not load settings: ${esc(e.message)}</p>
          <div class="st-actions"><button class="st-btn secondary" onclick="dialogRequestClose(this)">Close</button></div>`);
        return;
      }

      let html = `<h3>⚙️ Settings</h3><p class="st-sub">Open a group, or search for a setting. Provider keys and agent defaults are kept with Save at the bottom; every other box saves on its own.</p>`;

      // Setup checklist (lib/readiness): what this machine is missing and what to do about it, in its own words.
      html += `<div class="st-section" id="st-ready-section"><h4>Setup checklist</h4>
        <div class="st-hint">The hub checks its own machine: accounts and two-factor, a way to run models, Docker and the sandbox image for member agents, PDF and web reading, how it is restarted. Each line says what is missing and the exact step to fix it on this computer.</div>
        <div id="st-ready-list" class="st-hint" style="margin-left:0">Checking…</div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="loadReadiness()">Check again</button><span id="st-ready-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
      </div>`;
      // Security check (lib/security-check): the hub reviews its own security configuration, nightly and on demand.
      html += `<div class="st-section" id="st-sec-section"><h4>Security check</h4>
        <div class="st-hint">The hub reviews how it is set up: accounts and two-factor, how it can be reached, secrets and file permissions, agent policies and sandboxes, tokens and root, this machine's open doors. It runs every night and on demand. The same check runs from a terminal with no hub and no agent: <code>node scripts/security-check.js</code>.</div>
        <div id="st-sec-list" class="st-hint" style="margin-left:0">Checking…</div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="loadSecurityCheck(true)">Run now</button><span id="st-sec-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
      </div>`;
      setTimeout(loadSecurityCheck, 0);
      // Updates (lib/update-check): the daily look at GitHub behind the "Update available" card.
      html += `<div class="st-section" id="st-updates-section"><h4>Updates</h4>
        <div class="st-hint">Once a day the hub checks GitHub for a new version on its channel and tells admins: a card here with Update now or Later, a card on the phone, and a notification. It never installs anything by itself.</div>
        <div class="st-row"><label style="flex-basis:150px">Check every day</label><input type="checkbox" id="st-uc-on" onchange="saveUpdateCheck(this.checked)"><span id="st-uc-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px">Checking…</span></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="checkUpdatesNow(this)">Check now</button></div>
      </div>`;
      setTimeout(loadUpdateCheck, 0);
      // Modules (lib/modules): optional capabilities with guided setup live on their own page.
      html += `<div class="st-section" id="st-modules-section"><h4>Modules</h4>
        <div class="st-hint">Optional capabilities for agents (crypto exchanges, wallets, mail, search...), each with a step-by-step setup, encrypted keys and per-agent access. <a href="/modules" style="color:var(--accent)">Open the Modules page →</a></div>
      </div>`;
      setTimeout(loadReadiness, 0);

      // Local models (lib/local-models): one proxy (llama-swap) for every local engine, configured on its own page.
      html += `<div class="st-section" id="st-local-models-section"><h4>Local models</h4>
        <div class="st-hint">Run models on this machine through one proxy that starts the right engine (llama.cpp, NInfer or a command of your own), keeps a model loaded while it is in use and swaps when another is asked for. Models appear as <code>local/…</code>. <a href="/local-models" style="color:var(--accent)">Open the Local models page</a> <span id="st-local-models-status" class="st-dim"></span></div>
      </div>`;
      setTimeout(async () => { try { const r = await fetch('/api/local-models', { credentials: 'include' }); const j = await r.json(); const el = document.getElementById('st-local-models-status'); if (el && j && j.ok !== false) el.textContent = `· ${j.running ? 'proxy running on ' + j.port : (j.enabled ? 'proxy stopped' : 'off')}, ${(j.models || []).length} model(s)${(j.loaded || []).length ? ', loaded: ' + j.loaded.map(x => x.model || x.id || x).join(', ') : ''}`; if (j && j.ok !== false && j.enabled) stSum('models', 'local', `local models ${j.running ? 'running' : 'stopped'}`); } catch {} }, 0);

      html += `<div class="st-section" id="st-prov-section"><h4>LLM Providers</h4>
        <div class="st-hint">Keys are kept in one place: <code>data/settings.json</code>, readable only by this computer's account. A key typed into <code>.env</code> moves here when the hub starts.</div>`;
      for (const p of PROVIDERS) {
        const pdata = data.providers?.[p.id] || {};
        if (p.hasKey) {
          // A key the hub gets from its environment (a service file, Docker) is used until one is saved here.
          const hint = pdata.hasKey ? `${pdata.keyHint}${pdata.keySource === 'environment' ? ' (from the environment)' : ''}` : 'Not set';
          html += `<div class="st-row">
            <label>${esc(p.label)}</label>
            <input type="password" id="st-key-${p.id}" placeholder="${esc(hint)}"
              data-provider="${p.id}" data-field="apiKey">
            <button class="st-test-btn" onclick="testProvider('${p.id}')">Test</button>
          </div>`;
        }
        if (p.hasUrl) {
          html += `<div class="st-row">
            <label>${esc(p.label)}</label>
            <input type="text" id="st-url-${p.id}" value="${esc(pdata.url || '')}"
              placeholder="${esc(pdata.defaultUrl || '')}" data-provider="${p.id}" data-field="url">
            <button class="st-test-btn" onclick="testProvider('${p.id}')">Test</button>
          </div>
          <div class="st-hint">Default: ${esc(pdata.defaultUrl || '')}</div>`;
        }
      }
      html += `</div>`;

      // OpenRouter (lib/openrouter): which of its models the pickers offer, and the privacy switch.
      html += `<div class="st-section" id="st-or-section"><h4>OpenRouter</h4>
        <div class="st-hint">One key, models from many vendors (Grok, DeepSeek, Kimi, Qwen, Mistral, GLM, Llama, and Claude, GPT and Gemini too). Tick the ones the model pickers should offer; each runs with the same tools and memory as every other agent, and OpenRouter's reported cost goes into the daily spend.</div>
        <div id="st-or-body" class="st-hint" style="margin-left:0">Loading…</div>
      </div>`;
      setTimeout(() => loadOpenRouterBox(false), 0);

      html += `<div class="st-section" id="st-defaults-section"><h4>Agent Defaults</h4>
        <div class="st-row">
          <label>Max tokens</label>
          <input type="text" id="st-maxTokens" value="${data.maxCompletionTokens || 32000}"
            placeholder="32000" style="max-width:120px">
        </div>
        <div class="st-row">
          <label>Context msgs</label>
          <input type="text" id="st-maxContext" value="${data.maxContextMessages || 40}"
            placeholder="40" style="max-width:120px">
        </div>
        <div class="st-row">
          <label>Reasoning</label>
          <label class="toggle-switch"><input type="checkbox" id="st-reasoning" ${data.showReasoning !== false ? 'checked' : ''} onchange="saveReasoningToggle(this.checked)"><span class="toggle-slider"></span></label>
          <span id="st-reasoning-state" style="font-size:0.8rem;color:var(--text-dim)">${data.showReasoning !== false ? 'Shown above each reply.' : 'Not shown.'}</span>
        </div>
        <div class="st-hint">Models that reason before they answer (Claude, Codex, DeepSeek, Grok, Qwen…) show it in a panel above the reply: open or close it, drag its bottom edge to any height, ⤢ for the full window. Starts with the next reply.</div>
      </div>`;

      {
        // When a question (or an approval) still waits: settings.notify.questionAfterMinutes (unset 3, null never).
        const qa = data.notify ? data.notify.questionAfterMinutes : undefined;
        const qaVal = qa === null ? 'off' : (qa === undefined ? '3' : String(qa));
        const qaOpts = [['off', 'Never'], ['0', 'Right away'], ['1', 'After 1 minute'], ['3', 'After 3 minutes'], ['5', 'After 5 minutes'], ['10', 'After 10 minutes']];
        if (!qaOpts.some(o => o[0] === qaVal)) qaOpts.push([qaVal, `After ${qaVal} minutes`]);
        html += `<div class="st-section" id="st-notify-section"><h4>Notifications</h4>
        <div class="st-row">
          <label>🔔 Push</label>
          <button class="st-test-btn" id="st-push-btn" onclick="toggleDesktopPush()">…</button>
        </div>
        <div class="st-hint" id="st-push-hint">Notifications on this computer as well as the phone, even with this tab closed.</div>
        <div class="st-row">
          <label>Questions</label>
          <select id="st-question-after" onchange="saveQuestionAfter(this.value)">${qaOpts.map(([v, l]) => `<option value="${v}"${v === qaVal ? ' selected' : ''}>${l}</option>`).join('')}</select>
        </div>
        <div class="st-hint">A notification when an agent's question (or an approval) is still unanswered after this long. Finished replies notify only when you click 🔔 Notify me next to Cancel while the reply is running.</div>
      </div>`;
      }

      html += `<div class="st-section" id="st-emergency-section"><h4>Emergency</h4>
        <div class="st-row">
          <label>Kill switch</label>
          <button class="st-test-btn" style="color:#fff;background:#b71c1c" onclick="haltHub()">⛔ Halt all agents</button>
        </div>
        <div class="st-hint">Stops every running turn and job and blocks new ones until you press Resume.</div>
        <div class="st-row">
          <label>Provider pacing</label>
          <div id="st-pacing" style="flex:1;font-size:0.8rem;display:flex;flex-direction:column;gap:6px"></div>
        </div>
        <div class="st-hint">After rate limits or outages a provider runs one call at a time, then ramps back up. Resume restores full parallel right away.</div>
      </div>`;

      html += `<div class="st-section" id="st-approvals-section"><h4>Approval cards</h4>
        <div class="st-row">
          <label style="flex-basis:150px">Ask before risky actions</label>
          <label class="toggle-switch"><input type="checkbox" id="st-approvals" ${data.approvalsEnabled === true ? 'checked' : ''} onchange="saveApprovalsToggle(this.checked)"><span class="toggle-slider"></span></label>
          <span id="st-approvals-state" style="font-size:0.8rem;color:var(--text-dim)">${data.approvalsEnabled === true ? 'On: your agents pause on a card for sending, destructive and admin actions.' : 'Off: your agents just run. Members\' agents stay sandboxed either way.'}</span>
        </div>
        <div class="st-hint" style="margin-left:158px">Off by default. Turning it on shows a card (desktop, phone, push) when one of your agents is about to send something off the machine, delete, or touch hub data; it waits up to ${esc(String(data.approvalTimeoutMinutes || 60))} minutes for your answer.</div>
        <div class="st-row" style="margin-top:8px">
          <label style="flex-basis:150px">Always ask for</label>
          <span id="st-approval-classes" style="display:flex;gap:14px;flex-wrap:wrap;font-size:0.85rem">
            ${[['sudo', 'root commands (sudo)'], ['money', 'wallet and exchange'], ['destroy', 'destructive actions'], ['admin', 'hub data and credentials'], ['send', 'sending off the machine']].map(([c, l]) => `<label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" value="${c}" ${(Array.isArray(data.approvalClasses) && data.approvalClasses.includes(c)) ? 'checked' : ''} onchange="saveApprovalClasses()"> ${l}</label>`).join('')}
          </span>
        </div>
        <div class="st-hint" style="margin-left:158px">These kinds get a card even while the switch above is off. Root commands are the lead agent's alone (every other agent is refused); a card here means you confirm each one, and "approve for 1 hour" on the card lets a working session continue without asking again. Every root command is written to data/root-commands.jsonl either way.</div>
        <div class="st-row" style="margin-top:8px">
          <label style="flex-basis:150px">Root grants</label>
          <span id="st-root-grants" style="font-size:0.85rem;color:var(--text-dim)">Loading…</span>
          <button class="st-test-btn" onclick="loadRootGrants()" style="margin-left:8px">Refresh</button>
        </div>
        <div class="st-hint" style="margin-left:158px">An agent other than the lead runs root commands only while you have granted it root on its settings page (Tool policy → Root). Active grants are listed here with a revoke button; they expire on their own.</div>
      </div>`;
      // Claude plan (lib/plan-usage): the subscription's usage windows, warning levels, and every Claude agent's model.
      html += `<div class="st-section" id="st-plan-section"><h4>Claude plan</h4>
        <div class="st-hint">The hub reads your Claude subscription's usage every 10 minutes. When a weekly allowance passes a warning level you get a notice in the sidebar, a toast, a push to your phone and one line in each affected agent's next reply; then you choose each agent's model, here or in its chat header.</div>
        <div id="st-plan-usage" class="st-hint" style="margin-left:0">Loading…</div>
        <div class="st-row"><label style="flex-basis:150px">Warn me at</label><input type="text" id="st-plan-warn" placeholder="75, 90" style="width:110px;padding:4px"> <span style="font-size:0.85rem;color:var(--text-dim)">% of a weekly allowance</span> <button class="st-test-btn" onclick="savePlanWarn()" style="margin-left:8px">Save</button><span id="st-plan-warn-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
        <div class="st-row"><label style="flex-basis:150px">Switch by itself</label><label class="toggle-switch"><input type="checkbox" id="st-plan-auto" onchange="savePlanAuto(this.checked)"><span class="toggle-slider"></span></label><span id="st-plan-auto-state" style="font-size:0.8rem;color:var(--text-dim)"></span></div>
        <div id="st-plan-agents" style="margin-top:8px"></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="loadPlanBox(true)">Read usage now</button><span id="st-plan-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
      </div>`;
      setTimeout(loadPlanBox, 0);

      {
        const ac = data.autoClassifier || {};
        const sel = (id, opts, cur) => `<select id="${id}" style="padding:4px">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        html += `<div class="st-section" id="st-classifier-section"><h4>Auto model classifier</h4>
        <div class="st-hint">Decides the model for agents with Auto model on (the checkbox on each agent's settings page); in shadow mode it also watches every other agent's turns, logging what it would have picked. Off (builtin) keeps today's behaviour. A decider reads each prompt and names the kind of work (simple, code, math, vision, reasoning, hardest); the routing table picks the model. Guards: a confidence floor keeps the agent's own model, an agent's minimum model is never undercut, keep-on-box agents never use a hosted classifier, and shadow mode logs verdicts without changing anything.</div>
        <div class="st-row"><label style="flex-basis:150px">Classifier</label>${sel('st-cl-backend', [['builtin', 'builtin (off: keyword chain)'], ['local', 'local model (NInfer / LM Studio / Ollama)'], ['perplexity', 'Perplexity decider (hosted)'], ['local+perplexity', 'local, then Perplexity if local is down']], ac.backend || 'builtin')}</div>
        <div class="st-row"><label style="flex-basis:150px">Local server</label>${sel('st-cl-provider', [['auto', 'first reachable'], ['ninfer', 'NInfer'], ['lmstudio', 'LM Studio'], ['ollama', 'Ollama']], ac.localProvider || 'auto')} &nbsp; model <input type="text" id="st-cl-model" value="${esc(ac.localModel || '')}" placeholder="(server's first model)" style="width:200px"> &nbsp; <label><input type="checkbox" id="st-cl-think" ${ac.localThinking === false ? '' : 'checked'}> think briefly (slower, more accurate)</label></div>
        <div class="st-row"><label style="flex-basis:150px">Confidence floor</label><input type="number" id="st-cl-floor" min="0" max="1" step="0.05" value="${esc(String(ac.confidenceFloor == null ? 0.6 : ac.confidenceFloor))}" style="width:80px"> &nbsp; <label><input type="checkbox" id="st-cl-shadow" ${ac.shadow ? 'checked' : ''}> shadow mode (log only)</label></div>
        <div class="st-row"><label style="flex-basis:150px">Keep on box</label><input type="text" id="st-cl-keep" value="${esc(Array.isArray(ac.keepOnBox) ? ac.keepOnBox.join(', ') : '')}" placeholder="medical and legal teams by default" style="flex:1"></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="saveClassifier()">Save classifier settings</button><span id="st-cl-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
        <div class="st-row"><label style="flex-basis:150px">Try it</label><input type="text" id="st-cl-try" placeholder="Type a prompt and see what each backend says" style="flex:1" onkeydown="if(event.key==='Enter')tryClassifier()"><button class="st-test-btn" onclick="tryClassifier()">Classify</button></div>
        <div id="st-cl-result" class="st-hint" style="margin-left:158px;white-space:pre-wrap"></div>
        <div id="st-cl-stats" class="st-hint" style="margin-left:158px"></div>
        <div id="st-cl-recent" style="margin-left:158px;margin-top:6px;font-size:0.78rem;color:var(--text-dim);font-family:ui-monospace,monospace;white-space:pre;overflow-x:auto"></div>
      </div>`;
        setTimeout(loadClassifierStats, 0);
      }

      {
        const sbd = (data && data.sandboxDefaults) || {};
        const selSb = (id, opts, cur) => `<select id="${id}" style="padding:4px">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        const mp = (data && data.memberPolicy) || {};
        const mpSel = (k) => `<select id="st-mp-${k}" style="padding:4px">${[['', 'deny (built-in)'], ['ask', 'ask (approval card)'], ['allow', 'allow'], ['deny', 'deny']].map(([v, l]) => `<option value="${v}" ${(mp[k] || '') === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        html += `<div class="st-section" id="st-mp-section"><h4>Member agents: permissions</h4>
        <div class="st-hint">What every agent owned by a member may do beyond its own folders, unless that member's grant (Users page → Agent permissions) or the agent's own settings say otherwise. Changing the hub, destructive actions and money are never allowed for member agents. <b>ask</b> puts an approval card on an admin's screen.</div>
        <div class="st-row"><label style="flex-basis:150px">Web search and fetch</label>${mpSel('web')}</div>
        <div class="st-row"><label style="flex-basis:150px">Read outside its folders</label>${mpSel('read_outside')}</div>
        <div class="st-row"><label style="flex-basis:150px">Write outside its folders</label>${mpSel('write_outside')}</div>
        <div class="st-row"><label style="flex-basis:150px">Send off this machine</label>${mpSel('send')}</div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="saveMemberPolicy()">Save member defaults</button><span id="st-mp-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
      </div>`;
        html += `<div class="st-section" id="st-sb-section"><h4>Agent sandboxes</h4>
        <div class="st-hint">A sandboxed agent's shell and file tools run in a container of its own that holds only its folders: no hub data, no keys, no other agents. Hub tools (memory, Records, consultations, the policy gate) stay outside. Each agent can be set on its settings page; the defaults below say what "hub default" means. Needs Docker and the sandbox image. Without them, a sandboxed agent gets no shell instead of running on the host.</div>
        <div class="st-row"><label style="flex-basis:150px">Member-owned agents</label>${selSb('st-sb-member', [['container', 'container (recommended)'], ['off', 'off']], sbd.member || 'container')}</div>
        <div class="st-row"><label style="flex-basis:150px">Admin-side agents</label>${selSb('st-sb-admin', [['off', 'off (opt in per agent)'], ['container', 'container']], sbd.admin || 'off')}</div>
        <div class="st-row"><label style="flex-basis:150px">Tools, Claude/Codex agents</label>${selSb('st-tools-default', [['client', 'client tools (its own built-ins)'], ['hub', 'hub tools (same hands as every other agent)']], (data && data.toolsDefault) === 'hub' ? 'hub' : 'client')} <span class="st-hint" style="margin:0 0 0 8px">default for agents set to "hub default" on their settings page; gateway and local models always use hub tools</span></div>
        <div class="st-row"><label style="flex-basis:150px">Right now</label><span id="st-sb-now" style="flex:1;font-size:0.78rem;color:var(--text-dim)">${hubEsc(sandboxNowText(sbd, data && data.toolsDefault))}</span></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="saveSandboxDefaults()">Save sandbox defaults</button><button class="st-test-btn" onclick="buildSandboxImage()">Build / rebuild the image</button><span id="st-sb-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
        <div id="st-sb-status" class="st-hint" style="margin-left:158px"></div>
      </div>`;
        setTimeout(loadSandboxStatus, 0);
      }
      {
        const wsc = (data && data.webSearch) || {};
        const wfc = (data && data.webFetch) || {};
        const keys = wsc.keys || {};
        const selWs = (id, opts, cur) => `<select id="${id}" style="padding:4px">${opts.map(([v, l]) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`;
        const keyRow = (id, label, note) => `<div class="st-row"><label style="flex-basis:150px">${label}</label><input type="password" id="st-ws-key-${id}" placeholder="${keys[id] ? esc(keys[id]) : 'Not set'}" style="width:260px" autocomplete="off"> <span class="st-hint" style="margin:0 0 0 8px">${note}</span></div>`;
        html += `<div class="st-section" id="st-ws-section"><h4>Web search and fetch</h4>
        <div class="st-hint">Every agent on every model uses the same WebSearch and WebFetch tools; the hub does the work. Search walks the backends below in order and returns the first that answers: paid or keyed ones when you add a key, a self-hosted SearXNG the hub can run for you, and DuckDuckGo as the free floor. An agent may name a backend (for instance perplexity) when it wants that one. Fetch returns pages as markdown with links kept, reads PDFs, renders JavaScript-only pages in a browser when the plain fetch is empty, and refuses private and local addresses unless allowed below.</div>
        <div class="st-row"><label style="flex-basis:150px">Backend order</label><input type="text" id="st-ws-order" value="${esc(Array.isArray(wsc.order) ? wsc.order.join(', ') : 'brave, perplexity, serper, tavily, searxng, duckduckgo')}" style="flex:1"> <span class="st-hint" style="margin:0 0 0 8px">comma-separated; unconfigured ones are skipped</span></div>
        ${keyRow('brave', 'Brave key', 'api.search.brave.com; independent index')}
        ${keyRow('serper', 'Serper key', 'serper.dev; Google results')}
        ${keyRow('tavily', 'Tavily key', 'tavily.com; LLM-ready results')}
        <div class="st-row"><label style="flex-basis:150px">Perplexity</label><span class="st-hint" style="margin:0">uses the Perplexity provider key above</span></div>
        <div class="st-row"><label style="flex-basis:150px">SearXNG URL</label><input type="text" id="st-ws-searxng" value="${esc((wsc.searxng && wsc.searxng.url) || '')}" placeholder="http://127.0.0.1:8888" style="width:260px"> <button class="st-test-btn" onclick="searxngStart()">Run SearXNG here (Docker)</button><button class="st-test-btn" onclick="searxngStop()">Stop it</button></div>
        <div class="st-row"><label style="flex-basis:150px">Private addresses</label>${selWs('st-wf-private', [['admin', 'admin-side agents may fetch them (default)'], ['none', 'nobody'], ['all', 'every agent']], wfc.allowPrivate || 'admin')} &nbsp; Browser rendering ${selWs('st-wf-render', [['auto', 'auto (when the plain fetch is empty)'], ['off', 'off'], ['always', 'always']], wfc.render || 'auto')} &nbsp; <label><input type="checkbox" id="st-wf-jina" ${wfc.jina ? 'checked' : ''}> Jina Reader fallback (sends the URL to r.jina.ai)</label></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="saveWebSearch()">Save web settings</button><span id="st-ws-state" style="font-size:0.8rem;color:var(--text-dim);margin-left:8px"></span></div>
        <div id="st-ws-status" class="st-hint" style="margin-left:158px"></div>
        <div class="st-row"><label style="flex-basis:150px">Try a search</label><input type="text" id="st-ws-try" placeholder="query" style="flex:1" onkeydown="if(event.key==='Enter')tryWebSearch()"> ${selWs('st-ws-try-backend', [['', 'chain'], ['brave', 'brave'], ['perplexity', 'perplexity'], ['serper', 'serper'], ['tavily', 'tavily'], ['searxng', 'searxng'], ['duckduckgo', 'duckduckgo']], '')}<button class="st-test-btn" onclick="tryWebSearch()">Search</button></div>
        <div class="st-row"><label style="flex-basis:150px">Try a fetch</label><input type="text" id="st-wf-try" placeholder="https://…" style="flex:1" onkeydown="if(event.key==='Enter')tryWebFetch()"> <label><input type="checkbox" id="st-wf-try-render"> render</label><button class="st-test-btn" onclick="tryWebFetch()">Fetch</button></div>
        <div id="st-ws-result" style="margin-left:158px;margin-top:6px;font-size:0.78rem;color:var(--text-dim);font-family:ui-monospace,monospace;white-space:pre-wrap;max-height:260px;overflow:auto"></div>
      </div>`;
        setTimeout(loadWebSearchStatus, 0);
      }
      html += `<div class="st-section" id="st-cx-section"><h4>Data connectors</h4>
        <div class="st-hint" style="margin-left:0">Outside services plugged in as data: a patient portal, any MCP server the hub starts, or one of the built-in skills wrapped as a connector. Each connector is open to all agents or only to the ones you name. A connector can always be on, or locked behind its own passphrase, or behind its group's passphrase (one unlock opens every connector in the group, say all of "medical"). Unlocks expire after an idle timeout (hub setting connectorsUnlockMinutes, default 240 minutes) and on restart. Sensitive connectors need the owner's policy nod for reads.</div>
        <div id="st-cx-status" style="font-size:0.78rem;color:var(--text-dim);min-height:1.1em;margin-bottom:6px"></div>
        <div id="st-cx-groups"></div>
        <div id="st-cx-list"></div>
        <div id="st-cx-form"></div>
        <div class="st-row" style="margin-top:8px"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="cxNew()">New connector</button><button class="st-test-btn" onclick="cxGroupNewForm()">New group</button><button class="st-test-btn" onclick="cxLockAll()">Lock everything</button><button class="st-test-btn" onclick="loadConnectors()">Refresh</button></div>
      </div>`;
      setTimeout(loadConnectors, 0);

      html += `<div class="st-section" id="st-spend-section"><h4>Spend</h4>
        <div class="st-row">
          <label style="flex-basis:150px">Today</label>
          <div id="st-spend" style="flex:1;font-size:0.8rem;color:var(--text-dim)">Loading…</div>
        </div>
        <div class="st-row">
          <label style="flex-basis:150px">Daily cap per agent ($)</label>
          <input type="text" id="st-cap-agent" placeholder="unlimited" inputmode="decimal" style="max-width:120px">
        </div>
        <div class="st-row">
          <label style="flex-basis:150px">Daily cap, whole hub ($)</label>
          <input type="text" id="st-cap-hub" placeholder="unlimited" inputmode="decimal" style="max-width:120px">
          <button class="st-test-btn" id="st-caps-save" onclick="saveSpendCaps()">Save</button>
        </div>
        <div class="st-hint" style="margin-left:158px">Over a cap, an agent's decided actions (sending, writing outside its folders, admin, destructive) switch to ask for the rest of the day; nothing is silently stopped. Blank = unlimited.</div>
        <div class="st-row">
          <label style="flex-basis:150px" title="A monthly API credit, for example the one that comes with a Claude Max plan. The header then shows this period's spend through the hub against it.">Monthly API credit ($)</label>
          <select id="st-credit-provider" onchange="fillCreditInputs()" style="max-width:120px">${CREDIT_PROVIDERS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
          <input type="text" id="st-credit-amount" placeholder="none" inputmode="decimal" style="max-width:80px">
          <span style="font-size:0.78rem;color:var(--text-dim)">renews on day</span>
          <input type="text" id="st-credit-day" placeholder="1" inputmode="numeric" style="max-width:44px">
          <button class="st-test-btn" id="st-credit-save" onclick="saveCredit()">Save</button>
        </div>
        <div class="st-row">
          <label style="flex-basis:150px"></label>
          <div id="st-credit-list" style="flex:1;font-size:0.8rem;color:var(--text-dim)"></div>
        </div>
      </div>`;

      html += `<div class="st-actions">
        <span class="st-saved" id="st-saved">Saved</span>
        <button class="st-btn secondary" onclick="dialogRequestClose(this)">Close</button>
        <button class="st-btn" onclick="saveSettings()">Save</button>
      </div>`;

      stModal(html);
      groupSettings(data);
      paintDesktopPush();
      paintPacingSettings();
      paintSpendSettings();
      loadRootGrants();
    }

    // Auto model classifier (lib/classifier): settings, tallies, and the side-by-side try-it box.
    async function saveClassifier() {
      const saved = dialogGuard.savePoint(['st-cl-backend', 'st-cl-provider', 'st-cl-model', 'st-cl-think', 'st-cl-floor', 'st-cl-keep', 'st-cl-shadow'].map(id => document.getElementById(id)));
      const v = id => (document.getElementById(id) || {}).value; const chk = id => !!(document.getElementById(id) || {}).checked;
      const state = document.getElementById('st-cl-state');
      try {
        const r = await fetch('/api/auto-model/classifier', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
          body: JSON.stringify({ backend: v('st-cl-backend'), localProvider: v('st-cl-provider'), localModel: v('st-cl-model'), localThinking: chk('st-cl-think'), confidenceFloor: Number(v('st-cl-floor')), shadow: chk('st-cl-shadow'), keepOnBox: v('st-cl-keep') }) });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || r.status);
        saved();
        if (state) state.textContent = `Saved. Backend ${d.config.backend}${d.config.shadow ? ' (shadow)' : ''}; local server: ${d.localServer ? `${d.localServer.provider} / ${d.localServer.model}` : 'none reachable'}; Perplexity key: ${d.perplexityKey ? 'yes' : 'no'}.`;
        loadClassifierStats();
      } catch (e) { if (state) state.textContent = 'Could not save: ' + e.message; }
    }
    // Agent sandboxes (lib/sandbox): Docker and image state, running containers, defaults, image build as a job.
    // One read-only line: which agents run on the host (sandbox set to "off" on their page), and what the
    // defaults mean in words for agents left on "hub default".
    function sandboxNowText(sbd, toolsDefault) {
      const onHost = (Array.isArray(AGENTS) ? AGENTS : []).filter(a => a && a.sandbox === 'off').map(a => a.name).sort();
      const hands = toolsDefault === 'hub' ? 'hub hands' : 'client tools (Claude/Codex agents)';
      const adminWord = (sbd && sbd.admin) === 'container' ? 'sandboxed' : 'on the host';
      const memberWord = (sbd && sbd.member) === 'off' ? 'on the host' : 'sandboxed';
      return `On the host (no sandbox): ${onHost.length ? onHost.join(', ') : 'none set explicitly'}. New and unspecified agents: ${adminWord}, ${hands}; member-owned: ${memberWord}.`;
    }
    async function loadSandboxStatus() {
      const el = document.getElementById('st-sb-status'); if (!el) return;
      try {
        const d = await (await fetch('/api/sandbox/status', { credentials: 'include' })).json();
        const boxes = (d.containers || []).map(c => `${c.agent} (${c.status})`).join(', ') || 'none';
        el.textContent = d.error ? `Not ready: ${d.error}` : `Ready: Docker up, image ${d.image} built. Containers: ${boxes}.`;
      } catch { el.textContent = 'Could not read the sandbox status.'; }
    }
    async function saveMemberPolicy() {
      const saved = dialogGuard.savePoint(['st-mp-web', 'st-mp-read_outside', 'st-mp-write_outside', 'st-mp-send'].map(id => document.getElementById(id)));
      const state = document.getElementById('st-mp-state');
      const memberPolicy = {};
      for (const k of ['web', 'read_outside', 'write_outside', 'send']) { const v = (document.getElementById(`st-mp-${k}`) || {}).value; if (v) memberPolicy[k] = v; }
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ memberPolicy }) });
        if (r.ok) saved();
        if (state) state.textContent = r.ok ? 'Saved. Applies to member agents from their next tool call.' : `Could not save (HTTP ${r.status})`;
      } catch (e) { if (state) state.textContent = 'Could not save: ' + e.message; }
    }
    async function saveSandboxDefaults() {
      const saved = dialogGuard.savePoint(['st-sb-member', 'st-sb-admin', 'st-tools-default'].map(id => document.getElementById(id)));
      const state = document.getElementById('st-sb-state');
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ sandboxDefaults: { member: document.getElementById('st-sb-member').value, admin: document.getElementById('st-sb-admin').value }, toolsDefault: (document.getElementById('st-tools-default') || {}).value === 'hub' ? 'hub' : 'client' }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        saved();
        if (state) state.textContent = 'Saved. Applies to agents set to "hub default" from their next turn.';
        stSum('agents', 'sb', stSandboxText({ member: document.getElementById('st-sb-member').value, admin: document.getElementById('st-sb-admin').value }));
      } catch (e) { if (state) state.textContent = 'Could not save: ' + e.message; }
    }
    async function buildSandboxImage() {
      const state = document.getElementById('st-sb-state');
      try {
        const r = await (await fetch('/api/sandbox/build', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' })).json();
        if (state) state.textContent = r.ok ? `Building as job ${r.job || ''}; it takes a few minutes. Reload this box afterwards.` : (r.error || 'Build failed to start');
      } catch (e) { if (state) state.textContent = 'Could not start the build: ' + e.message; }
    }
    // Setup checklist (lib/readiness): rendered on the Settings page; the same data feeds the admin banner.
    const READY_ICON = { ok: '✅', info: 'ℹ️', warn: '⚠️', critical: '❌' };
    function readinessActionHtml(a) {
      if (!a) return '';
      if (a.href) return ` <a href="${esc(a.href)}" class="st-test-btn" style="text-decoration:none">${esc(a.label)}</a>`;
      if (a.api) return ` <button class="st-test-btn" onclick="readinessAction('${esc(a.api)}', '${esc(a.method || 'POST')}', this)">${esc(a.label)}</button>`;
      return '';
    }
    function readinessFixHtml(fix) {
      // `code` in the fix text becomes a copyable command
      return esc(String(fix || '')).replace(/`([^`]+)`/g, '<code style="user-select:all;background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px">$1</code>');
    }
    async function loadReadiness() {
      const el = document.getElementById('st-ready-list'); if (!el) return;
      const state = document.getElementById('st-ready-state');
      try {
        const d = await (await fetch('/api/readiness', { credentials: 'include' })).json();
        const order = { critical: 0, warn: 1, info: 2, ok: 3 };
        const items = (d.items || []).slice().sort((a, b) => order[a.level] - order[b.level]);
        el.innerHTML = items.map(i => `<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="flex:0 0 1.4em">${READY_ICON[i.level] || '•'}</span>
          <div style="flex:1"><div style="color:var(--text);font-weight:${i.level === 'ok' ? 400 : 600}">${esc(i.title)}</div>
            <div>${esc(i.detail || '')}</div>${i.fix ? `<div style="margin-top:2px">${readinessFixHtml(i.fix)}${readinessActionHtml(i.action)}</div>` : readinessActionHtml(i.action)}</div></div>`).join('') || 'Nothing to report.';
        if (state) state.textContent = `${d.critical ? `${d.critical} to fix` : 'nothing critical'}${d.warnings ? `, ${d.warnings} warning(s)` : ''}; checked ${new Date(d.checkedAt).toLocaleTimeString()} on ${d.mac ? 'macOS' : d.platform}.`;
        stSum('status', 'setup', d.critical ? `Setup: ${d.critical} to fix` : d.warnings ? `Setup: ${d.warnings} warning${d.warnings === 1 ? '' : 's'}` : 'Setup: all good', !!d.critical);
        if (d.critical) stOpenGroup('status');
      } catch (e) { el.textContent = 'Could not run the checks: ' + e.message; stSum('status', 'setup', 'Setup: could not check'); }
    }
    async function readinessAction(api, method, btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
      try {
        const r = await (await fetch(api, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: method === 'POST' ? '{}' : undefined })).json();
        if (btn) btn.textContent = r.ok ? (r.job ? `Started as job ${r.job}` : 'Done') : (r.error || 'Failed');
        setTimeout(loadReadiness, 4000);
      } catch (e) { if (btn) btn.textContent = 'Failed: ' + e.message; }
    }
    // Banner for admins while anything is critical (no accounts, no provider, members without Docker...).
    async function paintReadinessBanner() {
      const me = window.hubMe;
      let bar = document.getElementById('hub-readiness-notice');
      if (!me || !me.isAdmin || !me.user) { if (bar) bar.remove(); return; }
      let d = null;
      try { d = await (await fetch('/api/readiness', { credentials: 'include' })).json(); } catch { return; }
      const crit = (d && d.items || []).filter(i => i.level === 'critical' && i.id !== 'accounts' && i.id !== 'provider');   // those two have their own banners
      if (!crit.length) { if (bar) bar.remove(); layoutBanners(); return; }
      if (!bar) { bar = document.createElement('div'); bar.id = 'hub-readiness-notice'; bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9996;background:#7a3b12;color:#fff;padding:6px 14px;font-weight:600;box-sizing:border-box'; document.body.prepend(bar); }
      bar.innerHTML = `Setup needs attention: ${crit.map(i => esc(i.title)).join('; ')}. <a href="#" onclick="openSettingsAt('st-ready-section'); return false" style="color:#fff;text-decoration:underline">Open the setup checklist</a>.`;
      layoutBanners();
    }
    // The notices fixed at the top stack in this order, whichever painted first: no AI provider yet, the setup
    // checklist, security. Each one sits below the ones above it, so none covers another (or its X).
    function layoutBanners() {
      let top = 0;
      for (const id of ['hub-setup-notice', 'hub-readiness-notice', 'hub-security-notice']) {
        const n = document.getElementById(id);
        if (!n) continue;
        n.style.top = `${top}px`;
        top += n.offsetHeight || 0;
      }
    }
    // A notice's height can change after it is drawn (the web font arrives, the window narrows and its text wraps).
    window.addEventListener('resize', () => layoutBanners());
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => layoutBanners(), () => {});
    // Security check (lib/security-check): the same rows as the checklist, each tagged with its group; "Run now"
    // runs it fresh, otherwise the last result (nightly or under an hour old) is shown.
    async function loadSecurityCheck(runNow = false) {
      const el = document.getElementById('st-sec-list'); if (!el) return;
      const state = document.getElementById('st-sec-state');
      if (runNow && state) state.textContent = 'Running…';
      try {
        const init = runNow ? { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' } : { credentials: 'include' };
        const d = await (await fetch(runNow ? '/api/security-check/run' : '/api/security-check', init)).json();
        if (!d.ok) throw new Error(d.error || 'failed');
        const order = { critical: 0, warn: 1, info: 2, ok: 3 };
        const items = (d.items || []).slice().sort((a, b) => (order[a.level] - order[b.level]) || String(a.group).localeCompare(String(b.group)));
        el.innerHTML = items.map(i => `<div style="display:flex;gap:8px;align-items:flex-start;padding:5px 0;border-bottom:1px solid var(--border)">
          <span style="flex:0 0 1.4em">${READY_ICON[i.level] || '•'}</span>
          <div style="flex:1"><div style="color:var(--text);font-weight:${i.level === 'ok' ? 400 : 600}">${esc(i.title)} <span style="color:var(--text-dim);font-weight:400;font-size:0.8rem">· ${esc((d.groups || {})[i.group] || i.group)}</span></div>
            <div>${esc(i.detail || '')}</div>${i.fix ? `<div style="margin-top:2px">${readinessFixHtml(i.fix)}${securityActionHtml(i.action)}</div>` : securityActionHtml(i.action)}</div></div>`).join('') || 'Nothing to report.';
        const skipped = (d.skipped || []).length ? ` Not checked here: ${d.skipped.map(s => s.reason).join('; ')}.` : '';
        if (state) state.textContent = `${d.critical ? `${d.critical} critical` : 'nothing critical'}${d.warnings ? `, ${d.warnings} warning(s)` : ''}${d.infos ? `, ${d.infos} note(s)` : ''}; ${d.cached ? 'last run' : 'checked'} ${new Date(d.checkedAt).toLocaleString()}.${skipped}`;
        stSum('status', 'security', d.critical ? `Security: ${d.critical} critical` : d.warnings ? `Security: ${d.warnings} warning${d.warnings === 1 ? '' : 's'}` : 'Security: all good', !!d.critical);
        if (d.critical) stOpenGroup('status');
        paintSecurityBanner().catch(() => {});   // a Run now that resolves or finds something updates the banner at once
      } catch (e) { el.textContent = 'Could not run the security check: ' + e.message; if (state) state.textContent = ''; stSum('status', 'security', 'Security: could not check'); }
    }
    function securityActionHtml(a) {
      if (!a) return '';
      if (a.href) return ` <a href="${esc(a.href)}" class="st-test-btn" style="text-decoration:none">${esc(a.label)}</a>`;
      if (a.api) return ` <button class="st-test-btn" onclick="securityAction('${esc(a.api)}', '${esc(a.method || 'POST')}', this)">${esc(a.label)}</button>`;
      return '';
    }
    async function securityAction(api, method, btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
      try {
        const r = await (await fetch(api, { method, headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: method === 'POST' ? '{}' : undefined })).json();
        if (btn) btn.textContent = r.ok ? (r.fixed ? `Done: ${r.fixed.length} file(s)` : 'Done') : (r.error || 'Failed');
        setTimeout(() => loadSecurityCheck(true), 800);
      } catch (e) { if (btn) btn.textContent = 'Failed: ' + e.message; }
    }
    // Banner for admins from the last security check (below the setup banner when both show).
    // Critical: red, cannot be dismissed; it goes away once the check no longer finds it (Run now, or the next run).
    // Warnings only: dark yellow with an X. Dismissing hides it in this browser until the set of warnings changes:
    // a different set (a new warning, or one fixed and back) shows it again, and a critical finding always does.
    const SEC_DISMISS_KEY = 'hub-security-warn-dismissed';
    let secPaintSeq = 0, secShownSeq = 0;   // paints overlap (page load, the check in Settings): an answer older than the one shown is dropped
    function securityWarnKey(items) { return items.map(i => i.id).sort().join(','); }
    function dismissSecurityBanner() {
      const bar = document.getElementById('hub-security-notice');
      if (!bar || bar.dataset.level !== 'warn') return;   // a critical banner cannot be dismissed
      try { localStorage.setItem(SEC_DISMISS_KEY, bar.dataset.key || ''); } catch {}
      bar.remove();
      layoutBanners();
    }
    async function paintSecurityBanner() {
      const seq = ++secPaintSeq;
      const me = window.hubMe;
      if (!me || !me.isAdmin || !me.user) {
        secShownSeq = seq;   // and no earlier answer still on its way may draw
        const old = document.getElementById('hub-security-notice'); if (old) { old.remove(); layoutBanners(); }
        return;
      }
      let d = null;
      try {
        const r = await fetch('/api/security-check', { credentials: 'include' });
        if (!r.ok) return;   // an error is not "all clear": whatever shows stays
        d = await r.json();
      } catch { return; }
      if (!d || !Array.isArray(d.items)) return;
      if (seq < secShownSeq || window.hubMe !== me) return;   // a newer answer already shows, or the signed-in user changed
      secShownSeq = seq;
      let bar = document.getElementById('hub-security-notice');   // after the wait: it may have gone, or been made
      const items = d.items.filter(i => i.id !== 'accounts');   // no-accounts has its own banner
      const crit = items.filter(i => i.level === 'critical');
      const warn = items.filter(i => i.level === 'warn');
      const key = securityWarnKey(warn);
      let dismissed = ''; try { dismissed = localStorage.getItem(SEC_DISMISS_KEY) || ''; } catch {}
      if (dismissed && dismissed !== key) { dismissed = ''; try { localStorage.removeItem(SEC_DISMISS_KEY); } catch {} }   // the set changed
      if (!crit.length && (!warn.length || dismissed === key)) { if (bar) bar.remove(); layoutBanners(); return; }
      if (!bar) { bar = document.createElement('div'); bar.id = 'hub-security-notice'; document.body.prepend(bar); }
      const level = crit.length ? 'critical' : 'warn';
      bar.dataset.level = level;
      bar.dataset.key = level === 'warn' ? key : '';
      bar.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:9995;background:${level === 'critical' ? '#7a1212' : '#8a6a00'};color:#fff;padding:6px 44px 6px 14px;font-weight:600;box-sizing:border-box`;
      const link = `<a href="#" onclick="openSettingsAt('st-sec-section'); return false" style="color:#fff;text-decoration:underline">Open the security check</a>`;
      bar.innerHTML = level === 'critical'
        ? `Security needs attention: ${crit.map(i => esc(i.title)).join('; ')}. ${link}.`
        : `Security: ${warn.length} warning${warn.length === 1 ? '' : 's'} to review. ${link}.`
          + `<button type="button" class="sec-dismiss" aria-label="Dismiss security warnings" title="Hide until the warnings change" style="position:absolute;right:10px;top:50%;transform:translateY(-50%);background:none;border:0;color:#fff;font-size:20px;line-height:1;cursor:pointer;padding:2px 6px">&times;</button>`;
      const x = bar.querySelector('.sec-dismiss');
      if (x) x.addEventListener('click', () => dismissSecurityBanner());
      layoutBanners();
    }
    // ── Update available (lib/update-check): the server looks at GitHub once a day. While an update waits, admins see
    // a card at the bottom right (Update now / Later) and a chip in the sidebar; the chip stays after Later and brings
    // the card back. "Update now" is the Update dialog's own update and restart, for the current channel. ──
    let ucLast = null;
    async function paintUpdateCard() {
      const me = window.hubMe;
      const chip = document.getElementById('update-chip');
      if (!me || !me.isAdmin) { document.getElementById('hub-update-card')?.remove(); chip?.classList.remove('on'); return; }
      let s;
      try { const r = await fetch('/api/update-check', { credentials: 'include' }); if (!r.ok) return; s = await r.json(); } catch { return; }
      ucLast = s;
      const show = !!(s && s.enabled && s.available);
      if (chip) {
        chip.classList.toggle('on', show);
        chip.classList.toggle('sec', show && !!s.security);
        chip.textContent = show ? `⬇ ${s.latestVersion && s.latestVersion !== s.currentVersion ? s.latestVersion : 'Update'}` : '';
        chip.title = !show ? '' : s.snoozed && s.laterUntil ? `${s.headline}. Card hidden until ${new Date(s.laterUntil).toLocaleString()}: click to see it now` : `${s.headline}: click to update now or later`;
      }
      if (show && !s.snoozed) showUpdateCard();
      else document.getElementById('hub-update-card')?.remove();   // also when Later was pressed on another device
    }
    function showUpdateCard() {
      const s = ucLast;
      if (!s || !s.available) return;
      let card = document.getElementById('hub-update-card');
      if (!card) { card = document.createElement('div'); card.id = 'hub-update-card'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-label', 'Update available'); document.body.appendChild(card); }
      card.classList.toggle('sec', !!s.security);
      card.dataset.remote = s.remote || '';   // Later names the version this card shows
      const busy = busyAgentNames();
      const notes = (s.titles || []).map(t => `<li>${esc(t)}</li>`).join('') + (s.more ? `<li class="uc-more">and ${s.more} more</li>` : '');
      const have = s.latestVersion && s.latestVersion !== s.currentVersion && s.currentVersion ? `You have ${esc(s.currentVersion)}.` : `You're on ${esc(s.channel || s.branch || 'this channel')}.`;
      const warn = s.blocked
        ? `<div class="uc-warn">This hub has ${s.ahead ? `${s.ahead} commit${s.ahead === 1 ? '' : 's'} of its own that GitHub doesn't have` : `${s.dirty} changed file${s.dirty === 1 ? '' : 's'} that ${s.dirty === 1 ? "isn't" : "aren't"} committed`}, so it can't update by itself. Open Details to choose what to do.</div>`
        : busy.length ? `<div class="uc-warn">${busy.length === 1 ? `${esc(agentDisplayName(busy[0]))} is` : `${busy.length} agents are`} working. Updating restarts the hub and cuts ${busy.length === 1 ? 'that reply' : 'those replies'} short.</div>` : '';
      card.innerHTML = `<div class="uc-head">⬇️ ${esc(s.headline || 'An update is ready')}</div>
        <div class="uc-sub">${have}${s.security ? ' <span class="uc-sec">Includes a security fix.</span>' : ''}</div>
        ${notes ? `<div class="uc-label">What's new</div><ul class="uc-notes">${notes}</ul>` : ''}${warn}
        <div class="uc-msg" id="uc-msg"></div>
        <div class="uc-actions">${s.blocked
          ? `<button class="uc-btn" id="uc-later" onclick="updateLater()">Later</button><button class="uc-btn uc-primary" onclick="openGitSync()">Details</button>`
          : `<a href="#" class="uc-details" onclick="openGitSync(); return false">Details…</a><button class="uc-btn" id="uc-later" onclick="updateLater()">Later</button><button class="uc-btn uc-primary" id="uc-now" onclick="updateNow()">Update now</button>`}</div>`;
    }
    async function updateLater() {
      const shown = document.getElementById('hub-update-card')?.dataset.remote || '';
      document.getElementById('hub-update-card')?.remove();
      // Later names the version on the card: a newer one found meanwhile still shows.
      try { const r = await fetch('/api/update-check/later', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remote: shown || (ucLast && ucLast.remote) || null }) }); if (r.ok) ucLast = await r.json(); } catch { /* the card comes back on the next look */ }
    }
    async function updateNow() {
      const now = document.getElementById('uc-now'), later = document.getElementById('uc-later'), msg = document.getElementById('uc-msg');
      // Who is working now, not when the card was drawn: the restart cuts their replies short.
      const busy = busyAgentNames();
      if (busy.length && !confirm(`${busy.map(agentDisplayName).join(', ')} ${busy.length === 1 ? 'is' : 'are'} working. Updating restarts the hub and cuts ${busy.length === 1 ? 'that reply' : 'those replies'} short. Update now anyway?`)) return;
      if (now) { now.disabled = true; now.textContent = 'Updating…'; }
      if (later) later.disabled = true;
      let r;
      try { r = await (await fetch('/api/git-sync/update', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json(); }
      catch (e) { r = { success: false, error: e.message }; }
      if (!r || !r.success) {
        // The Update dialog has the ways out (discard changes, move to a rewritten history): send the admin there.
        if (msg) msg.innerHTML = `<div class="uc-err">The update didn't run: ${esc((r && r.error) || 'unknown error')}</div>`;
        if (now) { now.disabled = false; now.textContent = 'Details'; now.onclick = () => openGitSync(); }
        if (later) later.disabled = false;
        return;
      }
      if (msg) msg.innerHTML = `<div class="uc-ok">✓ Updated. Restarting the hub…</div>`;
      // The Update dialog's own restart: flush the active replies, restart, wait for the new boot.
      const rbtn = document.getElementById('restart-hub-btn');
      let refused = null;
      try { const rr = await fetch('/api/restart', { method: 'POST', credentials: 'include' }); if (!rr.ok) refused = rr.status; } catch { /* expected: the server goes away */ }
      if (refused) { if (msg) msg.innerHTML = `<div class="uc-err">Updated, but the hub refused to restart (HTTP ${refused}). Restart it from the ⋯ menu to finish.</div>`; return; }
      setTimeout(() => pollForRestart(rbtn), 8000);
    }
    // Settings → Status → Updates.
    function ucStateText(s) {
      const when = s.checkedAt ? ` (checked ${new Date(s.checkedAt).toLocaleString()})` : '';
      if (s.error && !s.available) return `Could not check: ${s.error}${when}`;
      if (s.available) return `${s.headline}${s.snoozed && s.laterUntil ? `; card hidden until ${new Date(s.laterUntil).toLocaleString()}` : ''}${when}`;
      return s.checkedAt ? `Up to date${s.currentVersion ? ` on ${s.currentVersion}` : ''}${when}` : 'Not checked yet';
    }
    async function loadUpdateCheck(s) {
      const box = document.getElementById('st-uc-on'), state = document.getElementById('st-uc-state');
      if (!box) return;
      try { if (!s) s = await (await fetch('/api/update-check', { credentials: 'include' })).json(); }
      catch (e) { if (state) state.textContent = 'Could not read: ' + e.message; return; }
      box.checked = s.enabled !== false;
      if (state) state.textContent = ucStateText(s);
      stSum('status', 'updates', s.enabled === false ? 'Update check off' : s.available ? 'Update available' : 'Up to date');
    }
    async function saveUpdateCheck(on) {
      const state = document.getElementById('st-uc-state');
      try {
        const r = await fetch('/api/update-check/settings', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !!on }) });
        const s = await r.json();
        if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
        loadUpdateCheck(s);
        paintUpdateCard().catch(() => {});
      } catch (e) { if (state) state.textContent = 'Not saved: ' + e.message; }
    }
    async function checkUpdatesNow(btn) {
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      try {
        const s = await (await fetch('/api/update-check/now', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
        loadUpdateCheck(s);
        paintUpdateCard().catch(() => {});
      } catch (e) { const st = document.getElementById('st-uc-state'); if (st) st.textContent = 'Could not check: ' + e.message; }
      if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
    }
    // Web search and fetch (lib/web-search, lib/web-fetch): backend chain, keys, SearXNG container, fetch guards.
    async function loadWebSearchStatus() {
      const el = document.getElementById('st-ws-status'); if (!el) return;
      try {
        const d = await (await fetch('/api/websearch/status', { credentials: 'include' })).json();
        const s = d.search || {}, f = d.fetch || {};
        const chain = (s.chain || []).join(' → ') || 'none';
        stSum('tools', 'search', `Search: ${chain}`);
        const off = (s.backends || []).filter(b => !b.configured).map(b => `${b.id} (needs ${b.needs})`).join(', ');
        const sx = s.searxng || {};
        const sxState = sx.container ? `container ${sx.name} ${sx.container}${sx.healthy ? ', healthy' : ', not answering'}` : sx.url ? (sx.healthy ? `external at ${sx.url}, healthy` : `${sx.url} not answering`) : 'not running';
        el.textContent = `Search chain now: ${chain}.${off ? ` Not configured: ${off}.` : ''} SearXNG: ${sxState}. Fetch: private addresses ${f.allowPrivate}, browser rendering ${f.render}${f.renderer ? ' (Firefox available)' : ' (no Playwright Firefox found: rendering unavailable)'}, PDF ${f.pdftotext ? 'yes' : 'no (install poppler-utils)'}, cache ${f.cacheMinutes} min.`;
      } catch { el.textContent = 'Could not read the web search status.'; }
    }
    async function saveWebSearch() {
      const saved = dialogGuard.savePoint(['st-ws-key-brave', 'st-ws-key-serper', 'st-ws-key-tavily', 'st-ws-order', 'st-ws-searxng', 'st-wf-private', 'st-wf-render', 'st-wf-jina'].map(id => document.getElementById(id)));
      const state = document.getElementById('st-ws-state');
      const keys = {}, sent = {};   // sent: each key field as it was when Save was pressed
      for (const k of ['brave', 'serper', 'tavily']) { const v = (document.getElementById(`st-ws-key-${k}`) || {}).value || ''; if (v.trim()) { keys[k] = v.trim(); sent[k] = v; } }
      const body = {
        order: (document.getElementById('st-ws-order').value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
        keys,
        searxng: { url: document.getElementById('st-ws-searxng').value || '' },
        fetch: { allowPrivate: document.getElementById('st-wf-private').value, render: document.getElementById('st-wf-render').value, jina: document.getElementById('st-wf-jina').checked },
      };
      try {
        const r = await (await fetch('/api/websearch/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify(body) })).json();
        if (state) state.textContent = r.ok ? 'Saved. Applies to the next search or fetch.' : (r.error || 'Could not save');
        if (r.ok) {
          saved();
          // A saved key is not shown again: its field empties and says "set". A field changed while the save ran keeps
          // the newer key (not saved yet); after a failed save every typed key stays, to try again.
          for (const [k, v] of Object.entries(sent)) { const inp = document.getElementById(`st-ws-key-${k}`); if (inp && inp.value === v) { inp.placeholder = 'set'; inp.value = ''; dialogGuard.markLoaded(inp); } }
        }
        loadWebSearchStatus();
      } catch (e) { if (state) state.textContent = 'Could not save: ' + e.message; }
    }
    async function tryWebSearch() {
      const out = document.getElementById('st-ws-result'); if (!out) return;
      const query = (document.getElementById('st-ws-try').value || '').trim(); if (!query) return;
      const backend = document.getElementById('st-ws-try-backend').value || undefined;
      out.textContent = 'Searching…';
      try {
        const r = await (await fetch('/api/websearch/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ query, backend, maxResults: 5 }) })).json();
        out.textContent = `${r.ms != null ? `${r.ms} ms. ` : ''}${r.rendered || r.error || ''}`;
      } catch (e) { out.textContent = 'Search failed: ' + e.message; }
    }
    async function tryWebFetch() {
      const out = document.getElementById('st-ws-result'); if (!out) return;
      const url = (document.getElementById('st-wf-try').value || '').trim(); if (!url) return;
      out.textContent = 'Fetching…';
      try {
        const r = await (await fetch('/api/websearch/fetch-test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ url, render: document.getElementById('st-wf-try-render').checked }) })).json();
        out.textContent = r.ok ? `${r.title ? r.title + '\n' : ''}[${r.via}${r.cached ? ', cached' : ''}; ${r.length} chars${r.finalUrl && r.finalUrl !== url ? `; from ${r.finalUrl}` : ''}]\n\n${r.markdown}` : `Fetch refused or failed: ${r.error}`;
      } catch (e) { out.textContent = 'Fetch failed: ' + e.message; }
    }
    async function searxngStart() {
      const state = document.getElementById('st-ws-state');
      try {
        const r = await (await fetch('/api/websearch/searxng/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' })).json();
        if (state) state.textContent = r.ok ? `Starting SearXNG as job ${r.job || ''} at ${r.url}; the first run pulls the image (a minute or two). Reload this box afterwards.` : (r.error || 'Could not start');
        const inp = document.getElementById('st-ws-searxng'); if (inp && r.url) inp.value = r.url;
      } catch (e) { if (state) state.textContent = 'Could not start SearXNG: ' + e.message; }
    }
    async function searxngStop() {
      const state = document.getElementById('st-ws-state');
      try {
        const r = await (await fetch('/api/websearch/searxng/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: '{}' })).json();
        if (state) state.textContent = r.ok ? 'SearXNG container removed.' : 'No SearXNG container to stop.';
        loadWebSearchStatus();
      } catch (e) { if (state) state.textContent = 'Could not stop SearXNG: ' + e.message; }
    }
    async function loadClassifierStats() {
      const el = document.getElementById('st-cl-stats'); if (!el) return;
      try {
        const d = await (await fetch('/api/auto-model/classifier', { credentials: 'include' })).json();
        const by = Object.entries(d.byBackend || {}).map(([k, n]) => `${k} ×${n}`).join(', ') || 'none yet';
        el.textContent = `Since ${new Date(d.since).toLocaleString()}: ${d.turns} classified turn(s)${d.shadow ? `, ${d.shadow} in shadow` : ''}; agreed with the keyword rule ${d.agree}, disagreed ${d.disagree}; floored ${d.floored}, lifted to a minimum ${d.lifted}. Backends: ${by}. Local server now: ${d.localServer ? `${d.localServer.provider} / ${d.localServer.model}` : 'none reachable'}.`;
        // Recent verdicts, newest first: time, agent, what the classifier said (and the keyword rule), the model it
        // would pick, the model that ran, backend and timing. The owner reads this to judge a shadow week.
        const rec = document.getElementById('st-cl-recent');
        if (rec) {
          const rows = (d.recent || []).slice(0, 30);
          const short = (m) => String(m || '').split('/').pop() || '-';
          const pad = (v, n) => String(v == null ? '' : v).padEnd(n).slice(0, n);
          rec.textContent = rows.length ? ['time     agent        verdict    keyword    would pick        ran               via', ...rows.map(r => {
            const t = new Date(r.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
            const via = `${String(r.backend || '').replace(/^local:/, 'local ').replace(/^perplexity:.*/, 'perplexity')}${r.confidence != null ? ` ${Number(r.confidence).toFixed(2)}` : ''}${r.ms != null ? ` ${r.ms}ms` : ''}${r.shadow ? ' shadow' : r.applied ? '' : ' not applied'}${r.reason ? ` (${r.reason})` : ''}`;
            return `${pad(t, 9)}${pad(r.agent || '-', 13)}${pad(r.category, 11)}${pad(r.builtinCategory || '-', 11)}${pad(short(r.wouldPick), 18)}${pad(short(r.ran), 18)}${via}`;
          })].join('\n') : '';
        }
      } catch { el.textContent = ''; }
    }
    async function tryClassifier() {
      const text = (document.getElementById('st-cl-try') || {}).value || ''; const out = document.getElementById('st-cl-result');
      if (!text.trim() || !out) return;
      out.textContent = 'Classifying…';
      try {
        const d = await (await fetch('/api/auto-model/classify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ text }) })).json();
        const line = (name, r) => r.error ? `${name}: failed (${r.error})` : r.skipped ? `${name}: skipped (${r.skipped})` : `${name}: ${r.category}${r.confidence != null ? ` (confidence ${Number(r.confidence).toFixed(2)})` : ''} → ${r.model}${r.ms != null ? `  [${r.ms} ms]` : ''}`;
        out.textContent = [line('keyword rule', d.builtin), line('local model', d.local || { error: 'not run' }), line('Perplexity decider', d.perplexity || { error: 'not run' })].join('\n');
      } catch (e) { out.textContent = 'Failed: ' + e.message; }
    }

    // ── Data connectors (Settings box) ──────────────────────────────────────────────────────────
    // Outside services (MCP servers the hub starts, or wrapped built-in skills) plugged in as data.
    // Admin-only API under /api/connectors and /api/connector-groups. The box keeps its state in
    // cxState and repaints its three parts (groups, list, form) separately so a connectors_changed
    // event can refresh the lists without wiping a form being edited.
    const cxState = { data: null, skills: null, tests: {}, form: null, groupForm: false, loadTimer: 0 };
    const CX_CLASSES = ['read', 'write', 'send'];
    function cxStatus(text, isError) {
      const el = document.getElementById('st-cx-status');
      if (!el) return;
      el.textContent = text || '';
      el.style.color = isError ? 'var(--error)' : 'var(--text-dim)';
    }
    async function cxApi(path, method, body) {
      const r = await fetch(path, { method: method || 'GET', headers: body ? { 'Content-Type': 'application/json' } : undefined, credentials: 'include', body: body ? JSON.stringify(body) : undefined });
      let d = {};
      try { d = await r.json(); } catch {}
      if (!r.ok || d.error) throw new Error(d.error || (r.status === 403 ? 'admin only' : `HTTP ${r.status}`));
      return d;
    }
    // Reads a passphrase input and clears it at once: passphrases are never kept in the DOM after use.
    function cxTakePass(id) {
      const el = document.getElementById(id);
      if (!el) return '';
      const v = el.value;
      el.value = '';
      return v;
    }
    async function loadConnectors() {
      if (!document.getElementById('st-cx-section')) return;
      try {
        cxState.data = await cxApi('/api/connectors');
        cxStatus('');
        const n = ((cxState.data && cxState.data.connectors) || []).length;
        stSum('tools', 'cx', `${n} data connector${n === 1 ? '' : 's'}`);
      } catch (e) {
        cxState.data = { connectors: [], groups: [] };
        cxStatus('Could not load connectors: ' + e.message, true);
      }
      renderConnectorsBox();
    }
    function renderConnectorsBox() {
      renderConnectorGroups();
      renderConnectorList();
      if (cxState.form) renderConnectorForm(); else if (cxState.groupForm) renderGroupForm(); else { const f = document.getElementById('st-cx-form'); if (f) f.innerHTML = ''; }
    }
    function cxBadge(text, color) {
      return `<span class="cx-badge" style="${color ? `color:${color};border-color:${color}` : ''}">${hubEsc(text)}</span>`;
    }
    function cxWhen(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      return isNaN(d) ? String(ts) : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    function renderConnectorGroups() {
      const box = document.getElementById('st-cx-groups');
      if (!box) return;
      const groups = (cxState.data && cxState.data.groups) || [];
      if (!groups.length) { box.innerHTML = '<div class="st-hint" style="margin-left:0">No groups yet. A group holds one passphrase for several connectors.</div>'; return; }
      box.innerHTML = groups.map(g => {
        const members = Array.isArray(g.connectors) && g.connectors.length ? g.connectors.map(hubEsc).join(', ') : 'no connectors';
        const act = g.unlocked
          ? `<button class="st-test-btn" onclick="cxGroupLock('${hubEsc(g.id)}')">Lock</button>`
          : `<input type="password" id="st-cx-gpass-${hubEsc(g.id)}" placeholder="passphrase" autocomplete="off" style="max-width:160px" onkeydown="if(event.key==='Enter')cxGroupUnlock('${hubEsc(g.id)}')"><button class="st-test-btn" onclick="cxGroupUnlock('${hubEsc(g.id)}')">Unlock</button>`;
        return `<div class="cx-row">
          <div class="cx-main"><strong>${hubEsc(g.label || g.id)}</strong> <span class="cx-id">(${hubEsc(g.id)})</span> ${g.unlocked ? cxBadge('unlocked' + (g.unlockedSince ? ' since ' + cxWhen(g.unlockedSince) : ''), 'var(--success)') : cxBadge('locked')}<div class="cx-sub">group · ${members}</div></div>
          <div class="cx-actions">${act}<input type="password" id="st-cx-gdel-${hubEsc(g.id)}" placeholder="passphrase to delete" autocomplete="off" style="max-width:150px"><button class="st-test-btn" onclick="cxGroupDelete('${hubEsc(g.id)}')">Delete</button></div>
        </div>`;
      }).join('');
    }
    function renderConnectorList() {
      const box = document.getElementById('st-cx-list');
      if (!box) return;
      const list = (cxState.data && cxState.data.connectors) || [];
      if (!list.length) { box.innerHTML = '<div class="st-hint" style="margin-left:0">No connectors yet.</div>'; return; }
      box.innerHTML = list.map(c => {
        const id = hubEsc(c.id);
        const badges = [
          c.enabled === false ? cxBadge('disabled', 'var(--warning)') : cxBadge('enabled', 'var(--success)'),
          c.protect && c.protect !== 'none' ? (c.unlocked ? cxBadge('unlocked', 'var(--success)') : cxBadge('locked', 'var(--warning)')) : cxBadge('always on'),
          c.running ? cxBadge('running', 'var(--success)') : '',
          c.toolCount != null ? cxBadge(`${c.toolCount} tool${c.toolCount === 1 ? '' : 's'}`) : '',
          c.sensitive ? cxBadge('sensitive', 'var(--purple)') : '',
        ].join(' ');
        const agents = Array.isArray(c.agents) ? (c.agents.length ? c.agents.map(hubEsc).join(', ') : 'no agents') : 'all agents';
        const protect = c.protect === 'own' ? 'own passphrase' : c.protect === 'group' ? `group ${hubEsc(c.group || '?')}` : 'no passphrase';
        const what = c.kind === 'skill' ? `skill ${hubEsc(c.skillId || '?')}` : `mcp ${hubEsc(c.command || '')}${Array.isArray(c.args) && c.args.length ? ' ' + hubEsc(c.args.join(' ')) : (typeof c.args === 'string' && c.args ? ' ' + hubEsc(c.args) : '')}`;
        const errObj = c.lastError && typeof c.lastError === 'object' ? c.lastError : null;
        const errText = errObj ? (errObj.message || errObj.error || JSON.stringify(errObj)) : (c.lastError ? String(c.lastError) : '');
        const errAt = cxWhen(errObj ? (errObj.at || errObj.ts) : c.lastErrorAt);
        const last = (errText ? `<span style="color:var(--accent)">last error${errAt ? ' ' + hubEsc(errAt) : ''}: ${hubEsc(errText)}</span>` : '')
          + (c.lastOk ? `${errText ? ' · ' : ''}last ok ${hubEsc(cxWhen(c.lastOk))}` : '');
        const lockBtn = !c.protect || c.protect === 'none' ? ''
          : c.unlocked ? `<button class="st-test-btn" onclick="cxLock('${id}')">Lock</button>`
            : `<input type="password" id="st-cx-pass-${id}" placeholder="passphrase" autocomplete="off" style="max-width:140px" onkeydown="if(event.key==='Enter')cxUnlock('${id}')"><button class="st-test-btn" onclick="cxUnlock('${id}')">Unlock</button>`;
        const tested = cxState.tests[c.id];
        const tools = tested ? `<div class="cx-tools">${tested.length ? tested.map(t => `<div><code>${hubEsc(t.name)}</code> ${cxBadge(t.cls || 'read')} <span style="color:var(--text-dim)">${hubEsc(t.description || '')}</span></div>`).join('') : 'no tools reported'}</div>` : '';
        return `<div class="cx-row" id="st-cx-row-${id}">
          <div class="cx-main"><strong>${hubEsc(c.label || c.id)}</strong> <span class="cx-id">(${id})</span> ${badges}
            <div class="cx-sub">${what} · ${agents} · ${protect}</div>
            ${last ? `<div class="cx-sub">${last}</div>` : ''}
            ${tools}
          </div>
          <div class="cx-actions">
            <button class="st-test-btn" onclick="cxEdit('${id}')">Edit</button>
            <button class="st-test-btn" id="st-cx-test-${id}" onclick="cxTest('${id}')">Test</button>
            ${lockBtn}
            <button class="st-test-btn" onclick="cxToggle('${id}', ${c.enabled === false ? 'true' : 'false'})">${c.enabled === false ? 'Enable' : 'Disable'}</button>
            <button class="st-test-btn" onclick="cxDelete('${id}')">Delete</button>
          </div>
        </div>`;
      }).join('');
    }
    function cxFind(id) { return ((cxState.data && cxState.data.connectors) || []).find(c => c.id === id) || null; }
    async function cxAction(label, fn) {
      cxStatus(label + '…');
      try { await fn(); cxStatus(''); await loadConnectors(); }
      catch (e) { cxStatus(`${label} failed: ${e.message}`, true); }
    }
    function cxUnlock(id) {
      const passphrase = cxTakePass(`st-cx-pass-${id}`);
      if (!passphrase) { cxStatus('Type the passphrase first.', true); return; }
      return cxAction(`Unlocking ${id}`, () => cxApi(`/api/connectors/${encodeURIComponent(id)}/unlock`, 'POST', { passphrase }));
    }
    function cxLock(id) { return cxAction(`Locking ${id}`, () => cxApi(`/api/connectors/${encodeURIComponent(id)}/lock`, 'POST', {})); }
    function cxLockAll() { return cxAction('Locking everything', () => cxApi('/api/connectors/lock-all', 'POST', {})); }
    function cxToggle(id, enabled) {
      const c = cxFind(id);
      if (!c) return;
      return cxAction(`${enabled ? 'Enabling' : 'Disabling'} ${id}`, () => cxApi('/api/connectors', 'POST', { id, enabled: !!enabled }));
    }
    function cxDelete(id) {
      if (!confirm(`Delete connector "${id}"? Its secrets go with it; files in its data folder stay.`)) return;
      if (cxState.form && cxState.form.id === id) cxState.form = null;
      return cxAction(`Deleting ${id}`, () => cxApi(`/api/connectors/${encodeURIComponent(id)}`, 'DELETE'));
    }
    async function cxTest(id) {
      const btn = document.getElementById(`st-cx-test-${id}`);
      if (btn) { btn.disabled = true; btn.textContent = 'Testing…'; btn.className = 'st-test-btn'; }
      try {
        const d = await cxApi(`/api/connectors/${encodeURIComponent(id)}/test`, 'POST', {});
        cxState.tests[id] = Array.isArray(d.tools) ? d.tools : [];
        cxStatus(`${id}: ${cxState.tests[id].length} tool(s) discovered.`);
        if (btn) { btn.className = 'st-test-btn ok'; btn.textContent = 'OK'; }
      } catch (e) {
        cxStatus(`Test of ${id} failed: ${e.message}`, true);
        if (btn) { btn.className = 'st-test-btn fail'; btn.textContent = 'Failed'; }
      }
      await loadConnectors();
      if (cxState.form && cxState.form.id === id) renderConnectorForm();
    }
    function cxGroupUnlock(id) {
      const passphrase = cxTakePass(`st-cx-gpass-${id}`);
      if (!passphrase) { cxStatus('Type the group passphrase first.', true); return; }
      return cxAction(`Unlocking group ${id}`, () => cxApi(`/api/connector-groups/${encodeURIComponent(id)}/unlock`, 'POST', { passphrase }));
    }
    function cxGroupLock(id) { return cxAction(`Locking group ${id}`, () => cxApi(`/api/connector-groups/${encodeURIComponent(id)}/lock`, 'POST', {})); }
    function cxGroupDelete(id) {
      const passphrase = cxTakePass(`st-cx-gdel-${id}`);
      if (!passphrase) { cxStatus('Deleting a group needs its passphrase.', true); return; }
      if (!confirm(`Delete group "${id}"? Connectors in it keep their settings but lose the group lock.`)) return;
      return cxAction(`Deleting group ${id}`, () => cxApi(`/api/connector-groups/${encodeURIComponent(id)}`, 'DELETE', { passphrase }));
    }
    function cxGroupNewForm() {
      cxState.form = null;
      cxState.groupForm = true;
      renderGroupForm();
    }
    function renderGroupForm() {
      const box = document.getElementById('st-cx-form');
      if (!box) return;
      box.innerHTML = `<div class="cx-form">
        <div class="cx-form-title">New group</div>
        <div class="st-row"><label style="flex-basis:150px">Id</label><input type="text" id="st-cx-g-id" placeholder="medical" style="max-width:200px"></div>
        <div class="st-row"><label style="flex-basis:150px">Label</label><input type="text" id="st-cx-g-label" placeholder="Medical records" style="max-width:300px"></div>
        <div class="st-row"><label style="flex-basis:150px">Passphrase</label><input type="password" id="st-cx-g-pass" autocomplete="new-password" style="max-width:220px"></div>
        <div class="st-row"><label style="flex-basis:150px">Passphrase again</label><input type="password" id="st-cx-g-pass2" autocomplete="new-password" style="max-width:220px"></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="cxGroupCreate()">Create group</button><button class="st-test-btn" onclick="cxCancel()">Cancel</button><span id="st-cx-form-err" style="font-size:0.78rem;color:var(--error);margin-left:8px"></span></div>
      </div>`;
    }
    async function cxGroupCreate() {
      const v = id => ((document.getElementById(id) || {}).value || '').trim();
      const err = document.getElementById('st-cx-form-err');
      const id = v('st-cx-g-id'), label = v('st-cx-g-label');
      const pass = cxTakePass('st-cx-g-pass'), pass2 = cxTakePass('st-cx-g-pass2');
      const fail = (m) => { if (err) err.textContent = m; };
      if (!id) return fail('A group id is needed.');
      if (!pass) return fail('A passphrase is needed.');
      if (pass !== pass2) return fail('The two passphrases differ.');
      try {
        await cxApi('/api/connector-groups', 'POST', { id, label: label || id, passphrase: pass });
        cxState.groupForm = false;
        cxStatus(`Group ${id} created.`);
        await loadConnectors();
      } catch (e) { fail(e.message); }
    }
    function cxCancel() {
      cxState.form = null;
      cxState.groupForm = false;
      const box = document.getElementById('st-cx-form');
      if (box) box.innerHTML = '';
    }
    async function cxLoadPickers() {
      if (!cxState.skills) {
        try { const d = await cxApi('/api/skills'); cxState.skills = d.skills || {}; } catch { cxState.skills = {}; }
      }
      if (!Array.isArray(AGENTS) || !AGENTS.length) {
        try { const d = await cxApi('/api/agents'); if (Array.isArray(d.agents)) AGENTS = d.agents; } catch {}
      }
    }
    function cxNew() {
      cxState.groupForm = false;
      cxState.form = { id: null, orig: null, draft: { kind: 'mcp', protect: 'none', agents: null, enabled: true, sensitive: false, tools: {} }, addSecrets: 1 };
      cxLoadPickers().then(renderConnectorForm);
    }
    function cxEdit(id) {
      const c = cxFind(id);
      if (!c) return;
      cxState.groupForm = false;
      cxState.form = { id, orig: c, draft: JSON.parse(JSON.stringify(c)), addSecrets: 1 };
      cxLoadPickers().then(renderConnectorForm);
    }
    // One form for New and Edit. The draft is read back from the inputs on save; kind/protect
    // changes only toggle which rows show.
    function renderConnectorForm() {
      const box = document.getElementById('st-cx-form');
      const f = cxState.form;
      if (!box || !f) return;
      const c = f.draft || {};
      const editing = !!f.id;
      const L = (t) => `<label style="flex-basis:150px">${t}</label>`;
      const sel = (id, opts, cur, extra) => `<select id="${id}" style="padding:4px" ${extra || ''}>${opts.map(([v, l]) => `<option value="${hubEsc(v)}" ${cur === v ? 'selected' : ''}>${hubEsc(l)}</option>`).join('')}</select>`;
      const skills = Object.entries(cxState.skills || {}).map(([sid, s]) => [sid, `${(s && s.label) || sid} (${sid})`]);
      const groups = ((cxState.data && cxState.data.groups) || []).map(g => [g.id, `${g.label || g.id} (${g.id})`]);
      const agentNames = (Array.isArray(AGENTS) ? AGENTS : []).map(a => a && (a.name || a.id)).filter(Boolean);
      const grantAll = !Array.isArray(c.agents);
      const granted = new Set(Array.isArray(c.agents) ? c.agents : []);
      const argsText = Array.isArray(c.args) ? c.args.join(' ') : (c.args || '');
      const secretNames = Array.isArray(c.secretNames) ? c.secretNames : [];
      const toolsKnown = cxState.tests[f.id] || null;
      const savedTools = c.tools && typeof c.tools === 'object' ? c.tools : {};
      const toolRows = toolsKnown ? toolsKnown.map(t => ({ name: t.name, detected: t.cls || 'read', cls: (savedTools[t.name] && savedTools[t.name].cls) || t.cls || 'read', description: t.description || '' }))
        : Object.entries(savedTools).map(([name, t]) => ({ name, detected: '', cls: (t && t.cls) || 'read', description: '' }));
      const toolsHtml = toolRows.length
        ? `<table class="cx-table"><thead><tr><th>tool</th><th>detected</th><th>class</th></tr></thead><tbody>${toolRows.map(t => `<tr><td><code>${hubEsc(t.name)}</code>${t.description ? `<div class="cx-sub">${hubEsc(t.description)}</div>` : ''}</td><td>${hubEsc(t.detected || '-')}</td><td>${sel('', CX_CLASSES.map(x => [x, x]), t.cls, `data-cx-tool="${hubEsc(t.name)}"`)}</td></tr>`).join('')}</tbody></table>`
        : `<div class="cx-sub">${editing ? 'No tools known yet: press Test to discover them.' : 'Save first, then Test to discover the tools and set their classes.'}</div>`;
      box.innerHTML = `<div class="cx-form">
        <div class="cx-form-title">${editing ? `Edit connector ${hubEsc(f.id)}` : 'New connector'}</div>
        <div class="st-row">${L('Id')}<input type="text" id="st-cx-f-id" value="${hubEsc(c.id || '')}" placeholder="mychart" style="max-width:200px" ${editing ? 'readonly' : ''}></div>
        <div class="st-row">${L('Label')}<input type="text" id="st-cx-f-label" value="${hubEsc(c.label || '')}" placeholder="MyChart (patient portal)"></div>
        <div class="st-row">${L('Kind')}${sel('st-cx-f-kind', [['mcp', 'mcp: a stdio MCP server the hub starts'], ['skill', 'skill: a built-in skill']], c.kind === 'skill' ? 'skill' : 'mcp', 'onchange="cxFormKindChange()"')}</div>
        <div id="st-cx-f-mcp">
          <div class="st-row">${L('Command')}<input type="text" id="st-cx-f-command" value="${hubEsc(c.command || '')}" placeholder="npx"></div>
          <div class="st-row">${L('Args')}<input type="text" id="st-cx-f-args" value="${hubEsc(argsText)}" placeholder="-y @some/mcp-server --flag"></div>
          <div class="st-hint" style="margin-left:158px">Arguments separated by spaces; quote with "double quotes" when one holds a space.</div>
        </div>
        <div id="st-cx-f-skill">
          <div class="st-row">${L('Skill')}${skills.length ? sel('st-cx-f-skillId', skills, c.skillId || skills[0][0]) : `<input type="text" id="st-cx-f-skillId" value="${hubEsc(c.skillId || '')}" placeholder="skill id">`}</div>
        </div>
        <div class="st-row">${L('Agents')}<label style="flex:0 0 auto;text-align:left"><input type="checkbox" id="st-cx-f-all" ${grantAll ? 'checked' : ''} onchange="cxFormAgentsChange()"> all agents</label></div>
        <div id="st-cx-f-agents" class="cx-checks" style="${grantAll ? 'display:none' : ''}">${agentNames.length ? agentNames.map(n => `<label><input type="checkbox" data-cx-agent="${hubEsc(n)}" ${granted.has(n) ? 'checked' : ''}> ${hubEsc(n)}</label>`).join('') : '<span class="cx-sub">no agents loaded</span>'}</div>
        <div class="st-row">${L('Protect')}${sel('st-cx-f-protect', [['none', 'none: always on'], ['own', 'own passphrase'], ['group', 'group passphrase']], c.protect || 'none', 'onchange="cxFormProtectChange()"')}<span id="st-cx-f-group-wrap">${groups.length ? sel('st-cx-f-group', groups, c.group || groups[0][0], 'onchange="cxFormProtectChange()"') : '<span class="cx-sub">no groups yet</span>'}</span></div>
        <div class="st-row" id="st-cx-f-curpass-row">${L('Current passphrase')}<input type="password" id="st-cx-f-curpass" autocomplete="off" style="max-width:220px"><span class="cx-sub">needed to change how a protected connector is locked</span></div>
        <div id="st-cx-f-newpass-rows">
          <div class="st-row">${L('New passphrase')}<input type="password" id="st-cx-f-newpass" autocomplete="new-password" style="max-width:220px"><span class="cx-sub">${editing && c.protect === 'own' ? 'leave blank to keep the current one' : ''}</span></div>
          <div class="st-row">${L('Repeat')}<input type="password" id="st-cx-f-newpass2" autocomplete="new-password" style="max-width:220px"></div>
        </div>
        <div class="st-row">${L('Sensitive')}<label style="flex:0 0 auto;text-align:left"><input type="checkbox" id="st-cx-f-sensitive" ${c.sensitive ? 'checked' : ''}> reads need the owner's policy nod</label></div>
        <div class="st-row">${L('Data folder')}<input type="text" id="st-cx-f-dataHome" value="${hubEsc(c.dataHome || '')}" placeholder="(hub default)"></div>
        <div class="st-row">${L('Notes')}<textarea id="st-cx-f-notes" rows="2" style="flex:1;padding:6px 10px;font-size:0.8rem;background:var(--bg-input);border:1px solid var(--border);border-radius:4px;color:var(--text)">${hubEsc(c.notes || '')}</textarea></div>
        <div class="st-row" style="align-items:flex-start">${L('Secrets')}<div style="flex:1" id="st-cx-f-secrets">
          ${secretNames.length ? secretNames.map(n => `<label class="cx-secret"><code>${hubEsc(n)}</code> <span class="cx-sub">(set)</span> <input type="checkbox" data-cx-secret-remove="${hubEsc(n)}"> remove</label>`).join('') : '<div class="cx-sub">none saved</div>'}
          <div id="st-cx-f-secret-rows">${Array.from({ length: f.addSecrets || 1 }).map(() => cxSecretRowHtml()).join('')}</div>
          <button class="st-test-btn" onclick="cxAddSecretRow()">+ another secret</button>
          <div class="cx-sub">Values are write-only: they are never shown back. Saving secrets needs the connector unlocked.</div>
        </div></div>
        <div class="st-row" style="align-items:flex-start">${L('Tools')}<div style="flex:1" id="st-cx-f-tools">${toolsHtml}</div></div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" id="st-cx-f-save" onclick="cxSave()">${editing ? 'Save' : 'Create'}</button>${editing ? `<button class="st-test-btn" onclick="cxTest('${hubEsc(f.id)}')">Test</button>` : ''}<button class="st-test-btn" onclick="cxCancel()">Cancel</button><span id="st-cx-form-err" style="font-size:0.78rem;color:var(--error);margin-left:8px"></span></div>
      </div>`;
      cxFormKindChange();
      cxFormProtectChange();
    }
    function cxSecretRowHtml() {
      return `<div class="cx-secret-row"><input type="text" class="cx-secret-name" placeholder="NAME" style="max-width:160px;font-family:ui-monospace,monospace"><span>=</span><input type="password" class="cx-secret-value" placeholder="value" autocomplete="new-password"></div>`;
    }
    function cxAddSecretRow() {
      const rows = document.getElementById('st-cx-f-secret-rows');
      if (!rows) return;
      rows.insertAdjacentHTML('beforeend', cxSecretRowHtml());
      if (cxState.form) cxState.form.addSecrets = rows.children.length;
    }
    function cxFormKindChange() {
      const kind = (document.getElementById('st-cx-f-kind') || {}).value || 'mcp';
      const mcp = document.getElementById('st-cx-f-mcp'), skill = document.getElementById('st-cx-f-skill');
      if (mcp) mcp.style.display = kind === 'mcp' ? '' : 'none';
      if (skill) skill.style.display = kind === 'skill' ? '' : 'none';
    }
    function cxFormAgentsChange() {
      const all = !!(document.getElementById('st-cx-f-all') || {}).checked;
      const list = document.getElementById('st-cx-f-agents');
      if (list) list.style.display = all ? 'none' : '';
    }
    function cxFormProtectChange() {
      const f = cxState.form;
      if (!f) return;
      const protect = (document.getElementById('st-cx-f-protect') || {}).value || 'none';
      const group = (document.getElementById('st-cx-f-group') || {}).value || '';
      const gw = document.getElementById('st-cx-f-group-wrap');
      if (gw) gw.style.display = protect === 'group' ? '' : 'none';
      const orig = f.orig || {};
      const wasProtected = !!(f.id && orig.protect && orig.protect !== 'none');
      const changing = wasProtected && (protect !== orig.protect || (protect === 'group' && group !== (orig.group || '')));
      const cur = document.getElementById('st-cx-f-curpass-row');
      if (cur) cur.style.display = changing ? '' : 'none';
      const np = document.getElementById('st-cx-f-newpass-rows');
      if (np) np.style.display = protect === 'own' ? '' : 'none';
    }
    function cxParseArgs(text) {
      const out = [];
      const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
      let m;
      while ((m = re.exec(text || ''))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
      return out;
    }
    async function cxSave() {
      const f = cxState.form;
      if (!f) return;
      const v = id => ((document.getElementById(id) || {}).value || '');
      const chk = id => !!(document.getElementById(id) || {}).checked;
      const err = document.getElementById('st-cx-form-err');
      const fail = (m) => { if (err) err.textContent = m; };
      if (err) err.textContent = '';
      const id = (f.id || v('st-cx-f-id')).trim();
      if (!id) return fail('A connector id is needed.');
      if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) return fail('Id: letters, digits, - and _ only.');
      const kind = v('st-cx-f-kind') === 'skill' ? 'skill' : 'mcp';
      const protect = v('st-cx-f-protect') || 'none';
      const body = {
        id, label: v('st-cx-f-label').trim() || id, kind,
        enabled: f.draft && f.draft.enabled === false ? false : true,
        sensitive: chk('st-cx-f-sensitive'),
        dataHome: v('st-cx-f-dataHome').trim(),
        notes: v('st-cx-f-notes'),
        protect,
      };
      if (kind === 'mcp') {
        body.command = v('st-cx-f-command').trim();
        body.args = cxParseArgs(v('st-cx-f-args'));
        if (!body.command) return fail('An MCP connector needs a command.');
      } else {
        body.skillId = v('st-cx-f-skillId').trim();
        if (!body.skillId) return fail('Pick a skill.');
      }
      body.agents = chk('st-cx-f-all') ? null : Array.from(document.querySelectorAll('#st-cx-f-agents input[data-cx-agent]')).filter(i => i.checked).map(i => i.dataset.cxAgent);
      if (protect === 'group') {
        body.group = v('st-cx-f-group');
        if (!body.group) return fail('Group protection needs a group: create one first.');
      }
      const orig = f.orig || {};
      const wasProtected = !!(f.id && orig.protect && orig.protect !== 'none');
      const changing = wasProtected && (protect !== orig.protect || (protect === 'group' && (body.group || '') !== (orig.group || '')));
      const curpass = cxTakePass('st-cx-f-curpass');
      if (changing) {
        if (!curpass) return fail('The current passphrase is needed to change how this connector is locked.');
        body.passphrase = curpass;
      }
      const np = cxTakePass('st-cx-f-newpass'), np2 = cxTakePass('st-cx-f-newpass2');
      if (protect === 'own') {
        const needNew = !f.id || orig.protect !== 'own';
        if (needNew && !np) return fail('An own passphrase needs a new passphrase.');
        if (np && np !== np2) return fail('The two new passphrases differ.');
        if (np) body.newPassphrase = np;
      }
      const secrets = {};
      document.querySelectorAll('#st-cx-f-secrets input[data-cx-secret-remove]').forEach(i => { if (i.checked) secrets[i.dataset.cxSecretRemove] = ''; });
      let badSecret = '';
      document.querySelectorAll('#st-cx-f-secret-rows .cx-secret-row').forEach(row => {
        const name = (row.querySelector('.cx-secret-name') || {}).value || '';
        const valEl = row.querySelector('.cx-secret-value');
        const val = valEl ? valEl.value : '';
        if (!name.trim() && !val) return;
        if (!/^[A-Z][A-Z0-9_]*$/.test(name.trim())) { badSecret = name; return; }
        if (!val) { badSecret = name; return; }
        secrets[name.trim()] = val;
      });
      if (badSecret !== '') return fail(`Secret "${badSecret}": the name is UPPER_CASE and the value cannot be empty.`);
      if (Object.keys(secrets).length) body.secrets = secrets;
      const toolSel = document.querySelectorAll('#st-cx-f-tools select[data-cx-tool]');
      if (toolSel.length) {
        body.tools = {};
        toolSel.forEach(s => { body.tools[s.dataset.cxTool] = { cls: CX_CLASSES.includes(s.value) ? s.value : 'read' }; });
      }
      const btn = document.getElementById('st-cx-f-save');
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        await cxApi('/api/connectors', 'POST', body);
        document.querySelectorAll('#st-cx-f-secret-rows .cx-secret-value').forEach(i => { i.value = ''; });
        cxState.form = null;
        cxStatus(`${f.id ? 'Saved' : 'Created'} connector ${id}.`);
        await loadConnectors();
      } catch (e) {
        document.querySelectorAll('#st-cx-f-secret-rows .cx-secret-value').forEach(i => { i.value = ''; });
        fail(e.message);
        if (btn) { btn.disabled = false; btn.textContent = f.id ? 'Save' : 'Create'; }
      }
    }
    // Hub event: something changed a connector or group (unlock expiry, another window, an agent's
    // test). Lists repaint; an open form is left alone.
    function onConnectorsChanged(ev) {
      if (!document.getElementById('st-cx-section')) return;
      clearTimeout(cxState.loadTimer);
      cxState.loadTimer = setTimeout(async () => {
        try { cxState.data = await cxApi('/api/connectors'); } catch { return; }
        renderConnectorGroups();
        renderConnectorList();
        if (cxState.form && cxState.form.id && !cxFind(cxState.form.id)) { cxState.form = null; const box = document.getElementById('st-cx-form'); if (box) box.innerHTML = ''; cxStatus(`Connector ${ev && ev.id ? ev.id : ''} was removed elsewhere.`); }
      }, 250);
    }

    // Reasoning panel on/off (settings.showReasoning, on unless turned off): saved at once, from the next reply.
    async function saveReasoningToggle(on) {
      const state = document.getElementById('st-reasoning-state');
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ showReasoning: !!on }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        if (state) state.textContent = on ? 'Shown above each reply.' : 'Not shown.';
      } catch (e) { alert('Could not save: ' + e.message); }
    }

    // Approval cards on/off: saved at once, takes effect on the next tool call of any agent.
    async function saveApprovalsToggle(on) {
      const state = document.getElementById('st-approvals-state');
      try {
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ approvalsEnabled: !!on }) });
        if (state) state.textContent = on ? 'On: your agents pause on a card for sending, destructive and admin actions.' : 'Off: your agents just run. Members\' agents stay sandboxed either way.';
        stSum('agents', 'appr', `approval cards ${on ? 'on' : 'off'}`);
      } catch (e) { alert('Could not save: ' + e.message); }
    }

    // Active root grants (lib/root-grants): list with revoke buttons; granting happens on the agent's settings page.
    async function loadRootGrants() {
      const el = document.getElementById('st-root-grants');
      if (!el) return;
      try {
        const r = await fetch('/api/root-grants', { credentials: 'include' });
        const d = await r.json();
        const grants = Array.isArray(d.grants) ? d.grants : [];
        if (!grants.length) { el.textContent = 'None active.'; return; }
        el.innerHTML = grants.map(g => `<span style="display:inline-flex;align-items:center;gap:6px;margin-right:12px"><b>${esc(g.agent)}</b> until ${esc(new Date(g.until).toLocaleTimeString())}${g.note ? ` (${esc(g.note)})` : ''} <button class="st-test-btn" onclick="revokeRootGrant('${esc(g.agent)}')">Revoke</button></span>`).join('');
      } catch (e) { el.textContent = `Could not load: ${e.message}`; }
    }
    async function revokeRootGrant(agent) {
      try { await fetch(`/api/root-grants/${encodeURIComponent(agent)}`, { method: 'DELETE', credentials: 'include' }); } catch (e) { alert('Could not revoke: ' + e.message); }
      loadRootGrants();
    }

    // Per-class approval cards (settings.approvalClasses): these kinds get a card even while the switch is off.
    // ── OpenRouter box: the catalogue with search, the offer (ticked), privacy (only providers that do not store or
    // train on prompts), defaults (the newest tool-capable model of each vendor the hub has no key for). ──
    let orView = null;
    async function loadOpenRouterBox(refresh) {
      const body = document.getElementById('st-or-body');
      if (!body) return;
      try {
        const r = await fetch('/api/openrouter' + (refresh ? '?refresh=1' : ''), { credentials: 'include' });
        orView = await r.json();
      } catch (e) { body.textContent = 'Could not load the OpenRouter list: ' + e.message; return; }
      if (orView && orView.hasKey) stSum('models', 'or', `OpenRouter: ${(orView.chosen || []).length} models`);
      renderOpenRouterBox();
    }
    function orPrice(m) {
      if (m.prompt == null || m.completion == null) return '';
      const f = (x) => { const v = Number((x * 1e6).toPrecision(12)); return v === 0 ? '0' : v < 0.1 ? v.toFixed(3) : v < 10 ? v.toFixed(2) : v.toFixed(0); };
      return `$${f(m.prompt)} / $${f(m.completion)} per M`;
    }
    function renderOpenRouterBox() {
      const body = document.getElementById('st-or-body');
      if (!body || !orView) return;
      const v = orView;
      const q = (document.getElementById('st-or-q')?.value || '').trim().toLowerCase();
      const all = !!document.getElementById('st-or-all')?.checked;
      const chosen = new Set(v.chosen || []);
      const list = (v.models || []).filter(m => (all || m.tools) && !/:batch/.test(m.id))
        .filter(m => !q || m.id.toLowerCase().includes(q) || String(m.name || '').toLowerCase().includes(q))
        .sort((a, b) => (chosen.has(b.id) - chosen.has(a.id)) || (b.created - a.created));
      const ctx = (n) => !n ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : `${Math.round(n / 1000)}K`;
      const rows = list.slice(0, 300).map(m => `<label class="or-row" style="display:flex;gap:8px;align-items:baseline;padding:2px 0;cursor:pointer">
          <input type="checkbox" class="st-or-pick" value="${esc(m.id)}"${chosen.has(m.id) ? ' checked' : ''}>
          <span style="flex:1;min-width:0"><b>${esc(m.name || m.id)}</b> <code style="font-size:0.75rem;color:var(--text-dim)">${esc(m.id)}</code></span>
          <span style="font-size:0.75rem;color:var(--text-dim);white-space:nowrap">${m.tools ? '🛠' : ''}${m.reasoning ? ' 🧠' : ''}${m.images ? ' 🖼' : ''} ${ctx(m.context)} ${esc(orPrice(m))}</span>
        </label>`).join('');
      const keyLine = v.hasKey ? '' : `<div style="color:var(--warning);margin-bottom:6px">No OpenRouter key yet: get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener" style="color:var(--accent)">openrouter.ai/keys</a>, paste it in LLM Providers above, press Test, then Save. The models below show up in the pickers once the key is saved.</div>`;
      body.innerHTML = `${keyLine}
        <div class="st-row"><label style="flex-basis:150px">Privacy</label><label style="flex:1;display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="st-or-privacy"${v.privacy ? ' checked' : ''} onchange="saveOpenRouter()"> Only use providers that do not store or train on prompts</label></div>
        <div class="st-row"><label style="flex-basis:150px">Offered</label><span>${(v.chosen || []).length} model(s)${v.custom ? '' : ' (the default offer)'} · catalogue ${(v.models || []).length} models${v.fetchedAt ? `, read ${esc(new Date(v.fetchedAt).toLocaleString())}` : ''}</span></div>
        <div class="st-row" style="flex-wrap:wrap"><label style="flex-basis:150px">Find</label><input type="text" id="st-or-q" value="${esc(q)}" placeholder="grok, deepseek, kimi, qwen, llama, claude…" oninput="renderOpenRouterBox()" style="flex:1;min-width:160px">
          <label style="display:flex;gap:4px;align-items:center;margin-left:8px;font-size:0.8rem;white-space:nowrap"><input type="checkbox" id="st-or-all"${all ? ' checked' : ''} onchange="renderOpenRouterBox()"> show models without tools</label></div>
        <div id="st-or-list" style="max-height:320px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;padding:6px 10px">${rows || '<i>No model matches.</i>'}${list.length > 300 ? `<div style="color:var(--text-dim)">… ${list.length - 300} more: narrow the search.</div>` : ''}</div>
        <div class="st-hint" style="margin-top:8px">🛠 can use tools (agents need this) · 🧠 takes a reasoning level · 🖼 reads images · context window · price in / out per million tokens</div>
        <div class="st-row"><label style="flex-basis:150px"></label><button class="st-test-btn" onclick="saveOpenRouter(true)">Save the ticked models</button>
          <button class="st-test-btn" onclick="openRouterDefaults()" style="margin-left:6px">Use the defaults</button>
          <button class="st-test-btn" onclick="loadOpenRouterBox(true)" style="margin-left:6px">Refresh the list</button></div>`;
      const qEl = document.getElementById('st-or-q');
      if (q && qEl) { qEl.focus(); qEl.setSelectionRange(q.length, q.length); }
    }
    async function postOpenRouter(payload, done) {
      try {
        const r = await fetch('/api/openrouter', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const j = await r.json();
        if (!r.ok || !j.ok) { hubToast(j.error || 'Could not save.'); return; }
        orView = j; renderOpenRouterBox(); __modelListCache = null;   // the pickers refetch the model list
        if (done) hubToast(done(j));
      } catch (e) { hubToast('Could not save: ' + e.message); }
    }
    function saveOpenRouter(withModels) {
      const privacy = !!document.getElementById('st-or-privacy')?.checked;
      if (!withModels) return postOpenRouter({ privacy }, () => (privacy ? 'OpenRouter: only providers that do not store or train on prompts.' : 'OpenRouter: any provider.'));
      // Keep ticks that the current search hides: start from the saved offer, apply the visible boxes.
      const keep = new Set(orView && orView.chosen || []);
      for (const b of document.querySelectorAll('.st-or-pick')) { if (b.checked) keep.add(b.value); else keep.delete(b.value); }
      postOpenRouter({ privacy, models: [...keep] }, (j) => `OpenRouter: ${j.chosen.length} model(s) offered in the pickers.`);
    }
    function openRouterDefaults() { postOpenRouter({ models: null }, (j) => `OpenRouter: back to the default offer (${j.chosen.length} models).`); }

    async function saveQuestionAfter(v) {
      const questionAfterMinutes = v === 'off' ? null : Number(v);
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ notify: { questionAfterMinutes } }) });
        hubToast(r.ok ? (questionAfterMinutes === null ? 'Questions will not send notifications.' : questionAfterMinutes === 0 ? 'Questions notify right away.' : `Questions notify after ${questionAfterMinutes} min unanswered.`) : 'Could not save.');
        if (r.ok) stSum('notify', 'q', stQuestionsText(questionAfterMinutes));
      } catch (e) { alert('Could not save: ' + e.message); }
    }

    async function saveApprovalClasses() {
      const approvalClasses = [...document.querySelectorAll('#st-approval-classes input[type=checkbox]')].filter(b => b.checked).map(b => b.value);
      try {
        await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ approvalClasses }) });
      } catch (e) { alert('Could not save: ' + e.message); }
    }

    // ── Claude plan: warnings instead of silent switching (lib/plan-usage). A chip in the sidebar header while any weekly
    // allowance is past the first warning level; the Settings box shows the windows, the levels, the optional automatic
    // switch, and a model picker for every agent on the Claude client. ──
    let planLast = null;
    const planWhen = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(Math.round(t / 60000) * 60000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'the reset'; };
    /** The window most in need of attention: { label, utilization, resetsAt, level } or null when none passed a level. */
    function planTopWarning(d) {
      const levels = (d && d.warn && Array.isArray(d.warn.at)) ? d.warn.at : [];
      if (!levels.length) return null;
      let top = null;
      for (const w of (d.weekly || [])) {
        const reached = levels.filter(l => Number(w.utilization) >= l);
        if (!reached.length) continue;
        if (!top || Number(w.utilization) > Number(top.utilization)) top = { ...w, level: reached[reached.length - 1] };
      }
      return top;
    }
    async function refreshPlanChip() {
      const el = document.getElementById('plan-warn');
      if (!el || (window.hubMe && !window.hubMe.isAdmin)) return;
      clearTimeout(refreshPlanChip.timer);
      let next = 10 * 60000;
      try {
        const r = await fetch('/api/plan-usage', { credentials: 'include' });
        if (r.status === 403) return;   // not an admin: no plan readout
        if (r.ok) planLast = await r.json(); else next = 30000;
      } catch { next = 30000; }        // the hub is restarting: try again shortly
      // Right after a hub start the first reading takes a few seconds; a page that asked earlier tries again every 15 s
      // (up to 2 minutes) instead of waiting 10 minutes with nothing to show.
      if (!planLast || !planLast.fetchedAt) { refreshPlanChip.tries = (refreshPlanChip.tries || 0) + 1; if (refreshPlanChip.tries <= 8) next = Math.min(next, 15000); }
      else refreshPlanChip.tries = 0;
      paintPlanChip(); paintPlanBadges();
      refreshPlanChip.timer = setTimeout(refreshPlanChip, next);
    }
    function paintPlanChip() {
      const el = document.getElementById('plan-warn');
      if (!el) return;
      const top = planTopWarning(planLast);
      el.classList.toggle('on', !!top);
      if (!top) { el.textContent = ''; return; }
      el.textContent = `⚠ ${top.family ? top.label : 'Claude plan'} ${Math.round(top.utilization)}%`;
      el.classList.toggle('hot', top.rejected || Number(top.utilization) >= 100);
      el.title = `${top.family ? top.label : 'Your Claude plan'} has used ${Math.round(top.utilization)}% of this week's allowance (resets ${planWhen(top.resetsAt)}). Click to choose your agents' models.`;
    }
    // Plan usage in each chat header, next to the model, for agents on the Claude subscription (the only ones whose
    // usage the hub can read): the weekly window that governs the agent's model, coloured once it passes a level.
    function planFamilyOf(model) {
      const id = String(model || '').replace(/^claude-sdk\//, '').replace(/\[1m\]$/i, '').replace(/^claude-/, '').toLowerCase();
      if (!id) return null;
      if (id === 'default') return 'opus';
      if (/^(fable|mythos)/.test(id)) return 'fable';
      if (/^opus/.test(id)) return 'opus';
      if (/^sonnet/.test(id)) return 'sonnet';
      if (/^haiku/.test(id)) return 'haiku';
      return null;
    }
    function planWindowFor(model, d = planLast) {
      if (!d || !/^claude-sdk\//.test(String(model || ''))) return null;
      const fam = planFamilyOf(model);
      const wins = (d.weekly || []).filter(w => w.utilization != null && (w.family == null || (fam && w.family === fam)));
      return wins.length ? wins.reduce((a, b) => (Number(b.utilization) > Number(a.utilization) ? b : a)) : null;
    }
    function paintPlanBadges() {
      const levels = (planLast && planLast.warn && Array.isArray(planLast.warn.at)) ? planLast.warn.at : [];
      for (const [id, chat] of Object.entries(chats)) {
        const el = document.getElementById(`plan-badge-${id}`);
        if (!el) continue;
        const w = chat && !chat.isGroup && chat.agent ? planWindowFor(chatModelOf(chat)) : null;
        if (!w) { el.hidden = true; el.textContent = ''; continue; }
        const pct = Math.round(Number(w.utilization));
        const passed = levels.filter(l => pct >= l);
        el.textContent = `${w.family ? w.label : 'Plan'} ${pct}% this week`;
        el.className = 'plan-badge' + (w.rejected || pct >= 100 ? ' refused' : passed.length && passed.length === levels.length ? ' hot' : passed.length ? ' warn' : '');
        const all = (planLast.weekly || []).find(x => x.family == null);
        const five = planLast.windows && planLast.windows.five_hour;
        el.title = `${w.family ? `${w.label} has` : 'Your Claude plan has'} used ${pct}% of this week's allowance (resets ${planWhen(w.resetsAt)})` +
          (all && w.family ? `; all models ${Math.round(Number(all.utilization))}%` : '') + (five && five.utilization != null ? `; 5-hour window ${Math.round(Number(five.utilization))}%` : '') + '. Click to choose models (Settings → Claude plan).';
        el.hidden = false;
      }
    }
    async function openPlanSettings() {
      await openSettingsAt('st-plan-section');
    }
    async function loadPlanBox(readNow = false) {
      const usageEl = document.getElementById('st-plan-usage');
      if (!usageEl) return;
      const state = document.getElementById('st-plan-state');
      if (readNow && state) state.textContent = 'Reading…';
      let d;
      try {
        const r = await fetch(readNow ? '/api/plan-usage/refresh' : '/api/plan-usage', { method: readNow ? 'POST' : 'GET', credentials: 'include' });
        d = await r.json();
        if (!r.ok) throw new Error(d.error || r.status);
      } catch (e) { usageEl.textContent = `Could not read the plan: ${e.message}`; if (state) state.textContent = ''; return; }
      planLast = d; paintPlanChip(); paintPlanBadges();
      const worst = (d.weekly || []).reduce((a, w) => (Number(w.utilization) || 0) > (a ? Number(a.utilization) || 0 : -1) ? w : a, null);
      stSum('models', 'plan', worst ? `${worst.family ? worst.label : 'Claude plan'} ${Math.round(Number(worst.utilization) || 0)}% this week` : '');
      if (state) state.textContent = d.fetchedAt ? `read ${new Date(d.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : (d.error ? `last read failed: ${String(d.error).slice(25, 140)}` : '');
      const levels = (d.warn && Array.isArray(d.warn.at)) ? d.warn.at : [];
      const first = levels.length ? levels[0] : 101; const last = levels.length ? levels[levels.length - 1] : 101;
      const rows = [];
      const five = d.windows && d.windows.five_hour;
      if (five && five.utilization != null) rows.push({ label: '5-hour window', utilization: five.utilization, resetsAt: five.resets_at });
      for (const w of (d.weekly || [])) rows.push({ label: w.family ? `${w.label} (weekly)` : 'All models (weekly)', utilization: w.utilization, resetsAt: w.resetsAt, rejected: w.rejected, weekly: true });
      usageEl.innerHTML = rows.length ? rows.map(w => {
        const pct = Math.round(Number(w.utilization) || 0);
        const color = w.rejected || pct >= 100 ? '#d4588b' : (w.weekly && pct >= last) ? '#d95926' : (w.weekly && pct >= first) ? '#c9a227' : '#3987e5';
        return `<div style="display:flex;align-items:center;gap:10px;margin:3px 0"><span style="flex-basis:150px;flex-shrink:0">${esc(w.label)}</span><span style="width:140px;height:6px;background:var(--border);border-radius:3px;overflow:hidden;flex-shrink:0"><span style="display:block;height:100%;width:${Math.min(pct, 100)}%;background:${color}"></span></span><b style="color:${color};min-width:44px">${pct}%</b><span style="color:var(--text-dim)">${w.rejected ? 'refused until ' : 'resets '}${esc(planWhen(w.resetsAt))}</span></div>`;
      }).join('') : (d.error ? `No reading yet: ${esc(String(d.error).slice(25, 200))}` : 'No reading yet (the first one comes a few seconds after the hub starts).');
      const warnIn = document.getElementById('st-plan-warn');
      if (warnIn && document.activeElement !== warnIn) warnIn.value = levels.join(', ');
      const auto = !!(d.policy && d.policy.enabled);
      const autoIn = document.getElementById('st-plan-auto'); if (autoIn) autoIn.checked = auto;
      const autoState = document.getElementById('st-plan-auto-state');
      if (autoState) autoState.textContent = auto ? `On: at ${d.policy.at}% an agent's turns run on its substitute model until the reset (Fable → Opus 5.5, Opus → Sonnet 5.5, Sonnet → Haiku 5.5).` : 'Off: agents stay on the model you chose; you get the warnings and decide.';
      await renderPlanAgents(d, levels);
    }
    async function renderPlanAgents(d, levels) {
      const el = document.getElementById('st-plan-agents');
      if (!el) return;
      const agents = Array.isArray(d.agents) ? d.agents : [];
      if (!agents.length) { el.innerHTML = ''; return; }
      const famLabel = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' };
      const hot = new Set((d.weekly || []).filter(w => levels.some(l => Number(w.utilization) >= l)).map(w => w.family || '*'));
      const groups = new Map();
      for (const a of agents) { const f = a.family || 'other'; if (!groups.has(f)) groups.set(f, []); groups.get(f).push(a); }
      let models = [], billing = {};
      try { const ml = await modelList(); models = ml.models; billing = ml.billing || {}; } catch {}
      const options = (cur) => {
        let h = cur && !models.includes(cur) ? `<option value="${esc(cur)}" selected>${esc(billingDisplay(cur, true))} (current)</option>` : '';
        for (const [label, rows] of groupModels(models)) h += `<optgroup label="${esc(label)}">` + rows.map(m => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc((billing[m] && billing[m].short) || billingDisplay(m, true))}</option>`).join('') + '</optgroup>';
        return h;
      };
      const order = ['fable', 'opus', 'sonnet', 'haiku', 'other'];
      el.innerHTML = `<div class="st-hint" style="margin-left:0;margin-bottom:4px">Your agents on the Claude client, by model. Changing one here is the same as its chat header picker: the next turn runs on the new model.</div>` +
        [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([fam, list]) => {
          const note = hot.has(fam) ? 'past a warning level' : hot.has('*') ? 'the all-models allowance is past a warning level' : '';
          return `<details ${note ? 'open' : ''} style="margin:4px 0"><summary style="cursor:pointer;font-size:0.85rem"><b>${esc(famLabel[fam] || 'Other')}</b> · ${list.length} agent${list.length === 1 ? '' : 's'}${note ? ` · <span style="color:#c9a227">${note}</span>` : ''}</summary>` +
            list.sort((x, y) => String(x.display || x.name).localeCompare(String(y.display || y.name))).map(a => `<div class="st-row" style="margin:2px 0 2px 12px"><label style="flex-basis:150px">${esc(a.icon || '🤖')} ${esc(a.display || a.name)}</label><select data-agent="${esc(a.name)}" data-model="${esc(a.model)}" onchange="planAgentModel(this)" style="padding:3px;max-width:340px">${options(a.model)}</select></div>`).join('') + '</details>';
        }).join('');
    }
    async function planAgentModel(sel) {
      const agent = sel.dataset.agent; const prev = sel.dataset.model; const model = sel.value;
      if (!agent || !model || model === prev) return;
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(agent)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ model }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success) { sel.value = prev; alert(`Could not change the model: ${d.error || r.status}`); return; }
        sel.dataset.model = model;
        const a = (AGENTS || []).find(x => x.name === agent); if (a) a.model = model;
        hubToast(`${agentDisplayName(agent)} now runs on ${model.split('/').pop()} from its next turn`);
        setTimeout(loadPlanBox, 400);
      } catch (e) { sel.value = prev; alert(`Could not change the model: ${e.message}`); }
    }
    async function savePlanWarn() {
      const saved = dialogGuard.savePoint(document.getElementById('st-plan-warn'));
      const v = document.getElementById('st-plan-warn').value;
      const at = String(v).split(/[,\s]+/).filter(Boolean).map(Number).filter(n => Number.isFinite(n) && n >= 1 && n <= 100);
      const st = document.getElementById('st-plan-warn-state');
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ planWarn: { at } }) });
        if (!r.ok) throw new Error(r.status);
        saved();
        if (st) st.textContent = at.length ? 'Saved.' : 'Saved: no warnings.';
        loadPlanBox();
      } catch (e) { if (st) st.textContent = `Could not save: ${e.message}`; }
    }
    async function savePlanAuto(on) {
      try {
        const r = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ planFallback: { enabled: !!on } }) });
        if (!r.ok) throw new Error(r.status);
      } catch (e) { alert('Could not save: ' + e.message); }
      loadPlanBox();
    }

    // ── Spend ledger: today's total in the sidebar header and the Spend section in Settings.
    // /api/ledger/today is polled every minute and shortly after each turn_end (the turn is
    // recorded when it ends). Older hubs have no ledger: the readout then stays hidden. ──
    const SPEND_REFRESH_MS = 60000;
    let spendToday = null;      // last /api/ledger/today answer
    let spendRefreshTimer = null;
    const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
    async function refreshSpendToday() {
      try {
        const r = await fetch('/api/ledger/today', { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        spendToday = await r.json();
      } catch { return; }
      paintSpendToday();
      paintCreditMeter();
      paintSpendSettings(false);
    }
    function scheduleSpendRefresh() {
      if (spendRefreshTimer) return;
      spendRefreshTimer = setTimeout(() => { spendRefreshTimer = null; refreshSpendToday(); }, 2000);
    }
    function paintSpendToday() {
      const el = document.getElementById('spend-today');
      if (!el) return;
      const t = spendToday;
      const show = !!t && ((t.total || 0) > 0 || (t.turns || 0) > 0);
      el.classList.toggle('on', show);
      if (!show) { el.textContent = ''; return; }
      el.textContent = `today ${usd(t.total)}`;
      const top = (t.agents || []).slice(0, 3).map(a => `${agentDisplayName(a.agent)} ${usd(a.cost)}`).join(', ');
      el.title = `API-equivalent spend today: ${usd(t.total)} over ${t.turns || 0} turn${t.turns === 1 ? '' : 's'}${top ? ` · ${top}` : ''}. Click for caps.`;
    }
    // Monthly API credits (settings.apiCredits, POST /api/ledger/credits): the header shows the fullest one.
    const CREDIT_PROVIDERS = [['anthropic', 'Anthropic'], ['openai', 'OpenAI'], ['google', 'Google'], ['openrouter', 'OpenRouter'], ['perplexity', 'Perplexity']];
    const creditLabel = (p) => (CREDIT_PROVIDERS.find(x => x[0] === p) || [p, p])[1];
    const cap = (n) => Number.isInteger(Number(n)) ? `$${Number(n)}` : usd(n);   // $200, not $200.00
    const creditSince = (day) => { const d = new Date(`${day}T12:00:00`); return isNaN(d) ? day : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); };
    function creditLine(c) {
      const pct = c.monthlyUsd ? Math.round(100 * c.spent / c.monthlyUsd) : 0;
      return `${creditLabel(c.provider)}: ${usd(c.spent)} of ${cap(c.monthlyUsd)} since ${creditSince(c.since)} (${pct}%)${c.unpriced ? `, plus ${c.unpriced} call${c.unpriced === 1 ? '' : 's'} with no known price` : ''}`;
    }
    function paintCreditMeter() {
      const el = document.getElementById('credit-meter');
      if (!el) return;
      const list = (spendToday && spendToday.credits) || [];
      el.classList.toggle('on', list.length > 0);
      if (!list.length) { el.textContent = ''; el.title = ''; el.classList.remove('warn', 'hot'); return; }
      const top = list.slice().sort((a, b) => b.spent / b.monthlyUsd - a.spent / a.monthlyUsd)[0];
      const pct = top.spent / top.monthlyUsd;
      el.textContent = `${list.length > 1 ? `${creditLabel(top.provider)} ` : ''}credit ${usd(top.spent)} of ${cap(top.monthlyUsd)}`;
      el.classList.toggle('hot', pct >= 0.9);
      el.classList.toggle('warn', pct >= 0.75 && pct < 0.9);
      el.title = `${list.map(creditLine).join('\n')}\nSpend through this hub, as its ledger books it. The provider's billing page has the exact figure. Click to change.`;
    }
    function fillCreditInputs() {
      const p = document.getElementById('st-credit-provider')?.value;
      const c = ((spendToday && spendToday.credits) || []).find(x => x.provider === p);
      const amt = document.getElementById('st-credit-amount'), day = document.getElementById('st-credit-day');
      if (amt) amt.value = c ? String(c.monthlyUsd) : '';
      if (day) day.value = c ? String(c.resetDay) : '';
    }
    async function saveCredit() {
      const btn = document.getElementById('st-credit-save');
      const body = {
        provider: document.getElementById('st-credit-provider')?.value,
        monthlyUsd: (document.getElementById('st-credit-amount')?.value || '').trim(),
        resetDay: (document.getElementById('st-credit-day')?.value || '').trim(),
      };
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        const r = await fetch('/api/ledger/credits', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (spendToday) spendToday.credits = d.credits || [];
        paintCreditMeter(); paintSpendSettings(false); fillCreditInputs();
        dialogGuard.markLoaded(['st-credit-provider', 'st-credit-amount', 'st-credit-day'].map(id => document.getElementById(id)));   // refilled from the hub's answer
        if (btn) { btn.className = 'st-test-btn ok'; btn.textContent = 'Saved'; }
      } catch (e) {
        if (btn) { btn.className = 'st-test-btn fail'; btn.textContent = 'Failed'; }
        alert(`Could not save the credit: ${e.message}`);
      }
      if (btn) { btn.disabled = false; setTimeout(() => { btn.className = 'st-test-btn'; btn.textContent = 'Save'; }, 3000); }
    }
    async function paintSpendSettings(fetchFirst = true) {
      const box = document.getElementById('st-spend');
      if (!box) return;
      if (fetchFirst || !spendToday) await refreshSpendToday();
      const t = spendToday;
      if (!t) { box.textContent = 'No ledger on this hub.'; stSum('money', 'spend', 'no spend ledger'); return; }
      const top = (t.agents || []).slice(0, 5).map(a => `${esc(agentDisplayName(a.agent))} ${usd(a.cost)} (${a.turns})`).join(' · ');
      box.innerHTML = `<b style="color:var(--text)">${usd(t.total)}</b> over ${t.turns || 0} turn${t.turns === 1 ? '' : 's'}${top ? `<div style="margin-top:2px">${top}</div>` : ''}`;
      const caps = t.caps || {};
      stSum('money', 'spend', `Today ${usd(t.total)}`);
      stSum('money', 'caps', caps.perAgentDailyUsd || caps.hubDailyUsd ? `caps: ${[caps.perAgentDailyUsd ? `${usd(caps.perAgentDailyUsd)} per agent` : '', caps.hubDailyUsd ? `${usd(caps.hubDailyUsd)} whole hub` : ''].filter(Boolean).join(', ')}` : 'no daily caps');
      const credits = t.credits || [];
      const listEl = document.getElementById('st-credit-list');
      if (listEl) listEl.textContent = credits.length ? credits.map(creditLine).join(' · ') : 'None set. Enter an amount to see it next to today\'s spend.';
      if (credits.length) stSum('money', 'credit', credits.map(c => `${creditLabel(c.provider)} credit ${usd(c.spent)} of ${cap(c.monthlyUsd)}`).join(', '),
        credits.some(c => c.spent >= 0.9 * c.monthlyUsd));
      else stSum('money', 'credit', '');
      const provEl = document.getElementById('st-credit-provider');
      if (provEl && !provEl.dataset.ready) {
        if (credits.length) provEl.value = credits[0].provider;
        provEl.dataset.ready = '1';
        fillCreditInputs();
      }
      const agentInp = document.getElementById('st-cap-agent');
      const hubInp = document.getElementById('st-cap-hub');
      if (agentInp && document.activeElement !== agentInp) agentInp.value = caps.perAgentDailyUsd ? String(caps.perAgentDailyUsd) : '';
      if (hubInp && document.activeElement !== hubInp) hubInp.value = caps.hubDailyUsd ? String(caps.hubDailyUsd) : '';
    }
    async function saveSpendCaps() {
      const saved = dialogGuard.savePoint(['st-cap-agent', 'st-cap-hub'].map(id => document.getElementById(id)));
      const btn = document.getElementById('st-caps-save');
      const val = (id) => { const v = (document.getElementById(id)?.value || '').trim().replace(/^\$/, ''); return v === '' ? null : Number(v); };
      const perAgentDailyUsd = val('st-cap-agent');
      const hubDailyUsd = val('st-cap-hub');
      for (const v of [perAgentDailyUsd, hubDailyUsd]) if (v !== null && !(Number.isFinite(v) && v >= 0)) { alert('Caps must be a dollar amount, or blank for unlimited.'); return; }
      if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
      try {
        const r = await fetch('/api/ledger/caps', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ perAgentDailyUsd, hubDailyUsd }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        saved();
        const d = await r.json().catch(() => null);
        if (d && d.caps && spendToday) spendToday.caps = d.caps;
        if (btn) { btn.className = 'st-test-btn ok'; btn.textContent = 'Saved'; }
        document.getElementById('st-saved')?.classList.add('show');
        setTimeout(() => document.getElementById('st-saved')?.classList.remove('show'), 2000);
      } catch (e) {
        if (btn) { btn.className = 'st-test-btn fail'; btn.textContent = 'Failed'; }
        alert(`Could not save caps: ${e.message}`);
      }
      if (btn) { btn.disabled = false; setTimeout(() => { btn.className = 'st-test-btn'; btn.textContent = 'Save'; }, 3000); }
    }
    setInterval(refreshSpendToday, SPEND_REFRESH_MS);

    // ── Desktop push notifications (optional; the same /sw.js the phone UI uses) ──
    function desktopPushSupported() {
      return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    }

    async function desktopPushSubscription() {
      if (!desktopPushSupported()) return null;
      try {
        const reg = await navigator.serviceWorker.getRegistration('/');
        return reg ? await reg.pushManager.getSubscription() : null;
      } catch { return null; }
    }

    async function paintDesktopPush() {
      const btn = document.getElementById('st-push-btn');
      const hint = document.getElementById('st-push-hint');
      if (!btn) return;
      if (!desktopPushSupported()) { btn.textContent = 'Not supported'; btn.disabled = true; stSum('notify', 'push', 'push not available in this browser'); return; }
      if (Notification.permission === 'denied') { btn.textContent = 'Blocked'; btn.disabled = true; if (hint) hint.textContent = 'Notifications are blocked for this site in the browser settings.'; stSum('notify', 'push', 'push blocked in this browser'); return; }
      const sub = await desktopPushSubscription();
      btn.textContent = sub ? 'Turn off' : 'Turn on';
      stSum('notify', 'push', sub ? 'push on for this computer' : 'push off for this computer');
      btn.disabled = false;
    }

    async function toggleDesktopPush() {
      const btn = document.getElementById('st-push-btn');
      if (btn) btn.disabled = true;
      try {
        const sub = await desktopPushSubscription();
        if (sub) {
          await fetch('/api/push/unsubscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
          await sub.unsubscribe();
        } else {
          const perm = await Notification.requestPermission();
          if (perm !== 'granted') throw new Error('permission not granted');
          const kr = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
          if (!kr.ok) throw new Error(kr.status === 404 ? 'this hub does not support push yet' : `HTTP ${kr.status}`);
          const { key } = await kr.json();
          if (!key) throw new Error('push is not configured on the hub');
          const pad = '='.repeat((4 - key.length % 4) % 4);
          const raw = atob((key + pad).replace(/-/g, '+').replace(/_/g, '/'));
          const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
          await navigator.serviceWorker.ready;
          const fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(raw, c => c.charCodeAt(0)) });
          const r = await fetch('/api/push/subscribe', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: fresh.toJSON(), agents: null }) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
        }
      } catch (e) {
        const hint = document.getElementById('st-push-hint');
        if (hint) hint.textContent = `Could not change notifications: ${e.message}`;
      }
      paintDesktopPush();
    }

    async function saveSettings() {
      // This Save writes the provider keys and URLs and the two defaults; it settles only those (lib/ui-dialog savePoint).
      const saved = dialogGuard.savePoint([...document.querySelectorAll('#st-overlay [id^="st-key-"], #st-overlay [id^="st-url-"]'), ...['st-maxTokens', 'st-maxContext'].map(id => document.getElementById(id))]);
      const patch = { providers: {} };

      for (const p of PROVIDERS) {
        if (p.hasKey) {
          const inp = document.getElementById(`st-key-${p.id}`);
          if (inp && inp.value) {
            if (!patch.providers[p.id]) patch.providers[p.id] = {};
            patch.providers[p.id].apiKey = inp.value;
          }
        }
        if (p.hasUrl) {
          const inp = document.getElementById(`st-url-${p.id}`);
          if (inp) {
            if (!patch.providers[p.id]) patch.providers[p.id] = {};
            patch.providers[p.id].url = inp.value || '';
          }
        }
      }

      const maxTokens = parseInt(document.getElementById('st-maxTokens')?.value);
      const maxContext = parseInt(document.getElementById('st-maxContext')?.value);
      if (maxTokens > 0) patch.maxCompletionTokens = maxTokens;
      if (maxContext > 0) patch.maxContextMessages = maxContext;

      try {
        const r = await fetch('/api/settings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(patch),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        saved();
        const note = document.getElementById('st-saved');
        if (note) { note.classList.add('show'); setTimeout(() => note.classList.remove('show'), 2000); }
      } catch (e) {
        alert('Save failed: ' + e.message);
      }
    }

    async function testProvider(provider) {
      const btn = event.target;
      btn.textContent = '...';
      btn.className = 'st-test-btn';

      const payload = { provider };
      const keyInp = document.getElementById(`st-key-${provider}`);
      const urlInp = document.getElementById(`st-url-${provider}`);
      if (keyInp?.value) payload.apiKey = keyInp.value;
      if (urlInp?.value) payload.url = urlInp.value;

      try {
        const r = await fetch('/api/settings/test-provider', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload),
        });
        const data = await r.json();
        if (data.ok) {
          btn.textContent = data.models ? `OK (${data.models})` : 'OK';
          btn.className = 'st-test-btn ok';
        } else {
          btn.textContent = data.error || `HTTP ${data.status}`;
          btn.className = 'st-test-btn fail';
        }
      } catch (e) {
        btn.textContent = 'Error';
        btn.className = 'st-test-btn fail';
      }

      setTimeout(() => { btn.textContent = 'Test'; btn.className = 'st-test-btn'; }, 4000);
    }

    // ── Agent Dreaming ──
    async function startDream() {
      if (!confirm('Start agent dreaming?\n\nAgents will review their recent activity and consolidate learnings into long-term memory.\n\nUses Sonnet 5 — cost ~$0.30 total.')) return;
      const btn = document.getElementById('dream-btn');
      btn.classList.add('restarting');

      let overlay = document.getElementById('dream-overlay');
      if (overlay) overlay.remove();

      overlay = document.createElement('div');
      overlay.id = 'dream-overlay';
      overlay.className = 'dream-overlay';
      overlay.innerHTML = `
        <div class="dream-modal">
          <h3>💤 Agent Dreaming</h3>
          <p class="dream-subtitle">Agents are consolidating recent learnings...</p>
          <div id="dream-agents"></div>
          <div class="dream-summary" id="dream-summary">Starting...</div>
        </div>
      `;
      document.body.appendChild(overlay);
      overlay.__dialogClose = () => { overlay.remove(); btn.classList.remove('restarting'); };   // Esc and the backdrop: dialogGuard

      try {
        await fetch('/api/dream', { method: 'POST', credentials: 'include' });
        // Poll status
        pollDreamStatus(btn);
      } catch (e) {
        document.getElementById('dream-agents').innerHTML = `<div class="dream-agent-row"><span class="dream-agent-name">Error: ${e.message}</span></div>`;
        btn.classList.remove('restarting');
      }
    }

    function pollDreamStatus(btn) {
      fetch('/api/dream/status', { credentials: 'include' })
        .then(r => r.json())
        .then(data => {
          renderDreamStatus(data);
          if (data.status === 'running') {
            setTimeout(() => pollDreamStatus(btn), 2000);
          } else {
            btn.classList.remove('restarting');
          }
        })
        .catch(() => { btn.classList.remove('restarting'); });
    }

    function renderDreamStatus(data) {
      const container = document.getElementById('dream-agents');
      const summary = document.getElementById('dream-summary');
      if (!container) return;

      let html = '';
      for (const r of data.results || []) {
        let statusClass, statusText;
        if (r.skipped) { statusClass = 'skipped'; statusText = r.reason || 'skipped'; }
        else { statusClass = 'done'; statusText = '✓ learned'; }
        html += `<div class="dream-agent-row">
          <span class="dream-agent-name">${r.agent}</span>
          <span class="dream-agent-status ${statusClass}">${statusText}</span>
        </div>`;
      }

      if (data.currentAgent) {
        html += `<div class="dream-agent-row">
          <span class="dream-agent-name">${data.currentAgent}</span>
          <span class="dream-agent-status active">🧠 dreaming...</span>
        </div>`;
      }
      container.innerHTML = html;

      if (summary) {
        const learned = (data.results || []).filter(r => !r.skipped).length;
        const skipped = (data.results || []).filter(r => r.skipped).length;
        if (data.status === 'running') {
          summary.textContent = `Processing... ${data.results?.length || 0} agents done`;
        } else if (data.status === 'complete') {
          summary.innerHTML = `<span style="color:var(--success)">Complete</span> — ${learned} agents learned, ${skipped} skipped`;
        } else if (data.status === 'error') {
          summary.innerHTML = `<span style="color:var(--error)">Error: ${data.error}</span>`;
        }
      }
    }

    // ── Sidebar resize & collapse ──
    const MOBILE_BP = 1024;
    function isMobile() { return window.innerWidth <= MOBILE_BP; }
    function toggleSidebar() {
      document.querySelector('.sidebar').classList.toggle('open');
      document.getElementById('sidebar-overlay').classList.toggle('open');
    }
    function openSidebar() {
      document.querySelector('.sidebar').classList.add('open');
      document.getElementById('sidebar-overlay').classList.add('open');
    }
    function closeSidebarOnMobile() {
      if (isMobile()) {
        document.querySelector('.sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('open');
      }
    }
    // Auto-open sidebar on mobile if no chats open
    if (isMobile()) { setTimeout(openSidebar, 300); }

    // ── Sidebar collapse/expand ──
    function collapseSidebar() {
      const sidebar = document.getElementById('sidebar');
      const expandBtn = document.getElementById('sidebar-expand-btn');
      sidebar.classList.add('collapsed');
      expandBtn.classList.add('visible');
      localStorage.setItem('sidebarCollapsed', 'true');
    }
    function expandSidebar() {
      const sidebar = document.getElementById('sidebar');
      const expandBtn = document.getElementById('sidebar-expand-btn');
      sidebar.classList.remove('collapsed');
      expandBtn.classList.remove('visible');
      localStorage.setItem('sidebarCollapsed', 'false');
    }
    // Restore collapsed state
    if (localStorage.getItem('sidebarCollapsed') === 'true' && !isMobile()) {
      document.getElementById('sidebar').classList.add('collapsed');
      document.getElementById('sidebar-expand-btn').classList.add('visible');
    }

    // ── Sidebar drag-to-resize ──
    (function initSidebarResize() {
      const sidebar = document.getElementById('sidebar');
      const handle = document.getElementById('sidebar-resize-handle');
      if (!handle) return;
      let isResizing = false;
      let startX, startWidth;

      handle.addEventListener('mousedown', (e) => {
        if (sidebar.classList.contains('collapsed')) return;
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        sidebar.classList.add('resizing');
        handle.classList.add('active');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
        e.preventDefault();
      });

      document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        const newWidth = Math.min(500, Math.max(160, startWidth + (e.clientX - startX)));
        sidebar.style.width = newWidth + 'px';
      });

      document.addEventListener('mouseup', () => {
        if (!isResizing) return;
        isResizing = false;
        sidebar.classList.remove('resizing');
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        localStorage.setItem('sidebarWidth', sidebar.style.width);
      });

      // Restore saved width
      const savedWidth = localStorage.getItem('sidebarWidth');
      if (savedWidth && !isMobile()) {
        sidebar.style.width = savedWidth;
      }
    })();

    // v5.1: All requests go through multi-provider LLM routing

    // ── "⋯" header menu ──
    // The rarely used header actions (messaging, wallets, dream, update, restart) live in a
    // dropdown under #more-btn; the tuning controls (pre-scan, lazy tools, SDK workers, terse,
    // reply length, message history) sit in an "Advanced" section of the same menu that only
    // shows when the "Advanced controls" checkbox is on (localStorage 'hub-advanced', default off).
    // The controls stay in the DOM either way so the wiring below keeps working.
    const moreBtn = document.getElementById('more-btn');
    const moreMenu = document.getElementById('more-menu');
    const moreWrap = document.getElementById('more-wrap');
    const advancedToggle = document.getElementById('advanced-toggle');
    const ADVANCED_KEY = 'hub-advanced';
    function isMoreMenuOpen() { return !!(moreMenu && moreMenu.classList.contains('open')); }
    function openMoreMenu() {
      if (!moreMenu) return;
      moreMenu.classList.add('open');
      moreBtn.setAttribute('aria-expanded', 'true');
      const first = moreMenu.querySelector('.more-item');
      if (first) first.focus();
    }
    function closeMoreMenu(refocus = false) {
      if (!moreMenu || !isMoreMenuOpen()) return;
      moreMenu.classList.remove('open');
      moreBtn.setAttribute('aria-expanded', 'false');
      if (refocus) moreBtn.focus();
    }
    function toggleMoreMenu() { if (isMoreMenuOpen()) closeMoreMenu(true); else openMoreMenu(); }
    function applyAdvanced(on) {
      if (moreMenu) moreMenu.classList.toggle('advanced', on);
      if (moreBtn) {
        moreBtn.classList.toggle('advanced', on);
        moreBtn.title = on ? 'More options (advanced controls on)' : 'More options';
      }
      if (advancedToggle) advancedToggle.checked = on;
    }
    if (moreMenu) {
      applyAdvanced(localStorage.getItem(ADVANCED_KEY) === '1');
      if (advancedToggle) {
        advancedToggle.addEventListener('change', () => {
          localStorage.setItem(ADVANCED_KEY, advancedToggle.checked ? '1' : '0');
          applyAdvanced(advancedToggle.checked);
        });
      }
      // Clicking anywhere outside the button + menu closes it.
      document.addEventListener('click', (e) => {
        if (isMoreMenuOpen() && moreWrap && !moreWrap.contains(e.target)) closeMoreMenu();
      });
      // Escape closes (and hands focus back to the button); Tab moves through the items as usual.
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isMoreMenuOpen()) { e.preventDefault(); closeMoreMenu(true); }
      });
      // Focus leaving the menu (Tab past the last item) closes it too.
      moreWrap.addEventListener('focusout', (e) => {
        if (isMoreMenuOpen() && e.relatedTarget && !moreWrap.contains(e.relatedTarget)) closeMoreMenu();
      });
    }

    // ── Pre-scan toggle ──
    const prescanToggle = document.getElementById('prescan-toggle');
    const prescanLabel = document.getElementById('prescan-label');
    function updatePrescanLabel() {
      // Full name either way: the control now sits on its own menu row, not in the crowded header.
      prescanLabel.textContent = '🔬 Pre-scan';
    }
    fetch('/api/prescan_tools').then(r => r.json()).then(data => {
      prescanToggle.checked = data.enabled;
      localStorage.setItem('prescanTools', data.enabled);
      updatePrescanLabel();
    }).catch(() => {
      prescanToggle.checked = localStorage.getItem('prescanTools') === 'true';
      updatePrescanLabel();
    });
    prescanToggle.addEventListener('change', () => {
      localStorage.setItem('prescanTools', prescanToggle.checked);
      updatePrescanLabel();
      fetch('/api/prescan_tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: prescanToggle.checked })
      }).catch(() => {});
    });

    // ── Lazy tools toggle ──
    // SDK sub-workers policy selector (fallback | allow | off)
    const sdkWorkersSelect = document.getElementById('sdk-workers-select');
    if (sdkWorkersSelect) {
      fetch('/api/sdk_workers', { credentials: 'include' }).then(r => r.json()).then(d => { if (d && d.mode) sdkWorkersSelect.value = d.mode; }).catch(() => {});
      sdkWorkersSelect.addEventListener('change', () => {
        fetch('/api/sdk_workers', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: sdkWorkersSelect.value }) })
          .then(r => r.json()).then(d => { if (d && d.mode) sdkWorkersSelect.value = d.mode; }).catch(() => {});
      });
    }

    const lazyToolsToggle = document.getElementById('lazy-tools-toggle');
    const lazyToolsLabel = document.getElementById('lazy-tools-label');
    function updateLazyToolsLabel() {
      lazyToolsLabel.textContent = '⚡ Lazy Tools';
    }
    fetch('/api/lazy_tools').then(r => r.json()).then(data => {
      lazyToolsToggle.checked = data.enabled;
      updateLazyToolsLabel();
    }).catch(() => {
      lazyToolsToggle.checked = true; // default on
      updateLazyToolsLabel();
    });
    lazyToolsToggle.addEventListener('change', () => {
      updateLazyToolsLabel();
      fetch('/api/lazy_tools', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: lazyToolsToggle.checked })
      }).catch(() => {});
    });

    // ── Caveman mode toggle ──
    const cavemanToggle = document.getElementById('caveman-toggle');
    const cavemanLabel = document.getElementById('caveman-label');
    function updateCavemanLabel() {
      cavemanLabel.textContent = '🦴 Terse';
    }
    // Load caveman state from server (source of truth)
    fetch('/api/caveman_mode').then(r => r.json()).then(data => {
      cavemanToggle.checked = data.enabled;
      localStorage.setItem('cavemanMode', data.enabled);
      updateCavemanLabel();
    }).catch(() => {
      cavemanToggle.checked = localStorage.getItem('cavemanMode') === 'true';
      updateCavemanLabel();
    });
    cavemanToggle.addEventListener('change', () => {
      localStorage.setItem('cavemanMode', cavemanToggle.checked);
      updateCavemanLabel();
      fetch('/api/caveman_mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: cavemanToggle.checked })
      }).catch(() => {});
    });

    // (The old all-or-nothing "Confirm changes" toggle is gone: per-agent tool policy decides
    // allow / ask / deny per action class, and "ask" shows an approval card; see the
    // Action approvals section below and the Tool policy section in agent settings.)

    // ── Max completion tokens control ──
    const maxTokensSelect = document.getElementById('max-tokens-select');
    // Restore from localStorage
    const savedMaxTokens = localStorage.getItem('maxCompletionTokens') || '32000';
    maxTokensSelect.value = savedMaxTokens;
    maxTokensSelect.addEventListener('change', () => {
      localStorage.setItem('maxCompletionTokens', maxTokensSelect.value);
      fetch('/api/max_completion_tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parseInt(maxTokensSelect.value, 10) })
      }).catch(() => {});
    });
    // Sync initial state to server on page load
    fetch('/api/max_completion_tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: parseInt(maxTokensSelect.value, 10) })
    }).catch(() => {});

    // ── Max context messages control ──
    const maxCtxSelect = document.getElementById('max-context-select');
    const savedMaxCtx = localStorage.getItem('maxContextMessages') || '40';
    maxCtxSelect.value = savedMaxCtx;
    maxCtxSelect.addEventListener('change', () => {
      localStorage.setItem('maxContextMessages', maxCtxSelect.value);
      fetch('/api/max_context_messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: parseInt(maxCtxSelect.value, 10) })
      }).catch(() => {});
    });
    fetch('/api/max_context_messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: parseInt(maxCtxSelect.value, 10) })
    }).catch(() => {});


    // ── Action approvals: a card for every tool call the agent's policy marks "ask" ──
    // Requests arrive on the agent's own chat stream (gateway approval_request / approval_resolved)
    // and on /api/events (same names); status_snapshot carries the whole pending list so a fresh
    // page shows outstanding cards. Cards stack top-right, newest first, and never block the page:
    // the agent's turn keeps streaming underneath while the owner decides. Answers go to
    // POST /api/approvals/<id>; a 404 means someone else (or the timeout) answered first.
    const APPROVAL_CLASS_LABELS = { write_outside: 'write outside its folders', send: 'send off this machine', admin: 'change hub data / another agent', destroy: 'destructive action', money: 'move money' };
    const APPROVAL_DETAIL_LABELS = { command: 'Command', path: 'Path', paths: 'Paths', to: 'To', channel: 'Channel', text: 'Text', reason: 'Why flagged', tool: 'Tool', input: 'Arguments', name: 'Name', model: 'Model' };
    const approvals = new Map();   // id -> { data, card }
    let approvalsTimer = null;

    function agentDisplayName(name) {
      return AGENTS.find(a => a.name === name)?.display || capName(String(name || 'An agent'));
    }
    function approvalWants(ev) {
      const label = APPROVAL_CLASS_LABELS[ev.cls] || String(ev.cls || 'do something that needs approval');
      return `${agentDisplayName(ev.agent)} wants to ${ev.cls === 'destroy' ? 'take a ' : ''}${label}`;
    }
    function approvalCountdown(expiresAt) {
      const ms = expiresAt ? Date.parse(expiresAt) - Date.now() : NaN;
      if (!(ms > 0)) return Number.isNaN(ms) ? '' : 'expired: not done';
      const s = Math.ceil(ms / 1000);
      return `expires in ${s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`}`;
    }
    // detail is { command, path, paths, to, channel, text, reason, tool, input, ... }: readable rows, not raw JSON.
    function approvalDetailRows(ev) {
      const d = ev.detail && typeof ev.detail === 'object' ? ev.detail : {};
      const rows = [];
      if (ev.tool && !d.tool) rows.push(['Tool', String(ev.tool)]);
      for (const [k, v] of Object.entries(d)) {
        if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) continue;
        let text;
        if (k === 'input') { try { text = JSON.stringify(JSON.parse(v), null, 2); } catch { text = String(v); } }
        else text = Array.isArray(v) ? v.map(String).join('\n') : typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v);
        rows.push([APPROVAL_DETAIL_LABELS[k] || k.replace(/_/g, ' '), text]);
      }
      return rows;
    }
    function approvalStack() {
      let stack = document.getElementById('approval-stack');
      if (!stack) {
        stack = document.createElement('div');
        stack.id = 'approval-stack';
        document.body.appendChild(stack);
      }
      // Sit under the halt / pacing banners when they are up.
      const halt = document.getElementById('hub-halt-banner');
      const pace = document.getElementById('hub-pacing-banner');
      stack.style.top = `${12 + (halt ? halt.offsetHeight : 0) + (pace ? pace.offsetHeight : 0)}px`;
      return stack;
    }
    function upsertApproval(ev) {
      if (!ev || !ev.id) return;
      if (!isHubAdmin()) return;   // members never see approval cards
      if (approvals.has(ev.id)) { approvals.get(ev.id).data = { ...approvals.get(ev.id).data, ...ev }; return; }
      const card = document.createElement('div');
      card.className = 'approval-card';
      card.dataset.id = ev.id;
      const rows = approvalDetailRows(ev);
      card.innerHTML = `
        <div class="approval-head">
          <span class="approval-icon">🔐</span>
          <div class="approval-title">${esc(approvalWants(ev))}</div>
        </div>
        ${ev.capReason ? `<div class="approval-cap">Over a spend cap: ${esc(ev.capReason)}</div>` : ''}
        <div class="approval-summary">${esc(ev.summary || '(no summary)')}</div>
        ${rows.length ? `<details class="approval-details"><summary>Details</summary><dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd></dl>`).join('')}</details>` : ''}
        <div class="approval-meta"><span class="approval-countdown">${esc(approvalCountdown(ev.expiresAt))}</span><span class="approval-note"></span></div>
        <div class="approval-actions">
          <button class="deny" type="button">Deny</button>
          <button class="allow-1h" type="button" title="Also allow this kind of action for this agent for the next hour (for sending: this recipient or host only)">Approve this kind for 1 hour</button>
          <button class="approve" type="button">Approve</button>
        </div>`;
      card.querySelector('.approve').onclick = () => answerApproval(ev.id, 'allow', null);
      card.querySelector('.allow-1h').onclick = () => answerApproval(ev.id, 'allow', '1h');
      card.querySelector('.deny').onclick = () => answerApproval(ev.id, 'deny', null);
      const stack = approvalStack();
      stack.insertBefore(card, stack.firstChild);   // newest on top
      approvals.set(ev.id, { data: ev, card });
      if (!approvalsTimer) approvalsTimer = setInterval(paintApprovalCountdowns, 1000);
    }
    function removeApproval(id, note) {
      const rec = approvals.get(id);
      if (!rec) return;
      approvals.delete(id);
      const done = () => { rec.card.remove(); if (!approvals.size) { approvalStack().remove(); if (approvalsTimer) { clearInterval(approvalsTimer); approvalsTimer = null; } } };
      if (note) {
        rec.card.classList.add('answered');
        rec.card.querySelector('.approval-note').textContent = note;
        for (const b of rec.card.querySelectorAll('button')) b.disabled = true;
        setTimeout(done, 1800);
      } else done();
    }
    function paintApprovalCountdowns() {
      for (const rec of approvals.values()) {
        const el = rec.card.querySelector('.approval-countdown');
        if (el) el.textContent = approvalCountdown(rec.data.expiresAt);
      }
      if (approvals.size) approvalStack();
    }
    // status_snapshot carries every pending card: drop the ones that are gone, add the ones we missed.
    function applyApprovals(list) {
      if (!Array.isArray(list)) return;
      const ids = new Set(list.map(a => a && a.id).filter(Boolean));
      for (const id of [...approvals.keys()]) if (!ids.has(id)) removeApproval(id);
      for (const a of list) upsertApproval(a);
    }
    function onApprovalEvent(ev) {
      if (!ev || !ev.id) return;
      if (ev.type === 'approval_request') upsertApproval(ev);
      else if (ev.type === 'approval_resolved') removeApproval(ev.id, ev.by && ev.by !== 'owner' ? (ev.by === 'timeout' ? 'Timed out: not done' : `${ev.decision === 'allow' ? 'Approved' : 'Denied'} (${ev.by})`) : null);
    }
    async function answerApproval(id, decision, remember) {
      const rec = approvals.get(id);
      if (!rec) return;
      const buttons = [...rec.card.querySelectorAll('button')];
      for (const b of buttons) b.disabled = true;
      const note = rec.card.querySelector('.approval-note');
      note.textContent = 'Sending…';
      try {
        const r = await fetch(`/api/approvals/${encodeURIComponent(id)}`, {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, remember: remember || null }),
        });
        if (r.status === 404) { removeApproval(id, 'Already answered'); return; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        removeApproval(id, decision === 'allow' ? (remember === '1h' ? 'Approved for 1 hour' : 'Approved') : 'Denied');
      } catch (e) {
        note.textContent = `Could not send: ${e.message}`;
        for (const b of buttons) b.disabled = false;
      }
    }

    // Agents loaded dynamically from server
    let AGENTS = [];
    
    const AGENT_COLORS = ['#4ade80', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#34d399', '#fb923c', '#e879f9'];
    
    const chats = {};
    let activeChat = null;
    let chatCounter = 0;
    let selectedGroupAgents = [];
    let selectedSummarizer = null;
    let tigerMode = 'roundtable'; // 'roundtable' or 'led'
    let agentDirectives = {};  // { agentName: "directive text" }
    let editingDirectiveFor = null;

    // (Avatar system removed)

    // (Eyes system removed)

    // (Hardware tab removed)

    // (Eyes/mood functions removed)
    
    // ── Agent Settings / Management ────────────────────────────────────────

    const settingsWindows = {};  // agentName -> popup Window reference

    function openAgentSettings(agentName, event) {
      event.stopPropagation();
      if (settingsWindows[agentName] && !settingsWindows[agentName].closed) {
        settingsWindows[agentName].focus();
        return;
      }
      const popup = window.open(
        `/agent-settings.html?agent=${encodeURIComponent(agentName)}`,
        `settings-${agentName}`,
        'width=700,height=600,resizable=yes,scrollbars=yes'
      );
      if (popup) {
        settingsWindows[agentName] = popup;
        popup.addEventListener('beforeunload', () => { delete settingsWindows[agentName]; });
      }
    }

    function openCreateAgent(event) {
      event.stopPropagation();
      const overlay = document.createElement('div');
      overlay.className = 'question-overlay';
      overlay.innerHTML = `
        <div class="question-modal" style="min-width:480px;max-width:560px;">
          <h3>Create New Agent</h3>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Agent Name <span style="color:var(--accent)">*</span></label>
            <input type="text" id="create-agent-name" placeholder="lowercase letters and numbers (e.g. security, reviewer)"
                   style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;outline:none;">
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Personality & Role <span style="color:var(--accent)">*</span></label>
            <textarea id="create-agent-personality" placeholder="Describe the agent's personality, role, and how it should behave. E.g.: 'A security-focused code reviewer who is thorough but pragmatic. Should flag real vulnerabilities but not bikeshed on style issues. Speaks with authority but explains reasoning.'"
                      style="width:100%;height:100px;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;outline:none;resize:vertical;font-family:inherit;"></textarea>
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Specialty Skills & Knowledge</label>
            <textarea id="create-agent-skills" placeholder="What specific skills or domain expertise should this agent have? E.g.: 'Deep knowledge of OWASP Top 10, Golang security patterns, AWS IAM policies. Can review Terraform configs and Kubernetes manifests.'"
                      style="width:100%;height:80px;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;outline:none;resize:vertical;font-family:inherit;"></textarea>
          </div>
          <div style="display:flex;gap:10px;margin-bottom:12px;">
            <div style="flex:1;">
              <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Model</label>
              <select id="create-agent-model" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;">
                <option value="">Loading models…</option>
              </select>
            </div>
            <div style="flex:1;">
              <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Category</label>
              <select id="create-agent-category" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;">
                <option value="primary" title="Primary agents are the ones you talk to (team heads). Lead powers are a separate checkbox in agent settings.">⭐ Primary Agent</option>
                <option value="specialist" selected>🔬 Domain Specialist</option>
                <option value="worker">⚙️ Worker Agent</option>
                <option value="experimental">🧪 Experimental Agent</option>
              </select>
            </div>
          </div>
          <div id="create-error" style="color:var(--accent);font-size:0.8rem;display:none;margin-bottom:8px;"></div>
          <div id="create-progress" style="font-size:0.8rem;color:var(--text-dim);display:none;margin-bottom:8px;">
            <span class="tool-spinner"></span> Generating personality files...
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button onclick="dialogRequestClose(this)" style="padding:6px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:5px;color:var(--text);cursor:pointer;">Cancel</button>
            <button id="create-confirm-btn" onclick="confirmCreateAgent()" style="padding:6px 14px;background:var(--accent);border:1px solid var(--accent);border-radius:5px;color:#fff;cursor:pointer;">Create</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      // Add the clearly separated OPENAI_CYBER section (direct-key models) to the model dropdown
      loadCyberModels();
      setTimeout(() => document.getElementById('create-agent-name').focus(), 50);
      document.getElementById('create-agent-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmCreateAgent();
      });
      populateModelSelect('create-agent-model');
    }

    // Fill a <select> with the models discovery actually found. Never falls
    // back to a hardcoded list — if discovery returns nothing, say so rather
    // than offering models that may not work.
    async function populateModelSelect(selectId, selected) {
      const sel = document.getElementById(selectId);
      if (!sel) return;
      try {
        const r = await fetch('/api/models', { credentials: 'include' });
        const d = await r.json();
        const models = d.models || [];
        const billing = d.billing || {};
        if (models.length === 0) {
          sel.innerHTML = '<option value="">No models found — check credentials</option>';
          return;
        }
        // Grouped by vendor; each line starts with the route: "API / gpt-6-astra", "Subscription (Claude sign-in) / …".
        sel.innerHTML = groupModels(models).map(([label, rows]) =>
          `<optgroup label="${label}">` + rows.map(m => `<option value="${m}"${m === selected ? ' selected' : ''}>${(billing[m] && billing[m].display) || billingDisplay(m)}</option>`).join('') + '</optgroup>'
        ).join('');
        if (selected && !models.includes(selected)) {
          sel.insertAdjacentHTML('afterbegin',
            `<option value="${selected}" selected>${selected} (not currently available)</option>`);
        }
      } catch (e) {
        sel.innerHTML = `<option value="">Failed to load models: ${e.message}</option>`;
      }
    }

    async function confirmCreateAgent() {
      const input = document.getElementById('create-agent-name');
      const errEl = document.getElementById('create-error');
      const progressEl = document.getElementById('create-progress');
      const btn = document.getElementById('create-confirm-btn');
      const name = input.value.trim().toLowerCase();
      const personality = document.getElementById('create-agent-personality').value.trim();
      const skills = document.getElementById('create-agent-skills').value.trim();
      const model = document.getElementById('create-agent-model').value;
      const category = document.getElementById('create-agent-category').value;

      if (!name || !/^[a-z][a-z0-9]*$/.test(name)) {
        errEl.textContent = 'Invalid name (lowercase letters and numbers, must start with a letter)';
        errEl.style.display = 'block';
        return;
      }
      if (!personality) {
        errEl.textContent = 'Please describe the agent\'s personality and role';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Creating...';
      errEl.style.display = 'none';
      progressEl.style.display = 'block';

      try {
        const r = await fetch('/api/agents/create', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, model, personality, skills, category }),
        });
        const result = await r.json();
        if (result.success) {
          input.closest('.question-overlay').remove();
          await loadAgents();
          openAgentSettings(name, new Event('click'));
        } else {
          errEl.textContent = result.error || 'Create failed';
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
      btn.disabled = false;
      btn.textContent = 'Create';
      progressEl.style.display = 'none';
    }

    function openCloneAgent(event) {
      event.stopPropagation();
      const overlay = document.createElement('div');
      overlay.className = 'question-overlay';
      overlay.innerHTML = `
        <div class="question-modal" style="min-width:320px;">
          <h3>Clone Agent</h3>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">Source Agent</label>
            <select id="clone-source" style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;">
              ${AGENTS.map(a => `<option value="${a.name}">${a.name}</option>`).join('')}
            </select>
          </div>
          <div style="margin-bottom:12px;">
            <label style="display:block;font-size:0.8rem;color:var(--text-dim);margin-bottom:4px;">New Name</label>
            <input type="text" id="clone-new-name" placeholder="lowercase letters and numbers"
                   style="width:100%;padding:8px 10px;background:var(--bg-input);color:var(--text);border:1px solid var(--border);border-radius:5px;font-size:0.85rem;outline:none;">
          </div>
          <div id="clone-error" style="color:var(--accent);font-size:0.8rem;display:none;margin-bottom:8px;"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end;">
            <button onclick="dialogRequestClose(this)" style="padding:6px 14px;background:var(--bg-input);border:1px solid var(--border);border-radius:5px;color:var(--text);cursor:pointer;">Cancel</button>
            <button id="clone-confirm-btn" onclick="confirmCloneAgent()" style="padding:6px 14px;background:var(--accent);border:1px solid var(--accent);border-radius:5px;color:#fff;cursor:pointer;">Clone</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);
      setTimeout(() => document.getElementById('clone-new-name').focus(), 50);
      document.getElementById('clone-new-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') confirmCloneAgent();
      });
    }

    async function confirmCloneAgent() {
      const source = document.getElementById('clone-source').value;
      const input = document.getElementById('clone-new-name');
      const errEl = document.getElementById('clone-error');
      const btn = document.getElementById('clone-confirm-btn');
      const name = input.value.trim().toLowerCase();

      if (!name || !/^[a-z][a-z0-9]*$/.test(name)) {
        errEl.textContent = 'Invalid name (lowercase letters and numbers, must start with a letter)';
        errEl.style.display = 'block';
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Cloning...';
      errEl.style.display = 'none';

      try {
        const r = await fetch('/api/agents/clone', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, name }),
        });
        const result = await r.json();
        if (result.success) {
          input.closest('.question-overlay').remove();
          await loadAgents();
          openAgentSettings(name, new Event('click'));
        } else {
          errEl.textContent = result.error || 'Clone failed';
          errEl.style.display = 'block';
        }
      } catch (e) {
        errEl.textContent = e.message;
        errEl.style.display = 'block';
      }
      btn.disabled = false;
      btn.textContent = 'Clone';
    }

    // Listen for updates from settings popup windows
    window.addEventListener('message', (event) => {
      const { type } = event.data || {};
      if (type === 'agent-updated' || type === 'agent-deleted' || type === 'agent-renamed') {
        if (type === 'agent-deleted' && event.data.agent) {
          delete settingsWindows[event.data.agent];
        }
        if (type === 'agent-renamed' && event.data.oldName) {
          delete settingsWindows[event.data.oldName];
        }
        loadAgents();
      }
    });

    let CYBER_MODELS = new Set();
    let CYBER_TAG = 'OPENAI_CYBER';
    async function loadAgents() {
      try {
        // Admins pick whose agents the sidebar lists; the server ignores the query for members.
        const ownerQuery = window.hubMe && window.hubMe.isAdmin ? `?owner=${encodeURIComponent(ownerView())}` : '';
        const response = await fetch('/api/agents' + ownerQuery, { credentials: 'include' });
        const data = await response.json();
        AGENTS = data.agents || [];
        for (const a of AGENTS) { if (a.owner) agentOwnerCache.set(a.name, a.owner); else agentOwnerCache.delete(a.name); }
        if (!CYBER_MODELS.size) loadCyberModels();
        // Newer hubs report busy/busySince/activity/pendingQuestion per agent; older ones do not (then no dots are drawn).
        if (AGENTS.some(a => 'busy' in a)) {
          const map = {};
          for (const a of AGENTS) map[a.name] = { busy: a.busy, busySince: a.busySince, activity: a.activity, pendingQuestion: a.pendingQuestion };
          applyStatusSnapshot(map);
        }
        console.log(`Loaded ${AGENTS.length} agents with SOUL data`);
        AGENTS.forEach(a => {
          if (a.soul) console.log(`  ${a.name}: ${a.soul.length} chars of SOUL`);
        });
        renderAgents();
      } catch (err) {
        console.error('Failed to load agents:', err);
        // Fallback to empty - user will need to reload
        AGENTS = [];
        renderAgents();
      }
    }
    
    document.addEventListener('DOMContentLoaded', async () => {
      await loadMe();
      applyMemberView();
      renderOwnerSwitcher();
      renderUserChip();
      document.addEventListener('click', (e) => { if (!e.target.closest('#user-chip-wrap')) toggleAccountMenu(false); });
      if (new URLSearchParams(location.search).get('security') === '1') openSecurityDialog();
      await Promise.all([loadAgents()]);
      // "/?agent=<name>" opens that agent's chat (the Welcome page hands over to Maestro's setup interview this way).
      { const want = new URLSearchParams(location.search).get('agent'); const a = want && AGENTS.find(x => x.name === want); if (a) startSoloChat(a.name, a.model); }
      setupTabs();
      setupConfigListeners();
      startHubHealthMonitor();
      startHubEventMonitor();
      refreshSpendToday();
      refreshPlanChip();
      showMobileBanner();
      // Check for pending restart action on page load (user may have refreshed)
      setTimeout(() => checkPendingRestartAction(), 1500);
      // Check if this page load is after a manual restart
      setTimeout(() => checkManualRestartComplete(), 2000);
    });

    function showMobileBanner() {
      if (window.innerWidth >= 700 || localStorage.getItem('hub-mobile-banner') === 'off') return;
      const bar = document.createElement('div');
      bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;display:flex;align-items:center;justify-content:space-between;padding:6px 12px;background:#14171F;border-bottom:1px solid #222632;color:#F3F4F6;font-size:13px';
      bar.innerHTML = '<a href="/mobile" style="color:#5A93FF;text-decoration:none">Phone? Try the mobile view</a><button aria-label="Dismiss" style="background:none;border:0;color:#9CA3AF;font-size:16px;padding:4px 8px">\u2715</button>';
      bar.querySelector('button').addEventListener('click', () => { localStorage.setItem('hub-mobile-banner', 'off'); bar.remove(); });
      document.body.appendChild(bar);
    }

    // ── Hub Health Monitor ──
    // Detects hub restarts and resets stuck "thinking" states
    // Shows resume popup if there's a pending restart action
    let hubWasDown = false;
    function startHubHealthMonitor() {
      setInterval(async () => {
        try {
          const r = await fetch('/api/agents', { credentials: 'include', signal: AbortSignal.timeout(5000) });
          if (r.ok) {
            if (hubWasDown) {
              hubWasDown = false;
              console.log('[Hub Monitor] Hub is back online — re-attaching chats that were mid-reply');
              // A stream that was open when the hub went away is dead; drop it and re-attach to
              // whatever the server has (the reply may be in history, or the turn may still run).
              for (const [chatId, chat] of Object.entries(chats)) {
                if (chat.status !== 'thinking') continue;
                if (chat.reattach) { reattachCheck(chatId); catchUpTurn(chatId); continue; }
                if (chat.controller) {
                  console.log(`[Hub Monitor] Re-attaching chat ${chatId} (${chat.agent})`);
                  chat.forceReattach = true;
                  try { chat.controller.abort(); } catch {}
                }
              }
              // Check for pending restart action
              checkPendingRestartAction();
            }
          } else {
            hubWasDown = true;
          }
        } catch {
          hubWasDown = true;
        }
      }, 5000); // Check every 5 seconds
    }

    // ── Pending Restart Action Popup ──
    async function checkPendingRestartAction() {
      try {
        const r = await fetch('/api/restart/pending', { credentials: 'include' });
        if (r.status === 204 || !r.ok) return; // No pending action
        const pending = await r.json();
        if (!pending || !pending.resume_message) return;

        console.log('[Hub Monitor] Found pending restart action:', pending);
        showResumePopup(pending);
      } catch (e) {
        console.error('[Hub Monitor] Error checking pending restart action:', e);
      }
    }

    async function checkManualRestartComplete() {
      const ts = localStorage.getItem('hub-manual-restart');
      if (!ts) return;
      localStorage.removeItem('hub-manual-restart');
      // Only show if restart was recent (within 60 seconds)
      if (Date.now() - parseInt(ts, 10) > 60000) return;

      // Run quick health checks
      const checks = [];
      try {
        const r = await fetch('/api/health', { credentials: 'include', signal: AbortSignal.timeout(5000) });
        checks.push({ name: 'Server', ok: r.ok });
      } catch { checks.push({ name: 'Server', ok: false }); }
      try {
        const r = await fetch('/api/agents', { credentials: 'include', signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const data = await r.json();
          const agents = data.agents || data;
          const count = Array.isArray(agents) ? agents.length : Object.keys(agents).length;
          checks.push({ name: 'Agents', ok: true, detail: `${count} loaded` });
        } else { checks.push({ name: 'Agents', ok: false }); }
      } catch { checks.push({ name: 'Agents', ok: false }); }
      try {
        const r = await fetch('/api/models', { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (r.ok) {
          const data = await r.json();
          const models = data.models || data;
          const count = Array.isArray(models) ? models.length : Object.keys(models).length;
          checks.push({ name: 'Models', ok: true, detail: `${count} available` });
        } else { checks.push({ name: 'Models', ok: false }); }
      } catch { checks.push({ name: 'Models', ok: false }); }

      const allOk = checks.every(c => c.ok);
      showRestartNotification(checks, allOk);
    }

    function showRestartNotification(checks, allOk) {
      const existing = document.getElementById('restart-notify-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'restart-notify-overlay';
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

      const popup = document.createElement('div');
      popup.style.cssText = 'background:var(--bg-secondary, #1e1e1e);border:1px solid var(--border-color, #444);border-radius:12px;padding:24px;max-width:420px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

      const icon = document.createElement('div');
      icon.style.cssText = 'font-size:28px;margin-bottom:12px;';
      icon.textContent = allOk ? '✅' : '⚠️';

      const title = document.createElement('h3');
      title.style.cssText = 'margin:0 0 16px 0;color:var(--text-primary, #fff);font-size:16px;';
      title.textContent = allOk ? 'Restarted successfully' : 'Restarted — issues detected';

      const checkList = document.createElement('div');
      checkList.style.cssText = 'margin-bottom:20px;';
      for (const c of checks) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;color:var(--text-primary, #ddd);font-size:14px;';
        const statusIcon = c.ok ? '✅' : '❌';
        const detail = c.detail ? ` — ${c.detail}` : '';
        row.textContent = `${statusIcon} ${c.name}${detail}`;
        checkList.appendChild(row);
      }

      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;justify-content:flex-end;';
      const okBtn = document.createElement('button');
      okBtn.textContent = 'OK';
      okBtn.style.cssText = 'padding:8px 24px;border-radius:6px;border:none;background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;font-weight:600;';
      okBtn.onclick = () => overlay.remove();
      buttons.appendChild(okBtn);

      popup.appendChild(icon);
      popup.appendChild(title);
      popup.appendChild(checkList);
      popup.appendChild(buttons);
      overlay.appendChild(popup);
      document.body.appendChild(overlay);

      // Auto-dismiss after 10 seconds if all OK
      if (allOk) setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 10000);
    }

    function showResumePopup(pending) {
      // Remove any existing popup
      const existing = document.getElementById('resume-popup-overlay');
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = 'resume-popup-overlay';
      overlay.dataset.dialogPersistent = '1';   // Resume or not is a choice: Esc and the backdrop leave it open
      overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';

      const popup = document.createElement('div');
      popup.style.cssText = 'background:var(--bg-secondary, #1e1e1e);border:1px solid var(--border-color, #444);border-radius:12px;padding:24px;max-width:500px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.4);';

      const icon = document.createElement('div');
      icon.style.cssText = 'font-size:28px;margin-bottom:12px;';
      icon.textContent = '🔄';

      const title = document.createElement('h3');
      title.style.cssText = 'margin:0 0 8px 0;color:var(--text-primary, #fff);font-size:16px;';
      title.textContent = 'Restarted — resume?';

      const reason = document.createElement('div');
      reason.style.cssText = 'color:var(--text-secondary, #aaa);font-size:12px;margin-bottom:12px;';
      reason.textContent = `Restart reason: ${pending.reason || 'N/A'}`;

      const message = document.createElement('div');
      message.style.cssText = 'color:var(--text-primary, #ddd);font-size:14px;margin-bottom:20px;line-height:1.5;background:var(--bg-tertiary, #2a2a2a);padding:12px;border-radius:8px;';
      message.textContent = pending.resume_message;

      const buttons = document.createElement('div');
      buttons.style.cssText = 'display:flex;gap:12px;justify-content:flex-end;';

      const noBtn = document.createElement('button');
      noBtn.textContent = 'Dismiss';
      noBtn.style.cssText = 'padding:8px 20px;border-radius:6px;border:1px solid var(--border-color, #555);background:transparent;color:var(--text-primary, #ccc);cursor:pointer;font-size:13px;';
      noBtn.onclick = async () => {
        overlay.remove();
        await fetch('/api/restart/pending', { method: 'DELETE', credentials: 'include' });
      };

      const yesBtn = document.createElement('button');
      yesBtn.textContent = '▶ Resume';
      yesBtn.style.cssText = 'padding:8px 20px;border-radius:6px;border:none;background:#4CAF50;color:#fff;cursor:pointer;font-size:13px;font-weight:600;';
      yesBtn.onclick = async () => {
        overlay.remove();
        await fetch('/api/restart/pending', { method: 'DELETE', credentials: 'include' });
        const agentName = pending.agent;
        if (!agentName || agentName === 'unknown') {
          console.error('[Resume] No agent name in pending action');
          return;
        }

        // Find the agent in AGENTS list to get its model
        const agentData = AGENTS.find(a => a.name === agentName);
        if (!agentData) {
          console.error('[Resume] Agent not found:', agentName);
          return;
        }

        // Check if there's already a chat open for this agent
        let targetChatId = null;
        for (const [cid, chat] of Object.entries(chats)) {
          if (chat.agent === agentName) { targetChatId = cid; break; }
        }

        if (targetChatId) {
          // Switch to existing chat
          const tabEl = document.querySelector(`.chat-tab[data-chat-id="${targetChatId}"]`);
          if (tabEl) tabEl.click();
        } else {
          // Open a new chat for this agent
          startSoloChat(agentName, agentData.model);
          // Find the newly created chat ID
          for (const [cid, chat] of Object.entries(chats)) {
            if (chat.agent === agentName) { targetChatId = cid; break; }
          }
        }

        if (!targetChatId) {
          console.error('[Resume] Could not create chat for agent:', agentName);
          return;
        }

        // Wait for the chat panel to render, then send the message
        setTimeout(() => {
          const input = document.getElementById(`input-${targetChatId}`);
          if (input) {
            input.value = `[RESTART COMPLETED — DO NOT restart again] The server has already restarted successfully. The user approved resuming. Here is what you were doing before the restart: ${pending.resume_message}`;
            sendSoloMessage(targetChatId);
          } else {
            console.error('[Resume] Could not find input for chat:', targetChatId);
          }
        }, 500);
      };

      buttons.appendChild(noBtn);
      buttons.appendChild(yesBtn);
      popup.appendChild(icon);
      popup.appendChild(title);
      popup.appendChild(reason);
      popup.appendChild(message);
      popup.appendChild(buttons);
      overlay.appendChild(popup);
      document.body.appendChild(overlay);
    }

    async function testConnection() {
      const btn = event.target;
      btn.textContent = '⏳ Testing...';
      btn.disabled = true;
      
      try {
        const response = await fetch('/api/agents', { credentials: 'include' });
        const data = await response.json();
        const agents = data.agents || [];
        alert(`✅ Connected!\n\n${agents.length} agents available:\n${agents.slice(0,8).map(a => a.name).join(', ')}${agents.length > 8 ? '...' : ''}`);
        btn.textContent = '✅ Connected';
      } catch (err) {
        alert(`❌ Connection failed\n\nError: ${err.message}`);
        btn.textContent = '❌ Failed';
      }
      
      setTimeout(() => {
        btn.textContent = '🔌 Test Connection';
        btn.disabled = false;
      }, 3000);
    }
    
    function setupConfigListeners() {
      document.getElementById('discussion-type').addEventListener('change', updateConfigUI);
      document.getElementById('context-mode').addEventListener('change', updateConfigUI);
      updateConfigUI();
      // Robot selector
      const robotSel = document.getElementById('active-robot-select');
      if (robotSel) {
        robotSel.addEventListener('change', async () => {
          try {
            await fetch('/api/robot/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ robot: robotSel.value }) });
          } catch (e) { console.error('Failed to switch robot:', e); }
        });
      }
    }
    
    function updateConfigUI() {
      const type = document.getElementById('discussion-type').value;
      const contextMode = document.getElementById('context-mode').value;
      const hint = document.getElementById('config-hint');
      const topicInput = document.getElementById('topic-input') || document.getElementById('topic-input-top');
      const contextN = document.getElementById('context-n');
      
      if (topicInput) topicInput.style.display = 'block'; // Always visible
      document.getElementById('context-n-label').style.display = contextMode === 'last-n' ? 'block' : 'none';
      
      if (tigerMode === 'led') {
        const leader = document.getElementById('led-leader')?.value;
        const workers = selectedGroupAgents.filter(a => a.name !== leader);
        if (!leader) {
          hint.textContent = 'Select a leader agent above';
          hint.style.color = 'var(--warning)';
        } else if (workers.length === 0) {
          hint.textContent = 'Add worker agents with [+] buttons';
          hint.style.color = 'var(--warning)';
        } else {
          hint.textContent = `Ready — ${workers.length} worker${workers.length > 1 ? 's' : ''} assigned`;
          hint.style.color = 'var(--success)';
        }
      } else if (type === 'moderated' && !selectedSummarizer) {
        hint.textContent = 'Select a summarizer with [S] button';
        hint.style.color = 'var(--warning)';
      } else if (selectedGroupAgents.length < 1) {
        hint.textContent = 'Select 1+ agents with [+] buttons';
        hint.style.color = 'var(--text-dim)';
      } else {
        hint.textContent = 'Ready to start!';
        hint.style.color = 'var(--success)';
      }
      
      updateStartButton();
    }
    
    function updateStartButton() {
      const type = document.getElementById('discussion-type').value;
      const btn = document.getElementById('start-group-btn');
      if (!btn) return;
      const needsSummarizer = type === 'moderated';
      
      let shouldDisable;
      if (tigerMode === 'led') {
        const leader = document.getElementById('led-leader')?.value;
        const workers = selectedGroupAgents.filter(a => a.name !== leader);
        shouldDisable = !leader;
        console.log('[updateStartButton] LED mode: leader=', leader, 'workers=', workers.length, 'disable=', shouldDisable);
      } else {
        shouldDisable = selectedGroupAgents.length < 1 || (needsSummarizer && !selectedSummarizer);
        console.log('[updateStartButton] RT mode: agents=', selectedGroupAgents.length, 'disable=', shouldDisable);
      }
      btn.disabled = shouldDisable;
    }
    
    function capName(name) { return name.charAt(0).toUpperCase() + name.slice(1); }

    function renderAgents() {
      const panel = document.getElementById('agent-list');

      const categories = [
        { key: 'primary', label: '⭐ Primary Agents', icon: '⭐' },   // the agents the owner talks to; lead powers are the per-agent `lead` flag (👑)
        { key: 'specialist', label: '🔬 Domain Specialists', icon: '🔬' },
        { key: 'worker', label: '⚙️ Worker Agents', icon: '⚙️' },
        { key: 'experimental', label: '🧪 Experimental Agents', icon: '🧪' }
      ];

      const grouped = { primary: [], specialist: [], worker: [], experimental: [] };
      AGENTS.forEach(a => {
        const cat = a.category || 'specialist';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(a);
      });
      // Sort within each category
      // Lead agents (👑) first within their group, then alphabetical
      Object.values(grouped).forEach(list => list.sort((a, b) => {
        if (!!a.lead !== !!b.lead) return a.lead ? -1 : 1;
        const da = (a.display || a.name).toLowerCase();
        const db = (b.display || b.name).toLowerCase();
        return da.localeCompare(db);
      }));

      const groupActions = !isHubAdmin() ? '' : `<div style="display:flex;gap:6px;margin-bottom:10px;">
        <span class="group-action-btn" onclick="openCreateAgent(event)" title="Create new agent">+ New Agent</span>
        <span class="group-action-btn" onclick="openCloneAgent(event)" title="Clone existing agent">Clone</span>
      </div>`;

      let html = groupActions;
      categories.forEach(cat => {
        const agents = grouped[cat.key] || [];
        if (agents.length === 0) return;
        const collapsed = localStorage.getItem(`cat-collapsed-${cat.key}`) === 'true';
        html += `
          <div class="agent-group" data-category="${cat.key}">
            <div class="agent-group-title" onclick="toggleCategoryCollapse('${cat.key}', this)">
              <span class="collapse-arrow ${collapsed ? 'collapsed' : ''}">\u25BC</span>
              <span>${cat.label}</span>
            </div>
            <div class="agent-group-items" style="${collapsed ? 'display:none' : ''}">
              ${agents.map(a => agentButton(a)).join('')}
            </div>
          </div>
        `;
      });

      panel.innerHTML = html;

      panel.querySelectorAll('.agent-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          if (!e.target.classList.contains('action-btn')) {
            startSoloChat(btn.dataset.agent, btn.dataset.model);
          }
        });
      });
      paintAllAgentStatus();
      renderAgentPicker();
    }

    function toggleCategoryCollapse(key, el) {
      const items = el.parentElement.querySelector('.agent-group-items');
      const arrow = el.querySelector('.collapse-arrow');
      const collapsed = items.style.display !== 'none';
      items.style.display = collapsed ? 'none' : '';
      arrow.classList.toggle('collapsed', collapsed);
      localStorage.setItem(`cat-collapsed-${key}`, collapsed);
    }
    
    // Direct-OpenAI-key ("Cyber") models.  Filled from /api/models; used to tag
    // every place a model name is shown so they are never mistaken for gateway models.
    function isCyberModel(m) { return CYBER_MODELS.has(m); }
    function cyberHeaderTag(model) {
      return isCyberModel(model)
        ? ` <span class="cyber-tag" title="Served directly from api.openai.com with the dedicated OpenAI key - NOT via the LLM Gateway">${CYBER_TAG}</span>`
        : '';
    }
    async function loadCyberModels() {
      try {
        const r = await fetch('/api/models');
        const d = await r.json();
        CYBER_MODELS = new Set(d.cyber || []);
        CYBER_TAG = d.cyberTag || CYBER_TAG;
        // Add a clearly separated section to the "create agent" model dropdown
        const sel = document.getElementById('create-agent-model');
        if (sel && CYBER_MODELS.size && !sel.querySelector('optgroup.cyber-group')) {
          const og = document.createElement('optgroup');
          og.className = 'cyber-group';
          og.label = `\u26A0 ${CYBER_TAG} - direct OpenAI key, NOT via LLM Gateway`;
          og.style.color = '#ffb347';
          for (const m of CYBER_MODELS) {
            const o = document.createElement('option');
            o.value = m;
            o.textContent = `[${CYBER_TAG}] ${m.replace(/^cyber\//, '')}`;
            o.style.color = '#ffb347';
            og.appendChild(o);
          }
          sel.appendChild(og);
        }
      } catch (e) { console.warn('loadCyberModels failed', e.message); }
    }

    function agentButton(agent) {
      const shortModel = agent.autoModel ? 'Auto' : agent.model.split('/').pop().substring(0, 24);
      const inGroup = selectedGroupAgents.some(a => a.name === agent.name);
      const isSummarizer = selectedSummarizer?.name === agent.name;
      // Every agent-supplied field (display, specialty, blurb, icon, model) is escaped: a stored name must
      // never become markup, whatever the server accepted or an older agents.json holds.
      const displayName = hubEsc(agent.display || capName(agent.name));
      const subtitle = hubEsc(agent.specialty || shortModel);
      const safeName = hubEsc(agent.name);
      const safeModel = hubEsc(agent.model || '');

      // Model status badge: NO MODEL (red) or OFFLINE (yellow) when model isn't available
      let statusBadge = '';
      if (agent.modelStatus === 'no_model') {
        statusBadge = '<span class="no-model">NO MODEL</span>';
      } else if (agent.modelStatus === 'offline') {
        statusBadge = '<span class="model-offline">OFFLINE</span>';
      }

      const sizeLabel = (!statusBadge && agent.modelSize != null)
        ? `<span class="model-size">${agent.modelSize >= 1 ? Math.round(agent.modelSize) + 'B' : agent.modelSize + 'B'}</span>`
        : '';
      // Direct-OpenAI-key models are tagged so they are never mistaken for gateway models
      const cyberBadge = agent.transport === 'OPENAI_CYBER'
        ? `<span class="cyber-tag" title="Served directly from api.openai.com with the dedicated OpenAI key - NOT via the LLM Gateway">OPENAI_CYBER</span>`
        : (/^(anthropic|openai|google|perplexity)\//.test(String(agent.model || ''))
          ? `<span class="cyber-tag billing-api" title="This agent runs on a provider API key: billed per token to your API credits, not to a subscription">API $</span>`
          : '');

      const tip = hubEsc(agent.blurb || `${capName(agent.category || 'specialist')} agent · ${shortModel}`);
      return `<button class="agent-btn ${hubEsc(agent.type || '')} ${inGroup ? 'in-group' : ''} ${isSummarizer ? 'is-summarizer' : ''}"
                      data-agent="${safeName}" data-model="${safeModel}" id="agent-btn-${safeName}" title="${tip}">
        <span class="agent-status" id="agent-status-${safeName}"></span>
        ${isHubAdmin() ? `<span class="action-btn gear-btn" onclick="openAgentSettings('${safeName}', event)" title="Agent settings">&#9881;</span>` : ''}
        <span class="agent-icon">${hubEsc(agent.icon || '🤖')}</span>
        <span class="agent-info">
          <span class="name">${displayName}${agent.lead ? '<span class="lead-badge" title="Lead agent: may schedule tasks for other agents and see, edit or cancel their tasks. Change in this agent\'s settings.">👑</span>' : ''}</span>
          <span class="model">${cyberBadge}${subtitle}${statusBadge || sizeLabel}</span>
        </span>
        <span class="actions">
          <span class="action-btn add-btn" onclick="toggleGroupAgent('${safeName}', '${safeModel}', event)">${inGroup ? '−' : '+'}</span>
          <span class="action-btn sum-btn" onclick="setSummarizer('${safeName}', '${safeModel}', event)">S</span>
        </span>
      </button>`;
    }
    
    function toggleGroupAgent(name, model, event) {
      event.stopPropagation();
      const idx = selectedGroupAgents.findIndex(a => a.name === name);
      if (idx >= 0) {
        selectedGroupAgents.splice(idx, 1);
        if (selectedSummarizer?.name === name) selectedSummarizer = null;
      } else {
        // Include SOUL data when adding agent
        const agentData = AGENTS.find(a => a.name === name);
        selectedGroupAgents.push({ name, model, soul: agentData?.soul || '' });
      }
      updateGroupBuilder();
      renderAgents();
      updateConfigUI();
    }
    
    function setSummarizer(name, model, event) {
      event.stopPropagation();
      if (selectedSummarizer?.name === name) {
        selectedSummarizer = null;
      } else {
        const agentData = AGENTS.find(a => a.name === name);
        selectedSummarizer = { name, model, soul: agentData?.soul || '' };
        if (!selectedGroupAgents.some(a => a.name === name)) {
          selectedGroupAgents.push({ name, model, soul: agentData?.soul || '' });
        }
      }
      updateGroupBuilder();
      renderAgents();
      updateConfigUI();
    }
    
    function renderAgentPicker() {
      const picker = document.getElementById('tt-agent-picker');
      if (!picker || !AGENTS) return;
      picker.innerHTML = AGENTS.map(a => {
        const selected = selectedGroupAgents.some(g => g.name === a.name);
        const display = hubEsc(a.display || capName(a.name));
        const icon = hubEsc(a.icon || '🤖');
        const cat = a.category === 'worker' ? 'Worker' : a.category === 'specialist' ? 'Specialist' : a.category === 'experimental' ? 'Experimental' : 'Primary';
        return `<div onclick="toggleGroupAgent('${hubEsc(a.name)}', '${hubEsc(a.model || '')}', event)"
                     class="tt-pick${selected ? ' tt-picked' : ''}"
                     style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; padding:10px 6px; border-radius:8px; cursor:pointer; 
                            background:${selected ? 'var(--purple)' : 'var(--bg-card)'}; color:${selected ? 'white' : 'var(--text)'}; 
                            border:1px solid ${selected ? 'var(--purple)' : 'var(--border)'}; transition:all 0.15s ease;">
          <span style="font-size:22px;">${icon}</span>
          <span style="font-size:12px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; text-align:center;">${display}</span>
          <span style="font-size:9px; opacity:0.6; text-transform:uppercase; letter-spacing:0.5px;">${cat}</span>
        </div>`;
      }).join('');
    }

    function updateGroupBuilder() {
      const container = document.getElementById('selected-agents');
      
      if (selectedGroupAgents.length === 0) {
        container.innerHTML = '';
      } else {
        container.innerHTML = selectedGroupAgents.map((a, i) => {
          const isSummarizer = selectedSummarizer?.name === a.name;
          const hasDirective = agentDirectives[a.name];
          const display = hubEsc(AGENTS.find(ag => ag.name === a.name)?.display || capName(a.name));
          return `<span class="selected-agent ${isSummarizer ? 'summarizer' : ''}" style="${!isSummarizer ? 'background:' + AGENT_COLORS[i % AGENT_COLORS.length] : ''}">
            ${isSummarizer ? '📋 ' : ''}${hasDirective ? '📝 ' : ''}<span onclick="openDirectiveEditor('${hubEsc(a.name)}', event)" style="cursor:pointer;" title="${hasDirective ? 'Edit directive' : 'Add directive'}">${display}</span>
            <span class="remove" onclick="toggleGroupAgent('${hubEsc(a.name)}', '${hubEsc(a.model || '')}', event)">✕</span>
          </span>`;
        }).join('');
      }
      renderAgentPicker();
      updateStartButton();
    }
    
    function openDirectiveEditor(agentName, event) {
      event?.stopPropagation();
      editingDirectiveFor = agentName;
      document.getElementById('directive-agent-name').textContent = agentName;
      document.getElementById('directive-input').value = agentDirectives[agentName] || '';
      document.getElementById('directive-editor').style.display = 'block';
      document.getElementById('directive-input').focus();
    }
    
    function closeDirectiveEditor() {
      document.getElementById('directive-editor').style.display = 'none';
      editingDirectiveFor = null;
    }
    
    function saveDirective() {
      if (!editingDirectiveFor) return;
      const directive = document.getElementById('directive-input').value.trim();
      if (directive) {
        agentDirectives[editingDirectiveFor] = directive;
      } else {
        delete agentDirectives[editingDirectiveFor];
      }
      closeDirectiveEditor();
      updateGroupBuilder();
    }
    
    function setupTabs() {
      document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
          tab.classList.add('active');
          document.getElementById(`${tab.dataset.tab}-panel`).classList.add('active');
        });
      });
    }
    
    function findSoloChat(agentName) {
      return Object.values(chats).find(c => c && !c.isGroup && !c.isWorker && c.agent === agentName) || null;
    }

    // Agent settings changed elsewhere (the settings page, another device): the sidebar and an open chat of that
    // agent follow without a reload. The server already uses the new model from the next turn; a chat that is
    // mid-turn finishes on the old model, shows "→ <model> after this turn", and relabels when the turn ends.
    function onAgentUpdated(ev) {
      if (!ev || !ev.agent) return;
      loadAgents().catch(() => {});
      const chat = findSoloChat(ev.agent);
      if (!chat) return;
      const busy = () => !!(chat.controller || chat.reattach || chat.status === 'thinking' || agentStatus[chat.agent]?.busy);
      const label = () => document.querySelector(`#panel-${chat.id} .chat-actions .agent-name`);
      const apply = () => {
        if (ev.model) chat.model = ev.model;
        if (ev.display) chat.display = ev.display;
        if (ev.icon) chat.icon = ev.icon;
        if ('autoModel' in ev) chat.autoModel = !!ev.autoModel;
        if (ev.effort) chat.effort = ev.effort;
        refreshEffortPick(chat);
        paintPlanBadges();
        const span = label();
        if (span) {
          const text = span.querySelector('.agent-name-text');
          const sel = span.querySelector('.model-pick');
          if (text) text.textContent = chat.display || capName(chat.agent);
          else span.textContent = `${chat.display || capName(chat.agent)} (${chat.autoModel ? 'Auto' : String(chat.model || '').split('/').pop()})`;
          if (sel) {
            const m = String(chat.model || '');
            if (m && ![...sel.options].some(o => o.value === m)) sel.insertAdjacentHTML('afterbegin', `<option value="${esc(m)}">${esc(chat.autoModel ? 'Auto' : billingDisplay(m, true))}</option>`);
            sel.value = m;
          }
        }
        if (chat._pendingAgentNote) { chat._pendingAgentNote.remove(); chat._pendingAgentNote = null; }
      };
      if (!busy()) { apply(); return; }
      const span = label();
      if (span && ev.model && ev.model !== chat.model && !chat._pendingAgentNote) {
        const n = document.createElement('span'); n.className = 'agent-switch-note'; n.style.cssText = 'opacity:.7;font-size:.85em;margin-left:6px';
        n.textContent = `→ ${String(ev.model).split('/').pop()} after this turn`; span.after(n); chat._pendingAgentNote = n;
      }
      if (chat._agentUpdateTimer) clearInterval(chat._agentUpdateTimer);
      chat._agentUpdateTimer = setInterval(() => {
        if (!chats[chat.id]) { clearInterval(chat._agentUpdateTimer); return; }
        if (!busy()) { clearInterval(chat._agentUpdateTimer); chat._agentUpdateTimer = null; apply(); }
      }, 1000);
    }

    // Who pays, from the model id alone (mirrors lib/billing so the header can say it before any list is fetched):
    // "Subscription (Claude sign-in) / claude-fable-5-1", "API / gpt-6-astra", "Local (ninfer) / qwen3.8-27b".
    const VENDOR_OF = { 'claude-sdk': 'Anthropic', anthropic: 'Anthropic', 'codex-cli': 'OpenAI', codex: 'OpenAI', openai: 'OpenAI', google: 'Google', perplexity: 'Perplexity', openrouter: 'OpenRouter', lmstudio: 'Local', ollama: 'Local', omlx: 'Local', ninfer: 'Local', local: 'Local' };
    const VENDOR_ORDER = ['Anthropic', 'OpenAI', 'Google', 'Perplexity', 'OpenRouter', 'Local'];
    function billingDisplay(model, compact = false) {
      const m = String(model || ''); const p = m.includes('/') ? m.split('/')[0] : ''; const name = m.includes('/') ? m.slice(m.indexOf('/') + 1) : m;
      const full = p === 'claude-sdk' ? 'Subscription (Claude sign-in)' : (p === 'codex-cli' || p === 'codex') ? 'Subscription (ChatGPT)' : ['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].includes(p) ? 'API $' : ['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(p) ? `Local (${p})` : '?';
      const short = full.startsWith('Subscription') ? 'Subscription' : full.startsWith('Local') ? 'Local' : full;
      return `${name} · ${compact ? short : full}`;   // model first: the name is what the operator looks for
    }
    function vendorOf(model) { const p = String(model || '').split('/')[0]; return VENDOR_OF[p] || (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Other'); }
    function vendorRank(v) { const i = VENDOR_ORDER.indexOf(v); return i < 0 ? VENDOR_ORDER.length : i; }
    // Pickers group by vendor AND route, so subscription and API models never interleave:
    // "Anthropic · Subscription (Claude sign-in)", "Anthropic · API $", "OpenAI · Subscription (ChatGPT)", "OpenAI · API $", "Local".
    const ROUTE_ORDER = ['Subscription', 'API', 'Local', '?'];
    function routeOf(model) { const p = String(model || '').split('/')[0]; return p === 'claude-sdk' || p === 'codex-cli' || p === 'codex' ? 'Subscription' : ['anthropic', 'openai', 'google', 'perplexity', 'openrouter'].includes(p) ? 'API' : ['lmstudio', 'ollama', 'omlx', 'ninfer', 'local'].includes(p) ? 'Local' : '?'; }
    function pickerGroup(model) {
      const v = vendorOf(model); const r = routeOf(model);
      const full = billingDisplay(model).split(' · ')[1] || r;
      return { key: v === 'Local' ? 'Local' : `${v} · ${full}`, rank: vendorRank(v) * 10 + ROUTE_ORDER.indexOf(r) };
    }
    function groupModels(models) {
      const groups = new Map();
      for (const m of models) { const g = pickerGroup(m); if (!groups.has(g.key)) groups.set(g.key, { rank: g.rank, models: [] }); groups.get(g.key).models.push(m); }
      return [...groups.entries()].sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0])).map(([key, g]) => [key, g.models.slice().sort((x, y) => billingDisplay(x, true).localeCompare(billingDisplay(y, true)))]);
    }
    // Model picker in the chat header: the operator changes the agent's model from inside the session. Same route as
    // the settings page (/api/agents/:name/model); the hub's agent_updated event then relabels the header, or notes
    // "after this turn" while the agent is busy. The list comes from /api/models, grouped by provider, fetched once.
    let __modelListCache = null;
    async function modelList() {
      if (__modelListCache) return __modelListCache;
      const r = await fetch('/api/models', { credentials: 'include' });
      const d = await r.json();
      __modelListCache = { models: d.models || [], transport: d.transport || {}, billing: d.billing || {}, health: d.health || {} };
      setTimeout(() => { __modelListCache = null; }, 5 * 60000);
      return __modelListCache;
    }
    // The picker holds only the current model until its list is filled. A native list that opened before that showed
    // one line, then jumped and was cut off when the list arrived while it was open (2026-10-21). So the list is filled
    // when the chat opens, and a click that still comes first is held until the list is there, then the list opens.
    const modelPickFilling = {};   // chatId -> the fill in progress
    function modelPickDown(ev, chatId) {
      const sel = document.getElementById(`model-pick-${chatId}`);
      if (!sel || sel.dataset.filled === 'done') return true;
      ev.preventDefault();
      fillModelPick(chatId).then(() => { sel.focus(); try { if (sel.showPicker) sel.showPicker(); } catch { /* the next click opens it */ } });
      return false;
    }
    function fillModelPick(chatId) {
      const sel = document.getElementById(`model-pick-${chatId}`);
      if (!chats[chatId] || !sel || sel.dataset.filled === 'done') return Promise.resolve();
      if (!modelPickFilling[chatId]) modelPickFilling[chatId] = fillModelPickNow(chatId, sel).finally(() => { delete modelPickFilling[chatId]; });
      return modelPickFilling[chatId];
    }
    async function fillModelPickNow(chatId, sel) {
      const chat = chats[chatId];
      sel.dataset.filled = 'pending';
      try {
        const { models, billing, health } = await modelList();
        const cur = String(chat.model || '');
        // Groups by vendor (Anthropic, OpenAI, Google, ...); every line starts with the route: "API / gpt-6-astra",
        // "Subscription (Claude sign-in) / claude-fable-5-1". The route is in the text, not in a grey group label.
        let html = '';
        if (cur && !models.includes(cur)) html += `<option value="${esc(cur)}" selected>${esc(billingDisplay(cur, true))} (current; not in the hub's list)</option>`;
        // The OpenRouter group ends with a search over OpenRouter's whole catalogue (the picker lists only the ticked models).
        for (const [label, rows] of groupModels(models)) {
          html += `<optgroup label="${esc(label)}">` + rows.map(m => `<option value="${esc(m)}"${m === cur ? ' selected' : ''}>${esc(((billing[m] && billing[m].short) || billingDisplay(m, true)) + healthNote(health && health[m]))}</option>`).join('')
            + (label.startsWith('OpenRouter') ? `<option value="${OR_MORE}">🔎 More OpenRouter models…</option>` : '') + '</optgroup>';
        }
        if (html) { sel.innerHTML = html; sel.value = cur; }
        sel.dataset.filled = 'done';
      } catch (e) { delete sel.dataset.filled; console.warn('[model-pick] list failed:', e.message); }
    }
    async function changeChatModel(chatId, model, opts = {}) {
      const chat = chats[chatId]; const sel = document.getElementById(`model-pick-${chatId}`);
      if (chat && model === OR_MORE) { if (sel) sel.value = chat.model; openOrPicker(chatId); return false; }
      if (!chat || !model || model === chat.model) return false;
      if (!opts.tested && !(await testBeforeSwitch(model))) { if (sel) sel.value = chat.model; return false; }
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(chat.agent)}/model`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ model }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.success) { if (sel) sel.value = chat.model; alert(`Could not change the model: ${d.error || r.status}`); return false; }
        // The hub's agent_updated event relabels the header (or parks the change until the current turn ends).
        return true;
      } catch (e) { if (sel) sel.value = chat.model; alert(`Could not change the model: ${e.message}`); return false; }
    }

    // What the hub has seen a model do (lib/model-health): " — ⚠ blocked by the privacy setting" after its name in the
    // pickers when its last reply or test failed for a reason that belongs to the model; nothing otherwise.
    function healthNote(h) { return h && (h.state === 'fail' || h.state === 'warn') && h.short ? ` — ⚠ ${h.short}` : ''; }
    function hideHubToast() { const t = document.getElementById('hub-toast'); if (t) t.classList.remove('on'); clearTimeout(hubToast.timer); }
    // Before an agent moves to a model this hub hasn't seen answer, one tiny test request (POST /api/models/test): a
    // refusal or a model that can't use tools is caught here, with the reason and what to do, not in the agent's next
    // reply. Subscription models (Claude, Codex) are not tested per request.
    async function testBeforeSwitch(model) {
      if (!String(model).includes('/') || /^(claude-sdk|codex-cli|codex)\//.test(model)) return true;
      const h = ((__modelListCache && __modelListCache.health) || {})[model];
      if (h && h.state === 'ok') return true;   // it has answered here
      const name = String(model).split('/').pop();
      hubToast(`Testing ${name} before switching…`, 90000);
      let r = null;
      try {
        const resp = await fetch('/api/models/test', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) });
        r = await resp.json().catch(() => null);
        if (!resp.ok || !r) throw new Error((r && r.error) || `HTTP ${resp.status}`);
      } catch (e) { hideHubToast(); return confirm(`Couldn't test ${name}: ${e.message}\n\nSwitch anyway?`); }
      __modelListCache = null;   // the pickers pick up the new mark (or its absence) when they next open
      document.querySelectorAll('select.model-pick[data-filled]').forEach(s => { delete s.dataset.filled; });
      const passed = r.ok !== undefined ? r.ok : r.success;   // r.success: the answer of a hub not yet restarted
      if (passed && r.toolCall !== false) { hubToast(`✓ ${name} works here${r.ms != null ? ` (${(r.ms / 1000).toFixed(1)} s)` : ''}`); return true; }
      hideHubToast();
      return confirm(`${r.title || `${name} may not work here.`} ${r.what || r.error || ''}\n\nWhat to do: ${r.fix || 'pick another model.'}\n\nSwitch anyway?`);
    }

    // ── OpenRouter: every model, from the chat header's picker ──
    // The picker offers only the OpenRouter models ticked in Settings → OpenRouter (8 by default, out of ~400). The last
    // line of its OpenRouter group, "🔎 More OpenRouter models…", opens this window: a search over the whole catalogue
    // (GET /api/openrouter, admins only). Choosing a model adds it to that list (POST /api/openrouter), so every picker
    // offers it from then on, and switches the agent to it through changeChatModel.
    const OR_MORE = '__or_more__';
    let orPickView = null;   // { at, view }: the catalogue and the current list, reused for 10 minutes
    /** The rows the search shows: tool-capable models unless `all`, every word of `q` in the id or name, newest first. */
    function orPickList(models, q, all) {
      const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
      return (models || []).filter(m => (all || m.tools) && !/:batch/.test(m.id))
        .filter(m => { const hay = `${m.id} ${m.name || ''}`.toLowerCase(); return words.every(w => hay.includes(w)); })
        .sort((a, b) => (b.created || 0) - (a.created || 0));
    }
    /** The offered list after adding `id`: the current one (the default offer until a list is saved), without repeats. */
    function orOfferWith(chosen, id) { const list = Array.isArray(chosen) ? chosen.slice() : []; if (!list.includes(id)) list.push(id); return list; }
    /** Warnings for one OpenRouter row: from the catalogue, the privacy setting and what the hub has seen (model health). */
    function orWarnings(m, { privacy, ids, health } = {}) {
      const out = []; const free = /:free$/.test(m.id);
      const paid = free && ids && ids.has(m.id.replace(/:free$/, '')) ? m.id.replace(/:free$/, '') : null;
      if (free && privacy) out.push({ level: 'block', text: `⛔ Blocked by your privacy setting${paid ? `; paid version: ${paid}` : ''}` });
      else if (free) out.push({ level: 'warn', text: 'Free version: may train on your prompts; low rate limits' });
      if (!m.tools) out.push({ level: 'warn', text: "⚠ Can't use tools" });
      if (m.context && m.context < 32000) out.push({ level: 'warn', text: `⚠ Small context window (${Math.round(m.context / 1000)}K): the hub's instructions alone take about 18K tokens` });
      const h = health && health[`openrouter/${m.id}`];
      if (h && (h.state === 'fail' || h.state === 'warn') && h.short) out.push({ level: 'warn', text: `⚠ Last check here: ${h.short}` });
      else if (h && h.okAt) out.push({ level: 'ok', text: '✓ Works here' });
      return out;
    }
    function orPickMeta(m) {
      const ctx = !m.context ? '' : m.context >= 1e6 ? `${(m.context / 1e6).toFixed(m.context % 1e6 ? 1 : 0)}M context` : `${Math.round(m.context / 1000)}K context`;
      const can = `${m.tools ? '🛠' : ''}${m.reasoning ? ' 🧠' : ''}${m.images ? ' 🖼' : ''}`.trim();
      return [can, ctx, orPrice(m)].filter(Boolean).join(' · ');
    }
    function closeOrPicker() { const ov = document.getElementById('or-pick-overlay'); if (ov) ov.remove(); }
    async function openOrPicker(chatId) {
      const chat = chats[chatId]; if (!chat) return;
      closeOrPicker();
      const ov = document.createElement('div');
      ov.className = 'gs-overlay'; ov.id = 'or-pick-overlay'; ov.dataset.chat = chatId; ov.dataset.noDirty = '1';   // search and filter only
      ov.innerHTML = `<div class="gs-modal or-pick" role="dialog" aria-label="OpenRouter models">
          <h3>OpenRouter models · ${hubEsc(chat.display || capName(chat.agent))}</h3>
          <div class="gs-sub">Choose a model to switch this agent to it. It is also added to your OpenRouter list (Settings → OpenRouter), so every model picker offers it from now on.</div>
          <div class="or-pick-tools"><input type="search" id="or-pick-q" placeholder="grok, deepseek, kimi, qwen, llama, claude…" autocomplete="off">
            <label><input type="checkbox" id="or-pick-all"> show models without tools</label></div>
          <div id="or-pick-msg" class="or-pick-msg">Loading the OpenRouter list…</div>
          <div id="or-pick-list" class="or-pick-list"></div>
          <div class="or-pick-legend">🛠 can use tools (agents need this) · 🧠 takes a reasoning level · 🖼 reads images · price in / out per million tokens</div>
          <div class="gs-actions"><button class="gs-btn secondary" onclick="closeOrPicker()">Close</button></div>
        </div>`;
      ov.addEventListener('click', (e) => { if (e.target === ov) closeOrPicker(); });
      document.body.appendChild(ov);
      document.getElementById('or-pick-q').addEventListener('input', renderOrPicker);
      document.getElementById('or-pick-all').addEventListener('change', renderOrPicker);
      document.getElementById('or-pick-list').addEventListener('click', (e) => { const b = e.target.closest('.or-pick-row'); if (b) chooseOrModel(b.dataset.id, b); });
      document.getElementById('or-pick-q').focus();
      try { await modelList(); } catch { /* no marks, the rows still show */ }
      if (!orPickView || Date.now() - orPickView.at > 10 * 60000) {
        try {
          const r = await fetch('/api/openrouter', { credentials: 'include' });
          const d = await r.json().catch(() => ({}));
          if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
          orPickView = { at: Date.now(), view: d };
        } catch (e) { const msg = document.getElementById('or-pick-msg'); if (msg) msg.textContent = 'Could not load the OpenRouter list: ' + e.message; return; }
      }
      renderOrPicker();
    }
    function renderOrPicker() {
      const ov = document.getElementById('or-pick-overlay'); const list = document.getElementById('or-pick-list'); const msg = document.getElementById('or-pick-msg');
      if (!ov || !list || !orPickView) return;
      const v = orPickView.view; const chat = chats[ov.dataset.chat];
      const cur = String((chat && chat.model) || ''); const offered = new Set(v.chosen || []);
      const ids = new Set((v.models || []).map(m => m.id)); const health = (__modelListCache && __modelListCache.health) || {};
      const warn = (m) => orWarnings(m, { privacy: v.privacy, ids, health });
      const blocked = (m) => (warn(m).some(w => w.level === 'block') ? 1 : 0);
      const rows = orPickList(v.models, document.getElementById('or-pick-q').value, document.getElementById('or-pick-all').checked)
        .sort((a, b) => blocked(a) - blocked(b));   // stable: newest first within each group, blocked ones last
      const shown = rows.slice(0, 200);
      msg.textContent = !v.hasKey ? 'No OpenRouter key yet: add one in Settings → LLM Providers.'
        : rows.length ? `${rows.length} model${rows.length === 1 ? '' : 's'}, newest first${rows.length > shown.length ? `. Showing ${shown.length}: type to narrow it down.` : '.'}` : 'No model matches.';
      list.innerHTML = shown.map(m => {
        const isCur = `openrouter/${m.id}` === cur;
        const tag = isCur ? '<span class="or-pick-tag">current</span>' : offered.has(m.id) ? '<span class="or-pick-tag">✓ in your list</span>' : '';
        const notes = warn(m).map(w => `<span class="or-pick-warn ${w.level}">${esc(w.text)}</span>`).join('');
        return `<button type="button" class="or-pick-row${isCur ? ' cur' : ''}" data-id="${esc(m.id)}"><span class="or-pick-name"><b>${esc(m.name || m.id)}</b> ${tag}</span><code>${esc(m.id)}</code><span class="or-pick-meta">${esc(orPickMeta(m))}</span>${notes}</button>`;
      }).join('');
    }
    async function chooseOrModel(id, btn) {
      const ov = document.getElementById('or-pick-overlay'); const chatId = ov && ov.dataset.chat; const chat = chats[chatId];
      if (!chat) { closeOrPicker(); return; }
      const model = `openrouter/${id}`;
      if (model === chat.model) { closeOrPicker(); return; }
      if (btn) btn.disabled = true;
      const msg = document.getElementById('or-pick-msg'); if (msg) msg.textContent = `Testing ${id}…`;
      if (!(await testBeforeSwitch(model))) { if (btn) btn.disabled = false; if (msg) msg.textContent = `Not switched: ${chat.display || capName(chat.agent)} stays on ${String(chat.model || '').split('/').pop()}.`; return; }
      if (msg) msg.textContent = `Switching to ${id}…`;
      const v = orPickView ? orPickView.view : {};
      let note = '';
      if (!(v.chosen || []).includes(id)) {   // add it to the offer first, so every picker lists it from now on
        note = '. It could not be added to the OpenRouter list';
        try {
          const r = await fetch('/api/openrouter', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ models: orOfferWith(v.chosen, id) }) });
          const j = await r.json().catch(() => ({}));
          if (r.ok && j.ok !== false) { orPickView = { at: Date.now(), view: j }; if (orView) orView = j; if ((j.chosen || []).includes(id)) note = ''; }
        } catch { /* the note says so */ }
        __modelListCache = null;   // every open chat's picker refetches the list next time it opens
        document.querySelectorAll('select.model-pick[data-filled]').forEach(s => { delete s.dataset.filled; });
      }
      closeOrPicker();
      if (await changeChatModel(chatId, model, { tested: true })) hubToast(`${chat.display || capName(chat.agent)} switches to ${billingDisplay(model, true)}${note}`, note ? 6000 : 3000);
    }

    // Reasoning effort in the chat header, next to the model (lib/effort). Admins choose it for any agent; members see
    // the level their admin set but cannot change it. Hidden for models where it changes nothing (local servers).
    const EFFORT_LEVELS = [['default', 'Default effort'], ['low', 'Low effort'], ['medium', 'Medium effort'], ['high', 'High effort'], ['xhigh', 'Extra high effort'], ['max', 'Max effort']];
    function effortSupported(model) {
      const m = String(model || ''); const p = m.split('/')[0]; const n = m.slice(m.indexOf('/') + 1).toLowerCase();
      if (p === 'claude-sdk' || p === 'codex-cli' || p === 'anthropic') return true;
      if (p === 'openai') return /^(gpt-5|gpt-6|o[1-9])/.test(n);
      if (p === 'google') return /gemini-(2\.5|[3-9])|gemini-(pro|flash)(-lite)?-latest/.test(n);
      if (p === 'openrouter') return orReasons(n);
      return false;
    }
    // OpenRouter: its catalogue says which models take a reasoning level (lib/effort reads the same flag). The pages
    // learn it from GET /api/openrouter (admins only, the same list the "More OpenRouter models" window uses); until it
    // has arrived, or for members, the effort picker stays hidden, and it repaints once the list is in.
    let orCatalogueTriedAt = 0;
    function orReasons(id) {
      const v = orPickView && orPickView.view;
      if (!v) { orLoadCatalogue(); return false; }
      const m = (v.models || []).find(x => x.id === id);
      return !!(m && m.reasoning);
    }
    function orLoadCatalogue() {
      if (!isHubAdmin() || Date.now() - orCatalogueTriedAt < 60000) return;   // one try a minute, also after a failure
      orCatalogueTriedAt = Date.now();
      (async () => {
        try {
          const r = await fetch('/api/openrouter', { credentials: 'include' });
          const d = await r.json().catch(() => ({}));
          if (r.ok && d.ok !== false) orPickView = { at: Date.now(), view: d };
        } catch { /* stays unknown: no effort picker for OpenRouter models */ }
        if (orPickView) for (const c of Object.values(chats)) if (c && c.id) refreshEffortPick(c);
      })();
    }
    function agentEffortOf(name) { const a = (AGENTS || []).find(x => x.name === name); return (a && a.effort) || 'default'; }
    function chatModelOf(chat) { if (chat.model) return chat.model; const a = (AGENTS || []).find(x => x.name === chat.agent); return (a && a.model) || ''; }
    function effortPickHtml(chat, chatId) {
      const level = chat.effort || agentEffortOf(chat.agent);
      const show = effortSupported(chatModelOf(chat)) && !chat.autoModel;
      const opts = EFFORT_LEVELS.map(([v, l]) => `<option value="${v}"${v === level ? ' selected' : ''}>${l}</option>`).join('');
      return `<select class="model-pick effort-pick" id="effort-pick-${chatId}" aria-label="Reasoning effort" title="${isHubAdmin() ? 'How hard this agent thinks before answering. Higher = slower and uses more of the plan or API budget. Applies from the next turn.' : 'Reasoning effort, set by an admin.'}"${isHubAdmin() ? '' : ' disabled'}${show ? '' : ' hidden'} onchange="changeChatEffort('${chatId}', this.value)">${opts}</select>`;
    }
    function refreshEffortPick(chat) {
      const sel = document.getElementById(`effort-pick-${chat.id}`); if (!sel) return;
      sel.value = chat.effort || agentEffortOf(chat.agent);
      sel.hidden = !effortSupported(chatModelOf(chat)) || !!chat.autoModel;
    }
    async function changeChatEffort(chatId, level) {
      const chat = chats[chatId]; const sel = document.getElementById(`effort-pick-${chatId}`);
      if (!chat) return;
      const before = chat.effort || agentEffortOf(chat.agent);
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(chat.agent)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ effort: level }) });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.success === false) { if (sel) sel.value = before; alert(`Could not change the effort: ${d.error || r.status}`); return; }
        chat.effort = level;
        const a = (AGENTS || []).find(x => x.name === chat.agent); if (a) a.effort = level;
      } catch (e) { if (sel) sel.value = before; alert(`Could not change the effort: ${e.message}`); }
    }

    function startSoloChat(agentName, model) {
      closeSidebarOnMobile();
      // One window per agent: a second open just brings the existing one forward.
      const existing = findSoloChat(agentName);
      if (existing) { switchToChat(existing.id); return existing.id; }
      const chatId = `chat-${++chatCounter}`;
      
      // Find agent to get SOUL data
      const agentData = AGENTS.find(a => a.name === agentName);
      const soulContent = agentData?.soul || '';
      
      // Build system message with SOUL personality
      let systemMessage = '';
      if (soulContent) {
        systemMessage = soulContent + '\n\n---\n\n';
      }
      systemMessage += `You are ${agentName}, an AI assistant. Be helpful, concise, and engaging.`;
      
      chats[chatId] = {
        id: chatId, agent: agentName, display: agentData?.display || capName(agentName),
        icon: agentData?.icon || '🤖', model: model, autoModel: agentData?.autoModel || false,
        messages: [{ role: 'system', content: systemMessage }],
        status: 'idle', controller: null, isGroup: false, soul: soulContent,
        sessionId: null, resumed: false, paused: false
      };
      renderSoloChatTab(chatId);
      renderSoloChatPanel(chatId);
      switchToChat(chatId);
      document.getElementById('empty-state').style.display = 'none';
      compactionRefresh(chatId);   // context % and compression mode under the toolbar (cheap GET)
      paintPlanBadges();           // plan usage next to the model (Claude subscription agents)

      // Load conversation history from server
      chats[chatId].historyLoaded = fetch(`/api/history/${encodeURIComponent(agentName)}`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : { history: [] })
        .then(data => {
          const history = data.history || [];
          if (history.length > 0) {
            // Add a visual separator so user knows this is restored history
            appendSystemNotice(chatId, `📜 Restored ${history.length} messages from previous session`);
            for (const msg of history) {
              // The running turn's reply so far (saved as plain text every 5 s): the live turn is drawn in its place,
              // with its tool calls, once the chat follows it (reattachIfIdle), so it is not shown twice.
              if (msg.inProgress) { chats[chatId].inProgress = { text: msg.content || '', ts: msg.ts || null }; continue; }
              if (msg.role === 'user' && msg.origin?.kind) appendSystemNotice(chatId, `⚡ ${hubOriginLabel(msg.origin)} — ${hubTurnTime(msg.ts)}`);
              chats[chatId].messages.push({ role: msg.role, content: msg.content });
              const hid = appendMessage(chatId, msg.role, msg.content);
              if (msg.role === 'assistant' && Array.isArray(msg.activity) && msg.activity.length) paintSavedActivity(hid, msg);
              if (msg.role === 'assistant' && typeof msg.reasoning === 'string' && msg.reasoning) setReasoning(hid, msg.reasoning, { total: Number(msg.reasoningChars) });
            }
            // Scroll to bottom after loading history
            const panel = document.getElementById(`messages-${chatId}`);
            if (panel) setTimeout(() => panel.scrollTop = panel.scrollHeight, 100);
          }
        })
        .catch(e => console.warn('[history] Failed to load:', e));
      // An agent already mid-turn when its chat opens (after a page reload, or reopened from the sidebar): follow that
      // turn now, as the ↻ button does. The hub's status snapshot only arrives when the event stream connects, usually
      // before this chat existed, so the chat sat green with "Send" while the sidebar card said busy.
      chats[chatId].historyLoaded.then(() => { if (chats[chatId]) pollAgentStatus(); });
      return chatId;
    }

    // ── Live agent status (sidebar dots) ──────────────────────────────────
    // Source of truth: the hub's status_snapshot / turn_start / turn_end / ask_user events,
    // the busy fields on /api/agents, and /api/agents/status polled while the event stream
    // is down.  Older hubs send none of these; then statusKnown stays false and no dots are
    // drawn (only this browser's own in-flight replies show, as before).
    const agentStatus = {};          // name -> { busy, busySince, activity, pendingQuestion }
    const localBusy = new Map();     // name -> ISO time this browser started streaming a reply
    let statusKnown = false;
    let busyFilterOn = false;
    const STATUS_POLL_MS = 20000;
    const STATUS_TICK_MS = 30000;
    const TURN_POLL_MS = 4000;       // a followed turn's view, while the live event stream is down

    function elapsedLabel(iso, short = false) {
      if (!iso) return '';
      const ms = Date.now() - new Date(iso).getTime();
      if (!(ms >= 0)) return '';
      const m = Math.floor(ms / 60000);
      if (m < 1) return short ? `${Math.max(1, Math.floor(ms / 1000))}s` : 'just started';
      if (m < 60) return short ? `${m}m` : `${m} min`;
      const h = Math.floor(m / 60);
      return short ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${h} h ${m % 60} min`;
    }

    function setAgentLive(name, patch) {
      if (!name) return;
      const cur = agentStatus[name] || { busy: false, busySince: null, activity: null, pendingQuestion: false };
      const next = { ...cur, ...patch };
      if (!next.busy) { next.busySince = null; next.activity = null; next.pendingQuestion = false; }
      else if (!next.busySince) next.busySince = cur.busySince || new Date().toISOString();
      agentStatus[name] = next;
      paintAgentStatus(name);
      paintAgentsWorking();
    }

    function applyStatusSnapshot(map) {
      if (!map || typeof map !== 'object') return;
      statusKnown = true;
      for (const [name, s] of Object.entries(map)) {
        setAgentLive(name, { busy: !!s.busy, busySince: s.busySince || null, activity: s.activity || null, pendingQuestion: !!s.pendingQuestion });
      }
      for (const name of Object.keys(agentStatus)) if (!(name in map)) setAgentLive(name, { busy: false });
      paintAllAgentStatus();
      // A window opened (or woken from sleep / a blank screen) while one of its agents is mid-turn:
      // the chat has no stream to that turn, so attach to it and show the reply when it lands.
      for (const [name, s] of Object.entries(map)) if (s.busy) reattachIfIdle(name, s.busySince || null);
    }

    async function reattachIfIdle(agentName, since) {
      const chat = findSoloChat(agentName);
      if (!chat || chat.controller || chat.reattach || chat.status === 'thinking') return;
      if (Object.values(hubTurns).some(t => t.chatId === chat.id)) return;   // already following it via turn_start
      try { await chat.historyLoaded; } catch {}
      if (!chats[chat.id] || chat.controller || chat.reattach || chat.status === 'thinking') return;
      const live = agentStatus[agentName];
      if (!live || !live.busy) return;
      const ip = chat.inProgress; chat.inProgress = null;   // that turn's text so far, from history (only if it is this turn's)
      const partial = ip && (!since || !ip.ts || Date.parse(ip.ts) >= Date.parse(since) - 1000) ? ip.text : '';
      const msgId = appendMessage(chat.id, 'assistant', partial || '…');
      enterReattach(chat.id, msgId, null, partial, 'agent busy on the server while this window had no stream to it', since);
    }

    async function pollAgentStatus() {
      try {
        const r = await fetch('/api/agents/status', { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;                       // 404 on an older hub: nothing to show
        const d = await r.json();
        if (d && d.agents) applyStatusSnapshot(d.agents);
        if (d && 'halted' in d) paintHubHalt(!!d.halted, d.haltReason);
      } catch {}
      pollPacing();
      if (!isHubAdmin()) return;   // approvals are an admin surface
      try {
        const r = await fetch('/api/approvals', { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (r.ok) { const d = await r.json(); if (d && Array.isArray(d.pending)) applyApprovals(d.pending); }
      } catch {}
    }

    // ── Hub kill switch: persistent red banner while halted + Resume ──
    function paintHubHalt(halted, reason) {
      let bar = document.getElementById('hub-halt-banner');
      if (!halted) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'hub-halt-banner';
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;box-sizing:border-box;z-index:10000;background:#b71c1c;color:#fff;padding:8px 14px;display:flex;align-items:center;gap:12px;font-weight:600';
        bar.innerHTML = '<span id="hub-halt-text"></span><button id="hub-halt-resume" style="margin-left:auto;padding:4px 12px;border:1px solid #fff;background:transparent;color:#fff;border-radius:4px;cursor:pointer">Resume</button>';
        document.body.insertBefore(bar, document.body.firstChild);
        bar.querySelector('#hub-halt-resume').onclick = resumeHub;
        if (!isHubAdmin()) bar.querySelector('#hub-halt-resume').style.display = 'none';
      }
      bar.querySelector('#hub-halt-text').textContent = '⛔ Hub halted: all agents stopped, nothing new will start' + (reason ? ` (${reason})` : '');
    }
    async function haltHub() {
      if (!confirm('Halt ALL agents?\n\nEvery running turn and job is stopped and nothing new starts (chat, schedules, delegation) until you press Resume.')) return;
      try {
        const r = await fetch('/api/hub/halt', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'halted from the desktop UI' }) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        paintHubHalt(true, d.reason);
        document.getElementById('st-overlay')?.remove();
      } catch (e) { alert(`Halt failed: ${e.message}`); }
    }
    async function resumeHub() {
      try {
        const r = await fetch('/api/hub/resume', { method: 'POST', credentials: 'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        paintHubHalt(false);
      } catch (e) { alert(`Resume failed: ${e.message}`); }
    }

    // ── Provider pacing: amber banner while a provider runs one call at a time (after a
    // rate limit / outage) or is ramping its parallelism back up. Fed by status_snapshot
    // (whole picture), provider_paced / provider_ramp (upsert) and provider_recovered
    // (delete); /api/hub/status is polled while the event stream is down. Older hubs send
    // no `pacing` at all, which simply leaves the map empty. ──
    const PACING_REASONS = { rate_limit: 'rate limit', overloaded: 'provider overloaded', timeout: 'network timeouts' };
    const PACING_PROVIDERS = { 'claude-sdk': 'Claude', anthropic: 'Claude API', openai: 'OpenAI', google: 'Gemini', 'codex-cli': 'Codex', codex: 'Codex', lmstudio: 'LM Studio', perplexity: 'Perplexity' };
    const pacing = new Map();        // provider -> { provider, limit, cap, reason, until, mode }
    let pacingTimer = null;
    let pacingPolledAt = 0;
    const PACING_POLL_MS = 30000;

    function pacingProviderName(p) { return PACING_PROVIDERS[p] || String(p || 'provider'); }
    function pacingReasonLabel(r) { return PACING_REASONS[r] || (r ? String(r).replace(/_/g, ' ') : 'slowing down'); }
    function pacingCountdown(until) {
      const ms = until ? Date.parse(until) - Date.now() : 0;
      if (!(ms > 0)) return null;
      const s = Math.ceil(ms / 1000);
      return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
    }
    function pacingLine(e) {
      const who = pacingProviderName(e.provider);
      if (e.mode === 'ramping') return `⚠ Pacing: ${who} ramping back up, ${e.limit} of ${e.cap} at a time`;
      const left = pacingCountdown(e.until);
      return `⚠ Pacing: ${who} one at a time (${pacingReasonLabel(e.reason)}) · ${left ? `parallel again in ${left}` : 'cooling off done, ramping as calls succeed'}`;
    }
    function applyPacing(list) {
      if (!Array.isArray(list)) return;
      pacing.clear();
      for (const e of list) if (e && e.provider) pacing.set(e.provider, { ...e, mode: e.mode === 'ramping' ? 'ramping' : 'paced' });
      paintPacing();
    }
    function upsertPacing(e, mode) {
      if (!e || !e.provider) return;
      pacing.set(e.provider, { ...(pacing.get(e.provider) || {}), ...e, mode });
      paintPacing();
    }
    function clearPacing(provider) {
      if (provider) pacing.delete(provider); else pacing.clear();
      paintPacing();
    }
    async function pollPacing() {
      if (Date.now() - pacingPolledAt < PACING_POLL_MS) return;
      pacingPolledAt = Date.now();
      try {
        const r = await fetch('/api/hub/status', { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.pacing) applyPacing(d.pacing.paced);
      } catch {}
    }
    function paintPacing() {
      let bar = document.getElementById('hub-pacing-banner');
      if (!pacing.size) {
        if (bar) bar.remove();
        if (pacingTimer) { clearInterval(pacingTimer); pacingTimer = null; }
        paintPacingSettings();
        return;
      }
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'hub-pacing-banner';
        // Fixed, not sticky: the body is a flex row, so a sticky block inserted into it rendered as a tall column on the left.
        bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#b26a00;color:#fff;padding:6px 14px;display:flex;flex-direction:column;gap:4px;font-weight:600;box-sizing:border-box';
      }
      // Directly under the red halt banner when there is one, else at the very top.
      const halt = document.getElementById('hub-halt-banner');
      bar.style.top = halt ? `${halt.offsetHeight}px` : '0';
      if (!bar.isConnected || (halt ? bar.previousElementSibling !== halt : bar !== document.body.firstElementChild)) {
        document.body.insertBefore(bar, halt ? halt.nextSibling : document.body.firstChild);
      }
      // One row, always: a single slowed provider shows its own line; several collapse into one
      // summary row with Resume all (one row per provider ate too much of the page).
      const items = pacing.size === 1
        ? [...pacing.values()].map(e => ({ key: e.provider, text: pacingLine(e), provider: e.provider, label: 'Resume full speed' }))
        : [{ key: '*', provider: null, label: 'Resume all', text: `⚠ Pacing: ${pacing.size} providers slowed · ` + [...pacing.values()].map(e => pacingLine(e).replace(/^⚠ Pacing: /, '')).join(' · ') }];
      const rows = new Map([...bar.children].map(r => [r.dataset.provider, r]));
      for (const it of items) {
        let row = rows.get(it.key);
        if (!row) {
          row = document.createElement('div');
          row.dataset.provider = it.key;
          row.style.cssText = 'display:flex;align-items:center;gap:12px;min-width:0';
          const text = document.createElement('span');
          text.style.cssText = 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
          const btn = document.createElement('button');
          btn.title = 'Owner override: restore full parallel now';
          btn.style.cssText = 'margin-left:auto;padding:4px 12px;border:1px solid #fff;background:transparent;color:#fff;border-radius:4px;cursor:pointer;white-space:nowrap';
          if (!isHubAdmin()) btn.style.display = 'none';
          row.append(text, btn);
          bar.appendChild(row);
        }
        rows.delete(it.key);
        row.firstChild.textContent = it.text;
        row.lastChild.textContent = it.label;
        row.lastChild.onclick = () => resetPacing(it.provider);
      }
      for (const row of rows.values()) row.remove();
      if (!pacingTimer) pacingTimer = setInterval(paintPacing, 1000);   // the countdown ticks
      paintPacingSettings();
    }
    // The same picture inside Settings > Emergency, next to the kill switch.
    function paintPacingSettings() {
      const box = document.getElementById('st-pacing');
      if (!box) return;
      box.innerHTML = '';
      if (!pacing.size) { box.textContent = 'All providers at full parallel.'; return; }
      for (const [provider, e] of pacing) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;color:#f5a623';
        const text = document.createElement('span');
        text.textContent = pacingLine(e).replace(/^⚠ Pacing: /, '');
        const btn = document.createElement('button');
        btn.className = 'st-test-btn';
        btn.textContent = 'Resume full speed';
        btn.onclick = () => resetPacing(provider);
        row.append(text, btn);
        box.appendChild(row);
      }
    }
    async function resetPacing(provider) {
      try {
        const r = await fetch('/api/hub/pacing/reset', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(provider ? { provider } : {}) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json().catch(() => null);
        if (d && d.pacing && Array.isArray(d.pacing.paced)) applyPacing(d.pacing.paced);
        else clearPacing(provider);
      } catch (e) { alert(`Could not resume full speed: ${e.message}`); }
    }

    function paintAgentStatus(name) {
      const dot = document.getElementById(`agent-status-${name}`);
      const btn = document.getElementById(`agent-btn-${name}`);
      if (!dot || !btn) return;
      const s = agentStatus[name];
      const mine = localBusy.get(name);
      const busy = !!(s && s.busy) || !!mine;
      const question = !!(s && s.pendingQuestion);
      const activity = (s && s.activity) || (mine ? 'replying to you' : 'working');
      const since = (s && s.busySince) || mine || null;
      const elapsed = elapsedLabel(since, false);
      const elapsedShort = elapsedLabel(since, true);
      let cls = 'agent-status';
      let tip = '';
      let text = '';
      if (question) { cls += ' live-question'; tip = `Waiting for your answer${activity ? ` · ${activity}` : ''}${elapsed ? ` · ${elapsed}` : ''}`; text = '?'; }
      else if (busy) { cls += ' live-busy'; tip = `${activity}${elapsed ? ` · ${elapsed}` : ''}`; }
      else if (statusKnown) { cls += ' live-idle'; tip = 'Idle'; }
      dot.className = cls;
      dot.textContent = text;
      dot.title = tip;
      btn.classList.toggle('is-busy', busy || question);
      // A turn started elsewhere (phone, scheduler, another window) can be stopped from here too:
      // surface the chat's Cancel button while the agent is busy and this window is not streaming it.
      try {
        const solo = findSoloChat(name);
        if (solo && !solo.controller) {
          const cancelBtn = document.getElementById(`cancel-${solo.chatId || solo.id}`);
          if (cancelBtn) { cancelBtn.style.display = (busy || question) ? '' : 'none'; cancelBtn.title = (busy || question) ? `Stop ${name}'s current turn (${activity})` : ''; }
          showNotifyBtn(solo.chatId || solo.id, busy || question);
        }
      } catch {}
      let line = btn.querySelector('.agent-busy-line');
      if (busy || question) {
        if (!line) { line = document.createElement('span'); line.className = 'agent-busy-line'; btn.querySelector('.agent-info')?.appendChild(line); }
        line.classList.toggle('question', question);
        line.textContent = question ? `❓ waiting for your answer${elapsedShort ? ` · ${elapsedShort}` : ''}` : `⏳ ${activity}${elapsedShort ? ` · ${elapsedShort}` : ''}`;
      } else if (line) {
        line.remove();
      }
    }

    function paintAllAgentStatus() {
      for (const a of AGENTS) paintAgentStatus(a.name);
      paintAgentsWorking();
    }

    function busyAgentNames() {
      const names = new Set(localBusy.keys());
      for (const [name, s] of Object.entries(agentStatus)) if (s.busy || s.pendingQuestion) names.add(name);
      return [...names];
    }

    function paintAgentsWorking() {
      const el = document.getElementById('agents-working');
      const list = document.getElementById('agent-list');
      if (!el) return;
      const n = busyAgentNames().length;
      if (n === 0) busyFilterOn = false;
      el.classList.toggle('on', n > 0);
      el.classList.toggle('filtering', busyFilterOn);
      el.textContent = n === 0 ? '' : `${n} agent${n === 1 ? '' : 's'} working${busyFilterOn ? ' · showing only these ✕' : ''}`;
      list?.classList.toggle('busy-filter', busyFilterOn);
    }

    function toggleBusyFilter() {
      busyFilterOn = !busyFilterOn;
      paintAgentsWorking();
    }

    // Elapsed times tick without re-fetching anything.
    setInterval(() => {
      for (const name of busyAgentNames()) paintAgentStatus(name);
      for (const chatId of Object.keys(chats)) if (chats[chatId]?.reattach) reattachCheck(chatId);
    }, STATUS_TICK_MS);

    // ── Hub event stream: turns the hub starts on its own ─────────────────
    // Consultations, job notices, job reports and scheduled tasks run without a
    // browser behind them.  /api/events broadcasts them; here they land in the
    // agent's window (opened automatically for job/schedule turns) and stream live.
    // Newer hubs also publish the user's own turns (origin.kind === 'user'); those are
    // only drawn when this window is not already streaming them itself.
    const hubTurns = {};   // turnId -> { chatId, msgId }
    const HUB_AUTO_OPEN = new Set(['job_notice', 'job_report', 'schedule']);

    function hubOriginLabel(origin) {
      switch (origin?.kind) {
        case 'user': return origin.label || 'replying to you';
        case 'consultation': return `consulted by ${origin.from || 'another agent'}`;
        case 'job_notice': return `job finished${origin.jobName ? `: ${origin.jobName}` : ''}`;
        case 'job_report': return `job report from ${origin.from || 'a worker'}${origin.jobName ? ` (${origin.jobName})` : ''}`;
        case 'schedule': return `scheduled task${origin.from ? `: ${origin.from}` : ''}`;
        case 'consult_reply': return 'queued consultation reply delivered';
        case 'comms': return 'message from a messaging channel';
        default: return 'hub turn';
      }
    }

    function hubTurnTime(ts) {
      const d = ts ? new Date(ts) : new Date();
      if (isNaN(d)) return 'the hub woke this agent';
      return `the hub woke this agent ${d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }

    function markTabUnread(chatId) {
      if (chatId === activeChat) return;
      document.getElementById(`tab-${chatId}`)?.classList.add('unread');
    }

    async function onHubTurnStart(ev) {
      if (ev.turnId && hubTurns[ev.turnId]) return;   // replayed after a reconnect (?since=): the turn is already followed
      setAgentLive(ev.agent, { busy: true, busySince: ev.startedAt || null, activity: ev.activity || hubOriginLabel(ev.origin) });
      let chat = findSoloChat(ev.agent);
      let opened = false;
      if (ev.origin?.kind === 'user') {
        // Our own send is already streaming in this window (or re-attaching to it).
        if (!chat || chat.controller || chat.reattach || chat.status === 'thinking') return;
      }
      if (!chat) {
        if (!HUB_AUTO_OPEN.has(ev.origin?.kind)) return;   // plain consultations only show in an already open window
        const agentData = AGENTS.find(a => a.name === ev.agent);
        const chatId = startSoloChat(ev.agent, agentData?.model || 'claude-sdk/default');
        chat = chats[chatId];
        opened = true;
      }
      if (!chat) return;
      try { await chat.historyLoaded; } catch {}
      if (!chats[chat.id]) return;   // closed meanwhile
      const last = chat.messages[chat.messages.length - 1];
      if (typeof ev.message === 'string' && !(last && last.role === 'user' && last.content === ev.message)) {   // history may already hold the notice
        chat.messages.push({ role: 'user', content: ev.message });
        appendMessage(chat.id, 'user', ev.message);
      }
      appendSystemNotice(chat.id, `⚡ ${hubOriginLabel(ev.origin)} — ${hubTurnTime()}`);
      const msgId = appendMessage(chat.id, 'assistant', '…');
      hubTurns[ev.turnId] = { chatId: chat.id, msgId, text: '' };
      setStatus(chat.id, 'thinking', hubOriginLabel(ev.origin));
      if (!opened) markTabUnread(chat.id);
      if (Array.isArray(ev.activity)) {   // a replayed turn_start carries what the turn has done so far
        const t = turnTrack(hubTurns[ev.turnId]);
        for (const item of ev.activity) turnActivityApply(chat.id, t, item);
        if (t.items.size) paintTurn(chat.id, t, t.text);
      }
    }

    function onHubTurnDelta(ev) {
      const t = hubTurns[ev.turnId];
      if (!t) {
        // Progress for a turn this window lost its stream to.
        const chat = findSoloChat(ev.agent);
        const ra = chat?.reattach;
        if (ra && ev.text && (!ra.turnId || ra.turnId === ev.turnId)) { ra.turnId = ra.turnId || ev.turnId; ra.partial = ev.text; paintReattach(chat.id, reattachLine(chat, ra)); }
        return;
      }
      if (!chats[t.chatId] || !ev.text) return;
      t.text = ev.text;
      paintTurn(t.chatId, t, t.text);
    }

    // ── Turn catch-up: the hub's view of a running turn (GET /api/agents/<name>/turn) ────────────
    // A chat that follows a turn without a stream of its own (a re-attach, or a turn started
    // elsewhere) keeps a tracker { msgId, items: Map(itemId -> tool row), workers: Set(workerId),
    // text }. Tool rows are keyed by the hub's activity item id (tool_start / tool_use / tool_result
    // share one) and workers by their id, so replaying the turn on top of live events updates in
    // place: never a duplicate tool row or worker card. Worker cards go through handleWorkerEvent,
    // the same path the own stream uses.
    async function fetchTurn(agentName) {
      try {
        const r = await fetch(`/api/agents/${encodeURIComponent(agentName)}/turn`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) return null;   // 403: a member without access to the agent; 404: an older hub
        const d = await r.json();
        return d && d.ok ? d : null;
      } catch { return null; }
    }

    function turnTrack(t) {
      if (!t.items) t.items = new Map();
      if (!t.workers) t.workers = new Set();
      return t;
    }

    // toolActivity in the shape buildToolsHtml takes: a call per row, plus a result once it is done.
    function turnToolActivity(t) {
      const out = [];
      if (!t.items) return out;
      for (const it of t.items.values()) {
        out.push({ type: 'call', tool: it.tool, input: it.input });
        if (it.done) out.push({ type: 'result', output: it.output || '' });
      }
      return out;
    }

    // What the turn is doing right now, for the re-attach line: the newest running tool and workers.
    function turnStatusText(t) {
      if (!t || !t.items) return '';
      const parts = [];
      const running = [...t.items.values()].filter(it => !it.done).pop();
      if (running) parts.push(`running ${running.tool}${running.input ? `: ${running.input.slice(0, 60)}` : ''}`);
      let busy = 0;
      for (const id of t.workers || []) if (workerRunOf(id)?.run.status === 'running') busy++;
      if (busy) parts.push(`${busy} worker${busy === 1 ? '' : 's'} working`);
      return parts.join(' · ');
    }

    function reattachLine(chat, ra) {
      const live = agentStatus[chat.agent];
      const what = turnStatusText(ra) || live?.activity || 'still working';
      const since = ra.since || live?.busySince || new Date(ra.startedAt).toISOString();
      return `⏳ ${chat.display || chat.agent}: ${what} on the server (${elapsedLabel(since, true) || 'just now'}). This window will show the reply when it lands.`;
    }

    // The own stream's layout rebuilt from the hub's view of a turn: steps of { text, tools }, the text split where
    // each tool call happened (item.at, the reply's length when the call started), so a turn followed after a reload,
    // a reopened tab or from another window reads exactly like one streamed here. Items without a place (an older hub)
    // go first, as before.
    function turnSteps(t, text) {
      const body = String(text || '');
      const steps = [];
      let cur = { text: '', tools: [] };
      let pos = 0;
      for (const [id, it] of (t && t.items ? t.items.entries() : [])) {
        const at = Math.max(pos, Math.min(Number.isFinite(it.at) ? it.at : 0, body.length));
        if (at > pos) {
          if (cur.tools.length) { steps.push(cur); cur = { text: '', tools: [] }; }
          cur.text += body.slice(pos, at); pos = at;
        }
        const started = it.ts ? Date.parse(it.ts) : NaN;
        const ended = it.doneTs ? Date.parse(it.doneTs) : NaN;
        cur.tools.push({ id, tool: it.tool, input: it.input || '', result: it.done ? (it.output || '') : null,
          status: it.done ? (/^(Error|⚠|✗)/.test(it.output || '') ? 'error' : 'done') : 'running',
          startedAt: Number.isFinite(started) ? started : null, durationMs: Number.isFinite(started) && Number.isFinite(ended) ? ended - started : undefined });
      }
      if (pos < body.length) {
        if (cur.tools.length) { steps.push(cur); cur = { text: '', tools: [] }; }
        cur.text += body.slice(pos);
      }
      steps.push(cur);
      return steps;
    }

    // A saved reply with the tool calls of its turn (lib/sdk-chat activityForSave): history reads like the live stream.
    function paintSavedActivity(msgId, msg) {
      const t = { items: new Map() };
      for (const a of msg.activity) {
        if (a && a.kind === 'tool') t.items.set(a.id || `h${t.items.size}`, { tool: a.tool || 'tool', input: a.summary || '', output: a.output || '', done: true, at: a.at, ts: a.ts, doneTs: a.doneTs });
      }
      if (t.items.size && msgId && document.getElementById(msgId)) renderSteps(msgId, turnSteps(t, msg.content), turnToolActivity(t), [], false);
    }

    // Paints the in-progress message of a turn started elsewhere, in the own stream's layout (text, its tool calls,
    // the text after them...).
    function paintTurn(chatId, t, text, streaming = true) {
      if (!chats[chatId] || !t.msgId || !document.getElementById(t.msgId)) return;
      if (!t.items || !t.items.size) { updateMessage(t.msgId, text || '…'); restoreLiveBars(t.msgId, streaming); return; }
      renderSteps(t.msgId, turnSteps(t, text), turnToolActivity(t), [], streaming);
    }

    // updateMessage rewrites the whole message: put back the phase bar and the token counter of a followed turn.
    function restoreLiveBars(msgId, streaming = true) {
      if (streaming && liveActivity.has(msgId)) renderLiveActivity(msgId);
      if (tokenUsageState.has(msgId)) renderTokenUsage(msgId, !streaming);
    }

    // turn_progress { turnId, agent, progress, usage, context } (also in the turn view): the phase bar ("Running Bash
    // · 12s"), the token counter and the context reading the own stream shows, for a turn this window follows.
    function applyTurnProgress(chatId, msgId, p) {
      const chat = chats[chatId];
      if (!chat || !msgId || !p || chat.controller) return;
      if (p.progress && chat.status === 'thinking') setLiveActivity(msgId, chatId, p.progress);
      if (p.usage) setTokenUsage(msgId, p.usage);
      if (p.context) updateContextHealth(chatId, p.context);
    }
    function onHubTurnProgress(ev) {
      const h = hubTurnTracker(ev);
      if (h) applyTurnProgress(h.chatId, h.ra ? h.ra.msgId : h.t.msgId, ev);
    }

    // One activity item (turn.activity[] entry or turn_activity event): upsert by id. Returns its kind.
    function turnActivityApply(chatId, t, item) {
      if (!item || typeof item !== 'object' || !item.id) return null;
      if (item.kind === 'tool') {
        let it = t.items.get(item.id);
        if (!it) { it = { tool: 'tool', input: '', output: '', done: false }; t.items.set(item.id, it); }
        if (Number.isFinite(item.at) && it.at === undefined) it.at = item.at;   // its place in the reply text
        if (item.ts && !it.ts) it.ts = item.ts;
        if (item.tool) it.tool = String(item.tool);
        if (item.summary) it.input = String(item.summary);
        if (item.status === 'done') {
          it.done = true;
          if (item.doneTs) it.doneTs = item.doneTs;
          if (item.output != null) it.output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output);
        }
        return 'tool';
      }
      if (item.kind === 'worker') { turnWorkerUpsert(chatId, t, item); return 'worker'; }
      if (item.kind === 'worker_tool') {
        const w = workerRunOf(item.workerId);
        if (!w) return null;
        const run = w.run;
        if (!run.turnTools) run.turnTools = [];
        let line = run.turnTools.find(x => x.id === item.id);
        if (!line) { line = { id: item.id, tool: 'tool', input: '' }; run.turnTools.push(line); }
        if (item.tool) line.tool = String(item.tool);
        if (item.summary) line.input = String(item.summary);
        paintWorkerRun(run);
        return 'worker_tool';
      }
      return null;
    }

    // A worker known from the hub's turn view (activity item or turn.workers[] record) through
    // handleWorkerEvent: worker_started once per id (its agent's open card takes it, as live), text
    // and tool lines in place, then the end.
    function turnWorkerUpsert(chatId, t, w) {
      const id = String(w.workerId || w.id || '');
      if (!id || closedWorkerRuns.has(id)) return;
      if (!workerRunOf(id)) {
        handleWorkerEvent(chatId, { type: 'worker_started', worker_id: id, agent_type: w.agent || '', description: w.description || 'Worker', model: w.model || '', prompt: w.prompt || '' });
        const started = workerRunOf(id);
        if (started && w.startedAt && !isNaN(Date.parse(w.startedAt))) {
          started.run.startedAt = Date.parse(w.startedAt);
          if (started.chat.workerId === id) started.chat.startedAt = started.run.startedAt;
        }
      }
      const found = workerRunOf(id);
      if (!found) return;
      const run = found.run;
      t.workers.add(id);
      // A start from the turn's activity list carries no prompt (the card showed its label); the worker record does
      if (!run.promptShown && typeof w.prompt === 'string' && w.prompt) { run.promptShown = true; updateMessage(run.promptMsgId, w.prompt); }
      let changed = false;
      if (typeof w.text === 'string' && w.text && w.text !== run.text) { run.text = w.text; changed = true; }
      if (Array.isArray(w.tools) && w.tools.length) {
        run.turnTools = w.tools.map(x => ({ id: x.id, tool: String(x.tool || 'tool'), input: String(x.summary || '') }));
        changed = true;
      }
      const status = w.status === 'started' ? 'running' : w.status;
      const over = status === 'completed' || status === 'failed';
      if (changed) paintWorkerRun(run, over);
      // handleWorkerEvent's completed/failed paths append notices: run them once per worker (a run
      // was marked stopped still takes the outcome the hub reports).
      if (over && run.status !== 'completed' && run.status !== 'failed') {
        handleWorkerEvent(chatId, { type: status === 'completed' ? 'worker_completed' : 'worker_failed', worker_id: id, error: w.error || undefined, cancelled: w.cancelled === true });
      }
    }

    // A worker's reply from hub-fed lines: every line but the newest counts as done (the hub keeps no
    // per-line status); once the worker is over, all of them.
    function paintWorkerRun(run, done = false) {
      if (run.turnTools) {
        run.tools = [];
        run.turnTools.forEach((l, i) => {
          run.tools.push({ type: 'call', tool: l.tool, input: l.input });
          if (done || i < run.turnTools.length - 1) run.tools.push({ type: 'result', output: '' });
        });
      }
      if (run.msgId) updateMessageWithTools(run.msgId, run.text || '', run.tools, [], !done && run.status === 'running');
    }

    // Does a fetched turn belong to this re-attach? Our own message must be the turn's message; a
    // re-attach without one (turn started elsewhere) goes by the start time the status gave us.
    function turnMatchesReattach(ra, turn) {
      if (ra.turnId) return ra.turnId === turn.turnId;
      if (ra.content) return turn.message === ra.content;
      if (ra.since && turn.startedAt) return Math.abs(Date.parse(turn.startedAt) - Date.parse(ra.since)) < 5000;
      return true;
    }

    // First step of a re-attach, and again on focus, reconnect and when the hub comes back: paint
    // the hub's view of the turn (partial text, tool activity, workers), then the live events keep
    // it moving. A turn that has already ended is finished right away from its text.
    async function catchUpTurn(chatId) {
      const chat = chats[chatId];
      if (!chat || chat.controller || chat.isWorker || chat.isGroup || !chat.agent) return;   // an own stream shows its turn itself
      const d = await fetchTurn(chat.agent);
      const turn = d && d.turn;
      if (turn) applyTurnNotify(chat.agent, turn);   // the bell's state for this person (tapped here or on another device)
      if (!turn || !chats[chatId] || chat.controller) return;   // nothing to show: history polling takes over
      const ra = chat.reattach;
      const entry = Object.entries(hubTurns).find(([, t]) => t.chatId === chatId);
      let t = null;
      if (ra) {
        if (!turnMatchesReattach(ra, turn)) return;
        ra.turnId = turn.turnId || ra.turnId;
        if (!ra.since && turn.startedAt) ra.since = turn.startedAt;
        t = turnTrack(ra);
      } else if (entry) {
        if (entry[0] !== turn.turnId) return;
        t = turnTrack(entry[1]);
      } else {
        return;
      }
      for (const item of turn.activity || []) turnActivityApply(chatId, t, item);
      for (const w of turn.workers || []) if (w && w.id) turnWorkerUpsert(chatId, t, w);
      if (typeof turn.reasoning === 'string' && turn.reasoning) {
        setReasoning(ra ? ra.msgId : t.msgId, turn.reasoning, { live: !turn.ended, total: Number(turn.reasoningChars), onlyIfLonger: true });
      }
      if (!turn.ended) applyTurnProgress(chatId, ra ? ra.msgId : t.msgId, turn);
      if (turn.question && turn.question.request_id && !turn.ended) showQuestionModal(turn.question, chatId).catch(() => {});
      if (ra) {
        if (typeof turn.text === 'string' && turn.text.length >= (ra.partial || '').length) ra.partial = turn.text;
        if (turn.ended) {
          const ok = turn.ended.ok !== false;
          finishReattach(chatId, ok ? (turn.text || '(no reply)') : `${turn.text ? turn.text + '\n\n' : ''}⚠ turn failed: ${turn.ended.error || 'unknown error'}`, ok);
          return;
        }
        paintReattach(chatId, reattachLine(chat, ra));
        return;
      }
      t.text = turn.text || t.text || '';
      if (turn.ended) onHubTurnEnd({ turnId: turn.turnId, agent: chat.agent, ok: turn.ended.ok !== false, error: turn.ended.error, reply: turn.text, origin: turn.origin, endedAt: turn.ended.endedAt });
      else paintTurn(chatId, t, t.text);
    }

    // Every chat following a turn without a stream of its own.
    function catchUpAll() {
      for (const [chatId, chat] of Object.entries(chats)) {
        if (!chat || chat.isWorker || chat.isGroup || chat.controller) continue;
        if (chat.reattach || Object.values(hubTurns).some(t => t.chatId === chatId)) catchUpTurn(chatId);
      }
    }

    // The chat following a turn through hub events: the one turn_start opened, else the agent's
    // re-attach (which adopts the turn id from the first event it sees).
    function hubTurnTracker(ev) {
      const t = hubTurns[ev.turnId];
      if (t) return chats[t.chatId] ? { chatId: t.chatId, t: turnTrack(t), ra: null } : null;
      const chat = findSoloChat(ev.agent);
      const ra = chat?.reattach;
      if (ra && (!ra.turnId || ra.turnId === ev.turnId)) { ra.turnId = ra.turnId || ev.turnId; return { chatId: chat.id, t: turnTrack(ra), ra }; }
      return null;
    }

    // turn_activity { turnId, agent, item }: a tool call, a worker, or a worker's tool line.
    function onHubTurnActivity(ev) {
      const h = hubTurnTracker(ev);
      if (!h || !ev.item) return;
      const kind = turnActivityApply(h.chatId, h.t, ev.item);
      if (h.ra) paintReattach(h.chatId, reattachLine(chats[h.chatId], h.ra));
      else if (kind === 'tool') paintTurn(h.chatId, h.t, h.t.text);
    }

    // turn_worker_delta { turnId, agent, workerId, text }: the worker's text so far.
    // turn_reasoning { turnId, agent, at, text }: the next piece of the turn's reasoning (the panel at the top of the reply).
    // A piece this page never got (the hub does not replay them) brings the hub's turn view, which has the reasoning so far.
    const rsnCatchUps = new Set();
    function onHubTurnReasoning(ev) {
      const h = hubTurnTracker(ev);
      if (!h) return;
      const msgId = h.ra ? h.ra.msgId : h.t.msgId;
      if (!msgId || addReasoningAt(msgId, Number(ev.at), typeof ev.text === 'string' ? ev.text : '')) return;
      if (rsnCatchUps.has(h.chatId)) return;
      rsnCatchUps.add(h.chatId);
      setTimeout(() => { rsnCatchUps.delete(h.chatId); catchUpTurn(h.chatId); }, 400);
    }

    function onHubTurnWorkerDelta(ev) {
      const h = hubTurnTracker(ev);
      if (!h) return;
      const w = workerRunOf(ev.workerId);
      if (!w || typeof ev.text !== 'string') return;
      w.run.text = ev.text;
      paintWorkerRun(w.run);
    }

    function onHubTurnEnd(ev) {
      setAgentLive(ev.agent, { busy: false });
      if (ev.agent && notifyArmed[ev.agent]) { notifyArmed[ev.agent] = null; paintNotifyBtns(ev.agent); }
      { const c = findSoloChat(ev.agent); if (c) { c.inProgress = null; setTimeout(() => compactionRefresh(c.id), 3500); } }   // context % moved (the hub records it 2.5 s after the turn)
      const t = hubTurns[ev.turnId]; delete hubTurns[ev.turnId];
      if (!t) {
        const chat = findSoloChat(ev.agent);
        if (chat?.reattach) {
          if (ev.reply) finishReattach(chat.id, ev.reply, true);
          else if (ev.ok === false) finishReattach(chat.id, `${chat.reattach.partial ? chat.reattach.partial + '\n\n' : ''}⚠ turn failed: ${ev.error || 'unknown error'}`, false);
          else reattachCheck(chat.id);
        }
        return;
      }
      if (!chats[t.chatId]) return;
      const chat = chats[t.chatId];
      const reply = ev.reply || (ev.ok ? '(no reply)' : `⚠ turn failed: ${ev.error || 'unknown error'}`);
      const el = document.getElementById(t.msgId);
      clearLiveActivity(t.msgId);
      if (el) { t.text = reply; paintTurn(t.chatId, t, reply, false); }
      if (tokenUsageState.has(t.msgId)) finalizeTokenUsage(t.msgId);
      for (const id of t.workers || []) { const w = workerRunOf(id); if (w && w.run.status === 'running') handleWorkerEvent(t.chatId, { type: 'worker_completed', worker_id: id }); }
      const last = chat.messages[chat.messages.length - 1];
      if (!(last && last.role === 'assistant' && last.content === reply)) chat.messages.push({ role: 'assistant', content: reply });
      setStatus(t.chatId, ev.ok ? 'idle' : 'error', ev.ok ? null : 'Hub turn failed');
      autoScroll(document.getElementById(`messages-${t.chatId}`));
      // A job report answers something this window asked for: bring it forward.
      if (ev.origin?.kind === 'job_report') switchToChat(t.chatId);
      else markTabUnread(t.chatId);
      refreshJobsBadge?.();
    }

    // ── Context compression (agent-authored working brief) ────────────────────────────────
    // GET /api/agents/<name>/compaction once when a chat opens and after each turn_end for that
    // agent; a small line under the toolbar when the context is half full or more. The hub's
    // compaction_start / compaction_end events become system notices in the agent's open chat.
    const COMPACTION_MODE_LABEL = { off: 'off', dry: 'dry run', on: 'on', assisted: 'assisted' };
    function compactionModeLabel(mode) { return COMPACTION_MODE_LABEL[mode] || String(mode || 'off'); }
    async function compactionRefresh(chatId) {
      const chat = chats[chatId];
      if (!chat || chat.isGroup || chat.isWorker || !chat.agent) return;
      let d;
      try { d = await filesApi(`/api/agents/${encodeURIComponent(chat.agent)}/compaction`); }
      catch { return; }   // older hub or no session yet: no line
      chat.compaction = d;
      renderCompactionLine(chatId, d);
    }
    // Shown from the first reading on, at every size, so the owner can watch the context grow (it used to wait
    // for 50%, and vanished after every compression).
    function renderCompactionLine(chatId, d) {
      const el = document.getElementById(`compaction-line-${chatId}`);
      if (!el) return;
      const pct = Math.round(Number(d && d.pct) || 0);
      const tokens = Number(d && d.tokens) || 0;
      if (!d || (!pct && !tokens)) { el.style.display = 'none'; el.textContent = ''; return; }
      const at = Math.round((Number(d.at) || 0.75) * 100);
      const size = tokens && Number(d.limit) ? ` · ${ctxTokens(tokens)} of ${ctxTokens(Number(d.limit))} tokens` : '';
      const mode = !d.mode ? '' : d.mode === 'off' ? ' · compression: off' : ` · compression: ${compactionModeLabel(d.mode)} at ${at}%`;
      el.textContent = `context ${pct}%${size}${mode}${d.running ? ' · writing the brief…' : ''}`;
      el.classList.toggle('hot', !!d.mode && d.mode !== 'off' && pct >= at);
      el.style.display = '';
    }
    function ctxTokens(n) { return n >= 1e6 ? `${(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n); }
    function onCompactionStart(ev) {
      const chat = findSoloChat(ev.agent);
      if (!chat) return;
      const who = chat.display || capName(ev.agent);
      chat.compactionNotice = appendSystemNotice(chat.id, `⚙ ${who} is writing its working brief (${compactionModeLabel(ev.mode)})…`, 'working');
      if (chat.compaction) { chat.compaction.running = true; renderCompactionLine(chat.id, chat.compaction); }
    }
    // compaction_progress { agent, part, parts } (assisted mode): the same notice line is updated in place.
    function onCompactionProgress(ev) {
      const chat = findSoloChat(ev.agent);
      if (!chat) return;
      const who = chat.display || capName(ev.agent);
      const text = `⚙ ${who} is extracting slice ${ev.part} of ${ev.parts}…`;
      if (chat.compactionNotice && chat.compactionNotice.isConnected) chat.compactionNotice.textContent = text;
      else chat.compactionNotice = appendSystemNotice(chat.id, text, 'working');
    }
    function onCompactionEnd(ev) {
      const chat = findSoloChat(ev.agent);
      if (!chat) return;
      chat.compactionNotice = null;
      if (ev.ok === false || ev.error) appendSystemNotice(chat.id, `⚠ compression failed: ${ev.error || 'unknown error'}`, 'failed');
      else appendSystemNotice(chat.id, ev.reset ? '✓ brief written, fresh session started' : '✓ brief written', 'complete');
      compactionRefresh(chat.id);
    }

    let hubEventSource = null;
    let hubLastEventAt = 0;          // when the last event of any kind (the hub's 15 s ping included) arrived
    let hubLastSeq = 0;              // sequence of the last ring event seen: a deliberate reconnect asks for ?since= it, so nothing is lost
    function startHubEventMonitor() {
      if (hubEventSource) { try { hubEventSource.close(); } catch {} }   // one stream alive at a time
      const source = new EventSource('/api/events' + (hubLastSeq > 0 ? `?since=${hubLastSeq}` : ''), { withCredentials: true });
      hubEventSource = source;
      hubLastEventAt = Date.now();
      const parse = e => { hubLastEventAt = Date.now(); try { const ev = JSON.parse(e.data); if (ev && Number(ev.seq) > hubLastSeq) hubLastSeq = Number(ev.seq); return ev; } catch { return null; } };
      source.addEventListener('hello', e => {
        const ev = parse(e); if (!ev) return;
        if (Number(ev.lastId) > hubLastSeq) hubLastSeq = Number(ev.lastId);
        // A different boot id means the hub restarted since this page loaded: the page code may be stale.
        // Reload as soon as no reply is streaming in this window (re-attached chats catch up again after the reload)
        // and no open dialog holds unsaved changes (the reload would lose them).
        if (ev.boot) {
          if (!window.__hubBoot) window.__hubBoot = ev.boot;
          else if (ev.boot !== window.__hubBoot && !window.__hubReloading) {
            window.__hubReloading = true;
            hubToast('The hub restarted. Reloading this page to the new version…');
            const busy = () => Object.values(chats).some(c => c && c.controller) || dialogGuard.hasChanges();
            const go = () => { if (busy()) { setTimeout(go, 2000); return; } setTimeout(() => { if (busy()) go(); else location.reload(); }, 800); };   // checked again just before
            go();
          }
        }
      });
      source.addEventListener('ping', e => { parse(e); });
      source.addEventListener('status_snapshot', e => { const ev = parse(e); if (ev) { applyStatusSnapshot(ev.agents); if ('halted' in ev) paintHubHalt(!!ev.halted, ev.haltReason); if (ev.pacing) applyPacing(ev.pacing.paced); if (ev.approvals) applyApprovals(ev.approvals); } });
      source.addEventListener('hub_halted', e => { const ev = parse(e); paintHubHalt(true, ev && ev.reason); });
      source.addEventListener('hub_resumed', e => { parse(e); paintHubHalt(false); });
      source.addEventListener('approval_request', e => { const ev = parse(e); if (ev) onApprovalEvent({ ...ev, type: 'approval_request' }); });
      source.addEventListener('approval_resolved', e => { const ev = parse(e); if (ev) onApprovalEvent({ ...ev, type: 'approval_resolved' }); });
      source.addEventListener('provider_paced', e => { const ev = parse(e); if (ev) upsertPacing(ev, 'paced'); });
      source.addEventListener('provider_ramp', e => { const ev = parse(e); if (ev) upsertPacing(ev, 'ramping'); });
      source.addEventListener('provider_recovered', e => { const ev = parse(e); if (ev && ev.provider) clearPacing(ev.provider); });
      source.addEventListener('turn_start', e => { const ev = parse(e); if (ev) onHubTurnStart(ev).catch(err => console.error('[hub-events]', err)); });
      source.addEventListener('turn_delta', e => { const ev = parse(e); if (ev) onHubTurnDelta(ev); });
      source.addEventListener('turn_activity', e => { const ev = parse(e); if (ev) onHubTurnActivity(ev); });
      source.addEventListener('turn_reasoning', e => { const ev = parse(e); if (ev) onHubTurnReasoning(ev); });
      source.addEventListener('turn_progress', e => { const ev = parse(e); if (ev) onHubTurnProgress(ev); });
      source.addEventListener('turn_worker_delta', e => { const ev = parse(e); if (ev) onHubTurnWorkerDelta(ev); });
      source.addEventListener('turn_end', e => { const ev = parse(e); if (ev) { onHubTurnEnd(ev); scheduleSpendRefresh(); } });
      source.addEventListener('turn_notify', e => {
        const ev = parse(e);
        if (!ev || !ev.agent || String(ev.userId) !== myNotifyId()) return;   // someone else's bell
        notifyArmed[ev.agent] = ev.on ? ev.turnId : null;
        paintNotifyBtns(ev.agent);
      });
      source.addEventListener('ask_user', e => {
        const ev = parse(e); if (!ev) return;
        setAgentLive(ev.agent, { busy: true, pendingQuestion: true });
        // The question itself, for a page whose chat stream is not attached (dedup by request id inside).
        if (ev.request_id && Array.isArray(ev.questions)) {
          const chat = findSoloChat(ev.agent);
          const chatId = chat ? Object.keys(chats).find(k => chats[k] === chat) : null;
          showQuestionModal({ request_id: ev.request_id, questions: ev.questions }, chatId || null).catch(() => {});
        }
      });
      source.addEventListener('ask_user_done', e => { const ev = parse(e); if (ev && ev.request_id) closeQuestion(ev.request_id); });
      source.addEventListener('ask_user_done', e => { const ev = parse(e); if (ev) setAgentLive(ev.agent, { pendingQuestion: false }); });
      source.addEventListener('compaction_start', e => { const ev = parse(e); if (ev) onCompactionStart(ev); });
      source.addEventListener('compaction_progress', e => { const ev = parse(e); if (ev) onCompactionProgress(ev); });
      source.addEventListener('compaction_end', e => { const ev = parse(e); if (ev) onCompactionEnd(ev); });
      source.addEventListener('agent_updated', e => { const ev = parse(e); if (ev) onAgentUpdated(ev); });
      // Plan limits: a family at its weekly limit runs on the substitute model; the plan refused a model outright.
      source.addEventListener('model_fallback', e => { const ev = parse(e); if (ev) hubToast(`${ev.agent}: ${String(ev.from || '').split('/').pop()} is at ${ev.utilization != null ? Math.round(ev.utilization) + '% of its weekly limit' : 'its limit'}; running on ${String(ev.to || '').split('/').pop()} until ${ev.resetsAt ? new Date(ev.resetsAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : 'the window resets'}`); });
      // Plan warnings and refusals (lib/plan-usage) are shown near the top, never as a pop-up over the input: the usage
      // badge next to each Claude agent's model, the sidebar chip, and the Settings box.
      source.addEventListener('plan_limit', e => { const ev = parse(e); if (!ev) return; refreshPlanChip(); if (document.getElementById('st-plan-section')) loadPlanBox(); });
      source.addEventListener('plan_warning', e => { const ev = parse(e); if (!ev) return; refreshPlanChip(); if (document.getElementById('st-plan-section')) loadPlanBox(); });
      // Data connectors: a connector or group changed (saved, locked, unlocked, expired); repaint the Settings box.
      source.addEventListener('connectors_changed', e => { const ev = parse(e); if (ev) onConnectorsChanged(ev); });
      // (Re)connected: what happened to followed turns meanwhile comes from the hub's turn view.
      source.onopen = () => { hubLastEventAt = Date.now(); reattachCheckAll(); catchUpAll(); };
      source.onerror = () => {
        // EventSource reconnects on its own (Last-Event-ID replays what was missed) unless it is
        // CLOSED for good, e.g. after an auth or 5xx answer; then start over in a few seconds.
        if (source.readyState === EventSource.CLOSED && hubEventSource === source) setTimeout(() => { if (hubEventSource === source) startHubEventMonitor(); }, 3000);
      };
    }
    window.addEventListener('beforeunload', () => { if (hubEventSource) hubEventSource.close(); });

    // Dead-connection watchdog. After a laptop sleep the EventSource often still reports OPEN while
    // its TCP connection is gone, so nothing arrives again, not even the hub's ping every 15 s.
    // Three missed pings and the stream is replaced; onopen then catches up on followed turns.
    const HUB_EVENT_STALE_MS = 45000;
    setInterval(() => {
      if (!hubEventSource || !hubLastEventAt || Date.now() - hubLastEventAt <= HUB_EVENT_STALE_MS) return;
      console.warn(`[hub-events] no event for ${Math.round((Date.now() - hubLastEventAt) / 1000)}s: reconnecting`);
      startHubEventMonitor();
    }, 10000);

    // Sleep detector: a 5 s tick that lands 20 s late means the machine slept or the tab was frozen.
    let lastTickAt = Date.now();
    setInterval(() => {
      const now = Date.now(), gap = now - lastTickAt;
      lastTickAt = now;
      if (gap > 20000) { console.warn(`[hub-events] woke after ${Math.round(gap / 1000)}s: re-syncing`); resync(true); }
    }, 5000);

    // Full recovery without a reload: a fresh event stream, fresh status and agent list, then the
    // followed turns catch up from the hub's turn view. Debounced: focus, visibilitychange and
    // pageshow all fire together on a wake.
    let resyncAt = Date.now();
    function resync(force = false) {
      const now = Date.now();
      if (now - resyncAt < 2000) return false;
      resyncAt = now;
      // Replace the event stream only when it is missing, not open, or silent past the ping cadence (a
      // laptop that slept), or on an explicit request: a healthy stream on a mere tab switch stays, so no
      // event falls in a reconnect gap. (A replaced stream asks for a replay since the last seq anyway.)
      const stale = !hubEventSource || hubEventSource.readyState !== EventSource.OPEN || (hubLastEventAt && now - hubLastEventAt > HUB_EVENT_STALE_MS);
      if (force || stale) startHubEventMonitor();
      loadAgents().catch(() => {});
      pollAgentStatus();
      reattachCheckAll();
      catchUpAll();
      return true;
    }

    // The ↻ button in a chat's action bar: always acts, spins for a second, and says what it did.
    function resyncClick() {
      for (const btn of document.querySelectorAll('.chat-actions .resync-btn')) {
        btn.classList.add('spinning'); btn.disabled = true;
        setTimeout(() => { btn.classList.remove('spinning'); btn.disabled = false; }, 1000);
      }
      resyncAt = 0;
      resync(true);
      const chat = activeChat ? chats[activeChat] : null;
      const busy = chat && chat.agent && !chat.isGroup && !chat.isWorker && (chat.reattach || chat.controller || chat.status === 'thinking' || agentStatus[chat.agent]?.busy);
      hubToast(busy ? `Re-synced with the hub, following ${chat.display || chat.agent}'s turn` : 'Re-synced with the hub');
    }

    function hubToast(text, ms = 3000) {
      let t = document.getElementById('hub-toast');
      if (!t) { t = document.createElement('div'); t.id = 'hub-toast'; document.body.appendChild(t); }
      t.textContent = text;
      t.classList.add('on');
      clearTimeout(hubToast.timer);
      hubToast.timer = setTimeout(() => t.classList.remove('on'), ms);
    }
    // While the event stream is not open, cheap polling keeps the dots honest.
    setInterval(() => {
      if (hubEventSource && hubEventSource.readyState === EventSource.OPEN) return;
      pollAgentStatus();
    }, STATUS_POLL_MS);
    // ...and a chat following a turn asks the hub for that turn every few seconds, so its text, tool calls and phase
    // bar keep coming (history alone has only the text, saved every 5 s).
    setInterval(() => {
      if (hubEventSource && hubEventSource.readyState === EventSource.OPEN && hubLastEventAt && Date.now() - hubLastEventAt <= HUB_EVENT_STALE_MS) return;
      catchUpAll();
    }, TURN_POLL_MS);
    
    function startGroupChat() {
      if (selectedGroupAgents.length < 1) return;
      closeSidebarOnMobile();

      const type = document.getElementById('discussion-type').value;
      const contextMode = document.getElementById('context-mode').value;
      const contextN = parseInt(document.getElementById('context-n').value) || 10;
      const rounds = Math.max(1, parseInt(document.getElementById('rounds-per-trigger').value) || 1);
      const pauseForUser = document.getElementById('pause-for-user').checked;
      const topic = document.getElementById('discussion-topic').value.trim();
      
      if (type === 'moderated' && !selectedSummarizer) return;
      
      const chatId = `chat-${++chatCounter}`;
      const participants = selectedGroupAgents.filter(a => a.name !== selectedSummarizer?.name);
      
      chats[chatId] = {
        id: chatId,
        agents: [...selectedGroupAgents],
        participants: participants,
        summarizer: selectedSummarizer,
        messages: [],
        syntheses: [],
        status: 'idle',
        controllers: {},
        isGroup: true,
        discussionType: type,
        contextMode: contextMode,
        contextN: contextN,
        roundsPerTrigger: rounds,
        pauseForUser: pauseForUser,
        waitingForUser: false,
        directives: { ...agentDirectives },  // Copy directives for this chat
        topic: topic,
        currentRound: 0,
        cancelled: false
      };
      
      renderGroupChatTab(chatId);
      renderGroupChatPanel(chatId);
      switchToChat(chatId);
      
      // Clear selection
      selectedGroupAgents = [];
      selectedSummarizer = null;
      agentDirectives = {};
      closeDirectiveEditor();
      updateGroupBuilder();
      renderAgents();
      updateConfigUI();
      
      document.getElementById('empty-state').style.display = 'none';
      
      // Auto-start when topic is provided (any mode)
      if (topic) {
        startAutonomousDiscussion(chatId, topic);
      }
    }
    
    function renderSoloChatTab(chatId) {
      const chat = chats[chatId];
      const tabs = document.getElementById('chat-tabs');
      const tab = document.createElement('div');
      tab.className = 'chat-tab';
      tab.id = `tab-${chatId}`;
      tab.innerHTML = `
        <span class="status idle"></span>
        <span class="tab-icon">${chat.icon || '🤖'}</span>
        <span class="name">${chat.display || chat.agent}${agentOwnerSuffix(chat.agent) ? `<small class="tab-owner">${hubEsc(agentOwnerSuffix(chat.agent))}</small>` : ''}</span>
        <span class="close-tab" onclick="closeChat('${chatId}', event)">✕</span>
      `;
      tab.addEventListener('click', () => switchToChat(chatId));
      tabs.appendChild(tab);
    }
    
    function renderGroupChatTab(chatId) {
      const chat = chats[chatId];
      const tabs = document.getElementById('chat-tabs');
      const shortNames = chat.agents.length > 3
        ? chat.agents.slice(0, 2).map(a => a.display || capName(a.name)).join(', ') + ` +${chat.agents.length - 2}`
        : chat.agents.map(a => a.display || capName(a.name)).join(', ');
      
      const tab = document.createElement('div');
      tab.className = 'chat-tab group';
      tab.id = `tab-${chatId}`;
      tab.innerHTML = `
        <span class="status idle"></span>
        <span class="name">👥 ${hubEsc(shortNames)}</span>
        <span class="close-tab" onclick="closeChat('${chatId}', event)">✕</span>
      `;
      tab.addEventListener('click', () => switchToChat(chatId));
      tabs.appendChild(tab);
    }
    
    function renderSoloChatPanel(chatId) {
      const chat = chats[chatId];
      const panels = document.getElementById('chat-panels');
      const panel = document.createElement('div');
      panel.className = 'chat-container';
      panel.id = `panel-${chatId}`;
      panel.innerHTML = `
        <div class="status-bar" id="status-bar-${chatId}">
          <div class="status-item">
            <span class="status-dot idle" id="status-dot-${chatId}"></span>
            <span id="status-text-${chatId}">Idle</span>
            <span class="session-indicator" id="session-indicator-${chatId}" style="font-size: 0.75em; opacity: 0.5; margin-left: 8px;" title=""></span>
          </div>
          <div class="active-agents" id="active-agents-${chatId}"></div>
        </div>
        <div class="thinking-panel" id="thinking-panel-${chatId}">
          <div class="thinking-label"><span class="spinner"></span><span id="thinking-agent-${chatId}">Thinking</span></div>
          <div class="thinking-content" id="thinking-content-${chatId}"></div>
        </div>
        <div class="chat-actions">
          <button onclick="resyncClick()" class="resync-btn" id="resync-btn-${chatId}" title="Re-sync with the hub" aria-label="Re-sync with the hub">↻</button>
          <button onclick="newSession('${chatId}')" title="Clear agent memory and start fresh">🔄 New Session</button>
          <button onclick="clearChat('${chatId}')">🗑️ Clear</button>
          <button onclick="saveChat('${chatId}')">💾 Save</button>
          <button onclick="openRecallPanel('${chatId}')" id="recall-btn-${chatId}" title="Search this agent's whole history">🔎 Recall</button>
          <button onclick="pauseRequest('${chatId}')" id="pause-${chatId}" style="display:none;" title="Pause to provide input, then continue">⏸️ Pause</button>
          <button onclick="cancelRequest('${chatId}')" id="cancel-${chatId}" style="display:none;">⏹️ Cancel</button>

          <span class="agent-name"><span class="agent-name-text">${hubEsc(chat.display || capName(chat.agent))}</span> <select class="model-pick" id="model-pick-${chatId}" title="Change this agent's model from here. Claude to Claude keeps the session; another provider continues from the conversation history. A change made while the agent is busy applies after this turn." aria-label="Model" onfocus="fillModelPick('${chatId}')" onmousedown="return modelPickDown(event, '${chatId}')" onchange="changeChatModel('${chatId}', this.value)"><option value="${esc(chat.model || '')}" selected>${chat.autoModel ? 'Auto' : esc(billingDisplay(chat.model, true))}</option></select> ${effortPickHtml(chat, chatId)}<span class="plan-badge" id="plan-badge-${chatId}" hidden onclick="openPlanSettings()"></span></span>${cyberHeaderTag(chat.model)}
        </div>
        <div class="compaction-line" id="compaction-line-${chatId}" style="display:none" title="Context compression: the agent writes its own working brief (see the agent's settings page)"></div>
        <div class="messages" id="messages-${chatId}"></div>
        <div class="input-area">
          <div class="input-wrapper">
            <div class="image-preview-area" id="image-preview-${chatId}"></div>
            <textarea id="input-${chatId}" placeholder="Type your message... (Ctrl+V to paste images)" onkeydown="handleKeyDown(event, '${chatId}')" onpaste="handlePaste(event, '${chatId}')" oninput="autoGrowTextarea(this)"></textarea>
          </div>
          <input type="file" id="file-input-${chatId}" multiple style="display:none" onchange="handleFileSelect(event, '${chatId}')">
          <button onclick="document.getElementById('file-input-${chatId}').click()" title="Attach a file: images are sent with the message, other files are uploaded to your files and their path is added to the message" style="background:var(--bg-input); border:1px solid var(--border); padding:8px 10px; font-size:1rem; cursor:pointer;">📎</button>
          <button onclick="toggleNotifyDone('${chatId}')" id="notify-${chatId}" class="notify-done-btn" style="display:none" aria-pressed="false" title="Get a notification on your phone when this reply is done">🔔 Notify me</button>
          <button onclick="sendSoloMessage('${chatId}')" id="send-${chatId}">Send</button>
        </div>
      `;
      panels.appendChild(panel);
      // Fill the model picker now, so its list is complete before the first click (modelPickDown).
      setTimeout(() => fillModelPick(chatId), 0);
      
      // Initialize pending images array for this chat
      chats[chatId].pendingImages = [];
    }

    function renderGroupChatPanel(chatId) {
      const chat = chats[chatId];
      const panels = document.getElementById('chat-panels');
      const panel = document.createElement('div');
      panel.className = 'chat-container';
      panel.id = `panel-${chatId}`;
      
      const modeLabel = {
        'free-flowing': '💬 Free-flowing',
        'autonomous': '🤖 Autonomous',
        'moderated': '📋 Moderated'
      }[chat.discussionType];
      
      const contextLabel = {
        'full': 'Full history',
        'summary-only': 'Summary only',
        'last-n': `Last ${chat.contextN} messages`
      }[chat.contextMode];
      
      const isAutonomous = chat.discussionType === 'autonomous';
      
      panel.innerHTML = `
        <div class="status-bar" id="status-bar-${chatId}">
          <div class="status-item">
            <span class="status-dot idle" id="status-dot-${chatId}"></span>
            <span id="status-text-${chatId}">Idle</span>
          </div>
          <span id="round-indicator-${chatId}" style="color: var(--purple)"></span>
          <div class="active-agents" id="active-agents-${chatId}"></div>
        </div>
        <div class="thinking-panel" id="thinking-panel-${chatId}">
          <div class="thinking-label"><span class="spinner"></span><span id="thinking-agent-${chatId}">Thinking</span></div>
          <div class="thinking-content" id="thinking-content-${chatId}"></div>
        </div>
        <div class="chat-actions">
          <button onclick="resyncClick()" class="resync-btn" id="resync-btn-${chatId}" title="Re-sync with the hub" aria-label="Re-sync with the hub">↻</button>
          <button onclick="clearChat('${chatId}')">🗑️ Clear</button>
          <button onclick="saveChat('${chatId}')">💾 Save</button>
          <button onclick="cancelGroupRequest('${chatId}')" id="cancel-${chatId}" style="display:none;">⏹️ Stop</button>
          <button onclick="resetChat('${chatId}')" style="background:var(--warning); color:black;">🔄 Reset</button>

          <span class="group-name">🐯 Tiger Team</span>
        </div>
        <div class="group-header">
          <span class="mode-badge ${chat.discussionType === 'moderated' ? 'moderated' : ''}">${modeLabel}</span>
          <span style="color: var(--text-dim)">Context: ${contextLabel}</span>
          ${chat.roundsPerTrigger > 1 ? `<span style="color: var(--text-dim); margin-left: 10px;">${chat.roundsPerTrigger} rounds/trigger</span>` : ''}
          <div class="participants">
            ${chat.agents.filter(a => a.name !== chat.summarizer?.name).map((a, i) => {
              return `<span class="participant" style="border-left: 3px solid ${AGENT_COLORS[i % AGENT_COLORS.length]}">${a.name}</span>`;
            }).join('')}
            ${chat.summarizer ? `<span class="participant summarizer">📋 ${chat.summarizer.name} (summarizer)</span>` : ''}
          </div>
          ${chat.topic ? `<div class="context-info">Topic: "${chat.topic}"</div>` : ''}
        </div>
        <div class="messages" id="messages-${chatId}"></div>
        <div class="agent-manager" id="agent-manager-${chatId}">
          <div class="agent-manager-header">
            <span>Manage Participants</span>
            <div class="add-agent-dropdown">
              <button onclick="toggleAddAgentMenu('${chatId}')">+ Add Agent</button>
              <div class="add-agent-menu" id="add-agent-menu-${chatId}"></div>
            </div>
          </div>
          <div class="agent-chips" id="agent-chips-${chatId}"></div>
        </div>
        <div class="input-area" id="input-area-${chatId}">
          <div class="input-wrapper">
            <div class="image-preview-area" id="image-preview-${chatId}"></div>
            <textarea id="input-${chatId}" placeholder="Type your message or question... (Ctrl+V to paste images)" onkeydown="handleKeyDown(event, '${chatId}')" onpaste="handlePaste(event, '${chatId}')" oninput="autoGrowTextarea(this)"></textarea>
          </div>
          <input type="file" id="file-input-${chatId}" multiple style="display:none" onchange="handleFileSelect(event, '${chatId}')">

          <button onclick="console.log('Send clicked for ${chatId}', chats['${chatId}']); sendGroupMessage('${chatId}')" id="send-${chatId}">Send</button>
          <button onclick="skipTurn('${chatId}')" id="skip-${chatId}" style="display:none; background:var(--purple);">⏭️ Skip / Continue</button>
          ${isAutonomous ? `
          <input type="number" id="continue-rounds-${chatId}" value="5" min="1" max="100" style="width:60px; padding:10px; background:var(--bg-input); border:1px solid var(--border); border-radius:6px; color:var(--text); text-align:center;">
          <button onclick="continueAutonomous('${chatId}', parseInt(document.getElementById('continue-rounds-${chatId}').value) || 1)" class="secondary">▶️ Auto</button>` : ''}
          <button onclick="toggleAgentManager('${chatId}')" style="background:var(--bg-input); border:1px solid var(--border);">⚙️</button>
        </div>
      `;
      panels.appendChild(panel);
      
      // Initialize pending images array for this chat
      chats[chatId].pendingImages = [];
    }

    function switchToChat(chatId) {
      document.querySelectorAll('.chat-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.chat-container').forEach(p => p.classList.remove('active'));
      document.getElementById(`tab-${chatId}`)?.classList.add('active');
      document.getElementById(`tab-${chatId}`)?.classList.remove('unread');
      document.getElementById(`panel-${chatId}`)?.classList.add('active');
      activeChat = chatId;
      window.__activeChatId = chatId;
      if (document.getElementById('files-panel')) filesRefresh(); // the Files panel follows the active chat's agent
      if (document.getElementById('recall-panel') && chats[chatId] && !chats[chatId].isGroup && chats[chatId].agent && String(chats[chatId].agent) !== recallState.agent) openRecallPanel(chatId); // so does Recall
      document.getElementById(`input-${chatId}`)?.focus();
      // Context footer disabled — live token-usage bar provides this info now
    }
    
    async function closeChat(chatId, event) {
      event?.stopPropagation();
      const chat = chats[chatId];
      if (!chat) return;

      if (chat.controller) chat.controller.abort();
      if (chat.controllers) Object.values(chat.controllers).forEach(c => c?.abort());
      if (chat.timerInterval) clearInterval(chat.timerInterval);

      // If closing a worker tab, clean up mappings (closed by the user: its runs stay closed)
      if (chat.isWorker) forgetWorkerCard(chatId, true);

      // If closing a coordinator, also close the worker tabs it called last
      if (!chat.isWorker) closeWorkerCardsOf(chatId);

      document.getElementById(`tab-${chatId}`)?.remove();
      document.getElementById(`panel-${chatId}`)?.remove();
      delete chats[chatId];
      rsnSweep();
      updateWorkerBarVisibility();

      const remaining = Object.keys(chats);
      if (remaining.length > 0) {
        switchToChat(remaining[remaining.length - 1]);
      } else {
        activeChat = null;
        window.__activeChatId = null;
        document.getElementById('empty-state').style.display = 'flex';
        if (document.getElementById('files-panel')) filesRefresh();
      }
    }
    
    function clearChat(chatId) {
      chats[chatId].messages = [];
      chats[chatId].syntheses = [];
      chats[chatId].currentRound = 0;
      document.getElementById(`messages-${chatId}`).innerHTML = '';
    }

    async function newSession(chatId) {
      const chat = chats[chatId];
      if (!chat || chat.isGroup) return;
      if (!confirm(`Start a new session for ${chat.agent}? This clears the agent's conversation history.`)) return;
      // Clear server-side session mapping
      try {
        await fetch(`/api/session/${encodeURIComponent(chat.agent)}`, { method: 'DELETE', credentials: 'include' });
      } catch (e) {
        console.log('Failed to clear session:', e.message);
      }
      // Reset local state
      chat.sessionId = null;
      chat.resumed = false;
      chat.messages = [chat.messages[0]]; // Keep system message
      chat.status = 'idle'; // Reset status to unblock input
      delete chat.lastMsgId; // Clear any stale message IDs
      setStatus(chatId, 'idle');
      setAgentStatus(chat.agent, '');
      document.getElementById(`messages-${chatId}`).innerHTML = '';
      const indicator = document.getElementById(`session-indicator-${chatId}`);
      if (indicator) { indicator.textContent = ''; indicator.title = ''; }
      appendMessage(chatId, 'system', 'New session started. Conversation history cleared.');
    }
    
    function saveChat(chatId) {
      const chat = chats[chatId];
      let header, content;
      
      if (chat.isGroup) {
        header = `# Tiger Team (${chat.discussionType})\nParticipants: ${chat.agents.map(a => a.name).join(', ')}\n`;
        if (chat.summarizer) header += `Summarizer: ${chat.summarizer.name}\n`;
        if (chat.topic) header += `Topic: ${chat.topic}\n`;
        header += `Context: ${chat.contextMode}\nDate: ${new Date().toISOString()}\n\n---\n\n`;
        
        content = chat.messages.map(m => {
          if (m.type === 'synthesis') return `[SYNTHESIS - Round ${m.round}]\n${m.content}\n`;
          if (m.type === 'round') return `\n--- Round ${m.round} ---\n`;
          const label = m.role === 'user' ? 'USER' : m.agent?.toUpperCase() || 'ASSISTANT';
          return `[${label}]\n${m.content}\n`;
        }).join('\n---\n\n');
      } else {
        header = `# Chat with ${chat.agent}\nModel: ${chat.model}\nDate: ${new Date().toISOString()}\n\n---\n\n`;
        content = chat.messages.map(m => `[${m.role.toUpperCase()}]\n${m.content}\n`).join('\n---\n\n');
      }
      
      const blob = new Blob([header + content], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = chat.isGroup ? `group-${chat.discussionType}-${Date.now()}.md` : `chat-${chat.agent}-${Date.now()}.md`;
      a.click();
      URL.revokeObjectURL(url);
    }
    
    // ── "Notify me when done": the 🔔 next to Interject while a reply runs. The hub keeps who asked on the running turn
    // and sends one notification to that person's devices when it ends (lib/push); turn_notify keeps every page in step.
    const notifyArmed = {};   // agent -> turnId this person asked to be notified about
    function myNotifyId() { const me = window.hubMe; return (me && me.user && me.user.id) ? String(me.user.id) : '*'; }
    function paintNotifyBtns(agent) {
      for (const [chatId, chat] of Object.entries(chats)) {
        if (!chat || chat.agent !== agent) continue;
        const btn = document.getElementById(`notify-${chatId}`);
        if (!btn) continue;
        const on = !!notifyArmed[agent];
        btn.classList.toggle('on', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.textContent = on ? '🔔 Notifying' : '🔔 Notify me';
        btn.title = on ? 'You will get a notification when this reply is done. Click to cancel.' : 'Get a notification on your phone when this reply is done';
      }
    }
    function showNotifyBtn(chatId, show) {
      // Next to Interject, only while the reply runs; gone the moment the turn is complete.
      const btn = document.getElementById(`notify-${chatId}`);
      if (btn) btn.style.display = show ? 'inline-block' : 'none';
      const chat = chats[chatId];
      if (chat && chat.agent) paintNotifyBtns(chat.agent);
    }
    function applyTurnNotify(agent, turn) {
      if (!agent || !turn) return;
      notifyArmed[agent] = (turn.active !== false && !turn.ended && Array.isArray(turn.notify) && turn.notify.includes(myNotifyId())) ? turn.turnId : null;
      paintNotifyBtns(agent);
    }
    async function toggleNotifyDone(chatId) {
      const chat = chats[chatId];
      if (!chat || !chat.agent) return;
      const agent = chat.agent, who = chat.display || capName(agent), on = !notifyArmed[agent];
      let r, d = {};
      try {
        r = await fetch(`/api/agents/${encodeURIComponent(agent)}/notify`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on }) });
        d = await r.json().catch(() => ({}));
      } catch { hubToast('Could not reach the hub.'); return; }
      if (r.status === 409) { notifyArmed[agent] = null; showNotifyBtn(chatId, false); hubToast(`${who} is not working on a reply right now.`); return; }
      if (!r.ok) { hubToast(d.detail || d.error || 'Could not change the notification.'); return; }
      notifyArmed[agent] = d.on ? d.turnId : null;
      paintNotifyBtns(agent);
      if (d.on && !d.devices) hubToast('No device of yours has notifications turned on yet. On the phone: the ⋮ menu, Notifications.', 9000);
      else if (d.on) hubToast(`You will get a notification when ${who} is done.`);
      else hubToast('Notification cancelled.');
    }

    // Ask the hub to stop the agent's running turn.  Closing the stream alone no longer stops it
    // (the server keeps working through disconnects), so Stop/Pause tell the server explicitly.
    // Older hubs answer 404 here; that is ignored.
    function stopAgentTurn(agentName) {
      return fetch('/api/chat/stop', {
        method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: agentName })
      }).catch(() => {});
    }

    function cancelRequest(chatId) {
      const chat = chats[chatId];
      stopAgentTurn(chat.agent);
      if (chat.controller) { chat.controller.abort(); chat.controller = null; }
      if (chat.reattach) {
        const ra = chat.reattach;
        delete chat.reattach;
        updateMessage(ra.msgId, ra.partial ? `${ra.partial}\n\n[Stopped]` : '[Stopped]');
        if (ra.partial) chat.messages.push({ role: 'assistant', content: `${ra.partial} [Stopped]`, partial: true });
        delete chat.lastMsgId;
        setAgentStatus(chat.agent, '');
      }
      updateThinkingPanel(chatId, '', null, false);
      cleanupWorkerTabs(chatId);
      setStatus(chatId, 'idle');
    }

    function pauseRequest(chatId) {
      const chat = chats[chatId];
      // Stop the turn on the server and abort the stream, but preserve partial response
      stopAgentTurn(chat.agent);
      if (chat.controller) { chat.controller.abort(); chat.controller = null; }
      updateThinkingPanel(chatId, '', null, false);
      cleanupWorkerTabs(chatId);
      // Set paused state — keeps session ID intact for auto-resume
      chat.paused = true;
      setStatus(chatId, 'paused', 'Paused — type your input and press Send to continue');
      // Focus the input
      const input = document.getElementById(`input-${chatId}`);
      if (input) {
        input.placeholder = 'Type your input and press Send to continue...';
        input.focus();
      }
    }
    
    function cancelGroupRequest(chatId) {
      const chat = chats[chatId];
      cleanupWorkerTabs(chatId);
      chat.cancelled = true;
      for (const a of Object.keys(chat.controllers || {})) stopAgentTurn(a);   // stop the agents on the hub, not just this page's streams
      Object.values(chat.controllers).forEach(c => c?.abort());
      chat.controllers = {};
      setStatus(chatId, 'idle');
    }
    
    function setStatus(chatId, status, statusText = null) {
      chats[chatId].status = status;

      // Stop tool tracker when leaving thinking state
      if (status !== 'thinking') {
        stopToolTracker(chatId);
        for (const [mid, st] of reasonState) if (st.live && st.chatId === chatId) finishReasoning(mid);   // its own stream's reasoning panels
      }

      // Tab status
      const tabStatusEl = document.querySelector(`#tab-${chatId} .status`);
      if (tabStatusEl) tabStatusEl.className = `status ${status}`;

      // Status bar
      const statusDot = document.getElementById(`status-dot-${chatId}`);
      const statusTextEl = document.getElementById(`status-text-${chatId}`);
      if (statusDot) statusDot.className = `status-dot ${status}`;
      if (statusTextEl) {
        statusTextEl.textContent = statusText || (status === 'thinking' ? 'Processing...' : status === 'paused' ? 'Paused' : status === 'error' ? 'Error' : 'Idle');
      }

      const pauseBtn = document.getElementById(`pause-${chatId}`);
      const cancelBtn = document.getElementById(`cancel-${chatId}`);
      const sendBtn = document.getElementById(`send-${chatId}`);

      const input = document.getElementById(`input-${chatId}`);

      if (status === 'thinking') {
        if (pauseBtn) pauseBtn.style.display = 'inline-block';
        if (cancelBtn) cancelBtn.style.display = 'inline-block';
        showNotifyBtn(chatId, true);
        // Enable interjection mode - user can type while agent runs
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = '⚡ Interject';
          sendBtn.style.background = 'var(--warning)';
          sendBtn.style.color = 'black';
        }
        if (input) input.placeholder = 'Type to interject new info into the running agent...';
      } else if (status === 'paused') {
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
        showNotifyBtn(chatId, false);
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          sendBtn.style.background = '';
          sendBtn.style.color = '';
        }
      } else {
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (cancelBtn) cancelBtn.style.display = 'none';
        showNotifyBtn(chatId, false);
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send';
          sendBtn.style.background = '';
          sendBtn.style.color = '';
        }
        // Clear active agents display
        const activeAgentsEl = document.getElementById(`active-agents-${chatId}`);
        if (activeAgentsEl) activeAgentsEl.innerHTML = '';
        // Reset input placeholder when going idle
        if (input && chats[chatId]?.paused) {
          input.placeholder = 'Message...';
          chats[chatId].paused = false;
        } else if (input) {
          input.placeholder = 'Type your message... (Ctrl+V to paste images)';
        }
      }
    }
    
    // 'thinking' = this browser is streaming a reply from the agent; '' = done.  The sidebar dot
    // merges this with the live status the hub reports (see paintAgentStatus).
    function setAgentStatus(agentName, status) {
      if (status === 'thinking') { if (!localBusy.has(agentName)) localBusy.set(agentName, new Date().toISOString()); }
      else localBusy.delete(agentName);
      paintAgentStatus(agentName);
      paintAgentsWorking();
    }

    // ── Tool Activity Tracker (live progress indicator) ──
    const toolTrackers = new Map(); // chatId -> { startTime, currentTool, intervalId, agentName, toolCount }

    function startToolTracker(chatId, agentName) {
      stopToolTracker(chatId);
      const tracker = {
        startTime: Date.now(),
        currentTool: null,
        toolCount: 0,
        agentName: agentName || 'Agent',
        intervalId: setInterval(() => updateToolTrackerDisplay(chatId), 1000),
        streaming: false,
      };
      toolTrackers.set(chatId, tracker);
      updateToolTrackerDisplay(chatId);
    }

    function updateToolActivity(chatId, toolName) {
      const tracker = toolTrackers.get(chatId);
      if (!tracker) return;
      // Truncate long tool descriptions for the status display
      tracker.currentTool = toolName.length > 60 ? toolName.substring(0, 57) + '...' : toolName;
      tracker.toolCount++;
      tracker.streaming = false;
      updateToolTrackerDisplay(chatId);
    }

    function updateToolStreaming(chatId) {
      const tracker = toolTrackers.get(chatId);
      if (!tracker || tracker.streaming) return;
      tracker.streaming = true;
      tracker.currentTool = null;
      updateToolTrackerDisplay(chatId);
    }

    function stopToolTracker(chatId) {
      const tracker = toolTrackers.get(chatId);
      if (tracker) {
        clearInterval(tracker.intervalId);
        toolTrackers.delete(chatId);
      }
      // Hide thinking panel
      const panel = document.getElementById(`thinking-panel-${chatId}`);
      if (panel) panel.classList.remove('active');
    }

    function updateToolTrackerDisplay(chatId) {
      const tracker = toolTrackers.get(chatId);
      if (!tracker) return;

      const elapsed = Math.floor((Date.now() - tracker.startTime) / 1000);
      const mins = Math.floor(elapsed / 60);
      const secs = elapsed % 60;
      const timeStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

      // Build status text
      let detail = '';
      if (tracker.streaming) {
        detail = 'streaming response';
      } else if (tracker.currentTool) {
        detail = tracker.currentTool;
      } else {
        detail = 'starting up';
      }

      const statusText = `${tracker.agentName} (${timeStr}) — ${detail}`;

      // Update status bar text
      const statusTextEl = document.getElementById(`status-text-${chatId}`);
      if (statusTextEl) statusTextEl.textContent = statusText;

      // Update thinking panel
      const panel = document.getElementById(`thinking-panel-${chatId}`);
      const agentEl = document.getElementById(`thinking-agent-${chatId}`);
      if (panel && agentEl) {
        panel.classList.add('active');
        agentEl.textContent = statusText;
      }
    }
    
    function updateActiveAgents(chatId, agentName, isActive) {
      const container = document.getElementById(`active-agents-${chatId}`);
      if (!container) return;
      
      const existingEl = document.getElementById(`active-${chatId}-${agentName}`);
      
      if (isActive && !existingEl) {
        const el = document.createElement('span');
        el.className = 'active-agent';
        el.id = `active-${chatId}-${agentName}`;
        el.innerHTML = `<span class="dot"></span>${agentName}`;
        container.appendChild(el);
      } else if (!isActive && existingEl) {
        existingEl.remove();
      }
    }
    
    function updateRoundIndicator(chatId, round, total = null) {
      const el = document.getElementById(`round-indicator-${chatId}`);
      if (el) {
        el.textContent = total ? `Round ${round}/${total}` : `Round ${round}`;
      }
    }
    
    // Image handling functions
    function handlePaste(event, chatId) {
      const items = event.clipboardData?.items;
      if (!items) return;

      for (const item of items) {
        if (item.type.startsWith('image/')) {
          event.preventDefault();
          const file = item.getAsFile();
          if (file) addImageToChat(chatId, file);
        } else if (item.kind === 'file') {
          // A pasted non-image file (e.g. from a file manager) goes to the files root like the paperclip does.
          const file = item.getAsFile();
          if (file && file.name) { event.preventDefault(); uploadFileForChat(chatId, file); }
        }
      }
    }

    // Images are sent inline with the message; any other file is uploaded to the files root
    // and its server path is appended to the message so the agent can read it.
    function handleFileSelect(event, chatId) {
      const files = event.target.files;
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          addImageToChat(chatId, file);
        } else {
          uploadFileForChat(chatId, file);
        }
      }
      event.target.value = ''; // Reset input
    }
    
    function addImageToChat(chatId, file) {
      const chat = chats[chatId];
      if (!chat.pendingImages) chat.pendingImages = [];
      
      // Resize large images to max 1600px on longest side, compress as JPEG
      const img = new Image();
      img.onload = () => {
        const MAX_DIM = 1600;
        let { width, height } = img;
        if (width > MAX_DIM || height > MAX_DIM) {
          const scale = MAX_DIM / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        // Use JPEG at 85% quality for screenshots (much smaller than PNG)
        const base64 = canvas.toDataURL('image/jpeg', 0.85);
        console.log(`[image] Resized ${img.naturalWidth}x${img.naturalHeight} → ${width}x${height}, size=${(base64.length / 1024).toFixed(0)}KB`);
        chat.pendingImages.push(base64);
        renderImagePreviews(chatId);
      };
      img.src = URL.createObjectURL(file);
    }
    
    function removeImageFromChat(chatId, index) {
      const chat = chats[chatId];
      if (chat.pendingImages) {
        chat.pendingImages.splice(index, 1);
        renderImagePreviews(chatId);
      }
    }
    
    function renderImagePreviews(chatId) {
      const chat = chats[chatId];
      const container = document.getElementById(`image-preview-${chatId}`);
      if (!container || !chat.pendingImages) return;
      
      if (chat.pendingImages.length === 0) {
        container.innerHTML = '';
        return;
      }
      
      container.innerHTML = chat.pendingImages.map((img, i) => `
        <div class="image-preview">
          <img src="${img}" alt="Preview ${i+1}">
          <button class="remove-preview" onclick="removeImageFromChat('${chatId}', ${i})">×</button>
        </div>
      `).join('') + '<span class="paste-hint">Images will be sent with your message</span>';
    }
    
    function clearPendingImages(chatId) {
      const chat = chats[chatId];
      if (chat) {
        chat.pendingImages = [];
        renderImagePreviews(chatId);
      }
    }
    
    function autoGrowTextarea(el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 400) + 'px';
    }

    function handleKeyDown(event, chatId) {
      if (event.key === 'Escape') {
        if (rsnFullFor) { event.preventDefault(); closeReasoningFull(); return; }   // the open reasoning view goes first
        if (toolsFullFor) { event.preventDefault(); closeToolsFull(); return; }     // so does the open tool view
        const chat = chats[chatId];
        if (chat && chat.status === 'thinking' && !chat.isGroup) {
          event.preventDefault();
          pauseRequest(chatId);
        }
        return;
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        const chat = chats[chatId];
        const input = document.getElementById(`input-${chatId}`);

        if (chat.isGroup) {
          // In group chats, always allow sending messages (even in autonomous mode when idle)
          if (input.value.trim()) {
            sendGroupMessage(chatId);
          }
        } else {
          sendSoloMessage(chatId);
        }
      }
    }
    
    // ── Re-attach after a lost connection ─────────────────────────────
    // When the stream drops mid-turn (sleep, Wi-Fi change, hub hiccup) the message
    // is never resent: the server keeps the turn running and writes the reply to
    // history, so the window re-attaches to that instead.
    const REATTACH_GIVE_UP_MS = 30 * 60 * 1000;   // only used when the hub cannot tell us whether the agent is busy

    function enterReattach(chatId, msgId, content, partialText, reason, since = null, sentAt = null) {
      const chat = chats[chatId];
      if (!chat) return;
      chat.controller = null;
      // content: the user message this window sent (null when the turn was started elsewhere or before
      // this page loaded); since: when the hub says the turn began, used to find the reply in history;
      // sentAt: when this window sent content (its own clock).
      chat.reattach = { msgId, content, since, sentAt, partial: partialText || '', startedAt: Date.now(), checking: false, turnId: null, items: new Map(), workers: new Set() };
      chat.lastMsgId = msgId;
      console.warn(`[re-attach] ${chat.agent}: ${reason}`);
      paintReattach(chatId, `⟳ Connection lost; ${chat.display || chat.agent} is still working on the server…`);
      setStatus(chatId, 'thinking', `Connection lost — waiting for ${chat.agent}'s reply`);
      setAgentStatus(chat.agent, 'thinking');
      catchUpTurn(chatId);   // the hub's view first: partial text, tool activity, workers
      setTimeout(() => reattachCheck(chatId), 1500);
    }

    function paintReattach(chatId, line) {
      const ra = chats[chatId]?.reattach;
      if (!ra) return;
      if (!ra.items || !ra.items.size) { updateMessage(ra.msgId, ra.partial ? `${ra.partial}\n\n${line}` : line); restoreLiveBars(ra.msgId); return; }
      const steps = turnSteps(ra, ra.partial || '');
      steps.push({ text: line, tools: [] });   // what the turn is doing now, below what it has done
      renderSteps(ra.msgId, steps, turnToolActivity(ra), [], true);
    }

    function finishReattach(chatId, text, ok = true) {
      const chat = chats[chatId];
      const ra = chat?.reattach;
      if (!ra) return;
      delete chat.reattach;
      clearLiveActivity(ra.msgId);
      if (ra.items && ra.items.size) renderSteps(ra.msgId, turnSteps(ra, text), turnToolActivity(ra), [], false); else updateMessage(ra.msgId, text);
      if (tokenUsageState.has(ra.msgId)) finalizeTokenUsage(ra.msgId);
      for (const id of ra.workers || []) { const w = workerRunOf(id); if (w && w.run.status === 'running') handleWorkerEvent(chatId, { type: 'worker_completed', worker_id: id }); }
      const existingIdx = chat.messages.findIndex(m => m.role === 'assistant' && m.partial);
      if (existingIdx >= 0) chat.messages.splice(existingIdx, 1);
      if (ok) chat.messages.push({ role: 'assistant', content: text });
      setStatus(chatId, ok ? 'idle' : 'error', ok ? null : 'Reply lost');
      setAgentStatus(chat.agent, '');
      delete chat.lastMsgId;
      markTabUnread(chatId);
    }

    // Can the hub say whether this agent is still working?  true/false, or null on an old hub.
    async function probeAgentBusy(agentName) {
      try {
        const r = await fetch('/api/agents/status', { credentials: 'include', signal: AbortSignal.timeout(5000) });
        if (r.ok) {
          const d = await r.json();
          const s = d.agents?.[agentName];
          if (s) return !!s.busy;
        }
      } catch {}
      try {
        const r = await fetch('/api/agents', { credentials: 'include', signal: AbortSignal.timeout(5000) });
        if (!r.ok) return null;
        const a = ((await r.json()).agents || []).find(x => x.name === agentName);
        return a && 'busy' in a ? !!a.busy : null;
      } catch { return null; }
    }

    // Which history entry is the message this window sent before its connection dropped? The hub stamps a
    // user entry when it receives it, so that entry can't be older than the send. An identical earlier message
    // (an earlier "Build it") must never be taken for it, or that message's old reply is shown as the answer to
    // a message the hub never got. The send time is moved onto the hub's clock with the history response's
    // Date header, so a computer clock that is off doesn't matter; ten seconds cover the header's whole seconds.
    function ownEntryIndex(history, content, sentAt, hubDate, now = Date.now()) {
      const hubNow = Date.parse(hubDate || '');
      const floor = (Number.isFinite(hubNow) ? hubNow - (now - sentAt) : sentAt) - 10000;
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (m.role === 'user' && m.content === content && Date.parse(m.ts) >= floor) return i;
      }
      return -1;
    }

    // Reload the tail of the agent's history and finish the bubble once a reply newer than our
    // own user entry is there.  Otherwise keep waiting while the agent is busy.
    // Shared verbatim with lib/ui-turn-reply.js and mobile.js (test/ui-turn-reply.test.js keeps the three in step).
    // ── turn-reply helpers (begin) ──
    function turnReplyFrom(history, start, minTs) {
      let reply = null, content = '';
      for (let i = Math.max(0, start); i < history.length; i++) {
        const m = history[i];
        if (!m) continue;
        if (m.role === 'user' && !m.ask) break;                                  // the next turn
        if (m.role !== 'assistant' || m.ask || typeof m.content !== 'string') continue;
        if (minTs && m.ts && Date.parse(m.ts) < minTs) continue;
        if (!reply) { reply = m; content = m.content; continue; }                 // the reply's first piece
        if (m.base > 0 && m.base === content.length) { reply = m; content += m.content; continue; }   // the next piece
        break;                                                                    // another reply: not this turn's
      }
      return reply ? { ...reply, content } : null;
    }
    function turnReplySince(history, sinceTs) {
      for (let i = history.length - 1; i >= 0; i--) {
        const m = history[i];
        if (!m || (m.role === 'user' && !m.ask) || !m.ts || !(Date.parse(m.ts) >= sinceTs)) return null;
        if (m.role === 'assistant' && !m.ask && typeof m.content === 'string' && !(m.base > 0)) return turnReplyFrom(history, i, sinceTs);
      }
      return null;
    }
    // ── turn-reply helpers (end) ──

    async function reattachCheck(chatId) {
      const chat = chats[chatId];
      const ra = chat?.reattach;
      if (!ra || ra.checking) return;
      ra.checking = true;
      try {
        const r = await fetch(`/api/history/${encodeURIComponent(chat.agent)}`, { credentials: 'include', signal: AbortSignal.timeout(8000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const history = (await r.json()).history || [];
        const ui = ra.content ? ownEntryIndex(history, ra.content, ra.sentAt || ra.startedAt, r.headers.get('Date')) : -1;
        const userTs = ui >= 0 ? Date.parse(history[ui].ts) : NaN;
        // The whole reply: in pieces when the agent asked a question meanwhile (lib/ui-turn-reply.js).
        let reply = ui >= 0 ? turnReplyFrom(history, ui + 1, userTs) : null;
        if (!reply && ui < 0 && ra.since) {
          // No user entry to anchor on (the turn began before this page loaded): the newest reply
          // written since the hub says the turn started.
          reply = turnReplySince(history, Date.parse(ra.since) - 2000);
        }
        if (!chats[chatId]?.reattach) return;

        const live = agentStatus[chat.agent];
        const stillBusy = live ? live.busy : await probeAgentBusy(chat.agent);
        if (!chats[chatId]?.reattach) return;
        // While the agent is still working, an assistant entry in history is only the incremental
        // partial save: show it as progress and keep waiting for turn_end rather than finishing early.
        if (reply && (stillBusy === true || reply.inProgress)) {   // inProgress: the hub says that turn is still running
          // (text only, saved every 5 s: the hub's turn view and live events are fresher; take it only when longer)
          if (reply.content && reply.content.length > (ra.partial || '').length) ra.partial = reply.content;
          paintReattach(chatId, reattachLine(chat, ra));
          setTimeout(() => reattachCheck(chatId), 10000);
          return;
        }
        if (reply) {
          if (typeof reply.reasoning === 'string' && reply.reasoning) setReasoning(ra.msgId, reply.reasoning, { total: Number(reply.reasoningChars), onlyIfLonger: true });
          finishReattach(chatId, reply.content);
          return;
        }
        const waited = Date.now() - ra.startedAt;
        if (stillBusy === false && waited > 15000) {
          if (ui < 0 && ra.content) {
            // The hub never got the message: hand it back, never resend on our own.
            const input = document.getElementById(`input-${chatId}`);
            if (input && !input.value) input.value = ra.content;
            finishReattach(chatId, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ The hub has no record of this message, so it is back in the input box. If you are not sure it was lost, reload the chat before sending it again.`, false);
          } else {
            finishReattach(chatId, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ ${chat.display || chat.agent} stopped without a reply (the hub may have restarted).`, false);
          }
          return;
        }
        if (stillBusy === null && waited > REATTACH_GIVE_UP_MS) {
          finishReattach(chatId, `${ra.partial ? ra.partial + '\n\n' : ''}⚠ No reply arrived in 30 minutes and this hub cannot say whether ${chat.agent} is still working. Check the history or resend.`, false);
          return;
        }
        paintReattach(chatId, stillBusy === false
          ? `⟳ Waiting for ${chat.display || chat.agent}'s reply…`
          : reattachLine(chat, ra));
        setStatus(chatId, 'thinking', `${chat.agent} is working on the server — reply will appear here`);
      } catch (err) {
        console.warn('[re-attach] check failed:', err.message);
      } finally {
        if (ra) ra.checking = false;
      }
    }

    function reattachCheckAll() {
      for (const chatId of Object.keys(chats)) if (chats[chatId]?.reattach) reattachCheck(chatId);
    }
    // A wake (sleep, another app, back/forward cache, network back) gets a fresh event stream plus
    // status, re-attach checks and turn catch-up; resync() runs those once per 2 s however many fire.
    window.addEventListener('online', () => resync());
    window.addEventListener('focus', () => resync());
    window.addEventListener('pageshow', () => resync());
    document.addEventListener('visibilitychange', () => { if (!document.hidden) resync(); });

    // Interject into a running agent turn (does not kill the turn)
    // A chat whose interjection found the turn already over sends the text as a normal message
    // once, even if the busy status has not caught up yet.
    const skipInterjectOnce = new Set();
    async function sendInterjection(chatId) {
      const chat = chats[chatId];
      const input = document.getElementById(`input-${chatId}`);
      const content = input.value.trim();
      if (!content) return;

      input.value = '';
      input.style.height = 'auto';

      // Show the interjection in the chat as a user message with a distinct style
      appendMessage(chatId, 'user', `⚡ [Interjection] ${content}`);

      // Show a transient "sent" notice that will be updated when the agent picks it up
      const noticeEl = appendSystemNotice(chatId, '⚡ Interjection sent - waiting for agent to pick it up...');
      if (noticeEl) noticeEl.id = `interject-notice-${chatId}`;

      try {
        const resp = await fetch('/api/chat/interject', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: chat.agent, message: content })
        });
        const result = await resp.json();
        if (result.success) {
          if (noticeEl) noticeEl.textContent = '⚡ Interjection delivered into the running turn';
        } else if (/not currently processing/i.test(String(result.error || ''))) {
          // The turn ended between the status update and the send: go as a normal message.
          if (noticeEl) noticeEl.textContent = '↪ The turn had already ended, sending as a new message…';
          skipInterjectOnce.add(chatId);
          input.value = content;
          return sendSoloMessage(chatId);
        } else {
          if (noticeEl) { noticeEl.textContent = `⚠️ Interjection failed: ${result.error}`; }
        }
      } catch (e) {
        if (noticeEl) { noticeEl.textContent = `⚠️ Interjection failed: ${e.message}`; }
      }
    }

    // Solo chat - multi-provider LLM routing (with retry logic)
    async function sendSoloMessage(chatId, retryCount = 0) {
      if (!retryCount) tzSentAt = Date.now();   // the person's own send: its request carries this device's zone (zoneHeader)
      const chat = chats[chatId];
      const input = document.getElementById(`input-${chatId}`);
      const content = input.value.trim();
      const pendingImages = chat.pendingImages || [];

      // Route to interjection whenever the agent is working: a turn this tab started, or one the hub
      // reports busy (started from the phone, a schedule, a consult or another tab). Before this the
      // desktop only interjected into its own turn and every other send bounced as "busy".
      // Images cannot be interjected, so a message with images still goes the normal way.
      const liveNow = agentStatus[chat.agent];
      const agentWorking = chat.status === 'thinking' || !!(liveNow && liveNow.busy);
      if (content && agentWorking && pendingImages.length === 0 && !skipInterjectOnce.delete(chatId)) {
        return sendInterjection(chatId);
      }

      // Need content OR images to send
      if (!content && pendingImages.length === 0) return;

      // Clear paused state if resuming
      if (chat.paused) {
        chat.paused = false;
        input.placeholder = 'Message...';
      }

      // Freeze the context footer so it scrolls up with the conversation
      const oldFooter = document.getElementById('context-footer');
      if (oldFooter) {
        oldFooter.removeAttribute('id');
        oldFooter.style.position = 'relative';
        oldFooter.style.borderTop = 'none';
        oldFooter.style.opacity = '0.5';
      }

      // Only clear input and add to history on first attempt (not retries)
      let userMsgEl = null;
      if (retryCount === 0) {
        input.value = '';
        input.style.height = 'auto';

        // Store images with message for history
        chat.messages.push({ role: 'user', content, images: pendingImages.length > 0 ? [...pendingImages] : undefined });
        appendMessageWithImages(chatId, 'user', content, pendingImages);
        userMsgEl = document.getElementById(`messages-${chatId}`)?.lastElementChild || null;
      }

      // Clear pending images
      const imagesToSend = [...pendingImages];
      if (retryCount === 0) {
        clearPendingImages(chatId);
      }

      // The hub says the agent is still on an earlier turn: warn, but let the message go.
      const live = agentStatus[chat.agent];
      if (live && live.busy) {
        const since = elapsedLabel(live.busySince, false);
        appendSystemNotice(chatId, `⏳ ${chat.display || chat.agent} is still working on the previous message (${live.activity || 'working'}${since ? `, ${since}` : ''}). Your message will queue or be refused (409) until it finishes.`);
      }

      setStatus(chatId, 'thinking', `${chat.agent} responding...`);
      setAgentStatus(chat.agent, 'thinking');
      if (retryCount === 0) {
        startToolTracker(chatId, chat.agent);
      }
      chat.controller = new AbortController();
      chat.forceReattach = false;

      const msgId = chat.lastMsgId || appendMessage(chatId, 'assistant', '⏳ Thinking...');
      chat.lastMsgId = msgId;
      const sentAt = Date.now();   // after a lost connection, only history the hub saved since then can be this message

      try {
        // Send only the raw user message — server manages conversation history
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...zoneHeader() },
          signal: chat.controller.signal,
          body: JSON.stringify({
            agent: chat.agent,
            message: content,
            images: imagesToSend
          })
        });

        if (response.status === 409) {
          // Agent busy: nothing was sent. Deliver the text into the running turn instead of bouncing it
          // (once per message; a message with images cannot be interjected and is handed back).
          document.getElementById(msgId)?.remove();
          if (userMsgEl) userMsgEl.remove();
          const last = chat.messages[chat.messages.length - 1];
          if (last && last.role === 'user' && last.content === content) chat.messages.pop();
          setStatus(chatId, 'idle');
          setAgentStatus(chat.agent, '');
          delete chat.lastMsgId;
          chat.controller = null;
          if (!imagesToSend.length && !chat.bounced409) {
            chat.bounced409 = true;
            setAgentLive(chat.agent, { busy: true });
            input.value = content;
            return sendInterjection(chatId);
          }
          chat.bounced409 = false;
          if (!input.value) input.value = content;
          chat.pendingImages = imagesToSend;
          renderImagePreviews(chatId);
          appendSystemNotice(chatId, `⛔ ${chat.display || chat.agent} is busy; it will finish first. Your message was not sent — it is back in the input box.`, 'warning');
          return;
        }
        chat.bounced409 = false;
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const { text: fullResponse, images: responseImages, toolActivity, partial, steps: responseSteps } = await streamResponseSolo(response, msgId, chatId, chat.agent);

        // Success! Save response and clean up
        if (responseImages.length > 0) {
          renderSteps(msgId, responseSteps || [{ text: fullResponse, tools: [] }], toolActivity, responseImages, false);
        }

        // Only add to history if we got a real response (not just reconnecting)
        if (fullResponse && fullResponse !== '[No response]' && !partial) {
          // Remove old partial message if exists
          const existingIdx = chat.messages.findIndex(m => m.role === 'assistant' && m.partial);
          if (existingIdx >= 0) chat.messages.splice(existingIdx, 1);

          chat.messages.push({ role: 'assistant', content: fullResponse });
        }

        setStatus(chatId, 'idle');
        setAgentStatus(chat.agent, '');
        delete chat.lastMsgId;
      } catch (err) {
        // Detect user-initiated cancel: AbortError, or any error while status is already idle
        // (cancelRequest sets idle before the fetch error propagates)
        const hubRecovered = chat.forceReattach === true;
        chat.forceReattach = false;
        const wasUserCancelled = !hubRecovered && (err.name === 'AbortError' || chat.status === 'idle' || !chat.controller);
        if (wasUserCancelled) {
          // Keep whatever was already streamed — don't overwrite
          const msgEl = document.getElementById(msgId);
          const existing = msgEl ? msgEl.textContent : '';
          const wasPaused = chat.paused;
          if (existing && existing !== '⏳ Thinking...' && existing !== '🔄 Reconnecting...') {
            const existingIdx = chat.messages.findIndex(m => m.role === 'assistant' && m.partial);
            if (existingIdx >= 0) {
              chat.messages[existingIdx].content = existing;
            } else {
              const tag = wasPaused ? ' [Paused]' : ' [Cancelled]';
              chat.messages.push({ role: 'assistant', content: existing + tag, partial: true });
            }
          }
          if (!wasPaused) {
            setStatus(chatId, 'idle');
          }
          delete chat.lastMsgId;
        } else {
          const msgEl = document.getElementById(msgId);
          const existing = msgEl ? msgEl.textContent : '';
          const partialText = existing && existing !== '⏳ Thinking...' ? existing : '';
          const isConnectionLoss = hubRecovered ||
                                   err.name === 'TypeError' ||              // fetch(): network error / failed to fetch
                                   err.message.includes('network') ||
                                   err.message.includes('fetch') ||
                                   err.message.includes('stall') ||
                                   err.message.includes('stream') ||
                                   err.message.includes('ECONNRESET') ||
                                   err.message.includes('ECONNREFUSED') ||
                                   err.message.includes('socket hang up') ||
                                   /^HTTP 50[234]/.test(err.message);
          if (isConnectionLoss) {
            // ── Connection lost: NEVER resend.  The server keeps running the turn; re-attach to it. ──
            if (partialText) chat.messages.push({ role: 'assistant', content: partialText, partial: true });
            enterReattach(chatId, msgId, content, partialText, err.message, null, sentAt);
            return;
          }
          // A real error from the hub (4xx, bad request, ...)
          if (partialText) {
            chat.messages.push({ role: 'assistant', content: partialText, partial: true });
            updateMessage(msgId, `${partialText}\n\n❌ Stream interrupted: ${err.message}`);
          } else {
            updateMessage(msgId, `❌ Error: ${err.message}`);
          }
          setStatus(chatId, 'idle');
          delete chat.lastMsgId;
        }
        setAgentStatus(chat.agent, '');
      }
      chat.controller = null;
    }
    
    // Group chat - free flowing
    async function sendGroupMessage(chatId) {
      tzSentAt = Date.now();   // the person's own send: the first speaker's request carries this device's zone (zoneHeader)
      const chat = chats[chatId];
      const input = document.getElementById(`input-${chatId}`);
      const content = input.value.trim();
      const pendingImages = chat.pendingImages || [];
      
      console.log(`sendGroupMessage(${chatId}) - content: "${content}", images: ${pendingImages.length}, status: ${chat.status}, waitingForUser: ${chat.waitingForUser}`);
      
      // If waiting for user and they submit empty (no content AND no images), treat as skip
      if (chat.waitingForUser && !content && pendingImages.length === 0) {
        skipTurn(chatId);
        return;
      }
      
      if (!content && pendingImages.length === 0 && !chat.waitingForUser) {
        console.log('No content or images, returning');
        return;
      }
      if (chat.status === 'thinking') {
        console.log('Still thinking, returning');
        
        return;
      }
      
      console.log('Proceeding to send message...');
      
      // Hide skip button, clear timeout, show we're processing
      showSkipButton(chatId, false);
      chat.waitingForUser = false;
      if (chat.userTimeout) { clearTimeout(chat.userTimeout); chat.userTimeout = null; }
      if (chat.userCountdown) { clearInterval(chat.userCountdown); chat.userCountdown = null; }
      
      if (content || pendingImages.length > 0) {
        input.value = '';
        input.style.height = 'auto';
        chat.messages.push({ role: 'user', content, images: pendingImages.length > 0 ? [...pendingImages] : undefined });
        appendMessageWithImages(chatId, 'user', content, pendingImages);
        clearPendingImages(chatId);
      }
      
      chat.cancelled = false;
      setStatus(chatId, 'thinking', 'Running discussion...');
      
      try {
        // Run one round
        chat.currentRound++;
        updateRoundIndicator(chatId, chat.currentRound, null);
        await runDiscussionRound(chatId);
        
        if (chat.summarizer && !chat.cancelled) {
          await runSynthesis(chatId);
        }
        
        // If pause for user is enabled AND not autonomous mode, wait for their turn (30s timeout)
        if (chat.pauseForUser && chat.discussionType !== 'autonomous' && !chat.cancelled) {
          waitForUserWithTimeout(chatId);
        } else {
          setStatus(chatId, 'idle');
        }
      } catch (err) {
        console.error('Group message error:', err);
        setStatus(chatId, 'idle');
      }
    }
    
    function waitForUserWithTimeout(chatId) {
      const chat = chats[chatId];
      if (!chat) return;
      
      // Clear any existing timeout
      if (chat.userTimeout) clearTimeout(chat.userTimeout);
      
      setStatus(chatId, 'idle', 'Your turn (30s)...');
      showSkipButton(chatId, true);
      chat.waitingForUser = true;
      
      // Start countdown display
      let remaining = 30;
      chat.userCountdown = setInterval(() => {
        remaining--;
        if (remaining > 0 && chat.waitingForUser) {
          setStatus(chatId, 'idle', `Your turn (${remaining}s)...`);
        } else {
          clearInterval(chat.userCountdown);
        }
      }, 1000);
      
      // Auto-continue after 30 seconds
      chat.userTimeout = setTimeout(() => {
        if (chat.waitingForUser && chat.status !== 'thinking') {
          clearInterval(chat.userCountdown);
          appendSystemMessage(chatId, '⏩ No input - continuing automatically');
          skipTurn(chatId);
        }
      }, 30000);
    }
    
    function skipTurn(chatId) {
      const chat = chats[chatId];
      if (!chat || chat.status === 'thinking') return;
      
      console.log(`Skipping turn for ${chatId}`);
      chat.waitingForUser = false;
      if (chat.userTimeout) { clearTimeout(chat.userTimeout); chat.userTimeout = null; }
      if (chat.userCountdown) { clearInterval(chat.userCountdown); chat.userCountdown = null; }
      showSkipButton(chatId, false);
      
      // Continue the discussion without user input
      continueDiscussion(chatId);
    }
    
    async function continueDiscussion(chatId) {
      const chat = chats[chatId];
      if (!chat || chat.status === 'thinking') return;
      
      chat.cancelled = false;
      setStatus(chatId, 'thinking', 'Agents responding...');
      
      try {
        chat.currentRound++;
        updateRoundIndicator(chatId, chat.currentRound, null);
        await runDiscussionRound(chatId);
        
        if (chat.summarizer && !chat.cancelled) {
          await runSynthesis(chatId);
        }
        
        // Pause for user again if enabled (but not in autonomous mode)
        if (chat.pauseForUser && chat.discussionType !== 'autonomous' && !chat.cancelled) {
          waitForUserWithTimeout(chatId);
        } else {
          setStatus(chatId, 'idle');
        }
      } catch (err) {
        console.error('Continue discussion error:', err);
        setStatus(chatId, 'idle');
      }
    }
    
    function showSkipButton(chatId, show) {
      const skipBtn = document.getElementById(`skip-${chatId}`);
      if (skipBtn) {
        skipBtn.style.display = show ? 'inline-block' : 'none';
      }
    }
    
    // Autonomous discussion
    async function startAutonomousDiscussion(chatId, topic) {
      const chat = chats[chatId];
      chat.cancelled = false;
      
      // Add topic as system message
      chat.messages.push({ role: 'system', content: `Discussion topic: ${topic}`, type: 'topic' });
      appendSystemMessage(chatId, `📌 Topic: ${topic}`);
      
      setStatus(chatId, 'thinking', 'Starting discussion...');
      
      // Run configured number of rounds (default to roundsPerTrigger or 1)
      const totalRounds = chat.roundsPerTrigger || 1;
      
      try {
        for (let r = 0; r < totalRounds && !chat.cancelled; r++) {
          chat.currentRound++;
          updateRoundIndicator(chatId, r + 1, totalRounds);
          appendRoundIndicator(chatId, chat.currentRound);
          await runDiscussionRound(chatId);
          
          if (chat.summarizer && !chat.cancelled) {
            await runSynthesis(chatId);
          }
        }
      } catch (err) {
        console.error('Autonomous start error:', err);
      } finally {
        setStatus(chatId, 'idle');
      }
    }
    
    async function continueAutonomous(chatId, rounds = 1) {
      const chat = chats[chatId];
      if (chat.status === 'thinking') return;
      
      chat.cancelled = false;
      setStatus(chatId, 'thinking', 'Running discussion...');
      
      try {
        for (let r = 0; r < rounds && !chat.cancelled; r++) {
          chat.currentRound++;
          updateRoundIndicator(chatId, r + 1, rounds);
          appendRoundIndicator(chatId, chat.currentRound);
          await runDiscussionRound(chatId);
          
          if (chat.summarizer && !chat.cancelled) {
            await runSynthesis(chatId);
          }
        }
      } catch (err) {
        console.error('Autonomous error:', err);
      } finally {
        setStatus(chatId, 'idle');
      }
    }
    
    async function runDiscussionRound(chatId) {
      const chat = chats[chatId];
      
      // Get participants (always exclude summarizer - they only summarize, never participate)
      const participants = chat.summarizer 
        ? chat.agents.filter(a => a.name !== chat.summarizer.name)
        : chat.agents;
      
      for (let i = 0; i < participants.length && !chat.cancelled; i++) {
        const agent = participants[i];
        const colorIndex = chat.agents.findIndex(a => a.name === agent.name);
        
        console.log(`[Round] Starting agent ${i+1}/${participants.length}: ${agent.name}`);
        const startTime = Date.now();
        
        try {
          await getAgentResponse(chatId, agent, colorIndex);
        } catch (err) {
          console.error(`[Round] Agent ${agent.name} failed:`, err);
        }
        
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[Round] Agent ${agent.name} completed in ${elapsed}s`);
        
        // Delay between agents — allow gateway cooldown between different agents
        if (i < participants.length - 1 && !chat.cancelled) {
          console.log('[Round] Waiting 5s before next agent (model swap time)...');
          await new Promise(r => setTimeout(r, 5000));
        }
      }
    }
    
    async function runSynthesis(chatId) {
      const chat = chats[chatId];
      if (!chat.summarizer) return;
      
      // Update status
      setAgentStatus(chat.summarizer.name, 'thinking');
      updateActiveAgents(chatId, chat.summarizer.name + ' (synthesizing)', true);
      
      const synthPrompt = buildSynthesisPrompt(chat);
      const msgId = appendSynthesisMessage(chatId, '⏳ Synthesizing...', chat.currentRound);
      
      chat.controllers[chat.summarizer.name] = new AbortController();
      
      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...zoneHeader() },
          signal: chat.controllers[chat.summarizer.name].signal,
          body: JSON.stringify({ agent: chat.summarizer.name, message: synthPrompt, sessionId: 'new' })
        });

        const fullResponse = await streamResponse(response, msgId, true, chat.currentRound, chatId, chat.summarizer.name);

        chat.syntheses.push({ round: chat.currentRound, content: fullResponse });
        chat.messages.push({ role: 'assistant', agent: chat.summarizer.name, content: fullResponse, type: 'synthesis', round: chat.currentRound });
        
      } catch (err) {
        if (err.name !== 'AbortError') {
          updateSynthesisMessage(msgId, `*Synthesis error: ${err.message}*`, chat.currentRound);
        }
      }
      
      // Clear status
      setAgentStatus(chat.summarizer.name, '');
      updateActiveAgents(chatId, chat.summarizer.name + ' (synthesizing)', false);
      delete chat.controllers[chat.summarizer.name];
    }
    
    function buildSynthesisPrompt(chat) {
      const participants = chat.participants.map(a => a.name).join(', ');
      const topic = chat.topic || 'the discussion';
      
      // Get messages from this round
      const roundMessages = chat.messages.filter(m => 
        m.type !== 'synthesis' && m.type !== 'topic' && m.type !== 'round'
      );
      
      let context;
      if (chat.contextMode === 'summary-only' && chat.syntheses.length > 0) {
        const lastSynth = chat.syntheses[chat.syntheses.length - 1];
        context = `Previous synthesis:\n${lastSynth.content}\n\nNew contributions this round:\n` +
          roundMessages.slice(-chat.participants.length).map(m => `[${m.agent || 'User'}]: ${m.content}`).join('\n\n');
      } else if (chat.contextMode === 'last-n') {
        context = roundMessages.slice(-chat.contextN).map(m => `[${m.agent || 'User'}]: ${m.content}`).join('\n\n');
      } else {
        context = roundMessages.map(m => `[${m.agent || 'User'}]: ${m.content}`).join('\n\n');
      }
      
      // Start with directive if set (put it FIRST so it gets priority)
      let directivePart = '';
      if (chat.directives && chat.summarizer && chat.directives[chat.summarizer.name]) {
        directivePart = `IMPORTANT INSTRUCTION: ${chat.directives[chat.summarizer.name]}\n\n`;
      }

      let prompt = `${directivePart}You are summarizing a multi-agent AI discussion on: "${topic}"

Participants: ${participants}

---
DISCUSSION:
${context}
---

Write a synthesis that:
- States each participant's position clearly
- Notes agreements and disagreements
- Keeps it concise (2-3 paragraphs max)

Do NOT add opinions. Do NOT participate. Just summarize what was said.`;
      
      return prompt;
    }
    
    async function getAgentResponse(chatId, agent, colorIndex) {
      const chat = chats[chatId];
      chat.controllers[agent.name] = new AbortController();
      
      // Update status indicators
      setAgentStatus(agent.name, 'thinking');
      updateActiveAgents(chatId, agent.name, true);
      
      // Build prompt for gateway
      const prompt = buildAgentPrompt(chat, agent);
      console.log(`[${agent.name}] Sending to gateway: ${prompt.substring(0, 150)}...`);
      
      const msgId = appendGroupMessage(chatId, 'assistant', '⏳ Thinking...', agent.name, colorIndex);
      
      try {
        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...zoneHeader() },
          signal: chat.controllers[agent.name].signal,
          body: JSON.stringify({ agent: agent.name, message: prompt, sessionId: 'new' })
        });

        const fullResponse = await streamResponseGroup(response, msgId, agent.name, colorIndex, chatId);

        console.log(`[${agent.name}] Got ${fullResponse.length} chars`);
        chat.messages.push({ role: 'assistant', content: fullResponse, agent: agent.name });

      } catch (err) {
        console.error(`[${agent.name}] Error:`, err);
        if (err.name !== 'AbortError') {
          const errorEl = document.getElementById(msgId);
          if (errorEl) {
            const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
            errorEl.innerHTML = `<div class="agent-label" style="background: ${color}33; color: ${color}">${agent.name}</div><span style="color: var(--accent)">❌ Error: ${err.message}</span>`;
          }
        }
        // On abort: keep whatever was already streamed
      }
      
      // Clear status indicators
      setAgentStatus(agent.name, '');
      updateActiveAgents(chatId, agent.name, false);
      delete chat.controllers[agent.name];
    }
    
    function buildAgentPrompt(chat, agent) {
      // Build a simple prompt string for the gateway (SOUL.md is handled by the agent)
      const otherParticipants = chat.agents
        .filter(a => a.name !== agent.name && a.name !== chat.summarizer?.name)
        .map(a => a.name).join(', ');
      
      let prompt = `You're in a group discussion with other AI agents: ${otherParticipants}.\n`;
      prompt += `Topic: "${chat.topic || 'open discussion'}"\n\n`;
      
      // Add directive if set
      if (chat.directives && chat.directives[agent.name]) {
        prompt += `YOUR DIRECTIVE: ${chat.directives[agent.name]}\n\n`;
      }
      
      // Build context based on mode
      let context = '';
      if (chat.contextMode === 'summary-only' && chat.syntheses.length > 0) {
        const lastSynth = chat.syntheses[chat.syntheses.length - 1];
        const currentRoundMsgs = chat.messages.filter(m => 
          m.type !== 'synthesis' && m.type !== 'topic' && m.type !== 'round'
        ).slice(-(chat.participants?.length || chat.agents.length));
        
        context = `Previous round summary:\n${lastSynth.content}\n\n`;
        if (currentRoundMsgs.length > 0) {
          context += `This round so far:\n`;
          context += currentRoundMsgs.map(m => `[${m.agent || 'User'}]: ${m.content}`).join('\n\n');
        }
      } else if (chat.contextMode === 'last-n') {
        const recentMsgs = chat.messages.filter(m => m.type !== 'round').slice(-chat.contextN);
        context = recentMsgs.map(m => {
          if (m.type === 'synthesis') return `[SYNTHESIS]: ${m.content}`;
          return `[${m.agent || 'User'}]: ${m.content}`;
        }).join('\n\n');
      } else {
        // Full context
        const allMsgs = chat.messages.filter(m => m.type !== 'round');
        context = allMsgs.map(m => {
          if (m.type === 'synthesis') return `[SYNTHESIS]: ${m.content}`;
          if (m.type === 'topic') return `[TOPIC]: ${m.content}`;
          return `[${m.agent || 'User'}]: ${m.content}`;
        }).join('\n\n');
      }
      
      if (context) {
        prompt += `DISCUSSION SO FAR:\n${context}\n\n`;
      }
      
      prompt += `YOUR TURN: Respond to the discussion. Only speak for yourself - others will respond separately. Be concise (2-3 paragraphs max).`;
      
      return prompt;
    }
    
    // AskUserQuestion handler - shows modal, waits for answer, POSTs response to bridge
    // One dialog per question: the same question can arrive on the chat stream, on the hub event stream and
    // from a turn catch-up, so request ids are remembered and the overlay is kept to close it when answered elsewhere.
    const shownQuestions = new Set();
    const questionOverlays = {};
    // Each question's "❓" lines in the chat: they leave a few seconds after it is answered or closed, so a
    // long reply with questions does not pile them up under itself.
    const questionNotices = new Map();
    function retireQuestionNotices(requestId) {
      for (const n of questionNotices.get(requestId) || []) retireSoon(n);
      questionNotices.delete(requestId);
    }
    function closeQuestion(requestId) {
      const o = questionOverlays[requestId];
      if (o) { o.remove(); delete questionOverlays[requestId]; }
      retireQuestionNotices(requestId);
    }
    function showQuestionModal(data, chatId) {
      return new Promise((resolve) => {
        const { request_id, questions } = data;
        if (!request_id || !Array.isArray(questions) || !questions.length) return resolve();
        if (shownQuestions.has(request_id)) return resolve();
        shownQuestions.add(request_id);
        const esc = escapeHtmlSafe;
        if (chatId) questionNotices.set(request_id, questions.map(q => appendSystemNotice(chatId, '❓ ' + q.question)).filter(Boolean));

        const overlay = document.createElement('div');
        overlay.className = 'question-overlay';
        overlay.dataset.dialogPersistent = '1';   // the agent waits for an answer: Esc and the backdrop leave it open
        questionOverlays[request_id] = overlay;

        let html = '<div class="question-modal">';
        html += '<h3>Agent needs your input</h3>';

        for (let i = 0; i < questions.length; i++) {
          const q = questions[i];
          if (q.header) {
            html += `<div class="question-header">${esc(q.header)}</div>`;
          }
          html += `<p class="question-text">${esc(q.question)}</p>`;
          html += `<div class="question-options">`;
          for (const opt of (q.options || [])) {
            const safeLabel = esc(opt.label).replace(/"/g, '&quot;');
            html += `<button class="question-option" data-qi="${i}" data-label="${safeLabel}">`;
            html += `<strong>${esc(opt.label)}</strong>`;
            if (opt.description) html += `<span>${esc(opt.description)}</span>`;
            html += '</button>';
          }
          html += '</div>';
        }

        html += '<div class="question-divider">or type a custom answer</div>';
        html += '<div class="question-custom">';
        html += '<input type="text" placeholder="Type your answer..." id="question-custom-input">';
        html += '</div>';
        html += '<div class="question-actions"><span class="question-hint" id="question-hint">Pick an answer, then press Submit.</span><button id="question-submit" disabled>Submit</button></div>';
        html += '</div>';
        overlay.innerHTML = html;

        function submitAnswers(answers) {
          fetch('/api/ask_response', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ request_id, answers })
          }).then(r => { if (r.ok) retireQuestionNotices(request_id); })   // the hub has the answer: its line can go
            .catch(err => console.error('Failed to submit question answer:', err));
          overlay.remove();
          delete questionOverlays[request_id];
          resolve();
        }

        // A click only selects (one option per question, highlighted); nothing is sent until Submit.
        // That stops a mis-click from answering the agent. A typed answer overrides the selections.
        const selected = {};
        const customInput = overlay.querySelector('#question-custom-input');
        const submitBtn = overlay.querySelector('#question-submit');
        const hint = overlay.querySelector('#question-hint');
        const refresh = () => {
          const typed = customInput.value.trim();
          const complete = typed || questions.every((q, i) => selected[i] !== undefined);
          submitBtn.disabled = !complete;
          hint.textContent = typed ? 'Your typed answer will be sent.' : complete ? 'Press Submit to send.' : (questions.length > 1 ? 'Pick an answer for each question, then press Submit.' : 'Pick an answer, then press Submit.');
        };
        overlay.querySelectorAll('.question-option').forEach(btn => {
          btn.addEventListener('click', () => {
            const qi = btn.dataset.qi;
            const was = btn.classList.contains('selected');
            overlay.querySelectorAll(`.question-option[data-qi="${qi}"]`).forEach(b => b.classList.remove('selected'));
            if (was) delete selected[qi];                       // clicking the highlighted option again clears it
            else { btn.classList.add('selected'); selected[qi] = btn.dataset.label; }
            refresh();
          });
        });
        const submitAll = () => {
          const text = customInput.value.trim();
          const answers = {};
          if (text) questions.forEach((q, i) => { answers[i.toString()] = text; });
          else { if (!questions.every((q, i) => selected[i] !== undefined)) return; questions.forEach((q, i) => { answers[i.toString()] = selected[i]; }); }
          submitAnswers(answers);
        };
        submitBtn.addEventListener('click', submitAll);
        customInput.addEventListener('input', refresh);
        customInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && customInput.value.trim()) submitAll();
        });
        refresh();

        document.body.appendChild(overlay);
        setTimeout(() => customInput.focus(), 100);
      });
    }

    // A question asked during a reply: show the card, but keep reading the reply. The hub holds the
    // stream open while the agent waits, with a heartbeat every 15 s, so the stall checks below stay
    // quiet and the rest of the reply arrives after the answer. Awaiting the card here stopped the
    // reading: after 90 s the stall check cut the reply off, and the rest only showed after a reload.
    function askFromStream(data, chatId) {
      showQuestionModal(data, chatId).catch(() => {});
    }

    // Streaming helpers
    async function streamResponse(response, msgId, isSynthesis = false, round = null, chatId = null, agentName = null) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let displayContent = '';
      let sseBuffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split('\n');
        sseBuffer = parts.pop(); // keep incomplete line
        const lines = parts.filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'meta') continue;
            // Gateway events: tool activity and questions wrapped in valid OpenAI format
            const oc = parsed.gateway || null;
            if (oc) {
              console.log('[FRONTEND-SSE] gateway event:', oc.type, oc);
              if (oc.type === 'ask_user_question') {
                askFromStream(oc, chatId);
                continue;
              }
              if (oc.type === 'auto_model') {
                try {
                  const modelShort = oc.model.split('/').pop();
                  window.__pendingAutoModel = window.__pendingAutoModel || {};
                  window.__pendingAutoModel[chatId] = modelShort;
                  const container = document.getElementById(`messages-${chatId}`);
                  if (container) {
                    const cib = container.querySelector('.context-info-box');
                    if (cib && !cib.dataset.modelAppended) {
                      cib.innerHTML += ` · <strong style="color:#7eb8f7">${modelShort}</strong>`;
                      cib.dataset.modelAppended = '1';
                    }
                  }
                  const headerSpan = document.querySelector(`#panel-${chatId} .agent-name`);
                  if (headerSpan) {
                    const agentDisplayName = headerSpan.textContent.split(' (')[0];
                    headerSpan.textContent = `${agentDisplayName} (${modelShort})`;
                  }
                } catch {}
                continue;
              }
              // Eyes expression events
              if (oc.type === 'expression_change') {
                const eyesWin = getEyesWindow(chatId);
                if (eyesWin) {
                  eyesWin.postMessage({ type: 'set-expression', data: { emotion: oc.emotion, irisColor: oc.irisColor } }, '*');
                }
                continue;
              }
              // Worker events
              if (oc.type?.startsWith('worker_')) {
                handleWorkerEvent(chatId, oc);
                continue;
              }
              // Context health / exhausted
              if (oc.type === 'context_health') { updateContextHealth(chatId, oc); continue; }
              if (oc.type === 'context_exhausted') { showContextExhausted(chatId, oc); continue; }
              if (oc.type === 'session_interrupted') { showSessionInterrupted(chatId, oc); continue; }
              // Tiger Team launch — open war room in new tab
              if (oc.type === 'open_tiger_team') {
                const params = new URLSearchParams({
                  coordinator: oc.coordinator,
                  participants: (oc.participants || []).join(','),
                  objective: oc.objective,
                  maxRounds: (oc.max_rounds || 5).toString(),
                  ...(oc.context ? { context: oc.context } : {}),
                  ...(oc.challenger ? { challenger: oc.challenger } : {})
                });
                const url = `/tiger-team?${params.toString()}`;
                // window.open from async context gets blocked by popup blocker
                // Show a clickable launch banner in the chat instead
                const container = document.getElementById(`messages-${chatId}`);
                if (container) {
                  const banner = document.createElement('div');
                  banner.className = 'tiger-team-launch-banner';
                  banner.innerHTML = `<div style="background: linear-gradient(135deg, #1a1a2e, #16213e); border: 1px solid #0f3460; border-radius: 8px; padding: 12px 16px; margin: 8px 0; display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.open('${url}', '_blank')">
                    <span style="font-size: 24px;">🐯</span>
                    <div style="flex:1">
                      <div style="color: #e94560; font-weight: 600; font-size: 13px;">Tiger Team Launched</div>
                      <div style="color: #aaa; font-size: 12px; margin-top: 2px;">${oc.coordinator} coordinating ${(oc.participants||[]).join(', ')}</div>
                    </div>
                    <span style="color: #0f3460; font-size: 20px;">→</span>
                  </div>`;
                  container.appendChild(banner);
                  autoScroll(container);
                }
                continue;
              }
              if (oc.type === 'approval_request' || oc.type === 'approval_resolved') {
                onApprovalEvent(oc);
                continue;
              }
              if (oc.type === 'reasoning') {
                appendReasoning(msgId, chatId, oc);
                continue;
              }
              if (oc.type === 'tool_start') {
                displayContent += `\n⚡ ${oc.tool}`;
                if (isSynthesis) {
                  updateSynthesisMessage(msgId, displayContent, round);
                } else {
                  updateMessage(msgId, displayContent);
                }
                if (chatId) updateToolActivity(chatId, oc.tool);
                continue;
              }
              if (oc.type === 'tool_use') {
                const suffix = oc.input ? `: ${oc.input}` : '';
                const marker = `\n⚡ ${oc.tool}${suffix}`;
                const lastIdx = displayContent.lastIndexOf(`\n⚡ ${oc.tool}`);
                if (lastIdx >= 0) {
                  displayContent = displayContent.substring(0, lastIdx) + marker;
                } else {
                  displayContent += marker;
                }
                if (isSynthesis) {
                  updateSynthesisMessage(msgId, displayContent, round);
                } else {
                  updateMessage(msgId, displayContent);
                }
                if (chatId) updateToolActivity(chatId, oc.tool + (oc.input ? `: ${oc.input}` : ''));
                continue;
              }
              if (oc.type === 'tool_result') {
                if (oc.output) {
                  displayContent += `\n⏎ ${oc.output}`;
                  if (isSynthesis) {
                    updateSynthesisMessage(msgId, displayContent, round);
                  } else {
                    updateMessage(msgId, displayContent);
                  }
                }
                continue;
              }
              if (oc.type === 'token_usage') {
                setTokenUsage(msgId, oc.usage);
                continue;
              }
            }
            // Legacy direct-type events (backwards compat)
            if (parsed.type === 'ask_user_question') {
              askFromStream(parsed, chatId);
              continue;
            }
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              displayContent += delta;

              // Live token estimate
              addTokenEstimate(msgId, delta);

              if (chatId) {
                const { thinking, stillThinking } = parseThinking(fullResponse);
                updateThinkingPanel(chatId, thinking, agentName, stillThinking);
              }

              if (isSynthesis) {
                updateSynthesisMessage(msgId, displayContent, round);
              } else {
                updateMessage(msgId, displayContent);
              }
            }
          } catch (e) {}
        }
      }

      // Clear thinking panel when done
      if (chatId) updateThinkingPanel(chatId, '', agentName, false);
      finalizeTokenUsage(msgId);

      return fullResponse;
    }

    async function streamResponseSolo(response, msgId, chatId, agentName) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let displayContent = '';
      let toolActivity = [];  // Separate tracking for tool calls
      let images = [];
      let sseBuffer = '';

      // Step-based display: each step = { text, tools[] }
      // A new step starts when we get text after tools completed
      let steps = [{ text: '', tools: [] }];
      let lastEventWasToolResult = false;

      // Client-side stall watchdog: if no bytes arrive for 90s, the connection
      // is likely dead (server aborted, network broke, browser was suspended).
      // The server sends heartbeats every 15s, so 90s = 6 missed heartbeats.
      // When triggered, throws a retryable error so sendSoloMessage auto-retries.
      // Heartbeats keep coming while a question card waits for an answer (askFromStream).
      const CLIENT_STALL_MS = 90000;
      let lastDataTime = Date.now();
      let stallTriggered = false;
      let stallTimer = setInterval(() => {
        const silentMs = Date.now() - lastDataTime;
        if (silentMs >= CLIENT_STALL_MS) {
          console.warn(`[stall-watchdog] No data from server for ${(silentMs/1000).toFixed(0)}s - aborting stream for retry`);
          clearInterval(stallTimer);
          stallTimer = null;
          stallTriggered = true;
          try { reader.cancel(); } catch {}
        }
      }, 10000); // check every 10s

      while (true) {
        let readResult;
        try {
          readResult = await reader.read();
        } catch (readErr) {
          // Stream read error (network death or stall-watchdog cancel)
          console.error('Stream read error:', readErr);
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          // Throw a retryable error so sendSoloMessage auto-retries
          throw new Error(stallTriggered ? 'stall detected - stream died' : 'network error during stream');
        }
        const { done, value } = readResult;
        if (done) {
          if (stallTimer) { clearInterval(stallTimer); stallTimer = null; }
          // The stall check cancels the reader, and a cancelled reader reports "done": that reply was
          // cut off, not finished. Same retryable error as above, so sendSoloMessage re-attaches.
          if (stallTriggered) throw new Error('stall detected - stream died');
          break;
        }
        lastDataTime = Date.now(); // reset watchdog on any data

        sseBuffer += decoder.decode(value, { stream: true });
        const parts = sseBuffer.split('\n');
        sseBuffer = parts.pop();
        const lines = parts.filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);

            // Check for metadata event (images)
            if (parsed.type === 'meta') {
              if (parsed.images) images.push(...parsed.images);
              continue;
            }

            // Context size info
            if (parsed.context_size) {
              showContextInfo(chatId, parsed.context_size, parsed.tool_count, parsed.message_count);
              continue;
            }

            // Handle AskUserQuestion from Claude SDK
            if (parsed.type === 'ask_user_question') {
              askFromStream(parsed, chatId);
              continue;
            }

            // Gateway events: tool activity wrapped in valid OpenAI format
            const oc2 = parsed.gateway || null;
            if (oc2) {
              console.log('[FRONTEND-SSE-SOLO] gateway event:', oc2.type, JSON.stringify(oc2).slice(0, 200));
              if (oc2.type === 'ask_user_question') {
                askFromStream(oc2, chatId);
                continue;
              }
              // Session ID tracking
              if (oc2.type === 'session_id') {
                const chat = chats[chatId];
                if (chat) {
                  chat.sessionId = oc2.session_id;
                  chat.resumed = oc2.resumed || false;
                  console.log(`[${agentName}] Session: ${oc2.session_id} (${oc2.resumed ? 'resumed' : 'new'})`);
                  // Update session indicator
                  const indicator = document.getElementById(`session-indicator-${chatId}`);
                  if (indicator) {
                    indicator.textContent = oc2.resumed ? '(resumed)' : '';
                    indicator.title = `Session: ${oc2.session_id}`;
                  }
                }
                continue;
              }
              // Eyes expression events
              if (oc2.type === 'expression_change') {
                const eyesWin = getEyesWindow(chatId);
                if (eyesWin) {
                  eyesWin.postMessage({ type: 'set-expression', data: { emotion: oc2.emotion, irisColor: oc2.irisColor } }, '*');
                }
                continue;
              }
              // Worker events
              if (oc2.type?.startsWith('worker_')) {
                handleWorkerEvent(chatId, oc2);
                continue;
              }
              // Context health — update usage indicator
              if (oc2.type === 'context_health') {
                updateContextHealth(chatId, oc2);
                continue;
              }
              // Context exhausted — session died
              if (oc2.type === 'session_interrupted') { showSessionInterrupted(chatId, oc2); continue; }
              if (oc2.type === 'context_exhausted') {
                showContextExhausted(chatId, oc2);
                continue;
              }
              // Tiger Team launch — show clickable banner
              if (oc2.type === 'open_tiger_team') {
                console.log('[TIGER-TEAM-BANNER] chatId:', chatId, 'container exists:', !!document.getElementById(`messages-${chatId}`));
                const params = new URLSearchParams({
                  coordinator: oc2.coordinator,
                  participants: (oc2.participants || []).join(','),
                  objective: oc2.objective,
                  maxRounds: (oc2.max_rounds || 5).toString(),
                  ...(oc2.context ? { context: oc2.context } : {}),
                  ...(oc2.challenger ? { challenger: oc2.challenger } : {})
                });
                const url = `/tiger-team?${params.toString()}`;
                const container = document.getElementById(`messages-${chatId}`);
                if (container) {
                  console.log('[TIGER-TEAM-BANNER] Creating banner, url:', url);
                  const banner = document.createElement('div');
                  banner.innerHTML = `<div style="background: linear-gradient(135deg, #1a1a2e, #16213e); border: 1px solid #0f3460; border-radius: 8px; padding: 12px 16px; margin: 8px 0; display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.open('${url}', '_blank')">
                    <span style="font-size: 24px;">🐯</span>
                    <div style="flex:1">
                      <div style="color: #e94560; font-weight: 600; font-size: 13px;">Tiger Team Launched</div>
                      <div style="color: #aaa; font-size: 12px; margin-top: 2px;">${oc2.coordinator} coordinating ${(oc2.participants||[]).join(', ')}</div>
                    </div>
                    <span style="color: #0f3460; font-size: 20px;">→</span>
                  </div>`;
                  container.appendChild(banner);
                  autoScroll(container);
                } else {
                  console.error('[TIGER-TEAM-BANNER] Container NOT FOUND for chatId:', chatId);
                }
                continue;
              }
              if (oc2.type === 'auto_model') {
                const modelShort = oc2.model.split('/').pop();
                // Stash for context-info-box to pick up
                window.__pendingAutoModel = window.__pendingAutoModel || {};
                window.__pendingAutoModel[chatId] = modelShort;
                // If context-info-box already exists, append now
                const container = document.getElementById(`messages-${chatId}`);
                if (container) {
                  const cib = container.querySelector('.context-info-box');
                  if (cib && !cib.dataset.modelAppended) {
                    cib.innerHTML += ` · <strong style="color:#7eb8f7">${modelShort}</strong>`;
                    cib.dataset.modelAppended = '1';
                  }
                }
                // Update panel header
                const headerSpan = document.querySelector(`#panel-${chatId} .agent-name`);
                if (headerSpan) {
                  const name = headerSpan.textContent.split(' (')[0];
                  headerSpan.textContent = `${name} (${modelShort})`;
                }
                continue;
              }
              if (oc2.type === 'approval_request' || oc2.type === 'approval_resolved') {
                onApprovalEvent(oc2);
                continue;
              }
              // Live progress ticker from the server (phase + elapsed)
              if (oc2.type === 'progress') {
                setLiveActivity(msgId, chatId, oc2);
                continue;
              }
              // Live reasoning stream
              if (oc2.type === 'reasoning') {
                appendReasoning(msgId, chatId, oc2);
                continue;
              }
              if (oc2.type === 'tool_start') {
                toolActivity.push({ type: 'call', tool: oc2.tool, input: '' });
                const currentStep = steps[steps.length - 1];
                currentStep.tools.push({ tool: oc2.tool, input: '', result: null, status: 'running', startedAt: Date.now(), toolCallId: oc2.tool_call_id || null });
                lastEventWasToolResult = false;
                renderSteps(msgId, steps, toolActivity, images, true);
                ensureLiveTick();
                if (chatId) updateToolActivity(chatId, oc2.tool);
                continue;
              }
              if (oc2.type === 'tool_use') {
                // Update the last tool_start entry with input details
                const last = toolActivity.findLast(t => t.type === 'call' && t.tool === oc2.tool);
                if (last) last.input = oc2.input || '';
                const currentStep = steps[steps.length - 1];
                // the call this input belongs to: by its id when the hub sends one (two calls of one tool can run side by side)
                const lastStepTool = (oc2.tool_call_id && currentStep.tools.find(t => t.toolCallId === oc2.tool_call_id)) || currentStep.tools.findLast(t => t.tool === oc2.tool);
                if (lastStepTool) lastStepTool.input = oc2.input || '';
                renderSteps(msgId, steps, toolActivity, images, true);
                if (chatId) updateToolActivity(chatId, oc2.tool + (oc2.input ? `: ${oc2.input}` : ''));
                continue;
              }
              if (oc2.type === 'tool_result') {
                if (oc2.output) {
                  toolActivity.push({ type: 'result', output: oc2.output });
                }
                const currentStep = steps[steps.length - 1];
                const runningTool = (oc2.tool_call_id && currentStep.tools.find(t => t.toolCallId === oc2.tool_call_id && t.status === 'running')) || currentStep.tools.find(t => t.status === 'running');
                if (runningTool) {
                  runningTool.result = oc2.output || '';
                  runningTool.status = oc2.output?.startsWith('Error') ? 'error' : 'done';
                  if (runningTool.startedAt) runningTool.durationMs = Date.now() - runningTool.startedAt;
                }
                lastEventWasToolResult = true;
                renderSteps(msgId, steps, toolActivity, images, true);
                continue;
              }
              if (oc2.type === 'token_usage') {
                setTokenUsage(msgId, oc2.usage);
                continue;
              }
              if (oc2.type === 'interjection_received') {
                // Update the existing notice to "received" and fade it out
                const noticeEl = document.getElementById(`interject-notice-${chatId}`);
                if (noticeEl) {
                  noticeEl.textContent = '✅ Interjection received';
                  noticeEl.style.transition = 'opacity 0.5s ease';
                  setTimeout(() => { noticeEl.style.opacity = '0'; }, 2000);
                  setTimeout(() => { noticeEl.remove(); }, 2500);
                }
                continue;
              }
              if (oc2.type === 'interjection_deferred') {
                // The turn ended before the agent could take the interjection in.
                // It is saved and will be delivered with the next message.
                const noticeEl = document.getElementById(`interject-notice-${chatId}`);
                const text = `⏭️ Interjection arrived too late for this turn — it will be delivered with your next message`;
                if (noticeEl) { noticeEl.textContent = text; noticeEl.removeAttribute('id'); }
                else appendSystemNotice(chatId, text);
                continue;
              }
            }

            // Legacy direct-type tool events
            if (parsed.type === 'tool_start' || parsed.type === 'tool_use' || parsed.type === 'tool_result') continue;

            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              displayContent += delta;

              // Start a new step if text arrives after tool results completed
              if (lastEventWasToolResult) {
                steps.push({ text: '', tools: [] });
                lastEventWasToolResult = false;
              }
              steps[steps.length - 1].text += delta;

              if (chatId) {
                updateToolStreaming(chatId);
                const { thinking, stillThinking } = parseThinking(fullResponse);
                updateThinkingPanel(chatId, thinking, agentName, stillThinking);
              }

              renderSteps(msgId, steps, toolActivity, images, true);
            }
          } catch (e) {}
        }
      }

      if (chatId) {
        updateThinkingPanel(chatId, '', agentName, false);
        stopToolTracker(chatId);
      }
      finishReasoning(msgId);

      // Final render — mark all tools as done (no spinners)
      if (toolActivity.length > 0) {
        // Mark all step tools as done
        for (const step of steps) {
          for (const t of step.tools) {
            if (t.status === 'running') t.status = 'done';
          }
        }
        renderSteps(msgId, steps, toolActivity, images, false);
      }

      const partial = !fullResponse || fullResponse.length === 0;
      if (!fullResponse) fullResponse = '[No response]';
      return { text: fullResponse, images, toolActivity, partial, steps };
    }

    async function streamResponseGroup(response, msgId, agentName, colorIndex, chatId) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullResponse = '';
      let displayContent = '';
      let gotFirstChunk = false;

      // Show loading status (bypass formatContent)
      const loadingEl = document.getElementById(msgId);
      if (loadingEl) {
        const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
        loadingEl.innerHTML = `<div class="agent-label" style="background: ${color}33; color: ${color}">${agentName}</div><em style="opacity:0.6">⏳ Loading model & generating...</em>`;
      }

      // Client-side stall watchdog (same as solo - 90s no-data triggers retryable error)
      const CLIENT_STALL_MS = 90000;
      let lastDataTime = Date.now();
      let stallTriggered = false;
      let stallTimer = setInterval(() => {
        if (Date.now() - lastDataTime >= CLIENT_STALL_MS) {
          console.warn(`[stall-watchdog] ${agentName}: No data for ${((Date.now()-lastDataTime)/1000).toFixed(0)}s - aborting group stream for retry`);
          clearInterval(stallTimer); stallTimer = null;
          stallTriggered = true;
          try { reader.cancel(); } catch {}
        }
      }, 10000);

      let sseBuffer = '';
      while (true) {
        let readResult;
        try { readResult = await reader.read(); } catch { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } break; }
        const { done, value } = readResult;
        if (done) { if (stallTimer) { clearInterval(stallTimer); stallTimer = null; } break; }
        lastDataTime = Date.now();

        if (!gotFirstChunk) {
          gotFirstChunk = true;
          console.log(`[${agentName}] First chunk received`);
        }

        sseBuffer += decoder.decode(value, { stream: true });

        // Debug: log raw chunks when response is empty
        if (fullResponse.length === 0) {
          console.log(`[${agentName}] Raw chunk sample:`, JSON.stringify(sseBuffer.substring(0, 500)));
        }

        const parts = sseBuffer.split('\n');
        sseBuffer = parts.pop();
        const lines = parts.filter(line => line.startsWith('data: '));

        for (const line of lines) {
          const data = line.slice(6);
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data);
            if (parsed.type === 'meta') continue;
            if (parsed.type === 'ask_user_question') {
              askFromStream(parsed, chatId);
              continue;
            }
            // Gateway events: tool activity wrapped in valid OpenAI format
            const oc3 = parsed.gateway || null;
            if (oc3) {
              if (oc3.type === 'ask_user_question') {
                askFromStream(oc3, chatId);
                continue;
              }
              // Eyes expression events
              if (oc3.type === 'expression_change') {
                const eyesWin = getEyesWindow(chatId);
                if (eyesWin) {
                  eyesWin.postMessage({ type: 'set-expression', data: { emotion: oc3.emotion, irisColor: oc3.irisColor } }, '*');
                }
                continue;
              }
              // Worker events
              if (oc3.type?.startsWith('worker_')) {
                handleWorkerEvent(chatId, oc3);
                continue;
              }
              // Context health / exhausted
              if (oc3.type === 'context_health') { updateContextHealth(chatId, oc3); continue; }
              if (oc3.type === 'context_exhausted') { showContextExhausted(chatId, oc3); continue; }
              if (oc3.type === 'session_interrupted') { showSessionInterrupted(chatId, oc3); continue; }
              // Tiger Team launch — open war room in new tab
              if (oc3.type === 'open_tiger_team') {
                const params = new URLSearchParams({
                  coordinator: oc3.coordinator,
                  participants: (oc3.participants || []).join(','),
                  objective: oc3.objective,
                  maxRounds: (oc3.max_rounds || 5).toString(),
                  ...(oc3.context ? { context: oc3.context } : {})
                });
                window.open(`/tiger-team?${params.toString()}`, '_blank');
                continue;
              }
              if (oc3.type === 'approval_request' || oc3.type === 'approval_resolved') {
                onApprovalEvent(oc3);
                continue;
              }
              if (oc3.type === 'reasoning') {
                appendReasoning(msgId, chatId, oc3);
                continue;
              }
              if (oc3.type === 'tool_start') {
                displayContent += `\n⚡ ${oc3.tool}`;
                updateGroupMessage(msgId, displayContent, agentName, colorIndex);
                if (chatId) updateToolActivity(chatId, oc3.tool);
                continue;
              }
              if (oc3.type === 'tool_use') {
                const suffix = oc3.input ? `: ${oc3.input}` : '';
                const marker = `\n⚡ ${oc3.tool}${suffix}`;
                const lastIdx = displayContent.lastIndexOf(`\n⚡ ${oc3.tool}`);
                if (lastIdx >= 0) {
                  displayContent = displayContent.substring(0, lastIdx) + marker;
                } else {
                  displayContent += marker;
                }
                updateGroupMessage(msgId, displayContent, agentName, colorIndex);
                if (chatId) updateToolActivity(chatId, oc3.tool + (oc3.input ? `: ${oc3.input}` : ''));
                continue;
              }
              if (oc3.type === 'tool_result') {
                if (oc3.output) {
                  displayContent += `\n⏎ ${oc3.output}`;
                  updateGroupMessage(msgId, displayContent, agentName, colorIndex);
                }
                continue;
              }
            }
            // Legacy direct-type tool events
            if (parsed.type === 'tool_start' || parsed.type === 'tool_use' || parsed.type === 'tool_result') continue;
            const delta = parsed.choices?.[0]?.delta?.content;
            if (delta) {
              fullResponse += delta;
              displayContent += delta;

              // Update thinking panel
              const { thinking, stillThinking } = parseThinking(fullResponse);
              updateThinkingPanel(chatId, thinking, agentName, stillThinking);

              updateGroupMessage(msgId, displayContent, agentName, colorIndex);
            }
          } catch (e) {
            console.log(`[${agentName}] Parse error:`, e, 'data:', data);
          }
        }
      }
      
      // The stall check ended the read: a group chat has no re-attach, so say the reply may be cut off
      // rather than pass it on as complete.
      if (stallTriggered) {
        const note = '\n\n⚠ The connection went quiet for 90 seconds, so this reply may be cut off.';
        fullResponse += note;
        displayContent += note;
        updateGroupMessage(msgId, displayContent, agentName, colorIndex);
      }

      // Clear thinking panel and live activity when done
      updateThinkingPanel(chatId, '', agentName, false);
      clearLiveActivity(msgId);
      finalizeTokenUsage(msgId);

      console.log(`[${agentName}] Stream complete, response length: ${fullResponse.length}`);
      console.log(`[${agentName}] Raw response:`, fullResponse.substring(0, 200));
      return fullResponse;
    }
    
    function handleStreamError(err, msgId, fullResponse, chat) {
      if (err.name === 'AbortError') {
        updateMessage(msgId, fullResponse + '\n\n*[Cancelled]*');
        chat.messages.push({ role: 'assistant', content: fullResponse + ' [Cancelled]' });
      } else {
        updateMessage(msgId, `*Error: ${err.message}*`);
        setStatus(chat.id, 'error');
      }
    }
    
    // Message rendering
    // Copy button on every message bubble: copies the original text/markdown, not the rendered HTML.
    const rawMessageText = new WeakMap();
    function decorateMessage(el, content) {
      if (!el) return;
      if (typeof content === 'string') rawMessageText.set(el, content);
      if (!el.querySelector(':scope > .msg-copy')) {
        const b = document.createElement('button');
        b.className = 'msg-copy'; b.type = 'button'; b.title = 'Copy message'; b.textContent = '⧉';
        el.appendChild(b);
      }
    }
    async function copyMessageText(el) {
      const text = rawMessageText.get(el) ?? el.innerText;
      try { await navigator.clipboard.writeText(text); }
      catch {
        const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch {} ta.remove();
      }
      const b = el.querySelector(':scope > .msg-copy'); if (b) { b.textContent = '✓'; setTimeout(() => { b.textContent = '⧉'; }, 1200); }
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.msg-copy');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      copyMessageText(b.closest('.message'));
    });

    function appendMessage(chatId, role, content) {
      const container = document.getElementById(`messages-${chatId}`);
      // When user sends a message, reset scroll tracking so auto-scroll
      // re-engages for the new response.
      if (role === 'user') userScrolledUp.set(container, false);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const div = document.createElement('div');
      div.className = `message ${role}`;
      div.id = msgId;
      div.innerHTML = formatContent(content);
      decorateMessage(div, content);
      container.appendChild(div);
      renderVisualBlocks(div);
      autoScroll(container);
      return msgId;
    }
    
    function showContextInfo(chatId, bytes, toolCount, msgCount) {
      const container = document.getElementById(`messages-${chatId}`);
      if (!container) return;
      const kb = (bytes / 1024).toFixed(1);
      const div = document.createElement('div');
      div.className = 'context-info-box';
      let html = `📊 Context: <strong>${kb} KB</strong> · ${toolCount} tools · ${msgCount} messages`;
      // Append auto-model if already known
      const pending = window.__pendingAutoModel && window.__pendingAutoModel[chatId];
      if (pending) {
        html += ` · <strong style="color:#7eb8f7">${pending}</strong>`;
        div.dataset.modelAppended = '1';
        delete window.__pendingAutoModel[chatId];
      }
      div.innerHTML = html;
      container.appendChild(div);
      autoScroll(container);
    }

    const _contextData = {};
    function updateContextHealth(chatId, data) {
      _contextData[chatId] = data;
      // The old footer stays off; the live reading moves the context line under the toolbar during the turn.
      const chat = chats[chatId];
      if (chat && data && Number(data.input_tokens) > 0) {
        const prev = chat.compaction || {};
        chat.compaction = { ...prev, tokens: Number(data.input_tokens), limit: Number(data.context_limit) || prev.limit || 0, pct: Number(data.usage_percent) || 0 };
        renderCompactionLine(chatId, chat.compaction);
      }
    }
    function _renderContextFooter(chatId, data) {
      const pct = data.usage_percent || 0;
      const tokens = (data.input_tokens || 0).toLocaleString();
      const limit = (data.context_limit || 200000).toLocaleString();
      const toolCalls = data.tool_calls || 0;
      const categories = data.categories || [];
      const color = pct >= 90 ? '#f85149' : pct >= 75 ? '#d29922' : 'var(--text-secondary)';

      // Remove old top bars
      document.querySelectorAll('[id^="context-health-"]').forEach(el => el.remove());
      const oldBar = document.getElementById('context-health-bar');
      if (oldBar) oldBar.remove();

      // Find or create footer inside the messages container
      const container = document.getElementById(`messages-${chatId}`);
      if (!container) return;

      let footer = document.getElementById('context-footer');
      if (!footer) {
        footer = document.createElement('div');
        footer.id = 'context-footer';
        footer.style.cssText = 'position:sticky;bottom:0;padding:6px 14px;font-size:11px;color:var(--text-secondary);background:var(--bg-primary,#0d1117);border-top:1px solid var(--border);display:flex;align-items:center;gap:10px;z-index:5;flex-wrap:wrap;';
      }

      // Build category breakdown if available
      let categoryHtml = '';
      if (categories.length > 0) {
        categoryHtml = categories
          .filter(c => c.tokens > 0)
          .map(c => `<span style="color:${c.color || 'inherit'}">${c.name}: ${c.tokens.toLocaleString()}</span>`)
          .join('<span style="opacity:0.3">·</span>');
      }

      footer.innerHTML = `<div style="display:flex;align-items:center;gap:6px"><div style="width:80px;height:4px;background:var(--border);border-radius:2px;overflow:hidden"><div style="height:100%;width:${Math.min(pct,100)}%;background:${color};border-radius:2px;transition:width 0.3s"></div></div><span style="color:${color};font-weight:500">${pct}%</span></div><span style="opacity:0.4">|</span><span>${tokens} / ${limit}</span>${categoryHtml ? `<span style="opacity:0.4">|</span>${categoryHtml}` : ''}${toolCalls > 0 ? `<span style="opacity:0.4">|</span><span>${toolCalls} tool calls</span>` : ''}`;

      container.appendChild(footer);
    }
    function _clearContextFooter() {
      const footer = document.getElementById('context-footer');
      if (footer) footer.remove();
    }

    // A crash, not a full window: the session resumes on the next message, so say so, calmly.
    function showSessionInterrupted(chatId, data) {
      const container = document.getElementById(`messages-${chatId}`);
      if (!container) return;
      const div = document.createElement('div');
      div.style.cssText = 'background:#d2992222;border:1px solid #d29922;border-radius:8px;padding:12px 16px;margin:12px 0;color:#d29922;font-size:13px;';
      div.innerHTML = `<strong>⚠️ Agent process stopped, session intact</strong><br><span style="color:var(--text-secondary);font-size:12px">${esc(String(data.error || '').slice(0, 200))} · at ${data.usage_percent || 0}% of context. Send your next message to continue; the agent resumes where it left off.</span>`;
      container.appendChild(div);
      autoScroll(container);
    }

    function showContextExhausted(chatId, data) {
      const pct = data.usage_percent || 0;
      const turns = data.turns_completed || 0;
      const container = document.getElementById(`messages-${chatId}`);
      if (!container) return;
      const div = document.createElement('div');
      div.style.cssText = 'background:#f8514922;border:1px solid #f85149;border-radius:8px;padding:12px 16px;margin:12px 0;color:#f85149;font-size:13px;';
      div.innerHTML = `<strong>🛑 Session ended — context window full</strong><br><span style="color:var(--text-secondary);font-size:12px">Used ${pct}% over ${turns} turns. Start a new conversation to continue. Memory and session notes are preserved.</span>`;
      container.appendChild(div);
      autoScroll(container);

      // Update the footer to show exhausted state
      const footer = document.getElementById('context-footer');
      if (footer) {
        footer.style.background = '#f8514922';
        footer.style.color = '#f85149';
        footer.innerHTML = '<span style="font-weight:600">CONTEXT EXHAUSTED</span>';
      }
    }

    // Shared verbatim with lib/ui-retire.js and mobile.js (test/ui-retire.test.js keeps the three in step).
    // ── retire helpers (begin) ──
    const RETIRE_AFTER_MS = 4000;
    const RETIRE_FOLD_MS = 600;
    function retireSoon(el, ms = RETIRE_AFTER_MS) {
      if (!el || !el.dataset || el.dataset.retiring) return false;
      el.dataset.retiring = '1';
      setTimeout(() => {
        if (!el.isConnected) { delete el.dataset.retiring; return; }   // gone meanwhile: if it comes back, it can be retired again
        el.style.maxHeight = el.offsetHeight + 'px';   // fold from its own height, not from "none"
        void el.offsetHeight;
        el.classList.add('retiring');
        setTimeout(() => el.remove(), RETIRE_FOLD_MS);
      }, ms);
      return true;
    }
    // ── retire helpers (end) ──

    function appendSystemNotice(chatId, text, variant) {
      const container = document.getElementById(`messages-${chatId}`);
      if (!container) return;
      const div = document.createElement('div');
      div.className = 'system-notice' + (variant ? ` notice-${variant}` : '');
      // Tiger team notices use simple HTML formatting (escape first, then apply bold/br)
      if (variant === 'tiger-team') {
        div.innerHTML = text
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\n/g, '<br>');
      } else {
        div.textContent = text;
      }
      container.appendChild(div);
      autoScroll(container);
      return div;
    }

    function appendMessageWithImages(chatId, role, content, images) {
      const container = document.getElementById(`messages-${chatId}`);
      if (role === 'user') userScrolledUp.set(container, false);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const div = document.createElement('div');
      div.className = `message ${role}`;
      div.id = msgId;
      
      let html = formatContent(content || '');

      // Add images if present (escaped; the click opens the modal through the delegated listener)
      html += imageGalleryHtml(images, 'max-height:200px;');

      div.innerHTML = html;
      decorateMessage(div, content);
      container.appendChild(div);
      renderVisualBlocks(div);
      autoScroll(container);
      return msgId;
    }

    function appendGroupMessage(chatId, role, content, agentName, colorIndex) {
      const container = document.getElementById(`messages-${chatId}`);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const div = document.createElement('div');
      div.className = `message ${role}`;
      div.id = msgId;
      
      if (role === 'assistant' && agentName) {
        const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
        div.innerHTML = `<div class="agent-label" style="background: ${color}33; color: ${color}">${agentName}</div>${formatContent(content)}`;
      } else {
        div.innerHTML = formatContent(content);
      }
      decorateMessage(div, content);

      container.appendChild(div);
      renderVisualBlocks(div);
      autoScroll(container);
      return msgId;
    }
    
    function appendSynthesisMessage(chatId, content, round) {
      const container = document.getElementById(`messages-${chatId}`);
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const div = document.createElement('div');
      div.className = 'message synthesis';
      div.id = msgId;
      div.innerHTML = `<div class="synthesis-label">📋 Synthesis - Round ${round}</div>${formatContent(content)}`;
      decorateMessage(div, content);
      container.appendChild(div);
      renderVisualBlocks(div);
      autoScroll(container);
      return msgId;
    }
    
    function appendSystemMessage(chatId, content) {
      const container = document.getElementById(`messages-${chatId}`);
      const div = document.createElement('div');
      div.className = 'round-indicator';
      div.innerHTML = content;
      container.appendChild(div);
      autoScroll(container);
    }
    
    function appendRoundIndicator(chatId, round) {
      const container = document.getElementById(`messages-${chatId}`);
      const div = document.createElement('div');
      div.className = 'round-indicator';
      div.innerHTML = `━━━ Round ${round} ━━━`;
      container.appendChild(div);
      autoScroll(container);
      
      chats[chatId].messages.push({ type: 'round', round: round });
    }
    
    // Track which messages containers the user has intentionally scrolled away from bottom.
    // Only real user input pauses auto-scroll (wheel, touch drag, scrollbar drag, keyboard),
    // because content appends and layout shifts fire scroll events too.
    //
    // The pause must happen on the FIRST upward input, before the browser has moved
    // anything: a streaming turn calls autoScroll on every chunk, and a wheel notch or
    // scrollbar drag moves the pane less than the old 200px threshold per frame, so the
    // snap-to-bottom won every time and the pane could not be scrolled while an agent
    // was talking. Auto-scroll resumes once the user is back near the bottom.
    const userScrolledUp = new WeakMap();
    const NEAR_BOTTOM_PX = 200;
    const distFromBottom = (c) => c.scrollHeight - c.scrollTop - c.clientHeight;

    function initScrollTracking(container) {
      if (container._scrollTracked) return;
      container._scrollTracked = true;

      let draggingScrollbar = false;
      let settleTimer = null;
      let lastTouchY = null;
      const pause = () => userScrolledUp.set(container, true);
      // Resume once the scroll has settled near the bottom (and no scrollbar drag is in progress).
      const resumeWhenSettled = () => {
        clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          if (!draggingScrollbar && distFromBottom(container) <= NEAR_BOTTOM_PX) userScrolledUp.set(container, false);
        }, 150);
      };

      container.addEventListener('wheel', (e) => {
        if (e.deltaY < 0) pause();
        resumeWhenSettled();
      }, { passive: true });
      container.addEventListener('touchstart', (e) => { lastTouchY = e.touches[0]?.clientY ?? null; }, { passive: true });
      container.addEventListener('touchmove', (e) => {
        const y = e.touches[0]?.clientY;
        if (lastTouchY != null && y != null && y > lastTouchY) pause();   // finger moving down = content scrolling up
        lastTouchY = y ?? lastTouchY;
        resumeWhenSettled();
      }, { passive: true });
      container.addEventListener('keydown', (e) => {
        if (['PageUp', 'ArrowUp', 'Home'].includes(e.key)) pause();
        if (['PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) resumeWhenSettled();
      });
      // Scrollbar drag: a mousedown to the right of the content box is on the scrollbar.
      // Pause for the whole drag; re-check on release.
      container.addEventListener('mousedown', (e) => {
        if (e.clientX >= container.getBoundingClientRect().left + container.clientWidth) {
          draggingScrollbar = true;
          pause();
        }
      });
      window.addEventListener('mouseup', () => {
        if (!draggingScrollbar) return;
        draggingScrollbar = false;
        resumeWhenSettled();
      });
      // While paused, every scroll is the user's: re-check so reaching the bottom resumes.
      container.addEventListener('scroll', () => {
        if (userScrolledUp.get(container) === true) resumeWhenSettled();
      }, { passive: true });
    }

    function autoScroll(container, force = false) {
      // Auto-scroll unless the user has intentionally scrolled up via wheel/touch/keyboard.
      initScrollTracking(container);
      const scrolledUp = userScrolledUp.get(container) === true;
      if (force || !scrolledUp) {
        container.scrollTop = container.scrollHeight;
      }
    }
    
    // Agent management functions
    function toggleAgentManager(chatId) {
      const manager = document.getElementById(`agent-manager-${chatId}`);
      if (manager) {
        manager.classList.toggle('active');
        if (manager.classList.contains('active')) {
          renderAgentChips(chatId);
          renderAddAgentMenu(chatId);
        }
      }
    }
    
    function toggleAddAgentMenu(chatId) {
      const menu = document.getElementById(`add-agent-menu-${chatId}`);
      if (menu) {
        menu.classList.toggle('show');
        if (menu.classList.contains('show')) {
          renderAddAgentMenu(chatId);
        }
      }
    }
    
    function renderAgentChips(chatId) {
      const chat = chats[chatId];
      const container = document.getElementById(`agent-chips-${chatId}`);
      if (!container) return;
      
      container.innerHTML = chat.agents.map((a, i) => {
        const isSummarizer = chat.summarizer?.name === a.name;
        const color = AGENT_COLORS[i % AGENT_COLORS.length];
        return `<span class="agent-chip ${isSummarizer ? 'summarizer' : ''}" style="${!isSummarizer ? 'border-left: 3px solid ' + color : ''}">
          ${isSummarizer ? '📋 ' : ''}${a.name}
          ${!isSummarizer ? `<span class="remove-agent" onclick="setSummarizerInChat('${chatId}', '${a.name}')" title="Set as summarizer" style="color: var(--blue)">📋</span>` : ''}
          <span class="remove-agent" onclick="removeAgentFromChat('${chatId}', '${a.name}')" title="Remove">✕</span>
        </span>`;
      }).join('') + (chat.summarizer ? `<button onclick="clearSummarizerInChat('${chatId}')" style="padding:4px 8px; font-size:0.7rem; background:transparent; border:1px solid var(--border); border-radius:4px; color:var(--text-dim); cursor:pointer; margin-left:5px;">Clear Summarizer</button>` : '');
    }
    
    function renderAddAgentMenu(chatId) {
      const chat = chats[chatId];
      const menu = document.getElementById(`add-agent-menu-${chatId}`);
      if (!menu) return;
      
      const currentNames = chat.agents.map(a => a.name);
      const available = AGENTS.filter(a => !currentNames.includes(a.name));
      
      if (available.length === 0) {
        menu.innerHTML = '<div class="agent-option" style="color: var(--text-dim)">All agents added</div>';
      } else {
        menu.innerHTML = available.map(a => 
          `<div class="agent-option" onclick="addAgentToChat('${chatId}', '${a.name}', '${a.model}')">${a.name}</div>`
        ).join('');
      }
    }
    
    function removeAgentFromChat(chatId, agentName) {
      const chat = chats[chatId];
      if (chat.agents.length <= 1) {
        
        return;
      }
      
      // Remove from agents array
      chat.agents = chat.agents.filter(a => a.name !== agentName);
      
      // If removed agent was summarizer, clear summarizer
      if (chat.summarizer?.name === agentName) {
        chat.summarizer = null;
      }
      
      // Update participants
      chat.participants = chat.agents.filter(a => a.name !== chat.summarizer?.name);
      
      // Re-render
      renderAgentChips(chatId);
      updateGroupHeader(chatId);
      
      // Close add menu if open
      const menu = document.getElementById(`add-agent-menu-${chatId}`);
      if (menu) menu.classList.remove('show');
    }
    
    function addAgentToChat(chatId, agentName, model) {
      const chat = chats[chatId];
      
      // Add to agents array
      chat.agents.push({ name: agentName, model: model });
      
      // Update participants (exclude summarizer)
      chat.participants = chat.agents.filter(a => a.name !== chat.summarizer?.name);
      
      // Re-render
      renderAgentChips(chatId);
      updateGroupHeader(chatId);
      
      // Close menu
      const menu = document.getElementById(`add-agent-menu-${chatId}`);
      if (menu) menu.classList.remove('show');
    }
    
    function setSummarizerInChat(chatId, agentName) {
      const chat = chats[chatId];
      const agent = chat.agents.find(a => a.name === agentName);
      if (agent) {
        chat.summarizer = agent;
        chat.participants = chat.agents.filter(a => a.name !== agentName);
        renderAgentChips(chatId);
        updateGroupHeader(chatId);
      }
    }
    
    function clearSummarizerInChat(chatId) {
      const chat = chats[chatId];
      chat.summarizer = null;
      chat.participants = [...chat.agents];
      renderAgentChips(chatId);
      updateGroupHeader(chatId);
    }
    
    function resetChat(chatId) {
      const chat = chats[chatId];
      if (!chat) return;
      
      // Cancel any ongoing requests
      chat.cancelled = true;
      Object.values(chat.controllers || {}).forEach(c => c?.abort());
      chat.controllers = {};
      
      // Reset status
      chat.status = 'idle';
      setStatus(chatId, 'idle');
      
      // Clear thinking panel
      updateThinkingPanel(chatId, '', null, false);
      
      // Clear agent statuses
      chat.agents.forEach(a => setAgentStatus(a.name, ''));
      
      console.log('Chat reset:', chatId, chat);
      
    }
    
    function updateGroupHeader(chatId) {
      const chat = chats[chatId];
      const header = document.querySelector(`#panel-${chatId} .group-header .participants`);
      if (header) {
        header.innerHTML = `
          ${chat.agents.filter(a => a.name !== chat.summarizer?.name).map((a, i) => {
            return `<span class="participant" style="border-left: 3px solid ${AGENT_COLORS[i % AGENT_COLORS.length]}">${a.name}</span>`;
          }).join('')}
          ${chat.summarizer ? `<span class="participant summarizer">📋 ${chat.summarizer.name} (summarizer)</span>` : ''}
        `;
      }
      
      // Update tab name
      const tabName = document.querySelector(`#tab-${chatId} .name`);
      if (tabName) {
        const shortNames = chat.agents.length > 3
          ? chat.agents.slice(0, 2).map(a => a.display || capName(a.name)).join(', ') + ` +${chat.agents.length - 2}`
          : chat.agents.map(a => a.display || capName(a.name)).join(', ');
        tabName.textContent = `👥 ${shortNames}`;
      }
    }
    
    // Close menus when clicking outside
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.add-agent-dropdown')) {
        document.querySelectorAll('.add-agent-menu').forEach(m => m.classList.remove('show'));
      }
    });
    
    function updateMessage(msgId, content, images = []) {
      const el = document.getElementById(msgId);
      if (el) {
        const thinkWasCollapsed = el.querySelector('.inline-thinking.collapsed') !== null;

        let html = formatContent(content);
        html += imageGalleryHtml(images);

        setMessageHtml(el, html);
        decorateMessage(el, content);
        renderVisualBlocks(el);

        if (thinkWasCollapsed) {
          const b = el.querySelector('.inline-thinking');
          if (b) b.classList.add('collapsed');
        }

        const container = el.parentElement;
        autoScroll(container);
      }
    }
    
    function buildToolsHtml(toolActivity, showStatus = false) {
      if (!toolActivity || toolActivity.length === 0) return '';

      // Group tool activity into call+result pairs
      const toolCalls = [];
      let currentCall = null;
      for (const t of toolActivity) {
        if (t.type === 'call') {
          currentCall = { tool: t.tool, input: t.input || '', result: null, status: 'running' };
          toolCalls.push(currentCall);
        } else if (t.type === 'result' && currentCall) {
          currentCall.result = t.output || '';
          currentCall.status = t.output?.startsWith('Error') ? 'error' : 'done';
          currentCall = null; // Next result pairs with next call
        }
      }

      // If not showing live status (final render), mark all as done
      if (!showStatus) {
        toolCalls.forEach(tc => { if (tc.status === 'running') tc.status = 'done'; });
      }

      const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

      const lines = toolCalls.map((tc, i) => {
        const statusIcon = tc.status === 'running'
          ? '<div class="tool-call-spinner"></div>'
          : tc.status === 'error'
            ? '<span class="tool-call-icon" style="color:#f87171">✗</span>'
            : '<span class="tool-call-icon" style="color:#4ade80">✓</span>';

        const inputHtml = tc.input ? `<span class="tool-call-input">— ${esc(tc.input)}</span>` : '';
        
        const statusLabel = tc.status === 'done' 
          ? '<span class="tool-call-status done">Done</span>' 
          : tc.status === 'error' 
            ? '<span class="tool-call-status error">Error</span>' 
            : '';

        let resultHtml = '';
        if (tc.result && tc.status !== 'running') {
          const resultId = `tool-result-${Date.now()}-${i}`;
          resultHtml = `<span class="tool-call-toggle" onclick="document.getElementById('${resultId}').classList.toggle('visible')">[output]</span>` +
            `<div class="tool-call-result" id="${resultId}">${esc(tc.result)}</div>`;
        }

        return `<div class="tool-call-line ${tc.status}">` +
          `${statusIcon}` +
          `<div class="tool-call-info">` +
            `<span class="tool-call-name">${esc(tc.tool)}</span>${inputHtml}${statusLabel}${resultHtml}` +
          `</div></div>`;
      }).join('');

      return `<div class="tool-calls-container">${lines}</div>`;
    }

    // ── Live elapsed-time ticker ────────────────────────────────────────
    // Repaints ONLY the timer text nodes once per second.  Deliberately does
    // NOT call renderSteps — a full re-render would nuke [output] toggle state
    // and fight the user's scroll position.
    const liveActivity = new Map(); // msgId -> { phase, detail, phaseStart, totalStart }
    const tokenUsageState = new Map(); // msgId -> { prompt_tokens, completion_tokens, total_tokens, ... }
    const tokenEstimate = new Map();   // msgId -> { chars, estimating, lastRealCompletion, waitPhase, waitStart }
    let liveTickInterval = null;

    function fmtTokens(n, approx) {
      if (n == null || n === 0) return approx ? '~0' : '0';
      const prefix = approx ? '~' : '';
      if (n >= 1000000) return prefix + (n / 1000000).toFixed(1) + 'M';
      if (n >= 1000) return prefix + (n / 1000).toFixed(1) + 'K';
      return prefix + n.toLocaleString();
    }

    function setTokenWaiting(msgId, phase, phaseStart) {
      if (!msgId) return;
      let est = tokenEstimate.get(msgId);
      if (!est) {
        est = { chars: 0, estimating: false, lastRealCompletion: 0, waitPhase: null, waitStart: null };
        tokenEstimate.set(msgId, est);
      }
      est.waitPhase = phase;
      est.waitStart = phaseStart;
      ensureLiveTick();
    }

    function clearTokenWaiting(msgId) {
      const est = tokenEstimate.get(msgId);
      if (est) { est.waitPhase = null; est.waitStart = null; }
    }

    function addTokenEstimate(msgId, deltaText) {
      if (!msgId || !deltaText) return;
      let est = tokenEstimate.get(msgId);
      if (!est) {
        est = { chars: 0, estimating: true, lastRealCompletion: 0, waitPhase: null, waitStart: null };
        tokenEstimate.set(msgId, est);
      }
      est.chars += deltaText.length;
      est.estimating = true;
      est.waitPhase = null;
      est.waitStart = null;
      ensureLiveTick();
    }

    function setTokenUsage(msgId, usage) {
      if (!msgId || !usage) return;
      tokenUsageState.set(msgId, usage);
      const est = tokenEstimate.get(msgId);
      if (est) {
        est.chars = 0;
        est.estimating = false;
        est.lastRealCompletion = usage.completion_tokens || 0;
        est.waitPhase = null;
        est.waitStart = null;
      }
      renderTokenUsage(msgId, false);
    }

    function renderTokenUsage(msgId, done) {
      const host = document.getElementById(msgId);
      if (!host) return;
      const realUsage = tokenUsageState.get(msgId);
      const est = tokenEstimate.get(msgId);
      const hasReal = !!realUsage;
      const isEstimating = est && est.estimating && est.chars > 0;
      const isWaiting = est && est.waitPhase && est.waitStart;

      if (!hasReal && !isEstimating && !isWaiting) return;

      let bar = host.querySelector('.token-usage');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'token-usage';
        const laBar = host.querySelector('.live-activity');
        if (laBar) laBar.insertAdjacentElement('afterend', bar);
        else host.appendChild(bar);
      }
      if (done) bar.classList.add('done');
      else bar.classList.remove('done');

      const promptTokens = realUsage ? realUsage.prompt_tokens : 0;
      const realCompletion = realUsage ? realUsage.completion_tokens : 0;
      const estNewTokens = isEstimating ? Math.round(est.chars / 4) : 0;
      const completionTokens = realCompletion + estNewTokens;
      const completionApprox = isEstimating;
      const reasoningTokens = realUsage ? (realUsage.reasoning_tokens || 0) : 0;
      const cacheTokens = realUsage ? (realUsage.cache_read_tokens || 0) : 0;

      const numCls = (approx) => approx ? 'tu-num estimating' : 'tu-num';
      const sep = '<span class="tu-dim" style="opacity:0.3"> · </span>';
      const parts = [];
      if (hasReal) {
        parts.push(`<span class="tu-stat"><span class="${numCls(false)}">${fmtTokens(promptTokens, false)}</span> <span class="tu-dim">in</span></span>`);
      }
      parts.push(`<span class="tu-stat"><span class="${numCls(completionApprox)}">${fmtTokens(completionTokens, completionApprox)}</span> <span class="tu-dim">out</span></span>`);
      if (reasoningTokens > 0) {
        parts.push(`<span class="tu-stat"><span class="${numCls(false)}">${fmtTokens(reasoningTokens, false)}</span> <span class="tu-dim">reasoning</span></span>`);
      }
      if (cacheTokens > 0) {
        parts.push(`<span class="tu-stat"><span class="${numCls(false)}">${fmtTokens(cacheTokens, false)}</span> <span class="tu-dim">cached</span></span>`);
      }

      if (isWaiting && !done) {
        const waitMs = Date.now() - est.waitStart;
        const WAIT_LABELS = { model: 'thinking', reasoning: 'reasoning', tool: 'running tool' };
        const waitLabel = WAIT_LABELS[est.waitPhase] || 'working';
        parts.push(`<span class="tu-stat tu-waiting"><span class="tu-num estimating">${waitLabel} ${fmtDur(waitMs)}</span></span>`);
      }

      const total = hasReal
        ? (realUsage.total_tokens || (promptTokens + realCompletion)) + estNewTokens
        : estNewTokens;
      const totalApprox = completionApprox;
      parts.push(`<span class="tu-stat" style="margin-left:auto"><span class="${numCls(totalApprox)}">${fmtTokens(total, totalApprox)}</span> <span class="tu-dim">total</span></span>`);

      const label = isEstimating ? 'Tokens ~' : 'Tokens';
      bar.innerHTML = `<span class="tu-label">${label}</span>${parts.join(sep)}`;
    }

    function finalizeTokenUsage(msgId) {
      const est = tokenEstimate.get(msgId);
      if (est) { est.chars = 0; est.estimating = false; est.waitPhase = null; est.waitStart = null; }
      renderTokenUsage(msgId, true);
      tokenEstimate.delete(msgId);
    }

    function fmtDur(ms) {
      if (ms < 1000) return ms < 100 ? '<0.1s' : `${(ms / 1000).toFixed(1)}s`;
      const s = Math.floor(ms / 1000);
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    }

    function durClass(ms) {
      if (ms > 120000) return 'verySlow';
      if (ms > 30000) return 'slow';
      return '';
    }

    function liveTick() {
      const now = Date.now();
      document.querySelectorAll('.tool-elapsed[data-started]').forEach(el => {
        const started = Number(el.dataset.started);
        if (!started) return;
        if (el.dataset.frozen === '1') return;
        const ms = now - started;
        el.textContent = fmtDur(ms);
        el.className = `tool-elapsed ${durClass(ms)}`;
      });
      for (const [msgId, la] of liveActivity) {
        const host = document.getElementById(msgId);
        if (!host) { liveActivity.delete(msgId); continue; }
        if (la.chatId && chats[la.chatId] && chats[la.chatId].status !== 'thinking') {
          clearLiveActivity(msgId);
          continue;
        }
        const bar = host.querySelector('.live-activity');
        if (!bar) continue;
        const phaseMs = now - la.phaseStart;
        const totalMs = now - la.totalStart;
        const t = bar.querySelector('.la-time');
        if (t) {
          t.textContent = `${fmtDur(phaseMs)} · ${fmtDur(totalMs)} total`;
          t.className = `la-time ${durClass(phaseMs)}`;
        }
      }
      for (const [msgId, est] of tokenEstimate) {
        if ((est.estimating && est.chars > 0) || (est.waitPhase && est.waitStart)) renderTokenUsage(msgId, false);
      }
      const hasActiveToken = [...tokenEstimate.values()].some(e => e.estimating || (e.waitPhase && e.waitStart));
      if (liveActivity.size === 0 && !hasActiveToken && !document.querySelector('.tool-elapsed[data-started]:not([data-frozen="1"])')) {
        clearInterval(liveTickInterval);
        liveTickInterval = null;
      }
    }

    function ensureLiveTick() {
      if (!liveTickInterval) liveTickInterval = setInterval(liveTick, 1000);
    }

    const PHASE_LABEL = {
      model: 'Thinking',
      reasoning: 'Reasoning',
      stream: 'Writing',
      tool: 'Running',
      waiting: 'Awaiting you',
    };

    function setLiveActivity(msgId, chatId, ev) {
      if (!msgId) return;
      const now = Date.now();
      const la = {
        chatId,
        phase: ev.phase || 'model',
        detail: ev.detail || '',
        turn: ev.turn || 1,
        phaseStart: now - (ev.phase_ms || 0),
        totalStart: now - (ev.total_ms || 0),
      };
      liveActivity.set(msgId, la);
      renderLiveActivity(msgId);
      ensureLiveTick();
      if (la.phase === 'model' || la.phase === 'reasoning' || la.phase === 'tool') {
        setTokenWaiting(msgId, la.phase, la.phaseStart);
      } else if (la.phase === 'stream') {
        clearTokenWaiting(msgId);
      }
      if (chatId) {
        const label = PHASE_LABEL[la.phase] || 'Working';
        updateToolActivity(chatId, la.detail ? `${label}: ${la.detail}` : label, true);
      }
    }

    function renderLiveActivity(msgId) {
      const host = document.getElementById(msgId);
      if (!host) return;
      const la = liveActivity.get(msgId);
      let bar = host.querySelector('.live-activity');
      if (!la) { if (bar) bar.remove(); return; }
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'live-activity';
        host.appendChild(bar);
      }
      bar.className = `live-activity phase-${la.phase}`;
      const label = PHASE_LABEL[la.phase] || 'Working';
      const turnTxt = la.turn > 1 ? ` <span style="opacity:.5">· step ${la.turn}</span>` : '';
      bar.innerHTML =
        `<span class="la-pulse"></span>` +
        `<span class="la-phase">${label}</span>` +
        `<span class="la-detail">${escapeHtmlSafe(la.detail)}${turnTxt}</span>` +
        `<span class="la-time">0s</span>`;
      liveTick();
    }

    function clearLiveActivity(msgId) {
      liveActivity.delete(msgId);
      clearTokenWaiting(msgId);
      const host = msgId && document.getElementById(msgId);
      const bar = host && host.querySelector('.live-activity');
      if (bar) bar.remove();
      finishReasoning(msgId);
      finishToolPanel(msgId);
    }

    // ── Reasoning panel ────────────────────────────────────────────────
    // The model's reasoning (Claude's summarized thinking, Codex's reasoning summary, the reasoning field of OpenRouter
    // and local models) in a panel at the top of its reply. The header opens and closes it, the grip under it sets any
    // height, ⤢ shows it at the size of the window. Every panel starts minimized, live or saved: the header (with the
    // word count and "thinking…") shows, and a click opens it. Text only (textContent), never markup. The panel is one
    // node that message rewrites keep (setMessageHtml), so its height and scroll position stay where the reader left them.
    const reasonState = new Map();   // msgId -> { text, total, live, v, raf, chatId }
    const REASON_KEEP = 200000;      // chars kept per reply (the newest); the hub keeps 120,000 of a turn, 40,000 when saved
    const RSN_HEIGHT_KEY = 'hub-reasoning-height';
    const rsnHeightPref = () => { const h = Number(localStorage.getItem(RSN_HEIGHT_KEY)); return Number.isFinite(h) && h >= 60 ? h : 220; };
    const rsnWords = (t) => { let n = 0; const re = /\S+/g; while (re.exec(t)) n++; return n; };
    // Shown as plain text: a summary's **headings** (Codex writes them) lose their asterisks; a cut start is marked.
    const rsnShown = (st) => (st.total > st.text.length ? '… (the start is not kept)\n\n' : '') + st.text.replace(/\*\*([^*\n]+)\*\*/g, '$1');

    function rsnState(msgId) {
      let st = reasonState.get(msgId);
      if (!st) { rsnSweep(); st = { text: '', total: 0, live: false, v: 0, raf: 0, chatId: null }; reasonState.set(msgId, st); }
      return st;
    }
    // Messages that left the page (a closed chat) take their reasoning with them.
    function rsnSweep() {
      for (const [id, st] of reasonState) if (!document.getElementById(id)) { if (st.raf) cancelAnimationFrame(st.raf); reasonState.delete(id); }
      if (rsnFullFor && !reasonState.has(rsnFullFor)) closeReasoningFull();
    }
    function rsnAdd(st, text) {
      st.text += text; st.total += text.length; st.v++;
      if (st.text.length > REASON_KEEP) st.text = st.text.slice(-REASON_KEEP);
    }
    function rsnSchedule(msgId) {
      const st = reasonState.get(msgId);
      if (st && !st.raf) st.raf = requestAnimationFrame(() => paintReasoning(msgId));
    }

    // The own stream's 'reasoning' event.
    function appendReasoning(msgId, chatId, ev) {
      const text = ev && typeof ev.text === 'string' ? ev.text : '';
      if (!text || !msgId || !document.getElementById(msgId)) return;
      const st = rsnState(msgId);
      st.live = true;
      if (chatId) st.chatId = chatId;
      rsnAdd(st, text);
      rsnSchedule(msgId);
    }
    // A followed turn's turn_reasoning { at, text }: false when text is missing before it (fetch the hub's copy).
    function addReasoningAt(msgId, at, text) {
      if (typeof text !== 'string' || !text || !msgId || !document.getElementById(msgId)) return true;
      const st = rsnState(msgId);
      st.live = true;
      if (Number.isFinite(at)) {
        if (at > st.total) return false;
        if (at + text.length <= st.total) return true;   // already shown (a replay)
        text = text.slice(st.total - at);
      }
      rsnAdd(st, text);
      rsnSchedule(msgId);
      return true;
    }
    // The hub's copy (turn view, saved reply). total = the turn's whole length (the text may be its newest part only).
    // onlyIfLonger: keep what is shown when it already has as much (live events can be ahead of a saved copy).
    function setReasoning(msgId, text, { live = false, total, onlyIfLonger = false } = {}) {
      if (typeof text !== 'string' || !text || !msgId || !document.getElementById(msgId)) return;
      const st = rsnState(msgId);
      const tot = Number.isFinite(total) && total >= text.length ? total : text.length;
      if (!(onlyIfLonger && st.total >= tot)) {
        st.text = text.length > REASON_KEEP ? text.slice(-REASON_KEEP) : text;
        st.total = tot;
      }
      st.live = live;
      st.v++;
      rsnSchedule(msgId);
    }
    function finishReasoning(msgId) {
      const st = msgId && reasonState.get(msgId);
      if (!st || !st.live) return;
      st.live = false; st.v++;
      rsnSchedule(msgId);
    }

    // Where the panel goes: first in the message, after a group chat's agent label.
    function placeReasoningPanel(host, box) {
      const label = host.querySelector(':scope > .agent-label, :scope > .synthesis-label');
      if (label) label.after(box); else host.insertBefore(box, host.firstChild);
    }
    // Message rewrites keep the panel node (and so its size, scroll position and open state).
    function setMessageHtml(el, html) {
      const tools = el.querySelector(':scope > .tool-stream');
      const kept = [tools, el.querySelector(':scope > .reason-stream')].find(n => n && n.contains(document.activeElement));
      const focused = kept ? document.activeElement : null;   // a reader on a panel's header or row stays there
      const box = el.querySelector(':scope > .reason-stream');
      el.innerHTML = html;
      if (box) placeReasoningPanel(el, box);
      if (tools) placeToolPanel(el, tools);
      if (focused && focused.isConnected) focused.focus({ preventScroll: true });
    }

    function paintReasoning(msgId) {
      const st = reasonState.get(msgId);
      if (!st) return;
      st.raf = 0;
      const host = document.getElementById(msgId);
      if (!host) { reasonState.delete(msgId); return; }
      let box = host.querySelector(':scope > .reason-stream');
      if (!box) {
        box = document.createElement('div');
        box.className = 'reason-stream';
        box.innerHTML =
          '<div class="rs-head" role="button" tabindex="0">' +
            '<span class="rs-dot"></span><span class="rs-label">Reasoning</span><span class="rs-count"></span>' +
            '<span class="rs-status"></span>' +
            '<button type="button" class="rs-full" title="Show at full size">⤢</button>' +
            '<span class="rs-toggle"></span>' +
          '</div>' +
          '<div class="rs-body"></div>' +
          '<div class="rs-grip" title="Drag to resize"></div>';
        box.querySelector('.rs-body').style.height = `${rsnHeightPref()}px`;
        box.classList.add('collapsed');   // minimized until the reader opens it
        placeReasoningPanel(host, box);
      }
      box.classList.toggle('live', st.live);
      const open = !box.classList.contains('collapsed');
      box.querySelector('.rs-head').setAttribute('aria-expanded', String(open));
      box.querySelector('.rs-toggle').textContent = open ? 'hide' : 'show';
      box.querySelector('.rs-status').textContent = st.live ? 'thinking…' : '';
      const words = rsnWords(st.text);
      box.querySelector('.rs-count').textContent = `· ${words.toLocaleString()} word${words === 1 ? '' : 's'}`;
      const body = box.querySelector('.rs-body');
      if (body.dataset.v !== String(st.v)) {
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.textContent = rsnShown(st);
        body.dataset.v = String(st.v);
        if (atEnd && st.live) body.scrollTop = body.scrollHeight;
      }
      if (st.live && st.chatId) updateToolActivity(st.chatId, `Reasoning · ${words.toLocaleString()} words`, true);
      if (st.live && host.parentElement) autoScroll(host.parentElement);   // keep a growing live panel in view (unless scrolled up)
      if (rsnFullFor === msgId) paintReasoningFull();
    }

    // ⤢: the reasoning at the size of the window (live while the turn runs). Esc, ✕ or a click outside closes it.
    let rsnFullFor = null;
    let rsnFullReturn = null;
    function openReasoningFull(msgId) {
      if (!reasonState.has(msgId)) return;
      let ov = document.getElementById('rsn-full');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'rsn-full';
        ov.className = 'rsn-full-overlay';
        ov.innerHTML =
          '<div class="rsn-full-box" role="dialog" aria-modal="true" aria-label="Reasoning" tabindex="-1">' +
            '<div class="rsn-full-head"><span class="rs-dot"></span><span class="rsn-full-title"></span>' +
            '<span class="rsn-full-count"></span><button type="button" class="rsn-full-close" title="Close (Esc)">✕</button></div>' +
            '<div class="rsn-full-body" tabindex="0"></div>' +
          '</div>';
        ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.rsn-full-close')) closeReasoningFull(); });
        // Esc closes it here, before the chat box's Esc (which pauses a running reply) could see it; Tab stays inside
        // (the text, then ✕). A question or approval dialog that opens above it keeps its own focus, and the chat box's
        // Esc closes this view first (handleKeyDown).
        ov.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeReasoningFull(); return; }
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const body = ov.querySelector('.rsn-full-body'), close = ov.querySelector('.rsn-full-close');
          (document.activeElement === close ? body : close).focus();
        });
        document.body.appendChild(ov);
      }
      rsnFullFor = msgId;
      rsnFullReturn = document.activeElement;
      const host = document.getElementById(msgId);
      const chatId = host && host.parentElement && host.parentElement.id.startsWith('messages-') ? host.parentElement.id.slice(9) : null;
      const who = chatId && chats[chatId] ? (chats[chatId].display || chats[chatId].agent || '') : '';
      ov.querySelector('.rsn-full-title').textContent = who ? `Reasoning · ${who}` : 'Reasoning';
      ov.querySelector('.rsn-full-body').dataset.v = '';
      ov.classList.add('open');
      paintReasoningFull();
      const b = ov.querySelector('.rsn-full-body');
      b.scrollTop = b.scrollHeight;
      ov.querySelector('.rsn-full-body').focus({ preventScroll: true });
    }
    function paintReasoningFull() {
      const ov = document.getElementById('rsn-full');
      const st = rsnFullFor && reasonState.get(rsnFullFor);
      if (!ov || !st) return;
      ov.classList.toggle('live', st.live);
      const words = rsnWords(st.text);
      ov.querySelector('.rsn-full-count').textContent = `${words.toLocaleString()} word${words === 1 ? '' : 's'}${st.live ? ' · thinking…' : ''}`;
      const body = ov.querySelector('.rsn-full-body');
      if (body.dataset.v !== String(st.v)) {
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.textContent = rsnShown(st);
        body.dataset.v = String(st.v);
        if (atEnd) body.scrollTop = body.scrollHeight;
      }
    }
    function closeReasoningFull() {
      const ov = document.getElementById('rsn-full');
      if (ov) ov.classList.remove('open');
      rsnFullFor = null;
      const back = rsnFullReturn; rsnFullReturn = null;
      if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch {} }
    }

    function toggleReasoningPanel(box) {
      const open = box.classList.contains('collapsed');
      box.classList.toggle('collapsed', !open);
      box.querySelector('.rs-head').setAttribute('aria-expanded', String(open));
      box.querySelector('.rs-toggle').textContent = open ? 'hide' : 'show';
      if (open && box.classList.contains('live')) { const body = box.querySelector('.rs-body'); body.scrollTop = body.scrollHeight; }
    }
    document.addEventListener('click', (e) => {
      const box = e.target.closest && e.target.closest('.reason-stream');
      if (!box) return;
      const host = box.parentElement;
      if (e.target.closest('.rs-full')) { e.preventDefault(); if (host && host.id) openReasoningFull(host.id); return; }
      if (e.target.closest('.rs-head')) { e.preventDefault(); toggleReasoningPanel(box); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const head = e.target.closest && e.target.closest('.reason-stream .rs-head');
      if (!head || e.target.closest('.rs-full')) return;
      e.preventDefault();
      toggleReasoningPanel(head.closest('.reason-stream'));
    });
    // The grip: drag for any height (60 px to most of the window); the size is kept for the next panels.
    document.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest && e.target.closest('.reason-stream .rs-grip');
      if (!grip || e.button !== 0) return;
      e.preventDefault();
      const body = grip.closest('.reason-stream').querySelector('.rs-body');
      const y0 = e.clientY, h0 = body.getBoundingClientRect().height;
      const move = (ev) => { body.style.height = `${Math.round(Math.max(60, Math.min(window.innerHeight * 0.85, h0 + ev.clientY - y0)))}px`; };
      const up = () => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        localStorage.setItem(RSN_HEIGHT_KEY, String(parseInt(body.style.height, 10) || rsnHeightPref()));
      };
      try { grip.setPointerCapture(e.pointerId); } catch {}
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });

    // ── Tool panel ─────────────────────────────────────────────────────
    // Every tool call of a reply in one panel under its reasoning panel, closed until the reader opens it, so a reply
    // that runs many tools no longer grows a line per call. The header is one line that updates in place: the calls
    // done, a red count of the failed ones, the call running now and for how long; once the reply is over, the number
    // of calls and the time they took. Opened, one short line per call (a click shows what went in and what came out);
    // a long list scrolls inside the panel and the grip sets its height; ⤢ shows every call with its output at the size
    // of the window. The text the agent writes between calls stays in the reply. Tool names, inputs and outputs are
    // text (escaped), never markup. The panel is one node that message rewrites keep (setMessageHtml).
    const TOOLS_HEIGHT_KEY = 'hub-tools-height';
    const toolsHeightPref = () => { const h = Number(localStorage.getItem(TOOLS_HEIGHT_KEY)); return Number.isFinite(h) && h >= 60 ? h : 260; };
    const TOOL_DETAIL_MAX = 20000;   // characters of one call's output shown in a detail
    let toolsFullFor = null;      // the message whose calls the full view shows
    let toolsFullReturn = null;

    // The panel's model from the reply's steps: a row per call, `group` its step (a thin line between groups). A call
    // still marked running once the reply is over did not finish ('stopped').
    function toolPanelModel(steps, live) {
      const rows = [];
      (steps || []).forEach((st, group) => {
        for (const tc of (st && st.tools) || []) {
          const status = tc.status === 'running' ? (live ? 'running' : 'stopped') : tc.status === 'error' ? 'error' : 'done';
          rows.push({ id: tc.id || tc.toolCallId || null, tool: String(tc.tool || 'tool'), input: String(tc.input || ''), result: tc.result == null ? '' : String(tc.result), status,
            startedAt: Number(tc.startedAt) || null, durationMs: Number.isFinite(tc.durationMs) ? tc.durationMs : null, group });
        }
      });
      // A row's identity across repaints (an opened row stays open): the call's own id, else when it started, what it is
      // and what went in.
      const seen = new Map();
      for (const r of rows) {
        if (r.id) { r.key = `id:${r.id}`; continue; }
        const base = `${r.startedAt || ''}|${r.tool}|${r.input}`; const n = seen.get(base) || 0; seen.set(base, n + 1); r.key = `${base}|${n}`;
      }
      return {
        rows, live: !!live,
        running: rows.filter(r => r.status === 'running'),
        done: rows.filter(r => r.status === 'done' || r.status === 'error').length,
        failed: rows.filter(r => r.status === 'error').length,
        spanMs: toolSpanMs(rows),
      };
    }
    // The time the calls took: the union of their intervals (calls that ran side by side count once). Null unless every
    // call has a start and an end (a call that did not finish, or a reply saved by an older version, shows no total).
    function toolSpanMs(rows) {
      if (!rows.length || rows.some(r => !r.startedAt || r.durationMs == null)) return null;
      const iv = rows.map(r => [r.startedAt, r.startedAt + Math.max(0, r.durationMs)]).sort((a, b) => a[0] - b[0]);
      let total = 0; let [s, e] = iv[0];
      for (const [a, b] of iv.slice(1)) { if (a > e) { total += e - s; s = a; e = b; } else if (b > e) e = b; }
      return total + (e - s);
    }
    // The header's words: calls done (or running) while the reply works, the number of calls once it is over.
    function toolSummaryText(m) {
      const n = m.rows.length;
      if (!m.live) return `${n} call${n === 1 ? '' : 's'}`;
      return m.done ? `${m.done} done` : `${m.running.length || n} running`;
    }
    function toolDurHtml(r) {
      const running = r.status === 'running';
      const ms = !r.startedAt ? null : running ? Date.now() - r.startedAt : r.durationMs;
      if (ms == null) return '<span class="ts-d"></span>';
      return `<span class="ts-d"><span class="tool-elapsed ${durClass(ms)}" data-started="${r.startedAt}"${running ? '' : ' data-frozen="1"'}>${fmtDur(ms)}</span></span>`;
    }
    function toolDetailText(r, full = false) {
      let out = r.status === 'running' ? 'Running…' : r.status === 'stopped' ? 'Stopped before it finished.' : (r.result || '(no output)');
      if (!full && out.length > TOOL_DETAIL_MAX) out = `${out.slice(0, TOOL_DETAIL_MAX)}\n… (${(out.length - TOOL_DETAIL_MAX).toLocaleString()} more characters not shown)`;
      return `${r.tool}${r.input ? `: ${r.input}` : ''}\n\n${out}`;
    }
    // The rows: `open` (a Set of row numbers) shows those calls' details; `all` shows every detail (the full view).
    function toolRowsHtml(m, open, all = false) {
      let html = ''; let group = null;
      m.rows.forEach((r, i) => {
        if (group !== null && r.group !== group) html += '<div class="ts-sep"></div>';
        group = r.group;
        const shown = all || !!(open && open.has(r.key));
        const icon = r.status === 'running' ? '<span class="ts-spin"></span>' : r.status === 'error' ? '✗' : r.status === 'stopped' ? '⏹' : '✓';
        html += `<div class="ts-row ${r.status}" data-i="${i}"${all ? '' : ` role="button" tabindex="0" aria-expanded="${shown}"`}>` +
          `<span class="ts-ic">${icon}</span><span class="ts-name">${escapeHtmlSafe(r.tool)}</span><span class="ts-in">${escapeHtmlSafe(r.input)}</span>` +
          `${toolDurHtml(r)}${all ? '' : `<span class="ts-chev">${shown ? '⌄' : '›'}</span>`}</div>`;
        if (shown) html += `<div class="ts-detail">${escapeHtmlSafe(toolDetailText(r, all))}</div>`;
      });
      return html;
    }
    function paintToolHead(box, m) {
      const q = (s) => box.querySelector(s);
      const open = !box.classList.contains('collapsed');
      q('.ts-head').setAttribute('aria-expanded', String(open));
      q('.ts-toggle').textContent = open ? 'hide' : 'show';
      const k = m.running.length ? 'run' : m.live ? 'wait' : 'done';
      const st = q('.ts-state');
      if (st.dataset.k !== k) { st.dataset.k = k; st.className = `ts-state ${k}`; st.textContent = k === 'done' ? '✓' : ''; }
      q('.ts-count').textContent = `· ${toolSummaryText(m)}`;
      const f = q('.ts-fail');
      f.textContent = m.failed ? `${m.failed} failed` : '';
      f.hidden = !m.failed;
      // What runs now and for how long (the time ticks with the other tool timers); the totals once the reply is over.
      const now = q('.ts-now'), t = q('.ts-time');
      const cur = m.running[m.running.length - 1];
      const key = cur ? `${cur.startedAt}|${cur.tool}|${cur.input}|${m.running.length}` : `-|${m.live}|${m.spanMs}`;
      if (now.dataset.k === key) return;
      now.dataset.k = key;
      if (cur) {
        const more = m.running.length > 1 ? `+${m.running.length - 1}` : '';
        now.innerHTML = `now: <b>${escapeHtmlSafe(cur.tool)}</b> ${escapeHtmlSafe(cur.input)}${more ? ` <span class="ts-more">${more}</span>` : ''}`;
        t.innerHTML = cur.startedAt ? `<span class="tool-elapsed" data-started="${cur.startedAt}">${fmtDur(Date.now() - cur.startedAt)}</span>` : '';
      } else {
        now.textContent = '';
        t.textContent = !m.live && m.spanMs != null ? fmtDur(m.spanMs) : '';
      }
    }
    // Whether two models show the same rows: compared by value (a string that did not change is the same string).
    function sameToolRows(a, b) {
      if (!a || !b || a.live !== b.live || a.rows.length !== b.rows.length) return false;
      return b.rows.every((y, i) => { const x = a.rows[i]; return x.key === y.key && x.group === y.group && x.status === y.status && x.tool === y.tool && x.startedAt === y.startedAt && x.durationMs === y.durationMs && x.input === y.input && x.result === y.result; });
    }
    function paintToolPanel(host, msgId, steps, live) {
      const m = toolPanelModel(steps, live);
      let box = host.querySelector(':scope > .tool-stream');
      if (!m.rows.length) { if (box) box.remove(); return; }
      if (!box) {
        box = document.createElement('div');
        box.className = 'tool-stream collapsed';   // closed until the reader opens it
        box.innerHTML =
          '<div class="ts-head" role="button" tabindex="0">' +
            '<span class="ts-state"></span><span class="ts-label">Tools</span><span class="ts-count"></span>' +
            '<span class="ts-fail" hidden></span><span class="ts-now"></span><span class="ts-time"></span>' +
            '<button type="button" class="ts-full" title="Every call with its output, at full size">⤢</button>' +
            '<span class="ts-toggle"></span>' +
          '</div>' +
          '<div class="ts-body"></div>' +
          '<div class="ts-grip" title="Drag to resize"></div>';
        box.querySelector('.ts-body').style.maxHeight = `${toolsHeightPref()}px`;
        box._open = new Set();
        placeToolPanel(host, box);
      }
      const prev = box._model;
      box._steps = steps; box._model = m; box.dataset.msg = msgId;
      box.classList.toggle('live', m.live);
      paintToolHead(box, m);
      // The rows are rebuilt only when a call starts, ends or changes; the running timers tick on their own.
      const body = box.querySelector('.ts-body');
      if (!body.dataset.built || !sameToolRows(prev, m)) {
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        const top = body.scrollTop;
        const fRow = body.contains(document.activeElement) ? document.activeElement.closest('.ts-row') : null;
        const fKey = fRow && prev && prev.rows[Number(fRow.dataset.i)] ? prev.rows[Number(fRow.dataset.i)].key : null;
        body.innerHTML = toolRowsHtml(m, box._open);
        body.dataset.built = '1';
        box._rev = (box._rev || 0) + 1;
        body.scrollTop = atEnd && m.live ? body.scrollHeight : top;
        const j = fKey ? m.rows.findIndex(r => r.key === fKey) : -1;
        if (j >= 0) body.querySelector(`.ts-row[data-i="${j}"]`)?.focus({ preventScroll: true });
      }
      if (toolsFullFor === msgId) paintToolsFull();
    }
    // Where the panel goes: right under the reasoning panel, else first in the message (after a group chat's label).
    function placeToolPanel(host, box) {
      const rsn = host.querySelector(':scope > .reason-stream');
      if (rsn) { rsn.after(box); return; }
      const label = host.querySelector(':scope > .agent-label, :scope > .synthesis-label');
      if (label) label.after(box); else host.insertBefore(box, host.firstChild);
    }
    // The reply is over (done, stopped or failed): the header shows the totals; a call still running did not finish.
    function finishToolPanel(msgId) {
      const host = msgId && document.getElementById(msgId);
      const box = host && host.querySelector(':scope > .tool-stream');
      if (box && box._model && box._model.live) paintToolPanel(host, msgId, box._steps, false);
    }
    function toggleToolPanel(box) {
      box.classList.toggle('collapsed');
      if (box._model) paintToolHead(box, box._model);
      if (!box.classList.contains('collapsed') && box.classList.contains('live')) { const b = box.querySelector('.ts-body'); b.scrollTop = b.scrollHeight; }
    }
    function toggleToolRow(box, row, keyboard = false) {
      const i = Number(row.dataset.i);
      const r = Number.isInteger(i) && box._model ? box._model.rows[i] : null;
      if (!r) return;
      if (box._open.has(r.key)) box._open.delete(r.key); else box._open.add(r.key);
      const body = box.querySelector('.ts-body');
      const top = body.scrollTop;
      body.innerHTML = toolRowsHtml(box._model, box._open);
      body.scrollTop = top;
      if (keyboard) body.querySelector(`.ts-row[data-i="${i}"]`)?.focus({ preventScroll: true });
    }
    document.addEventListener('click', (e) => {
      const box = e.target.closest && e.target.closest('.tool-stream');
      if (!box) return;
      if (e.target.closest('.ts-full')) { e.preventDefault(); if (box.dataset.msg) openToolsFull(box.dataset.msg); return; }
      if (e.target.closest('.ts-head')) { e.preventDefault(); toggleToolPanel(box); return; }
      const row = e.target.closest('.ts-row');
      if (row && !String(window.getSelection ? window.getSelection() : '')) toggleToolRow(box, row);   // not while selecting text
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const t = e.target.closest && e.target.closest('.tool-stream .ts-head, .tool-stream .ts-row');
      if (!t || e.target.closest('.ts-full')) return;
      e.preventDefault();
      const box = t.closest('.tool-stream');
      if (t.classList.contains('ts-head')) toggleToolPanel(box); else toggleToolRow(box, t, true);
    });
    // The grip: drag for any height (60 px to most of the window); the size is kept for the next panels.
    document.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest && e.target.closest('.tool-stream .ts-grip');
      if (!grip || e.button !== 0) return;
      e.preventDefault();
      const body = grip.closest('.tool-stream').querySelector('.ts-body');
      const y0 = e.clientY, h0 = body.getBoundingClientRect().height;
      const move = (ev) => { body.style.maxHeight = `${Math.round(Math.max(60, Math.min(window.innerHeight * 0.85, h0 + ev.clientY - y0)))}px`; };
      const up = () => {
        grip.removeEventListener('pointermove', move); grip.removeEventListener('pointerup', up); grip.removeEventListener('pointercancel', up);
        localStorage.setItem(TOOLS_HEIGHT_KEY, String(parseInt(body.style.maxHeight, 10) || toolsHeightPref()));
      };
      try { grip.setPointerCapture(e.pointerId); } catch {}
      grip.addEventListener('pointermove', move); grip.addEventListener('pointerup', up); grip.addEventListener('pointercancel', up);
    });
    // ⤢: every call with what went in and what came out, at the size of the window (live while the reply runs). Esc,
    // ✕ or a click outside closes it; Tab stays inside (the list, then ✕).
    function openToolsFull(msgId) {
      let ov = document.getElementById('tools-full');
      if (!ov) {
        ov = document.createElement('div');
        ov.id = 'tools-full';
        ov.className = 'rsn-full-overlay tools-full';
        ov.innerHTML =
          '<div class="rsn-full-box" role="dialog" aria-modal="true" aria-label="Tool calls" tabindex="-1">' +
            '<div class="rsn-full-head"><span class="rsn-full-title"></span><span class="rsn-full-count"></span>' +
            '<button type="button" class="rsn-full-close" title="Close (Esc)">✕</button></div>' +
            '<div class="rsn-full-body ts-full-body" tabindex="0"></div>' +
          '</div>';
        ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('.rsn-full-close')) closeToolsFull(); });
        ov.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToolsFull(); return; }
          if (e.key !== 'Tab') return;
          e.preventDefault();
          const body = ov.querySelector('.rsn-full-body'), close = ov.querySelector('.rsn-full-close');
          (document.activeElement === close ? body : close).focus();
        });
        document.body.appendChild(ov);
      }
      toolsFullFor = msgId;
      toolsFullReturn = document.activeElement;
      const host = document.getElementById(msgId);
      const chatId = host && host.parentElement && host.parentElement.id.startsWith('messages-') ? host.parentElement.id.slice(9) : null;
      const who = chatId && chats[chatId] ? (chats[chatId].display || chats[chatId].agent || '') : '';
      ov.querySelector('.rsn-full-title').textContent = who ? `Tools · ${who}` : 'Tools';
      ov.querySelector('.rsn-full-body').dataset.rev = '';
      ov.classList.add('open');
      paintToolsFull();
      const b = ov.querySelector('.rsn-full-body');
      b.scrollTop = b.scrollHeight;
      b.focus({ preventScroll: true });
    }
    function paintToolsFull() {
      const ov = document.getElementById('tools-full');
      const host = toolsFullFor && document.getElementById(toolsFullFor);
      const box = host && host.querySelector(':scope > .tool-stream');
      if (!ov || !box || !box._model) { if (ov && toolsFullFor) closeToolsFull(); return; }
      const m = box._model;
      ov.classList.toggle('live', m.live);
      ov.querySelector('.rsn-full-count').textContent = `${toolSummaryText(m)}${m.failed ? ` · ${m.failed} failed` : ''}${!m.live && m.spanMs != null ? ` · ${fmtDur(m.spanMs)}` : ''}`;
      const body = ov.querySelector('.rsn-full-body');
      const rev = String(box._rev || 0);
      if (body.dataset.rev !== rev) {
        const atEnd = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
        body.innerHTML = toolRowsHtml(m, null, true);
        body.dataset.rev = rev;
        if (atEnd) body.scrollTop = body.scrollHeight;
      }
    }
    function closeToolsFull() {
      const ov = document.getElementById('tools-full');
      if (ov) ov.classList.remove('open');
      toolsFullFor = null;
      const back = toolsFullReturn; toolsFullReturn = null;
      if (back && back.isConnected && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch {} }
    }

    function escapeHtmlSafe(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderSteps(msgId, steps, toolActivity, images = [], isStreaming = true) {
      const el = document.getElementById(msgId);
      if (!el) return;

      const thinkWasCollapsed = el.querySelector('.inline-thinking.collapsed') !== null;

      // The text the agent writes stays in the reply, in order; every tool call goes into the reply's tool panel.
      let html = '';

      for (let si = 0; si < steps.length; si++) {
        const step = steps[si];
        const isLastStep = si === steps.length - 1;
        const hasTools = step.tools.length > 0;
        const hasText = step.text.trim().length > 0;

        // Render step text — intermediate steps (followed by tools) render smaller as status labels
        if (hasText) {
          const isIntermediate = hasTools || (!isLastStep && steps.length > 1);
          const cls = isIntermediate ? 'step-text step-intermediate' : 'step-text';
          html += `<div class="${cls}">${formatContent(step.text.replace(/^\s*\n/, ''))}</div>`;   // the paragraph break after a tool call is the layout's job
        }
      }

      // Append images (escaped; click handled by the delegated listener)
      html += imageGalleryHtml(images);

      setMessageHtml(el, html);
      paintToolPanel(el, msgId, steps, isStreaming);
      decorateMessage(el, steps.map(st => st.text).filter(t => t && t.trim()).join('\n\n'));

      if (thinkWasCollapsed) {
        const b = el.querySelector('.inline-thinking');
        if (b) b.classList.add('collapsed');
      }

      // innerHTML wiped the live-activity footer — put it back if still active
      if (isStreaming && liveActivity.has(msgId)) renderLiveActivity(msgId);
      // innerHTML wiped the token-usage bar — put it back (always, so it persists after streaming ends)
      if (tokenUsageState.has(msgId) || tokenEstimate.has(msgId)) renderTokenUsage(msgId, !isStreaming);

      const container = el.parentElement;
      autoScroll(container);
    }

    function updateMessageWithTools(msgId, content, toolActivity, images = [], isStreaming = true) {
      const el = document.getElementById(msgId);
      if (el) {
        const thinkWasCollapsed = el.querySelector('.inline-thinking.collapsed') !== null;

        // Show spinner on last tool when still streaming
        const showStatus = isStreaming;
        let html = buildToolsHtml(toolActivity, showStatus) + formatContent(content);
        html += imageGalleryHtml(images);

        setMessageHtml(el, html);
        decorateMessage(el, content);
        renderVisualBlocks(el);

        if (thinkWasCollapsed) {
          const b = el.querySelector('.inline-thinking');
          if (b) b.classList.add('collapsed');
        }

        // innerHTML wiped the token-usage bar — restore it
        if (tokenUsageState.has(msgId) || tokenEstimate.has(msgId)) renderTokenUsage(msgId, !isStreaming);

        const container = el.parentElement;
        autoScroll(container);
      }
    }

    function openImageModal(imgUrl) {
      const modal = document.getElementById('image-modal');
      const modalImg = document.getElementById('modal-image');
      modalImg.src = imgUrl;
      modal.classList.add('active');
      dialogGuard.open(modal, { close: closeImageModal });   // Esc closes it first, before any dialog under it
    }
    // One delegated listener for every chat image: no inline handler ever carries an agent-supplied URL.
    document.addEventListener('click', (e) => {
      const img = e.target && e.target.closest && e.target.closest('img.generated-image');
      if (!img) return;
      e.preventDefault();
      openImageModal(img.currentSrc || img.src);
    });
    
    function closeImageModal() {
      const modal = document.getElementById('image-modal');
      modal.classList.remove('active');
      dialogGuard.closed(modal);
    }
    
    function updateGroupMessage(msgId, content, agentName, colorIndex) {
      const el = document.getElementById(msgId);
      if (el) {
        const thinkWas = el.querySelector('.inline-thinking.collapsed') !== null;
        const color = AGENT_COLORS[colorIndex % AGENT_COLORS.length];
        setMessageHtml(el, `<div class="agent-label" style="background: ${color}33; color: ${color}">${agentName}</div>${formatContent(content)}`);
        decorateMessage(el, content);
        renderVisualBlocks(el);
        if (thinkWas) { const b = el.querySelector('.inline-thinking'); if (b) b.classList.add('collapsed'); }
        const container = el.parentElement;
        autoScroll(container);
      }
    }
    
    function updateSynthesisMessage(msgId, content, round) {
      const el = document.getElementById(msgId);
      if (el) {
        setMessageHtml(el, `<div class="synthesis-label">📋 Synthesis - Round ${round}</div>${formatContent(content)}`);
        decorateMessage(el, content);
        renderVisualBlocks(el);
        const container = el.parentElement;
        autoScroll(container);
      }
    }
    
    function parseThinking(content) {
      // Extract thinking content and actual response
      const thinkingPatterns = [
        /<think>([\s\S]*?)<\/think>/gi,
        /<thinking>([\s\S]*?)<\/thinking>/gi,
        /<reasoning>([\s\S]*?)<\/reasoning>/gi,
        /\[think\]([\s\S]*?)\[\/think\]/gi,
        /\[thinking\]([\s\S]*?)\[\/thinking\]/gi,
      ];
      
      let thinking = '';
      let cleaned = content;
      
      for (const pattern of thinkingPatterns) {
        const matches = content.matchAll(pattern);
        for (const match of matches) {
          thinking += (thinking ? '\n' : '') + match[1].trim();
        }
        cleaned = cleaned.replace(pattern, '');
      }
      
      // Check for unclosed thinking tags (still in progress)
      const unclosedPatterns = [
        /<think>([\s\S]*)$/i,
        /<thinking>([\s\S]*)$/i,
        /<reasoning>([\s\S]*)$/i,
        /\[think\]([\s\S]*)$/i,
        /\[thinking\]([\s\S]*)$/i,
      ];
      
      let stillThinking = false;
      for (const pattern of unclosedPatterns) {
        const match = cleaned.match(pattern);
        if (match) {
          thinking += (thinking ? '\n' : '') + match[1].trim();
          cleaned = cleaned.replace(pattern, '');
          stillThinking = true;
        }
      }
      
      // Strip instruction echoing at start of response
      const echoPatterns = [
        /^.*?we need to respond.*?\n/i,
        /^.*?should respond.*?\n/i,
        /^.*?should be narrative.*?\n/i,
        /^.*?should be concise.*?\n/i,
        /^.*?let me craft.*?\n/i,
        /^.*?let's craft.*?\n/i,
        /^.*?i need to.*?\n/i,
        /^.*?my role is.*?\n/i,
        /^.*?my objective.*?\n/i,
        /^.*?narrative style.*?\n/i,
        /^.*?bullet point.*?\n/i,
        /^.*?third person.*?\n/i,
        /^.*?should not generate.*?\n/i,
        /^.*?should refer to.*?\n/i,
      ];
      
      for (const pattern of echoPatterns) {
        cleaned = cleaned.replace(pattern, '');
      }
      
      // Detect and clean garbage output (repeated characters like ????)
      // Only trigger if the MAJORITY of the remaining text is garbage
      const garbageChars = ['?', '.', '*', '#', '_', '='];
      for (const char of garbageChars) {
        const escaped = char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const garbageMatch = cleaned.match(new RegExp(escaped + '{20,}'));
        if (garbageMatch && garbageMatch[0].length > cleaned.length * 0.3) {
          const salvaged = cleaned.slice(0, garbageMatch.index).trim();
          if (salvaged.length > 50) {
            cleaned = salvaged;
          } else {
            cleaned = '[Response degenerated]';
          }
          break;
        }
      }
      
      return { thinking: thinking.trim(), response: cleaned.trim(), stillThinking };
    }
    
    function updateThinkingPanel(chatId, thinking, agentName = null, stillThinking = true) {
      // Thinking content renders inline in the message bubble.
      // The thinking panel is now managed by the tool tracker for live progress.
      // Only hide the panel here if the tool tracker isn't active.
      if (!stillThinking && !toolTrackers.has(chatId)) {
        const panel = document.getElementById(`thinking-panel-${chatId}`);
        if (panel) panel.classList.remove('active');
      }
    }

    // ==================== WORKER TABS ====================
    // One card per named agent: when an agent that already has an open card is called again, that card
    // comes back to work and shows the new call under the earlier ones, instead of a second card for the
    // same agent. Temporary workers (spawn_workers) and the Claude client's sub-agents keep a card per
    // call. Each call is a run inside its card, keyed by its worker id, so two calls to one agent that
    // overlap still stream into their own replies.

    // Map workerId -> workerChatId (the card that shows this worker's run)
    const workerTabMap = new Map();
    // Map workerChatId -> coordinatorChatId (the chat behind the card's newest run)
    const workerParentMap = new Map();
    // Map card key -> workerChatId: the open card of each named agent
    const workerCardByKey = new Map();
    // Worker ids whose card the user closed: a replayed start or a catch-up never brings them back
    const closedWorkerRuns = new Set();

    // Which calls share a card: a named agent's share one (its name), a one-off worker's never (null).
    function workerCardKey(oc) {
      const agent = typeof oc.agent_type === 'string' ? oc.agent_type.trim() : '';
      if (!agent || agent === 'temporal' || agent === 'sdk-agent') return null;
      return `${oc.tiger_team ? 'tt' : 'agent'}:${agent}`;
    }

    // The card and run showing a worker id, or null (unknown, or its card was closed).
    function workerRunOf(workerId) {
      const workerChatId = workerTabMap.get(String(workerId));
      const chat = workerChatId ? chats[workerChatId] : null;
      const run = chat && chat.runs ? chat.runs[String(workerId)] : null;
      return run ? { workerChatId, chat, run } : null;
    }

    function workerRunsActive(chat) {
      return Object.values(chat.runs || {}).some(r => r.status === 'running');
    }

    // A run ended: the card stops working (timer and status) once none of its runs is still running;
    // until then its timer follows the newest run still running.
    function settleWorkerCard(workerChatId, status, statusText) {
      const chat = chats[workerChatId];
      if (!chat) return;
      const live = Object.values(chat.runs || {}).filter(r => r.status === 'running').sort((a, b) => b.startedAt - a.startedAt)[0];
      if (live) { chat.startedAt = live.startedAt; updateWorkerTabTimer(workerChatId); return; }
      if (chat.timerInterval) { clearInterval(chat.timerInterval); chat.timerInterval = null; }
      setStatus(workerChatId, status, statusText);
    }

    // A stopped run (Stop on its card, or its caller was stopped; the hub stops it too): its notice and reply stop
    // saying it works.
    function markWorkerRunCancelled(chat, run) {
      run.status = 'cancelled';
      if (run.noticeEl) {
        run.noticeEl.textContent = `⏹ ${chat.agentLabel || 'Agent'} Stopped`;
        run.noticeEl.className = 'system-notice notice-failed';
      }
      if (run.text || run.tools.length || run.turnTools) paintWorkerRun(run);   // no longer drawn as streaming (an empty one keeps its "...")
    }

    // One call to the card's agent: its prompt and a reply placeholder in the card, a notice in the
    // caller's chat, and the card (back) at work.
    function startWorkerRun(workerChatId, chatId, oc) {
      const chat = chats[workerChatId];
      const workerId = String(oc.worker_id);
      const again = Object.keys(chat.runs).length > 0;
      workerTabMap.set(workerId, workerChatId);
      workerParentMap.set(workerChatId, chatId);
      chat.workerId = workerId;   // the newest run's
      chat.parentChatId = chatId;
      chat.externalSource = oc.external_source || null;
      chat.workerPrompt = oc.prompt || oc.description || '';
      if (oc.model) chat.model = oc.model;
      paintWorkerCaller(workerChatId);
      if (again) appendSystemNotice(workerChatId, `↻ Called again by ${workerCallerLabel(chat)} · ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, 'worker-again');

      // The coordinator's prompt, then the reply placeholder
      const promptMsgId = appendMessage(workerChatId, 'user', oc.prompt || oc.description || '(no prompt)');
      const msgId = appendMessage(workerChatId, 'assistant', '...');

      // "Working" notice in the caller's chat
      const label = chat.agentLabel || 'Agent';
      const noticeEl = appendSystemNotice(chatId, `${chat.isTigerTeam ? '🐯' : '⏳'} ${label} is Working...`, chat.isTigerTeam ? 'tiger-working' : 'working');

      const startedAt = Date.now();
      chat.runs[workerId] = { id: workerId, parentChatId: chatId, externalSource: chat.externalSource, msgId, promptMsgId, promptShown: !!oc.prompt, text: '', tools: [], turnTools: null, noticeEl, startedAt, status: 'running' };
      chat.lastMsgId = msgId;
      chat.workingNoticeEl = noticeEl;
      chat.startedAt = startedAt;
      if (again) setStatus(workerChatId, 'thinking', 'Working...');

      // Elapsed timer (the newest call's)
      if (!chat.timerInterval) chat.timerInterval = setInterval(() => updateWorkerTabTimer(workerChatId), 1000);
      updateWorkerTabTimer(workerChatId);
      flashTab(workerChatId);
    }

    function handleWorkerEvent(chatId, oc) {
      if (oc.type === 'worker_started') {
        const workerId = String(oc.worker_id);
        if (workerRunOf(workerId) || closedWorkerRuns.has(workerId)) return true;   // already shown (a replay), or its card was closed
        const key = workerCardKey(oc);
        const open = key ? workerCardByKey.get(key) : null;
        if (open && chats[open] && document.getElementById(`tab-${open}`)) {
          startWorkerRun(open, chatId, oc);   // this agent's card is open: it re-activates
          return true;
        }
        const workerChatId = `worker-${workerId}`;
        if (chats[workerChatId]) return true;
        const isTigerTeam = !!oc.tiger_team;

        chats[workerChatId] = {
          id: workerChatId,
          agent: oc.agent_type || 'worker',
          display: oc.description || 'Worker',
          model: oc.model || 'sonnet',
          messages: [],
          status: 'thinking',
          isWorker: true,
          externalSource: oc.external_source || null,
          isTigerTeam,
          workerId,
          parentChatId: chatId,
          workerPrompt: oc.prompt || oc.description || '',
          startedAt: Date.now(),
          timerInterval: null,
          cardKey: key,
          runs: {},
          // Extract agent name from description
          agentLabel: (oc.description || 'Worker').replace(/^Worker:\s*/, '').replace(/^🐯\s*/, ''),
          lastMsgId: null,
          controller: null,
        };
        if (key) workerCardByKey.set(key, workerChatId);

        renderWorkerChatTab(workerChatId);
        renderWorkerChatPanel(workerChatId);
        startWorkerRun(workerChatId, chatId, oc);
        return true;
      }

      if (oc.type === 'worker_text_delta') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        w.run.text += oc.text;
        updateMessageWithTools(w.run.msgId, w.run.text, w.run.tools);
        return true;
      }

      if (oc.type === 'worker_tool_start') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        w.run.tools.push({ type: 'call', tool: oc.tool, input: '' });
        updateMessageWithTools(w.run.msgId, w.run.text, w.run.tools);
        return true;
      }

      if (oc.type === 'worker_tool_use') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        // Update the most recent matching tool call with its input
        const last = [...w.run.tools].reverse().find(t => t.type === 'call' && t.tool === oc.tool);
        if (last) last.input = oc.input || '';
        updateMessageWithTools(w.run.msgId, w.run.text, w.run.tools);
        return true;
      }

      if (oc.type === 'worker_tool_result') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        if (oc.output) {
          w.run.tools.push({ type: 'result', output: oc.output });
          updateMessageWithTools(w.run.msgId, w.run.text, w.run.tools);
        }
        return true;
      }

      if (oc.type === 'worker_completed') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        const { workerChatId, chat, run } = w;
        if (run.status === 'completed' || run.status === 'failed') return true;   // already ended (a repeat)
        run.status = 'completed';
        settleWorkerCard(workerChatId, 'idle', 'Completed');

        // Update the working notice
        const label = chat.agentLabel || 'Agent';
        const doneIcon = chat.isTigerTeam ? '🐯 ✅' : '✅';
        // It leaves a few seconds later: finished workers piled up under a long reply (a failed or stopped one stays)
        if (run.noticeEl) {
          run.noticeEl.textContent = `${doneIcon} ${label} is Complete`;
          run.noticeEl.className = 'system-notice notice-complete';
          retireSoon(run.noticeEl);
        } else {
          retireSoon(appendSystemNotice(chatId, `${doneIcon} ${label} is Complete`, 'complete'));
        }
        return true;
      }

      // ── Tiger Team Events ──
      if (oc.type === 'tiger_team_started') {
        const teamNotice = `🐯 **Tiger Team Launched**\n👑 Lead: ${oc.coordinator_display}\n👥 Team: ${(oc.participant_displays || []).join(', ')}\n🎯 ${oc.objective || ''}`;
        appendSystemNotice(chatId, teamNotice, 'tiger-team');
        return true;
      }
      if (oc.type === 'tiger_team_round') {
        appendSystemNotice(chatId, `━━━ Round ${oc.round} — ${oc.agent_display || oc.agent} ━━━`, 'round');
        return true;
      }
      if (oc.type === 'tiger_team_completed') {
        appendSystemNotice(chatId, `✅ Tiger Team Complete — ${oc.coordinator_display} delivered ${oc.result_length} chars`, 'complete');
        return true;
      }
      if (oc.type === 'tiger_team_error') {
        appendSystemNotice(chatId, `❌ Tiger Team Error: ${oc.error}`, 'failed');
        return true;
      }

      if (oc.type === 'worker_failed') {
        const w = workerRunOf(oc.worker_id);
        if (!w) return false;
        const { workerChatId, chat, run } = w;
        if (run.status === 'completed' || run.status === 'failed') return true;   // already ended (a repeat)
        if (oc.cancelled) {   // stopped by the owner, on its card or with its caller
          if (run.status !== 'cancelled') markWorkerRunCancelled(chat, run);
          settleWorkerCard(workerChatId, 'error', 'Stopped');
          return true;
        }
        const failLabel = 'Failed';
        run.status = 'failed';
        if (oc.error) {
          // Under this run's reply: a later call to the agent may already show below it
          const errEl = document.getElementById(appendMessage(workerChatId, 'system', `Worker ${failLabel.toLowerCase()}: ${oc.error}`));
          const replyEl = document.getElementById(run.msgId);
          if (errEl && replyEl && replyEl.nextElementSibling !== errEl) replyEl.after(errEl);
        }
        settleWorkerCard(workerChatId, 'error', failLabel);

        const agentLabel = chat.agentLabel || 'Agent';
        if (run.noticeEl) {
          run.noticeEl.textContent = `❌ ${agentLabel} ${failLabel}`;
          run.noticeEl.className = 'system-notice notice-failed';
        } else {
          appendSystemNotice(chatId, `❌ ${agentLabel} ${failLabel}`, 'failed');
        }
        return true;
      }

      return false;
    }

    // Labels go in as text: a worker's description can come from a model (a temporary worker's label,
    // a sub-agent's description).
    function renderWorkerChatTab(workerChatId) {
      const chat = chats[workerChatId];
      const workerBar = document.getElementById('worker-tabs');
      const tab = document.createElement('div');
      tab.className = 'chat-tab worker' + (chat.isTigerTeam ? ' tiger-team-tab' : '');
      tab.id = `tab-${workerChatId}`;
      const desc = chat.display || 'Worker';
      tab.innerHTML = '<span class="status thinking"></span><span class="name"></span><span class="close-tab">&#x2715;</span>';
      tab.querySelector('.name').textContent = desc.length > 30 ? desc.slice(0, 28) + '...' : desc;
      tab.querySelector('.close-tab').addEventListener('click', (e) => closeChat(workerChatId, e));
      tab.addEventListener('click', () => switchToChat(workerChatId));
      workerBar.appendChild(tab);
      updateWorkerBarVisibility();
    }

    function updateWorkerBarVisibility() {
      const workerBar = document.getElementById('worker-tabs');
      const hasWorkerTabs = workerBar.querySelectorAll('.chat-tab').length > 0;
      workerBar.classList.toggle('has-tabs', hasWorkerTabs);
    }

    function renderWorkerChatPanel(workerChatId) {
      const chat = chats[workerChatId];
      const panels = document.getElementById('chat-panels');
      const panel = document.createElement('div');
      panel.className = 'chat-container';
      panel.id = `panel-${workerChatId}`;

      panel.innerHTML = `
        <div class="status-bar" id="status-bar-${workerChatId}">
          <div class="status-item">
            <span class="status-dot thinking" id="status-dot-${workerChatId}"></span>
            <span id="status-text-${workerChatId}">Working...</span>
            <span class="worker-elapsed" id="worker-elapsed-${workerChatId}" style="margin-left:8px;font-size:0.8em;color:var(--text-dim);">0s</span>
          </div>
        </div>
        <div class="chat-actions">
          <button data-w="back" id="worker-back-${workerChatId}"></button>
          <button data-w="stop" id="cancel-${workerChatId}" title="Stop the calls running in this card">&#x23F9; Stop</button>
          <span class="agent-name" id="worker-name-${workerChatId}"></span>${cyberHeaderTag(chat.model)}
        </div>
        <div class="messages" id="messages-${workerChatId}"></div>
        <div class="worker-readonly-footer" id="worker-from-${workerChatId}"></div>
      `;
      // The caller can change when the card re-activates: both buttons read the card at click time
      panel.querySelector('[data-w="back"]').addEventListener('click', () => { const c = chats[workerChatId]; if (c) switchToChat(c.parentChatId); });
      panel.querySelector('[data-w="stop"]').addEventListener('click', () => cancelWorkerCard(workerChatId));
      if (chat.agent === 'sdk-agent') panel.querySelector('[data-w="stop"]').title = 'Stop: this sub-agent runs inside its caller\'s reply, so that reply stops too';
      panels.appendChild(panel);
      paintWorkerCaller(workerChatId);
    }

    function workerCallerLabel(chat) {
      const parentChat = chats[chat.parentChatId];
      return chat.externalSource || (parentChat ? (parentChat.display || parentChat.agent || 'Coordinator') : 'Coordinator');
    }

    // The card's header and footer: its agent and model, and who called it last.
    function paintWorkerCaller(workerChatId) {
      const chat = chats[workerChatId];
      if (!chat) return;
      const label = workerCallerLabel(chat);
      const back = document.getElementById(`worker-back-${workerChatId}`);
      if (back) { back.textContent = `↩ ${label}`; back.title = `Switch to ${label}`; }
      const name = document.getElementById(`worker-name-${workerChatId}`);
      if (name) name.textContent = `${chat.display} (${(chat.model || '').split('/').pop() || chat.model})`;
      const from = document.getElementById(`worker-from-${workerChatId}`);
      if (from) from.textContent = `Read-only worker view — output streams from ${label}`;
    }

    function updateWorkerTabTimer(workerChatId) {
      const chat = chats[workerChatId];
      if (!chat || chat.status !== 'thinking') return;
      const elapsed = Math.floor((Date.now() - chat.startedAt) / 1000);
      const el = document.getElementById(`worker-elapsed-${workerChatId}`);
      if (el) {
        if (elapsed < 60) el.textContent = `${elapsed}s`;
        else el.textContent = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
      }
    }

    function flashTab(chatId) {
      const tab = document.getElementById(`tab-${chatId}`);
      if (!tab) return;
      tab.classList.add('flash');
      setTimeout(() => tab.classList.remove('flash'), 2000);
    }

    function cleanupWorkerTabs(coordinatorChatId) {
      // This coordinator's stream stopped: its calls still running end as cancelled
      for (const wChatId of new Set(workerTabMap.values())) {
        const wChat = chats[wChatId];
        if (!wChat || !wChat.runs) continue;
        let ended = false;
        for (const run of Object.values(wChat.runs)) {
          if (run.parentChatId === coordinatorChatId && run.status === 'running') { markWorkerRunCancelled(wChat, run); ended = true; }
        }
        if (ended) settleWorkerCard(wChatId, 'error', 'Stopped');
      }
    }

    // A card going away: its runs' ids and its agent's slot are freed (that agent's next call opens a new card).
    // Closed by the user (dismissed), its runs never come back on this page.
    function forgetWorkerCard(workerChatId, dismissed = false) {
      const chat = chats[workerChatId];
      if (!chat) return;
      if (chat.timerInterval) { clearInterval(chat.timerInterval); chat.timerInterval = null; }
      for (const id of Object.keys(chat.runs || {})) {
        if (dismissed) closedWorkerRuns.add(id);
        if (workerTabMap.get(id) === workerChatId) workerTabMap.delete(id);
      }
      if (chat.cardKey && workerCardByKey.get(chat.cardKey) === workerChatId) workerCardByKey.delete(chat.cardKey);
      workerParentMap.delete(workerChatId);
    }

    // A coordinator chat closing: the cards it called last close with it, unless another open chat called
    // that agent too; then the card stays and follows that chat (one whose call still runs first). Its
    // runs still going elsewhere are no longer followed.
    function closeWorkerCardsOf(coordinatorChatId) {
      for (const [wChatId, pChatId] of [...workerParentMap]) {
        if (pChatId !== coordinatorChatId) continue;
        const wChat = chats[wChatId];
        const survivor = Object.values(wChat?.runs || {})
          .filter(r => r.parentChatId !== coordinatorChatId && chats[r.parentChatId])
          .sort((a, b) => ((b.status === 'running') - (a.status === 'running')) || (b.startedAt - a.startedAt))[0];   // a running call first
        if (survivor) {
          wChat.parentChatId = survivor.parentChatId;
          wChat.externalSource = survivor.externalSource || null;
          workerParentMap.set(wChatId, survivor.parentChatId);
          paintWorkerCaller(wChatId);
          continue;
        }
        forgetWorkerCard(wChatId);
        workerParentMap.delete(wChatId);
        document.getElementById(`tab-${wChatId}`)?.remove();
        document.getElementById(`panel-${wChatId}`)?.remove();
        delete chats[wChatId];
      }
      cleanupWorkerTabs(coordinatorChatId);
    }

    // ⏹ Stop on a card: every call still running in it, stopped on the hub. A Claude-client sub-agent runs inside its
    // caller's reply, so stopping it means stopping that reply.
    function cancelWorkerCard(workerChatId) {
      const chat = chats[workerChatId];
      if (!chat || !chat.runs) return Promise.resolve([]);
      const callers = new Set(), stops = [];
      for (const run of Object.values(chat.runs)) {
        if (run.status !== 'running') continue;
        if (chat.agent !== 'sdk-agent') { stops.push(cancelWorker(run.id)); continue; }
        const p = run.parentChatId;
        if (!chats[p] || callers.has(p)) continue;
        callers.add(p);
        if (chats[p].isGroup) cancelGroupRequest(p); else cancelRequest(p);
      }
      return Promise.all(stops);
    }

    // Stop one call on the hub. The card says Stopped once the hub has stopped it (or its end event says so first).
    async function cancelWorker(workerId) {
      const w = workerRunOf(workerId);
      const caller = w ? chats[w.run.parentChatId] : null;
      let r = null;
      try {
        const res = await fetch('/api/cancel-worker', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ worker_id: workerId, agent: (caller && !caller.isGroup && caller.agent) || (w && w.chat.agent) || undefined }),
        });
        r = await res.json().catch(() => null);
      } catch {}
      const now = workerRunOf(workerId);
      if (now && r && r.success && now.run.status === 'running') {
        markWorkerRunCancelled(now.chat, now.run);
        settleWorkerCard(now.workerChatId, 'error', 'Stopped');
      }
      return r;
    }

    // ── Visual blocks ─────────────────────────────────────────────────────────────────────────────
    // Four fenced block types are DRAWN instead of shown as source (lib/visuals-policy.js promises
    // this to every agent): ```svg (inline, sanitized), ```mermaid (diagram), ```chart (Chart.js
    // config as JSON) and ```html (a sealed sandboxed iframe). formatContent turns a closed fence into
    // a placeholder <div class="visual" data-kind=...> whose only child is the escaped source in a
    // <pre><code>; nothing in it is ever interpreted as HTML. renderVisualBlocks() then draws every
    // placeholder it finds (idempotent: data-rendered marks the ones done) once the library it needs
    // has been lazy-loaded from /vendor/. An unclosed fence (still streaming) is left as plain text,
    // so a block is only drawn once it is complete. Any failure keeps the source visible as a normal
    // code block and adds a one-line note; nothing throws out of the renderer.
    const VISUAL_KINDS = { svg: 'svg', mermaid: 'mermaid', chart: 'chart', html: 'html' };
    const VISUAL_PALETTE = ['#3987e5', '#d95926', '#199e70', '#8b6fd6', '#c9a227', '#d4588b'];
    const VISUAL_TEXT = '#c3c2b7';
    const VISUAL_GRID = 'rgba(255,255,255,.12)';
    const VISUAL_SURFACE = '#1a1a19';
    const VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:;";
    const VISUAL_SCRIPTS = { purify: '/vendor/purify.min.js', mermaid: '/vendor/mermaid.min.js', chart: '/vendor/chart.umd.min.js' };

    function visualKind(lang) { return VISUAL_KINDS[String(lang || '').toLowerCase()] || null; }
    // escapedSource is already HTML-escaped (& < >); reading the <pre> back through textContent restores it.
    function visualPlaceholder(kind, escapedSource) {
      return `<div class="visual visual-${kind}" data-kind="${kind}"><pre class="visual-src"><code>${escapedSource}</code></pre></div>`;
    }

    // Lazy script loader: one <script src> per file, shared promise; a failed load can be retried.
    const visualScriptLoads = new Map();
    function loadScriptOnce(src) {
      if (visualScriptLoads.has(src)) return visualScriptLoads.get(src);
      const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = true;
        s.onload = () => resolve();
        s.onerror = () => { visualScriptLoads.delete(src); s.remove(); reject(new Error(`could not load ${src}`)); };
        document.head.appendChild(s);
      });
      visualScriptLoads.set(src, p);
      return p;
    }

    // Rendered svg/mermaid markup by source: a streaming paint repaints the whole message many times
    // after a fence has closed, and a diagram must not be re-parsed on every delta.
    const visualCache = new Map();
    function visualCachePut(key, html) {
      if (visualCache.size >= 40) visualCache.delete(visualCache.keys().next().value);
      visualCache.set(key, html);
    }
    let visualSeq = 0;
    const visualCharts = new Set();   // live Chart.js instances; destroyed once their canvas is repainted away

    function visualFail(el, note) {
      if (!el || !el.isConnected) return;
      el.classList.add('visual-failed');
      el.classList.remove('rendered');
      el.querySelectorAll(':scope > .visual-body, :scope > .visual-bar, :scope > .visual-note').forEach(n => n.remove());
      const n = document.createElement('div');
      n.className = 'visual-note';
      n.textContent = note;
      el.insertBefore(n, el.firstChild);
    }
    function visualMount(el, kind, body, withExpand) {
      const bar = document.createElement('div');
      bar.className = 'visual-bar';
      bar.innerHTML = `<span class="visual-kind">${kind}</span>`
        + (withExpand ? '<button type="button" class="visual-btn" data-act="expand">expand</button>' : '')
        + '<button type="button" class="visual-btn" data-act="source">source</button>';
      el.insertBefore(body, el.firstChild);
      el.insertBefore(bar, el.firstChild);
      el.classList.add('rendered');
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest && e.target.closest('.visual-btn');
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      const v = b.closest('.visual');
      if (!v) return;
      if (b.dataset.act === 'expand') { const on = v.classList.toggle('expanded'); b.textContent = on ? 'shrink' : 'expand'; }
      else if (b.dataset.act === 'source') { const on = v.classList.toggle('show-source'); b.textContent = on ? 'hide source' : 'source'; }
    });

    // SVG: DOMPurify's svg profile, then a second pass of our own. Scripts, foreignObject, embeds,
    // on* handlers, javascript: and every external reference go; href/xlink:href may only be a
    // #fragment or a data:image URI, and CSS url() may only point at a #fragment.
    function sanitizeSvg(source) {
      const DP = window.DOMPurify;
      if (!DP || typeof DP.sanitize !== 'function') throw new Error('sanitizer unavailable');
      const clean = DP.sanitize(source, {
        USE_PROFILES: { svg: true, svgFilters: true },
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'object', 'embed', 'audio', 'video', 'style', 'animate', 'set', 'animateMotion', 'animateTransform'],   // SMIL could retarget an href at runtime
        FORBID_ATTR: ['style'],
        // No ALLOWED_URI_REGEXP here: DOMPurify applies it to EVERY attribute value (width, viewBox, x...),
        // which emptied sized drawings. The href rule is enforced by the second pass below.
      });
      const tpl = document.createElement('template');   // inert: nothing loads or runs while parsing
      tpl.innerHTML = clean;
      const svg = tpl.content.querySelector('svg');
      if (!svg) return '';
      // No CSS at all (a <style> or style attribute can overlay the page, and @import / url() reach out);
      // href / xlink:href / src may only be a #fragment or a data:image URI (no external reference, no
      // javascript:); presentation attributes stay, but url() in them may only point at a #fragment.
      const externalUrl = /url\(\s*['"]?\s*(?!#)|@import/i;
      for (const n of [svg, ...svg.querySelectorAll('*')]) {
        if (n.tagName.toLowerCase() === 'style') { n.remove(); continue; }
        for (const a of [...n.attributes]) {
          const name = a.name.toLowerCase();
          if (name.startsWith('on') || name === 'style') n.removeAttribute(a.name);
          else if ((name === 'href' || name === 'xlink:href' || name === 'src') && !/^\s*(#|data:image\/)/i.test(a.value)) n.removeAttribute(a.name);
          else if (/javascript:/i.test(a.value)) n.removeAttribute(a.name);
          else if (externalUrl.test(a.value)) n.removeAttribute(a.name);
        }
      }
      return svg.outerHTML;
    }
    async function renderSvgBlock(el, source) {
      const key = 'svg\n' + source;
      let html = visualCache.get(key);
      if (html === undefined) {
        await loadScriptOnce(VISUAL_SCRIPTS.purify);
        html = sanitizeSvg(source);
        visualCachePut(key, html);
      }
      if (!html) throw new Error('no <svg> element in the block');
      if (!el.isConnected) return;
      const body = document.createElement('div');
      body.className = 'visual-body';
      body.innerHTML = html;
      visualMount(el, 'svg', body, false);
    }

    // Mermaid: strict security level (its own sanitizer, no click handlers or html labels), dark theme.
    let mermaidReady = null;
    function mermaidInit() {
      if (!mermaidReady) {
        mermaidReady = loadScriptOnce(VISUAL_SCRIPTS.mermaid).then(() => {
          if (!window.mermaid) throw new Error('mermaid unavailable');
          window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', suppressErrorRendering: true });
        }).catch(e => { mermaidReady = null; throw e; });
      }
      return mermaidReady;
    }
    async function renderMermaidBlock(el, source) {
      const key = 'mermaid\n' + source;
      let html = visualCache.get(key);
      if (html === undefined) {
        await mermaidInit();
        const id = `mmd-${Date.now().toString(36)}-${++visualSeq}`;
        try {
          const out = await window.mermaid.render(id, source.trim());
          html = out && out.svg ? out.svg : '';
        } catch (e) {
          const stray = document.getElementById('d' + id);   // mermaid's scratch element, if it left one
          if (stray) stray.remove();
          const why = e && e.message ? String(e.message).split('\n')[0].slice(0, 140) : '';
          throw new Error('diagram did not parse' + (why ? `: ${why}` : ''));
        }
        if (!html) throw new Error('empty diagram');
        visualCachePut(key, html);
      }
      if (!el.isConnected) return;
      const body = document.createElement('div');
      body.className = 'visual-body';
      body.innerHTML = html;
      visualMount(el, 'mermaid', body, false);
    }

    // Chart.js: the block is a JSON config {type, data, options}. JSON.parse only: no functions, no
    // eval. Dark palette and layout defaults are filled in only where the config says nothing.
    let chartReady = null;
    function chartInit() {
      if (!chartReady) {
        chartReady = loadScriptOnce(VISUAL_SCRIPTS.chart).then(() => {
          const C = window.Chart;
          if (!C) throw new Error('Chart.js unavailable');
          C.defaults.color = VISUAL_TEXT;
          C.defaults.borderColor = VISUAL_GRID;
        }).catch(e => { chartReady = null; throw e; });
      }
      return chartReady;
    }
    function chartConfig(source) {
      let cfg;
      try { cfg = JSON.parse(source); } catch { throw new Error('config is not valid JSON'); }
      const obj = (v) => v && typeof v === 'object' && !Array.isArray(v);
      if (!obj(cfg)) throw new Error('config must be a JSON object');
      if (typeof cfg.type !== 'string' || !cfg.type) throw new Error('config needs a "type"');
      if (!obj(cfg.data) || !Array.isArray(cfg.data.datasets)) throw new Error('config needs data.datasets');
      const sliced = (t) => t === 'pie' || t === 'doughnut' || t === 'polarArea';
      const radial = sliced(cfg.type) || cfg.type === 'radar';
      cfg.data.datasets.forEach((ds, i) => {
        if (!obj(ds)) return;
        const type = typeof ds.type === 'string' ? ds.type : cfg.type;
        const c = VISUAL_PALETTE[i % VISUAL_PALETTE.length];
        if (sliced(type)) {
          if (ds.backgroundColor === undefined) ds.backgroundColor = (Array.isArray(ds.data) ? ds.data : []).map((_, j) => VISUAL_PALETTE[j % VISUAL_PALETTE.length]);
          if (ds.borderColor === undefined) ds.borderColor = VISUAL_SURFACE;
        } else {
          if (ds.borderColor === undefined) ds.borderColor = c;
          if (ds.backgroundColor === undefined) ds.backgroundColor = (type === 'line' || type === 'radar') ? c + '33' : c;
        }
      });
      const o = cfg.options = obj(cfg.options) ? cfg.options : {};
      o.responsive = true;
      o.maintainAspectRatio = false;
      o.plugins = obj(o.plugins) ? o.plugins : {};
      o.plugins.legend = obj(o.plugins.legend) ? o.plugins.legend : {};
      if (o.plugins.legend.display === undefined) o.plugins.legend.display = sliced(cfg.type) || cfg.data.datasets.length > 1;
      o.plugins.tooltip = obj(o.plugins.tooltip) ? o.plugins.tooltip : {};
      if (o.plugins.tooltip.enabled === undefined) o.plugins.tooltip.enabled = true;
      if (!radial) {
        o.scales = obj(o.scales) ? o.scales : {};
        for (const ax of ['x', 'y']) {
          const s = o.scales[ax] = obj(o.scales[ax]) ? o.scales[ax] : {};
          s.grid = obj(s.grid) ? s.grid : {};
          if (s.grid.color === undefined) s.grid.color = VISUAL_GRID;
          s.ticks = obj(s.ticks) ? s.ticks : {};
          if (s.ticks.color === undefined) s.ticks.color = VISUAL_TEXT;
        }
        const valueAxis = o.indexAxis === 'y' ? 'x' : 'y';
        if (cfg.type === 'bar' && o.scales[valueAxis].beginAtZero === undefined) o.scales[valueAxis].beginAtZero = true;
      }
      return cfg;
    }
    async function renderChartBlock(el, source) {
      const cfg = chartConfig(source);   // a bad config fails before any library loads
      await chartInit();
      if (!el.isConnected) return;
      const body = document.createElement('div');
      body.className = 'visual-body';
      const canvas = document.createElement('canvas');
      canvas.setAttribute('role', 'img');
      body.appendChild(canvas);
      visualMount(el, 'chart', body, false);
      try { visualCharts.add(new window.Chart(canvas, cfg)); }
      catch (e) { throw new Error('chart could not be built' + (e && e.message ? `: ${String(e.message).slice(0, 140)}` : '')); }
    }

    // HTML: a sealed frame. sandbox="allow-scripts" only (no same-origin, forms, popups or top
    // navigation), no referrer, and a CSP at the top of the document that allows nothing from the
    // network: inline script and style, data:/blob: images, data: fonts.
    function sealedHtmlDocument(source) {
      // The hub's own document: the CSP meta is the first thing in a <head> the hub wrote, so nothing in
      // the author's markup (a comment holding "<head>", its own <head>, a doctype) can come before it.
      // The author's content goes in the body; stray <html>/<head>/<body> tags in it are merged by the parser.
      return '<!DOCTYPE html><html><head><meta charset="utf-8">'
        + `<meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}">`
        + `<style>html{background:${VISUAL_SURFACE};color:#ffffff;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}body{margin:8px}</style>`
        + `</head><body>${String(source ?? '')}</body></html>`;
    }
    async function renderHtmlBlock(el, source) {
      if (!el.isConnected) return;
      const f = document.createElement('iframe');
      f.setAttribute('sandbox', 'allow-scripts');
      f.setAttribute('referrerpolicy', 'no-referrer');
      f.setAttribute('loading', 'lazy');
      f.setAttribute('title', 'html block');
      f.className = 'visual-frame';
      f.srcdoc = sealedHtmlDocument(source);
      const body = document.createElement('div');
      body.className = 'visual-body';
      body.appendChild(f);
      visualMount(el, 'html', body, true);
    }

    const VISUAL_RENDERERS = { svg: renderSvgBlock, mermaid: renderMermaidBlock, chart: renderChartBlock, html: renderHtmlBlock };
    // The shared post-render pass: call after any message HTML is inserted or updated. Safe to call
    // again on the same element (rendered placeholders are skipped) and never throws.
    function renderVisualBlocks(root) {
      const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
      for (const c of visualCharts) {
        if (!c.canvas || !c.canvas.isConnected) { try { c.destroy(); } catch {} visualCharts.delete(c); }
      }
      let list;
      try { list = scope.querySelectorAll('.visual[data-kind]:not([data-rendered])'); } catch { return; }
      list.forEach(el => {
        el.dataset.rendered = '1';
        const kind = el.dataset.kind;
        const run = VISUAL_RENDERERS[kind];
        const src = el.querySelector(':scope > .visual-src');
        if (!run || !src) return;
        const source = src.textContent;
        Promise.resolve().then(() => run(el, source)).catch(err => {
          visualFail(el, `${kind}: ${err && err.message ? err.message : 'could not render'}`);
        });
      });
    }
    // Safety net: any message painted by a path that forgot the explicit call still gets drawn.
    if (window.MutationObserver && document.body) {
      let visualPassPending = false;
      new MutationObserver(() => {
        if (visualPassPending) return;
        visualPassPending = true;
        requestAnimationFrame(() => { visualPassPending = false; renderVisualBlocks(document); });
      }).observe(document.body, { childList: true, subtree: true });
    }

    // Shared verbatim with lib/ui-safe-text.js and mobile.js (test/ui-escaping.test.js keeps the three in step).
    // ── safe-text helpers (begin) ──
    function escapeHtml(s) {
      return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function autolinkEscaped(text, attrs) {
      // Runs on text that is already HTML-escaped, so a quote can only appear as &quot; / &#39; and never raw.
      return String(text).replace(/(^|[^"=])(https?:\/\/[A-Za-z0-9\-._~:/?#\[\]@!$&'()*+,;=%]+)/g, (m, lead, url) => {
        const cut = url.search(/&quot;|&#39;|&lt;|&gt;/);
        const u = cut >= 0 ? url.slice(0, cut) : url;
        const rest = cut >= 0 ? url.slice(cut) : '';
        // Sentence punctuation after a URL is text, not part of it: trailing . , ; : ! ? and a ) or ] with no
        // opening partner inside the URL ("see https://x.y/a, then", "(https://x.y/a)"); a balanced (...) stays.
        // A bare trailing & arrives escaped as &amp; and goes as one unit. Bracket counts are taken once (linear time).
        let href = u;
        const n = { '(': 0, ')': 0, '[': 0, ']': 0 };
        for (const c of href) if (c in n) n[c]++;
        for (;;) {
          if (href.endsWith('&amp;')) { href = href.slice(0, -5); continue; }
          const last = href.slice(-1);
          const open = last === ')' ? '(' : last === ']' ? '[' : '';
          if (open && n[open] < n[last]) { n[last]--; href = href.slice(0, -1); }
          else if (/[.,;:!?]/.test(last)) href = href.slice(0, -1);
          else break;
        }
        if (!/^https?:\/\/[A-Za-z0-9]/.test(href)) return m;
        return `${lead}<a href="${href}" target="_blank" rel="noopener noreferrer"${attrs || ''}>${href}</a>${u.slice(href.length)}${rest}`;
      });
    }
    function safeLinkUrl(url) {
      const u = String(url ?? '').replace(/&amp;/g, '&').replace(/[\u0000- \u007f-\u009f\s]/g, '');
      if (!u) return null;
      if (/^https?:\/\//i.test(u) || /^mailto:/i.test(u)) return u;
      if (/^\/\//.test(u)) return null;                       // protocol-relative: another host
      if (/^[/#?]/.test(u)) return u;                         // same-origin path, fragment or query
      if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;          // relative path (no scheme at all)
      return null;                                            // javascript:, data:, vbscript:, file:, ...
    }
    function imageSrcKind(src, origin) {
      const s = String(src ?? '').replace(/[\u0000- \u007f-\u009f\s]/g, '');
      if (/^data:image\//i.test(s)) return { kind: 'data', url: s };
      if (/^blob:/i.test(s)) return { kind: 'blob', url: s };
      const u = safeLinkUrl(s);
      if (!u || /^mailto:/i.test(u)) return null;
      if (!/^https?:\/\//i.test(u)) return { kind: 'same', url: u };
      try { return { kind: new URL(u).origin === String(origin || '') ? 'same' : 'external', url: u }; } catch { return null; }
    }
    // ── safe-text helpers (end) ──

    // Shared verbatim with lib/ui-version-label.js and mobile.js (test/ui-version-label.test.js keeps the three in step).
    // ── version-label helpers (begin) ──
    function versionLabel(v) {
      if (!v || !v.version) return null;
      const sha = v.commit ? String(v.commit).slice(0, 12) : '';
      if (v.channel === 'stable') return { text: `v${v.version} · stable`, kind: 'stable', title: `My Maestro AI ${v.version}, stable channel` };
      if (v.channel === 'experimental') return { text: `v${v.version}-dev${sha ? ` · ${sha}` : ''}`, kind: 'experimental', title: `My Maestro AI ${v.version}, experimental channel (branch ${v.branch || 'dev'})${sha ? `, commit ${sha}` : ''}` };
      const where = v.branch || 'no branch';
      return { text: `v${v.version} · ${where}${sha ? ` · ${sha}` : ''}`, kind: 'other', title: `My Maestro AI ${v.version}, branch ${where}${sha ? `, commit ${sha}` : ''}` };
    }
    function updateStatusText(s) {
      if (!s || typeof s !== 'object') return null;
      if (s.enabled === false) return 'Check off';
      if (s.available) {
        if (s.latestVersion && s.latestVersion !== s.currentVersion) return `${s.latestVersion} available`;
        const n = Number(s.behind) || 0;
        return n > 0 ? `${n} new change${n === 1 ? '' : 's'} available` : 'Update available';
      }
      if (s.error) return `Check failed: ${s.error}`;
      if (s.checking) return 'Checking…';
      return s.checkedAt ? 'Up to date' : 'Not checked yet';
    }
    function versionDetailsText(v, u, ua) {
      v = v || {};
      const when = (t) => { const d = new Date(t); return t && !isNaN(d) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown'; };
      const channel = v.channel ? `${v.channel}${v.branch ? ` (branch ${v.branch})` : ''}` : (v.branch ? `branch ${v.branch}` : 'unknown');
      const lines = [
        `My Maestro AI ${v.version || 'unknown'}`,
        `Channel: ${channel}`,
        `Commit: ${v.commit || 'unknown'}${v.commitDate ? ` (${v.commitDate})` : ''}`,
        `Hub started: ${when(v.startedAt)}`,
        `Node.js: ${v.node || 'unknown'}`,
        `Restart pending: ${v.restartPending == null ? 'unknown' : v.restartPending ? 'yes (code on disk is newer than the running hub)' : 'no'}`,
      ];
      const up = updateStatusText(u);
      if (up) lines.push(`Update: ${up}`);
      if (ua) lines.push(`Browser: ${ua}`);
      return lines.join('\n');
    }
    // ── version-label helpers (end) ──

    // Shared verbatim with lib/ui-dialog.js and mobile.js (test/ui-dialog.test.js keeps the three in step).
    // ── dialog helpers (begin) ──
    const DIALOG_TEXT = {
      discardTitle: 'Discard changes?',
      discardBody: "You changed something here that isn't saved. If you close it now, those changes are lost.",
      discard: 'Discard',
      keepEditing: 'Keep editing',
      close: 'Close',
      closeAria: 'Close dialog',
      saving: 'Still saving. Wait until it is done, then close.',
    };
    const DIALOG_SKIP_TYPES = ['button', 'submit', 'reset', 'image', 'hidden', 'search'];
    const DIALOG_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

    /** Is this element a field whose value counts as an edit? */
    function dialogField(el) {
      if (!el || !el.tagName) return false;
      const tag = String(el.tagName).toUpperCase();
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return false;
      if (tag === 'INPUT' && DIALOG_SKIP_TYPES.includes(String(el.type || 'text').toLowerCase())) return false;
      if (el.closest && el.closest('[data-no-dirty]')) return false;
      return true;
    }
    /** The value a field shows, as one comparable string. */
    function dialogFieldValue(el) {
      const type = String(el.type || '').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return el.checked ? '1' : '0';
      if (el.multiple && el.options) return Array.from(el.options).filter(o => o.selected).map(o => o.value).join('\u0001');
      return String(el.value == null ? '' : el.value);
    }
    /** Changed: a field still on the page differs from its baseline. */
    function dialogIsDirty(baselines) {
      for (const [el, v] of baselines) if (el.isConnected !== false && dialogFieldValue(el) !== v) return true;
      return false;
    }
    /** An Escape the dialog layer must leave alone: text being composed, already handled by an inner widget, or meant for
     *  an open dropdown / combobox / date picker (aria-expanded). */
    function dialogEscapeIgnored(e) {
      if (!e) return true;
      if (e.isComposing || e.keyCode === 229) return true;
      if (e.defaultPrevented) return true;
      const t = e.target;
      return !!(t && t.getAttribute && t.getAttribute('aria-expanded') === 'true');
    }
    /** A <dialog> opened with showModal(); one opened with show() sits beside the page, which stays usable. */
    function dialogIsModal(el) {
      try { return el.matches(':modal'); } catch { return true; }   // no :modal support: treat it as covering the page
    }

    function createDialogGuard({ doc = document, win = window, auto = '', useHistory = false, trackSaves = true, pageDirty = false } = {}) {
      const layers = [];   // innermost last
      let confirmOpen = null, confirmFinish = null, seq = 0, lastAct = { t: 0, el: null }, escIgnoredAt = 0, popping = false, histId = 0, histSeq = 0, lastOutside = null;
      const page = pageDirty ? { el: doc.body, page: true, baselines: new Map() } : null;
      const now = () => Date.now();

      function layerOf(el) {
        if (!el) return null;
        for (let i = layers.length - 1; i >= 0; i--) if (layers[i].el === el || (layers[i].el.contains && layers[i].el.contains(el))) return layers[i];
        return null;
      }
      const top = () => layers[layers.length - 1] || null;
      // Layers that cover the page: all but a <dialog> opened with show() (the phone's approvals panel), which leaves the
      // page and its tabs usable, so Back stays the page's while only such a panel is open.
      const covering = () => layers.filter(l => !(l.isDialog && l.el.open && !dialogIsModal(l.el)));
      const scopeOf = (el) => layerOf(el) || (page && el && page.el.contains && page.el.contains(el) ? page : null);

      // Baselines: the first time a field is focused, pressed or typed in. A radio notes its whole group (keyboard arrows
      // move the choice without focusing the old one); a label notes the field it controls.
      function note(target) {
        let el = target;
        if (el && el.tagName && String(el.tagName).toUpperCase() === 'LABEL' && el.control) el = el.control;
        if (!dialogField(el)) return;
        const s = scopeOf(el);
        if (!s) return;
        const group = String(el.type || '').toLowerCase() === 'radio' && el.name && s.el.querySelectorAll
          ? Array.from(s.el.querySelectorAll('input[type="radio"]')).filter(r => r.name === el.name) : [el];
        for (const f of group) if (!s.baselines.has(f)) s.baselines.set(f, dialogFieldValue(f));
      }
      // A change on a field never noted (changed by a path the listeners above missed): its old value is unknown, so it
      // counts as changed rather than as unchanged.
      function noteChange(e) {
        const el = e.target;
        if (!dialogField(el)) return;
        const s = scopeOf(el);
        if (s && !s.baselines.has(el)) s.baselines.set(el, '\u0000unknown');
      }
      function dirty(l) { return !!l && !l.persistent && dialogIsDirty(l.baselines); }

      function focusables(el) {
        if (!el.querySelectorAll) return [];
        return Array.from(el.querySelectorAll(DIALOG_FOCUSABLE)).filter(n => !n.hidden && !(n.closest && n.closest('[hidden]')) && (!n.getClientRects || n.getClientRects().length > 0));
      }

      function register(el, opts = {}) {
        if (!el) return null;
        const had = layers.find(l => l.el === el);
        if (had) return had;
        const isDialog = String(el.tagName || '').toUpperCase() === 'DIALOG';
        const l = {
          id: ++seq, el, isDialog, baselines: new Map(), saving: 0,
          modal: opts.modal !== undefined ? !!opts.modal : !(el.classList && el.classList.contains('gs-dock')),
          persistent: !!(el.dataset && el.dataset.dialogPersistent),
          close: opts.close || null,
          // What opened it: the focused element, unless the dialog already took the focus; then the last one outside.
          opener: (() => { const a = doc.activeElement; return a && a !== doc.body && !(el.contains && el.contains(a)) ? a : lastOutside; })(),
        };
        layers.push(l);
        if (isDialog && el.addEventListener && !el.__dialogCancel) {
          el.__dialogCancel = (e) => {
            e.preventDefault();   // the guard decides, never the browser
            if (now() - escIgnoredAt < 200) return;
            const lay = layers.find(x => x.el === el);
            if (lay) requestClose(lay, 'cancel');
          };
          el.addEventListener('cancel', el.__dialogCancel);
        }
        if (l.modal && !isDialog) Promise.resolve().then(() => {
          if (!l.el.isConnected || layers.indexOf(l) < 0) return;
          const a = doc.activeElement;
          if (a && l.el.contains(a)) return;
          const box = (l.el.firstElementChild && l.el.firstElementChild.focus) ? l.el.firstElementChild : l.el;
          if (box.setAttribute && !box.hasAttribute('tabindex')) box.setAttribute('tabindex', '-1');
          try { box.focus({ preventScroll: true }); } catch {}
        });
        syncHistory();
        return l;
      }

      function unregister(el) {
        const i = layers.findIndex(l => l.el === el);
        if (i < 0) return;
        const [l] = layers.splice(i, 1);
        syncHistory();
        const a = doc.activeElement;
        if (l.opener && l.opener.isConnected !== false && (!a || a === doc.body || a.isConnected === false || (l.el.contains && l.el.contains(a)))) {
          try { l.opener.focus({ preventScroll: true }); } catch {}
        }
      }

      function closeNow(l) {
        if (l.el.__dialogClose) l.el.__dialogClose();
        else if (l.close) l.close();
        else if (l.isDialog) { if (l.el.open) l.el.close(); }
        else if (l.el.remove) l.el.remove();
        unregister(l.el);
      }

      function flashSaving(l) {
        const host = l.el.querySelector && (l.el.querySelector('dialog, .question-modal, .gs-modal, .st-modal') || l.el);
        if (!host || !host.appendChild) return;
        let n = host.querySelector('.dlg-saving');
        if (!n) { n = doc.createElement('div'); n.className = 'dlg-saving'; n.setAttribute('role', 'status'); host.appendChild(n); }
        n.textContent = DIALOG_TEXT.saving;
        clearTimeout(n.__t); n.__t = setTimeout(() => n.remove && n.remove(), 2500);
      }

      /** The one way out. how: 'escape' | 'close' | 'backdrop' | 'back' | 'cancel'. Returns what happened. */
      function requestClose(l, how = 'close') {
        if (!l) return 'none';
        if (confirmOpen) return 'confirm';
        if (l.persistent && how !== 'close') return 'kept';
        if (l.saving > 0) { flashSaving(l); return 'busy'; }
        if (dirty(l)) { askDiscard(l); return 'confirm'; }
        closeNow(l);
        return 'closed';
      }

      function askDiscard(l) {
        const d = doc.createElement('dialog');
        d.className = 'dlg-discard';
        d.setAttribute('role', 'alertdialog');
        d.setAttribute('aria-labelledby', 'dlg-discard-title');
        d.setAttribute('aria-describedby', 'dlg-discard-body');
        d.innerHTML = '<h3 id="dlg-discard-title"></h3><p id="dlg-discard-body"></p><div class="dlg-discard-btns"><button type="button" class="dlg-discard-go"></button><button type="button" class="dlg-discard-keep"></button></div>';
        d.querySelector('#dlg-discard-title').textContent = DIALOG_TEXT.discardTitle;
        d.querySelector('#dlg-discard-body').textContent = DIALOG_TEXT.discardBody;
        const go = d.querySelector('.dlg-discard-go'), keep = d.querySelector('.dlg-discard-keep');
        go.textContent = DIALOG_TEXT.discard;
        keep.textContent = DIALOG_TEXT.keepEditing;
        const back = doc.activeElement;
        const finish = (discard) => {
          if (confirmOpen !== d) return;
          confirmOpen = null; confirmFinish = null;
          try { d.close(); } catch {}
          if (d.remove) d.remove();
          if (discard) { l.baselines.clear(); closeNow(l); }
          else {
            syncHistory();   // Back took the entry while the question was up: it comes back
            try { (back && back.isConnected !== false ? back : l.el).focus({ preventScroll: true }); } catch {}
          }
        };
        go.addEventListener('click', () => finish(true));
        keep.addEventListener('click', () => finish(false));
        d.addEventListener('cancel', (e) => { e.preventDefault(); finish(false); });   // Escape on the question = keep editing
        d.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(false); }   // Enter never discards
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
        });
        confirmOpen = d; confirmFinish = finish;
        doc.body.appendChild(d);
        if (d.showModal) d.showModal();
        keep.focus();
        return d;
      }

      // ── Keys: Escape for the innermost layer, Tab kept inside a modal one ──
      function onKeydown(e) {
        if (e.key === 'Escape' || e.key === 'Esc') {
          if (confirmOpen) return;   // the question handles its own keys
          if (dialogEscapeIgnored(e)) { escIgnoredAt = now(); return; }
          const l = top();
          if (!l) return;
          if (!l.modal && !(l.el.contains && l.el.contains(e.target))) return;   // a docked panel answers only from inside
          e.preventDefault();
          requestClose(l, 'escape');
          return;
        }
        if (e.key === 'Tab') {
          if (confirmOpen) return;
          const l = top();
          if (!l || !l.modal || l.isDialog) return;   // native modal dialogs keep the focus themselves
          const f = focusables(l.el);
          if (!f.length) { e.preventDefault(); return; }
          const first = f[0], last = f[f.length - 1], a = doc.activeElement;
          // Focus on something that is not one of the controls (the dialog box itself, a scroll area, or outside):
          // Tab goes to the first control, Shift+Tab to the last, never out of the dialog.
          if (!l.el.contains(a) || f.indexOf(a) < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
          else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
        }
      }

      // ── The phone's Back gesture: while any layer covers the page, the guard keeps ONE history entry on top of the
      // page's own. Back takes that entry: the innermost covering layer is asked to close, and the entry comes back while
      // one is still open (a layer under it, the question, a save running, an answer needed), so the next Back comes here
      // again. Closing the last one any other way removes the entry, so the next Back reaches the page's router; a layer
      // that closes under another one leaves no entry behind. ──
      function syncHistory() {
        if (!useHistory || popping) return;   // our own back() is on its way: its popstate syncs again
        const open = covering().length;
        if (open && !histId) {
          const id = ++histSeq;
          try { win.history.pushState({ ...(win.history.state || {}), dialog: id }, ''); histId = id; } catch {}
        } else if (!open && histId) {
          const id = histId;
          histId = 0;
          const st = win.history.state;
          if (!st || st.dialog !== id) return;   // the page moved history on since: its entries are left alone
          popping = true;
          try { win.history.back(); } catch { popping = false; }
        }
      }
      function onPopstate(e) {
        if (popping) {   // our own back() after the last layer closed
          popping = false;
          e.stopImmediatePropagation();
          syncHistory();   // a layer that opened meanwhile gets its entry now
          return;
        }
        if (!histId || (e.state || {}).dialog === histId) return;
        e.stopImmediatePropagation();   // the page's own router must not move while a layer is open
        histId = 0;
        if (confirmOpen) confirmFinish(false);   // Back on "Discard changes?" = Keep editing
        else requestClose(covering().pop(), 'back');
        syncHistory();
      }

      // ── Saves in flight: a POST/PUT/PATCH/DELETE to the hub's /api/ that follows a click or key in a layer keeps that
      // layer open until the hub answers (the response headers; the page reads the answer and commits right after). It
      // settles nothing by itself (a Test button posts too): see savePoint. ──
      function wrapFetch() {
        const orig = win.fetch && win.fetch.bind(win);
        if (!orig || win.fetch.__dialogGuard) return;
        const wrapped = function (input, init) {
          const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          let l = null;
          if (method !== 'GET' && method !== 'HEAD' && now() - lastAct.t < 1500) {
            let url = ''; try { url = new URL(typeof input === 'string' ? input : input.url, win.location.href).pathname; } catch {}
            if (url.startsWith('/api/')) l = scopeOf(lastAct.el);
          }
          if (!l) return orig(input, init);
          l.saving = (l.saving || 0) + 1;
          return Promise.resolve(orig(input, init)).finally(() => { l.saving--; });
        };
        wrapped.__dialogGuard = true;
        win.fetch = wrapped;
      }
      /** savePoint(fields): the fields a save writes (an element, a container of them, or a list), with the values they
       *  have now, as the save starts. The returned commit(), called once the hub confirmed the save, makes exactly those
       *  values the fields' baselines: an edit made while the save ran stays changed, and nothing else is touched. */
      function savePoint(scope) {
        const list = [];
        const add = (el) => {
          if (!el) return;
          if (dialogField(el)) list.push(el);
          else if (el.querySelectorAll) for (const f of el.querySelectorAll('input, textarea, select')) if (dialogField(f)) list.push(f);
        };
        if (Array.isArray(scope) || (scope && typeof scope.length === 'number' && !scope.tagName)) for (const el of scope) add(el); else add(scope);
        const snap = list.map(el => [el, dialogFieldValue(el)]);
        return function commit() {
          for (const [el, v] of snap) { if (el.isConnected === false) continue; const s = scopeOf(el); if (s) s.baselines.set(el, v); }
        };
      }

      // ── Wiring ──
      const act = (e) => { lastAct = { t: now(), el: e.target }; note(e.target); };
      doc.addEventListener('keydown', onKeydown);
      doc.addEventListener('focusin', (e) => { if (!layerOf(e.target) && e.target !== confirmOpen) lastOutside = e.target; note(e.target); }, true);
      doc.addEventListener('pointerdown', act, true);
      doc.addEventListener('keydown', act, true);
      doc.addEventListener('change', (e) => { noteChange(e); lastAct = { t: now(), el: e.target }; }, true);
      doc.addEventListener('input', noteChange, true);
      // A click on an overlay's own backdrop (not on its box) is a way out too.
      doc.addEventListener('click', (e) => {
        const l = top();
        if (!l || !l.modal || e.target !== l.el || confirmOpen) return;
        if (l.isDialog) {
          const r = l.el.getBoundingClientRect && l.el.getBoundingClientRect();
          if (!r || (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom)) return;
        }
        if (l.el.dataset && l.el.dataset.dialogNoBackdrop) return;
        e.stopImmediatePropagation();
        requestClose(l, 'backdrop');
      }, true);
      if (useHistory && win.addEventListener) win.addEventListener('popstate', onPopstate);
      // Unsaved changes anywhere: an open layer, or the editing page itself. The pages' own reloads wait while this is true.
      const hasChanges = () => layers.some(dirty) || (!!page && dialogIsDirty(page.baselines));
      if (win.addEventListener) win.addEventListener('beforeunload', (e) => {
        if (hasChanges()) { e.preventDefault(); e.returnValue = ''; return ''; }
      });
      if (trackSaves) wrapFetch();
      if (typeof MutationObserver !== 'undefined' && doc.body) {
        const consider = (n) => {
          if (!n || n.nodeType !== 1) return;
          if (auto && n.matches && n.matches(auto)) register(n);
          if (String(n.tagName).toUpperCase() === 'DIALOG' && n.open && n !== confirmOpen) register(n);
        };
        new MutationObserver((recs) => {
          for (const r of recs) {
            if (r.type === 'attributes') {
              const n = r.target;
              if (n === confirmOpen || String(n.tagName).toUpperCase() !== 'DIALOG') continue;
              if (n.open) register(n); else unregister(n);
              continue;
            }
            for (const n of r.removedNodes) if (n.nodeType === 1) for (const l of layers.slice()) if (l.el === n || (n.contains && n.contains(l.el))) unregister(l.el);
            for (const n of r.addedNodes) consider(n);
          }
        }).observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
        if (auto && doc.querySelectorAll) for (const n of doc.querySelectorAll(auto)) register(n);
      }
      if (!doc.getElementById('dlg-style') && doc.head) {
        const s = doc.createElement('style');
        s.id = 'dlg-style';
        s.textContent = '.dlg-discard{margin:auto;max-width:min(92vw,380px);padding:20px;border:1px solid var(--border-strong,#333846);border-radius:12px;background:var(--bg-card,#14171F);color:var(--text,#F3F4F6);font:inherit}'
          + '.dlg-discard::backdrop{background:rgba(0,0,0,.55)}.dlg-discard h3{margin:0 0 8px;font-size:1.05rem}.dlg-discard p{margin:0 0 16px;color:var(--text-dim,#9CA3AF);line-height:1.4}'
          + '.dlg-discard-btns{display:flex;gap:8px;justify-content:flex-end}.dlg-discard-btns button{min-height:36px;padding:0 16px;border-radius:8px;border:1px solid var(--border-strong,#333846);background:var(--bg-input,#040507);color:var(--text,#F3F4F6);font:inherit;cursor:pointer}'
          + '.dlg-discard-btns .dlg-discard-go{color:var(--error,#FF4C4C)}.dlg-discard-btns .dlg-discard-keep{background:var(--accent,#3D7BFF);border-color:var(--accent,#3D7BFF);color:#fff}'
          + '.dlg-discard-btns button:focus-visible{outline:2px solid var(--accent-hover,#5A93FF);outline-offset:2px}'
          + '.dlg-saving{margin-top:10px;font-size:.8rem;color:var(--warning,#F5A623)}';
        doc.head.appendChild(s);
      }

      return {
        open: (el, opts) => register(el, opts),
        closed: (el) => unregister(el),
        requestClose: (elOrChild, how) => requestClose(layerOf(elOrChild), how),
        isDirty: (elOrChild) => dirty(layerOf(elOrChild)) || (!layerOf(elOrChild) && !!page && dialogIsDirty(page.baselines)),
        hasChanges,
        savePoint,
        markLoaded: (els) => { for (const el of (Array.isArray(els) ? els : [els])) { const l = el && scopeOf(el); if (l) l.baselines.delete(el); } },   // put in by the page, not typed
        layers: () => layers.slice(),
        _confirm: () => confirmOpen,
      };
    }
    // ── dialog helpers (end) ──

    // One way out of every dialog on this page: Escape, Close / Cancel / ✕, a click on the backdrop (lib/ui-dialog.js).
    // The overlays below are found when they appear; the image viewer registers itself. A dialog's own buttons that
    // dismiss it call dialogRequestClose(this); a successful Save or Create still removes it directly.
    const dialogGuard = createDialogGuard({ auto: '.question-overlay, .gs-overlay, .st-overlay, .dream-overlay, #restart-notify-overlay, #resume-popup-overlay' });
    function dialogRequestClose(el, how) { return dialogGuard.requestClose(el, how || 'close'); }

    // ── Version label and About box (GET /api/version, lib/hub-map versionInfo). The dim line under the title shows the
    // version and channel (experimental and other branches in their own colour, plus a dot while a restart is pending);
    // clicking it, or "About My Maestro AI" in the ⋯ menu, opens the About box. ──
    let hubVersion = null;
    async function paintVersionLabel() {
      const el = document.getElementById('hub-version');
      let v;
      try { const r = await fetch('/api/version', { credentials: 'include' }); if (!r.ok) return hubVersion; v = await r.json(); } catch { return hubVersion; }
      hubVersion = v;
      const l = versionLabel(v);
      if (!el) return v;
      if (!l) { el.hidden = true; return v; }
      el.className = `hub-version ${l.kind}`;
      el.innerHTML = `<span class="hv-text">${escapeHtml(l.text)}</span>${v.restartPending ? '<span class="hv-dot" title="Restart pending: code on disk is newer than the running hub"></span>' : ''}`;
      el.title = v.restartPending ? 'Restart pending: code on disk is newer than the running hub. Click for details.' : `${l.title}. Click for details.`;
      el.setAttribute('aria-label', `${l.text}${v.restartPending ? ', restart pending' : ''}: about this hub`);
      el.hidden = false;
      return v;
    }
    // The update line is for admins (the update check is an admin route); a hub with no accounts is its owner's alone.
    async function aboutUpdateStatus() {
      if (window.hubMe && !window.hubMe.isAdmin) return null;
      try { const r = await fetch('/api/update-check', { credentials: 'include' }); if (!r.ok) return null; ucLast = await r.json(); return ucLast; } catch { return null; }
    }
    async function openAboutDialog() {
      const earlier = document.getElementById('about-overlay');
      const opener = earlier ? earlier._opener : document.activeElement;   // where focus goes back on close
      earlier?.remove();
      const overlay = document.createElement('div');
      overlay.className = 'question-overlay';
      overlay.id = 'about-overlay';
      overlay._opener = opener;
      const close = () => {
        overlay.remove();
        const back = opener && opener.isConnected && opener.offsetParent !== null ? opener : document.getElementById('more-btn');   // the ⋯ menu has closed
        if (back && typeof back.focus === 'function') { try { back.focus({ preventScroll: true }); } catch {} }
      };
      overlay.__dialogClose = close;   // Esc, Tab kept inside, the backdrop: dialogGuard
      overlay.innerHTML = `
        <div class="question-modal about-modal" role="dialog" aria-modal="true" aria-labelledby="about-title">
          <h3 id="about-title">About My Maestro AI</h3>
          <div id="about-body" class="about-body">Loading…</div>
          <div class="about-actions"><button class="sec-btn" id="about-copy" disabled>Copy details</button><button class="sec-btn" id="about-close">Close</button></div>
        </div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('#about-close').onclick = () => dialogRequestClose(overlay);
      overlay.querySelector('#about-close').focus();
      const [v, u] = await Promise.all([paintVersionLabel(), aboutUpdateStatus()]);
      if (!overlay.isConnected) return;   // closed, or opened again, meanwhile
      const body = overlay.querySelector('#about-body');
      if (!v) { body.textContent = 'Could not read the version from the hub.'; return; }
      const l = versionLabel(v) || { kind: 'other' };
      const started = v.startedAt ? new Date(v.startedAt) : null;
      const row = (k, val) => `<div class="about-k">${k}</div><div class="about-v">${val}</div>`;
      const up = updateStatusText(u);
      const upBtn = u && u.available ? (u.blocked
        ? '<button class="sec-btn" id="about-update" data-act="details">Details…</button>'
        : '<button class="sec-btn about-primary" id="about-update" data-act="card">Update…</button>') : '';
      body.innerHTML = `<div class="about-grid">
        ${row('Version', `${escapeHtml(v.version || 'unknown')} <span class="hub-version ${l.kind} about-chip">${escapeHtml(v.channel || v.branch || 'no branch')}</span>`)}
        ${row('Branch', escapeHtml(v.branch || '—'))}
        ${row('Commit', `<code>${escapeHtml(v.commit || '—')}</code>${v.commitDate ? ` · ${escapeHtml(v.commitDate)}` : ''}`)}
        ${row('Hub started', started && !isNaN(started) ? escapeHtml(started.toLocaleString()) : '—')}
        ${v.restartPending ? row('Restart', '<span class="about-warn"><span class="hv-dot"></span>Restart pending: code on disk is newer than the running hub</span>') : ''}
        ${row('Node.js', escapeHtml(v.node || '—'))}
        ${up ? row('Updates', `${escapeHtml(up)}${upBtn ? ` ${upBtn}` : ''}`) : ''}
      </div>`;
      const ub = overlay.querySelector('#about-update');
      if (ub) ub.onclick = () => { close(); if (ub.dataset.act === 'card') showUpdateCard(); else openGitSync(); };
      const copy = overlay.querySelector('#about-copy');
      copy.disabled = false;
      copy.onclick = () => filesCopy(versionDetailsText(v, u, navigator.userAgent), copy);
    }

    // A markdown image: same-origin, data: and blob: sources are shown inline; any other host is shown as a
    // link with the alt text and the host, never fetched (an off-site image is a zero-click beacon that can
    // carry whatever is in the agent's context in its URL). An unsafe source is blocked outright.
    function imageHtml(src, alt, inlineStyle) {
      const eAlt = escapeHtml(alt || '');
      const im = imageSrcKind(src, location.origin);
      if (!im) return `<div class="image-gallery"><code>[blocked image: ${eAlt}]</code></div>`;
      if (im.kind === 'external') {
        let host = ''; try { host = new URL(im.url).host; } catch {}
        return `<div class="image-gallery"><a href="${escapeHtml(im.url)}" target="_blank" rel="noopener noreferrer" class="external-image" title="Image on another site; opens in a new tab">🖼 ${eAlt || 'image'} <span class="external-host">(${escapeHtml(host)})</span></a></div>`;
      }
      return `<div class="image-gallery"><img src="${escapeHtml(im.url)}" class="generated-image" alt="${eAlt}"${inlineStyle ? ` style="${inlineStyle}"` : ''}></div>`;
    }
    // Attached / generated image lists (server-provided URLs): escaped, no inline handler; the click is delegated.
    function imageGalleryHtml(images, inlineStyle) {
      if (!images || !images.length) return '';
      return '<div class="image-gallery">' + images.map(u => `<img src="${escapeHtml(u)}" class="generated-image" alt="Generated image"${inlineStyle ? ` style="${inlineStyle}"` : ''}>`).join('') + '</div>';
    }

    function formatContent(content) {
      if (!content) return '<span style="opacity:0.5">...</span>';

      // Parse thinking — render inline as collapsible purple block
      const { thinking, response, stillThinking } = parseThinking(content);

      if (!response && !thinking) return '<span style="opacity:0.5">...</span>';

      // Build inline thinking block if present
      let thinkingHtml = '';
      if (thinking) {
        const escapedThinking = thinking
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        const activeClass = stillThinking ? ' still-thinking' : '';
        const label = stillThinking ? 'Thinking...' : 'Thought process';
        thinkingHtml = `<div class="inline-thinking${activeClass}">` +
          `<div class="thinking-header" onclick="this.parentElement.classList.toggle('collapsed')">` +
          `<span class="arrow">▾</span> ${label}</div>` +
          `<div class="thinking-body">${escapedThinking}</div></div>`;
      }

      if (!response) return thinkingHtml || '<span style="opacity:0.5">...</span>';

      // Closed ```svg / ```mermaid / ```chart / ```html fences become visual placeholders (drawn by
      // renderVisualBlocks). They are held out first, before the image/link/table passes and the
      // inline formatting, so their source reaches the renderer byte for byte (escaped here, inside
      // <pre><code>; never parsed as markup). Other fences take the usual code-block path below.
      // R3: per-render, unguessable markers. Model or user text cannot predict one, so a marker for one
      // kind (say a table) cannot be smuggled inside another kind's content (say image alt text) and then
      // get substituted when that kind is re-inserted. The ~ terminates the index so one marker is never a
      // prefix of another (V1~ vs V11~). Markers are plain [a-z0-9~], so escaping and inline formatting
      // leave them untouched.
      const MARK = 'm' + ((window.crypto && crypto.getRandomValues) ? Array.from(crypto.getRandomValues(new Uint8Array(16)), b => (b % 36).toString(36)).join('') : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
      const mk = (kind, i) => `${MARK}${kind}${i}~`;
      const visualTokens = [];
      const withVisualPlaceholders = response.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
        const kind = visualKind(lang);
        if (!kind) return match;
        visualTokens.push(visualPlaceholder(kind, code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
        return mk('V', visualTokens.length - 1);
      });

      // Extract markdown links BEFORE HTML-escaping (URLs contain special chars)
      const linkTokens = [];
      // First extract images (![alt](src)) so they don't match as links
      // Extract markdown images BEFORE HTML-escaping (they contain paths with / etc.)
      const imageTokens = [];
      const withImagePlaceholders = withVisualPlaceholders.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
        const idx = imageTokens.length;
        // Convert absolute file paths to /api/image/ URLs
        let imgSrc = src;
        if (src.startsWith('/') && !src.startsWith('/api/')) {
          imgSrc = '/api/image/' + btoa(src);
        }
        imageTokens.push({ alt, src: imgSrc });
        return mk('I', idx);
      });

      // Extract markdown links [text](url) BEFORE HTML-escaping
      const withLinkPlaceholders = withImagePlaceholders.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, text, url) => {
        const idx = linkTokens.length;
        linkTokens.push({ text, url });
        return mk('L', idx);
      });

      // Extract tables before HTML-escaping
      const tableTokens = [];
      const withTablePlaceholders = withLinkPlaceholders.replace(/(^|\n)(\|[^\n]+\|\s*\n\|(?:\s*:?-+:?\s*\|)+\s*\n(?:\|[^\n]+\|\s*\n?)+)/g, (match, p1, p2) => {
        const idx = tableTokens.length;
        const lines = p2.trim().split('\n');
        const header = lines[0].trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
        const rows = lines.slice(2).map(line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|'));
        
        const fmtCell = (c) => c.trim()
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
          .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
          .replace(/\*([^*]+)\*/g, '<em>$1</em>')
          .replace(/`([^`]+)`/g, '<code>$1</code>');
        let tableHtml = '<table><thead><tr>';
        header.forEach(h => tableHtml += `<th>${fmtCell(h)}</th>`);
        tableHtml += '</tr></thead><tbody>';
        rows.forEach(row => {
          tableHtml += '<tr>';
          row.forEach(cell => tableHtml += `<td>${fmtCell(cell)}</td>`);
          tableHtml += '</tr>';
        });
        tableHtml += '</tbody></table>';
        tableTokens.push(tableHtml);
        return p1 + mk('T', idx);
      });

      let formatted = escapeHtml(withTablePlaceholders)   // all five characters: the autolinker relies on quotes being entities, never raw
        .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>')
        // A whole line in underscores is italic: the hub's one-line notices (plan, auto model, sandbox...).
        // snake_case inside a sentence is never a whole line, and the markers above carry no underscores,
        // so neither matches.
        .replace(/(^|\n)_(?=[^\s_])([^\n]*?[^\s_])_(?=\n|$)/g, '$1<em>$2</em>');
      // Bare URLs: strict charset, cut before any quote or angle bracket (the text is already escaped).
      formatted = autolinkEscaped(formatted, ' style="color: #6ea8fe; text-decoration: underline;"')
        .replace(/\n/g, '<br>');

      for (let i = 0; i < visualTokens.length; i++) {
        formatted = formatted.replace(mk('V', i), () => visualTokens[i]);
      }

      // Re-insert extracted images: inline when same-origin / data: / blob:, a link for any other host.
      for (let i = 0; i < imageTokens.length; i++) {
        const { alt, src } = imageTokens[i];
        const imgTag = imageHtml(src, alt, 'max-height:300px;');
        formatted = formatted.replace(mk('I', i), () => imgTag);
      }

      // Re-insert extracted links: only http(s), mailto and same-origin paths; everything escaped.
      for (let i = 0; i < linkTokens.length; i++) {
        const { text, url } = linkTokens[i];
        const u = safeLinkUrl(url);
        const eText = escapeHtml(text);
        const linkTag = u
          ? `<a href="${escapeHtml(u)}" target="_blank" rel="noopener noreferrer" style="color: #6ea8fe; text-decoration: underline;">${eText}</a>`
          : `<code>[blocked link: ${eText}]</code>`;
        formatted = formatted.replace(mk('L', i), () => linkTag);
      }

      // Re-insert extracted tables (function replacer so $-sequences in the HTML are literal).
      for (let i = 0; i < tableTokens.length; i++) {
        formatted = formatted.replace(mk('T', i), () => tableTokens[i]);
      }

      return thinkingHtml + formatted;
    }
    
    // ==================== ORCHESTRATION ====================
    
    let orchWorkers = [];
    
    function populateOrchestrationDropdowns() {
      const coordSelect = document.getElementById('orch-coordinator');
      const workerSelect = document.getElementById('orch-worker-select');
      if (!coordSelect || !workerSelect) return; // Elements removed in merged UI
      
      // Clear existing options (keep first placeholder)
      coordSelect.innerHTML = '<option value="">Select coordinator...</option>';
      workerSelect.innerHTML = '<option value="">Add worker...</option>';
      
      // Flat alphabetical list of all agents
      const sorted = [...AGENTS].sort((a, b) => {
        const da = (a.display || a.name).toLowerCase();
        const db = (b.display || b.name).toLowerCase();
        return da.localeCompare(db);
      });

      // Populate both dropdowns with the same sorted list
      for (const a of sorted) {
        const displayName = a.display || capName(a.name);
        const shortModel = a.model.split('/').pop().substring(0, 20);

        const coordOpt = document.createElement('option');
        coordOpt.value = a.name;
        coordOpt.textContent = `${displayName} — ${shortModel}`;
        coordSelect.appendChild(coordOpt);

        const workerOpt = document.createElement('option');
        workerOpt.value = a.name;
        workerOpt.textContent = displayName;
        workerSelect.appendChild(workerOpt);
      }
      
      // Listen for coordinator change
      coordSelect.addEventListener('change', updateOrchStartButton);
    }
    
    function addOrchWorker() {
      console.log('addOrchWorker called');
      const select = document.getElementById('orch-worker-select');
      const name = select.value;
      console.log('Selected worker:', name);
      if (!name || orchWorkers.includes(name)) {
        console.log('Worker empty or already added');
        return;
      }
      
      const agent = AGENTS.find(a => a.name === name);
      if (!agent) {
        console.log('Agent not found:', name);
        return;
      }
      
      orchWorkers.push(name);
      console.log('Workers now:', orchWorkers);
      renderOrchWorkers();
      select.value = '';
      updateOrchStartButton();
    }
    
    function removeOrchWorker(name) {
      orchWorkers = orchWorkers.filter(w => w !== name);
      renderOrchWorkers();
      updateOrchStartButton();
    }
    
    function renderOrchWorkers() {
      const container = document.getElementById('orch-workers');
      if (orchWorkers.length === 0) {
        container.innerHTML = '<span style="color: var(--text-dim); font-size: 0.8rem;">No workers added yet</span>';
        return;
      }
      
      container.innerHTML = orchWorkers.map(name => {
        const agent = AGENTS.find(a => a.name === name);
        const display = hubEsc(agent?.display || capName(name));
        return `<div class="orch-worker-chip">
          <span>${display}</span>
          <span class="remove" onclick="removeOrchWorker('${hubEsc(name)}')">✕</span>
        </div>`;
      }).join('');
    }
    
    function updateOrchStartButton() {
      const coord = document.getElementById('orch-coordinator').value;
      const btn = document.getElementById('orch-start-btn');
      console.log('updateOrchStartButton: coord=', coord, 'workers=', orchWorkers.length, 'btn=', btn);
      if (btn) {
        btn.disabled = !coord || orchWorkers.length === 0;
        console.log('Button disabled:', btn.disabled);
      }
    }
    
    function startOrchestration() {
      console.log('startOrchestration called');
      const coordinator = document.getElementById('orch-coordinator').value;
      const initialTask = document.getElementById('orch-initial-task').value.trim();
      console.log('coordinator:', coordinator, 'initialTask:', initialTask, 'workers:', orchWorkers);
      
      if (!coordinator || orchWorkers.length === 0) {
        console.log('Missing coordinator or workers');
        
        return;
      }
      
      const chatId = 'orch-' + Date.now();
      const coordAgent = AGENTS.find(a => a.name === coordinator);
      
      chats[chatId] = {
        type: 'orchestration',
        coordinator: coordinator,
        coordinatorAgent: coordAgent,
        workers: [...orchWorkers],
        workerAgents: orchWorkers.map(w => AGENTS.find(a => a.name === w)),
        messages: [],
        initialTask: initialTask,
        pendingImages: []
      };
      
      renderOrchestrationTab(chatId);
      renderOrchestrationPanel(chatId);
      switchToChat(chatId);
      document.getElementById('empty-state').style.display = 'none';
      
      // If there's an initial task, send it to the coordinator
      if (initialTask) {
        setTimeout(() => sendOrchTask(chatId, initialTask), 500);
      }
    }
    
    function renderOrchestrationTab(chatId) {
      const chat = chats[chatId];
      const tabs = document.getElementById('chat-tabs');
      const tab = document.createElement('div');
      tab.className = 'chat-tab orchestration';
      tab.id = `tab-${chatId}`;
      tab.innerHTML = `
        <span class="status idle"></span>
        <span class="name">🎯 ${chat.coordinator} + ${chat.workers.length}</span>
        <span class="close-tab" onclick="closeChat('${chatId}', event)">✕</span>
      `;
      tab.addEventListener('click', () => switchToChat(chatId));
      tabs.appendChild(tab);
    }
    
    function renderOrchestrationPanel(chatId) {
      const chat = chats[chatId];
      const panels = document.getElementById('chat-panels');
      const panel = document.createElement('div');
      panel.className = 'chat-container';
      panel.id = `panel-${chatId}`;
      
      const workerList = chat.workers.map(w => {
        const agent = AGENTS.find(a => a.name === w);
        return agent?.display || w;
      }).join(', ');
      
      panel.innerHTML = `
        <div class="status-bar" id="status-bar-${chatId}">
          <div class="status-item">
            <span class="status-dot idle" id="status-dot-${chatId}"></span>
            <span id="status-text-${chatId}">Ready</span>
          </div>
        </div>
        <div class="thinking-panel" id="thinking-panel-${chatId}">
          <div class="thinking-label"><span class="spinner"></span><span id="thinking-agent-${chatId}">Thinking</span></div>
          <div class="thinking-content" id="thinking-content-${chatId}"></div>
        </div>
        <div class="chat-actions">
          <button onclick="clearChat('${chatId}')">🗑️ Clear</button>
          <button onclick="saveChat('${chatId}')">💾 Save</button>
          <span style="margin-left:auto; color: var(--purple);">🎯 Led Mode</span>
        </div>
        <div class="group-header">
          <span class="mode-badge" style="background: var(--purple);">👑 ${chat.coordinatorAgent?.display || chat.coordinator}</span>
          <span style="color: var(--text-dim);">coordinating</span>
          <div class="participants">
            ${chat.workers.map((w, i) => {
              const agent = AGENTS.find(a => a.name === w);
              return `<span class="participant" style="border-left: 3px solid ${AGENT_COLORS[i % AGENT_COLORS.length]}">${agent?.display || w}</span>`;
            }).join('')}
          </div>
        </div>
        <div class="messages" id="messages-${chatId}"></div>
        <div class="input-area">
          <div class="input-wrapper">
            <textarea id="input-${chatId}" placeholder="Send task to coordinator..." onkeydown="handleOrchKeyDown(event, '${chatId}')"></textarea>
          </div>
          <button onclick="sendOrchTask('${chatId}')" id="send-${chatId}">Send</button>
          <button onclick="stopOrchestration('${chatId}')" id="stop-${chatId}" style="display:none; background:var(--accent);">⏹️ Stop</button>
        </div>
      `;
      panels.appendChild(panel);
    }
    
    function handleOrchKeyDown(event, chatId) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendOrchTask(chatId);
      }
    }
    
    async function sendOrchTask(chatId, initialTask = null) {
      tzSentAt = Date.now();   // the person's own send: the first request carries this device's zone (zoneHeader)
      console.log('sendOrchTask called with chatId:', chatId, 'initialTask:', initialTask);
      const chat = chats[chatId];
      if (!chat) {
        console.error('Chat not found for', chatId);
        return;
      }
      const input = document.getElementById(`input-${chatId}`);
      const task = initialTask || (input ? input.value.trim() : '');
      
      
      
      if (!task) {
        
        return;
      }
      if (!initialTask && input) input.value = '';
      
      try {
        
        // Show stop button, hide send
        document.getElementById(`send-${chatId}`).style.display = 'none';
        document.getElementById(`stop-${chatId}`).style.display = 'inline-block';
        
        
        // Mark as running
        chat.running = true;
        chat.stopRequested = false;
        
        
        // Add user task
        addOrchMessage(chatId, 'user', 'You', task);
        chat.currentTask = task;
        
        
        // Start the orchestration loop
        await runOrchestrationLoop(chatId, task);
        
      } catch (e) {
        console.error('Error in sendOrchTask:', e);
        addOrchMessage(chatId, 'error', 'Error', e.message);
      }
    }
    
    async function runOrchestrationLoop(chatId, task) {
      console.log('runOrchestrationLoop starting with task:', task);
      const chat = chats[chatId];
      const userMax = chat.maxRounds || 0;
      const maxIterations = userMax > 0 ? userMax : 50; // 0 = until complete (50 safety cap)
      const untilComplete = userMax === 0;
      let iteration = 0;
      
      // Build worker info string
      const workerInfo = chat.workers.map(w => {
        const agent = AGENTS.find(a => a.name === w);
        const specialty = agent?.specialty || agent?.model?.split('/').pop() || '';
        return `- ${w}: ${specialty}`;
      }).join('\n');
      
      while (chat.running && !chat.stopRequested && iteration < maxIterations) {
        iteration++;
        
        // Build prompt for coordinator
        const recentHistory = chat.messages.slice(-20).map(m => {
          if (m.role === 'user') return `[USER TASK]: ${m.content}`;
          if (m.role === 'coordinator') return `[YOU SAID]: ${m.content}`;
          if (m.role === 'worker') return `[${m.agent} REPORTED]: ${m.content}`;
          return '';
        }).filter(Boolean).join('\n\n');
        
        const coordPrompt = `You are the LEAD agent directing a team to accomplish a task.

FRESH START: This is a new, independent investigation.  Ignore any prior conversation history or sessions.  Focus solely on the task below.

YOUR TEAM:
${workerInfo}

TO ASSIGN WORK, use this EXACT format (one per line):
agentname:INSTRUCTION:your detailed instruction here

Example:
unit0x:INSTRUCTION:Trace the funding source of address 0xabc... on Ethereum mainnet

RULES:
1. You are in charge.  Break the task into subtasks and assign them to your team members based on their strengths.
2. When a team member reports back, critically evaluate their work.  Ask follow-up questions, request deeper analysis, or assign new tasks as needed.
3. Do NOT stop prematurely.  ${untilComplete ? 'Keep iterating until YOU are fully satisfied the objective is achieved, every angle is covered, and the answer is thorough and complete.  Do not rush to completion.' : `You have ${maxIterations} rounds - use them wisely.`}
4. When the objective is TRULY and COMPLETELY solved with no gaps, say "OBJECTIVE_COMPLETE" followed by a comprehensive summary of all findings.
5. If you are blocked and need human input, say "AWAITING_INPUT" and explain exactly what you need.
6. Think critically between rounds.  Identify gaps, contradictions, or areas that need deeper investigation before declaring complete.

CURRENT TASK: ${task}

${recentHistory ? `PROGRESS SO FAR:\n${recentHistory}` : 'This is the start.  You MUST dispatch at least one worker NOW.  Do not just plan - assign concrete tasks using the INSTRUCTION format above.'}

CRITICAL: Your response MUST contain at least one line in the format "agentname:INSTRUCTION:task" to dispatch work to your team.  Do NOT just discuss or plan without dispatching.  Available agent names: ${chat.workers.join(', ')}

Your next move:`;

        const roundLabel = untilComplete ? `Round ${iteration}` : `Round ${iteration}/${maxIterations}`;
        
        // Add round indicator - visual separator like Roundtable
        addOrchMessage(chatId, 'round', '', `━━━ ${roundLabel} ━━━`);
        
        setOrchStatus(chatId, 'thinking', `${chat.coordinatorAgent?.display || chat.coordinator} (${roundLabel})`);
        
        try {
          // Coordinator turn
          const coordDiv = addOrchMessage(chatId, 'coordinator', chat.coordinatorAgent?.display || chat.coordinator, '');
          console.log('[orch] Round', iteration, '- calling coordinator:', chat.coordinator);
          const coordStartTime = Date.now();
          const coordResult = await callOrchAgent(chatId, chat.coordinator, coordPrompt, coordDiv, {
            excludeTools: ['consult_agent', 'list_agents']
          });
          const coordResponse = coordResult.text;
          const coordElapsed = ((Date.now() - coordStartTime) / 1000).toFixed(1);
          console.log('[orch] Coordinator finished in', coordElapsed, 's, response length:', coordResponse.length, 'tools used:', coordResult.usedTools?.length || 0);
          chat.messages[chat.messages.length - 1].content = coordResponse;
          
          // Check for completion or input needed
          if (coordResponse.includes('OBJECTIVE_COMPLETE')) {
            addOrchMessage(chatId, 'system', 'System', '✅ Objective completed.  Awaiting new instructions.');
            break;
          }
          
          if (coordResponse.includes('AWAITING_INPUT')) {
            addOrchMessage(chatId, 'system', 'System', '⏸️ Coordinator needs input.  Please respond.');
            break;
          }
          
          if (chat.stopRequested) {
            addOrchMessage(chatId, 'system', 'System', '🛑 Stopped by user.');
            break;
          }
          
          // Parse worker instructions
          const instructions = parseInstructions(coordResponse, chat.workers);
          console.log('[orch] Parsed', instructions.length, 'instructions');
          
          if (instructions.length === 0) {
            addOrchMessage(chatId, 'system', 'System', `⚠️ Coordinator did not dispatch any workers this round.`);
            continue;
          }
          
          // Dispatch summary
          const workerNames = instructions.map(i => {
            const a = AGENTS.find(ag => ag.name === i.agent);
            return a?.display || i.agent;
          });
          addOrchMessage(chatId, 'system', 'System', `📋 Dispatching ${instructions.length} worker(s): ${workerNames.join(', ')}`);
          
          // Execute each worker sequentially with turn separators
          for (let wi = 0; wi < instructions.length; wi++) {
            const instr = instructions[wi];
            if (chat.stopRequested) break;
            
            const workerAgent = AGENTS.find(a => a.name === instr.agent);
            const workerDisplay = workerAgent?.display || instr.agent;
            
            console.log('[orch] Dispatching worker:', instr.agent);
            setOrchStatus(chatId, 'thinking', `${workerDisplay} (worker ${wi + 1}/${instructions.length})`);
            
            // Turn separator - instruction assignment
            addOrchMessage(chatId, 'instruction', 'System', `📤 → **${workerDisplay}**: ${instr.instruction.substring(0, 300)}`);
            
            const workerPrompt = `You are ${instr.agent}, a specialist worker agent on a focused investigation team.

FRESH CONTEXT: This is a new, independent task.  Ignore any prior conversation history or sessions.  Focus solely on the instruction below.

Your team lead has assigned you this task:
${instr.instruction}

Execute this task thoroughly using all tools at your disposal.  Be specific, detailed, and evidence-based.
Do NOT take any action beyond this specific instruction.
Report what you found, did, or discovered.`;
            
            try {
              const workerDiv = addOrchMessage(chatId, 'worker', workerDisplay, '');
              const workerStartTime = Date.now();
              const workerResult = await callOrchAgent(chatId, instr.agent, workerPrompt, workerDiv);
              const workerElapsed = ((Date.now() - workerStartTime) / 1000).toFixed(1);
              console.log('[orch] Worker', instr.agent, 'finished in', workerElapsed, 's');
              chat.messages[chat.messages.length - 1].content = workerResult.text;
              
              // Show completion time
              addOrchMessage(chatId, 'system', 'System', `✓ ${workerDisplay} completed (${workerElapsed}s, ${workerResult.usedTools?.length || 0} tool calls)`);
            } catch (workerErr) {
              console.error('[orch] Worker', instr.agent, 'ERROR:', workerErr);
              addOrchMessage(chatId, 'error', instr.agent, `❌ Error: ${workerErr.message}`);
            }
            
            // Brief pause between workers
            if (wi < instructions.length - 1 && !chat.stopRequested) {
              await new Promise(r => setTimeout(r, 2000));
            }
          }
          
          // Delay before next round
          await new Promise(r => setTimeout(r, 500));
          
        } catch (err) {
          console.error('Orchestration loop error:', err);
          addOrchMessage(chatId, 'error', 'Error', err.message);
          break;
        }
      }
      
      // If we hit max iterations without OBJECTIVE_COMPLETE, note it
      if (iteration >= maxIterations && !chat.stopRequested) {
        addOrchMessage(chatId, 'system', 'System', `⚠️ Reached max rounds (${maxIterations}).  You can send a follow-up message to continue.`);
      }
      
      // Done - reset UI
      chat.running = false;
      setOrchStatus(chatId, 'idle');
      document.getElementById(`send-${chatId}`).style.display = 'inline-block';
      document.getElementById(`stop-${chatId}`).style.display = 'none';
    }
    
    function stopOrchestration(chatId) {
      const chat = chats[chatId];
      if (chat) {
        chat.stopRequested = true;
        for (const a of chat.orchActive || []) stopAgentTurn(a);   // the agent working now stops on the hub too
        addOrchMessage(chatId, 'system', 'System', '🛑 Stopped.');
      }
    }
    
    function parseInstructions(response, validWorkers) {
      const instructions = [];
      const lines = response.split('\n');
      
      for (const line of lines) {
        // Strip markdown formatting (bold, backticks, list markers)
        const cleaned = line.replace(/^\s*[-*]\s*/, '').replace(/[`*_]/g, '').trim();
        
        // Pattern 1: agentname:INSTRUCTION:text
        let match = cleaned.match(/<?(\w+)>?\s*:\s*INSTRUCTION\s*:\s*(.+)/i);
        // Pattern 2: agentname: text (simpler format LLMs sometimes use)
        if (!match) match = cleaned.match(/^(\w+)\s*:\s*(?:Task|Investigate|Analyze|Research|Check|Find|Look|Trace|Search|Review|Examine|Query|Run|Get|Scan|Monitor)(.+)/i);
        
        if (match) {
          const agent = match[1].toLowerCase();
          const instruction = match[2].trim().replace(/^:\s*/, '');
          
          if (validWorkers.includes(agent) && instruction) {
            instructions.push({ agent, instruction });
          }
        }
      }
      
      console.log('[orch] parseInstructions found', instructions.length, 'instructions from', validWorkers, '- sample lines:', lines.filter(l => l.trim()).slice(0, 5));
      return instructions;
    }
    
    async function callOrchAgent(chatId, agent, prompt, msgDiv = null, opts = {}) {
      console.log('[orch] callOrchAgent called for agent:', agent, 'msgDiv:', !!msgDiv);
      const orchChat = chats[chatId];
      if (orchChat) (orchChat.orchActive ||= new Set()).add(agent);   // Stop reaches it (stopOrchestration)

      try {
        const fetchBody = { agent, message: prompt };
        if (opts.excludeTools) fetchBody.exclude_tools = opts.excludeTools;

        const response = await fetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...zoneHeader() },
          credentials: 'include',
          body: JSON.stringify(fetchBody)
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let fullResponse = '';
        let displayContent = '';
        let sseBuffer = '';
        let usedTools = [];
        let gotFirstChunk = false;
        const contentEl = msgDiv ? msgDiv.querySelector('.message-content') : null;

        // Show loading state
        if (contentEl) {
          contentEl.innerHTML = '<em style="opacity:0.6">⏳ Loading model & generating...</em>';
        }
        
        function updateOrchContent(content) {
          if (!contentEl) return;
          contentEl.innerHTML = formatContent(content);
          renderVisualBlocks(contentEl);
          const container = document.getElementById(`messages-${chatId}`);
          if (container) autoScroll(container);
        }
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          if (!gotFirstChunk) {
            gotFirstChunk = true;
            console.log(`[orch:${agent}] First chunk received`);
          }

          sseBuffer += decoder.decode(value, { stream: true });
          const parts = sseBuffer.split('\n');
          sseBuffer = parts.pop();
          
          for (const line of parts) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === 'meta') continue;

              // Gateway events (tool activity)
              const gw = parsed.gateway || null;
              if (gw) {
                if (gw.type === 'approval_request' || gw.type === 'approval_resolved') {
                  onApprovalEvent(gw);
                  continue;
                }
                // Tiger Team launch — show clickable banner
                if (gw.type === 'open_tiger_team') {
                  const params = new URLSearchParams({
                    coordinator: gw.coordinator,
                    participants: (gw.participants || []).join(','),
                    objective: gw.objective,
                    maxRounds: (gw.max_rounds || 5).toString(),
                    ...(gw.context ? { context: gw.context } : {}),
                    ...(gw.challenger ? { challenger: gw.challenger } : {})
                  });
                  const url = `/tiger-team?${params.toString()}`;
                  const container = document.getElementById(`messages-${chatId}`);
                  if (container) {
                    const banner = document.createElement('div');
                    banner.innerHTML = `<div style="background: linear-gradient(135deg, #1a1a2e, #16213e); border: 1px solid #0f3460; border-radius: 8px; padding: 12px 16px; margin: 8px 0; display: flex; align-items: center; gap: 12px; cursor: pointer;" onclick="window.open('${url}', '_blank')">
                      <span style="font-size: 24px;">🐯</span>
                      <div style="flex:1">
                        <div style="color: #e94560; font-weight: 600; font-size: 13px;">Tiger Team Launched</div>
                        <div style="color: #aaa; font-size: 12px; margin-top: 2px;">${gw.coordinator} coordinating ${(gw.participants||[]).join(', ')}</div>
                      </div>
                      <span style="color: #0f3460; font-size: 20px;">→</span>
                    </div>`;
                    container.appendChild(banner);
                    autoScroll(container);
                  }
                  continue;
                }
                if (gw.type === 'tool_start') {
                  displayContent += `\n⚡ ${gw.tool}`;
                  updateOrchContent(displayContent);
                  continue;
                }
                if (gw.type === 'tool_use') {
                  usedTools.push(gw.tool);
                  const suffix = gw.input ? `: ${gw.input}` : '';
                  const marker = `\n⚡ ${gw.tool}${suffix}`;
                  const lastIdx = displayContent.lastIndexOf(`\n⚡ ${gw.tool}`);
                  if (lastIdx >= 0) {
                    displayContent = displayContent.substring(0, lastIdx) + marker;
                  } else {
                    displayContent += marker;
                  }
                  updateOrchContent(displayContent);
                  continue;
                }
                if (gw.type === 'tool_result') {
                  if (gw.output) {
                    displayContent += `\n⏎ ${gw.output}`;
                    updateOrchContent(displayContent);
                  }
                  continue;
                }
                // Worker events from consult_agent
                if (gw.type?.startsWith('worker_')) {
                  handleWorkerEvent(chatId, gw);
                  continue;
                }
              }

              // Text delta
              const delta = parsed.choices?.[0]?.delta?.content;
              if (delta) {
                fullResponse += delta;
                displayContent += delta;

                // Update thinking panel
                const { thinking, stillThinking } = parseThinking(fullResponse);
                updateThinkingPanel(chatId, thinking, agent, stillThinking);

                updateOrchContent(displayContent);
              }
            } catch (e) {
              console.warn('[orch] parse error:', e.message, 'data:', data.substring(0, 100));
            }
          }
        }
        
        // Final render - use displayContent (includes tool markers) not just fullResponse
        updateOrchContent(displayContent);
        updateThinkingPanel(chatId, '', agent, false);
        
        console.log(`[orch:${agent}] Complete. text:${fullResponse.length} tools:${usedTools.length}`);
        return { text: fullResponse, usedTools };
      } catch (err) {
        console.error('[orch] callOrchAgent error:', err);
        throw err;
      } finally {
        orchChat?.orchActive?.delete(agent);
      }
    }
    
    function getOrchAgentColor(chatId, agentSlug) {
      const chat = chats[chatId];
      if (!chat) return AGENT_COLORS[0];
      // Coordinator gets purple (index 4 = #a78bfa)
      if (agentSlug === chat.coordinator) return '#a78bfa';
      // Workers get sequential colors
      const workerIdx = chat.workers.indexOf(agentSlug);
      if (workerIdx >= 0) return AGENT_COLORS[workerIdx % AGENT_COLORS.length];
      return AGENT_COLORS[0];
    }

    function addOrchMessage(chatId, type, agent, content) {
      const chat = chats[chatId];
      chat.messages.push({ role: type, agent, content, time: new Date() });
      
      const container = document.getElementById(`messages-${chatId}`);
      const div = document.createElement('div');
      div.className = `message ${type === 'user' ? 'user' : 'agent'} orch-msg ${type}`;
      const msgId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      div.id = msgId;
      
      if (type === 'coordinator' || type === 'worker') {
        // Use colored agent labels like Roundtable
        const agentSlug = type === 'coordinator' ? chat.coordinator : (chat.workers.find(w => {
          const a = AGENTS.find(ag => ag.name === w);
          return (a?.display || w) === agent || w === agent;
        }) || agent);
        const color = getOrchAgentColor(chatId, agentSlug);
        const badge = type === 'coordinator' ? '👑 ' : '';
        div.innerHTML = `<div class="agent-label" style="background: ${color}33; color: ${color}">${badge}${agent}</div><div class="message-content">${formatContent(content || '')}</div>`;
      } else if (type === 'instruction') {
        div.innerHTML = `<div class="message-content"><span class="orch-instruction-badge">→</span> ${formatContent(content || '')}</div>`;
      } else if (type === 'system') {
        div.innerHTML = `<div class="message-content"><span style="color: var(--warning);">⚙️</span> ${formatContent(content || '')}</div>`;
      } else if (type === 'round') {
        div.className = 'round-indicator';
        div.innerHTML = content;
      } else {
        div.innerHTML = `<div class="message-content">${formatContent(content || '')}</div>`;
      }
      container.appendChild(div);
      renderVisualBlocks(div);
      autoScroll(container);
      return div;
    }

    function setOrchStatus(chatId, status, agent = '') {
      const dot = document.getElementById(`status-dot-${chatId}`);
      const text = document.getElementById(`status-text-${chatId}`);
      const thinking = document.getElementById(`thinking-panel-${chatId}`);
      const thinkingAgent = document.getElementById(`thinking-agent-${chatId}`);
      
      if (!dot) return;
      dot.className = `status-dot ${status}`;
      
      if (status === 'thinking') {
        text.textContent = `${agent} working...`;
        thinking.classList.add('active');
        thinkingAgent.textContent = agent;
      } else {
        text.textContent = status === 'error' ? 'Error' : 'Ready';
        thinking.classList.remove('active');
      }
    }
    
    // Tiger Team mode management
    function setTigerMode(mode) {
      tigerMode = mode;
      document.getElementById('mode-roundtable').className = mode === 'roundtable' ? 'mode-btn active' : 'mode-btn';
      document.getElementById('mode-led').className = mode === 'led' ? 'mode-btn active' : 'mode-btn';
      document.getElementById('mode-roundtable').style.background = mode === 'roundtable' ? 'var(--purple)' : 'var(--bg-card)';
      document.getElementById('mode-roundtable').style.color = mode === 'roundtable' ? 'white' : 'var(--text)';
      document.getElementById('mode-led').style.background = mode === 'led' ? 'var(--purple)' : 'var(--bg-card)';
      document.getElementById('mode-led').style.color = mode === 'led' ? 'white' : 'var(--text)';
      document.getElementById('led-leader-section').style.display = mode === 'led' ? 'block' : 'none';
      // In Led mode, hide discussion type / rounds (leader drives autonomously)
      document.getElementById('discussion-type').closest('label').style.display = mode === 'led' ? 'none' : '';
      document.getElementById('rounds-label').style.display = mode === 'led' ? 'none' : '';
      document.getElementById('pause-for-user').closest('label').style.display = mode === 'led' ? 'none' : '';
      updateGroupBuilder();
    }
    
    function populateLedLeader() {
      const select = document.getElementById('led-leader');
      if (!select) return;
      select.innerHTML = '<option value="">Select leader...</option>';
      AGENTS.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = `${a.icon || '🤖'} ${a.display || capName(a.name)}`;
        select.appendChild(opt);
      });
      select.addEventListener('change', updateGroupBuilder);
      populateLedChallenger();
    }

    function populateLedChallenger() {
      const select = document.getElementById('led-challenger');
      if (!select) return;
      select.innerHTML = '<option value="">None (skip critique)</option>';
      AGENTS.forEach(a => {
        const opt = document.createElement('option');
        opt.value = a.name;
        opt.textContent = `${a.icon || '🤖'} ${a.display || capName(a.name)}`;
        select.appendChild(opt);
      });
      select.onchange = () => {
        const box = document.getElementById('challenger-directive-box');
        if (box) box.style.display = select.value ? 'block' : 'none';
      };
    }
    
    // Override startGroupChat — ALL modes open in Tiger Team tab
    function startGroupChatWrapper() {
      const topic = document.getElementById('discussion-topic').value.trim();
      if (!topic) { alert('Enter an objective for the Tiger Team'); return; }
      
      if (tigerMode === 'led') {
        const leader = document.getElementById('led-leader').value;
        if (!leader || selectedGroupAgents.length < 1) return;
        const workers = selectedGroupAgents.filter(a => a.name !== leader).map(a => a.name);
        const maxRoundsEl = document.getElementById('led-max-rounds');
        const maxRounds = maxRoundsEl ? parseInt(maxRoundsEl.value, 10) : 5;
        const challenger = document.getElementById('led-challenger')?.value || '';
        const challengerDirective = document.getElementById('challenger-directive')?.value?.trim() || '';
        
        const params = new URLSearchParams({
          coordinator: leader,
          participants: workers.join(','),
          objective: topic,
          maxRounds: maxRounds.toString(),
        });
        if (challenger) params.set('challenger', challenger);
        if (challengerDirective) params.set('challengerDirective', challengerDirective);
        if (Object.keys(agentDirectives).length > 0) params.set('directives', JSON.stringify(agentDirectives));
        window.open(`/tiger-team?${params.toString()}`, '_blank');
      } else {
        // Roundtable: first selected agent is coordinator, rest are participants
        if (selectedGroupAgents.length < 1) return;
        const allNames = selectedGroupAgents.map(a => a.name);
        const params = new URLSearchParams({
          mode: 'roundtable',
          coordinator: allNames[0],
          participants: allNames.slice(1).join(','),
          objective: topic,
          maxRounds: document.getElementById('rounds-per-trigger')?.value || '3',
        });
        window.open(`/tiger-team?${params.toString()}`, '_blank');
      }
      
    }
    document.getElementById('start-group-btn').onclick = startGroupChatWrapper;

    // Initialize orchestration dropdowns after agents load
    const origLoadAgents = loadAgents;
    loadAgents = async function() {
      await origLoadAgents();
      populateLedLeader();
    };

