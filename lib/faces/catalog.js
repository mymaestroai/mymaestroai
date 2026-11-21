'use strict';
// lib/faces/catalog.js: the character packs this hub can download the first time someone chooses one. Each entry names
// ONE tar.gz on a GitHub release of this project, with the exact byte count and SHA-256 the download must match.
// The archive is built by scripts/build-face-archive.js (deterministic: the same pack gives the same bytes).

const CATALOG = Object.freeze([Object.freeze({
  id: 'owl',
  name: 'Owl',
  version: 1,
  tag: 'owl-pack-v1',
  file: 'owl-pack-v1.tar.gz',
  url: 'https://github.com/mymaestroai/mymaestroai/releases/download/owl-pack-v1/owl-pack-v1.tar.gz',
  size: 36929466,
  sha256: '33561c392472643e9b2d9e27e31625963ebd1bbd1d5a1314ac2cde31d6cd08db',
})]);

function catalogEntry(id) {
  return CATALOG.find(e => e.id === id) || null;
}

module.exports = { CATALOG, catalogEntry };
