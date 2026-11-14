'use strict';
/**
 * ui-call-display.js — the call display of a hands-free voice call, shared by the desktop page and the phone page
 * (index.html / mobile.html load it before app.js / mobile.js; it is also loadable with require() for tests). It decides
 * which display a call shows (None, the Orb, or an installed Character), builds the full-screen view, drives the Orb
 * (lib/ui-voice-orb.js) or the Character player (lib/ui-face-player.js) from the call's real states and the reply audio,
 * and gives the person Hang up / Back to chat, a Display chooser and an optional Interrupt button (off by default, per device; when on it
 * shows only while the agent thinks or speaks; hands-free needs no button to interrupt). Browser-safe plain JS; nothing runs at load time; DOM only through
 * createElement / textContent / setAttribute (the pack's name and every caption are data, never markup); styles are in
 * ui-call-display.css and CSSOM property writes only; no network except GET /api/faces.
 *
 * Choice model (per device; the agent only supplies a default):
 *   device choice  'follow' (default, unset) | 'none' | 'orb' | 'pack:<slug>'      key DISPLAY_STORE_KEY in localStorage
 *   a device choice always wins, an explicit 'none' included; 'follow' uses the agent's default, else None.
 *   A chosen character that is not installed (or cannot load) stays SAVED; the call falls back to None (never the Orb) and
 *   the voice panel says so.
 *
 *   resolveDisplay({ choice, agentDefault, packs, packsState, unusable }) -> { kind: 'none'|'orb'|'pack', slug, pack, source, missing, pending, wanted }
 *   loadDisplayPrefs(storage) / saveDisplayPrefs(storage, patch)        { choice, captions, interrupt }
 *   mapDisplayState(callState, { audio, hello })                        the display state for a controller state
 *   createTalkFloor({ call, setTimer, clearTimer, waitMs })             gives the person the floor without a fake utterance
 *   fetchPacks(fetch)                                                    GET /api/faces -> [{ id, name, background, hasReactions }]
 *   fillDisplaySelect(doc, select, { choice, packs })                    the voice panel's selector (Follow agent default / None / Orb / packs)
 *   createCallDisplay(options) -> display                                see the method list at its definition
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.CallDisplay = api; root.createCallDisplay = api.createCallDisplay; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const DISPLAY_STORE_KEY = 'hub-voice-display';
  const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
  const MOODS = ['delighted', 'laughing', 'sympathetic', 'surprised', 'proud', 'curious', 'encouraging'];
  const COLOR_RE = /^(#[0-9a-f]{3,8}|rgba?\([0-9 ,.%\/]+\))$/i;
  // HELLO_MS: how long hello is held before a check; HELLO_WAIT_MS: the bound on a hello clip that has not ARRIVED yet (a slow link) before it is
  // given up; HELLO_POLL_MS: the check interval once the player reports hello waiting/playing (players without those fields keep the plain HELLO_MS timer)
  const HELLO_MS = 3500, HELLO_WAIT_MS = 7000, HELLO_POLL_MS = 100, GOODBYE_MS = 3000, TALK_WAIT_MS = 6000, TALK_FRAME_MS = 8000, CAPTION_MAX = 400, PACKS_RETRY_MS = 3000;
  const STATE_TEXT = { starting: 'Starting', listening: 'Listening', hearing: 'Hearing you', thinking: 'Thinking', speaking: 'Speaking', standby: 'Waiting', ended: 'Call ended' };

  /** 'follow' | 'none' | 'orb' | 'pack:<slug>' or null for anything else. `allowFollow` false: a saved agent default has no 'follow'. */
  function cleanChoice(v, allowFollow) {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (s === 'none' || s === 'orb') return s;
    if (allowFollow !== false && s === 'follow') return s;
    if (s.startsWith('pack:') && SLUG_RE.test(s.slice(5))) return s;
    return null;
  }

  /**
   * Which display a call shows. packsState: 'ready' | 'loading' | 'failed' (default: 'ready' when `packs` is an array, else 'loading').
   * unusable: slugs that failed to load. A pack that is not installed (or unusable, or the list failed) -> kind 'none', missing true
   * (never the Orb); while the list is still loading -> kind 'none', pending true.
   */
  function resolveDisplay(o) {
    const x = o || {};
    const pref = cleanChoice(x.choice) || 'follow';
    let eff = pref, source = 'device';
    if (pref === 'follow') { eff = cleanChoice(x.agentDefault, false) || 'none'; source = 'agent'; }
    if (eff === 'none') return { kind: 'none', source, missing: false, pending: false };
    if (eff === 'orb') return { kind: 'orb', source, missing: false, pending: false };
    const slug = eff.slice(5);
    const state = x.packsState || (Array.isArray(x.packs) ? 'ready' : 'loading');
    if (state === 'loading') return { kind: 'none', source, missing: false, pending: true, wanted: slug };
    const bad = x.unusable instanceof Set ? x.unusable : new Set(Array.isArray(x.unusable) ? x.unusable : []);
    const pack = state === 'ready' && Array.isArray(x.packs) ? x.packs.find(p => p && p.id === slug) : null;
    if (!pack || bad.has(slug)) {
      // offReason (machine-readable, no text): 'removed' = the installed list lacks it, or the server confirmed it gone (404/410 on its manifest: x.removed);
      // 'could-not-load' = the list itself failed, or the pack failed to load without that verdict. Never guessed from a transient failure.
      const gone = x.removed instanceof Set ? x.removed : new Set(Array.isArray(x.removed) ? x.removed : []);
      const offReason = !pack ? (state === 'failed' ? 'could-not-load' : 'removed') : (gone.has(slug) ? 'removed' : 'could-not-load');
      return { kind: 'none', source, missing: true, pending: false, wanted: slug, failed: !!pack || state === 'failed', offReason };
    }
    return { kind: 'pack', slug, pack, source, missing: false, pending: false, name: typeof pack.name === 'string' ? pack.name : slug };
  }

  function loadDisplayPrefs(storage) {
    const p = { choice: 'follow', captions: false, interrupt: false };
    try {
      const raw = JSON.parse(storage.getItem(DISPLAY_STORE_KEY));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const c = cleanChoice(raw.choice); if (c) p.choice = c;
        if (typeof raw.captions === 'boolean') p.captions = raw.captions;
        p.interrupt = raw.interrupt === true;
      }
    } catch { /* unset or unreadable: the defaults */ }
    return p;
  }
  function saveDisplayPrefs(storage, patch) {
    const merged = Object.assign(loadDisplayPrefs(storage), {});
    if (patch && cleanChoice(patch.choice)) merged.choice = patch.choice.trim();
    if (patch && typeof patch.captions === 'boolean') merged.captions = patch.captions;
    if (patch && typeof patch.interrupt === 'boolean') merged.interrupt = patch.interrupt;
    try { storage.setItem(DISPLAY_STORE_KEY, JSON.stringify(merged)); } catch { /* storage blocked: this session only */ }
    return merged;
  }

  /** Controller state -> display state. 'speaking' shows speaking only once reply audio has really started (not while it is fetched). */
  function mapDisplayState(callState, st) {
    const s = st || {};
    switch (callState) {
      case 'speaking': return s.audio ? 'speaking' : 'thinking';
      case 'thinking': return 'thinking';
      case 'hearing': return 'listening';
      case 'listening': return s.hello ? 'idle' : 'listening';
      default: return 'idle';   // starting (and anything unknown)
    }
  }

  /** The microphone's dB (voiceLevelDb) as 0..1 for the display. */
  function levelFromDb(db) { const n = Number(db); return Number.isFinite(n) ? Math.max(0, Math.min(1, (n + 60) / 50)) : 0; }

  /**
   * Talk: the person takes the floor on purpose. It uses the controller's own entry points: onSpeechStart() (cuts what is being read and
   * marks the person as speaking; no utterance is made up) and, when the microphone then hears nothing, onMisfire(), which returns the
   * call to listening exactly like a false start. Once the voice activity detector reports speech (wrap() sees its events) the detector
   * owns the turn; a watchdog on its frames lets go if it goes silent for good.
   *   take() -> true when the floor was taken;  wrap(handlers) -> handlers to give the VAD;  cancel()
   */
  function createTalkFloor(o) {
    const x = o || {};
    const setT = x.setTimer || ((f, ms) => setTimeout(f, ms)), clearT = x.clearTimer || ((t) => clearTimeout(t));
    const waitMs = Number.isFinite(x.waitMs) ? x.waitMs : TALK_WAIT_MS;
    let timer = null, taken = false, owned = false;
    const call = () => { try { return typeof x.call === 'function' ? x.call() : x.call; } catch { return null; } };
    const clear = () => { if (timer !== null) { clearT(timer); timer = null; } };
    const letGo = () => {   // the microphone heard nothing (or went silent): back to listening, as after a false start
      clear();
      if (!taken) return;
      taken = false; owned = false;
      const c = call();
      try { if (c && typeof c.onMisfire === 'function') c.onMisfire(); } catch { /* the call is over */ }
    };
    const arm = (ms) => { clear(); timer = setT(letGo, ms); };
    return {
      take() {
        const c = call();
        if (!c || typeof c.onSpeechStart !== 'function') return false;
        const s = c.state;
        if (!s || s === 'starting' || s === 'ended') return false;
        if (taken) { if (!owned) arm(waitMs); return true; }
        taken = true; owned = false;
        try { c.onSpeechStart(); } catch { taken = false; return false; }
        arm(waitMs);
        return true;
      },
      wrap(h) {
        const hh = h || {};
        const seen = () => { if (taken) { owned = true; arm(TALK_FRAME_MS); } };
        const done = () => { if (taken) { clear(); taken = false; owned = false; } };
        return Object.assign({}, hh, {
          onSpeechBegin: (...a) => { seen(); return hh.onSpeechBegin && hh.onSpeechBegin(...a); },
          onSpeechStart: (...a) => { seen(); return hh.onSpeechStart && hh.onSpeechStart(...a); },
          onFrame: (...a) => { if (taken && owned) arm(TALK_FRAME_MS); return hh.onFrame && hh.onFrame(...a); },
          onSpeechEnd: (...a) => { done(); return hh.onSpeechEnd && hh.onSpeechEnd(...a); },
          onMisfire: (...a) => { done(); return hh.onMisfire && hh.onMisfire(...a); },
        });
      },
      cancel() { clear(); taken = false; owned = false; },
      get taken() { return taken; },
    };
  }

  /** GET /api/faces -> the installed packs ([] on any failure is NOT returned: it rejects, so the caller can tell failed from empty). */
  async function fetchPacks(fetchFn) {
    const f = fetchFn || (typeof fetch === 'function' ? fetch : null);
    if (!f) throw new Error('no fetch');
    const r = await f('/api/faces', { credentials: 'same-origin' });
    if (!r || !r.ok) throw new Error('HTTP ' + (r && r.status));
    const j = await r.json();
    const list = Array.isArray(j && j.packs) ? j.packs : [];
    return list.filter(p => p && typeof p.id === 'string' && SLUG_RE.test(p.id)).map(p => ({
      id: p.id, name: typeof p.name === 'string' && p.name ? p.name.slice(0, 80) : p.id,
      background: typeof p.background === 'string' && COLOR_RE.test(p.background) ? p.background : '', hasReactions: p.hasReactions === true,
    }));
  }

  /** The panel's selector: Follow agent default / None / Orb / one option per installed pack. A saved pack that is not installed stays selectable (shown as "not installed"). */
  function fillDisplaySelect(doc, select, o) {
    const x = o || {};
    const choice = cleanChoice(x.choice) || 'follow';
    const packs = Array.isArray(x.packs) ? x.packs : [];
    while (select.firstChild) select.removeChild(select.firstChild);
    const add = (value, label) => { const el = doc.createElement('option'); el.value = value; el.textContent = label; select.appendChild(el); };
    add('follow', 'Follow agent default'); add('none', 'None'); add('orb', 'Orb');
    for (const p of packs) add('pack:' + p.id, p.name || p.id);
    if (choice.startsWith('pack:') && !packs.some(p => 'pack:' + p.id === choice)) add(choice, choice.slice(5) + ' (not installed)');
    select.value = choice;
  }

  /** The unobtrusive line in the voice panel about the display (empty when all is well). */
  function displayNote(resolved) {
    const r = resolved || {};
    // offReason decides: a listed pack the server confirmed gone (404/410, failed + 'removed', while a stale list still names it) was removed;
    // one the list lacks is not installed; a pack that failed without that verdict could not load
    if (r.missing) {
      if (r.offReason === 'removed') return r.failed ? 'The chosen character was removed; no display is shown. Your choice is kept.' : 'The chosen character is not installed here; no display is shown. Your choice is kept.';
      return r.failed ? 'The chosen character could not load; no display is shown. Your choice is kept.' : 'The chosen character is not installed here; no display is shown. Your choice is kept.';
    }
    if (r.pending) return 'Looking for the chosen character...';
    return '';
  }

  function validColor(c) { return typeof c === 'string' && COLOR_RE.test(c) ? c : ''; }
  const stripMoodTag = (t) => String(t == null ? '' : t).replace(/^\s*\[([a-z]{3,20})\]\s*/i, (m, w) => (MOODS.includes(w.toLowerCase()) ? '' : m));

  /**
   * createCallDisplay(options) -> display. One per call; created inside the tap that starts the call.
   *   options: window, document, storage, fetch, setTimeout, clearTimeout,
   *     agentDefault()            the agent's default ('none' | 'orb' | 'pack:<slug>')
   *     adopt()                   [{ el, label, wrapClass, show, prepare(), release() }] the call controls to move into the view (the real elements, with a
   *                               placeholder left behind and restored when the view hides or the call ends)
   *     reopenHost()              the call bar's Hang up button (or the element holding it): "Show display" is put INSIDE that bar, right before
 *                               it, while the view is hidden. null/absent while the bar is not on screen. Pages always give it (the button never floats
 *                               over the page's tabs); only without this option (tests, other embedders) is the button appended to the body.
 *     onTalk() / onHangUp()     the optional Interrupt button (device option, off by default; shown only while the agent thinks or speaks) and the Hang up button
   *     onRetryMic()              optional: the microphone was lost (micLost(true)); the slot button then reads "Try the microphone again" and calls this
   *     onChange()                the choice or what is shown changed (the page repaints its panel)
   *     shared                    { ctx, routes, routed } the page keeps across calls (phone page): the audio context and routed media elements outlive the display
   *     onRoutesLost()            the shared context was lost (closed): the page must replace its media element (a captured element is silent for good)
   *     needsContext              true on the phone page: an AudioContext is made (and resumed) in unlock(), inside the tap
   *     output(ctx)               optional: the AudioNode reply audio ends in (the page's loudness chain); default ctx.destination
   *     createVoiceOrb / createFacePlayer   factories (default: the page's globals)
   *   recording (a recorded call): setRecording({ state: 'on' | 'paused' | 'off' | 'error' | 'stopped' }) shows the "Recording" badge (red dot; "Recording paused" with a hollow dot;
   *     "Not recording" for error; "Recording stopped" for stopped; hidden for off, the default) and, for on / paused, the Pause / Resume recording button, which calls
   *     options.onRecordingToggle(wantPaused) (it may return a promise; the page answers by calling setRecording again, so the badge follows the server). The badge sits
   *     in the view's stage while the view is shown, else in the page's call bar (options.reopenHost): on screen in every display mode.
   *   state: setState(name) micLost(on) connLost(on) level(db) thinkingPulse(event) showsPulse() mood(turnKey, mood) reply(kind, turnKey) caption(text) clearCaption() activeFacePack()
   *   audio: routeBufferSource(ctx, src) routeElement(el) audioStart() audioEnd() audioStop() speech(kind)
   *   view: unlock() setChoice(c) setCaptions(b) setInterruptButton(b) hideToChat() showView() syncReopen() hangUp() release() destroy() info()
   */
  function createCallDisplay(options) {
    const o = options || {};
    const win = o.window || (typeof window !== 'undefined' ? window : null);
    const doc = o.document || (win && win.document);
    const setT = o.setTimeout || ((f, ms) => setTimeout(f, ms)), clearT = o.clearTimeout || ((t) => clearTimeout(t));
    const DRAW_POLL_MS = 100, DRAW_WAIT_MS = 8000, DRAW_SLOW_POLL_MS = 1000;   // after a character is ready: how often its picture is checked, for how long, then how often
    const storage = o.storage || null;
    const ORB = () => o.createVoiceOrb || (win && win.createVoiceOrb) || (typeof createVoiceOrb === 'function' ? createVoiceOrb : null);
    const FACE = () => o.createFacePlayer || (win && win.createFacePlayer) || (typeof createFacePlayer === 'function' ? createFacePlayer : null);
    const quiet = (fn) => { try { return fn(); } catch { return undefined; } };

    let prefs = storage ? loadDisplayPrefs(storage) : { choice: 'follow', captions: false, interrupt: false };
    let packs = null, packsState = 'loading', packsToken = 0, unusable = new Set(), removedSlugs = new Set(), viewFailed = false, packsRetried = false, packsRetryTimer = null;
    // The reply's reaction (the mood clip): queued per reply, played ONCE when the whole reply's speech is over (reply('end', key) from the call
    // controller, via the page), never while any reply audio is heard; dropped when the person begins real speech first. rKey is the turn
    // being answered, rDone that its reply ended, rHold that the person is speaking (a false start lifts it), rClosed the turns that are over.
    let rKey = null, rDone = false, rHold = false;
    const rPending = new Map(), rClosed = new Set();
    let destroyed = false, ending = false, visible = true, started = false;
    let micLostOn = false, connLostOn = false, talkMode = 'off';
    let ctrl = 'starting', ctrlDetail = '', helloDone = false, helloOn = false, helloTimer = null, helloWaited = 0, helloPlayed = 0, goodbyeTimer = null;
    let audioOn = false, speakSeen = false, pendingAn = null, deviceSpeech = false;
    let capReserve = 0, capRO = null, capOnResize = null;
    const CAPTION_BOTTOM = 12, CAPTION_GAP = 8;
    let resolved = { kind: 'none', pending: false };
    let held = 0, view = null, viewGen = 0, ui = null, reopen = null, prevFocus = null, adopted = [], audioCtx = null, goodbyeDone = null, silentRoute = null;
    // o.shared (the phone page): { ctx, routes: WeakMap, routed } outlives this display. A media element can have its source made only ONCE and a
    // closed context would silence it for good, so the context and the element routes stay with the page and the next call reuses them.
    const shared = o.shared && typeof o.shared === 'object' ? o.shared : null;
    if (shared && !shared.routes) shared.routes = new WeakMap();
    let elementRoutes = shared ? shared.routes : new WeakMap();
    const analysers = new WeakMap(), moodSeen = new Set();

    const resolveNow = () => resolveDisplay({ choice: prefs.choice, agentDefault: quiet(() => o.agentDefault && o.agentDefault()), packs, packsState, unusable, removed: removedSlugs });
    const wantsPack = () => {
      const eff = prefs.choice === 'follow' ? cleanChoice(quiet(() => o.agentDefault && o.agentDefault()), false) : prefs.choice;
      return typeof eff === 'string' && eff.startsWith('pack:');
    };
    const changed = () => { if (!destroyed) quiet(() => o.onChange && o.onChange()); };

    // ── packs (the installed characters) ──
    function ensurePacks(force) {
      if (destroyed || ending) return Promise.resolve(packs);
      if (!force && (packsState === 'ready' || packsState === 'failed')) return Promise.resolve(packs);
      const my = ++packsToken;   // a late answer for an earlier request (or after hang-up) is ignored
      return fetchPacks(o.fetch).then((list) => {
        if (destroyed || ending || my !== packsToken) return packs;
        packs = list; packsState = 'ready'; refresh(); return packs;
      }, () => {
        if (destroyed || ending || my !== packsToken) return packs;
        packs = []; packsState = 'failed'; refresh();
        // One automatic try after a short wait (a brief network drop); bounded, and never after release or once a newer request exists.
        if (!packsRetried && wantsPack()) {
          packsRetried = true;
          packsRetryTimer = setT(() => { packsRetryTimer = null; if (!destroyed && !ending && my === packsToken && packsState === 'failed') ensurePacks(true); }, PACKS_RETRY_MS);
        }
        return packs;
      });
    }

    // ── the view ──
    const el = (tag, cls, text) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
    const setStyle = (e, k, v) => { if (e && e.style && typeof e.style.setProperty === 'function') e.style.setProperty(k, v); };
    function button(cls, label, onClick, text) {
      const b = el('button', cls, text === undefined ? label : text); b.type = 'button'; b.setAttribute('aria-label', label);
      b.addEventListener('click', (e) => { quiet(() => e.preventDefault && e.preventDefault()); onClick(e); });
      return b;
    }
    function ensureUi() {
      if (ui || !doc) return ui;
      const root = el('div', 'ucd-overlay');
      root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', 'Voice call display');
      const stage = el('div', 'ucd-stage'), host = el('div', 'ucd-host');
      stage.appendChild(host);
      const status = el('div', 'ucd-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
      const note = el('div', 'ucd-note'); note.setAttribute('aria-live', 'off');
      const caption = el('div', 'ucd-caption'); caption.setAttribute('aria-live', 'polite'); caption.hidden = true;
      stage.appendChild(status); stage.appendChild(note); stage.appendChild(caption);
      const drawer = el('div', 'ucd-drawer'); drawer.hidden = true; drawer.setAttribute('role', 'region'); drawer.setAttribute('aria-label', 'Call controls');
      // The drawer's first child: a grab handle and a Close button; a swipe down on it (touch or mouse) closes the drawer. Only the header listens, so the list below scrolls freely.
      const dhead = el('div', 'ucd-drawer-head');
      const grab = el('span', 'ucd-grab'); grab.setAttribute('aria-hidden', 'true');
      const dclose = button('ucd-small ucd-drawer-close', 'Close the controls', () => toggleDrawer(false), 'Close');
      dhead.appendChild(el('span', 'ucd-drawer-head-gap')); dhead.appendChild(grab); dhead.appendChild(dclose);
      drawer.appendChild(dhead);
      {
        const SWIPE_PX = 40;
        let startY = null;
        const begin = (y) => { startY = Number.isFinite(y) ? y : null; };
        const move = (y) => { if (startY !== null && Number.isFinite(y) && y - startY >= SWIPE_PX) { startY = null; toggleDrawer(false); } };
        const touchY = (e) => { const t = e && ((e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0])); return t ? Number(t.clientY) : NaN; };
        dhead.addEventListener('touchstart', (e) => begin(touchY(e)));
        dhead.addEventListener('touchmove', (e) => move(touchY(e)));
        dhead.addEventListener('touchend', (e) => { move(touchY(e)); startY = null; });
        dhead.addEventListener('touchcancel', () => { startY = null; });
        // a mouse drag usually leaves the header: the pointer is captured so its move and release still arrive here
        // never on Close: a captured pointer would take the click away from the button
        dhead.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' || (typeof e.button === 'number' && e.button !== 0) || (e.target && dclose.contains && dclose.contains(e.target))) return; begin(Number(e.clientY)); quiet(() => dhead.setPointerCapture && dhead.setPointerCapture(e.pointerId)); });
        dhead.addEventListener('pointermove', (e) => { if (e.pointerType === 'touch') return; move(Number(e.clientY)); });
        dhead.addEventListener('pointerup', (e) => { if (e.pointerType === 'touch') return; move(Number(e.clientY)); startY = null; quiet(() => dhead.releasePointerCapture && dhead.releasePointerCapture(e.pointerId)); });
        dhead.addEventListener('pointercancel', () => { startY = null; });
        dhead.addEventListener('lostpointercapture', () => { startY = null; });
      }
      stage.addEventListener('click', () => { if (!drawer.hidden) toggleDrawer(false); });
      const bar = el('div', 'ucd-bar');
      const talk = button('ucd-talk', 'Interrupt the reply', () => {
        if (ending) return;
        if (talkMode === 'interrupt') quiet(() => o.onTalk && o.onTalk());
        else if (talkMode === 'mic') quiet(() => o.onRetryMic && o.onRetryMic());
      }, 'Interrupt');
      root.tabIndex = -1; root.setAttribute('tabindex', '-1');
      const hang = button('ucd-hang', 'Hang up', () => { if (!ending) quiet(() => o.onHangUp && o.onHangUp()); }, 'Hang up');
      const back = button('ucd-small ucd-back', 'Back to chat', () => hideToChat(), 'Back to chat');
      const caps = button('ucd-small ucd-caps', 'Captions', () => setCaptions(!prefs.captions), 'Captions');
      const ctl = button('ucd-small ucd-ctl', 'Call controls', () => toggleDrawer(), 'Controls');
      ctl.setAttribute('aria-expanded', 'false');
      const dispWrap = el('label', 'ucd-small ucd-disp'); const dispText = el('span', 'ucd-disp-text', 'Display');
      const disp = el('select', 'ucd-display'); disp.setAttribute('aria-label', 'Display');
      dispWrap.appendChild(dispText); dispWrap.appendChild(disp);
      disp.addEventListener('change', () => { if (!ending) setChoice(disp.value); });
      disp.addEventListener('blur', () => { if (!destroyed) paintChooser(); });   // a list that arrived while it had focus is put in now
      const main = el('div', 'ucd-main'); main.appendChild(talk); main.appendChild(hang);
      const side = el('div', 'ucd-side'); side.appendChild(dispWrap); side.appendChild(back); side.appendChild(caps); side.appendChild(ctl);
      bar.appendChild(main); bar.appendChild(side);
      root.appendChild(stage); root.appendChild(drawer); root.appendChild(bar);
      root.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          quiet(() => { e.preventDefault(); e.stopPropagation(); });
          if (!drawer.hidden) toggleDrawer(false);   // an open drawer closes first; the view stays
          else if (!ending) hideToChat();
          return;
        }
        if (e.key === 'Tab') trapTab(e);
      });
      ui = { root, stage, host, status, note, caption, drawer, bar, talk, hang, back, caps, ctl, disp };
      // the caption band's size drives the character's reserve: one bounded observer (or a window resize listener when there is none), released in finish()
      const RO = o.ResizeObserver || (win && win.ResizeObserver);
      if (RO) { try { capRO = new RO(() => { if (!destroyed) syncReserve(); }); capRO.observe(caption); capRO.observe(stage); } catch { if (capRO) quiet(() => capRO.disconnect()); capRO = null; } }   // a partly registered observer is released before the resize-listener fallback
      if (!capRO && win && typeof win.addEventListener === 'function') { capOnResize = () => { if (!destroyed) syncReserve(); }; win.addEventListener('resize', capOnResize); }
      paintCaps(); paintTalk(); paintStatus(); badge(held);
      if (packsState === 'loading' && packsToken === 0) ensurePacks();   // a call showing the Orb also lists the installed characters in its Display chooser (once: a request already on its way is not replaced)
      return ui;
    }
    // The slot button before Hang up: Interrupt (only with the device option on, while the agent thinks/speaks), Try the microphone again (mic lost), or off (invisible, inert, still in the layout).
    function paintTalk() {
      if (!ui) return;
      const live = !ending && ctrl !== 'starting' && ctrl !== 'ended';
      let mode = 'off';
      if (live && micLostOn && typeof o.onRetryMic === 'function') mode = 'mic';
      else if (live && prefs.interrupt === true && (ctrl === 'thinking' || ctrl === 'speaking')) mode = 'interrupt';
      talkMode = mode;
      const t = ui.talk;
      t.setAttribute('data-ucd-mode', mode);
      if (mode === 'off') {
        t.setAttribute('data-ucd-off', ''); t.setAttribute('aria-hidden', 'true'); t.setAttribute('tabindex', '-1');
        if (doc && doc.activeElement === t) quiet(() => ui.root.focus());
      } else {
        for (const k of ['data-ucd-off', 'aria-hidden', 'tabindex']) quiet(() => t.removeAttribute(k));
        const label = mode === 'mic' ? 'Try the microphone again' : 'Interrupt the reply';
        t.textContent = mode === 'mic' ? label : 'Interrupt'; t.setAttribute('aria-label', label);
      }
    }
    // The Display chooser: refilled only when the choice or the installed list changed (paintStatus runs on every state change), never while it has focus.
    let chooserKey = null;
    function paintChooser() {
      if (!ui || !ui.disp || doc.activeElement === ui.disp) return;
      const list = Array.isArray(packs) ? packs : [];
      const key = prefs.choice + '|' + list.map(p => p.id + ':' + p.name).join(',');
      if (key === chooserKey) return;
      chooserKey = key;
      fillDisplaySelect(doc, ui.disp, { choice: prefs.choice, packs: list });
    }
    function micLost(on) {
      if (destroyed || ending) return;
      micLostOn = !!on;
      paintTalk(); paintStatus();
    }
    function connLost(on) {   // the connection to the server is lost / back: the status line says so
      if (destroyed || ending) return;
      connLostOn = !!on;
      paintStatus();
    }
    function trapTab(e) {
      const list = [recUi && recUi.pause.parentNode === recUi.wrap && recUi.wrap.parentNode === ui.stage ? recUi.pause : null, talkMode !== 'off' ? ui.talk : null, ui.hang, ui.disp, ui.back, ui.caps, ui.ctl].filter(b => b && !b.disabled);
      if (!list.length) return;
      const items = list.slice();
      if (!ui.drawer.hidden && typeof ui.drawer.querySelectorAll === 'function') for (const n of Array.from(ui.drawer.querySelectorAll('button, input, select, textarea, a[href]'))) items.push(n);
      const first = items[0], last = items[items.length - 1], active = doc.activeElement;
      if (e.shiftKey && (active === first || !items.includes(active))) { quiet(() => e.preventDefault()); quiet(() => last.focus()); }
      else if (!e.shiftKey && (active === last || !items.includes(active))) { quiet(() => e.preventDefault()); quiet(() => first.focus()); }
    }
    function paintCaps() {
      if (!ui) return;
      ui.caps.setAttribute('aria-pressed', prefs.captions ? 'true' : 'false');
      ui.caps.textContent = prefs.captions ? 'Captions on' : 'Captions off';
      if (!prefs.captions) { ui.caption.textContent = ''; ui.caption.hidden = true; }
      syncReserve();
    }
    // Caption reserve: a shown character's host stops above the caption band so the band never covers its feet. The band's real height is
    // measured (offsetHeight, else getBoundingClientRect); with no layout (no measurement) it is estimated from the stage size and the text:
    // font clamp(20px, 4.2% of the stage width, 40px), line height 1.25, 24px side offsets + 28px padding, 0.6em per character, 20px padding, at most 40% of the stage.
    // reserve = band height + 12px (the band's bottom offset) + 8px gap; 0 for the Orb, None, no caption text and captions off.
    function captionHeight() {
      const c = ui.caption; let h = 0;
      quiet(() => { h = Number(c.offsetHeight) || 0; if (!(h > 0) && typeof c.getBoundingClientRect === 'function') h = Number(c.getBoundingClientRect().height) || 0; });
      if (h > 0) return h;
      const sw = Number(ui.stage.clientWidth) || 640, sh = Number(ui.stage.clientHeight) || 360;
      const fs = Math.max(20, Math.min(40, sw * 0.042)), perLine = Math.max(4, Math.floor(Math.max(40, sw - 52) / (fs * 0.6)));
      const lines = Math.max(1, Math.ceil(String(c.textContent || '').length / perLine));
      return Math.min(Math.ceil(lines * fs * 1.25 + 20), Math.floor(sh * 0.4));
    }
    // A long caption fills the band up to its 40% cap and then scrolls: the newest line (the end of the text) is kept fully in view after every
    // caption change and every resize (syncReserve runs for both). scrollTop beyond the maximum is clamped by the browser.
    function scrollNewest() {
      const c = ui && ui.caption;
      if (!c || c.hidden || !c.textContent) return;
      quiet(() => { c.scrollTop = Number(c.scrollHeight) || 0; });
    }
    function syncReserve() {
      if (!ui) return;
      scrollNewest();
      let r = 0;
      if (view && view.kind === 'pack' && prefs.captions && !ui.caption.hidden && ui.caption.textContent) r = Math.round(captionHeight() + CAPTION_BOTTOM + CAPTION_GAP);
      if (r === capReserve) return;
      capReserve = r; setStyle(ui.stage, '--ucd-caption-reserve', r + 'px');
    }
    function paintStatus() {
      if (!ui) return;
      const t = connLostOn && !ending ? 'Connection lost' : micLostOn && !ending ? 'Microphone lost' : ctrl === 'standby' && ctrlDetail ? 'Waiting for “' + ctrlDetail + '”' : (STATE_TEXT[ctrl] || ctrl);
      ui.status.textContent = ending ? 'Goodbye' : t;
      paintChooser();
      ui.note.textContent = displayNote(resolved);
      ui.note.hidden = !ui.note.textContent;
    }
    function toggleDrawer(force) {
      if (!ui) return;
      const open = typeof force === 'boolean' ? force : ui.drawer.hidden;
      const wasOpen = !ui.drawer.hidden;
      ui.drawer.hidden = !open;
      ui.ctl.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (wasOpen && !open) quiet(() => ui.ctl.focus());   // closing hands focus back to the Controls button
    }

    // The real controls move into the view (no copies, no duplicate ids) and go back to where they were.
    function adoptControls() {
      if (adopted.length || !ui) return;
      let list = [];
      try { list = (o.adopt && o.adopt()) || []; } catch { list = []; }
      for (const d of list) {
        const node = d && d.el;
        if (!node || !node.parentNode) continue;
        const ph = el('span', 'ucd-placeholder'); ph.hidden = true;
        const rec = { node, ph, hidden: node.hidden, wrap: null, d };
        try {
          node.parentNode.insertBefore(ph, node);
          const sec = el('div', 'ucd-section' + (d.wrapClass ? ' ' + d.wrapClass : ''));
          if (d.label) { const h = el('div', 'ucd-section-title', d.label); sec.appendChild(h); }
          sec.appendChild(node); rec.wrap = sec; ui.drawer.appendChild(sec);
          if (typeof d.prepare === 'function') quiet(() => d.prepare());
          if (d.show) node.hidden = false;
          adopted.push(rec);
        } catch { quiet(() => { if (ph.parentNode) { ph.parentNode.insertBefore(node, ph); ph.remove(); } }); }
      }
    }
    function restoreControls() {
      const list = adopted; adopted = [];
      for (const r of list) {
        quiet(() => {
          if (r.d && typeof r.d.release === 'function') quiet(() => r.d.release());
          if (r.d && r.d.show) r.node.hidden = r.hidden;
          if (r.ph.parentNode) { r.ph.parentNode.insertBefore(r.node, r.ph); r.ph.remove(); }
          else if (r.node.parentNode) r.node.parentNode.removeChild(r.node);   // its home is gone (the chat was closed): nothing keeps it
          if (r.wrap && r.wrap.parentNode) r.wrap.parentNode.removeChild(r.wrap);
        });
      }
    }

    function mount() {   // the overlay is in the page only while a character or the orb is shown
      if (!ui || !doc || !doc.body) return;
      if (!ui.root.parentNode) {
        prevFocus = doc.activeElement || null;
        doc.body.appendChild(ui.root);
      }
      ui.root.hidden = false;
      placeRec();
    }
    function unmount() {
      stopArming();
      if (ui && ui.root.parentNode) ui.root.parentNode.removeChild(ui.root);
      placeRec();
    }
    // "Show display" lives in the call bar beside Hang up (o.reopenHost). The bar can be moved (into the view while it is shown) or
    // re-made by the page, so the button is placed again whenever it is asked for (syncReopen) and removed when the view is shown.
    function showReopen(on) {
      if (!on) { if (reopen) { quiet(() => reopen.parentNode && reopen.parentNode.removeChild(reopen)); reopen = null; } return; }
      if (!doc || !doc.body) return;
      if (typeof o.reopenHost !== 'function') {   // no bar to live in (tests, other embedders): the old fixed button
        if (reopen && reopen.parentNode) return;
        reopen = reopen || button('ucd-reopen ucd-reopen-float', 'Show the call display', () => showView(), 'Show display');
        doc.body.appendChild(reopen);
        return;
      }
      let host = null; try { host = o.reopenHost(); } catch { host = null; }
      const par = host && host.parentNode;
      if (!par || (ui && ui.root && ui.root.contains && ui.root.contains(host))) { if (reopen && reopen.parentNode) quiet(() => reopen.parentNode.removeChild(reopen)); return; }   // no bar on screen: nothing floats
      if (!reopen) reopen = button('ucd-reopen', 'Show the call display', () => showView(), 'Show display');
      if (reopen.parentNode === par && reopen.nextSibling === host) return;
      par.insertBefore(reopen, host);
    }
    function syncReopen() { if (!destroyed && !ending && started && !visible && resolved.kind !== 'none') showReopen(true); placeRec(); }

    // ── the recording indicator (a call whose voice is recorded) ──
    // One small element (a badge and the Pause button), made when setRecording first says something. It sits in the view's stage (top right: Hang up is in
    // the bar below) while the view is shown, and in the page's call bar (before "Show display" / Hang up) while it is not (Back to chat, or a display of None),
    // so it is on screen in every display mode and never covers Hang up. recState: 'off' (hidden, the default) | 'on' | 'paused' | 'error' | 'stopped'.
    let recState = 'off', recUi = null, recBusy = false;
    // 'trouble': still recording, but some speech has not reached the hub yet (it keeps trying): a red dot and Pause stay.
    const REC_TEXT = { on: 'Recording', trouble: 'Recording (some speech not sent yet)', paused: 'Recording paused', error: 'Not recording', stopped: 'Recording stopped' };
    function paintRec() {
      if (!recUi) return;
      const on = recState === 'on' || recState === 'trouble', paused = recState === 'paused';
      recUi.wrap.setAttribute('data-state', recState);
      recUi.text.textContent = REC_TEXT[recState] || '';
      recUi.dot.hidden = !(on || paused);   // a red dot while recording, a hollow one while paused, none when it is not recording
      recUi.pause.hidden = !(on || paused);
      recUi.pause.textContent = paused ? 'Resume recording' : 'Pause recording';
      recUi.pause.setAttribute('aria-label', paused ? 'Resume recording' : 'Pause recording');
      recUi.pause.disabled = recBusy || ending;
    }
    function placeRec() {
      if (!recUi) return;
      const gone = () => { if (recUi.wrap.parentNode) quiet(() => recUi.wrap.parentNode.removeChild(recUi.wrap)); };
      if (destroyed || recState === 'off') { gone(); return; }
      if (ui && ui.root.parentNode && !ui.root.hidden) { recUi.wrap.setAttribute('data-place', 'stage'); if (recUi.wrap.parentNode !== ui.stage) ui.stage.appendChild(recUi.wrap); return; }
      if (!doc || !doc.body) return;
      if (typeof o.reopenHost !== 'function') { if (recUi.wrap.parentNode !== doc.body) doc.body.appendChild(recUi.wrap); return; }   // no bar to live in (tests, other embedders)
      let host = null; try { host = o.reopenHost(); } catch { host = null; }
      const par = host && host.parentNode;
      if (!par || (ui && ui.root && ui.root.contains && ui.root.contains(host))) { gone(); return; }   // no bar on screen
      // Its own line ABOVE the bar's button row, never inside it: on a narrow phone a badge in the row pushed Hang up off the screen.
      const row = par.parentNode;
      if (!row) { gone(); return; }
      recUi.wrap.setAttribute('data-place', 'bar');
      if (recUi.wrap.parentNode === row && recUi.wrap.nextSibling === par) return;
      row.insertBefore(recUi.wrap, par);
    }
    // display.setRecording({ state }): 'on' | 'trouble' | 'paused' | 'off' | 'error' | 'stopped'. Anything else is 'off' (hidden).
    function setRecording(v) {
      if (destroyed) return;
      const s = v && typeof v === 'object' ? v.state : v;
      recState = REC_TEXT[s] ? s : 'off';
      if (!recUi && recState !== 'off' && doc) {
        const wrap = el('div', 'ucd-rec'); wrap.setAttribute('role', 'status'); wrap.setAttribute('aria-live', 'polite');
        const dot = el('span', 'ucd-rec-dot'); dot.setAttribute('aria-hidden', 'true');
        const text = el('span', 'ucd-rec-text');
        const pause = button('ucd-rec-pause', 'Pause recording', () => {
          if (ending || recBusy || (recState !== 'on' && recState !== 'trouble' && recState !== 'paused') || typeof o.onRecordingToggle !== 'function') return;
          recBusy = true; paintRec();
          let p; try { p = Promise.resolve(o.onRecordingToggle(recState !== 'paused')); } catch { p = Promise.resolve(); }   // true = pause, false = resume; the page answers with setRecording
          p.then(() => {}, () => {}).then(() => { recBusy = false; paintRec(); });
        }, 'Pause recording');
        wrap.appendChild(dot); wrap.appendChild(text); wrap.appendChild(pause);
        recUi = { wrap, dot, text, pause };
      }
      paintRec(); placeRec();
      changed();
    }

    let drawTimer = null;
    // First frame: a character's overlay is put in the page "arming" (data-ucd-arming: transparent and click-through, see ui-call-display.css), the
    // player is sized synchronously in the page (impl.resize, no wait for the ResizeObserver callback), and the reveal comes after two animation
    // callbacks, with an ARM_MAX_MS timer as the fallback when frames stop (hidden tab, occluded window) and timers still run. This gives the browser
    // two frames to lay out and paint the picture before anyone sees it (a run in Chrome once showed a frame with the stage colour and the edge glow
    // but no stage layer); neither mechanism guarantees that rasterising has finished. Without requestAnimationFrame it is revealed at once.
    const ARM_MAX_MS = 250;
    let armRaf = null, armTimer = null;
    function stopArming() {
      if (armRaf !== null) { const id = armRaf; armRaf = null; quiet(() => win && typeof win.cancelAnimationFrame === 'function' && win.cancelAnimationFrame(id)); }
      if (armTimer !== null) { clearT(armTimer); armTimer = null; }
      if (ui) quiet(() => ui.root.removeAttribute && ui.root.removeAttribute('data-ucd-arming'));
    }
    function teardownView() {
      if (drawTimer !== null) { clearT(drawTimer); drawTimer = null; }
      stopArming();
      viewFailed = false;   // a new view (choice, show, rebuild) starts without the old view's could-not-load
      viewGen++;
      const v = view; view = null;
      if (v && v.impl) quiet(() => v.impl.destroy());
      if (ui) { while (ui.host.firstChild) quiet(() => ui.host.removeChild(ui.host.firstChild)); syncReserve(); }
    }
    function buildView() {
      teardownView();
      resolved = resolveNow();
      paintStatus();
      if (destroyed || ending || !doc) return;
      if (resolved.kind === 'none') { restoreControls(); unmount(); showReopen(false); changed(); return; }
      if (!visible) { restoreControls(); unmount(); showReopen(started); changed(); return; }
      ensureUi();
      if (resolved.kind === 'pack') { restoreControls(); unmount(); }
      unlock();   // a choice made in a tap (the panel's selector) may need the phone's audio context too
      let impl = null;
      const my = viewGen;
      try {
        if (resolved.kind === 'orb') { const f = ORB(); impl = f ? f(ui.host, { label: 'Voice orb', window: win }) : null; setStyle(ui.stage, '--ucd-bg', ''); }
        else { const f = FACE(); impl = f ? f(ui.host, { packId: resolved.slug, label: resolved.name || 'Animated character', fit: 'contain', glowBeyond: true /* the stage clips: the edge glow may run past the host into the caption reserve */, window: win, onBackground: (c) => { if (!destroyed && !ending && my === viewGen && ui) setStyle(ui.stage, '--ucd-bg', validColor(c)); } /* the player's own background (its poster's outer ring) is the stage colour too, so the caption reserve blends; a stale view is ignored */, onLost: () => { if (!destroyed && !ending && my === viewGen && view && view.kind === 'pack') markUnusable(view.slug, true); } }) : null; /* onLost: files removed mid-call -> ordinary call bar, choice kept; the next call resolves it missing -> None */ setStyle(ui.stage, '--ucd-bg', validColor(resolved.pack && resolved.pack.background)); }
      } catch { impl = null; }
      if (!impl) { markUnusable(resolved.slug || ''); return; }
      view = { kind: resolved.kind, slug: resolved.slug || '', impl };
      // A character is never put on screen without a picture to show (no blank paper): the overlay waits until the player reports a real
      // drawable frame (its still or a playing clip). Meanwhile the ordinary call bar stays where it is, fully usable. The wait is bounded:
      // a pack the server CONFIRMS gone (404/410 on its manifest, at boot or by the player's probe) becomes None (the choice stays saved); a pack that
      // merely fails or is slow (network, timeout, 5xx, no picture yet) never does: the overlay just waits for the picture, the call bar stays usable.
      let shown = false;
      const present = () => {
        if (destroyed || my !== viewGen || !view || !visible || shown) return;
        shown = true; viewFailed = false;
        const raf = win && typeof win.requestAnimationFrame === 'function' ? (f) => win.requestAnimationFrame(f) : null;
        let revealed = false;
        const reveal = () => {   // once: the second animation frame or the ARM_MAX_MS fallback, whichever comes first
          if (revealed) return; revealed = true;
          if (destroyed || my !== viewGen || !view) return;   // torn down meanwhile (teardownView already cancelled and cleared the mark)
          stopArming();   // the other trigger is cancelled, the mark removed
          if (!ending) { showReopen(false); adoptControls(); }
          changed();
        };
        if (raf) quiet(() => ui.root.setAttribute('data-ucd-arming', ''));
        mount();
        quiet(() => impl.resize && impl.resize());   // laid out now, in the page, not when the ResizeObserver callback gets to it
        if (!raf) { reveal(); return; }
        try { armRaf = raf(() => { if (my !== viewGen) return; try { armRaf = raf(reveal); } catch { reveal(); } }); } catch { reveal(); return; }   // a stale first callback never touches a newer view's frame
        armTimer = setT(reveal, ARM_MAX_MS);
      };
      if (resolved.kind === 'pack' && impl.ready && typeof impl.ready.then === 'function') {
        let waited = 0;
        // The overlay appears as soon as the player's picture is really painted (pictureReady true), not when the beak patches and speaking
        // tracks have also arrived (`ready`). pictureReady false (no picture yet / too slow) changes nothing: the ready path below decides, bounded as before.
        // A later `ready` rejection ends in None only when it carries a 404/410 verdict (the choice stays saved); a stale view (changed or destroyed meanwhile) is ignored.
        if (impl.pictureReady && typeof impl.pictureReady.then === 'function') {
          impl.pictureReady.then(ok => {
            if (ok !== true || destroyed || ending || my !== viewGen || shown) return;
            let d = true; try { const i = typeof impl.getInfo === 'function' ? impl.getInfo() : null; if (i && i.drawable === false) d = false; } catch { d = true; }
            if (!d) return;
            if (drawTimer !== null) { clearT(drawTimer); drawTimer = null; }
            present();
          }, () => {});
        }
        const drawn = () => { let d = true; try { const i = typeof impl.getInfo === 'function' ? impl.getInfo() : null; if (i && i.drawable === false) d = false; } catch { d = true; } return d; };
        const check = () => {
          drawTimer = null;
          if (destroyed || ending || my !== viewGen || shown) return;
          if (drawn()) { present(); return; }
          // After DRAW_WAIT_MS without a picture (a pack without a poster on a slow link) the check goes on every DRAW_SLOW_POLL_MS until the picture is
          // drawn or the view is torn down (teardownView clears this one timer; the call ending tears it down): a picture that arrives late still opens it.
          // No verdict either way: nothing is marked unusable.
          waited += waited >= DRAW_WAIT_MS ? DRAW_SLOW_POLL_MS : DRAW_POLL_MS;
          drawTimer = setT(check, waited >= DRAW_WAIT_MS ? DRAW_SLOW_POLL_MS : DRAW_POLL_MS);
        };
        // Only a confirmed missing pack (the player tags the MANIFEST's 404/410 as packGone; any other rejection, whatever its status) becomes None
        // (the choice stays saved). An ordinary failure is no verdict: the view is kept and nothing is marked unusable, so the player is reported as
        // could-not-load while nothing is drawable; hiding and showing the display, or choosing again, builds a fresh view and tries again (no timer, no loop).
        impl.ready.then(() => { check(); }, (e) => {
          if (destroyed || my !== viewGen) return;
          if (e && e.packGone === true && (e.status === 404 || e.status === 410)) { markUnusable(view ? view.slug : '', true); return; }
          if (!shown && !drawn()) { viewFailed = true; changed(); }
        });
      } else { mount(); showReopen(false); adoptControls(); }
      if (audioOn) {   // a sentence is being heard right now (the view was hidden or changed mid-sentence): attach to the audio that is really playing
        if (pendingAn) { deviceSpeech = false; quiet(() => impl.setAnalyser && impl.setAnalyser(pendingAn)); }
        else if (silentRoute) { /* routed but not audible yet: the analyser comes when the context runs */ }
        else { deviceSpeech = true; quiet(() => impl.speechEvent && impl.speechEvent('start')); }
      }
      syncReserve();
      applyState();
      maybeHello();
      if (doc.activeElement !== ui.disp) quiet(() => (talkMode !== 'off' ? ui.talk : ui.root).focus());   // a choice made with the arrow keys on the Display select keeps its focus
      changed();
    }
    function markUnusable(slug, removed) {   // removed: the server confirmed it gone (offReason 'removed'); otherwise it could not load
      if (slug) { unusable.add(slug); if (removed === true) removedSlugs.add(slug); else removedSlugs.delete(slug); }
      teardownView();
      resolved = resolveNow();
      paintStatus();
      restoreControls(); unmount(); showReopen(false);
      changed();
    }
    function refresh() {
      if (destroyed || ending) return;
      const next = resolveNow();
      const same = view && next.kind === resolved.kind && (next.slug || '') === (resolved.slug || '');
      if (same || (!view && next.kind === 'none' && resolved.kind === 'none' && next.pending === resolved.pending && next.missing === resolved.missing)) { resolved = next; paintStatus(); changed(); return; }
      buildView();
    }

    // ── state ──
    function applyState() {
      if (!view) return;
      const s = mapDisplayState(ctrl, { audio: speakSeen, hello: helloOn });
      quiet(() => view.impl.setState(s));
    }
    function endHello() {
      if (helloTimer !== null) { clearT(helloTimer); helloTimer = null; }
      if (!helloOn) return;
      helloOn = false; applyState();
    }
    function maybeHello() {   // once, when the call is really up; it never holds the microphone (the controller listens either way) and hearing cancels it
      if (helloDone || !view || ctrl === 'starting' || ctrl === 'ended') return;
      helloDone = true;
      if (ctrl !== 'listening') return;
      let ok = false;
      try { ok = view.impl.react('hello') === true; } catch { ok = false; }
      if (!ok) return;
      helloOn = true; helloWaited = HELLO_MS; helloPlayed = 0;
      helloTimer = setT(helloTick, HELLO_MS);
      applyState();
    }
    // The hello's end. A player that reports it (getInfo().helloWaiting / helloPlaying) keeps hello until its clip has ARRIVED (bounded by
    // HELLO_WAIT_MS) and then lets it play out (bounded by HELLO_MS), so a slow start no longer swallows it; hearing the person
    // (setState hearing/thinking/speaking) still ends it at once through endHello(). Anything else: the plain timer.
    function helloTick() {
      helloTimer = null;
      if (!helloOn) return;
      let i = null; try { i = view && typeof view.impl.getInfo === 'function' ? view.impl.getInfo() : null; } catch { i = null; }
      if (i && typeof i.helloWaiting === 'boolean' && typeof i.helloPlaying === 'boolean') {
        if (i.helloWaiting && !i.helloPlaying && helloWaited < HELLO_WAIT_MS) { helloWaited += HELLO_POLL_MS; helloTimer = setT(helloTick, HELLO_POLL_MS); return; }
        if (i.helloPlaying && helloPlayed < HELLO_MS) { helloPlayed += HELLO_POLL_MS; helloTimer = setT(helloTick, HELLO_POLL_MS); return; }
      }
      endHello();
    }
    function setState(name, detail) {
      if (destroyed || ending) return;
      ctrl = String(name || ''); ctrlDetail = typeof detail === 'string' ? detail : '';
      if (ctrl !== 'speaking') { speakSeen = false; clearCaption(); }   // the reply is over (or cut): its last sentence does not stay on screen
      if (ctrl === 'hearing' || ctrl === 'thinking' || ctrl === 'speaking') endHello();
      if (ctrl === 'ended') { endHello(); }
      if (ctrl === 'speaking' && audioOn) speakSeen = true;
      paintTalk(); paintStatus();
      applyState();
      if (ctrl === 'listening') maybeHello();
      tryReact();   // a mood held back while the display still showed speaking
    }
    // Held items (Now / Later / Skip) wait in the controls drawer: the Controls button says how many.
    function badge(n) {
      held = Math.max(0, Number(n) | 0);
      if (ui) { ui.ctl.textContent = held ? 'Controls (' + held + ')' : 'Controls'; ui.ctl.setAttribute('aria-label', held ? 'Call controls, ' + held + ' waiting' : 'Call controls'); }
    }
    // One thinking pulse of the call's clock { at, attackMs, decayMs, strength }, passed on unchanged to a view that takes it (the orb's
    // thinkingPulse); the Character player has none and ignores it. Nothing after the call ended.
    function showsPulse() { return !destroyed && !ending && !!view; }   // a view is up that takes the thinking clock's pulses (None, hidden: no)
    function thinkingPulse(ev) { if (!destroyed && !ending && view && ev) quiet(() => view.impl.thinkingPulse && view.impl.thinkingPulse(ev)); }
    function level(db) { if (!destroyed && !ending && view) quiet(() => view.impl.setMicLevel && view.impl.setMicLevel(levelFromDb(db))); }

    // ── reply audio ──
    const outputFor = (ctx) => { let n = null; if (typeof o.output === 'function') { try { n = o.output(ctx); } catch { n = null; } } return n || ctx.destination; };   // where reply audio ends: the page's output node (its loudness chain) or the speakers
    function routeBufferSource(ctx, src) {
      const direct = () => { src.connect(outputFor(ctx)); return false; };
      pendingAn = null;
      if (destroyed || ending || !view || !ctx || typeof ctx.createAnalyser !== 'function') return direct();
      try {
        let an = analysers.get(ctx);
        if (!an) { an = ctx.createAnalyser(); an.fftSize = 2048; an.smoothingTimeConstant = 0; an.connect(outputFor(ctx)); analysers.set(ctx, an); }
        src.connect(an);   // source -> analyser -> destination: the only path, so nothing plays twice
        pendingAn = an;
        return true;
      } catch { pendingAn = null; quiet(direct); return false; }
    }
    function routeElement(elm) {
      pendingAn = null; silentRoute = null;
      if (destroyed || ending || !elm) return false;
      const ctx = shared ? shared.ctx : audioCtx;
      let route = elementRoutes.get(elm);
      if (route) {   // a media element can have its source made only once: reused for every sentence (and every call, with a shared route)
        if (!ctx || route.ctx !== ctx || ctx.state === 'closed') return false;
        pendingAn = route.an;
        if (ctx.state !== 'running') {   // the element is captured, so it is silent until the context runs: resume, and claim audio only when it does
          pendingAn = null; silentRoute = route;
          quiet(() => { const r = ctx.resume && ctx.resume(); if (r && r.then) r.then(() => { if (silentRoute !== route || destroyed || ending) return; silentRoute = null; if (ctx.state !== 'running') return; pendingAn = route.an; if (audioOn && view) { deviceSpeech = false; quiet(() => view.impl.setAnalyser && view.impl.setAnalyser(route.an)); } }, () => {}); });
        }
        return pendingAn !== null;
      }
      if (!view || !ctx) return false;
      if (ctx.state !== 'running') { quiet(() => { const r = ctx.resume && ctx.resume(); if (r && r.catch) r.catch(() => {}); }); return false; }   // never route (and so mute) through a context that is not running
      try {
        const srcNode = ctx.createMediaElementSource(elm), an = ctx.createAnalyser();
        an.fftSize = 2048; an.smoothingTimeConstant = 0;
        srcNode.connect(an); an.connect(outputFor(ctx));
        route = { srcNode, an, ctx }; elementRoutes.set(elm, route); if (shared) shared.routed = (shared.routed || 0) + 1; pendingAn = an;
        return true;
      } catch { return false; }
    }
    function audioStart() {   // reply audio really began (not when the speech was fetched)
      if (destroyed || ending) return;
      audioOn = true;
      if (ctrl === 'speaking') speakSeen = true;
      if (view) {
        if (pendingAn) { deviceSpeech = false; quiet(() => view.impl.setAnalyser && view.impl.setAnalyser(pendingAn)); }
        else if (!silentRoute) { deviceSpeech = true; speech('start'); }   // a captured element behind a suspended context is silent: no beak until it is heard
      }
      applyState();
    }
    function audioEnd() {   // a sentence ended (or was cut): the beak closes at once
      audioOn = false;
      if (view) {
        quiet(() => view.impl.setAnalyser && view.impl.setAnalyser(null));
        if (deviceSpeech) { deviceSpeech = false; speech('end'); }
      }
      deviceSpeech = false;
      pendingAn = null;
      tryReact();   // an end that came after the reply was over (nothing plays while reply audio is heard)
    }
    function audioStop() { audioEnd(); if (view && view.kind === 'pack') quiet(() => view.impl.speechEvent && view.impl.speechEvent('cancel')); }
    function speech(kind) {   // device voice hooks: start | boundary | end | pause | resume | cancel
      if (destroyed || ending) return;
      // The device voice's state is tracked even with no view (None, hidden, or a pack still being chosen), so a view that opens
      // mid-sentence attaches to what is really being heard and an end that happened while hidden is never lost.
      if (kind === 'start' || kind === 'resume') { audioOn = true; deviceSpeech = true; if (ctrl === 'speaking') { speakSeen = true; applyState(); } }
      else if (kind === 'end' || kind === 'cancel' || kind === 'pause') { audioOn = false; deviceSpeech = false; }
      if (!view) return;
      let k = kind;
      if (view.kind === 'orb') { if (k === 'cancel' || k === 'pause') k = 'end'; else if (k === 'resume') k = 'boundary'; }
      quiet(() => view.impl.speechEvent && view.impl.speechEvent(k));
      if (kind === 'end') tryReact();   // the device voice's last sentence ended after the reply was over
    }

    // ── moods, captions ──
    // The mood is QUEUED for its reply (once per turn: the SSE chunk and the hub event may both arrive; stale after hang-up, and for a turn that is
    // over). It plays only at the reply's end (reply('end')), or at once when the reply already ended (a late mood). True when it was accepted.
    function mood(turnKey, m) {
      if (destroyed || ending) return false;
      const word = typeof m === 'string' ? m.toLowerCase() : '';
      if (!MOODS.includes(word)) return false;
      const key = String(turnKey == null ? '' : turnKey);
      if (moodSeen.has(key) || rClosed.has(key)) return false;
      moodSeen.add(key);
      if (moodSeen.size > 64) moodSeen.delete(moodSeen.values().next().value);
      if (!view) return false;
      rPending.set(key, word);
      if (rPending.size > 8) rPending.delete(rPending.keys().next().value);
      if (rDone && rKey === key) tryReact();
      return true;
    }
    function tryReact() {   // the one place a mood clip is started: the reply is over, nobody speaks, no reply audio is heard
      if (destroyed || ending || !view || rHold || !rDone || audioOn) return false;
      // The controller ends the reply BEFORE it settles to listening, so the player still shows speaking and would drop the clip:
      // the mood stays pending (not consumed) until the mapped display state has left speaking; setState retries.
      if (mapDisplayState(ctrl, { audio: speakSeen, hello: helloOn }) === 'speaking') return false;
      const word = rPending.get(rKey);
      if (!word) return false;
      rPending.delete(rKey);
      return quiet(() => view.impl.react(word)) === true;
    }
    const cancelReaction = () => { if (view) quiet(() => view.impl.cancelReaction && view.impl.cancelReaction()); };
    // The reply's boundaries, from the call controller (ui.reply) and the page (the key of the turn):
    //   'turn' a new turn of the call was sent (older turns are over)   'start' the person's message is on its way (a new reply is expected)
    //   'end' the whole reply (speech, or just its text when nothing is spoken) is over, before listening   'drop' the person began real speech
    //   'resume' that was a false start
    function reply(kind, key) {
      if (destroyed || ending) return;
      const k = String(key == null ? '' : key);
      if (kind === 'turn') {
        if (rKey !== null && rKey !== k) { rClosed.add(rKey); if (rClosed.size > 64) rClosed.delete(rClosed.values().next().value); }
        for (const p of Array.from(rPending.keys())) if (p !== k) { rClosed.add(p); rPending.delete(p); }
        rKey = k; rDone = false; rHold = false; cancelReaction();
      } else if (kind === 'start') { rDone = false; rHold = false; }
      else if (kind === 'end') {
        rKey = k; rDone = true;
        if (!view) rPending.delete(k); else tryReact();
      } else if (kind === 'drop') { rHold = true; cancelReaction(); }
      else if (kind === 'resume') { rHold = false; tryReact(); }
    }
    function caption(text) {
      if (destroyed || ending || !ui || !prefs.captions || !view) return;
      const t = stripMoodTag(text).replace(/\s+/g, ' ').trim().slice(0, CAPTION_MAX);
      ui.caption.textContent = t; ui.caption.hidden = !t;
      syncReserve();
    }
    function clearCaption() { if (ui) { ui.caption.textContent = ''; ui.caption.hidden = true; syncReserve(); } }
    function activeFacePack() {   // null while the view could not load (viewFailed): nothing is shown, so chat requests do not ask for mood tags
      return !destroyed && !ending && visible && !viewFailed && view && view.kind === 'pack' && resolved.pack && resolved.pack.hasReactions === true ? view.slug : null;
    }

    // ── choice, captions, visibility ──
    function setChoice(c) {
      const choice = cleanChoice(c);
      if (!choice) return false;
      prefs = storage ? saveDisplayPrefs(storage, { choice }) : Object.assign({}, prefs, { choice });
      if (destroyed || ending) return true;
      if (choice.startsWith('pack:') || wantsPack()) { if (packsState === 'loading') ensurePacks(); else if (packsState === 'failed') ensurePacks(true); }   // choosing again retries a failed list
      visible = true;   // choosing a display shows it
      buildView();
      return true;
    }
    function setInterruptButton(on) {
      prefs = storage ? saveDisplayPrefs(storage, { interrupt: !!on }) : Object.assign({}, prefs, { interrupt: !!on });
      paintTalk();
      changed();
    }
    function setCaptions(b) {
      prefs = storage ? saveDisplayPrefs(storage, { captions: !!b }) : Object.assign({}, prefs, { captions: !!b });
      paintCaps();
      changed();
    }
    function hideToChat() {
      if (destroyed || ending || !ui || !visible) return;
      visible = false;
      clearCaption();   // the audio itself goes on (and its state is kept): the view that is opened again attaches to it
      teardownView();          // nothing is drawn while the chat is shown
      restoreControls(); unmount();
      showReopen(true);
      const rf = reopen; quiet(() => rf && rf.focus());
      changed();
    }
    function showView() {
      if (destroyed || ending) return;
      if (visible) { if (viewFailed) buildView(); return; }   // a view that could not load (transient, nothing marked unusable) is built afresh: the person can try again
      visible = true; buildView();
    }

    // ── the call's life ──
    function unlock() {   // inside the tap that starts the call: an audio context made and resumed here is allowed to play later (iOS)
      if (!o.needsContext || audioCtx || !win) return;
      resolved = resolveNow();
      if (resolved.kind === 'none' && !resolved.pending) return;   // None never makes (or routes through) an audio context
      quiet(() => {
        if (shared && shared.ctx && shared.ctx.state !== 'closed') { audioCtx = shared.ctx; }   // the page's context from an earlier call: its routed element keeps playing through it
        else {
          const AC = win.AudioContext || win.webkitAudioContext;
          if (!AC) return;
          audioCtx = new AC();
          if (shared) { const lost = !!shared.ctx; shared.ctx = audioCtx; shared.routed = 0; shared.routes = elementRoutes = new WeakMap(); if (lost) quiet(() => o.onRoutesLost && o.onRoutesLost()); }   // an element captured by a closed context is silent for good: the page makes a new one
        }
        if (typeof audioCtx.resume === 'function') { const r = audioCtx.resume(); if (r && r.catch) r.catch(() => {}); }
      });
    }
    function start() {
      if (started || destroyed) return;
      started = true; unlock();
      resolved = resolveNow();
      if (wantsPack()) ensurePacks();
      buildView();
    }
    function finish() {
      if (destroyed) return;
      destroyed = true; ending = true; packsToken++;
      for (const t of [helloTimer, goodbyeTimer, packsRetryTimer]) if (t !== null) clearT(t);
      helloTimer = goodbyeTimer = packsRetryTimer = null; rPending.clear();
      if (goodbyeDone) { const r = goodbyeDone; goodbyeDone = null; r(); }   // a release during the goodbye settles the hang-up promise
      teardownView(); restoreControls(); unmount(); showReopen(false);
      if (capRO) { const r = capRO; capRO = null; quiet(() => r.disconnect()); }
      if (capOnResize) { const f = capOnResize; capOnResize = null; quiet(() => win.removeEventListener('resize', f)); }
      if (audioCtx) {
        const c = audioCtx; audioCtx = null;
        if (shared && shared.routed > 0 && c.state !== 'closed') { /* a routed element lives on this context: it stays (running) for the page and the next call */ }
        else { if (shared && shared.ctx === c) { shared.ctx = null; shared.routed = 0; } quiet(() => { const r = c.close && c.close(); if (r && r.catch) r.catch(() => {}); }); }
      }
      silentRoute = null;
      const pf = prevFocus; prevFocus = null; if (pf) quiet(() => pf.focus && pf.focus());
      ui = null;
    }
    // Hang-up: what the page holds is let go at once (controls return to the chat) and the character says goodbye for a bounded time.
    function hangUp() {
      if (destroyed || ending) return Promise.resolve();
      ending = true; started = false;
      audioEnd(); clearCaption(); endHello();
      restoreControls();
      if (ui) { for (const b of [ui.talk, ui.hang, ui.back, ui.caps, ui.ctl, ui.disp]) b.disabled = true; ui.drawer.hidden = true; paintTalk(); paintStatus(); }
      paintRec();
      let said = false;
      if (view && visible) {
        // A character that is not ready (clips still loading, or failed) has nothing to show: the view closes at once, no blank "Goodbye".
        const info = quiet(() => (view.kind === 'pack' && view.impl.getInfo ? view.impl.getInfo() : null));
        const notReady = !!info && (info.ready !== true || !!info.failed || info.drawable === false);
        if (!notReady) { try { said = view.impl.react('goodbye') === true; } catch { said = false; } }
      }
      if (!said) { finish(); return Promise.resolve(); }
      quiet(() => view.impl.setAnalyser && view.impl.setAnalyser(null));
      return new Promise((resolve) => { goodbyeDone = resolve; goodbyeTimer = setT(() => { goodbyeTimer = null; finish(); }, GOODBYE_MS); });
    }
    function release() { if (destroyed) return; ending = true; finish(); }   // hidden / frozen / failed: no animation, nothing waits

    return {
      start, unlock, setState, micLost, connLost, setRecording, level, thinkingPulse, showsPulse, syncReopen, badge, mood, caption, clearCaption, activeFacePack,
      routeBufferSource, routeElement, audioStart, audioEnd, audioStop, speech, reply,
      setChoice, setCaptions, setInterruptButton, hideToChat, showView, hangUp, release, destroy: release,
      ensurePacks, refresh,
      info() { return { resolved, choice: prefs.choice, captions: prefs.captions, interruptButton: !!prefs.interrupt, visible, ending, destroyed, state: ctrl, talk: talkMode, micLost: micLostOn, connLost: connLostOn, packs, packsState, kind: view ? view.kind : 'none', note: displayNote(resolved), offReason: resolved.offReason || (viewFailed && view ? 'could-not-load' : null), hello: helloOn, audio: audioOn, recording: recState }; },
      get active() { return !destroyed && !ending; },
      get ui() { return ui; },
    };
  }

  return { DISPLAY_STORE_KEY, SLUG_RE, MOODS, STATE_TEXT, HELLO_MS, HELLO_WAIT_MS, GOODBYE_MS, TALK_WAIT_MS, cleanChoice, resolveDisplay, loadDisplayPrefs, saveDisplayPrefs, mapDisplayState,
    levelFromDb, createTalkFloor, fetchPacks, fillDisplaySelect, displayNote, stripMoodTag, createCallDisplay };
});
