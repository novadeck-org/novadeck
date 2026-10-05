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

## Desktop Notifications

The page asks the desktop host for a notification when an agent finishes, on the
`novadeck:notice` channel (the preload bridge's `showNotice`), and hears which one the
person clicked on `novadeck:notice-click` (`onNoticeClick`). The host acts only on a
notice from the main frame of one of its own windows showing the app's own UI, as for
appearance reports; it drops notices from any other sender, such as a page in the
companion pane, which has no preload. A notice passes (`desktopNoticeOf` in
`application/host/src/main/notices.ts`) as a terminal id of letters, digits, `_` and `-`,
at most 64 long, a title of at most 256 characters and a body of at most 120, neither
holding a control character or a bidirectional mark, override or isolate; nothing else of it,
such as an icon or a sound, crosses, and any other value is dropped. The preload sends
only those three fields, and the page cuts and cleans its text the same way before it
asks (`desktopNotices` in `application/ui/src/backend/runner/desktop-host.ts`). On Linux,
Electron hands the body to the desktop's notification server as it is, and that server
may read it as markup (it advertised `body-markup` and `body-hyperlinks` when probed with
Electron 44), so the host escapes `&`, `<` and `>` in the body there
(`notificationText`), and it shows as the text it was given, never as bold text, a link
or an image; the title, the notification's summary, is plain text on every platform, as
the body is on macOS and Windows. The host shows at most one notification per terminal id
at a time. A click brings the window the
notice came from to the front and sends that page only the terminal id, which the page
checks against the same pattern and uses only to select a terminal it already has.

What a notification shows is the start of the agent's last reply, which the runner reads
from the agent's own Stop hook payload or its transcript or rollout, strips of terminal
escapes, control characters and bidirectional marks and overrides, and cuts to 120 characters
before it reaches any client (`replyPreview` in
`application/runner/src/harnesses/harness.ts`). It is the agent's words, so it may echo
what the agent read, a secret included, onto the system's notification centre, which
other applications and the lock screen may show; turn **Notify when an agent finishes**
off in Preferences where that matters. A compromised UI can show no more through this
channel than notifications with text of its choosing, under the app's name.

## Pasted Files

The desktop preload's `pathForFile` hands the page the path of a `File` it already
holds, which only a paste gives it; it names no other file and reads nothing. The
companion pane's pages get no preload (see `application/host/src/main/pages.ts`), so
they have no bridge to ask through.

A file copied in a file manager pastes its own path, so names chosen outside Novadeck,
such as a downloaded file's, now reach the terminal's shell. They go in inert or not at
all (`ownPath` in `application/ui/src/backend/runner/paste.ts`): a path with a control
character never does; a POSIX path has a backslash before every character a shell
splits, expands or globs on; a Windows path goes in only when every character is a
letter, mark, digit, space, `.`, `_`, `-`, `\` or `:`, with no space before a `-`, and
in double quotes when it has a space; no spacing modifier letter or combining
diacritic, which a code-page conversion can turn into a quote. Where its quotes are
lost (PowerShell running a `.cmd`, or a paste into a quote already open), such a path
can't run a command or start an option, though its spaces may split it into words. A
path that fails these rules is uploaded instead, under the runner's own safe name,
which keeps to the same letters (`safeName` in
`application/runner/src/terminals/uploads.ts`).

An upload's path goes in double-quoted when the person's own folders above it hold a
space or any character outside those letters, as `C:\R&D\...` does (`shellPath`);
PowerShell running a `.cmd` program drops those quotes, so cmd can still split it there.

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
does it install Novadeck's plugin into that agent, through the agent's own plugin
commands, and disconnecting removes it. The plugin's hook does nothing outside
Novadeck's shells. On Linux and macOS its MCP server starts the launcher the terminal names in `NOVADECK_MCP`, as its hook starts `NOVADECK_HOOK`'s, and otherwise the launcher of the Novadeck that connected the agent; both are the user's own environment, so a process that changes them runs nothing it couldn't run already.
