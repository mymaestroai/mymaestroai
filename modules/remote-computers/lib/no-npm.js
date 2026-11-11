'use strict';
// MeshCentral runs "<--npmpath value> install ..." through a shell whenever a module it wants is missing (meshcentral.js:4320-4322),
// and the same value for its update checks (meshcentral.js:632-794). This stands in for npm: it installs nothing, says so, and fails.
process.stderr.write('runtime installs are disabled; reinstall the connector\n');
process.stdout.write('runtime installs are disabled; reinstall the connector\n');
process.exit(1);
