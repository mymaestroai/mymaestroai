'use strict';
// "Require two-factor sign-in for admins" (hub setting requireAdmin2fa), in plain words:
//  - ON (the default, and whenever the stored value is anything but false): no admin can remove two-factor from their own account.
//  - OFF: an admin may remove two-factor from their own account with their password AND a current code, and then signs in
//    with a password alone (lib/auth login() asks for a code only when the account has two-factor).
//  - Opening the hub to the network (lib/bind-host) still needs an admin who has two-factor, whatever this setting says.
//  - Members are not affected.

const REQUIRED_MESSAGE = 'Two-factor sign-in is required for admins. To remove it, an admin first turns off "Require two-factor sign-in for admins" in Settings, Security.';

function requiredFrom(value) { return value !== false; }

function createAdmin2fa({ getSetting, updateSettings, auth, notify = () => {}, log = () => {} }) {
  const required = () => requiredFrom(getSetting('requireAdmin2fa', true));

  function setRequired({ actorId, isAdmin, want, password, code, ip } = {}) {
    if (typeof want !== 'boolean') return { ok: false, status: 400, error: 'Send required: true or false.' };
    const denied = { ok: false, status: 403, error: 'Only an admin can change this.' };
    if (!isAdmin) return denied;
    const u = auth.getUser(actorId);
    if (!u || u.role !== 'admin' || u.disabled) return denied;
    const cur = required();
    if (want === cur) return { ok: true, required: cur, changed: false };
    if (want === false) {
      const r = auth.login(u.login, String(password || ''), { ip });
      if (!r || !r.ok) return { ok: false, status: 403, error: (r && r.locked) ? r.error : 'That password is not right.' };
      if (r.needsTotp) {
        const t = auth.totpCheck(u.id, String(code || '').replace(/\s+/g, ''));
        if (!t || !t.ok) return { ok: false, status: 403, error: 'That two-factor code is not right.' };
      }
    }
    updateSettings({ requireAdmin2fa: want });
    try { auth.audit(u.id, 'security.admin2fa', want ? 'required' : 'optional', ip || null); } catch {}
    try {
      Promise.resolve(notify({
        title: want ? 'Two-factor sign-in is required for admins again' : 'Two-factor sign-in is now optional for admins',
        body: `${u.name || u.login} changed this in Settings, Security.`,
        url: '/', tag: 'admin-2fa',
      })).catch(() => {});
    } catch {}
    try { log(`[security] two-factor for admins is now ${want ? 'required' : 'optional'} (changed by ${u.login})`); } catch {}
    return { ok: true, required: want, changed: true };
  }

  return { required, setRequired };
}

module.exports = { REQUIRED_MESSAGE, requiredFrom, createAdmin2fa };
