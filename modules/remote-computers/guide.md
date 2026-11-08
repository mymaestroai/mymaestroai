# Remote computers: setup guide

## What it does

This module lets your agents work on other computers over your private Tailscale network. A small MeshCentral
server runs inside this connector. You install a helper program on each PC you want to add, and the PC connects
to that server. Nothing is reachable from the open internet.

Agents get one of three levels:

- **Look:** list the computers, see facts about them (system, memory, disks, whether a restart is pending) and take
  screenshots.
- **Act:** run commands as administrator.
- **Drive:** use the mouse and keyboard.

Every agent starts at Look. You raise an agent's level in the settings.

## Safety

- **Levels.** An agent can never do more than its level. Agents you do not list get Look.
- **Your yes on the phone.** MeshCentral's own "Allow" prompts do not cover commands: its command feature does not
  ask the person at the PC. So My Maestro asks you, on your phone, before an agent's first Act or Drive in each
  session. A session lasts as long as you set (30 minutes unless you change it). If you say no, the agent is not
  allowed to ask again straight away.
- **A notice on the PC.** When a session starts, the PC shows a short notice saying which agent is using it.
- **A dedicated PC.** Use a computer with nothing personal on it: no private files, no signed-in accounts you care
  about. An agent you allow can fully control it.
- **Everything is logged.** The hub records every command and every use of the mouse and keyboard.
- **MeshCentral keeps a log too.** MeshCentral keeps every command an agent runs, and every text typed with the type
  tool (as base64), in its own event log inside the connector's protected folder. Anything you or an agent types there,
  such as a password, stays in that log.
- **Act and Drive are not walled off from each other.** A command can open programs, so an agent that can Act can
  reach much of what Drive does. Give Drive only to agents you would also give Act.
- **Screenshots are private.** An agent receives each screenshot in its reply. They are not written to My Maestro's
  shared folders (such as the Files folder), but the AI session's own record may keep the picture, like any tool
  result. The connector keeps a private copy (the newest 200 per computer) in its own protected folder for
  troubleshooting.
- **Clicks use the screenshot's shot id.** click (and scroll at a place) must name the shot id of the screenshot the
  agent looked at. It works for 10 minutes, only for that agent and computer, and is refused if the screen size has
  changed since.
- **Linux only for now.** This connector needs My Maestro on Linux. On any other system the health check says so and
  nothing starts.

## What each step does

- **What this does:** explains the levels and asks you to confirm that agents you allow can fully control the
  computers you add.
- **Install:** puts the server in place. It downloads about 210 MB in all (more space on disk once unpacked): about 85 MB of server programs now and about 125 MB of helper programs for the PCs, downloaded the first time the server starts. It is downloaded once.
- **Your settings:** the tailnet name and tailnet address of My Maestro's computer (the computer My Maestro runs on, not the PC you want to control), and the two ports.
- **Start the server:** starts the server and checks that it is running and ready. You do not need to be at My Maestro's computer: if the server needs an administrator command, press Ask Maestro and Maestro runs it for you.
- **Prepare the PC:** done by you on the PC: Windows 11 with a local account, signing in automatically, never
  locking or sleeping, Tailscale installed and signed in to the same tailnet as My Maestro's computer, nothing personal on it. Do not sign in to My Maestro on that PC: an agent using the PC could use that sign-in.
- **Get the installer:** makes a link that works once, for 15 minutes. Open it in a browser on the PC. It downloads
  `MyMaestro-RemoteAgent.exe`. Run it and choose Install.
- **Check the PC is connected:** passes when at least one PC is online.
- **What agents may do:** the level for each agent and the session length.
- **Who can use it at all:** which agents may use remote computers. The lead agent is always allowed.

## What each setting does

- **My Maestro's computer: tailnet name:** the tailnet name of the computer My Maestro runs on. It is NOT the PC you want to control.
  The PCs connect to this name, for example `hub.example.ts.net`. Find it in the
  Tailscale app on My Maestro's computer, or run `tailscale status` there.
- **My Maestro's computer: tailnet address:** the `100.x.y.z` address of the computer My Maestro runs on, for example
  `100.64.0.10`. It is NOT the PC you want to control. The server listens only on it.
- **Control port** (default 9971): used only on My Maestro's computer by the connector.
- **Computer port** (default 9972): the port on the tailnet address that the PCs connect to.
- **Run as** (default auto): `service` runs MeshCentral as its own system service (see "Its own service (Linux)").
  `hub` runs it under My Maestro's own account. `auto` uses `service` when My Maestro's computer has systemd.
