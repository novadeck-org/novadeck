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

## Desktop Appearance

The desktop host takes one report from its page about how it looks, on the
`novadeck:appearance` channel (the preload bridge's `showAppearance`). The host acts
only on a report from the main frame of one of its own windows showing the app's own
UI; it drops reports from any other sender, such as a page in the companion pane. A
report passes as a scheme of `system`, `light` or `dark` and an opaque `#rrggbb`
colour, and nothing else of it: any other value is dropped.

A valid report sets Electron's `nativeTheme.themeSource`, which is global to the app: it
changes the native parts of every window, and what `prefers-color-scheme` reports to
every page the app shows, the companion pane's pages included. It also sets the
reporting window's background colour and keeps the report in `appearance.json` in the
app's data folder, written to a temporary file beside it and renamed over it. The next
launch reads that file back through the same check before it sets `themeSource` and
opens windows on the kept colour. A compromised UI can change no more through this
channel than the app's colour scheme and its windows' background colour.

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
On Linux and macOS, closing a terminal or stopping the runner hangs up the program in
the terminal's foreground, then the shell, and once the shell has exited resumes that
program's process group with SIGCONT, so a program the shell's exit left stopped by job
control can still exit. This is not a process-tree kill guarantee; daemonized or
hangup-ignoring descendants may survive. Use service-level process isolation and
cleanup if that guarantee is required.
Replay stays in memory. Unless turned off in Preferences (`settings.set`), the runner
keeps each terminal's transcript, its serialized screen and scrollback capped at 256 KiB,
in the SQLite metadata file so a restored terminal can show it again. Transcripts may
contain secrets that were typed or printed. Metadata files use owner-only permissions
where supported (0600 in a 0700 directory); on Windows they live in the per-user
application data folder. Nothing is logged.

Each shell the runner starts can report which agent session runs in it, through a
local endpoint: a Unix socket in a private temporary directory, or a named pipe on
Windows. The endpoint accepts only an agent session report, for the terminal whose
random per-shell token (`NOVADECK_REPORT_TOKEN`) the report carries; it is not a runner
API and grants nothing else. Processes in a shell can read that shell's token, and so
can misreport its session, which at worst resumes another session of the same user.
The runner builds the resume command itself, from a fixed program and arguments and a
session id limited to letters, digits, `.`, `_` and `-`, so a report cannot make a
shell run anything else.
The shell integration and hook live in the runner's own `shell` folder; the runner
never writes to the user's rc files or dotfiles. Only when the person connects an agent
does it install NovaDeck's plugin into that agent, through the agent's own plugin
commands, and disconnecting removes it. The plugin's hook does nothing outside
NovaDeck's shells.
