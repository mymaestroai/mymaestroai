'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { modelFacts } = require('../lib/temporal-workers');
const { strongestPerVendor } = require('../lib/model-offers');

const LIST = ['claude-sdk/claude-opus-4-8', 'claude-sdk/claude-opus-4-7', 'claude-sdk/claude-sonnet-4-6', 'openai/gpt-5.4', 'openai/gpt-5.5', 'openai/gpt-5.5-2026-01-01', 'google/gemini-3-pro', 'google/gemini-3-pro-preview'];

test('modelFacts: newest per family, noise skipped, strongest per vendor, second-opinion line', () => {
  const lines = modelFacts(LIST).split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'Newest of each family: claude-sdk/claude-opus-4-8, claude-sdk/claude-sonnet-4-6, google/gemini-3-pro, openai/gpt-5.5');
  assert.equal(lines[1], 'Strongest per vendor: claude-sdk/claude-opus-4-8 (Anthropic, Subscription), google/gemini-3-pro (Google, API), openai/gpt-5.5 (OpenAI, API)');
  assert.equal(lines[2], 'For a second opinion, pick the strongest model from a vendor other than yours.');
});

test('modelFacts: empty input gives an empty string', () => {
  assert.equal(modelFacts([]), '');
  assert.equal(modelFacts(undefined), '');
});

test('strongestPerVendor: one per vendor, sorted by vendor name', () => {
  const r = strongestPerVendor(LIST);
  assert.deepEqual(r.map((x) => x.vendor), ['Anthropic', 'Google', 'OpenAI']);
  assert.deepEqual(r.map((x) => x.id), ['claude-sdk/claude-opus-4-8', 'google/gemini-3-pro', 'openai/gpt-5.5']);
  assert.deepEqual(strongestPerVendor([]), []);
  assert.deepEqual(strongestPerVendor(null), []);
});
