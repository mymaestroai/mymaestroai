# Changelog

All notable changes to My Maestro AI are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

- **On the phone, Activity moved into the ⋮ menu.** The Activity button in the bottom bar was rarely needed and easy to tap by accident. It now sits in the ⋮ menu, with its count of new events beside it, and the bottom bar keeps Agents and Chat.

- **The chat fills the window, and nothing pushes it sideways.** On the desktop, the messages and the message box were held to 1200 px in the middle of the window, so a wide screen showed broad empty margins; they now use the full width at every size, with a margin that grows with the window (12 px on a phone to 32 px on a wide screen). One setting, `--chat-max-width`, holds the width, so a "limit the width" option later is one value. Wide tables, long code lines, long links and long unbroken words now scroll or wrap inside their own message, and the chat scrolls only up and down: before, a wide reply let the desktop page at phone width slide left and right while you scrolled (the chat was 1046 px wide on a 390 px screen). The phone page's chat is locked the same way.

- **On a phone, the desktop page's header no longer overlaps itself.** The ☰ now has a row of its own in the open agent list, with "My Maestro AI" and the version line below it instead of under it. In a chat, the top row holds the ☰ and the Files, Schedule, Settings, Help and ⋯ buttons, and the open agents sit on their own row below, which scrolls sideways when many are open; every header button is at least 36 px.

- **Agents now work in your local time.** Before, the times agents read were in UTC with no zone named: the hub's search hits, past messages, recall results, summaries and session notes. Agents on the Claude subscription were told only the date, not the time, and every install read scheduled times as US Eastern. So an agent could take this morning for last night. Now every message an agent gets starts with your local date and time, and every time it reads is in your local time with the zone named; "tomorrow at 9am" in a scheduled task means 9 AM where you are. Your time zone follows the device you are using: each message you send carries it, and the page also tells your Maestro when you tap or type (a page left open somewhere else, reloading by itself, doesn't). To keep one zone wherever you are, choose it in your new Profile (the account menu on the desktop, the ⋮ menu on the phone), which also shows the name and sign-in your Maestro knows you by. Agents that belong to another person use that person's time, and your Maestro's own agents use the first admin's. Tasks already scheduled keep their times, and times are still stored in UTC.

- **Answered questions and finished workers no longer pile up under a long reply.** On the desktop, each question an agent asked left a yellow line under its reply, and each worker or consulted agent a green "is Complete" line, so during a long reply they stacked up at the bottom and pushed the reply itself up the screen. A question's line now leaves a few seconds after it is answered or closed, and a worker's line a few seconds after the worker finishes; a worker that fails or is stopped keeps its red line. On the phone, an answered question's box leaves the same way.

- **The rest of an agent's reply now shows after you answer its question, even minutes later.** On the desktop, when an agent asked you something and you answered more than about 90 seconds later, the agent carried on, but the page showed nothing more of that reply until you reloaded it. The page stopped reading the reply while the question was open, and its check for a dead connection then gave up on it. It now keeps reading while a question waits, and a question answered on another device no longer holds the page up either. A reply that really does go silent for 90 seconds now reconnects in a chat with one agent, as after a lost connection, instead of being shown as finished; in a group chat it now says it may be cut off. And a page that reconnects to a reply in which the agent asked a question, on the desktop or the phone, now shows the whole reply instead of the question.

## [5.8.1] - 2026-10-28

One change since 5.8.0: install My Maestro AI as an app on your computer, with the Maestro icon. Press Update in your Maestro to get it; on 5.7.0 or later it also tells you when an update is ready.

- **Install My Maestro AI as an app on your computer, with its own icon.** Chrome and Edge ("Install page as app") and Safari on a Mac (File → Add to Dock) now make an app called My Maestro AI with the Maestro icon, which opens the desktop layout in its own window. Before, only the phone page described itself as an app, so an app made from the desktop page got a small or plain icon. If an app you made earlier still shows the old icon, remove it and make it again. The phone app is unchanged.

## [5.8.0] - 2026-10-27

Five changes since 5.7.3: a setup interview you can pick up where you left off, dialogs that ask before discarding your unsaved edits, your version and an About box, Maestro marked as the lead agent unless you've already chosen one, and your agent's tool activity in one expandable panel. Press Update in your Maestro to get them; on 5.7.0 or later it also tells you when an update is ready.

- **A setup interview you leave can be picked up again.** Closing the window or stepping away no longer ends Maestro's setup interview. Maestro keeps its place in a note (its Record `setup-interview.md`) and carries on from there when you answer its last question or say "continue the setup interview"; an unanswered question pauses the interview instead of ending it. The Welcome page's "You're all set" screen points back to the interview until it is finished, and its phone line now points to steps that exist (ask Maestro, or Help → The phone app) instead of a Settings entry that was never there. Installs whose copy of the interview guide was never edited get the new one at the next start.

- **Dialogs ask before discarding your unsaved edits.** Escape now closes any dialog, panel, sheet or image viewer, innermost first: an open list or picker inside it, then an image opened from it, then the dialog. A dialog where you changed something asks **Discard changes?** first, with **Keep editing** as the default; Escape or Enter on that question keeps editing. The same rule applies to Close, Cancel, ✕, a click outside the dialog and, on the phone, the Back gesture, which now closes the open sheet instead of leaving the screen. Typing something and deleting it again doesn't count as a change, and search and filter boxes never do. A dialog that is still saving stays open and says so. Tab stays inside an open dialog, and closing it returns the focus to where you were. Closing or reloading the tab with unsaved changes in a dialog, or in an agent's settings window, makes the browser warn first, and when your Maestro restarts or updates, an open page reloads itself only once no dialog holds unsaved changes. An agent's question and the "resume interrupted work?" choice still need an answer, so Escape leaves them open.

- **See which version you're running, and an About box.** A small line under "My Maestro AI" at the top left now shows the version and channel: `v5.8.0 · stable`, or on the experimental channel `v5.8.0-dev` followed by the short commit it runs, in purple; any other branch shows its name in blue. An amber dot next to it means a restart is pending: the code on disk is newer than the running hub. Click the line, or choose **About My Maestro AI** at the top of the ⋯ menu, for the version, channel and branch, commit and its date, when the hub started, the Node.js version and, for admins, whether an update is ready (with the same Update action as the update card), plus **Copy details**, a plain-text block to paste into a bug report. On the phone the version line and About are the first item of the ⋮ menu. The page reads it from `GET /api/version`, open to any signed-in user and never to visitors.

- **Maestro is marked as the lead agent, unless you've already chosen one.** New installs now mark Maestro as the lead agent (👑 Lead agent in its settings). Before, nothing was marked, and an install with no mark counts every primary agent you own as a lead, so agents you created later, such as a health organizer, also got the lead's extra rights, like managing other agents' schedules. The first time your Maestro starts after this update, if no agent is marked and Maestro is yours (not a member's) and already counts as a lead, Maestro is marked, and agents that were leads only because nothing was marked lose that. Tick 👑 Lead agent on any agent that should keep it. The check runs once and respects later changes: to choose a different lead, tick that agent before unticking Maestro, because with no agent ticked the old rule applies again and every primary agent you own counts as a lead.

- **See your agent's tool activity in one expandable panel.** A reply's tool calls now sit in one Tools panel under its Reasoning panel, closed until you open it, instead of a line per call between the reply's text, so a reply that runs many tools no longer keeps growing. The panel's header updates in place: how many calls are done, a red count of any that failed, and what is running now and for how long; when the reply is done, the number of calls and the time they took. Open it for one short line per call, and click or tap a call to see what went in and what came out; ⤢ shows every call with its output at full size, and the grip under the panel sets its height. The text the agent writes between calls stays in the reply. On the desktop and the phone.

## [5.7.3] - 2026-10-25

Two security fixes since 5.7.2. Boxed agents' file tools now check where links lead before following them, and a way for chat messages to run script is closed. Press Update in your Maestro to get them; on 5.7.0 or later it also tells you when an update is ready.

- **Security fix: boxed agents' file tools check where links lead before following them.** An agent that runs in a box could reach files elsewhere on the computer through a link. The file tools that work outside the box (Read, Write, Edit, Glob and Grep) and Records now check where a path really leads and refuse it when it ends outside the folders that agent may use. A Record that links into a folder that agent may use keeps working; a Record that links outside those folders is no longer loaded or written.

- **Security fix: closes a way for chat messages to run script.** A specially crafted message, for example text that a model copied from a web page, could make the desktop chat run script with your signed-in session, without a click. This release fixes the formatting step that allowed it, in the desktop chat and on the phone.

## [5.7.2] - 2026-10-24

One change since 5.7.1: the Stop button now also stops the agents a reply asked for help, and the requests it had queued for busy agents. Press Update in your Maestro to get it; on 5.7.0 or later it also tells you when an update is ready.

- **The Stop button now stops the helpers too.** Stopping an agent stopped only that agent's own reply: the agents it had asked for help (consultations, temporary workers, stand-ins) kept working to the end, because each runs as a reply of its own. ⏹ Stop on a worker card stopped nothing at all, and the group-chat and orchestration Stops only stopped the page from listening. Now Stop on an agent also stops the agents that reply asked for help, and the ones those asked in turn, and drops the requests it had queued for busy agents; background jobs keep running, as they always have. ⏹ Stop on a worker card stops that one call (a call still waiting for its agent never starts, and a stand-in running it stops too); the caller is told the owner stopped it and carries on. A Claude-client sub-agent runs inside its caller's reply, so its Stop stops that reply. Group-chat and orchestration Stops now stop their agents. Cards and notices say "Stopped" only once the hub has stopped the call, and still do after a reload. Members may stop only calls of agents they can use. Consultation ids no longer repeat when two calls start in the same millisecond.

## [5.7.1] - 2026-10-24

Three changes since 5.7.0: package updates that clear 11 security advisories, a security check of your computer that Maestro offers in the setup interview, and a fix to the command policy found while testing it. Press Update in your Maestro to get them; on 5.7.0 it also tells you when an update is ready.

- **Package updates for 11 security advisories.** `npm audit` flagged 11 of the packages My Maestro AI depends on (1 critical, 7 high, 3 moderate), mostly in parts of the agent-tool (MCP) library that it never runs. All of them now use their fixed versions, among them the agent-tool library (1.29.0 to 1.32.2), undici (7.24.7 to 7.30.1) and zod (4.3.6 to 4.6.7), and `npm audit` finds nothing. Updating installs the new packages before any code moves, as before.

- **Maestro offers a security check of your computer.** During the setup interview, Maestro now offers to check the install and the computer it runs on for security problems: network services other devices can reach, missing security updates, known vulnerabilities in the software, and weak settings such as password logins or a disk without encryption. It follows a step-by-step guide (`docs/SECURITY-REVIEW.md`), only looks, changes nothing without your yes on each change, and never asks for your password. You can ask for a review any time; the Help page has a new Security section.

- **A file named reboot-required no longer counts as a reboot.** The command policy refused any command that mentioned `/var/run/reboot-required` (the file that says an installed update waits for a restart), as if it were a reboot. Reading that file is now allowed. Everything that really restarts or stops the computer still counts, and a few more forms now do too: `kexec`, `init 6` and `telinit 0`, the sysrq trigger, and the D-Bus Reboot call.

## [5.7.0] - 2026-10-24

Eleven changes since 5.6.0: see how a model reasons before it answers, a notice when an update is ready, Tiger Teams whose members work side by side, security warnings at the top, API keys kept in Settings, new installs that keep their folders inside the install, a plain message when a reply runs out of steps, and fixes for the phone, the model list and the workers bar. Your Maestro on 5.6.0 gets them when you press Update.

- **One card per agent in the workers bar.** When an agent asked another agent for help several times, the desktop's workers bar opened a new card for every call, so a review that went back and forth left a row of identical cards. Now an agent that already has an open card gets its next call in that card: the card goes back to working, and the new request and reply appear under the earlier ones after a "Called again" line. Calls that overlap each stream into their own reply, and the caller's chat still gets one notice per call. Temporary workers and the Claude client's own sub-agents still get a card per call. A card you close stays closed, and the agent's next call opens a fresh one. A page reloaded in the middle of a call rebuilds the single card, with each call's request (it used to show the card's label instead). Worker names and descriptions, which can come from a model, are now shown as text, never read as HTML. ⏹ Stop on a card now says what it does: the page stops following the call, which the hub may still finish.

- **Security warnings show at the top too, and can be hidden; critical problems can't.** The security banner used to appear only for critical problems. Warnings now show in a dark-yellow banner with an × that hides it in that browser until the list of warnings changes: a new warning brings it straight back, and a critical problem always shows, in red, with no ×. Running the check in Settings updates the banner at once. The notices at the top of the page now stack below each other instead of covering one another, also when the window narrows.

- **See how a model reasons before it answers.** Models that think before they reply (Claude, Codex, and the reasoning models on OpenRouter or on local servers) now show that reasoning in a panel at the top of the reply, on the desktop and on the phone. It streams in while the model thinks, stays with the saved reply, and follows a reply that was started on another device or before a reload. It starts minimized, showing only its header with a word count and "thinking…" while the model works: click the header to open it (and again to close it), drag its bottom edge to any height, or press ⤢ to read it at the size of the window (full screen on the phone). The reasoning is never part of the reply and never goes back to the model. On Claude it is Claude's own summary of its thinking, which costs nothing extra; Codex shows its short reasoning summary when it writes one. Turn it off in Settings → Agents → Agent Defaults → Reasoning.

- **The phone keeps your own last exchange when you load earlier messages.** On the phone, "Load earlier" and "Copy chat" rebuild the chat from a local copy of its history, and a reply you had just sent from the phone (with your message) was never added to it, so loading earlier messages made the exchange disappear until the chat was opened again; a reconnected reply could also appear there twice. Now, when a reply finishes in the open chat, the phone reads the chat's history back from your Maestro, which has already saved the reply with its tool calls and reasoning.

- **The model list in the chat header opens complete on the first click.** It used to fill in only after the first click, while the list was already open, so it showed one line, then jumped and was cut off. It is now filled when the chat opens, and a click that comes before the list waits for it.

- **All API keys in one place.** Keys used to live in two files: the ones typed into Settings in `data/settings.json`, older ones in `.env`, so finding or changing a key meant looking in both, and a key in `.env` needed a restart. Now every AI provider and web-search key is kept in Settings (`data/settings.json`, readable only by your account). When the hub starts, it moves any key it finds in `.env` into Settings, keeps the old file as `.env.bak-<time>` and leaves a note in `.env` saying where each key went. Settings → AI models shows which keys come from the environment instead (a service file or Docker), and those keep working. `HUB_KEEP_ENV_KEYS=1` keeps keys in `.env`.

- **New installs keep their folders inside the install.** The hub keeps your agents' Files folders, members' folders and team folders (`share/`, `users/`, `medical/`, `legal/`) in its "hub home". That used to be the folder above the install, which for the one-line installer's `~/mymaestroai` is your home folder itself, so those folders landed loose in it. New installs now keep them in `~/mymaestroai/hub-home/`. Installs whose folders already sit beside them keep them there. If yours sit loose in your home folder, `mymaestro move-home` shows what would move and `mymaestro move-home --yes` moves them: the hub stops and starts again, a link stays at each old place so paths your agents wrote down keep working, and the security check points to it. `mymaestro backup` now includes `hub-home/`, and `mymaestro help` no longer prints a stray line.

