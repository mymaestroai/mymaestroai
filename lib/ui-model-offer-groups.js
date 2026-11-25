'use strict';

function mountModelOfferGroups(win) {
  const doc = win.document;
  if (win.top !== win || win.mmSettingsOnly) return;
  const api = '/api/model-offer-groups';
  const panel = doc.createElement('section');
  panel.setAttribute('aria-label', 'Model upgrades');
  panel.hidden = true;
  panel.style.cssText = 'position:fixed;bottom:max(1rem,env(safe-area-inset-bottom));right:1rem;z-index:1000;box-sizing:border-box;width:min(26rem,calc(100% - 2rem));max-height:50vh;overflow:auto;overflow-wrap:anywhere;padding:1rem;background:Canvas;color:CanvasText;border:1px solid GrayText;border-radius:.6rem;box-shadow:0 3px 18px #0004;text-align:left;font:1rem/1.4 system-ui';
  doc.body.append(panel);
  const notice = element(panel, 'div');
  notice.setAttribute('role', 'status');
  const offers = element(panel, 'div');
  offers.setAttribute('aria-live', 'polite');
  let signature = '';
  let checking = false;
  let answering = false;
  let revision = 0;

  function element(parent, tag, value) {
    const node = doc.createElement(tag);
    if (value !== undefined) node.textContent = value;
    parent.append(node);
    return node;
  }

  function button(parent, label, click) {
    const node = element(parent, 'button', label);
    node.type = 'button';
    node.style.cssText = 'margin:.25rem .5rem .25rem 0;min-height:2.75rem;padding:.4rem .7rem';
    node.addEventListener('click', click);
  }

  function showGroups(groups) {
    const next = JSON.stringify(groups);
    if (signature === next) return;
    signature = next;
    offers.replaceChildren();
    for (const group of groups) {
      const card = element(offers, 'section');
      element(card, 'h2', 'Newer model versions available');
      const list = element(card, 'ul');
      for (const row of group.rows) {
        const item = element(list, 'li');
        element(item, 'strong', row.name);
        element(item, 'div', 'From ' + row.from + ' to ' + row.to);
        element(item, 'small', [row.route, row.cost].filter(Boolean).join(' · '));
      }
      button(card, 'Upgrade all ' + group.rows.length + (group.rows.length === 1 ? ' agent' : ' agents'), () => answer(group, 'apply'));
      button(card, 'Dismiss offer', () => answer(group, 'dismiss'));
    }
    panel.hidden = !groups.length && !notice.firstChild;
  }

  function clear() {
    notice.replaceChildren();
    showGroups([]);
    panel.hidden = true;
  }

  async function refresh() {
    if (checking || answering || doc.hidden) return;
    checking = true;
    const current = revision;
    try {
      const res = await win.fetch(api, { cache: 'no-store' });
      if (current !== revision) return;
      if (res.status === 401 || res.status === 403 || res.redirected) { clear(); return; }
      if (!res.ok) throw new Error();
      const data = await res.json();
      if (current !== revision) return;
      if (!Array.isArray(data.groups) || !data.groups.every(g => g && typeof g.id === 'string' && g.id &&
          Array.isArray(g.rows) && g.rows.length && g.rows.every(r => r && ['name', 'from', 'to'].every(k => typeof r[k] === 'string' && r[k])))) throw new Error();
      showGroups(data.groups);
    } catch {
      if (current === revision) showGroups([]);
    } finally {
      checking = false;
      if (current !== revision && !answering) await refresh();
    }
  }

  async function answer(group, action) {
    if (answering) return;
    answering = true;
    revision++;
    notice.replaceChildren();
    element(notice, 'p', action === 'apply' ? 'Checking agents and applying upgrades…' : 'Dismissing offer…');
    showGroups([]);
    try {
      const res = await win.fetch(api + '/answer', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: group.id, action })
      });
      if (res.status === 401 || res.status === 403 || res.redirected) { clear(); return; }
      if (!res.ok) throw new Error();
      const { results } = await res.json();
      if (!Array.isArray(results)) throw new Error();
      const labels = new Map([
        ['switched', 'Upgraded'], ['busy', 'Busy. Review the offer again when this agent is free.'],
        ['changed', 'Changed since the offer. Upgrade skipped.'], ['failed', 'Upgrade failed. Review the current offer to retry.'],
        ['dismissed', 'Offer dismissed']
      ]);
      notice.replaceChildren();
      element(notice, 'h2', 'Model upgrade results');
      const list = element(notice, 'ul');
      for (const row of group.rows) {
        const result = results.find(r => r && r.name === row.name);
        element(list, 'li', row.name + ' — ' + (labels.get(result?.status) || 'Outcome unavailable'));
      }
    } catch {
      notice.replaceChildren();
      element(notice, 'p', 'Could not confirm the outcome. Review the current offers before trying again.');
    } finally {
      answering = false;
    }
    button(notice, 'Close results', () => {
      notice.replaceChildren();
      panel.hidden = !offers.firstChild;
    });
    await refresh();
  }

  doc.addEventListener('visibilitychange', refresh);
  win.setInterval(refresh, 60000);
  return refresh();
}

if (typeof module !== 'undefined' && module.exports) module.exports = { mountModelOfferGroups };
else mountModelOfferGroups(window);
