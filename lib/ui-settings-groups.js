/**
 * ui-settings-groups.js — the eight groups of the desktop Settings dialog (pure; no DOM).
 *
 * openSettings() (app.js) still draws its sections one after the other, each with an id "st-<name>-section". This module says
 * which of the eight groups every section belongs to, which sections sit under a group's closed "More", which single rows are
 * lifted out of a section into another group (Agent Defaults dissolves), which group opens first, and which sections a search
 * shows. app.js reads it; tests read it too. Node (tests): module.exports.
 *
 *   GROUPS   [{ id, title, icon, sub, sections: [section id], more: [section id] }] in display order
 *   ROWS     [{ selector, to: groupId, more?: bool, part, partTitle }]  rows moved (with their hints) into a small section
 *            "st-moved-<part>" inside the target group (under its More when more is true); every element id stays
 *   groupOfSection(id)  -> { group, more } (a section nobody knows goes to Upkeep, under More: nothing is ever lost)
 *   defaultGroup({ crit, last }) -> the group to open first: the first with a red summary, else the last one opened, else "you"
 *   moreLabel(group, nameOf) -> "More: A, B" for a closed More button (null when the group has no More content)
 *   search(q, entries) -> [{ group, ids }] the sections a search shows under each group (entries: [{ id, text }])
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.hubSettingsGroups = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GROUPS = [
    { id: 'review', title: 'For your review', icon: '\u{1F514}', sub: 'Problems, new features, recent changes',
      sections: ['st-ready-section', 'st-health-section', 'st-sec-section', 'st-recent-section'], more: [] },
    { id: 'you', title: 'You and this device', icon: '\u{1F642}', sub: 'Light or dark, text size, notifications, sign-in',
      sections: ['st-looks-section', 'st-notify-section', 'st-chat-section'], more: [] },
    { id: 'agents', title: 'Agents and teams', icon: '\u{1F916}', sub: 'Agents, defaults, teams',
      sections: ['st-workers-section'], more: [] },
    { id: 'money', title: 'Models and money', icon: '\u{1F4B3}', sub: 'Subscriptions, keys, plan usage, caps',
      sections: ['st-prov-section', 'st-or-section', 'st-subs-section', 'st-plan-section', 'st-local-models-section', 'st-spend-section'],
      more: ['st-classifier-section', 'st-tuning-section'] },
    { id: 'voice', title: 'Voice and calls', icon: '\u{1F399}', sub: 'Voices, talk mode, microphone, call display',
      sections: ['st-voice-section'], more: [] },
    { id: 'tools', title: 'Tools and connections', icon: '\u{1F50C}', sub: 'Web search, connectors, computers',
      sections: ['st-ws-section', 'st-comms-section', 'st-cx-section', 'st-modules-section'], more: [] },
    { id: 'safety', title: 'People and safety', icon: '\u{1F6E1}', sub: 'People, boxes, approvals, security check',
      sections: ['st-sb-section', 'st-lb-section', 'st-mp-section', 'st-approvals-section', 'st-security-section'], more: [] },
    // st-defaults-section is what is left of Agent Defaults once its rows have moved; it is removed when it is empty.
    { id: 'upkeep', title: 'Upkeep', icon: '\u{1F9F0}', sub: 'Backups, updates, health, expert values',
      sections: ['st-backups-section', 'st-memory-section', 'st-selfcheck-section', 'st-components-section', 'st-updates-section', 'st-emergency-section'],
      more: ['st-defaults-section'] },
  ];

  // Rows lifted out of their section into another group (P4-4). The row is the element's .st-row (or the element itself when it
  // is a block) plus the .st-hint lines that follow it; ids, names and loaders are untouched, so saving keeps working.
  const ROWS = [
    { selector: '#st-reasoning', to: 'you', part: 'reasoning', partTitle: 'Reasoning' },
    { selector: '#st-sidebar-teams', to: 'agents', part: 'teams', partTitle: 'Teams' },
    { selector: '#st-sidebar-tiger', to: 'agents', part: 'teams', partTitle: 'Teams' },
    { selector: '#st-notify-agent', to: 'agents', part: 'own-notify', partTitle: 'Agents with their own setting' },
    { selector: '#st-nb-agent-box', to: 'agents', part: 'own-notify', partTitle: 'Agents with their own setting' },
    { selector: '#prescan-toggle', to: 'agents', more: true, part: 'ship-off', partTitle: 'Features that ship off' },
    { selector: '#caveman-toggle', to: 'agents', more: true, part: 'ship-off', partTitle: 'Features that ship off' },
    { selector: '#st-maxTokens', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-maxContext', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-model-offers', to: 'money', more: true, part: 'limits', partTitle: 'Limits and suggestions' },
    { selector: '#st-research-remind', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-research-ownwork', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-research-thorough', to: 'tools', part: 'research', partTitle: 'Deep research' },
    { selector: '#st-look-new', to: 'safety', part: 'new-members', partTitle: 'New members' },
  ];

  const DEFAULT_GROUP = 'you';
  const STORE_KEY = 'hub-settings-group';
  const byId = (id) => GROUPS.find((g) => g.id === id) || null;
  const movedId = (r) => `st-moved-${r.part}`;

  /** The ids of every section the dialog may draw, one list for the whole page (tests compare it with openSettings). */
  function allSectionIds() {
    return GROUPS.flatMap((g) => [...g.sections, ...g.more]);
  }

  /** { group, more } for a section id; "st-moved-<part>" sections follow ROWS; anything unknown lands in Upkeep under More. */
  function groupOfSection(id) {
    for (const g of GROUPS) {
      if (g.sections.includes(id)) return { group: g.id, more: false };
      if (g.more.includes(id)) return { group: g.id, more: true };
    }
    const r = ROWS.find((x) => movedId(x) === id);
    if (r) return { group: r.to, more: !!r.more };
    return { group: 'upkeep', more: true };
  }

  /** Where a moved row ended up, by its selector (null when the table does not move it). */
  function groupOfRow(selector) {
    const r = ROWS.find((x) => x.selector === selector);
    return r ? { group: r.to, more: !!r.more, section: movedId(r) } : null;
  }

  function isGroup(id) { return !!byId(id); }

  /** The group to open: the first (in display order) with a red summary, else the last one opened (when it still exists), else You and this device. */
  function defaultGroup(o) {
    const crit = (o && o.crit) || {};
    const red = (id) => Array.isArray(crit) ? crit.includes(id) : !!crit[id];
    for (const g of GROUPS) if (red(g.id)) return g.id;
    const last = o && o.last;
    return isGroup(last) ? last : DEFAULT_GROUP;
  }

  /** The closed More button's text: "More: Auto model classifier, Tuning" (null when the group has no More content). */
  function moreLabel(group, nameOf, extra) {
    const g = typeof group === 'string' ? byId(group) : group;
    if (!g) return null;
    const names = [...g.more, ...((extra || []).filter(Boolean))].map((id) => (nameOf && nameOf(id)) || id).filter(Boolean);
    return names.length ? `More: ${[...new Set(names)].join(', ')}` : null;
  }

  /**
   * What a search shows, across every group. entries = [{ id: section id, text: lower-case words of that section and its rows }].
   * A group whose title (or sub-line) contains the query shows whole. Result is in group order; groups with nothing are left out.
   */
  function search(q, entries) {
    q = String(q || '').trim().toLowerCase();
    if (!q) return [];
    const by = new Map();
    for (const g of GROUPS) by.set(g.id, { group: g.id, ids: [], els: [], whole: g.title.toLowerCase().includes(q) });
    for (const e of entries || []) {
      const slot = by.get(e.group) || by.get(groupOfSection(e.id).group);   // e.group: where the page actually put it
      if (slot.whole || String(e.text || '').toLowerCase().includes(q)) { slot.ids.push(e.id); if (e.el) slot.els.push(e.el); }
    }
    return [...by.values()].filter((s) => s.ids.length).map((s) => ({ group: s.group, ids: s.ids, els: s.els, whole: s.whole }));
  }

  return { GROUPS, ROWS, DEFAULT_GROUP, STORE_KEY, allSectionIds, groupOfSection, groupOfRow, defaultGroup, moreLabel, search, byId, isGroup, movedId };
});
