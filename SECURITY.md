# Security

## Report a Finding

Report security findings to the owner privately. If no private contact is listed,
ask the owner for one without sharing vulnerability details. Keep raw secrets and
exploit details out of issues and PRs.

Include the affected component, impact, and sanitized steps to reproduce.
Separate confirmed behavior from suspicion. If a credential leaks, tell the owner
promptly so it can be rotated; removing it from a file does not revoke it.

## Credentials and Data

This repository is public. Treat committed code, issues, PRs, workflow logs, and
artifacts as publicly accessible. Keep sensitive data out of code and shared work.
Store credentials in the project's secret store or ignored local configuration.
Use dummy values in examples and sanitized data in tests. Check logs, screenshots,
issues, PRs, and agent context before sharing them. Grant only the access a task needs.

## Security Changes

Preserve authentication, authorization, and input validation. When changing a
boundary, describe its access rules and test allowed and denied cases. Document
project-specific trust boundaries here as they emerge.

## Terminal Runner

The standalone terminal API is a personal/self-hosted shell capability, not a
multi-user sandbox. Anyone holding `NOVADECK_TOKEN` can execute programs and read
or modify files as the runner's OS account. Projects and sessions organize work;
they do not restrict filesystem access. Run under a dedicated, unprivileged
account. Do not run the runner as root or expose it as a service for strangers.

The terminal API is disabled without a configured token. Use a cryptographically
random token (at least 32 bytes of entropy), keep it out of URLs, logs, browser
bundles, and committed files, and send it in the initial RPC handshake. Rotation
currently requires restarting the runner, which ends its shells. The token is
removed from inherited PTY environment variables, but processes sharing the OS
account are not isolated from the runner.

A runner served over a MessagePort (`servePort`) trusts whoever holds the port and
skips the token. Hand such a port only to a renderer the host itself loaded, such
as an Electron window with context isolation, and never forward it to web content.
The desktop host answers port requests only from the main frame of its own windows,
which cannot navigate away from the packaged UI.

Bind to loopback by default. Remote access requires a trusted HTTPS/WSS reverse
proxy (or a private encrypted network), explicit browser origins in
`CORS_ORIGINS`, and firewall rules preventing direct public access to the plaintext
listener. Requests without an Origin header are permitted for native clients but
still require authentication. CORS and origin checks do not replace the token.
An allowed web UI is trusted with shell access: compromise of that UI can
compromise the runner account.

The runner bounds connections, messages, terminal counts, replay history, and
per-viewer pending output. Heartbeats release dead connections; a slow viewer is
detached without killing its terminal. These limits do not constrain shell CPU,
disk, network, or child-process usage. Apply OS/service limits where needed.
Closing a terminal or stopping the runner is not a process-tree kill guarantee;
daemonized or hangup-ignoring descendants may survive. Use service-level process
isolation and cleanup if that guarantee is required.
Screen state and replay stay in memory and may contain secrets; neither is logged
or stored in SQLite. Metadata files use owner-only permissions where supported.
