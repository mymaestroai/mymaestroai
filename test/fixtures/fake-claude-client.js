#!/usr/bin/env node
'use strict';
// A stand-in for the Claude client (`claude`), for tests and for the proof on a running copy. Never talks to anything.
//   auth status --json   prints {"loggedIn": <credentials file exists>, "authMethod": "claude.ai"}; exit 0 when signed in, 1 when not.
//                        The credentials file is $CLAUDE_CONFIG_DIR/.credentials.json.
//   auth login --claudeai  prints the browser line, the link line and the prompt, then reads one line from standard input:
//                        "GOOD-CODE-12345" -> writes the credentials file (a dummy token), prints "Login successful", exit 0;
//                        anything else -> "OAuth error: Invalid code. Please make sure the full code was copied", exit 1.
// FAKE_CLAUDE_MODE=network  login prints "Failed to connect to api: getaddrinfo ENOTFOUND platform.claude.com", exit 1.
// FAKE_CLAUDE_MODE=hang     login prints nothing and waits.
const fs = require('fs');
const path = require('path');

const dir = process.env.CLAUDE_CONFIG_DIR || path.join(process.env.HOME || '.', '.claude');
const creds = path.join(dir, '.credentials.json');
const args = process.argv.slice(2);

if (args[0] === 'auth' && args[1] === 'status') {
  const loggedIn = fs.existsSync(creds);
  process.stdout.write(JSON.stringify({ loggedIn, authMethod: 'claude.ai' }) + '\n');
  process.exit(loggedIn ? 0 : 1);
} else if (args[0] === 'auth' && args[1] === 'login') {
  const mode = process.env.FAKE_CLAUDE_MODE || '';
  if (mode === 'network') {
    process.stdout.write('Failed to connect to api: getaddrinfo ENOTFOUND platform.claude.com\n');
    process.exit(1);
  }
  if (mode === 'hang') {
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write('Opening browser to sign in…\n');
    process.stdout.write("If the browser didn't open, visit:\n");
    process.stdout.write('https://claude.example/oauth/authorize?code=true&state=standin\n');
    process.stdout.write('Paste code here if prompted > ');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
      buf += d;
      const i = buf.indexOf('\n');
      if (i < 0) return;
      const line = buf.slice(0, i).trim();
      if (line === 'GOOD-CODE-12345') {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(creds, JSON.stringify({ token: 'dummy-token' }), { mode: 0o600 });
        process.stdout.write('\nLogin successful\n');
        process.exit(0);
      }
      process.stdout.write('\nOAuth error: Invalid code. Please make sure the full code was copied\n');
      process.exit(1);
    });
    process.stdin.on('end', () => process.exit(1));
  }
} else {
  process.stderr.write('fake claude client: unsupported arguments\n');
  process.exit(2);
}
