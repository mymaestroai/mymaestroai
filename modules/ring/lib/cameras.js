'use strict';
// Ring module: which camera is meant. The camera list is the one api.refreshDevices() keeps in the store (devices.json).
//
// createCameras(ctx) takes ctx = { store, settings } (settings may be an object or a function returning one) and returns:
//   findCamera(text)      -> device id | null    a full device id, the exact camera name, or a unique short id ("…V3XTXI" or "V3XTXI")
//   cameraInfo(deviceId)  -> { id, name, kind, house }   name and kind are null for a camera not in the list; house comes from the
//                            'houses' setting ("House A: front, back; House B: garage") or is 'house unknown'
//   list()                -> [cameraInfo, ...] every known camera
//   fetchedAt()           -> ISO time of the last device list, or null
//
// module.exports = { createCameras }
const { houseFor, clean } = require('./events');

function createCameras(ctx) {
  const { store } = ctx;
  const settings = () => { try { return (typeof ctx.settings === 'function' ? ctx.settings() : ctx.settings) || {}; } catch { return {}; } };
  const devices = () => {
    const d = store.devices.get();
    return d && d.devices && typeof d.devices === 'object' && !Array.isArray(d.devices) ? d.devices : {};
  };

  function findCamera(q) {
    const devs = devices();
    const ids = Object.keys(devs);
    const s = clean(q, 200);
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(devs, s)) return s;
    const byName = ids.filter((id) => (devs[id].name || '').toLowerCase() === s.toLowerCase());
    if (byName.length === 1) return byName[0];
    const tail = s.replace(/^(…|\.\.\.)/, '');
    const byTail = /^[A-Za-z0-9]{6,}$/.test(tail) ? ids.filter((id) => id.endsWith(tail)) : [];
    return byTail.length === 1 ? byTail[0] : null;
  }
  function cameraInfo(deviceId) {
    const d = Object.prototype.hasOwnProperty.call(devices(), deviceId) ? devices()[deviceId] : null;
    const name = d && d.name ? clean(d.name, 80) : null;
    return { id: deviceId, name, kind: d && d.type ? clean(d.type, 40) : null, house: houseFor(name, deviceId, settings().houses) };
  }
  const list = () => Object.keys(devices()).map(cameraInfo);
  const fetchedAt = () => { const d = store.devices.get(); return d && typeof d.fetchedAt === 'string' ? d.fetchedAt : null; };

  return { findCamera, cameraInfo, list, fetchedAt };
}

module.exports = { createCameras };
