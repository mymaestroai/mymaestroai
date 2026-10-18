'use strict';

/**
 * cyber-models.js — INERT STUB.
 *
 * The 2026-09-21 maintainer handoff references a "cyber models" transport
 * (allow-listed models sent straight to api.openai.com with a dedicated key,
 * bypassing the gateway). That module was deliberately omitted from the
 * handoff package, so this stub provides the same four-function surface with
 * the feature switched OFF:
 *
 *   isCyberModel(model)    -> always false
 *   cyberTransport(model)  -> always null   (caller falls through to the normal transport)
 *   transportTag(model)    -> always null   (UI shows no "direct key" badge)
 *   listCyberModels()      -> always []     (adds nothing to the model picker)
 *
 * Nothing in the hub changes behaviour because of this file. If the real
 * transport is ever wanted, replace this module; callers need no edits.
 */

function isCyberModel(_model) { return false; }
function cyberTransport(_model) { return null; }
function transportTag(_model) { return null; }
async function listCyberModels() { return []; }

module.exports = { isCyberModel, cyberTransport, transportTag, listCyberModels };
