# Remote computers: setup guide

## What it does

Your agents can see and control other computers over your private Tailscale network. Nothing is open to the internet.

- **Look:** see facts about a computer and take a picture of its screen.
- **Act:** run commands on it as administrator.
- **Drive:** use its mouse and keyboard. This works on Windows computers only.

Every agent starts at Look. For Act and Drive, your phone asks you before the first use in each session. That is on by default.

## Before you start

- Install Tailscale on the computer your Maestro runs on and on the computer you want to control. Sign in to both with the same account.
- The first check looks at the computer your Maestro runs on. It needs a supported system (Linux or Mac), Tailscale signed in, and 300 MB of free space.
- Use a computer you want to control that has nothing personal on it. An agent you allow can fully control it.

## Set it up

Press the one button. It downloads the server once (about 210 MB in all), finds the name and address of the computer your Maestro runs on, picks free ports and starts the server. It never changes settings you saved yourself.

On Linux with systemd, the server runs as its own locked-down service. Installing that service needs an administrator once. You choose:

- **Ask Maestro.** Your Maestro runs the command, but only if it may and you asked it to.
- **Copy the command.** Run it yourself in a terminal on the computer your Maestro runs on. It asks for an administrator password.
- **Run it without an administrator.** The server then runs under your Maestro's own account and has the same access to files as your Maestro.

On a Mac, and on Linux without systemd, the server runs under your Maestro's own account. A Mac is new here and not yet proven on a real Mac.

## Add a computer

On the computer you want to control, sign in to Tailscale with the same account. Choose its kind and press Make the link. The link works once and for 15 minutes. A Windows link also comes as a QR code.

- **Windows.** Open the link. It downloads `MyMaestro-RemoteAgent.exe`. Run it and choose Install. Windows Defender or SmartScreen may warn, because this is a remote-access tool. Choose "More info", then "Run anyway", on that computer only. For screen pictures, use an account that signs in by itself and never locks or sleeps.
- **Linux.** Run the one command the page shows in a terminal on that computer. With systemd it installs a service. Without systemd it runs in that terminal until you close it. Screen pictures need someone signed in to an X11 desktop. New: a test Linux computer joined, but the tools there are not yet proven.
- **Mac.** Run the one Terminal command the page shows. It downloads the agent for that link only and installs it. In System Settings, Privacy & Security, Screen Recording, switch on meshagent. New: not yet proven on a real Mac.

Mouse and keyboard control works on Windows only. Do not sign in to My Maestro on the computer you add.

## Who may use it

- An agent can never do more than its level. Agents without a level get Look. The lead agent has a level too.
- For Act and Drive, each agent has "Ask me before each session". It is ticked by default. If you untick it, a web page or an email could mislead that agent into using the computer before you notice. You still get a notice on the computer and everything is logged.
- A yes lasts as long as you set (30 minutes by default). If you say no, the agent cannot ask again straight away.
- Act and Drive are not walled off from each other. Give Drive only to agents you would also give Act.
- After restoring a backup, every agent asks again.
- Everything is logged. The server also keeps what agents run and type in its own log, so a password typed there stays in that log.
- Screenshots go to the agent in its reply. They are not written to your Maestro's shared folders. The connector keeps its own private copy (the newest 200 per computer).
- A click must name the shot id of the screenshot the agent looked at. It works for 10 minutes and is refused if the screen size changed.

## When something goes wrong

- **"Reinstall needed. Run Set it up again.":** the server program is missing. Run Set it up again.
- **"Waiting for setup":** the name or address is not saved yet. Run Set it up.
- **"The server is getting ready":** wait a minute. The page shows when it is ready.
- **"could not be downloaded from GitHub":** the computer your Maestro runs on cannot reach github.com. Check its connection, then press Try again. What was downloaded is kept.
- **"needs an administrator password once":** choose one of the three options under Set it up.
- **"This link has expired":** a link works once and for 15 minutes. Make a new one.
- **"The installer is not available right now" or "still getting ready":** the server is not ready. Finish Set it up, then make a new link.
- **"No computer has connected yet":** run the link's download or command on that computer, then check again. The check says whether no link was made, the link was not used, or it was used but nothing connected.
- **"registered, but it is offline":** switch the computer on, check that Tailscale runs on it, and wait a minute.
- **"No one is signed in" or "did not confirm the input":** nobody is signed in, or the screen is locked. On Windows set automatic sign-in and never lock. On Linux the desktop must be X11. On a Mac switch on Screen Recording for meshagent.
- **"The antivirus ... blocked this":** the antivirus on that computer stopped it. Windows Security, Protection history, shows the block. Do not turn the antivirus off or add an exclusion.
- **"busy, try again":** a command is still running there. Wait a few minutes.
- **"may still be running":** the connection dropped after the command was sent. Check what happened before trying again.
- **"Take a new screenshot and use its shot id":** the shot id is old or belongs to another agent or computer.
- **"The screen changed since that screenshot":** take a new screenshot.
- **"Approved. Call ... again":** your yes came late. The agent calls the tool again and it runs at once.
- **You said no on your phone:** the agent is not asked again for a couple of minutes.

## For your Maestro

You read this when someone pressed Ask Maestro.

- First look at the step and the last check message you were given. They name what did not happen.
- Never run the remote-control agent on the computer your Maestro runs on.
- Run an administrator command only when the person asked you to and you have that right.
- Settings are under Advanced settings on the setup page. Do not ask the person to type addresses or ports; Set it up fills them in.

## Removing a computer

- **Windows:** on that computer, open Settings -> Apps, find Mesh Agent and choose Uninstall.
- **Linux or Mac:** ask your Maestro to help you remove the Mesh Agent service from that computer.

The computer then shows as offline, and agents can no longer reach it.

## Switching it off

Turn Remote computers off in Data connectors. No agent can use any computer. To keep it on but stop agents from acting, set every agent to Look.
