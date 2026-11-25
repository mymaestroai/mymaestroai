'use strict';

const access = require('./access');

async function routeModelOfferGroups({ req, pathname, readBody, identify, isOwner = user => require('./auth').getAuth().isOwner(user), getService, isBusy }) {
  const denied = { status: 403, body: { error: 'admin_only' } };
  if (!access.isAdminSession(req) || req.hubUser.id == null || !isOwner(req.hubUser)) return denied;
  const userId = req.hubUser.id;
  function stillAllowed() {
    const current = identify(req);
    return !!current && current.kind === 'user' && !current.pendingTotp &&
      access.isAdmin(current.user) && current.user.id === userId && isOwner(current.user);
  }

  if (pathname === '/api/model-offer-groups' && req.method === 'GET') {
    const groups = await getService().list();
    return stillAllowed() ? { status: 200, body: { groups } } : denied;
  }
  if (pathname !== '/api/model-offer-groups/answer' || req.method !== 'POST') {
    return { status: 405, body: { error: 'method not allowed' } };
  }

  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return { status: 400, body: { error: 'invalid JSON' } }; }
  if (!body || typeof body.id !== 'string' || !body.id.trim() || body.id.length > 256 ||
      !['apply', 'dismiss'].includes(body.action)) {
    return { status: 400, body: { error: 'Expected an offer id and apply or dismiss.' } };
  }
  if (!stillAllowed()) return denied;
  try {
    const { results } = await getService().answer(body.id, body.action, { stillAllowed, isBusy });
    return stillAllowed() ? { status: 200, body: { results } } : denied;
  } catch (e) {
    if (!stillAllowed()) return denied;
    if (e.message === 'Unknown model offer group') return { status: 409, body: { error: 'That offer is no longer available.' } };
    throw e;
  }
}

module.exports = { routeModelOfferGroups };
