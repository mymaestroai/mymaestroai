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

Every agent starts at Look. You raise an agent's level when you choose which agents may use it, and later under
Status and limits (Save permissions).

## Safety

- **Levels.** An agent can never do more than its level. Agents you have not given a level get Look. The lead agent
  also has a level, and you can change it.
- **Your yes on the phone.** MeshCentral's own "Allow" prompts do not cover commands: its command feature does not
  ask the person at the PC. So My Maestro asks you, on your phone, before an agent's first Act or Drive in each
  session. A session lasts as long as you set (30 minutes unless you change it). If you say no, the agent is not
  allowed to ask again straight away.
- **Ask me before each session.** For Act and Drive, each agent has this box, ticked by default. If you untick it
  for an agent, it starts sessions without asking you. My Maestro warns you before it saves that: an agent can be
  misled by a web page or an email, and with asking off it could then use the computer without you knowing in
  time. You still get the notice on the PC and everything is still logged. After restoring a backup, every agent asks again; untick the box to turn asking off.
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
- **Linux and Mac.** The computer your Maestro runs on must be Linux or a Mac. On a Mac it is new and not yet
  proven on a real Mac. Windows is not supported yet: the setup says so on its first step and nothing is installed.

## What each step does

- **What this does:** explains the levels and checks, before anything is installed, that the computer your Maestro runs on can run it:
  a supported system, Tailscale installed and signed in (it shows the name and address it found), and 300 MB free.
  Then you confirm that agents you allow can fully control the computers you add.
- **Set it up:** one button. It downloads the server once (about 210 MB in all), fills in the name and address of the computer your Maestro runs on
  on your private network from Tailscale, keeps ports 9971 and 9972 or picks the next free pair, starts the server and
  checks it. If that computer has more than one address on your private network, it asks which one. On Linux with
  systemd the server runs as its own locked-down service, which needs an administrator once: press Ask Maestro (it runs
  the command when it may), copy the command and run it yourself, or choose "Run it without an administrator", which
  runs the server under your Maestro's own account (it then has the same access to files as your Maestro). On a Mac,
  and on Linux without systemd, it runs under your Maestro's own account. Saved settings are never changed by it.
  Every setting stays under **Advanced settings**.
- **Add a computer:** Windows computers for now. On that computer: sign in to Tailscale with the same account, open the
  one-time link in a browser within 15 minutes, run the downloaded `MyMaestro-RemoteAgent.exe` and choose Install. For
  agents to see the screen, use a local account that signs in by itself, set it to never lock or sleep, and keep
  personal files and accounts off it. Do not sign in to My Maestro on that computer.
- **Wait for the computer:** passes when a computer is online. When none is, it says which part did not happen: the
  link was not opened, the helper was downloaded but never connected, or the computer is offline.
- **Who may use it:** which agents may use remote computers, the level for each (Look, Act or Drive) and whether you
  are asked on your phone before each Act or Drive session. The lead agent is always allowed.

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
- **Asking per computer:** You can also choose, for each computer on the Computers box in this connector's page, between asking every session, asking once a day, or not asking chosen agents on that computer.
- **Approved session length:** how long one yes for Act or Drive lasts (5 to 120 minutes).
- **Each agent's level and Ask me:** set in the agent list, not as a typed setting, and saved with Save.

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
- **"The antivirus ... blocked this click / typing / command":** the PC's antivirus stopped it. The message names the
  detection when Microsoft Defender reports one, and Windows Security > Protection history on the PC shows the block.
  Screenshots come through the same channel as Open desktop, so they do not run any script on the PC. Agent screenshots show no notice on the PC, the same as before; a screenshot taken while a person has the desktop open cannot be used to click. Do not turn
  the antivirus off or add an exclusion for My Maestro.
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
- **"Approved. Call ... again":** your yes came late in the call, so nothing was sent. The agent calls
  the tool again and it runs at once.
- **The owner said no:** you declined the question on your phone. The agent is not asked again for a couple of
  minutes. Ask the agent to try again when you are ready.
- **"This link has expired":** installer links work once and for 15 minutes. Run Get the installer again.
- **"The installer is not available right now":** the server is not ready. Run Start the server, then make a new link.

## Its own service (Linux)

On Linux with systemd, MeshCentral runs as its own system service instead of inside My Maestro. You install it once.
The setup shows a command that starts with `sudo bash` and runs `install.sh`. Press Ask Maestro and Maestro runs it for
you (it needs administrator rights on My Maestro's computer); you do not need to be at that computer. Or run it yourself in a terminal on My Maestro's computer (it asks
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
agent's access at once without removing anything, set all agents to Look and leave the connector on, or turn the
connector off. To take the helper off a PC, see "Removing a computer".
