# Ring cameras: setup guide

This module connects your Ring cameras to My Maestro. When a camera sees motion or a doorbell is pressed, your notice
agent is told and gets a still picture. Your agents can also ask for the latest picture, a live picture, a short live
clip, a recorded clip, or the recent event history. It is read-only: nothing in your Ring account can be changed, and
nothing can be unlocked or switched off. Pictures and clips are saved in the notice agent's Files folder, which is how
that agent (and only that agent) sees them. What an agent looks at goes to that agent's AI model as part of the
conversation.

Ring does not use a sign-in page for this. You create a private app in Ring's developer console, give it four web
addresses on your Maestro, and then start the connection from the Ring app. Ring must be able to reach your Maestro
from the internet over https, so your Maestro needs a public address (for example https://maestro.example.com).

## What each step does

- **What this does:** explains what the module can and cannot do.
- **Create your private app in Ring:** in Ring's developer console, create a private app with the Cameras and
  Doorbells scopes. Ring asks for four addresses; they are your public address followed by `/hooks/ring/link`,
  `/hooks/ring/token`, `/hooks/ring/events` and `/hooks/ring/done`. Save the app and copy the Client ID, the Client
  secret and the key Ring uses to sign events.
- **Install:** puts the module in place. Live pictures and clips also need `ffmpeg` at /usr/bin/ffmpeg and Python 3
  with the GStreamer bindings. Test the second with `python3 -c 'import gi; gi.require_version("Gst", "1.0")'`: no
  error means it is there. On Debian or Ubuntu: `sudo apt install ffmpeg python3-gi gstreamer1.0-plugins-good
  gstreamer1.0-plugins-bad gstreamer1.0-libav`. Event pictures, recorded clips and history work without them.
  The module needs Linux (it uses /proc/self/fd to write files safely); on other systems it does not run.
- **Client ID, secret and signing key:** paste the three values from Ring.
- **Your settings:** the email of your Ring account, your public https address, your time zone, optional house
  groups and the face recognition switch (see below).
- **Addresses for Ring:** shows the four addresses built from your public address, ready to copy into Ring's console.
  If it says to save your public address first, go back to the settings step.
- **Connect your Ring account:** opens the connection for 30 minutes and shows a one-time code. Start the connection
  from the Ring app; the page that opens asks for the code. If the code runs out, run this step again. Five wrong codes
  close the page; run the step again for a new code.
- **Who can look at the cameras:** the notice agent always gets the notices and pictures. Tick any other agents that
  may ask to see the cameras.
- **Finish:** switches the module on. A nightly check confirms the connection still works; it keeps no camera data.

## What each setting does

- **Ring account email:** the email address of the Ring account that owns the cameras. It is sent to Ring once, while
  the account is linked. Without it the link page refuses to connect.
- **Public address of this Maestro:** the https address Ring can reach, with no path. It is only used to show the four
  addresses in the setup; the module itself does not call it.
- **Time zone:** names like `Europe/London` or `America/Chicago`. Used for the times in notices and for the day
  folders of pictures. An unknown name falls back to UTC.
- **Houses:** optional grouping, written as `House A: front, back; House B: garage`. A camera whose name contains one
  of the words belongs to that house. Notices say which house, otherwise "house unknown".
- **Keep pictures / clips (days) and size limits (MB):** older files, and the oldest files beyond the size limit,
  are removed automatically. Files named in a notice that may still be waiting are kept for 7 hours.
- **Recognize faces:** off by default. It needs a face recognizer running on this same computer. Pictures are only
  ever sent to the recognizer address below, and only if that address is this computer (`127.0.0.1` or `localhost`).
  Agents see names and counts, never the recognizer's fingerprints or face crops.
- **Face recognizer address:** default `http://127.0.0.1:9795`.
- **Notice unknown faces seen before:** with face recognition on, tells you when an unknown face was seen on earlier
  visits in the last 30 days.
- **Face records size limit:** the private face records follow the picture age; this caps their size.

## Tools

- **status:** the cameras, whether each is online, and whether the Ring connection works.
- **still:** a picture, `latest` (newest stored picture from the last N minutes, 1 to 1440) or `live` (opens the
  camera for a moment; needs ffmpeg and the GStreamer bindings). Returns the saved file, relative to the Files folder
  and absolute.
- **clip:** `live` (1 to 55 seconds) or `recorded` (1 to 300 seconds, with `start`). Returns the clip and a sheet of
  12 frames from it. Ring records around events, so find the time with `history` first. Starting times are written as
  `YYYY-MM-DD HH:MM` in the time zone above, as an ISO time with a zone, or as epoch milliseconds, and may be up to
  180 days back.
- **history:** events for one camera or `all`, from the last 1 to 168 hours.
- **faces:** who the recognizer sees in a saved still, as of now.
- Limits per hour: 120 latest stills, 30 live stills, 20 live clips, 20 recorded clips, 60 history, 60 status,
  300 faces. Only one still, clip or faces request runs at a time.

## Common errors and fixes

- **"Ring is not linked, or the link needs renewing":** the connection was never made or was lost. Run the connect step
  again. A notice "The camera connection was lost. Sign in again: Data connectors, Ring cameras." means Ring rejected
  the stored sign-in; this also happens if the connection is removed in the Ring app.
- **The link page says no connection is in progress:** the page only works for a connection started from the Ring app
  in the last 10 minutes. Start again from the Ring app.
- **The link page says connecting is closed:** no code is open. Run the connect step to open it, or you used five wrong
  codes.
- **"That code is not right":** type the code from the setup (letters and digits; the dash is optional).
- **"The connector has no account email in its settings yet":** fill in the Ring account email in the settings step.
- **"... already connected to a different Ring account":** the module links one Ring account. To use a different one,
  remove this connector in Data connectors and set it up again.
- **Events never arrive:** check that the four addresses in Ring's console match the Addresses step exactly, that your
  Maestro is reachable from the internet over https, and that the signing key was pasted correctly. A wrong key shows
  as refused events in the log.
- **Live pictures fail with "could not be opened" or "no video":** install the programs listed in the Install step; the
  health check reports whether they are present.
- **"the disk is nearly full":** the module keeps 2 GiB free; remove old files or lower the size limits.
- **"Ring renewed the sign-in but it has not been saved yet":** Ring gives a new lasting sign-in each time it is used and
  My Maestro saves it. If saving fails, the new one is kept privately and tried again; if it stays, restart My Maestro
  and check the connection.
- **"too many ... requests this hour":** the per-hour limits above protect your camera and Ring's service; wait.

## Revoking access

Remove the connection in the Ring app (the list of connected apps), or delete the private app in Ring's developer
console. Then remove the module under Data connectors to delete its saved state.
