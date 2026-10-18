# Security policy

## Reporting a security problem

Please report it privately, not in a public issue:
https://github.com/mymaestroai/mymaestroai/security/advisories/new
(GitHub's private vulnerability reporting).

Include what you found, how to reproduce it, and the commit you tested. You will get an answer
within a few days. Please allow reasonable time for a fix before you disclose the problem.

## Supported versions

Fixes land on `main`, the stable channel. Install them with the hub's **Update** button or
`mymaestro update`.

## Scope

In scope: the hub itself (server, pages, phone app), its installer and its command-line tools.
Out of scope: the model providers and the outside services that agents connect to.

The hub is meant to run on your own machine. It listens on localhost only by default and expects
remote access through Tailscale. Listening on the network is an explicit setting (`HUB_BIND_HOST`)
that the hub ignores unless sign-in is set up: once accounts exist, an administrator with two-factor.
