/**
 * ui-teams.js — who reports to whom, as a tree for the Teams view, and the rules a new reporting line must follow.
 * Shared by the desktop page, the phone page and the server (validation), so all three agree.
 *
 * An agent's boss:
 *   1. its reportsTo, when that names another agent in the list;
 *   2. else the one primary agent that names it as buildPartner (read only; two or more such primaries: no boss);
 *   3. else none.
 * Main agents (category 'primary', or the lead) are always at the top; they report to nobody.
 *
 * Functions:
 *   isMain(agent)                         category 'primary' or lead
 *   bossOf(agent, agents)                 the boss's name, or null (rules above)
 *   tree(agents, status)                  { mains, shared, other, anyTeam, size } for the Teams view; every agent once
 *   hasTeam(name, agents)                 true when main agent `name` has someone under it
 *   helpersBy(status)                     { parentName: number of running temporary workers }
 *   ownerKey(agent, adminIds)             '@admin' for admin-side agents, else the member's id
 *   checkReportsTo(name, boss, agents, adminIds)   null when allowed, else a plain reason (server-side rule)
 *   MAX_DEPTH                             3 levels: main agent, team leader, worker
 *
 * Pure; no network. Browser: window.hubTeams. Node: module.exports.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.hubTeams = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const MAX_DEPTH = 3;

  function isMain(a) { return !!(a && (a.category === 'primary' || a.lead === true)); }
  function nameOf(a) { return a && typeof a.name === 'string' ? a.name : ''; }

  function byName(agents) {
    const m = new Map();
    for (const a of agents || []) if (nameOf(a)) m.set(a.name, a);
    return m;
  }

  function bossFrom(a, map, partnerOf) {
    if (!a || isMain(a)) return null;
    const r = typeof a.reportsTo === 'string' ? a.reportsTo : '';
    if (r && r !== a.name && map.has(r)) return r;
    const p = partnerOf.get(a.name);
    return p && p.length === 1 && p[0] !== a.name ? p[0] : null;
  }

  // buildPartner reading: a main agent is the inferred boss of its buildPartner only when both have the same owner.
  function partnersOf(agents) {
    const m = new Map();
    const owners = new Map();
    for (const a of agents || []) if (nameOf(a)) owners.set(a.name, String(a.owner || ''));
    for (const a of agents || []) {
      if (!nameOf(a) || !isMain(a) || typeof a.buildPartner !== 'string' || !a.buildPartner) continue;
      if (!owners.has(a.buildPartner) || owners.get(a.buildPartner) !== String(a.owner || '')) continue;
      if (!m.has(a.buildPartner)) m.set(a.buildPartner, []);
      m.get(a.buildPartner).push(a.name);
    }
    return m;
  }

  function bossOf(agent, agents) {
    const map = byName(agents);
    return bossFrom(agent, map, partnersOf(agents));
  }

  function helpersBy(status) {
    const out = Object.create(null);
    for (const [, s] of Object.entries(status || {})) {
      if (!s || !s.worker || !s.parent || !s.busy) continue;
      out[s.parent] = (out[s.parent] || 0) + 1;
    }
    return out;
  }

  /**
   * The Teams view. Returns
   *   mains:  [{ agent, children: [node], size, working, helpers }]   (Your agents; every level: the lead first, then by shown name)
   *   node:   { agent, children: [node], size, working, helpers, depth }  (depth 1 = team leader, 2 = worker, 3+ deeper)
   *   shared: [agent]   no boss, not main, not experimental
   *   other:  [agent]   category experimental with no boss
   *   anyTeam: true when any main agent has someone under it
   *   size:   number of agents placed (always agents.length)
   * size = everyone below; working = busy agents below plus running helpers of the team; helpers = this agent's own.
   * A boss chain that loops (old or hand-edited data) is cut: the agent goes where it would go with no boss.
   */
  function tree(agents, status) {
    const list = (agents || []).filter(a => nameOf(a));
    const map = byName(list);
    const partners = partnersOf(list);
    const st = status || {};
    const helpers = helpersBy(st);
    const boss = new Map();
    for (const a of list) boss.set(a.name, bossFrom(a, map, partners));
    // Cut loops: only an agent whose own boss chain returns to itself is inside a loop and loses its boss
    // (decided on the original chains, then cut together; one that merely leads into a loop keeps its boss).
    const inLoop = [];
    for (const a of list) {
      let b = boss.get(a.name), steps = 0;
      while (b && steps <= list.length) {
        if (b === a.name) { inLoop.push(a.name); break; }
        b = boss.get(b); steps++;
      }
    }
    // Cut one agent per loop at a time, so each loop keeps all but one link broken only as far as needed.
    for (const n of inLoop) {
      let b = boss.get(n), steps = 0, still = false;
      while (b && steps <= list.length) {
        if (b === n) { still = true; break; }
        b = boss.get(b); steps++;
      }
      if (still) boss.set(n, null);
    }
    // A boss chain that never reaches a main agent (e.g. a specialist reporting to a specialist) still shows: its top
    // goes to shared/other and the rest hang under it.
    const kids = new Map();
    for (const a of list) {
      const b = boss.get(a.name);
      if (!b) continue;
      if (!kids.has(b)) kids.set(b, []);
      kids.get(b).push(a);
    }
    const busy = n => !!(st[n] && st[n].busy);
    // Same order as the All Agents list: the lead first, then by shown name.
    const label = a => String(a.display || a.name).toLowerCase();
    const order = (x, y) => (y.lead === true) - (x.lead === true) || label(x).localeCompare(label(y));
    function node(a, depth) {
      const children = (kids.get(a.name) || []).slice().sort(order).map(c => node(c, depth + 1));
      const size = children.reduce((s, c) => s + 1 + c.size, 0);
      const working = children.reduce((s, c) => s + (busy(c.agent.name) ? 1 : 0) + c.working, 0) + (helpers[a.name] || 0);
      return { agent: a, children, size, working, helpers: helpers[a.name] || 0, depth };
    }
    const mains = [], shared = [], other = [];
    for (const a of list.slice().sort(order)) {
      if (boss.get(a.name)) continue;
      if (isMain(a)) mains.push(node(a, 0));
      else if (a.category === 'experimental') other.push(node(a, 0));
      else shared.push(node(a, 0));
    }
    return { mains, shared, other, anyTeam: mains.some(m => m.children.length > 0), size: list.length };
  }

  /**
   * The Teams list's sections, in order, from a tree() result. Sections with no rows are left out.
   *   teams:  main agents with someone under them
   *   solo:   "Solo agents": every main agent with no team, whether or not it is recorded as working alone (the owner 2026-11-24: "Create a classification of solo agents";
   *           "No team yet" and "Working alone" are one section now; isAlone is kept for callers that need it per row)
   *   shared: tree.shared
   *   other:  tree.other (experimental agents with no boss), as today
   * Each section is { key, title, count, rows } and keeps tree()'s order (the lead first, then by shown name).
   */
  function sections(t, isAlone) {
    const mains = (t && t.mains) || [];
    const out = [
      { key: 'teams', title: 'Teams', rows: mains.filter(m => m.children.length > 0) },
      { key: 'solo', title: 'Solo agents', rows: mains.filter(m => !m.children.length) },
      { key: 'shared', title: 'Shared specialists', rows: (t && t.shared) || [] },
      { key: 'other', title: 'Other', rows: (t && t.other) || [] },
    ];
    return out.filter(s => s.rows.length > 0).map(s => Object.assign(s, { count: s.rows.length }));
  }

  /** true when someone reports to main agent `name` (the Build team entry and line are for a main agent where this is false). */
  function hasTeam(name, agents) {
    const m = tree(agents, null).mains.find(x => x.agent.name === name);
    return !!(m && m.children.length > 0);
  }

  function ownerKey(a, adminIds) {
    const o = a && a.owner ? String(a.owner) : '';
    const admins = adminIds instanceof Set ? adminIds : new Set((adminIds || []).map(String));
    return !o || admins.has(o) ? '@admin' : o;
  }

  /**
   * May `name` report to `boss`? null = yes; otherwise a reason in plain words. boss '' or null = clear (always allowed
   * for an existing agent). Rules: the agent exists and is not a main agent; the boss exists and is not the agent;
   * same side (both admin-side, or the boss belongs to the agent's member owner or is shared with them); at most three
   * levels: the boss is a main agent or reports to one, and an agent that has others under it may report only to a main
   * agent; no loops.
   */
  function checkReportsTo(name, bossName, agents, adminIds) {
    const list = (agents || []).filter(a => nameOf(a));
    const map = byName(list);
    const a = map.get(name);
    if (!a) return `there is no agent named ${name}`;
    if (bossName == null || bossName === '') return null;
    if (typeof bossName !== 'string') return 'reportsTo must be an agent name';
    if (isMain(a)) return `${name} is a main agent; main agents report to nobody`;
    if (bossName === name) return 'an agent cannot report to itself';
    const b = map.get(bossName);
    if (!b) return `there is no agent named ${bossName}`;
    const ka = ownerKey(a, adminIds), kb = ownerKey(b, adminIds);
    const shared = Array.isArray(b.sharedWith) && b.sharedWith.map(String).includes(ka);
    if (ka !== kb && !(ka !== '@admin' && shared)) return `${bossName} belongs to someone else`;
    const partners = partnersOf(list);
    // The tree as it would be after the change.
    const next = list.map(x => (x.name === name ? Object.assign({}, x, { reportsTo: bossName }) : x));
    const nmap = byName(next);
    const up = n => bossFrom(nmap.get(n), nmap, partners);
    // Loop check.
    const seen = new Set([name]);
    let cur = bossName, steps = 0;
    while (cur && steps <= next.length) {
      if (seen.has(cur)) return `${bossName} already reports to ${name}, directly or through others`;
      seen.add(cur); cur = up(cur); steps++;
    }
    if (!isMain(b)) {
      const bb = up(bossName);
      if (!bb || !isMain(nmap.get(bb))) return `${bossName} is not a main agent or a team leader; a team has at most ${MAX_DEPTH} levels`;
      const hasReports = next.some(x => x.name !== name && up(x.name) === name);
      if (hasReports) return `${name} has agents reporting to it, so it can report only to a main agent`;
    }
    return null;
  }

  /**
   * Names of agents whose stored reportsTo no longer passes checkReportsTo in the current graph. The first failing
   * line is removed from a working copy and everything is re-checked until stable, so removing the returned lines
   * leaves a valid graph.
   */
  function invalidLines(agents, adminIds) {
    const work = (agents || []).filter(a => nameOf(a)).map(a => Object.assign({}, a));
    const out = [];
    for (let guard = 0; guard <= work.length; guard++) {
      let bad = null;
      for (const a of work) {
        if (typeof a.reportsTo !== 'string' || !a.reportsTo) continue;
        if (checkReportsTo(a.name, a.reportsTo, work, adminIds)) { bad = a; break; }
      }
      if (!bad) break;
      delete bad.reportsTo;
      out.push(bad.name);
    }
    return out;
  }

  /** Names whose reporting line a change broke. Pure. Each line is judged as it stands (not after a simulated clean-up,
   *  which could hide a line the change broke): a line
   *  that was valid in `before` and is invalid in `after` is broken. Clearing it can break lines that hung on it, so the
   *  check repeats on what is left. A line that was already invalid in `before` is never returned. */
  function brokenBy(before, after, adminIds) {
    const okBefore = new Set();
    for (const a of before || []) {
      if (a && a.name && typeof a.reportsTo === 'string' && a.reportsTo && checkReportsTo(a.name, a.reportsTo, before, adminIds) === null) okBefore.add(a.name);
    }
    let cur = (after || []).filter(Boolean).map(a => Object.assign({}, a));
    const out = [];
    for (let guard = 0; guard <= cur.length; guard++) {
      const bad = cur.filter(a => okBefore.has(a.name) && !out.includes(a.name) && typeof a.reportsTo === 'string' && a.reportsTo
        && checkReportsTo(a.name, a.reportsTo, cur, adminIds) !== null).map(a => a.name);
      if (!bad.length) break;
      out.push(...bad);
      cur = cur.map(a => (bad.includes(a.name) ? Object.assign({}, a, { reportsTo: undefined }) : a));
    }
    return out;
  }

  return { MAX_DEPTH, isMain, bossOf, tree, sections, hasTeam, helpersBy, ownerKey, checkReportsTo, invalidLines, brokenBy };
});
