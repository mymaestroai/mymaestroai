/**
 * plural.js — "1 agent" / "3 agents": real words by count, for every text a person can read (server side).
 *
 *   plural(n, one, many = one + 's') -> "1 agent" | "3 agents" | "0 agents"
 *   word(n, one, many = one + 's')   -> "agent" | "agents" (the word alone, for "1 agent uses / 3 agents use")
 */
'use strict';

const word = (n, one, many) => (Number(n) === 1 ? one : (many === undefined ? `${one}s` : many));
const plural = (n, one, many) => `${n} ${word(n, one, many)}`;

module.exports = { plural, word };
