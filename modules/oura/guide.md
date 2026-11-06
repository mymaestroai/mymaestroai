# Oura Ring: setup guide

This module lets your agents read your Oura Ring data when you ask: sleep, readiness, activity, heart rate, blood
oxygen and workouts. It is read-only: nothing in your Oura account can be changed. Your health data stays on Oura's
side until an agent reads it; it then goes to that agent's AI model as part of the conversation, and only when that
agent reads it. Only your lead agent can read it unless you tick other agents in the "Who can read it" step.

## What each step does

- **About:** explains what the module can and cannot do.
- **Register your Oura app:** each person registers their own small Oura app at
  https://cloud.ouraring.com/oauth/applications (a name such as "My Maestro", a website, and a Redirect URI). The
  Redirect URI must match exactly what the page shows, character for character. If you open your Maestro from more
  than one address (for example by name and by IP address), add one Redirect URI per address. Copy the Client ID and
  the Client Secret.
- **Install:** puts the module's tool server in place.
- **Client ID and secret:** paste the two values from Oura.
- **Sign in:** sends you to Oura's page; approve the permissions (daily, heart rate, workout, SpO2) and you come back
  here. Oura gives a new lasting sign-in each time it is used; My Maestro saves the new one automatically.
- **Who can read it:** pick which other agents may read your Oura data.
- **Finish:** switches the module on. A nightly check confirms the sign-in still works.

## Common errors and fixes

- **redirect_uri mismatch:** the Redirect URI saved in your Oura app differs from the one this page shows, or you
  opened Maestro from an address you did not add. Add the exact address shown (scheme, host, port and path) to the
  app and try again.
- **invalid_client:** the Client ID or Client Secret was pasted wrong. Copy both again from your Oura app.
- **access_denied:** the approval was declined, or one of the permissions was unticked. Sign in again and approve.
- **"The Oura sign-in has expired or was removed. Sign in again in Data connectors.":** the lasting sign-in no
  longer works (it was removed in Oura, or the app was deleted). Run the Sign in step again.
- **429, "limit of 5,000 requests in 5 minutes":** too many requests. Wait a few minutes.
- **A message about an Oura Membership:** Oura asked for a current Oura Membership to share this data, or a
  permission was not approved. Check the membership in the Oura app, then sign in again.
- **Only 10 people can sign in:** a new Oura app is limited to 10 users by default. That is plenty for one household;
  more needs Oura's approval.

## Revoking access

Remove the app under Connected apps in your Oura account, or delete it at https://cloud.ouraring.com/oauth/applications.

## What each tool returns

All tools take optional dates and return compact JSON. The default is the last 7 days; at most 31 days at a time.

- **oura_sleep:** one row per night with the date, sleep score, total, deep, REM and light minutes, efficiency,
  average and lowest heart rate, average HRV and latency in minutes.
- **oura_readiness:** date, readiness score, temperature deviation and the contributors.
- **oura_activity:** date, activity score, steps, active and total calories, inactivity alerts.
- **oura_heart_rate:** takes `start` and `end` as date-times (default the last 24 hours, at most 7 days). Returns
  timestamp, bpm and source, thinned evenly to at most 500 points.
- **oura_spo2:** date and average blood oxygen percentage.
- **oura_workouts:** date, activity, start, end, calories, distance and intensity.