- **The hub tells you when an update is ready.** Other installs used to stay on whatever version they had until someone thought to press Update. Now, soon after the hub starts and then once a day, it asks GitHub whether its channel (stable or experimental) has something new. When it does, admins see a card with the new version and what's new, and two clear buttons: **Update now** (the same update as the Update dialog, then a restart; it warns first if agents are working) and **Later** (hides the card for a day; a newer version shows at once). On the desktop the card sits at the bottom right with a chip in the sidebar; on the phone it sits on the agent list, the ⋮ menu's Update item says a new version is ready, and each new version arrives once as a notification that opens the same choice. An entry starting with "Security" in the release notes marks the update as a security fix. The check reads only; it never installs anything by itself. It is on by default; Settings → Status → Updates turns it off and has Check now.

- **A reply that runs out of steps says so.** One reply on the Claude subscription may take up to 200 tool steps. A long job that used them all ended with "The agent's process stopped unexpectedly", which read like a crash. It now says the reply stopped at the step limit, that everything done so far is kept, and that "continue" picks up where it stopped.

- **Tiger Teams work with several members at once.** Members work at the same time, but the war room used to pour everything into whichever card was newest: some members' cards stayed empty, as if they had skipped their turn, and their replies showed up under someone else or under the coordinator. Each dispatch now has its own card, headed by its task, with that member's tools and reply. Every team also gets a shared folder, `share/common/tiger-teams/<team id>`, that every member can read and write, sandboxed or not, and the coordinator is told to put the team's files there; a draft the coordinator saved in its own folder was invisible to sandboxed members, so their first round failed. A team now keeps working when its page is closed, reloaded or loses its connection (it used to stop eight seconds later): the page follows it again and redraws what it missed, and a team opened later is redrawn card by card from its own history. Only Stop ends a team early, and the page says "Stopped". One member's failure no longer ends the whole team: the coordinator is told why, in plain words, and carries on; a member that is busy with another conversation is waited for, up to ten minutes; a roundtable skips a participant that can't speak; and a challenger that can't review stops the run with the reason, so Resume runs only the review again. Failures that must stop a team still do: a Stop, an action whose outcome is unknown (it may have changed something, so it waits for you to check), and a required data source that failed. A read-only tool that fails (Read, Grep, the team's archive) is just an error the agent sees, not a stop that needs the operator. Members on a Claude subscription model are answered through the Anthropic API key in a team: the war room now says so when the team starts (or warns that they will fail without a key), and their use is booked as API spend, so the monthly credit meter counts it.

- **The phone app no longer throws away a message you're typing.** When a new version of the phone app arrived, or the hub restarted, the app reloaded itself as soon as no reply was streaming, and whatever was in the message box was lost. Now each chat keeps a draft of its message box, so a reload, a restart or switching chats brings the text back, and a send clears it. The app also waits to reload while you're typing (the box is focused or holds text), for up to ten minutes.

## [5.6.0] - 2026-10-21

Five changes since 5.5.1: the phone's Send button and keyboard, the Claude plan figure, a monthly API credit meter, safer updates, and a test that no longer fails at random. A hub on 5.5.1 gets them by pressing Update.

- **The Claude plan figure no longer drops to about 1%.** After any reply on the Claude subscription, the plan chip and badges could read "Plan 1%" for a week at 76%, until the next check put it right. The Claude client reports usage with each reply as a fraction (0.76), and the hub stored it as if it were a percentage. It's now converted, so the chip, the warnings and the Settings → Claude plan box stay on the real figure.
- **The phone's Send button takes the whole touch.** On a phone the first tap on Send could still only close the keyboard, leaving the message in the box. The Send and 🔔 buttons now cancel the touch itself and handle it themselves, so the browser can't turn it into a scroll or move focus off the message box. Once the message has gone, the box lets go and the keyboard closes; a tap with nothing to send leaves it open. As on any button, sliding off before letting go does nothing, and only the main mouse button counts. Mouse, keyboard and screen-reader activation still send, and a screen reader's send closes the keyboard too.
- **See your monthly API credit at a glance.** Set a provider's monthly credit in Settings → Money and safety → Spend: an amount, and the day it renews. One example is the API credit that comes with a Claude Max plan. A chip beside today's spend then reads "credit $41.20 of $200". It turns amber at 75% and rose at 90%, and its tooltip names the provider and the period. On the phone, the same figure sits at the top of the ⋮ menu. It counts calls made through the hub, at the cost its spend ledger books, so the provider's billing page stays the exact figure; calls with no known price are listed apart, not counted as free. Claude subscription turns never count. Admins only; nothing shows until an amount is set.
- **Updates install packages safely, and say so when they can't.** When an update changes the hub's packages, the in-app updater used to run a plain `npm install`. That ran install scripts, could rewrite the lockfile (which then blocked the next update), and on failure still reported success, so the page restarted the hub into code whose packages were missing. Now it installs the way the installer does: `npm ci --omit=dev --ignore-scripts`, then a rebuild of better-sqlite3, using the npm that ships with the hub's own Node. npm gets only the environment it needs: none of the hub's keys or tokens, nor the desktop's SSH agent or keyring. The packages for the incoming code are installed in a side folder before any code moves, and they replace the old ones only once every dependency is in place and the database module loads. So a hub stopped during a slow install still starts, on its old code with its old packages. If the install fails, nothing changes and the update says why in plain words; the pages and `mymaestro update` restart only after a successful update. A channel switch that changes the packages now installs them too, a package missing from an install is put back by the next update, and two updates can no longer run at once, from the pages or `mymaestro update` (if an update is ever killed mid-way, its lock file is named in the message, to be deleted by hand).
- **A job-runner test no longer fails at random.** It cancelled a job before the job had recorded its process, then deleted the job's folder while the job was still starting, which collided on busy machines (seen once on GitHub's test runner). It now waits for the process to start and to be gone.

## [5.5.1] - 2026-10-21

A security release. For a hub on 5.5.0, this is the only change.

- **Security: Node.js 22.23.4.** Node.js issued security fixes on 2026-10-21 (the highest rated HIGH for the 22.x line), touching outgoing HTTP connections, DNS lookups, TLS checks of IP addresses and Brotli decompression. New installs now get Node.js 22.23.4 (its checksums taken from nodejs.org's signed list), and the automatic tests run on it. An install made with the one-line installer keeps its own Node.js until the installer runs again: running the same one-line command again updates that install in place to the newest version of its channel, replaces its Node.js and keeps your settings, agents and data (an install that follows experimental adds `bash -s -- --channel experimental`). The installer now refuses to move an install whose branch has commits of its own that GitHub does not have. A hub that runs on the computer's own Node.js gets the fix from the system's updates; restart the hub afterwards. Hubs no longer miss this quietly: once a hub has this update, a Node.js older than its line's last security release turns the security check red when Node rated that release HIGH or CRITICAL (the admin banner shows it, with the exact fix for that install), and Maestro raises it with you at the start of its next reply and offers to do the upgrade, which it does only once you agree.

## [5.5.0] - 2026-10-19

Everything since 5.4.0 (2026-09-22). For a hub that was already on the previous stable (2026-10-18), only the first five entries below are new.

- **Tool calls stand out in the phone app.** In a reply, each tool call used to be grey code-style text that was easy to mix up with the reply. It is now light blue on a faint blue panel with a blue bar, with the tool's name in bold ("✓ **Bash** · grep -c error server.log"). A call that failed is red. The reply's own text is unchanged. Phone app version v50.
- **Claude on an API key no longer fails while it thinks.** Claude 5 models think by default, and while they do, Anthropic's stream carries only a keep-alive ping about every 30 seconds and hands over the whole thinking block at the end (measured on `claude-fable-5-1` at effort Max). The hub's stream reader dropped those pings, so its two-minute silence timer cut off any longer think as "The model returned nothing (empty stream from anthropic)", about every other turn for an agent on Max effort. Now:
  - **Thinking keeps the connection alive:** every event without output passes a keep-alive to the silence timer. A connection that really goes silent still closes, with "Anthropic sent nothing at all for 120 seconds" in place of "returned nothing".
  - **Anthropic's own errors are shown:** an error inside an open stream (for example "Overloaded") now says the provider is busy, instead of "returned nothing".
  - **Room to think:** Claude 5 models (Fable, Opus, Sonnet, Haiku) may now use up to 128,000 output tokens, the API's own limit (it was 32,000). Above Medium effort a turn gets at least 64,000 unless the agent has its own Max tokens or the hub's Max tokens was lowered below its 32,000 default; tokens are billed only as used.
  - **No paid retries of an empty think:** when thinking uses the whole allowance and nothing was written, the turn stops and explains (send again, or lower the effort). It used to ask the model to "continue" up to five times, and each time the model started thinking again from scratch.
  - **The right context window:** Claude models on the API were sized at the 128,000-token default, so long conversations lost recent turns they had room for. They now get the same window as on the Claude client: 1,000,000 for Fable 5, Opus 4.7+, Sonnet 5+ and Haiku 5.5, and 200,000 for older models.
- **Settings in six groups instead of one long list.** The ⚙️ panel's 17 sections are now folded into **Status** (setup checklist, security check), **AI models** (providers, OpenRouter, Claude plan, local models, auto model classifier), **Agents** (defaults, sandboxes, member permissions, approval cards), **Notifications**, **Tools and data** (web search and fetch, data connectors, modules) and **Money and safety** (spend, emergency stop). The groups start closed. Each header has a one-line summary, for example "Setup: all good · Security: 6 warnings", "5 provider keys · OpenRouter: 10 models · Fable 100% this week", "Today $4.12 · no daily caps". Click a header to open it; this browser remembers which groups you left open. A search box at the top shows only the sections that match (for example "sandbox", "push", "privacy"), opens their groups and marks them; Escape or clearing it puts the groups back. **Status opens by itself, its summary in red, when the setup checklist or the security check finds something critical.** Links into Settings open the right group first: the Claude plan badge, today's spend in the header, and the setup and security banners. A group the hub opens by itself (a critical finding, a link, a search) is not remembered as your choice, a red Status stays in view during a search, and the summaries follow changes made inside Settings. Desktop page only.
- **A message lost on the way is no longer answered with an older reply.** When the connection dropped as a message was sent (desktop or phone app), the page looked for the message in the agent's history by its words alone. So a message the hub never received, with the same words as an earlier one (a second "Build it"), was answered with that earlier message's reply, hours old. Now a history entry counts only if the hub saved it after the message left; the send time is read on the hub's own clock (the history response's Date header), so a device clock that is off doesn't matter. A message the hub has no record of says so and goes back in the message box, with a hint to reload the chat before resending if unsure; one it did get still shows its own reply when the connection comes back. Phone app version v49.
- **Automatic tests on every pull request.** A GitHub Actions workflow (`.github/workflows/tests.yml`) runs the full test suite on each pull request into `dev` or `main`, on each merge into them and on demand, installing as the installer does (Node 22.23.3, packages without install scripts, then a rebuild of better-sqlite3). Its actions are pinned to full commit hashes, its token is read-only, and no run after a merge is ever replaced by a later one. `npm test` is now that suite (`scripts/run-tests.js`: every test file at any depth except the two that need a running hub or real agents, skipping hidden files such as macOS `._` copies; it stops if it finds none). Two integration test files that had been left out are back, with their stale expectations updated, and two tool-policy tests no longer assume the hub sits in `~/agent-hub`. `CONTRIBUTING.md` and a pull-request checklist describe the flow.
- **Know whether a model will work before an agent depends on it.**
  - **The hub remembers what each model did.** When a reply fails for a reason that belongs to the model or its provider account (blocked by the privacy setting, can't use tools, gone, key refused, out of credit, local server not running), the model gets a mark in every model picker, desktop and phone: "nemotron-3.5-super-vl:free · API $ — ⚠ blocked by the privacy setting". The next reply that works clears it. Passing trouble (rate limits, busy servers, the network) leaves the record alone.
  - **A quick test before switching.** Moving an agent to a model this hub hasn't seen answer first sends one tiny request through the same route the agent will use, with one tool to call. It costs a fraction of a cent, and nothing when refused. If the model is refused, or answers without using the tool, you see why and what to do, and choose whether to switch anyway. Claude and Codex subscription models are not tested per request. The agent settings page's ⚡ Test button runs the same test.
  - **Warnings in "🔎 More OpenRouter models…":** free versions say when the privacy setting blocks them and name the paid version; models that can't use tools or whose context window is too small for the hub's instructions say so; models that worked here show "✓ Works here". Blocked ones are listed last.
  - **An agent that consults a failing agent** now gets the same plain explanation the person sees, not the raw provider text.
  - **Fixed:** the spend log recorded every failed API reply as successful.
- **Errors that say what to do.** When a model's provider refuses or fails a reply, the chat used to end with the raw text (`[Error: Provider 404: {"error":{…}}]`). It now says what happened and what to do, with the provider's own message on a last "Details" line. Examples: a free OpenRouter model blocked by the privacy setting suggests the paid version and its price; an empty account says where to add credit; a refused key says where to paste a new one; a conversation too long for the model says how to start a new session; a local model server that isn't running says to start it. Plain rules over the status and the message, so it works when every provider is down. The explanation is saved with the reply, so a reload or another device shows it too, and failed replies no longer become session notes.
- **Every OpenRouter model from the chat header, on the phone too.** The model picker lists only the OpenRouter models ticked in Settings → OpenRouter (8 by default, out of about 400), and the phone app had no way to reach the rest. The OpenRouter group in the picker now ends with **🔎 More OpenRouter models…**, on the desktop and in the phone app. It opens a search over OpenRouter's whole catalogue: tool-capable models newest first (models without tools on request), each with what it can do, its context window and its price. Choosing one switches the agent to it and adds it to the OpenRouter list, so every picker offers it from then on. If the hub could not keep it in the list, the confirmation says so. Admins only, like the picker.
- **Reasoning effort for OpenRouter models.** The effort picker in the chat header (desktop and phone) now also shows for OpenRouter models that take a reasoning level (OpenRouter's catalogue says which, the same flag the hub already used to send it), and hides for those that don't. The level goes to OpenRouter as `reasoning.effort`; these models take low to high, so Extra high and Max are sent as High. The pages read the flag from the OpenRouter list (admins), so the picker appears a moment after the chat opens.
- **OpenRouter's "latest" aliases can be saved.** Ids such as `~x-ai/grok-latest` (which follow a vendor's newest model) were dropped when the OpenRouter list was saved, from Settings as well; the list now keeps them.

- **OpenRouter as a provider.** One key (Settings → LLM Providers, or the Welcome page's API-key step) gives agents models from many vendors (Grok, DeepSeek, Kimi, Qwen, Mistral, GLM, Llama, MiniMax, and Claude, GPT and Gemini too), as `openrouter/<vendor>/<model>`, with the same tools, memory and policy as every other agent (the hub's own tool loop). **Settings → OpenRouter** lists OpenRouter's catalogue with search (🛠 tools, 🧠 reasoning, 🖼 images, window, price): tick the models the pickers offer; until you do, the hub offers the newest tool-capable model of each vendor it has no key for. Each call's cost comes from OpenRouter and goes into the daily spend; Claude models through OpenRouter get the hub's cache breakpoints; reasoning effort (low, medium, high) works where the model takes it; context windows and image support come from the catalogue. **Privacy:** by default the hub asks OpenRouter to use only providers that do not store or train on prompts (a switch in the same box). The key is checked with OpenRouter's free key lookup, never by spending.

- **Phone notifications only when you want them.** Finished replies no longer notify your phone on every turn (they did for every agent, including the ones Maestro consults behind the scenes). While a reply is running, a **🔔 Notify me** button sits next to the Interject button, by the message box, on the desktop and on the phone (it disappears as soon as the reply is done): tap it and you get one notification when that reply is done, on your own devices; tap again to cancel. It works for any running reply (started on the desktop, the phone, a scheduled task or an alert), and every screen you have open shows whether it is on. A question an agent asks you (or an approval) notifies only once it has waited **3 minutes** unanswered; change or turn that off in Settings → Notifications (`settings.notify.questionAfterMinutes`). Question reminders go to the agent owner's devices (a member's own agents notify that member only). Members can now also read their own agents' running-turn view.