- **What each agent may do:** one entry per agent, like `maestro:look`, `maestro:act` or `maestro:drive`.
- **Approved session length:** how long one yes for Act or Drive lasts (5 to 120 minutes).

## Tools

- **computers** (Look): lists the computers, whether each is online and when it was last seen.
- **info** (Look): facts about one computer.
- **screenshot** (Look): a picture of the main screen, returned to the agent with a shot id.
- **run** (Act): runs a command and returns its output.
- **click** (Drive): clicks the mouse at a place in a screenshot, named by its shot id.
- **type** (Drive): types text.
- **key** (Drive): presses a key or a combination.
- **scroll** (Drive): turns the mouse wheel.

## Common errors and fixes

- **"Reinstall needed: open Data connectors and run Install again":** the server program is missing. Run the Install
  step again.
- **"Waiting for setup":** the tailnet name or address is not saved yet. Fill in the settings step.
- **No screenshot, or "did not confirm the input":** nobody is signed in on the PC, or the screen is locked or showing
  a secure screen. Set Windows to sign in automatically and never lock, then try again.
- **The PC is offline:** it is switched off or asleep, or Tailscale is not running on it. Switch it on, check
  Tailscale, and wait a minute.
- **Windows Defender or SmartScreen warns about the installer:** that is expected, because the helper is a
  remote-access tool. Choose "More info", then "Run anyway", on the dedicated PC only.
- **"busy, try again":** a command is still running on that PC. One command runs at a time. Wait a few minutes.
- **"may still be running":** the connection dropped, or the PC did not answer, after the command was sent. The agent
  is told to check what happened (a screenshot, or a read-only command) before it tries again.
- **"Take a new screenshot and use its shot id":** the shot id is unknown, older than 10 minutes, or belongs to
  another agent or computer.
- **"The screen changed since that screenshot":** the screen size is different now. Take a new screenshot.
- **"Approved for N minutes. Call ... again":** your yes came late in the call, so nothing was sent. The agent calls
  the tool again and it runs at once.
- **The owner said no:** you declined the question on your phone. The agent is not asked again for a couple of
  minutes. Ask the agent to try again when you are ready.
- **"This link has expired":** installer links work once and for 15 minutes. Run Get the installer again.
- **"The installer is not available right now":** the server is not ready. Run Start the server, then make a new link.

## Its own service (Linux)

On Linux with systemd, MeshCentral runs as its own system service instead of inside My Maestro. You install it once.
The setup shows a command that starts with `sudo bash` and runs `install.sh`. Press Ask Maestro and Maestro runs it for
you; you do not need to be at My Maestro's computer. If you prefer a terminal, run it on My Maestro's computer (it asks
for an administrator password). The command runs a script from My Maestro's own folder with administrator
rights, so it trusts My Maestro's files as they are at that moment, as installing My Maestro did.

What the command does:

- It creates a system account named `mymaestro-remote`.
- It copies the program to `/opt/mymaestro-remote`.
- It keeps MeshCentral's data and keys in `/var/lib/mymaestro-remote`, where only that account can read them.
- It starts a locked-down service. The service sees only the system's programs, its own program and its own data:
  no home folders, no other disks, none of My Maestro's folders. It accepts connections from My Maestro and from the
  allowed agent addresses, and cannot open a connection or send anything except replies on the connections it accepted.
- Once your computer is connected, set "Addresses the computers may connect from" to that computer's own 100.x
  address and run the install command again, so no other device on your tailnet can connect to MeshCentral. The
  setup warns until the range is narrowed.
- Running the command with sudo trusts the script as it stands in My Maestro's folder at that moment, each time.

Good to know:

- The service keeps running when My Maestro restarts. The connector finds it again by itself, within about 30 seconds
  of the install finishing; you do not need to restart My Maestro.
- If you change the settings later, the setup shows the install command again; run it once more so the service
  picks up the new settings.
- Its data is not in My Maestro's backups. If you move to a new computer, install the PC's agent again.
- To remove it, run `sudo bash <module dir>/service/uninstall.sh`, where `<module dir>` is the folder of this
  connector (the install command shows the full path).
- `hub` mode runs MeshCentral under My Maestro's own account. Use it only on computers without systemd.
- Its log is in `journalctl -u mymaestro-remote`.

## Removing a computer

On the PC, uninstall **Mesh Agent** from Settings -> Apps. Then the computer shows as offline in the list; it
can be left there or removed from the MeshCentral device group.

## Switching it off

Turn the connector off in Data connectors. The server stops, and the PCs can no longer be reached. To end every
agent's access at once without removing anything, set all agents to `look` and leave the connector on, or turn the
connector off. To take the helper off a PC, see "Removing a computer".
