'use strict';

/**
 * routes.js — HTTP surface for /api/comms/*. Thin wrapper: parse the request,
 * call into CommsService, shape the response. All state/logic lives in service.js;
 * this file owns no data of its own.
 */

const { getCommsService } = require('./service');

async function handle(pathname, req, res, { readBody, jsonResponse, getAgents }) {
  const svc = getCommsService();

  const agentExists = async (name) => {
    try { return (await getAgents()).some(a => a.name === name); }
    catch { return false; }
  };

  try {
    if (pathname === '/api/comms/status' && req.method === 'GET') {
      return jsonResponse(res, 200, await svc.status());
    }

    if (pathname === '/api/comms/telegram/token' && req.method === 'POST') {
      const { token } = JSON.parse((await readBody(req)) || '{}');
      try {
        return jsonResponse(res, 200, await svc.setToken(token));
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/comms/telegram/config' && req.method === 'POST') {
      const patch = JSON.parse((await readBody(req)) || '{}');
      try {
        const next = await svc.patchConfig(patch, { agentExists });
        return jsonResponse(res, 200, next);
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/comms/telegram/senders' && req.method === 'POST') {
      const { add, remove } = JSON.parse((await readBody(req)) || '{}');
      try {
        if (add) return jsonResponse(res, 200, svc.addSender(add));
        if (remove !== undefined) return jsonResponse(res, 200, svc.removeSender(remove));
        return jsonResponse(res, 400, { error: 'expected { add } or { remove }' });
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/comms/telegram/test' && req.method === 'POST') {
      const { to, text } = JSON.parse((await readBody(req)) || '{}');
      try {
        return jsonResponse(res, 200, await svc.testSend({ to, text }));
      } catch (e) {
        return jsonResponse(res, 400, { error: e.message });
      }
    }

    if (pathname === '/api/comms/audit' && req.method === 'GET') {
      const url = new URL(req.url, 'http://internal');
      const limit = Number(url.searchParams.get('limit')) || 100;
      return jsonResponse(res, 200, svc.getAudit(limit));
    }

    if (pathname === '/api/comms/audit.csv' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="comms-audit.csv"' });
      return res.end(svc.auditCsv());
    }

    return jsonResponse(res, 404, { error: 'not found' });
  } catch (e) {
    return jsonResponse(res, 500, { error: e.message });
  }
}

module.exports = { handle };
