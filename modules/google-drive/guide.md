# Google Drive backups: setup guide

This module keeps a copy of every nightly backup in the Google Drive of the account that signs in. The copies are
already encrypted when they leave this computer. My Maestro works only in its own backup folder. Google's per-file
permission covers only the files the app creates there, or files you choose to share with it.

## What each step does

- **About:** explains what the module can and cannot see.
- **Register your Google app:** each person creates their own small Google app (a project, the Drive API, a consent
  screen limited to the "drive.file" permission, and an OAuth client of the type "TVs and Limited Input devices").
  Nothing is shared with anyone else. This permission doesn't need Google's review. On a new project, Google Auth
  Platform first shows **Get started**, one form that asks for the app name and your email, the audience and the
  contact details. Internal exists only for Google Workspace accounts; personal Gmail accounts choose External and,
  afterwards, **Publish app** on the Audience page.
- **Install:** puts the module's tool server in place.
- **Client ID and secret:** the two values Google shows when the client is created.
- **Sign in:** shows a short code; approve it at the address shown, on any phone or computer, with the Google
  account whose Drive should hold the backups.
- **Finish:** switches the module on. Each night's backup is then copied to Drive.

## Common errors and fixes

- **invalid_client:** the Client ID or secret was pasted wrong, or the client isn't of the type "TVs and Limited
  Input devices". Create a new client of that type and paste both values again.
- **access_denied:** the sign-in was declined on the approval page, or the app is Internal and the account is outside
  the organisation. Try again and approve, or use an account of the organisation; otherwise make the app External.
- **org_internal:** the app is set to Internal but the signing-in account is not in that Google Workspace
  organisation. Sign in with an organisation account, or change Audience to External and publish the app.
- **Sign-in stops after 7 days ("revoked or has expired"):** an External app left in Testing has its sign-ins ended
  by Google after 7 days. In Audience, choose Publish app, then sign in again.
- **admin_policy_enforced:** a Workspace administrator blocks the app. Ask them to allow it, or use a personal
  Google account.
- **Storage quota full:** the Drive has no room for the next backup. Free some space or buy more storage; the next
  night's backup will then upload.
- **"The Google sign-in was revoked or has expired. Sign in again.":** run the Sign in step again.

## Revoking access

Remove the app at https://myaccount.google.com/permissions, or delete its OAuth client in Google Cloud
(Google Auth Platform, Clients). Backups already in Drive stay there until you delete them.

## Where the copies appear

In your Drive, in the folder "My Maestro AI Backups". Only files placed there by this module are visible to it.

## A different Google account or app registration

A different Google account, or a new Google app registration, can't see backups an earlier one made. They stay in that
Drive folder and can be removed there by hand. Keep the old registration until you no longer need those copies.
