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
- **Screenshots are private.** An agent receives each screenshot in its reply, not as a file in the Files folder. The
  connector keeps a private copy (the newest 200 per computer) in its own protected folder for troubleshooting.
- **Clicks use the screenshot's shot id.** click (and scroll at a place) must name the shot id of the screenshot the
  agent looked at. It works for 10 minutes, only for that agent and computer, and is refused if the screen size has
  changed since.
- **Linux only for now.** This connector needs My Maestro on Linux. On any other system the health check says so and
  nothing starts.

## What each step does

- **What this does:** explains the levels and asks you to confirm that agents you allow can fully control the
  computers you add.
- **Install:** puts the server in place (about 110 MB, downloaded once).
- **Your settings:** this computer's tailnet name, its tailnet address and the two ports.
- **Start the server:** starts the server and checks that it is running and ready.
- **Prepare the PC:** done by you on the PC: Windows 11 with a local account, signing in automatically, never
  locking or sleeping, Tailscale installed and signed in to the same tailnet, nothing personal on it.
- **Get the installer:** makes a link that works once, for 15 minutes. Open it in a browser on the PC. It downloads
  `MyMaestro-RemoteAgent.exe`. Run it and choose Install.
- **Check the PC is connected:** passes when at least one PC is online.
- **What agents may do:** the level for each agent and the session length.
- **Who can use it at all:** which agents may use remote computers. The lead agent is always allowed.

## What each setting does

- **This computer's tailnet name:** the name the PCs connect to, for example `hub.example.ts.net`. Find it in the
  Tailscale app on this computer, or run `tailscale status`.
- **This computer's tailnet address:** the `100.x.y.z` address, for example `100.64.0.10`. The server listens only
  on it.
- **Control port** (default 9971): used only on this computer by the connector.
- **Computer port** (default 9972): the port on the tailnet address that the PCs connect to.
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

## Removing a computer

On the PC, uninstall **Mesh Agent** from Settings -> Apps. Then the computer shows as offline in the list; it
can be left there or removed from the MeshCentral device group.

## Switching it off

Turn the connector off in Data connectors. The server stops, and the PCs can no longer be reached. To end every
agent's access at once without removing anything, set all agents to `look` and leave the connector on, or turn the
connector off. To take the helper off a PC, see "Removing a computer".
