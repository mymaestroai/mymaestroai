# Security review (the lead agent's playbook)

Use this when the owner accepts the security check offered in the setup interview, or asks for one ("is this computer safe?", "check for vulnerabilities"). It covers this install of My Maestro AI and the computer it runs on: what other devices can reach, what is out of date, and settings that make a break-in easier. You report in plain words and fix only what the owner approves.

## Rules

- **Look first, change nothing.** Every command here only reads. Make a change (a setting, the firewall, a service, a package, a file) only after the owner says yes to that one change, once you have said what it does and how to undo it.
- **Never ask for a password.** A command that needs `sudo` asks for one. Skip it, give the owner the exact command to run in their own terminal, and read the output if they paste it.
- **No secrets in the chat.** Check a secret file with `ls -l` (its permissions), never by printing it: not `.env`, `data/settings.json`, keys, tokens or password files.
- **This computer only.** Don't scan other devices on the network, and don't install scanners, unless the owner asks.
- **Don't fix the hub's packages yourself.** `npm audit fix` rewrites the install's `package-lock.json`, and a changed tracked file blocks the next update. Package fixes arrive with new versions of My Maestro AI.
- **A few checks at a time.** Run the checks in small groups. If the hub's command policy refuses one, say which one, skip it and carry on with the rest; never work around a refusal.
- **Be calm and concrete.** Most computers show a few warnings. Say which are real risks here, which are fine, and why.
- **Inside a sandbox you can't see the computer.** If your shell runs in the hub's sandbox (`/.dockerenv` exists, or Settings shows you boxed), say so, and ask the owner to run `mymaestro doctor` in a terminal or to let you run on the host (Settings → Agent sandboxes).

## 1. The hub's own check

In the install folder (usually ~/mymaestroai), run `node scripts/security-check.js` (`--json` for the details). It never prints a secret, and it exits with 2 when something is critical, 1 for warnings only and 0 when clean. It covers the hub's side: two-factor on admin accounts, permissions on secret files, which agents can run commands as root, the Node.js security release, how the hub is reached, and more. Never add `--fix-modes` without a yes. Its findings go into your report.

## 2. What other devices can reach

- **Listening services.** Read the whole list, don't cut it short. Linux: `ss -tuln` lists them all (TCP and UDP); `ss -tulpn` adds the program names it is allowed to see. macOS: `netstat -an -p tcp | grep LISTEN` lists the TCP ones and `netstat -an -p udp` the UDP ones; `lsof -nP -iTCP -sTCP:LISTEN` adds names (only your own without sudo).
- **How to read the address.** `127.0.0.1` or `[::1]`: this computer only. `0.0.0.0`, `[::]`, `*` or the computer's network address: any device on the network can try it. This computer's Tailscale address (`tailscale ip -4`; Tailscale uses part of 100.64.0.0/10, which other networks use too): the tailnet, which is private but can include other people and devices shared with it; `tailscale status` shows who is on it. The hub should listen on 127.0.0.1 (port 9999 unless changed) and be reached from other devices only through Tailscale.
- **Name each open service and say whether it should be open:** SSH (22), file sharing (139, 445), remote desktop and screen sharing (3389, 5900), databases (5432, 3306, 6379, 27017), the Docker API (2375, 2376: serious, it gives full control of the computer), local AI servers (Ollama 11434, LM Studio 1234: anyone on the network can use them), printer and device discovery (631, 5353: usually fine). For a port you don't recognise, find its program (`ss -tulpn`, `lsof -i :PORT`) before you say what it is.
- **The firewall.** Linux: `systemctl is-active ufw firewalld` (no sudo); the rules need `sudo ufw status verbose`, which the owner runs. macOS: `/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate`. An active firewall may block a service that listens on every address: say so instead of calling it exposed.
- **SSH logins.** Linux: `grep -h -i -E '^\s*(PasswordAuthentication|PermitRootLogin)' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf`. Passwords can be guessed; keys can't. macOS: Remote Login is on when port 22 is listening (System Settings → General → Sharing).
- **Tailscale.** `tailscale status` and `tailscale funnel status`: an address marked "(tailnet only)" stays on the tailnet; anything else is published to the whole internet and needs a good reason. Name any device or person on the tailnet the owner may not expect, and any device shared into or out of it.

## 3. Updates and known vulnerabilities

- **The operating system.** Ubuntu and Debian: `apt list --upgradable` (how many updates wait), `apt-get -s upgrade | grep -c '^Inst.*security'` (how many of them are security updates; `-s` only simulates) and `/var/run/reboot-required` (an installed update waits for a restart). Fedora: `dnf check-update --security` (exit code 100 means updates are waiting, not an error). macOS: `softwareupdate -l`, and `brew outdated` if Homebrew is installed.
- **Automatic updates.** Ubuntu: `systemctl is-enabled unattended-upgrades`. macOS: System Settings → General → Software Update → Automatic updates.
- **The hub's packages.** In the install folder: `npm audit --omit=dev` (it only asks the npm registry). Give the count by severity and the worst packages, and say whether the hub uses the affected part when you can tell. Don't run `npm audit fix` (see the rules): suggest checking for a newer version of My Maestro AI (Settings → Update), whose packages may already be fixed.
- **Node.js and the AI clients.** `node -v` (the hub's check says whether it misses a security release); `claude --version` and `codex --version` if they are installed.

## 4. The computer itself

- **Disk encryption.** Linux: `lsblk -o NAME,TYPE,MOUNTPOINT` (a `crypt` row means encrypted). macOS: `fdesetup status`. Without it, anyone who takes the disk can read it.
- **Who has power.** `id -nG`: members of `sudo`, `wheel` or `admin` can become root, and members of `docker` can too, without a password.
- **Automatic login and the screen lock.** Linux with GNOME: `grep -i AutomaticLogin /etc/gdm3/custom.conf` and `gsettings get org.gnome.desktop.screensaver lock-enabled`. A computer that logs itself in and never locks is only as safe as the room it stands in.
- **macOS protections.** `csrutil status` (System Integrity Protection) and `spctl --status` (Gatekeeper) should both be on.

## 5. The report

Open with one or two sentences on how it looks overall. Then:

1. **Fix now**: anything that lets another device or person in, or a waiting security update.
2. **Fix soon**: weaker settings worth tightening.
3. **Good to know**: fine as it is, but worth knowing.
4. **Looks good**: what you checked and found in order, in one line.

Each finding gets what you found, why it matters (one plain sentence), the fix (the exact command or setting), and who does it: you, once they say yes, or they, when it needs their password. Offer to make your fixes one at a time, each with its own yes; check again afterwards and say what changed.

End by saving a short dated note to memory (what you found, what was fixed, what is left; no secrets), and offer to repeat the review once a month with schedule_task.
