'use strict';

/**
 * telegram.js — thin Telegram Bot API client: long-poll getUpdates, sendMessage
 * (chunked at 4096 chars on line boundaries), sendChatAction. No Telegram SDK
 * dependency: plain fetch against the HTTP API so it is easy to fake in tests.
 */

const DEFAULT_API_BASE = 'https://api.telegram.org';
const MAX_MESSAGE_LEN = 4096;
const POLL_TIMEOUT_S = 30;
const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const IDLE_DELAY_MS = 20;

function maskToken(str) {
  return String(str).replace(/\/bot[^/]+\//g, '/bot***/');
}

/** Chunk text into <=limit pieces, breaking on the last newline at or before the limit. */
function chunkText(text, limit = MAX_MESSAGE_LEN) {
  const out = [];
  let rest = String(text);
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut <= 0) cut = limit;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.length || out.length === 0) out.push(rest);
  return out;
}

class TelegramChannel {
  constructor({ getToken, apiBase, fetchImpl } = {}) {
    this.getToken = getToken || (() => null);
    this.apiBase = apiBase || DEFAULT_API_BASE;
    this.fetchImpl = fetchImpl || global.fetch;
    this._offset = 0;
    this._polling = false;
    this._abortController = null;
    this._lastPollAt = null;
    this._lastError = null;
    this._backoffMs = BACKOFF_MIN_MS;
  }

  status() {
    return { polling: this._polling, lastPollAt: this._lastPollAt, lastError: this._lastError };
  }

  _url(method) {
    const token = this.getToken();
    if (!token) throw new Error('no Telegram token set');
    return `${this.apiBase}/bot${token}/${method}`;
  }

  async _call(method, body) {
    let res;
    try {
      res = await this.fetchImpl(this._url(method), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: this._abortController ? this._abortController.signal : undefined,
      });
    } catch (e) {
      throw new Error(maskToken(e.message));
    }
    let json;
    try { json = await res.json(); }
    catch (e) { throw new Error(`bad Telegram response: ${maskToken(e.message)}`); }
    if (!json || json.ok !== true) {
      const desc = (json && json.description) || `HTTP ${res.status}`;
      throw new Error(maskToken(`Telegram API error (${method}): ${desc}`));
    }
    return json.result;
  }

  async getMe() {
    return this._call('getMe', {});
  }

  async sendMessage(chatId, text) {
    const parts = chunkText(text);
    let last;
    for (const part of parts) {
      last = await this._call('sendMessage', { chat_id: chatId, text: part });
    }
    return last;
  }

  async sendChatAction(chatId, action = 'typing') {
    try { await this._call('sendChatAction', { chat_id: chatId, action }); }
    catch { /* best effort */ }
  }

  /** Start long-polling. onMessage(update) is called for every update received. */
  start(onMessage) {
    if (this._polling) return;
    this._polling = true;
    this._backoffMs = BACKOFF_MIN_MS;
    this._loop(onMessage).catch(() => {});
  }

  stop() {
    this._polling = false;
    if (this._abortController) { try { this._abortController.abort(); } catch { /* already done */ } this._abortController = null; }
  }

  async _loop(onMessage) {
    while (this._polling) {
      this._abortController = new AbortController();
      try {
        const updates = await this._call('getUpdates', { offset: this._offset, timeout: POLL_TIMEOUT_S });
        this._lastPollAt = Date.now();
        this._lastError = null;
        this._backoffMs = BACKOFF_MIN_MS;
        if (!updates || updates.length === 0) {
          await sleep(IDLE_DELAY_MS);
          continue;
        }
        for (const upd of updates) {
          this._offset = upd.update_id + 1;
          try { await onMessage(upd); } catch (e) { console.error('[comms] telegram onMessage error:', e.message); }
        }
      } catch (e) {
        if (!this._polling) break;
        this._lastError = maskToken(e.message);
        this._lastPollAt = Date.now();
        await sleep(this._backoffMs);
        this._backoffMs = Math.min(this._backoffMs * 2, BACKOFF_MAX_MS);
      }
    }
  }
}

function sleep(ms) { return new Promise(resolve => { const t = setTimeout(resolve, ms); if (t.unref) t.unref(); }); }

module.exports = { TelegramChannel, chunkText, maskToken, DEFAULT_API_BASE };