- **Agents' questions reach the phone app.** A question an agent asks (ask_user) now appears in the phone app also when it was asked before the app joined the reply (the app was closed, or opened in the middle of a turn: joining a running turn fetched the question and dropped it), when it arrived while another screen was open (it was parked under the wrong name and never shown), and after the chat is closed and reopened (the unanswered question is put back). A question for a chat that is not open shows a notice, "❓ Maestro is asking you something. Tap to answer.", that opens the chat.

- **`mymaestro` finds its service on more machines.** A broken link among the user's service files (left by a removed service; `gnome-remote-desktop.service` on Ubuntu, for example) stopped the search, so on installs without `data/install.json` (those made before the installer) `mymaestro start` started a second, unsupervised copy instead of the service, and `restart`/`status` lost track of it. Unreadable files are now skipped, on Linux and on a Mac.

- **The Welcome page knows whether Claude is ready.** When Claude Code is on the computer, the AI step checks its sign-in by itself (one quick question), so a signed-in owner sees ✓ and Continue without pressing anything, and a signed-out one sees the sign-in steps. Resuming setup and "an AI is connected" now count Claude only when it is really signed in (its saved sign-in or, on a Mac, its Keychain entry exists) or a Welcome check passed (`claudeOkAt` in `data/welcome.json`), no longer merely because the `claude` program is installed. The installer says in one line whether Claude Code is on the computer and signed in. A failed Claude or API-key check now shows what to do, with the provider's own message under Details (it used to show only the raw message, such as "Not logged in · Please run /login"). A Claude check is no longer reported as a local engine in `GET /api/welcome/state`.

- **Setup resumes where it stopped.** Signing in to Claude can open its page in the same browser tab as the Welcome page, and a new owner had no way back. Now the hub remembers that setup started (`data/welcome.json`) and, until Maestro's first answer or "Skip for now", its address sends the administrator back to the Welcome page at the step they reached; the installer's Desktop shortcut opens that address and the installer says so. The Welcome page shows how to get back on every step, warns in the Claude card that sign-in may take over the page, checks Claude by itself on return, re-reads progress after the Back button, and offers "Skip for now" and "Use a different AI".

- **The code is public:** https://github.com/mymaestroai/mymaestroai (license unchanged: PolyForm Noncommercial 1.0.0). The installer clones it without a sign-in: `curl -fsSL https://mymaestroai.ai/install.sh | bash` (the website serves the same script as install/install.sh; hubs installed from the old private repository move with Update, or with https://mymaestroai.ai/move.sh when Update says "Update blocked"). SECURITY.md says how to report a security problem privately (GitHub private vulnerability reporting). The repository starts with a fresh history; installs that followed the earlier private repository move to it with an update.

- **Phones and second computers follow a running reply live again.** The hub refused its live event stream to every page opened through the tailnet address (`*.ts.net`, how the phone and other computers reach it through Tailscale Serve) unless that name was listed in `HUB_ALLOWED_HOSTS`, which only `tailscale-setup.sh` writes. Those pages fell back to slow polling: a reply's text arrived in jumps and its tool calls never showed. Tailscale names are now accepted, as the rest of the hub already did. Also: a page that follows a turn without a live stream (refused, asleep, a proxy that buffers) fetches the turn every 4 s; the phase bar ("Running Bash · 12s"), the token counter and the context line now reach every window that follows a turn (new event `turn_progress`, also in the turn view), also once the sender's browser has gone; a reply saved in progress (every 5 s) is flagged in `/api/history` (`inProgress`) and no longer shows as a text-only copy above the live turn; the history copy never rolls the live text back; the phone's header keeps the line under the agent's name for what it is doing (effort, plan and context moved to their own row; the Stop button is a square on narrow phones).

