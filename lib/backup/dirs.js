'use strict';
// backup/dirs.js — where a restore keeps its working files inside the install. No other requires: apply.js loads this
// before .env is read.
const path = require('path');

function restoreDirs(root) {
  const base = path.join(root, '.restore');
  return { base, staged: path.join(base, 'new'), prepared: path.join(base, 'prepared.json'), journal: path.join(base, 'journal.json'), aside: path.join(base, 'aside'), uploads: path.join(base, 'uploads') };
}

module.exports = { restoreDirs };
