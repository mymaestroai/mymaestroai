#!/usr/bin/env node
'use strict';
// Build the release archive of a character pack: node scripts/build-face-archive.js <packDir> <outFile>
// The pack must pass validatePack; the archive holds manifest.json and every file the manifest uses (no top-level
// folder) and is deterministic, so the same pack always gives the same size and sha256 (put both in lib/faces/catalog.js).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const packs = require('../lib/faces/packs');
const { writeTarGz } = require('../lib/faces/tar');

const [packDir, outFile] = process.argv.slice(2);
if (!packDir || !outFile) { console.error('Usage: node scripts/build-face-archive.js <packDir> <outFile>'); process.exit(2); }
const v = packs.validatePack(packDir);
if (!v.ok) { console.error(`Not a valid character pack: ${v.error}`); process.exit(1); }
const entries = Object.values(v.files).map(f => ({ name: f.rel, data: fs.readFileSync(f.abs) }));
const gz = writeTarGz(entries);
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
fs.writeFileSync(outFile, gz);
console.log(`size ${gz.length}`);
console.log(`sha256 ${crypto.createHash('sha256').update(gz).digest('hex')}`);