- **A reconnected reply reads like a live one.** After a reload, a reopened chat or from another device (desktop and phone), the running reply shows its text and its tool calls (and workers) in the order they happened, as it does for the window that started it; the phone now lays out its own replies that way too (it used to put every tool call above one block of text). The hub records where in the reply each call started (`item.at` on `turn_activity` and `GET /api/agents/<name>/turn`). Saved replies keep the tool calls of their turn (`activity` on the assistant entry in `data/conversations/<agent>.jsonl`, offsets in the saved text, output clipped, at most 120 per reply), so history shows them too after any reload. Text that resumes after a tool call starts a new paragraph, so saved replies no longer glue sentences together ("Checked.Found it."). Older history is unchanged.
- **One name: My Maestro AI.** Every place a person or an agent sees the product's name now says My Maestro AI: page titles and headings (the desktop sidebar, the phone app's top bar, which keeps the full name next to the owner picker on narrow phones), restart dialogs, push notification titles, the authenticator label for new two-factor enrolments (existing entries keep their old label; the codes keep working), agent prompts and new agents' IDENTITY.md, generated config comments, the startup banner, README, LICENSE (commercial licensing through www.mymaestroai.ai), NOTICE and the hub map. Internal names (the install folder, `data/` files, settings keys, the `agent-hub` tool server, the Hyperliquid agent name) are unchanged, so existing installs keep working.
- **Removed: an unused exchange add-on** (a module that was never used with a real account) and the last mentions of the old delegation bridge. The modules framework is unchanged; its tests use the fixture module in `test/fixtures/modules/`.
- **Pre-publication scrub** (Sentinel's review of 2026-10-17, items 1-12): test fixtures no longer use this machine's Tailscale addresses, ports or tailnet name, a real Slack channel id, a test user named after the owner, or a family case (mobility aids, a deed, a power of attorney, lab values); install-specific agent names in tests and defaults are neutral (the Telegram default is the lead agent only). Removed: the leftover workplace usage dashboard (`/ai-dashboard`, its API stub and public route prefix, the Snowflake settings block), `PORTING-GUIDE.md`, and a stock tiger image whose licence does not allow redistribution (the Tiger Team page uses the project's own SVG). The Maestro user template is written for a household instead of a workplace. `scripts/clean-bundle.sh` builds from tracked files only (`git archive HEAD`), so files in the working folder never reach a bundle. The installer sets the code's GitHub location in one variable (`REPO_SLUG`, `MM_REPO_SLUG`); README and installer texts no longer assume a private repository.
- **Claude plan: warnings instead of silent model switching.** When a weekly allowance of the Claude subscription (Fable, Opus, Sonnet, or all models) passes a warning level (default 75% and 90%, `settings.planWarn`), the hub says so once per level: a chip in the sidebar header ("⚠ Fable 90%", click for the Settings box), a push to admins' devices (push subscriptions now record the account that registered them), and one line in each affected agent's next reply. Every chat with an agent on the Claude subscription shows its usage next to the model ("Fable 90% this week", gold past the first level, orange past the last; "Fable 90%" in the phone header); no pop-up. Brief toasts on the desktop now appear near the top instead of over the message box. **Settings → Claude plan** shows the windows with their reset times, the levels, and every agent on the Claude client with a model picker. The automatic switch to a cheaper model (`settings.planFallback`) is now **off by default**; turn it on in the same box. A refused turn says to pick another model instead of promising a fallback.
- **Context size always visible.** The line under each chat's toolbar shows the context from the first reading on ("context 29% · 275K of 950K tokens · compression: on at 90%") and moves during a reply; it used to appear only past 50% and vanished after every compression. The phone shows "N% context" in the chat header.
- **One-line installation.** One command (see Quick Start in the README; the script is `install/install.sh`) installs My Maestro AI on a Mac or Linux machine without sudo: its own Node.js 22 (SHA-256 pinned per platform), the code with git, packages (`npm ci --ignore-scripts`, then the database module), private `.env` and `data/`, a service that starts it by itself (systemd user unit with linger, or a launchd agent), the `mymaestro` command, and the Welcome page in the browser. For a private repository it uses the user's GitHub SSH key or a read-only token kept in a 0600 file. `--dry-run` changes nothing; `--uninstall` keeps your data.
- **Welcome page** (`/welcome`, replacing the old setup wizard): the first account needs the one-time setup code the installer prints (`data/setup-token`; `mymaestro setup-link`), so no other program on the machine can claim the hub; then two-factor with recovery codes, one AI proven by a real request (a Claude subscription check, an API key listed without spending, or a local engine), and Maestro. `/setup` and `/setup-admin` redirect there; the old routes that rewrote `.env` wholesale are gone; an empty `.env` no longer counts as configured. **Upgrade note:** an install with no account yet needs the setup link to create one (`node scripts/hub-cli.js setup-link`, or the line in the server log).
- **Maestro's setup interview.** A fresh install's Maestro interviews the owner: who they are, which agents they want (Doc, Counsel, Developer, Personal Assistant, others), the model for each (it picks from what the install can use; the lead agent's brief now lists the models it can assign), their personalities; it builds them, runs a sample task with each, walks through the phone app (Tailscale), and says plainly that nothing needs a restart.
- **The `mymaestro` command** (`scripts/hub-cli.js`, `lib/service-manager.js`): status, start, stop, restart, logs, open, setup-link, update, doctor (including a real Claude sign-in test), backup, reset-2fa, service install/remove, uninstall. Works while the hub is stopped, and finds the service of installs made before the installer.
- **Help.** A **?** button at the top right opens Help beside the chat (also in the phone menu and on the sign-in page): creating and changing agents, models, reminders, files, family members, the phone app, and what to do when something is wrong. A Claude turn that fails because the sign-in is missing or expired now says how to fix it, in the chat.
- `scripts/tailscale-setup.sh` works on Linux as well as macOS and restarts the hub through its service. Browser tabs and the phone app are named My Maestro AI.
- **Removed:** `setup.sh` (asked for Node 18 and wrote provider keys to a world-readable `.env`); the installer and the Welcome page replace it.

- **Task scheduler view.** The 📅 panel opens on what is live: active or paused scheduled tasks, running background jobs and enabled TASKS.md tasks. A bar at the top switches to **Last 24 hours**, **Last 7 days** or **Everything** (past runs appear under a time range), turns whole sections on or off, and opens the new-task form, which now stays closed until you ask for it or edit a task. Each trimmed section says what it is not showing ("Not shown: 16 done, 10 cancelled") with a link to everything. The choice is remembered per browser. Scheduled tasks now report their last change time, so a task cancelled today counts as today.
- **Update channels.** The Update dialog now asks, every time it opens, which channel to follow: **stable** (branch `main`, promoted code) or **experimental** (branch `dev`, the latest work). The current channel is preselected and the dialog shows what the other would add or leave behind; choosing it switches branches and updates in one step, and you can switch back the same way. Branch names can be overridden with `HUB_STABLE_BRANCH` / `HUB_EXPERIMENTAL_BRANCH`. The lead agent's "this hub" brief names the branch and channel. The phone app gains the same **Update hub** entry in its menu (admins only), with the channel question, the incoming commit count, and the restart that follows.
- **Security check.** Settings → Security check reviews the installation's security configuration and says what to fix: accounts and two-factor, exposure (bind address, Tailscale Serve or Funnel, tunnels, notification endpoints), secret file permissions with a one-click tighten, secrets in git, personal credentials in the hub user's home, agent policy overrides and folder reach, member agents on the host, approval cards, web-fetch private access, container hardening, the Claude sign-in inside containers, API tokens, root (sudo without a password, the docker group, grants, the audit), services open to the network, SSH, backups, the Node.js line, a pending restart, local edits and the lock file. It runs nightly (`HUB_SECURITY_CHECK_HOURS`), a red banner names anything critical, and `node scripts/security-check.js [--json] [--fix-modes]` runs the same check from a terminal with no hub and no agent (exit 2 critical, 1 warnings, 0 clean). Reviewed with the security agent; nothing it prints is a secret.

- **Removed: an unused delegation bridge** (its files, routes, desktop worker tabs and settings). Nothing in the hub used it, and it had been the one route handled before the login gate.

- **Sandboxed agents stay inside for background work.** A sandboxed agent's `run_job` (and `Bash` with `run_in_background`) now runs inside its container through `docker exec`, with the job's working directory checked against the box's folders; a cancel or timeout stops the process inside the box too; when the sandbox is unavailable the job is refused instead of running on the host. Every admin-side container also mounts `share/common`, one folder the owner's agents share. Changing an agent's folders, sandbox mode or hands rebuilds its container on the next turn.

- **Root grants: the operator can hand one agent root for a while.** On an agent's settings page (Tool policy → Root) an admin grants root for 15 minutes to 24 hours with a note; the grant is enforced by the policy gate on the agent's next root command, expires on its own, can be revoked at once (there and under Settings → Approval cards → Root grants), and is written to `data/root-commands.jsonl` and the hub's audit table. Never for a member's agent or for an agent whose shell runs inside a container; the hub's own service identity cannot create one, so no agent can grant itself root. `lib/root-grants.js`, routes `/api/root-grants`.

- **Root is the lead agent's alone, and visible.** The policy gate recognises `sudo`, `doas`, `pkexec` and `su` at the head of a shell command (in `Bash` and `run_job`, under any tool prefix): the command is at least an admin action (the inner command can make it destroy), every root command is written to `data/root-commands.jsonl` with its outcome, and any agent other than the lead is refused outright, whatever its admin rule says. New setting `approvalClasses` (Settings → Approval cards → "Always ask for"): the listed kinds (root commands, wallet and exchange, destructive, hub data, sending) get an approval card even while cards are off overall, so the owner can confirm each root command without turning every card on.

- **Security, first batch (from the 2026-10-16 architecture review).** *Static files:* an allow-list of the UI's pages and assets (`lib/static-files.js`, real path inside the install) replaces the fallback that served any existing file under the install folder (`.env`, `data/`, the release tarball) to any signed-in user. *Policy gate:* the hub's hands under their MCP names (`mcp__hub__Bash` …) classify exactly like the client built-ins (they fell through to "read", so an agent on hub hands was never gated); `RestartHub` is an admin action; on the gateway path the gate resolves relative paths against the same directory as the hands; temporary workers use their parent's sandbox and carry its owner; a consult's owner check runs before any stand-in worker. *Requests:* a malformed cookie or path escape answers 400 instead of ending the process. *Access:* `/v1` refuses admin sessions that have not finished two-factor; a token sees only its agents' turns; a member changes an agent's model only within `memberModels`; a member's agent never runs Codex with its sandbox bypassed; browsers and tokens cannot set the hub-internal chat fields (`image_files`, `consulted_by`, `origin`; members also not `override`, `ephemeral`, `tiger_team`, `consultation_depth`); `walletOwner` is no longer accepted by `POST /api/settings` (`HUB_WALLET_OWNER` or the settings file); when no lead is flagged, a member's assistant is never a lead by default. *WebFetch:* private addresses are refused for everyone by default (`webFetch.allowPrivate` default `none`; `admin` restores the old behaviour); the hub's own port, its local model ports and link-local/metadata addresses are never fetched whatever the setting; hex IPv4-mapped IPv6 addresses are recognised. *Downloads and headers:* HTML/SVG/XML/script files from the Files panel are always attachments and inline text documents are sandboxed; every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: SAMEORIGIN` and a baseline Content-Security-Policy (`base-uri`, `form-action`, `object-src`; a script policy follows once the pages drop their inline handlers). *On disk:* settings, OAuth tokens and `.env` are written owner-only and the `.env` writer strips line breaks. *Loader:* the hub's own installed SDK copy is preferred over a newer global install.

- A model call that returns nothing at all (no text, no tool call, no finish reason, no usage) is no longer saved as a blank reply. For a local engine, which may still be loading or whose proxy is re-reading its config, the same request is sent again after 2.5 s and once more after 6 s, with a notice in the chat; otherwise, or after a third empty answer, the turn ends with a visible error. Proven on a test hub with an engine that answers its first call with a non-stream body.

- **Local models: one proxy for every local engine** (lib/local-models, `/local-models` page, provider `local/`). The hub installs a pinned, checksum-verified llama-swap release and writes its config from a registry the owner edits on the page: llama.cpp models (GGUF, with vision projector and speculative draft files), NInfer models (`.ninfer`), or any command that serves an OpenAI-compatible API on `${PORT}`. The proxy starts the engine a request needs, keeps the model loaded while in use, swaps on a different model and unloads idle ones (per-model or global idle timeout); it runs detached, so loaded models survive hub restarts, and starts with the hub when switched on. The page detects engines (llama-server from the hub's own build, PATH, Homebrew or LM Studio's bundled binary; ninfer-serve), builds llama.cpp for the machine as a background job (CUDA when present; brew on a Mac), scans model folders, loads, tests and unloads models, shows the proxy log, and refreshes the hub's model list. Models appear as `local/<id>` everywhere a model is chosen; they are free in the ledger; the registry's context window feeds the elastic context; the setup checklist reports a missing proxy or engine.

- **The hub map for the lead agent** (`docs/HUB-MAP.md`): a complete operational map of the software, written for the agent that helps with setup and configuration: where every file and folder is, what each `lib/` module does, every `.env` variable and settings key, accounts and access (roles, sessions, API tokens, exposure rule), the agent record and workspace, turns, memory and context on each model route, tools and the policy classes with the role defaults, sandboxes, extensions, the API by area, a troubleshooting table and sixteen step-by-step setup recipes. The shipped Maestro template (`templates/workspaces/maestro/SOUL.md`) now tells a fresh install's Maestro to read it before any installation, configuration or repair conversation. The lead agent also gets a short **"this hub" brief on every turn** (`lib/hub-map.js`, all three model routes): version and commit, when the process started and whether code changed since (restart pending), install and hub-home paths, port and exposure, supervisor, accounts, agents by category, providers with keys, Claude sign-in, sandboxes, the setup-checklist summary, the operating rules in one line and the map's table of contents. The text is stable between state changes, so a resumed Claude session is re-sent it only when something changed; `hubBrief: false` in settings turns it off. The full map is never loaded automatically.

- **API tokens for programs** (lib/auth tokens, lib/access TOKEN_ROUTES). A script, bot or dashboard that calls the hub signs in with `Authorization: Bearer hub_…` instead of a person's session. An admin creates tokens on the Users page ("API tokens for scripts") or with `node scripts/hub-token.js` (works with the hub stopped, `--out` writes the secret to a file with mode 600). Each token names its scopes (chat, interject, status, wallet-executor, openai-api) and, for chat/interject, the agents it may address; by default it is accepted from the hub machine only (a request through a proxy such as Tailscale Serve does not count); optional expiry; revocable; shown once, stored hashed; creation, revocation and use are audited. Calls outside the scopes get 403 token_scope. The OpenAI-compatible endpoints (/v1/models, /v1/chat/completions) now require a token with the openai-api scope or a signed-in admin once accounts exist (they had been open to anyone who could reach the port). Why: cron bots written before accounts existed had been refused with 401 for days and read the refusal as "agent busy".
- **Old password login retired once accounts exist.** HUB_AUTH_USERNAME/HUB_AUTH_PASSWORD (an admin without two-factor, compared with plain `===`) are honoured only while the hub has no accounts; with accounts they are ignored, the hub warns at start and the setup checklist asks to remove them. Network exposure (HUB_BIND_HOST) with accounts requires an admin with two-factor enabled; the hub's own loopback calls no longer attach the pair (they carry the per-process service token).

- **Reasoning effort per agent** (lib/effort): Default, Low, Medium, High, Extra high, Max. Chosen next to the model in the chat header (desktop and phone) and on the agent settings page; admins only (members see the level their admin set; the field is not member-editable). Translated per route, checked against the live APIs: Claude client (Agent SDK `effort`) and Anthropic API (`output_config.effort`) take all levels; OpenAI API and Codex (`reasoning_effort` / `model_reasoning_effort`) top out at xhigh; Gemini at high; non-reasoning OpenAI models and local servers get nothing, and the pickers hide for them. OpenAI refuses function tools with reasoning_effort on /chat/completions, so such turns go to /responses. Proven with real turns on all five routes (the Claude client reported CLAUDE_EFFORT=low). Before this, Claude agents ran at the client's default (medium here).
- Phone app: change an agent's model from the chat header. Tap the model line under the agent's name (▾): the phone's own picker lists every model the hub can reach, grouped like the desktop (Anthropic · Subscription, Anthropic · API $, OpenAI · Subscription (ChatGPT), OpenAI · API $, Google, Perplexity, Local); same route as the desktop; admins only; a toast confirms (or says the switch happens after the current reply). Also fixed: the header Stop button showed on idle agents (the button style overrode the hidden flag). App cache hub-mobile-v30.
- **Resumed Claude-client sessions now see context changes** (lib/context-refresh). The Claude client keeps the system prompt a session started with; on resume the hub's fresh personality, Records, memory and settings text was ignored, so an agent never saw anything changed after its session began (a canary Record was invisible; the reported system-prompt size never moved). The hub now remembers, per agent and session, what the session has received and puts only the changes at the top of the next message (<hub_context_update>: changed sections in full, appended records as the appended part, removed ones listed; oversized ones named with "read the file"). A session with no baseline (every session older than this change) gets the full current context once; a client-side compaction resets the baseline. Per-message search hits now travel with the message on this path too. Proven on a test hub: a Record and a personality rule added mid-session were seen and followed on the next resumed turn, with no resend after that.
- **Modules**: optional capabilities with a guided setup (Modules page). One folder per module (modules/<id>/: module.json, setup.json, optional index.js; format in modules/README.md); core in lib/modules (manifest validation, pinned npm installer with scripts off, step engine: explain / outside / install / secrets / check / settings / grant / finish, state in data/modules.json). A module runs as a data connector whose command is lib/modules/mcp-guard.js: unlisted or "off" tools are hidden, the module's guard() checks every call with live settings (invalid values fall back to the safe default), money calls are reserved before they go out and run one at a time, every non-read call is logged with secrets blanked; batched JSON-RPC, reserved ids and id-less calls are refused. Money modules reach wallet agents only, never member agents; module connectors cannot be edited from the Connectors page; module changes are refused from the hub's internal service identity. Connectors: "money" tool class, one start at a time per connector. Setup checklist lists unfinished modules.
- A chat turn for an agent that does not exist is refused with 404 ("No agent named …") instead of running on a default model under that name, which hid lost agent records.
- Prompt caching on every API-key route. Anthropic: cache breakpoints on tools, system prompt and the latest message (settings.promptCache {enabled, ttl 5m|1h}). OpenAI: per-agent prompt_cache_key (hashed). All gateway providers: the opening of each request stays identical between calls: past messages carry absolute times instead of "[5m ago]" (which changed every turn and defeated every provider's cache, NInfer/LM Studio prefix caches included), old messages are dropped in blocks of 12 instead of one per turn, and per-message search hits travel with the current request instead of the system prompt. Usage counts cached reads/writes (Anthropic cache fields, OpenAI/Gemini prompt_tokens_details.cached_tokens); the ledger prices them at cache rates; a [cache] log line per turn. Measured on a throwaway hub: Claude API 98-99% of input from cache after the first turn ($0.097 -> $0.007 per tool turn on Sonnet 5.5); GPT-5.5 94-96%; Gemini at Google's discretion (0-44%). Subscription agents were already caching (verified in the client's usage records) and are unchanged.
- Creating agents at the same time no longer loses some of them: createAgent re-reads the agent list after the personality step (a model call of several seconds) instead of saving the list it read before it.
- anthropic/ (API key) route: tool use works. The hub's OpenAI-format history is now converted to Anthropic's format (assistant tool calls -> tool_use blocks; tool results -> tool_result blocks in one user message, ahead of any note or image the hub adds; consecutive roles merged; a tool call left without a result answered as not run). Before, the second model call of every tool-using turn failed with 400 "Unexpected role \"tool\"" (reported by a tester running a cloud install). Proven against the real API: parallel tool calls, results, a follow-up turn.
- Token usage on the gateway path: the Anthropic stream reports input (incl. cache) and output tokens, OpenAI and Google streams ask for usage, and the tool loop books each turn's provider-reported tokens (summed over its tool rounds; Gemini's running totals counted once, thinking tokens included) so the ledger prices API-key turns instead of booking them at $0. Anthropic max_tokens now maps to finish_reason length, so the existing cut-off resume applies.
- Update button: a rewritten GitHub history (for example after personal details were scrubbed) is recognised instead of reported as hundreds of "local commits not pushed". Local commits are matched to their rewritten copies by author and committer time plus subject or changed files; the dialog explains it and offers "Move to GitHub's History & Restart" (old position kept as a backup/before-rewrite-<time> branch; files the new history stops tracking are copied to data/backups/update-<time> and kept when now ignored; data/ and workspaces/ untouched). Commits with no copy upstream are listed and need a tick; plain local work stays blocked. Copies still on the old Update code need the one-time `git fetch origin && git reset --hard origin/main`.
- Settings: a hand edit of data/settings.json (walletAgents, walletOwner, teamTemplates and other settings the UI does not offer) is picked up while the hub runs and is no longer overwritten by the hub's next save; a half-written file keeps the loaded settings.
- Tests: the wallet tests use their own dummy owner address instead of reading the install's settings; look-alike address fixtures no longer derive from a real address.
- Desktop: streamed replies lost their copy button. The page rebuilds a reply bubble on every streamed chunk, and the rebuild for replies with tool steps (and for group and synthesis messages) never put the button back. Every rebuild now re-adds it. Test test/ui-copy.test.js.

### Added
- **No personal details in the code.** Team membership (medical/legal folders, Files folder, keep-on-box) now
  comes from each agent's own folder grants instead of hard-coded agent names; the wallet agent (`walletAgents`),
  the owner's receiving address (`walletOwner`) and the "Create team" templates (`teamTemplates`) are settings,
  none by default. Comments, docs and test fixtures use neutral names; the trading-agent workspace template is no
  longer shipped; `.gitignore` ignores all of `data/` except the example; real names were removed from the AI
  dashboard page; the license notice keeps the copyright holder's name only.
- **Member agent permissions (grants).** Admins decide what member-owned agents may do beyond their own folders,
  in three layers, each overriding the one before: a hub default for every member agent (Settings → Member agents:
  permissions, `settings.memberPolicy`), a per-member grant (Users page → Agent permissions, `user.grants.policy`),
  and a per-agent override (agent settings page). Grantable: web search and fetch, reading and writing outside
  their folders, sending off the machine; each allow, ask (approval card) or deny. Changing the hub, destructive
  actions and money stay denied for member agents at every layer. A member grant can also name outside agents its
  agents may consult (for example `maestro` to request a new specialist). The agent settings page shows where each
  rule comes from. Grants are sanitised server-side and every change is in the audit log.
- **Subscription vs API credits, said everywhere (`lib/billing.js`).** Every model id says who pays: `claude-sdk/`
  and `codex-cli/` run on a subscription sign-in, `anthropic/`, `openai/`, `google/` and `perplexity/` on that
  provider's API key (credits), local providers free. `/api/models` carries the billing per model; the chat header
  picker and the create-agent list label each group, the agent settings page labels each family, and agents on an
  API key wear an "API $" badge in the agent list. The Claude Code client never receives the Anthropic API key, so
  adding a key for `anthropic/` models cannot move subscription agents onto the API bill.
- **Setup checklist (`lib/readiness.js`).** The hub checks its own machine and says what is missing and the exact
  step to fix it on that platform (macOS or Linux): admin account and two-factor, a way to run models and the Claude
  sign-in, Docker and the sandbox image when members or sandboxed agents exist (with a one-click build), the
  tools-default warning about a sign-in inside a member's box, PDF reading (poppler), JavaScript page rendering,
  the search chain, and how the hub is restarted (service manager or relauncher, last restart result). Shown on
  the Settings page, as a banner for admins while anything is critical, on the Users page before an invite, and in
  chat when a sandboxed agent's shell is withheld. Route `GET /api/readiness` (admin).

### Fixed
- **Members could change their own agents' permissions.** `PATCH /api/agents/:name` accepted every field from the
  agent's owner, including its policy, folders, sandbox, tools, owner and sharing. Members may now change only
  conversation settings (blurb, context and output limits, compaction); everything else answers 403 for an admin.
- **A shell command can no longer hold a turn open (`lib/client-watch.js`).** An agent's turn hung for 20 minutes
  after its reply: a grep with a pathological pattern kept running after the client's Bash tool timed out, the
  Claude client waits for its child shells before exiting, so the hub never saw the result and the owner's next
  message queued behind a finished turn. The hub now spawns the client itself (the SDK's `spawnClaudeCodeProcess`),
  knows its pid, and once the model has ended its turn without a result for 45 s, lists and kills whatever still
  runs under the client, says so in the chat, and lets the turn close; a cancelled turn kills the whole tree. The
  hub's own Bash tool runs commands in their own process group and kills the group on timeout, so a pipeline
  cannot outlive the call either.
- **Spend ledger prices (a tester's report).** The Claude rows were a generation old (Opus $15/$75, Sonnet
  $3/$15, Haiku $1/$5), overstating "API-equivalent" spend by 1.5 to 10 times. Now the published 2026-10 rates:
  Fable 5.1 $10/$50, Opus 5.5 $4/$20, Opus 5 and 4.5-4.8 $5/$25, Sonnet 5.5 $2/$10, Haiku 5.5 $0.10/$0.50, Haiku
  3.5 $0.80/$4; cache reads at 2.5% (Fable 5.1), 5% (Opus 5.5, Sonnet 5.5) or 10% of the input rate. Figures
  already in `data/ledger.db` were booked at the old rates.
- **Restart on unsupervised installs (for example a Mac started by hand).** The Restart button handed the job to a bash chain that could
  fail without a trace, and the page then saw the old server answering `/api/health` and reported success, so an
  updated hub kept running the old code for days. Now: `/api/health` carries a boot id; the page compares it before
  and after and treats "same process still answering" as a failure, showing `data/restart.log` and the server log
  (`GET /api/restart/log`). Installs with no supervisor restart through `scripts/relaunch.js`, a Node relauncher
  started with the hub's own node binary, environment and arguments: it waits for the old process to exit (the hub
  signals itself), waits for the port, starts the new server and checks health, logging every step. macOS launchd
  jobs restart with `launchctl kickstart -k`; systemd installs keep the exit-75 path. (`lib/restart.js`,
  `scripts/relaunch.js`; tests `test/restart.test.js`, `test/relaunch.test.js`.)

### Added
- **No-accounts banner.** A hub updated from before multi-user has keys but no admin account, so the setup wizard
  never asked for one and the hub runs with no login and multi-user features off. `/api/me` now reports
  `accounts`, and the page shows a banner linking to `/setup` until an admin account exists. The account chip
  hides cleanly in that state instead of throwing.
- **Model picker in the chat header (desktop).** The model shown at the top right of a solo chat is now a select:
  the operator changes the agent's model from inside the session, grouped by provider from `/api/models`, through
  the same route as the settings page. Claude to Claude keeps the client session; another provider continues from
  the conversation history. A change while the agent is busy is noted and applied after the turn. (app.js
  `fillModelPick` / `changeChatModel`; test `test/ui-model-pick.test.js`.)
- **One set of hands for every model path (`lib/hub-tools.js`).** Bash, Read, Write, Edit, Glob and Grep are now one
  implementation with Claude Code's names and parameters, shared by the gateway loop (every OpenAI, Gemini,
  Anthropic-key, Perplexity and local agent), the Claude Code client and the Codex client. Read returns cat -n style
  lines, reads images and PDFs (text, and page images for scanned pages or a `pages` range) and notebooks; Edit
  requires a Read in the same turn, an exact unique match (or `replace_all`), refuses a file that changed on disk and
  shows the edited region; Write refuses to overwrite an unread file; Grep has ripgrep's modes, context, type and
  glob filters and paging, with a pure-Node fallback when rg is missing; Glob sorts by modification time; Bash caps
  output and can run detached as a hub job. Images from Read reach the model on every path (MCP image content for
  the clients; a follow-up message for gateway models with vision). A sandboxed agent's hands act inside its
  container (Bash through `docker exec`, file tools confined to its mounts). Per agent **Tools** = hub default |
  client | hub on the settings page (`agent.tools`), hub-wide default `settings.toolsDefault` (client) in the
  Settings page's sandbox box; gateway and local models always use hub tools. With `hub`, the Claude client runs
  on the host with its built-ins disallowed and the hub's versions served as the MCP server `hub`
  (`mcp__hub__Read` and so on), so a sandboxed agent never carries a sign-in into its box; Codex gets the same tools
  through its bridge with its own shell confined to read-only. Tests `test/hub-tools.test.js`,
  `test/tools-parity.test.js` (the three paths carry the same eight tools with identical schemas).
- **Web search and fetch, hub-native and the same for every model.** `WebSearch` walks a chain of backends in the
  owner's order and returns the first that answers, in one result shape (rank, title, URL, date, snippet, backend):
  Brave, Perplexity (the provider key), Serper, Tavily, a self-hosted SearXNG, and DuckDuckGo's lite page as the
  zero-key floor; an agent may name a backend (`backend: perplexity`) or ask for fresh results (`freshness`).
  `WebFetch` returns pages as markdown with links, headings, lists, tables and code kept, reads PDFs through
  pdftotext, pretty-prints JSON, pages long documents with `offset`, renders JavaScript-only pages in a real browser
  (Playwright Firefox through `lib/web-render.py`) when the plain fetch comes back empty or on `render: true`, and
  refuses private, loopback, link-local and Tailscale addresses (after resolving the name, and after redirects)
  unless `settings.webFetch.allowPrivate` lets the agent's kind through (default: admin-side agents only); an
  optional Jina Reader fallback is off by default. Ten-minute cache. The hub can run SearXNG as a Docker container
  (`hub-searxng`, loopback only, JSON output on) from the Settings page. Settings box **Web search and fetch**
  (order, keys, SearXNG, fetch guards, try-it rows); routes `/api/websearch/*`. (`lib/web-search.js`,
  `lib/web-fetch.js`, `lib/web-render.py`; tests `test/web-search.test.js`, `test/web-fetch.test.js`,
  `test/ui-websearch.test.js`.)
- **Agent sandboxes.** An agent's shell and file tools can run in a container of its own (`sandbox/Dockerfile`,
  image `agent-hub-sandbox`), holding only that agent's folders mounted at their host paths: no hub data, no keys,
  no other agents; read-only root, no capabilities, pid and memory limits; no network for gateway-path agents.
  Claude-client agents run the client itself inside the box through a per-agent wrapper with a minimal
  environment; hub tools (memory, Records, consultations, the policy gate) stay in the hub process, so memory and
  the shared pool are unaffected. Per agent `sandbox: inherit | off | container`; `settings.sandboxDefaults`
  (members: container, admins: off). Without Docker or the image, a sandboxed agent gets no shell rather than
  running on the host. Routes `/api/sandbox/status`, `/api/sandbox/build` (a job), `/api/sandbox/agents/:name/reset|stop`;
  Settings box and a per-agent selector. `lib/sandbox.js`.
- **Data connectors.** Outside services (a patient portal such as MyChart, a bank, any MCP server, or
  one of the built-in skills) plug into the hub as data, not code: `data/connectors.json`, managed from
  the Settings page ("Data connectors"). Each connector has access grants (every agent, or a named list;
  only on the agent's own turns, never through a consultation), password protection per service or per
  service group (one "medical" passphrase unlocks every medical connector; unlocks expire after an idle
  timeout, `connectorsUnlockMinutes`, default 240, and on restart), a data home folder, and a policy
  class per tool (read, write, send; a *sensitive* connector classifies its reads as `admin`, so workers
  and members never read patient data silently). Secrets are AES-256-GCM encrypted under an scrypt key
  from the passphrase (or a purpose-derived hub key for always-on connectors); lowering protection needs
  the current passphrase and is logged. An MCP connector runs with a minimal environment plus its own
  secrets only, its stderr and errors redacted. A wrapped skill leaves the ungated skill path. Tools are
  named `<connector>__<tool>` on both dispatch paths; the agent's context lists its connectors and lock
  state. Routes under `/api/connectors` and `/api/connector-groups` (admin). `lib/connectors.js`.
- **Catch up on a running turn, and see workers on the phone.** A page that opens or wakes while an
  agent is mid-turn used to show a dead "still working on the server…" bubble until the final reply,
  because only reply text was broadcast and a fresh page got no replay; and the mobile page ignored
  worker events altogether. Now the hub keeps the running turn's tool calls and workers per agent and
  serves them at `GET /api/agents/:name/turn` (message, text so far, activity, workers, or the turn
  that just ended), and publishes compact `turn_activity` and throttled `turn_worker_delta` events on
  `/api/events`. Both pages fetch the turn so far on load, wake, focus and event-stream reconnect, then
  follow live. Mobile gains an activity feed inside the in-progress bubble: tool rows and worker rows
  with spinner, tick or cross, tap to expand a worker's text and tool lines, collapsed to a one-line
  summary after the turn, and a live status line ("running Bash: npm test · 2m 10s"). Desktop feeds the
  same data through its existing worker cards and tool activity. Service worker `hub-mobile-v19`.
- **Wake recovery and a re-sync button.** After a laptop lid close or a phone app switch the event
  connection often looked open to the browser while being dead on the wire, so nothing arrived until
  the tab was closed and reopened. The hub's heartbeat is now a real `ping` event every 15 s; both
  pages treat 45 s of silence as a dead connection and reconnect, detect a sleep (a 5 s timer landing
  20 s late) and re-sync, and reconnect on wake only when the stream is actually stale. A deliberate
  reconnect asks the hub to replay from the last event seen (`/api/events?since=<seq>`), so no event
  falls in the gap. A ↻ re-sync button sits in every desktop chat's action bar and in the mobile chat
  header: new stream, fresh agents and status, re-attach and catch-up, with a toast saying what it did.
  Service worker `hub-mobile-v20`.
- **An optional decider behind Auto model, off by default.** `settings.autoClassifier.backend` picks who
  classifies a prompt into simple / code / math / vision / reasoning / hardest: `builtin` (today's chain,
  the default and unchanged), `local` (any OpenAI-compatible local server: NInfer, LM Studio, Ollama; the
  model thinks briefly, about half a second, or answers in ~150 ms with thinking off), `perplexity`
  (Perplexity's Decisions API, pplx-decider-v1.1-27b, ~250 ms, calibrated confidence, two cents per
  million tokens), or `local+perplexity` (local first, hosted when the local server is down). Guards: a
  confidence floor (default 0.6) keeps the agent's own model; a per-agent `minModel` never routes below
  that family; `keepOnBox` agents (medical and legal teams by default) never use a hosted classifier;
  `shadow: true` logs every verdict next to the keyword rule and changes nothing. Unreachable or
  unconfigured backends fall through to the builtin chain; a turn never fails because of the
  classifier. Settings page: a classifier box with a try-it field that shows every backend's verdict side
  by side (`GET/POST /api/auto-model/classifier`, `POST /api/auto-model/classify`). The routing tables
  moved to the current models (Sonnet 5.5, Opus 5.5, Fable 5.1) and are owner-editable in settings.
- **Subscription usage windows and automatic fallback at the weekly limit.** The hub now reads the
  Claude plan's usage windows (5-hour, 7-day, per-model weekly such as Fable) through the Claude client
  every ten minutes and from the rate-limit events the client streams during turns
  (`GET /api/plan-usage`, `POST /api/plan-usage/refresh`). When a model family is at the owner's
  threshold (default 90%) or the plan has refused it, agents on that family run their turns on the
  substitute: Fable → Opus 5.5, Opus → Sonnet 5.5, Sonnet → Haiku 5.5 by default
  (`settings.planFallback` `{ enabled, at, map }`; per agent `fallbackModel`, "none" to opt out). Per
  turn only: the configured model stays and the first turn after the reset is back on it. The chat shows
  a one-line notice on a fallback turn; both pages toast the first fallback and any refusal.
- **Open windows follow a model change.** Changing an agent's model, name or icon on its settings page
  now reaches every open page through a hub event: the sidebar and the agent's open chat relabel at once
  when idle, or at the end of the running turn (the header shows "→ model after this turn" meanwhile).
  The server already picked the model up on the next turn; the pages just didn't know.
- **Pictures, charts and diagrams in the chat.** Fenced blocks of type `svg`, `mermaid`, `chart`
  (a Chart.js config as JSON) and `html` are drawn instead of printed, on desktop and mobile: SVG is
  sanitized (DOMPurify plus a second pass), mermaid runs in strict mode with the dark theme, charts get
  the hub palette and start at zero, and html runs in a sealed frame (`sandbox="allow-scripts"`, a
  CSP that forbids any network) with expand and source toggles. A parse error shows the source and a
  one-line note. Libraries are vendored (DOMPurify 3.4.16, mermaid 12.1.0, Chart.js 4.5.1) and loaded
  on first use. Every agent's instructions now carry a hub-generic guide on showing an image file,
  drawing charts and diagrams, screenshots, PDF pages and video frames, with the dark palette.
- **`generate_image` tool.** A picture from a description, or an edit of a reference image, made by
  Google's Gemini image models (default) or OpenAI's GPT image models (`provider: "openai"`), fast or
  best tier, saved in the agent's Files folder and returned as the markdown line that shows it inline.
  Models are the owner's choice in `settings.imageModels`. Claude models have no image output; this is
  how an agent gets one. Service worker `hub-mobile-v21`.
- **Authorize an external Hyperliquid agent wallet from the Wallet panel.** A bot that keeps its own
  key outside the keystore can be approved by address and name (`POST /api/wallet/hl/approve-agent`,
  owner passphrase required, keystore unlocked). The approval is signed by the main wallet's key, the
  hub's own agent is untouched, the result is checked against the exchange's `extraAgents` listing,
  recorded and audited. The panel lists the agents the exchange reports on the account.
- **Key files are secrets by name.** `agent-key`, `private.key`, `*.pem`, `*.secret`, `id_ed25519` and
  the like are admin-class reads for every agent, wherever they sit, so one agent's bot key is not
  readable by another.
- **License.** The project is released under the PolyForm Noncommercial License 1.0.0 (`LICENSE`,
  `NOTICE`, `package.json`): free for noncommercial use, commercial licenses from the copyright holder.
  The README used to claim MIT with no license file. Bundled third-party libraries keep their own licenses.

### Fixed
- **Restart button never restarted a systemd install** (reported by a tester, with the cause). The
  button spawned `safe-restart.sh` with its output discarded; the script appended to `server.log`, which a
  unit's `StandardOutput=append:` creates as root, so the redirect failed and the script died before
  `restart.sh` ran. Now one path for every install (`lib/restart.js`): under systemd the server signals
  itself (SIGUSR2), shuts down cleanly and exits with code 75, which `Restart=always` and
  `Restart=on-failure` both restart, so no second server ever races for the port; elsewhere
  `safe-restart.sh` runs detached with its output in `data/restart.log` (or the temp dir) and reports a
  failed restart instead of hiding it. `scripts/restart.sh` gained a systemd branch (asks systemd to restart
  the unit, user or system scope; signals the server when systemctl is not permitted). The RestartHub
  tool uses the same path. README documents the unit settings.
- **1M context for the models that have it by default.** The hub's window table treated every Claude
  id without `[1m]` as 200K, so an agent on plain `claude-fable-5-1` was told it had 200K and compacted
  early. Fable 5.x, Mythos, Opus 4.7 and later, Sonnet 5 and later, Haiku 5.5 and the picker aliases for
  them now read as 1M; the suffix still marks the 1M variant of Opus 4.6 / Sonnet 4.6. The Claude client's
  picker no longer lists `[1m]` aliases, so agents configured on `claude-fable-5-1[1m]` keep running but
  the id is absent from the chooser; the agent editor now always keeps the configured model selectable,
  labelled "(current; not in the hub's list)", so a Save cannot switch an agent off its model.
- **Only a few Claude models in the agent editor after an in-app update.** The updater deleted the
  discovered-models cache, so until the next discovery finished the hub had no list; a page opened in
  that window got a short list built from quick probes and cached it for five minutes, and a second
  caller during a discovery run was handed the old cache. Now the updater keeps the list and marks it
  stale, a caller during a run joins that run, a probed-only list is never cached, `/api/models`
  reports `discovering` / `stale`, and the agent editor says "model list is rebuilding" and refetches
  until it is final. (Reported by testers; a related fix fb6846d makes a newly saved
  provider key's models show at once.)
- **Spend ledger booked the session total on every turn.** The Claude client reports a running total
  for the whole (resumed) session; the ledger recorded it per turn, so a day of work showed $17K.
  Now each turn books the increase since the previous result of that session, or a prompt-cache-aware
  estimate of its own usage (cache reads at 10%, writes at 125% of the input rate). Existing rows
  were recomputed. `o3-mini` / `o3-pro` get their own prices.
- **Pages re-attach to a running turn** when they load or wake (laptop lid, blank screen, phone lock,
  message sent from another device): the chat shows "working on the server" and paints the reply on
  turn end instead of sitting on Idle with nothing.
- Twenty-five bugs surfaced by the new behavioural unit tests, among them: a corrupt `agents.json`
  was silently replaced by the defaults (now preserved, with a `.bak` and atomic writes); the event
  stream's sequence id was overwritten by approval ids so those events never replayed; the
  OpenAI-compatible endpoint hung on a bad body (now 400/500); the image route served any image
  path on disk (now only hub folders) and accepted any upload type (now png/jpeg/gif/webp, 20 MB);
  "approve for 1 hour" hashed calls ignoring nested arguments; `gpt-5-chat` lost its output cap;
  invite acceptance returned the raw user record; a good sign-in did not reset the failure counter;
  cloning an agent dropped its owner and category; settings crashed on a null provider; memory
  context could exceed its byte cap; shared-memory search treated `%`/`_` as wildcards; the Edit
  tool expanded `$&` in replacements; "tues"/"thurs" one-offs parsed as recurring; `every 0 minutes`
  was accepted; a paused task could still fire; Linux default-route detection used the macOS command;
  git sync hid the "branch not on remote" message; task-queue list order and date validation.

### Changed
- **Approval cards are off by default.** An action an agent's policy marks "ask" (sending, destructive,
  admin, writing outside its folders) now just runs unless the owner turns on *Ask before risky actions*
  in Settings. Denies (member sandbox, wallet rules) apply either way. When on, "approve this kind for
  1 hour" covers the whole class for that agent (destination still matters for sending and money),
  and words inside quoted strings (a grep pattern, a commit message) no longer count as commands.

### Added
- **Elastic context for gateway and local models.** The hub now learns each model's real context
  window (the agent's `contextWindow` setting, else LM Studio's loaded context length, else a table)
  and fills it by priority: the agent's own files and Records first, then the most recent turns
  verbatim, then recall hits, with room reserved for the reply. As Records grow the recent window
  shrinks; nothing older than the agent's last compression is replayed, because the working brief
  covers it. A small local model never drowns and never gets a silently truncated prompt. Each turn
  logs its budget. Plus an **assisted** compression mode, default for local models at 60%: the hub
  feeds the recent transcript in slices sized to the window, the agent extracts facts and decisions
  into its Records from each slice, then writes its brief on a fixed template, then starts fresh.
  The agent writes every word; the hub only paces the work.
- **Agent-authored context compression.** No provider summarises an agent's session any more. Each
  agent has a compaction mode (`off` / `dry` / `on`, default `dry`) and a threshold (default 75% of
  its context window). At the threshold, or when the agent asks (`compress_context`) or the owner
  presses *Compress now*, the hub runs the agent's own compression turn: the agent updates its Records
  with every fact not yet there and writes a working brief (a Record) of what to carry forward
  verbatim. In `dry` mode nothing else happens: the owner reads the brief and decides. In `on` mode
  the hub then opens a fresh provider session seeded with the Records, the most recent turns verbatim
  from the transcript archive, and recall for everything older. The provider's own compaction is
  pushed to the top of the window as a last-resort guard. Settings per agent on its settings page;
  progress on the event stream. Nothing is lost at any step: the archive keeps every turn.
- **Transcript archive and Recall.** The hub now keeps every turn of every agent in full, in its own
  database (`data/transcript.db`): the message, the reply, each tool call and each tool result, on every
  path (Claude, OpenAI, Gemini, local, Codex). Nothing is trimmed or summarised by a provider. A
  full-text index makes it searchable in milliseconds. Agents get `recall` (search their own archive)
  and `recall_context` (the exchange around a hit); the hub also attaches the best hits for each new
  message to the agent's context, labelled as search hits. People get a 🔎 Recall panel on every chat
  (desktop) and a Recall sheet on the phone. Existing history was backfilled from the hub's chat logs
  and the Claude client's session files. An agent's working memory now belongs to the hub, not the
  model vendor: switch the model and the history comes along.
- **Records.** Per-agent documents the hub loads in full into the agent's context on every turn, never
  searched for relevance, never trimmed (`workspaces/<agent>/records/*.md`, symlinks allowed, size cap
  per agent). They are the agent's source of truth: a patient summary, a matter file, a job file, open
  positions. Agents keep them with `record_write` / `record_list`; owners edit them on the agent's
  settings page. The hub adds an index of the agent's Files folder so nothing uploaded goes unnoticed.
  The standing rule in every agent's context: Records are the facts, Recall covers the rest, say
  plainly when something is in neither.
- **Files: upload, download, browse.** A 📁 Files button (desktop header, mobile ⋮ menu) opens the
  files folder of the agent whose chat is open: GP and the medical team keep `~/agent-hub/medical`
  (inbox/, patients/), Counsel and the legal team `~/agent-hub/legal`, every other admin-side agent
  gets `~/agent-hub/share/<agent>` (on the Samba share), and a member's agents share `users/<id>/files`.
  Each agent's startup context names its folder. With no chat open the panel shows the owner's general
  folder. Upload (multiple, drag and drop, progress), download, new
  folder, rename, delete, and "Use in chat", which drops the server path into the composer. The
  paperclip accepts any file: images stay inline, anything else is uploaded and referenced by path.
  Members only ever reach their own folder; admins open any owner's through the owner switcher.
  Paths cannot leave the root (dot-dot, symlinks), uploads land whole or not at all, per-file limit
  `filesMaxUploadMb` (default 512). Routes: `/api/files`, `/api/files/upload`, `/download`, `/mkdir`,
  `/rename`.
- **Every member starts with an assistant.** Accepting an invite (or being created by an admin) gives a
  member one personal agent, owned by them, which introduces itself on first contact and asks what to be
  called (`rename_me`). It can spin up the hub's temporary workers on any provider inside the same
  sandbox; the Claude client's own sub-agent tool is off for member-owned agents.
- **Agent requests.** Members cannot create agents, so their agents have `request_agent`: a request for
  one specialist or a whole medical/legal team lands on the admin's Users page, the event stream and
  push; approving creates it for that member automatically, declining sends a note into the requesting
  chat. Routes: `/api/agent-requests`.
- **Multiple users.** The hub has accounts: a login page (first visit creates the admin), passwords
  (scrypt), sessions in secure cookies, TOTP two-factor with recovery codes and "trust this browser
  for 30 days" (required for admins), invite links, login rate limiting and an audit log. Roles:
  **admin** sees every agent and all settings; **member** sees only the agents they own or that an
  admin shared with them, and no admin controls. Every agent has an **owner** (a user, or none =
  infrastructure) and a **shared with** list. Enforcement is server-side on every route and on the
  event stream; consults, agent rosters and shared memory are scoped to the owner's pool. A member's
  agents run under a tight policy (nothing leaves the box, writes only in the owner's folder under
  `users/<id>/`). Admins get an owner switcher at the top of the agent list (Mine / Infrastructure /
  each member), a Users page (`/users`: invite, create, roles, disable, reset password or 2FA, delete,
  audit, **create a whole medical or legal team for a member from a template**), owner and sharing
  fields on each agent's settings page, and an account menu (Security: enrol or disable 2FA, change
  password, sign out everywhere). Mobile has the same switcher, security sheet and sign-out.
  Routes: `/api/auth/*`, `/api/me`, `/api/users*`, `/api/agents?owner=`. The hub's own internal
  calls use a per-process service token; the old `HUB_AUTH_USERNAME` basic auth still works as an
  admin for older integrations.
- **Cleaner desktop header.** The top bar keeps the chat tabs, Scheduler, Settings and a "⋯"
  menu. Messaging, Wallets, Dream, Update from GitHub and Restart live in the menu; an "Advanced
  controls" checkbox (off by default, remembered per browser) reveals the six tuning controls with
  plain labels (Reply length limit, Message history sent, Pre-scan, Lazy tools, SDK workers, Terse).
- **Per-agent tool policy and action-level approvals.** Every tool call on every path (Claude SDK
  `PreToolUse` hook, gateway tool loop, Codex MCP bridge, and Codex shell/file-change approval
  requests with `approvalPolicy: untrusted`) is classified into an action class (read, write inside
  own folders, delegate, write outside, send off the machine, admin, destroy, money) and decided per
  agent: allow / ask / deny. Defaults by role: workers and specialists deny everything outside their
  roots and nothing leaves the box; team heads ask before sending or writing outside; the lead agent
  asks for destructive actions too; wallet agents keep the wallet firewall. `ask` pauses the exact
  call on an approval card (desktop, mobile, web push) for 10 minutes, then denies; "approve this
  kind for 1 hour" remembers (agent, class, destination). Overrides and extra roots per agent in
  Settings (`policy` in agents.json). The old all-or-nothing confirm-tools prompt with its 2-minute
  auto-approve is gone. Routes: `/api/approvals`, `/api/policy/<agent>`.
- **Spend ledger.** `data/ledger.db` records every turn (agent, origin, model, tokens, API-equivalent
  cost, duration). Daily caps per agent and hub-wide are configurable and OFF by default; over a cap
  an agent's decided actions become `ask` for the rest of the day. Routes: `/api/ledger/today`,
  `/api/ledger/days`, `/api/ledger/caps`.
- **Provider pacing: parallel until it is not.** `lib/provider-pacing.js` paces every fan-out path
  (consult_agent, spawn_workers, stand-ins) per provider: a concurrency cap (Claude 6, OpenAI 4,
  Gemini 4, Codex 2, LM Studio 1), and on a transient failure (rate limit, overload, network
  timeout) the provider drops to one-at-a-time for a cooling-off period (2 min or the provider's
  retry-after), the call is retried twice with backoff (10 s, 30 s), and the limit ramps back
  1 → 2 → 4 → cap as calls succeed. Every agent path now reports a typed `turn_error` (SDK result
  error flag honoured, SDK crash, gateway failure, Codex stop/crash) instead of handing "API Error:
  429" to a coordinator as a specialist's answer; the coordinator gets `[TRANSIENT FAILURE]` /
  `[FAILED]` text that says what happened and what to do. State: `GET /api/hub/status` (`pacing`),
  `status_snapshot` (`pacing.paced`), events `provider_paced` / `provider_ramp` /
  `provider_recovered` / `provider_retry`, a web-push notice when a provider is paced, amber
  banners on desktop and mobile with "Resume full speed" (`POST /api/hub/pacing/reset`), and a
  test hook `POST /api/hub/pacing/fault {provider, count}` that fails the next N delegations
  synthetically so the fallback can be proven on the live hub.
- **Desktop interject whenever the agent is busy.** A send to an agent the hub reports as working
  (a turn from the phone, a schedule, a consult or another tab) is delivered into that turn as an
  interjection instead of bouncing as "busy"; a 409 from the hub is turned into an interjection
  once; if the turn has already ended the text goes as a normal message. Messages with images
  still go the normal way.
- **Provider down = fail fast.** A refused or unreachable connection (LM Studio off, wrong port)
  is classified `down`: the provider is paced at once, nothing is retried (neither the gateway's
  three network retries nor pacing's 10 s / 30 s), and the coordinator gets `[PROVIDER DOWN]`.
- **Mobile interject.** While the open chat's agent is working, the phone's send button becomes
  Interject and posts into the running turn (same `/api/chat/interject` as the desktop); Stop
  moves to the header for every busy state.

### Changed
- **Reads are policed too.** Two new action classes: `read_outside` (reading files outside the
  agent's own folders, or the admin's external accounts through skill tools) and `web` (WebFetch,
  WebSearch). Admin-side agents keep both allowed; member-owned agents are denied both by default
  (grants widen this). Secrets and other agents' private state (`.env`, `data/users.json`,
  `data/auth.db`, `data/memory.db`, `data/conversations`, `~/.claude`, `~/.codex`, `~/.ssh`,
  `~/.config/gog`, wallet keystores) are `admin` even to read: denied for everyone but the lead,
  who is asked.

### Fixed
- **A refused or unanswered approval no longer ends the agent's turn.** The Claude harness read a
  permission "deny" as "the user said stop" and killed long-running turns when a card was denied or
  timed out; refusals now block just that one tool call and the agent carries on with the reason.
- **Approval window is configurable** (`approvalTimeoutMinutes` in settings, default 60 minutes,
  was a fixed 10) so a card can wait for the owner without the job dying.
- **Tool policy false positives.** The shell classifier counted every slash token and every `>` in
  a command as a write, so awk/sed/grep regex literals ("/class=/"), comparisons ("NR>s"), quoted
  text and heredoc bodies parked read-only commands on approval cards. Only the arguments of write
  verbs and real (unquoted) redirection targets count now; heredoc bodies are data.
- **First gateway turn after a restart answered against a bogus placeholder.** The prompt was
  written to the conversation log before the gateway loop first loaded that log into memory, so the
  loader took the fresh prompt for a reply a restart had killed, appended "[Response was delivered
  but interrupted by a server restart. Do not re-answer this prompt.]" and the model saw the prompt
  twice with that instruction between (Gemini obeyed it and replied with nothing). The conversation
  is now primed in memory before the prompt is logged. Claude SDK and Codex agents were not affected.

### Added
- **Restart from the phone.** The mobile ⋮ menu has "Restart hub": a confirm sheet names any
  agents still mid-turn, then it posts the same `/api/restart` the desktop button uses, waits
  on `/api/health` and reloads when the hub is back.
- **Copy buttons.** Every message bubble on the desktop and mobile pages has a ⧉ button that
  copies the message's original text/markdown; the mobile ⋮ menu has "Copy whole chat".
- **Kill switch.** `POST /api/hub/halt` aborts every running turn and worker, cancels detached
  jobs, and sets a flag (`data/hub-halt.json`, survives restarts) that refuses new turns (503,
  unless the body says `override: true` so the owner can still reach maestro), pauses both
  schedulers and consultations, and announces `hub_halted` on `/api/events` and by push.
  `POST /api/hub/resume` clears it; `GET /api/hub/status` reports it. Desktop: "⛔ Halt all
  agents" in Settings and a red banner with Resume while halted.
- **Images in consultations.** `consult_agent` and `spawn_workers` take an optional `images`
  array (absolute file paths or data URLs, max 8 × 10 MB, type-checked) that reaches the
  consulted agent's model as real image input on the SDK, gateway and Codex paths, so a
  coordinator can hand a photo to a specialist.
- **Stop a running turn from any device.** The mobile chat header shows a red ■ Stop while
  the agent is busy, whether the turn was started on that phone, on the desktop, by the
  scheduler or by another agent; the desktop chat's Cancel button now appears from the
  live status as well. Both call `POST /api/chat/stop`.
- **Turns survive the browser going away.** Closing the laptop, switching apps on the phone,
  or losing the network no longer aborts the agent's turn: the hub marks it detached, keeps
  working, logs the reply, and announces `turn_end`. Stop is explicit now
  (`POST /api/chat/stop {agent}`); a tool confirmation on a detached turn is denied after
  10 minutes, an `ask_user` question times out as before. The desktop and mobile pages
  never resend a message on a dropped connection: they show "still working on the
  server", follow the live progress, and pull the finished reply from history when the
  network or the tab comes back.
- **Live agent status.** `/api/agents` reports `busy`, `busySince`, `activity`
  ("replying to you", "consulted by doc", "scheduled task: …") and `pendingQuestion`;
  `/api/agents/status` is a cheap poll; `/api/events` now publishes every turn (the
  owner's own included), plus `ask_user`/`ask_user_done` and a `status_snapshot` on
  connect. Both UIs show a pulsing amber dot with the activity and elapsed time on busy
  agents, a blue "?" on an agent waiting for a human answer, a "N agents working" chip
  that filters to them, and a warning before sending to a busy agent (a 409 keeps the text
  in the box instead of resending).
- **Push notifications** (`lib/push.js`, `web-push`). The installed mobile app (and the
  desktop, via a Settings toggle) can subscribe; the hub sends a notification when an
  agent replies, asks a question, or a scheduled task or job finishes. Payloads carry only
  a title, "Tap to open" and the chat URL, never message content. VAPID keys and
  subscriptions live in `data/push/` (0600); dead subscriptions are pruned; one push per
  agent per 20 s; no banner while the app is open and focused.
- **Phone-first mobile view (`/mobile`).** A separate, small, chat-first page for phones:
  agents grouped with busy dots and unread badges, one chat at a time with streaming
  replies, tool lines, agent questions as tappable buttons, photo and camera attachments,
  and an Activity tab (hub-initiated turns, scheduled tasks, jobs). Installable as a PWA
  (`manifest.json`, `sw.js`; the service worker never touches `/api/*`). It reuses the
  existing APIs; the only server change is the route. The desktop page shows a dismissable
  "try the mobile view" banner on screens under 700px. Also reachable at `/mobile.html`.
- **`ask_user` tool: live interviews.** An agent can ask the person one question and wait
  for the answer inside the current turn: the question appears instantly with choices and
  a text box (desktop modal, mobile inline), the answer goes back as the tool result, so a
  sequence of adaptive questions runs with seconds between them instead of a full turn
  each. "Skip" is offered by default; no answer within 10 minutes (or Stop) returns
  `NO_ANSWER`; unavailable to consulted agents and to turns with no live user. Questions
  and answers are written to the transcript (❓ / ↳).
- **Lead agents are a per-agent flag.** `lead: true` (checkbox in agent settings, 👑 badge
  in the sidebar and mobile list, lead-first sorting) grants the hub-wide powers: schedule
  tasks for other agents, see/edit/cancel their tasks, default comms route. One or several
  agents may carry it. Category is grouping only again: ⭐ Primary Agents are the ones the
  owner talks to. Fallback when nothing is flagged: the primaries, else `maestro`
  (a contributor's PR #3 made the lead "category primary"; the flag builds on it).
- **Agent blurbs.** Each agent has a one-line `blurb` (≤120 chars) shown as a hover
  tooltip on the desktop sidebar and as the subtitle on mobile, editable on the agent
  settings page and via `PATCH /api/agents/:name`.
- **Task scheduler.** `schedule_task`, `list_scheduled_tasks` and `cancel_scheduled_task`
  for every agent (one-off or recurring, times in US Eastern), a 📅 panel for the owner,
  and `/api/scheduled-tasks`. Agents schedule for themselves; lead agents and the owner
  for anyone. Scheduled turns stay visible in the agent's chat after a reload, labelled
  as a scheduled task and never as the owner speaking. Background jobs (`run_job`) moved
  into the same 📅 panel; the ⚙ button is gone.
- **Tailnet access (a contributor, PR #2).** `HUB_ALLOWED_HOSTS`, `HUB_TAILNET_USERS`
  (identity headers trusted only from a loopback peer), `HUB_AGENT_PERMISSION_MODE`,
  `HUB_WORKER_DEFAULT_SCOPE`, a `scripts/tailscale-setup.sh`, and a macOS fix for
  `jobs.js` (no `setsid` binary needed).
- **Codex CLI provider.** `codex-cli/<model>` runs OpenAI models on the owner's ChatGPT
  subscription through `codex exec`, with hub tools over a per-turn MCP bridge and live
  mid-turn interjections via the Codex app-server.
- **Telegram comms module (`lib/comms`).** Owner panel, allow-listed senders, per-agent
  routing, agent tools; the lead agent is the default route.
- **Consults: push delivery and stand-ins.** Queued consultation replies are pushed to the
  master as soon as the target is free; a busy `worker`-category agent is replaced by a
  temporary stand-in on the same model; `list_agents` reports busy state and queue depth.
- **Per-agent `contextBudget`.** SDK agents can run with a chosen working context (min
  125K, capped at the model's window); compaction at 80% of the effective window.
- **Hub event stream: windows follow turns the hub starts on its own.** A consultation, a
  job notice, a job report or a scheduled task runs with no browser behind it, so an open
  window for that agent stayed blank until it was reopened. `GET /api/events` now
  broadcasts every such turn (`turn_start`, throttled `turn_delta` text snapshots,
  `turn_end`, with the origin and job id) as Server-Sent Events with `Last-Event-ID`
  replay (`lib/hub-events.js`). The browser subscribes at load: a job or schedule turn
  for an agent with no window opens one automatically and streams the reply into it, a
  turn for an open window streams there and marks the tab unread, and a job report
  brings the master's window to the front because that window asked for the work.
  Consultations only show in windows that are already open. The stream is same-origin
  only.
- **One window per agent.** Opening an agent that already has a window switches to it
  instead of creating a duplicate, so two windows can never race on the same history.
  Worker sub-panels inside a coordinator's chat are unaffected.
- **Job pool: detached jobs that outlive an agent's turn (`run_job`).** The hub starts a
  fresh process for every reply and kills it, with every child, when the reply ends, so a
  command an agent started with `&`, `nohup` or the Bash tool's background flag died
  silently the moment the agent stopped talking (auditor's backtest, 2026-09-22), and
  even a correctly detached job could not wake its agent when it ended. Every agent now has
  `run_job`, `job_status`, `job_cancel` and `list_jobs`. The hub launches the command as a
  transient systemd user scope (falls back to `setsid`), keeps the log under
  `data/jobs/<id>/`, and when the job exits wakes the owner in a new, saved turn with the
  exit code and output tail. A job carries `report_to`, set automatically to the agent that
  consulted the owner: after the owner's wake-up turn ends, the hub forwards the owner's
  reply to that master as a new turn in the master's chat, so a worker's analysis reaches
  the agent that asked for it. Jobs survive hub restarts; jobs that ended while the hub was
  down are announced on start-up, jobs whose process vanished are reported as lost, and a
  wake-up turn cut by a restart still yields a notice to the master. Wake-ups wait while
  the target agent is busy and retry. Every agent's system prompt now says that its shell
  dies with the turn and how to use `run_job` instead. Owner view: the ⚙ button in the
  header shows the running count and opens a docked Job pool panel (owner, master, status,
  hand-off progress, log tail, cancel); `GET /api/jobs`, `POST /api/jobs/cancel`.
- **Tiger Team interject.** The war room's message box is now a real interjection: with
  the default "Team" target the coordinator receives it durably (before its next model
  call, surviving resume) and every participant working at that moment receives it live at
  its next tool boundary, so nobody keeps working on stale instructions while the
  coordinator waits on them. "Coordinator only" and a named participant are also
  accepted. Each pickup is acknowledged in the war room ("✓ alice picked it up 01:12")
  and journaled in the team record.
- **Hyperliquid owner routes accept the executor token.** `/api/wallet/hl/config` and
  `/api/wallet/hl/agent` now take the current executor token in `X-Executor-Token` as
  proof of ownership, exactly like the executor's own owner routes, so the trading agent
  can finish the Hyperliquid setup by API after the owner unlocks the keystore and hands
  it the token. Audit rows record which proof was used; failed agent-key setups are
  audited too.
- **Wallet recovery, import and backups.** The owner can now always get the keys back out:
  "Reveal key" on any wallet (passphrase required every time, audited, never a tool) shows
  its private key and, for generated wallets, its seed phrase; `scripts/wallet-recover.js`
  prints every wallet's secrets from the keystore file alone, with no hub running; and the
  encrypted keystore is copied to `~/agent-hub/backups/` (`HUB_WALLET_BACKUP_DIR`) after
  every change, with a "Back up now" button. New wallets are generated from a fresh 12-word
  seed phrase (account 0), stored encrypted next to the key, so they import into any wallet
  app. "Import a wallet" takes a private key, or a seed phrase from which one account is
  derived (index selectable); an imported phrase is used for the derivation and not stored,
  so the seed's other accounts stay out of reach of this machine.
- **Hyperliquid: HLP vault equity and spot balances in the read-only tools.** `hl_status` and
  `hl_balances` report vault equity (from `userVaultEquities`) with the HLP lock-up time;
  `hl_positions` includes spot balances.

### Fixed
- **Mobile: one running reply no longer locks every chat.** Streams and re-attach state are
  per agent: the send button shows Stop only in the chat of the agent this device is
  streaming, idle agents can be opened and messaged while others work, a stream whose chat
  is closed keeps running in the background and the reply is there when you return.
- **Gateway path sent webp/gif images as jpeg**; mime types are now mapped correctly.
- **Transcript after an `ask_user` question.** Progress saves carry the whole reply; after a
  question/answer pair the text is appended as a delta (entries tagged `base`) instead of
  repeating the part already logged.
- **SDK context window no longer ratchets down.** Each turn shrank the window by 0.8× to a
  100K floor (the hub passed its own auto-compact value back in as the limit), which left
  long-running agents thrashing in compaction.
- **New Session actually resets.** The button cleared the UI log but kept the stored SDK
  session and Codex thread, so the "new" session resumed the old one.
- **`TASKS.md` cron triggers written in ET fired four hours late.**
- **Wallet firewall:** deactivate-then-re-add supersedes an entry; a badly signed
  deactivation cannot be backdated to revive one; `locked` is reported only when the
  keystore is truly locked; the 👛 panel gained an address-book editor.
- **Hyperliquid deposit no longer leaves an allowance standing.** If the Relay bridge call
  fails after the USDC approval confirmed, the approval is revoked (`approve(depository, 0)`)
  on every failure path and the error says so; a failed revoke is reported with the exact
  fix. The bridge simulation is retried up to three times (3 s apart) when it fails right
  after the approval, which is the RPC lagging the approval by a block, so the manual
  retry the trading agent needed on its first real deposit is gone.
- **Hyperliquid caps could be raced.** The daily deposit/withdraw totals and the open-position
  count were read, then the network was awaited, then the ledger written, so two overlapping
  calls could both pass. Signing tools now run one at a time; the second call sees the first.
- The Relay currency id for Hyperliquid USDC (`0x00000000000000000000000000000000`) is now
  documented with its source (Relay's chain listing, "USDC (Perps)").

### Changed
- **Mobile app icon and name.** The installed app is "My Maestro AI" (was "Hub") with a
  hub-and-spokes icon; the manifest moved to `manifest.json`.
- **Mobile service worker: network first.** The page and script are fetched fresh whenever
  the hub is reachable (cache only as offline fallback), and the manifest and icons are
  never cached, so phones stop running stale code for an open or two after each update.
  Registered with `updateViaCache: 'none'`.
- **Cross-origin browser requests are refused.** The wildcard `Access-Control-Allow-Origin`
  is gone. `/api/*`, `/v1/*` and any non-GET request carrying a foreign `Origin` or
  `Sec-Fetch-Site: cross-site|same-site` gets 403; an `Origin` on an unknown `Host` is
  refused too (DNS rebinding). Loopback, `*.ts.net` and `HUB_ALLOWED_HOSTS` count as
  known (`lib/origin-guard.js`). Needed because `tailscale serve` publishes the hub with no
  login: any web page on a tailnet device could POST to `/api/chat`.
- **Memory context keeps the newest entries.** Long-term memory that exceeded the budget
  was truncated from the wrong end (agents saw only their oldest notes); the newest are
  kept now, shared memory is deduplicated per topic and author, and session notes load the
  two most recent days.
- **SDK runs the globally installed Claude client** instead of the embedded one;
  `@anthropic-ai/claude-agent-sdk` bumped for Opus 5.5.
- **Models list refreshes as soon as a provider key is saved.**
- **The 👛 wallet panel is a side panel now.** It docks to the right without dimming or
  blocking the chat, keeps its width and scroll position when it re-renders, has an
  always-visible Close button, Esc closes it and the left edge drags to resize. The
  Executor and Hyperliquid boxes show in full instead of scrolling inside 200px.
- **Unlock box first.** While the keystore is locked the Unlock box is the first thing in
  the wallet panel, Enter submits it, and the browser will not autofill it. The Executor
  and Hyperliquid boxes have passphrase fields of their own, and typing into one of those
  then clicking Unlock used to send an empty passphrase and report "Wrong passphrase."
  An empty passphrase now gets its own message, and failed unlocks are audited.

## [5.4.0] - 2026-09-22

A Hyperliquid account for the trading agent, a scoped executor for its bots, and an end to
false "Session ended" banners.

### Upgrade notes
- New dependency: `@msgpack/msgpack`. The Update button runs `npm install` for you.
- A restart is required. Both new features are inert until enabled in the 👛 panel.

### Added
- **Wallet executor** (`POST /api/wallet/execute`): a script can run a *registered* action
  within seconds, with no model in the loop, under caps the owner sets in the 👛 panel.
  Requested for liquidation protection: detection took ~1 s but the only signing path was a
  model turn (2–4 min). v1 registers one action, `deleverage`, which repays USDC debt on
  Aave v3 (Base) with aWETH collateral in one transaction through Aave's own
  ParaSwapRepayAdapter; it can only reduce debt, approves the exact amount and revokes it
  afterwards, validates the quoted router against Aave's Augustus registry, prices caps
  with Aave's on-chain oracle, and simulates the whole sequence before a dry run passes.
  Inert until the owner enables it: off by default, per-action dry-run on by default,
  caps $250 per execution / 4 per hour / 8 per day, honours the pause switch. Token auth
  (`X-Executor-Token`; only the hash is stored). Every call, accepted or refused, is in the
  wallet audit log as `executor:<action>`; a real execution is also reported to the trading
  agent at the start of its next turn, never by starting a model turn.

- **Hyperliquid account for the trading agent** (`hl_*` tools, `lib/wallet/hyperliquid.js`):
  perps (ETH, BTC, HYPE by default; owner allow-list), the HLP vault, spot HYPE, one-step
  deposits from Base through Relay (the contract paid is pinned and re-checked against
  Relay's own chain metadata), and withdrawals that can only go to the main wallet's own
  address on Arbitrum. Orders are signed by an agent key generated inside the keystore
  (`hl-agent-<env>`) that Hyperliquid itself prevents from withdrawing; the main key signs
  only agent approval, withdrawals and transfers. Isolated margin only; owner caps on
  deposit/order notional/leverage/open positions/withdrawals; per-tool enable and dry-run
  (default on); testnet by default. Signing is a port of the official SDK, tested against
  its byte-exact vectors. New dependency: `@msgpack/msgpack`. `arbitrum` added to the
  wallet networks (no swaps) so withdrawn funds are reachable.

### Fixed
- **False "Session ended — context window full" banners.** The hub treated every Claude
  Code process exit as a full context window, even at 0% or 30% usage, and told the owner
  the session had ended when the next message would have resumed it. Now only the API's
  own "prompt is too long" (or usage ≥ 85%) counts as a full window; any other exit shows
  a calm "process stopped, session intact" notice, and the SDK's error output is kept in
  the hub log so the real cause is visible.
- **Agents on plain model ids ran past the real context limit and died.** The SDK reports
  a 1M window for `claude-fable-5-1`, but the API enforces 200K for that id (only the
  `[1m]` alias gets 1M), so sessions grew to 250K+ and were refused. The hub now caps the
  window to what the id implies and passes it to the SDK as
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW` (80% of the window), so auto-compaction runs before
  the wall instead of the process crashing. Verified: an agent driven to 178K on a 100K
  test window compacted to 23K and carried on.

### Security notes
- Every agent shares the hub's OS user, so a local process that can read `data/` can read
  the executor token. The token keeps out accidents; the action registry, its invariants
  and the caps are the real bound. The worst a caller with the token can do is
  deleverage early.
- Changing executor settings or minting a token requires the keystore passphrase (or the
  current token) once a keystore exists, so a local process cannot enable the executor for
  itself. The caller-supplied `reason` reaches the trading agent only inside a delimited
  block marked as untrusted text. An approval that was broadcast is revoked on every exit
  path, and the quote is re-checked for staleness immediately before the swap is sent.

## [5.3.0] - 2026-09-21

On-chain trading wallets for one dedicated agent, on Base. Agents can now reach each other
when busy, and tool use is fixed for Gemini and the GPT-5.6 family.

### Upgrade notes
- New dependency: `viem`. The Update button runs `npm install` for you.
- The feature is inert until the owner opens the new 👛 **Wallet** panel, creates a
  keystore and a wallet, and funds it. **What a wallet holds is the most that can be
  lost**: there are no spend limits by design, so fund accordingly.
- The keystore locks on every restart. Unlock it in the Wallet panel; agents cannot.
- Create an agent named `trader` (its personality ships as a template), or list other
  agent names under `walletAgents` in `data/settings.json`.
- A restart is required.

### Added
- **Wallet tools**, given only to agents in `walletAgents` (default `["trader"]`):
  `wallet_status`, `wallet_balances`, `wallet_read_contract`, `wallet_quote_swap`,
  `wallet_swap`, `wallet_send_transaction` (any contract call or transfer).
  Networks: `base` and `base-sepolia` (testnet, no swaps).
- **Safety defaults, each overridable per call:** every transaction is simulated
  against live chain state and refused if it would revert; swaps default to 0.5%
  max slippage; `dryRun:true` does everything except sign and broadcast, which is the
  paper-trading mode.
- **Swaps** route through the KyberSwap aggregator. The router address is pinned, so
  a compromised API cannot redirect funds, and ERC-20 approvals are for the exact
  amount, never unlimited.
- **Encrypted keystore** (`data/wallet-keystore.json`, scrypt + AES-256-GCM, `0600`).
  Keys are generated fresh per wallet. There is deliberately no seed-phrase or key
  import: a seed phrase would expose every account derived from it and break the
  "loss is capped by the balance" guarantee. The key is never in `.env`, a log, a
  tool result or any agent's context.
- **Wallet panel** (👛 in the toolbar): create/unlock/lock the keystore, create
  wallets, pause all trading, download the audit log as CSV.
- **Audit log** of every request, approved or refused, with the requesting agent.
- **Leaked-key alert:** if ETH leaves a wallet and the hub sent nothing in the last
  ten minutes, an alert is raised in the panel, the log and `wallet_status`, with the
  instruction not to refill that wallet.
- `trader` workspace template with its trading rules.
- **`zora` network, for recovery only.** A wallet address is the same on every EVM
  chain, and the keystore has no key export by design, so ETH sent to a wallet on the
  wrong chain could not be moved. Transfers and contract calls work on Zora; swaps do not.
- **Consultations to a busy agent are queued instead of dropped.** The hub runs one turn
  per agent, so `consult_agent` to an agent that was mid-turn used to return "busy,
  nothing ran". A primary agent is mid-chat with its owner most of the time, so other
  agents could rarely reach it. Now the caller waits up to 20 seconds
  (`HUB_CONSULT_BUSY_WAIT_MS`); after that the request is saved to disk and the caller is
  told it was queued. The hub runs it when the target is free, and delivers the reply at
  the start of the caller's next turn, or at once if the caller asks the same thing again.
  Queued requests survive a restart. Failures, deleted agents and requests older than six
  hours are reported to the caller, never silently lost.

### Fixed
- **Gemini agents failed whenever they called several tools in one step.** Gemini streams
  parallel tool calls with no `index` field; the tool loop grouped calls by `index`, so
  they merged into one call with invalid arguments. The turn came back empty, or the next
  request failed with HTTP 400 "Request contains an invalid argument". Single tool calls
  worked, which made the failure look random. Affects Pro and Flash.
- **`gpt-5.6` models (`sol`, `luna`) could not use tools.** OpenAI rejects function tools
  for this family on `/v1/chat/completions`; they are now routed to `/v1/responses`.
  `gpt-5.5`, `gpt-5.4-mini` and `o3` were not affected.
- **Agents on a 1M-context model were told their window was 200K.** One asked its owner
  for a fresh chat at 13% usage. The same constant would have reported any error past
  170K tokens as "context window full". The hub now uses the window the SDK measures,
  then the `[1m]` suffix, then 200K, and tells agents not to announce a full session on a
  guess.

### Security notes
- Wallet tools are withheld from temporary workers, and from the trading agent itself
  on turns where another agent is consulting it, so no agent can trade by asking.
- A queued consultation always runs as its own consultation turn. It is never injected
  into the target's running turn: that channel carries the owner's authority, and an
  owner turn can hold wallet tools. Replies are labelled as coming from agents.
- All agents share the hub's OS user, so an agent with a shell could read the
  encrypted keystore file, though not decrypt it. The design accepts this because
  exposure is bounded by wallet balances. Keep balances small.

### Tests
- 300 offline tests across 34 suites. New suites: `wallet-keystore`, `wallet-service`,
  `tool-call-deltas`, `context-window`, `consult-queue`.

## [5.2.1] - 2026-09-21

Makes the Update button dependable for anyone with access to the repository.

### Upgrade notes
- **Install with `git clone`, not a tarball.** The Update button uses git; an install
  extracted from a bundle has no history and reports that it cannot update. To move
  an existing tarball install: stop the hub, rename the old folder, clone, copy
  `.env`, `data/` and `workspaces/` across, run `npm install --omit=dev`, start it.
- **Existing clones with an edited Maestro personality:** this release stops tracking
  `workspaces/maestro/*.md`. Before updating, copy `workspaces/` somewhere safe, run
  `git checkout -- workspaces`, update, then copy your folder back.

### Changed
- **Agent workspaces are no longer tracked in git.** They are user data. Editing
  Maestro's identity or `USER.md` used to make the install look modified, which
  blocked the Update button. Defaults now ship in `templates/workspaces/` and are
  copied into `workspaces/` on startup only where a file is missing; existing
  files are never overwritten.
- README Quick Start installs with `git clone`; new "Updating" section.

### Fixed
- The update code answered GitHub's credential request with the prompt text itself
  (`GIT_ASKPASS=echo`), so a login problem always surfaced as a misleading
  "Authentication failed". It now uses the credentials the clone was made with.
- "Not a git repository" and authentication failures now say what to do about it.

## [5.2.0] - 2026-09-21

A large release: durable Tiger Team recovery, the ability to talk to an agent
while it is working, vendor-neutral parallel workers, a safer network default,
and a hardened transport layer.

### Upgrade notes — read before updating

- **The hub now listens on `127.0.0.1` only.** Previous versions bound to every
  network interface. If you reach the hub from another machine, set
  `HUB_BIND_HOST=0.0.0.0` (or a specific address) **and** both
  `HUB_AUTH_USERNAME` and `HUB_AUTH_PASSWORD` in `.env`. Without both auth
  values the setting is ignored and the hub stays on localhost.
- **A restart is required.** The browser UI and the server changed together.
- **A Tiger Team now stops about 8 seconds after its browser tab disconnects.**
  Earlier versions kept running unattended. Stopped teams can be resumed from
  their checkpoint.
- **Agents are steered toward delegating inside the platform.** The new
  `SDK workers` selector defaults to `Fallback`. Set it to `Allow` to restore
  the old behaviour exactly.
- Installs created from a bundle tarball have no `.git` directory, so the
  Update button reports "Not a git repository". One-time fix, run inside the
  hub folder: `git init -b main && git remote add origin <repo-url> && git
  fetch origin && git reset origin/main`.

### Added

#### Temporal workers — parallel workers on any model (`spawn_workers`)
- Any agent can create temporary workers that run **in parallel**, and the
  **calling agent chooses the model for each one** from everything the install
  can reach: Claude, OpenAI, Gemini, Perplexity, Codex, and local models.
- A worker on a `claude-sdk/*` model runs with the full Claude Code harness;
  any other model runs through the hub's own tool loop. This covers everything
  the Claude SDK's built-in sub-agent tool does without tying delegation to
  one vendor.
- Workers are ephemeral: no `agents.json` entry, no conversation log, no saved
  session. They appear in the UI as worker tabs labelled with their model.
- Tool scope per worker: `read` (default), `full`, or `none`. Workers cannot
  spawn or consult further workers.
- Per-provider concurrency caps (hosted APIs run several at once, a local
  model server runs one at a time), a limit of 8 workers per call, and
  all-or-nothing validation: one invalid job rejects the whole batch.
- The tool's description carries a live shortlist — one model per tier per
  provider, preferring `-latest` aliases — and any exact model id is accepted.
  Omitting the model uses the caller's own.

#### Interjection — talk to an agent mid-turn
- Typing while an agent is working sends an **interjection** instead of being
  blocked. The agent takes it into account at its next step.
- Works for **Claude SDK agents** as well as gateway agents. For SDK agents the
  message is pushed into the live session: it is absorbed at the next tool
  boundary, or triggers an immediate follow-up turn if the agent was already
  writing its final answer.
- Nothing is dropped: an interjection that misses its turn is saved and
  delivered ahead of your next message, and the UI tells you so.

#### Tiger Team recovery
- Durable journals and checkpoints, full artifact capture, safe resume after a
  crash, disconnect or restart, and follow-up access to archived runs.
- New API: `GET /api/tiger-team/status`, `POST /api/tiger-team/resume`,
  `POST /api/tiger-team/reconcile`, `GET /api/tiger-team/archive/:id`.
- Completed work is not redone on resume; tool calls with an unknown outcome
  are never silently replayed.

#### Delegation policy (`SDK workers` setting)
- Toolbar selector and `GET`/`POST /api/sdk_workers`, stored as `sdkWorkers`:
  - `fallback` (default) — platform agents and temporal workers first; the SDK
    sub-agent tool only when those cannot do the job, with a stated reason.
  - `allow` — no steering (previous behaviour).
  - `off` — the SDK sub-agent tool is removed from agents entirely.
- Agents now see a live roster of platform workers with each one's model,
  strengths, and whether it is busy.

#### Also new
- **Hub recovery watcher**: if the hub goes down mid-message, the page waits
  and resends automatically when it returns.
- **Authenticated HTTP tools** for agents: `auth_http_status`,
  `auth_http_request`.
- **OpenAI Responses API** translation for models that require it.
- **Newest-installed SDK loader**: the hub resolves every installed copy of
  `@anthropic-ai/claude-agent-sdk` (hub-local, npm-global, or
  `CLAUDE_SDK_PATH`) and loads the newest, logging its choice at startup.

### Changed
- **Network binding** defaults to loopback; see upgrade notes. The startup
  banner states `localhost only` or `NETWORK-EXPOSED`.
- **Transport layer**: shared keep-alive connection pool, a stream stall
  watchdog (longer allowance for local model servers), closed-stream guards,
  and cancellation that frees pooled sockets promptly.
- `consult_agent` is described to agents as the primary way to delegate.
- Tiger Team stop is targeted at the session's own team; `tt_error` events are
  now `tt_interrupted`.
- Meeting alerts poll every 60 seconds over a 30–180 second window (was every
  30 seconds over 60–120), which removes a flood of calendar calls.
- Routine MCP stdio `INFO` chatter is no longer written to the server log.
- `@anthropic-ai/claude-agent-sdk` updated to 0.3.270.

### Fixed
- **Gemini 3.x agents could not use tools.** The thought signature Gemini
  attaches to each tool call was dropped, so the second request of any
  tool-using turn failed with HTTP 400.
- **Consulting a busy agent returned "(no response)".** The caller is now told
  the agent is busy, that nothing ran, and which workers are free.
- **Recoverable provider errors were never recognised.** The chat loop looked
  for the text "Gateway 5" while the client throws "Provider 5xx".
- A latent `ReferenceError` in the abort log line of the gateway tool loop.
- Runtime data files created by the new features are now gitignored, so a
  running hub no longer looks modified to the Update button.

### Security
- Loopback-only binding by default, with network exposure refused unless
  Basic auth is fully configured.
- Interjection fallback data is written with `0600` permissions.
- An upstream tool-proxy route that executed MCP tools behind only a
  loopback-peer check, with Basic auth bypassed, was deliberately **not**
  included.

### Deliberately not included from the upstream handoff
- Modules the upstream package did not ship: `data-check`,
  `panther-dashboard`, `pdf-parse`, `env-file`, `updater`, `task-scheduler`.
- The direct-key "cyber models" transport. `lib/cyber-models.js` is an inert
  stub that keeps the feature switched off.
- Single-gateway prompt wording and headers. This fork keeps direct
  multi-provider routing.

### Tests
- 250 offline tests across 18 suites. New suites: `sdk-loader`, `bind-host`,
  `sdk-interject`, `worker-policy`, `temporal-workers`, plus 12 suites from
  the upstream handoff covering Tiger Team recovery, the tool loop and
  authenticated HTTP.
- `test/integration.test.js` and `test/agent-workers.test.js` target an older
  layout and port and are not part of the offline run.

## [5.1.0] - 2026-08-09

Baseline for this changelog: MCP bridge for SDK agents, SQLite memory, shared
memory pool, max-length continuations, context footer with category breakdown,
dream system, Tiger Team enhancements, oMLX provider support, image
passthrough to local models, and git-sync "Discard Changes & Update".

[Unreleased]: https://github.com/mymaestroai/mymaestroai/compare/v5.8.1...dev
[5.8.1]: https://github.com/mymaestroai/mymaestroai/tree/v5.8.1
[5.8.0]: https://github.com/mymaestroai/mymaestroai/tree/v5.8.0
[5.7.3]: https://github.com/mymaestroai/mymaestroai/tree/v5.7.3
[5.7.2]: https://github.com/mymaestroai/mymaestroai/tree/v5.7.2
[5.7.1]: https://github.com/mymaestroai/mymaestroai/tree/v5.7.1
[5.7.0]: https://github.com/mymaestroai/mymaestroai/tree/v5.7.0
[5.6.0]: https://github.com/mymaestroai/mymaestroai/tree/v5.6.0
[5.5.1]: https://github.com/mymaestroai/mymaestroai/tree/v5.5.1
[5.5.0]: https://github.com/mymaestroai/mymaestroai/tree/v5.5.0
