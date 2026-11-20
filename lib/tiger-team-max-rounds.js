'use strict';
/**
 * The Max Rounds value of a Tiger Team request. 0 means "Until Complete": no limit, carried through as a
 * real 0. Only a missing or invalid value falls back; a positive value is capped (the page offers up to 20).
 */
function normalizeMaxRounds(value, fallback, cap) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0;
  return Math.min(Math.floor(n) || fallback, cap || 20);
}

module.exports = { normalizeMaxRounds };
