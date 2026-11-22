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
`apps/desktop/src/main/notices/notices.ts`) as a terminal id of letters, digits, `_` and `-`,
at most 64 long, a title of at most 256 characters and a body of at most 120, neither
holding a control character or a bidirectional mark, override or isolate; nothing else of it,
such as an icon or a sound, crosses, and any other value is dropped. The preload sends
only those three fields, and the page cuts and cleans its text the same way before it
asks (`desktopNotices` in `frontend/runner-adapter/src/desktop/app.ts`). The page can also
take a notice away by its terminal id (`closeNotice`, `novadeck:notice-close`), and report the
Inbox count for the app's icon (`setBadge`, `novadeck:badge`): a whole number from 0 to 999 and
an image that is null or a base64 PNG data URL of at most 16384 characters, checked by
`desktopBadgeOf` in the page, the preload and `apps/desktop/src/main/notices/badge.ts`, each from
the app's own window only. The page can also ask whether its window has the system's focus
(`onWindowFocus`, `novadeck:window-focus-request`, carrying nothing); the host answers only the
app's own page, with a boolean, and sends it again on each change. On Linux,
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
`harnesses/core/src/decode.ts`). It is the agent's words, so it may echo
what the agent read, a secret included, onto the system's notification centre, which
other applications and the lock screen may show; turn **Notify when an agent finishes**
off in Preferences where that matters. A compromised UI can show no more through this
channel than notifications with text of its choosing, under the app's name.

## Desktop Uninstall

The page asks the desktop host what uninstalling would do (`uninstallPlan`) and to do it
(`uninstallApp`), and to quit once it has (`quitApp`), on three `novadeck:` channels
(`uninstallPlanChannel`, `uninstallAppChannel`, `quitAppChannel` in
`apps/desktop/src/bridge.ts`). The host acts only on a request from the main frame of one
of its own windows showing the app's own UI, as for appearance reports; any other sender, such
as a page in the companion pane, is told uninstalling is unavailable and nothing is touched.

The only value a request carries is `keepData`, and the host deletes the person's data only
when it is exactly `false`; anything else keeps it. The host works out the rest itself
(`apps/desktop/src/main/install/uninstall.ts`): the plan from where the running app is installed,
and every path to delete from the platform's own locations, never from the page. It
refuses a path that is not absolute and normalized, holds `..` or a control character, or is a
root, the home folder or a folder that holds it, before the shutdown, so a refusal ends no
shells. A copy that is portable, unpackaged, or not found where an installer puts it has no
plan to run. On Linux the host removes the sandbox profile through `pkexec`, which shows the
system's own password prompt; it never runs `sudo`, and when `pkexec` fails it returns the
command for the person to run themselves, built from the profile's path alone. On Windows it
starts the installer's own uninstaller, and, to delete data, a hidden PowerShell helper that
waits for the app to exit and then, for up to ten minutes, for the uninstaller's file to be
gone; it deletes nothing if the file is still there, as after a cancelled uninstall. A compromised UI can end the app's shells and remove the app and,
by sending `keepData: false`, the app's data folder, which it could already do through the
runner; it can remove no other path through this channel.

## Companion Pane Pages

Pages in the companion pane load in Electron's `<webview>` with no preload, no Node and a
sandbox, on the `persist:novadeck-pages` session, apart from the app's
(`libraries/viewers/src/browser/host.ts`). The session is kept on disk, in `Partitions`
in the app's data folder, so a person who signs in to a site stays signed in there in
every page and after a restart. Electron keeps its cookies without encryption (the
cookie-encryption fuse is off), readable by anything that runs as the person, as their
shell and agents already do. The session is refused every permission, device, download
and `file:` address.

Agents choose which pages the pane shows, so a page an agent shows loads signed in
wherever the person signed in, and the agent hears of its title, the errors it logs and
the requests it fails. That is the person's choice: their agents can already reach their
browser and its sign-ins through browser tools. No page reaches the app's page or its
bridge: a page has no preload, and the host answers only its own windows showing the app.

A window a page opens goes through only right after the person's click or key, one per
gesture. A popup the page sized, as a sign-in opens, opens in a window of the app on the
pages' session, with the page's own lockdown and guard, and its opener, so the sign-in
can hand its answer back; anything else opens in the person's browser. Electron takes a
window's options from the features the page names, so every option that could hide the
window, cover others or pass it off as the app's is pinned: shown, framed, opaque,
focusable, in the taskbar, not on top or full screen, placed by the system, resizable and
no smaller than 360×300, and titled by the site it is at before the page's own title.
Only its size, within that, is the page's. It closes with the page view that opened it,
so the view stays live, not resting, while it is open; closing the page's item, or
anything else that takes its view away, closes it too. A passkey
sign-in that names no passkey signs in with the only one that fits, or asks the person
which in a dialog of the window the page is in; a cancelled or failed question cancels
it. On macOS the app doesn't turn on Touch ID passkeys yet, so the person's own synced
passkeys don't show there; a security key or a phone still can.

## PDF, 3D Model and Web Page Previews

A PDF an agent shows is parsed and drawn by pdf.js, and a 3D model (GLB/glTF, STL, OBJ with its
materials, PLY, 3MF) by three.js, each in a frame of its own (`libraries/viewers/src/frame`, used
by `pdf.ts` and `model.ts`), never in the app's page. The frame is an `<iframe
sandbox="allow-scripts">`, without `allow-same-origin`, so its origin is opaque: it can't read
the app's page (`parent.document` throws), its storage, cookies or IndexedDB, and it can't open
popups or move the app's window. In the desktop app it runs in a renderer process of its own.
Its page, `viewer-frame.html` beside the app's own (`libraries/viewers/src/frame/frame.html`,
copied to `frontend/ui/public`), has a policy of its own, `default-src 'none'`: no WebSocket (so
no reach to the runner), no image, font, media or frame from any address, and fetches only of
`blob:` and `data:` addresses (`connect-src blob: data:`), which are bytes the frame already
holds, never the network; a `blob:` address another origin made can't be read from it. It allows
one inline script, named by its hash, which runs only when the page's origin is opaque, so a page
that frames it without the sandbox, as a site could frame a development server's copy, runs
nothing with the app's origin. That script takes one message, from its parent only: the viewer's
scripts as text (pdf.js and the PDF viewer, or three.js, its loaders and the 3D viewer bundled
into one), a worker's if it has one, and one end of a `MessageChannel`. The frame runs those from
blob addresses; pdf.js also with WebAssembly for its image decoders and a blob worker.

No page policy covers WebRTC, so the frame's script deletes WebRTC's constructors
(`RTCPeerConnection` and every other global named `RTC…` or `webkitRTC…`) from the frame before
the viewer runs. A child frame a script in it makes can't hand them back: the sandbox gives the
child an opaque origin of its own, so its globals can't be read, and the frame's policy, which
the child inherits, runs no script in it (pdf.test.ts checks both). Should a flaw still reach a
peer connection, the desktop app sends no WebRTC traffic over UDP that doesn't go through a
proxy (`setWebRTCIPHandlingPolicy("disable_non_proxied_udp")` on its windows; the app uses no
WebRTC), which leaves a TURN server reached over TCP; in a browser, as `pnpm dev:web`, the
browser's own WebRTC settings apply.

A PDF's bytes go into the frame transferred over the channel; pdf.js's CMaps, fonts and decoders
too, asked for by a name the app checks (letters, digits, `.`, `_` and `-`), read once for every
frame from the app's own copies, at most 16 a second. A model's bytes go in the same way, with
the files beside it that it names (a glTF's buffers and textures, an OBJ's material libraries
and theirs), which the runner reads for it: only a name the model itself writes, in the model's
folder or under it (`..` and symlinks out of it are refused), never one that may hold secrets
(whatever the person revealed), 64 at most and 256 MB with the model; an address of its own
(`https:`, `file:`, an absolute path) is never read. In the frame, each file a loader asks for
is answered from those by name, and anything else with nothing, so no address a model names is
ever fetched. What a glTF's arrays and a 3MF's zip claim to hold is checked before a loader
believes it, so a file that claims gigabytes isn't drawn rather than taking the frame's memory;
the frame carries no decoder for Draco, Meshopt or Basis compression.

What comes out is only what the viewer's own check takes
(`libraries/viewers/src/pdf/messages.ts`, `model/messages.ts`), each field checked and nothing
more: a PDF's page at the top, zoom and page count, or a model's camera and toggles; why it isn't
drawn; whether it is opening; the files pdf.js needs; a still of a model, as a PNG of at most
1 MB; and three of the pane's actions for keys pressed in it (hide the pane, the next or previous
tab). Those are names, never keys, so nothing from the frame types into a terminal or an agent's
composer. The frame has the focus only when the person gives it: a press on the PDF or model, or
Tab to it, through a glass in front of the frame, or the app focusing the viewer; the person
leaving it takes the focus back from it. A drag begun on the glass, which turns a model, goes to
the frame as where the pointer is and which buttons are down, never as an event. A script in the
frame that takes the focus itself (which the browser allows a frame the person has just used) has
it put back where it was as soon as it leaves anything in the app's page, or the app's window
loses it to the frame, so keys typed for a terminal don't reach it. The app acts on an action
only while the frame has the focus it was given, at most five a second. Stills are drawn by one
such frame out of sight, which takes no presses and is never given the focus. The app listens to
nothing the frame posts to its window, and its other window listeners check the sender is their
own. A frame that loads another page than its own, which only a script in it could make it do,
is taken away once that page has loaded; the app page's own policy keeps such a page to the app's
origin, so in the desktop app it can load none at all (its files are refused to the frame), and
under `pnpm dev:web` it can load another page of the development server, which runs without the
frame's policy until then. Within the PDF's frame, only the pages are drawn, on canvases, with no
annotation, text or form layer; pdf.js's scripting sandbox is never loaded, so a script a PDF
carries never runs; and XFA is off.

A web page an agent shows (an `.html` file) is drawn in the same frame (`libraries/viewers/src/html.ts`,
`html/frame-viewer.ts`), under the same policy and walls. The viewer reads the stylesheets, pictures and fonts the page
names (and those the stylesheets name) through the runner, by names from the page's folder
(`companions.part` with `file`): only a file of a style, picture or font type, inside the page's
folder (`..` and symlinks out of it refused, an address of its own, a root or a scheme never read),
never one that may hold secrets, at most 64 files and 32 MiB, and the runner reads nothing else
for a page. The frame builds the page from them with its DOM parser, which loads and runs nothing:
stylesheets become `<style>` elements, pictures and fonts data addresses, and scripts, frames,
plugins, `<base>` and refreshes are taken out. The result is drawn in a child frame of its own with
an empty `sandbox` attribute (no script, form, popup or navigation), which inherits the frame's
policy: no script at all (the page's inline scripts are blocked, and its own removed), no
network (an address the page names that wasn't handed over loads nothing), no frame in the page.
So a page's script never runs, however the page is written, and it can reach neither the app, the
runner, its storage nor the network. It's drawn under the pointer as it is, without the glass the
PDF and 3D viewers have: the page's own frame takes presses, scrolls and selection, and can't
take the focus itself, as it runs no script.

A flaw in pdf.js or three.js reaches only its frame: the bytes of the PDF or model it shows (and
the files beside a model), the keys the person types while it has the focus, and what it may tell
the app. It could draw something misleading, or keep its pane busy; only a further way back to
WebRTC, as above, could send what it has elsewhere.

## Packaged App Fuses

The packaged binary's Electron fuses (`electronFuses` in `apps/desktop/electron-builder.yml`)
turn off running it as Node (`ELECTRON_RUN_AS_NODE`), `NODE_OPTIONS` and `--inspect`, so
starting the binary with them runs nothing of the starter's choosing in the app's place, and
turn on the embedded asar integrity check (macOS and Windows) and loading the app only from
`app.asar`. The UI in `resources/ui` is outside that check. Chromium's
`--remote-debugging-port` is not a fuse and stays open: whoever can start the binary with it
reaches the page and its preload bridge, and through them can run shells as the app, with the
permissions macOS has granted it (such as access to protected folders).

## Release Verification

Releases are built by the repository's `release.yml`. Every asset gets a GitHub build
provenance attestation, which proves this repository's workflow built it. `SHA256SUMS` lists
the assets' checksums. `install.sh` checks each download against it and, when the GitHub CLI
is installed and signed in, runs `gh attestation verify <file> --repo novadeck-org/novadeck`
too; otherwise it says plainly that only the checksums were checked. The checksums come from
the same release as the files, so alone they show a download arrived whole, not who built it.
To check by hand: `gh attestation verify <file> --repo novadeck-org/novadeck`.

There is no GPG signature today: the workflow signs `SHA256SUMS` as `SHA256SUMS.asc` only once
a release key is configured (`docs/release-signing.md`), and none exists yet. macOS builds are
signed and notarized when the Apple credentials are set. Windows builds are unsigned until
Azure signing is set up, so Windows shows SmartScreen's warning. The desktop app's own
updates come from GitHub: it downloads only files under
`https://github.com/<owner>/<repo>/releases/download/`, whatever novadeck.dev's feed says, and
on macOS also checks the new app's code signature. The check allows any release under that prefix, so a compromised website could still offer an older genuine release or a prerelease. Linux and Windows check the feed's SHA-512
of the file and nothing else, so the attestation, not the app, is where a release's origin is
proven.

## Pasted Files

The desktop preload's `pathForFile` hands the page the path of a `File` it already
holds, which only a paste gives it; it names no other file and reads nothing. The
companion pane's pages get no preload (see `libraries/viewers/src/browser/host.ts`), so
they have no bridge to ask through.

A file copied in a file manager pastes its own path, so names chosen outside Novadeck,
such as a downloaded file's, now reach the terminal's shell. They go in inert or not at
all (`ownPath` in `libraries/terminal/src/view/paste.ts`): a path with a control
character never does; a POSIX path has a backslash before every character a shell
splits, expands or globs on; a Windows path goes in only when every character is a
letter, mark, digit, space, `.`, `_`, `-`, `\` or `:`, with no space before a `-`, and
in double quotes when it has a space; no spacing modifier letter or combining
diacritic, which a code-page conversion can turn into a quote. Where its quotes are
lost (PowerShell running a `.cmd`, or a paste into a quote already open), such a path
can't run a command or start an option, though its spaces may split it into words. A
path that fails these rules is uploaded instead, under the runner's own safe name,
which keeps to the same letters (`safeName` in
`backend/runner/src/terminals/uploads.ts`).

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

The token is the owner's. The owner can give each device a credential of its own
(`devices.mint`, docs/backend-api.md "Devices"), which grants the same shell access but is
revoked alone (`devices.revoke`), ending that device's sessions at once, without rotating the
token. The runner keeps only a SHA-256 hash of each device's 256-bit secret, and compares it
in constant time after looking the device up by its public id. Only the owner's connections
(the token's, or the desktop app's port) may add a device; a device may revoke only itself.
A revoked credential's next handshake is told it was revoked, and only a handshake that
proves that credential: a wrong secret learns nothing more than a wrong token does. Logs
name a device by its id, never by its credential.

A runner served over a MessagePort (`servePort`) trusts whoever holds the port and
skips the token. Hand such a port only to a renderer the host itself loaded, such
as an Electron window with context isolation, and never forward it to web content.
The desktop host answers port requests only from the main frame of its own windows,
which cannot navigate away from the packaged UI.

Bind to loopback by default: the runner refuses to start on any other `HOST` unless
`NOVADECK_ALLOW_REMOTE_HOST=1` is set. Remote access requires a trusted HTTPS/WSS reverse
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
in the SQLite metadata file so a restored terminal can show it again. It is saved about
every 30 seconds while it changes, and when a shell exits or restarts. Before it is saved,
what looks like a secret (known token prefixes, values named like secrets, keys, long
key-like runs) is masked in a worker thread; a transcript that cannot be masked is not
saved, and the copy saved before stays. The masked text is then encrypted (AES-256-GCM,
bound to its terminal) with a key the desktop app keeps in the system keychain: the
Keychain on macOS, DPAPI on Windows, the Secret Service on Linux (GNOME Keyring, or KWallet
where it offers the Secret Service). Where nothing protects that key (no keyring on Linux,
an unlock that is refused or fails, the standalone runner, which has no key) no transcript is saved or shown, and the setting stays as it is.
A restored terminal waits a few seconds, once for the run, for the key; if it comes later,
that terminal's saved transcript is not shown and is left as it is until the next start.
A transcript found unencrypted is forgotten at every start, key or not, but a database set
aside as `workspace.sqlite.earlier-<time>` keeps what it held, plain transcripts included,
until you delete it. The key keeps the database file, and a backup of it, from showing the
transcripts; titles, summaries, commands, directories and Inbox content are still stored in
plain text there. It does not protect against a process of your own user, which on Windows
and Linux can ask the system to unwrap the key as the app does. Anything else that was
typed or printed may still be saved. Metadata files use owner-only permissions where
supported (0600 in a 0700 directory); on Windows they live in the per-user application data
folder. Before a migration changes the database, the runner copies it, plain transcripts
included, to `snapshots/` beside it (the newest three are kept, with the same owner-only
permissions) so an upgrade can be undone; delete that folder to remove them. A copy keeps
transcripts as the database held them: encrypted ones stay encrypted, and only a database
that predates the encryption holds plain ones. Titles, summaries, commands, directories and
Inbox content are plain text in every copy. The runner and the desktop app also write log
files (`runner.log` and the main process's `host.log`, rotated by size) to the logs folder,
with paths, URLs, account names and known secrets redacted. They hold what the app did
(starts, failures, update checks), not terminal contents, though an error message can name a
command or a folder. Started with `NOVADECK_LOGS=verbose`, for a bug report, the logs also
hold lines that may include what a terminal's screen showed. When an agent's dialog can't be
read, the log says so once, with the harness, its version, the kind and tool of the request (an
MCP tool as just `mcp`) and the adapter's reason codes, never the dialog's text outside verbose
lines. A card for such a dialog also offers "Save for debugging", which, only when the person
clicks it, writes one owner-only JSON file to a `dialogs` folder beside the logs (beside the
database for a runner started without the app) holding the screen as shown and the request's tool
input, so it can be attached to a bug report or made into a test; nothing sends it anywhere, the
newest 50 stay, and it is yours to read and delete before you share it. If the app crashes, Electron
saves a minidump (process memory, which can hold terminal text) in its local crash folder;
it is never uploaded.

Each shell the runner starts can report which agent session runs in it, through a
local endpoint: a Unix socket in a private temporary directory, or a named pipe on
Windows. The endpoint accepts an agent session report, and the agent's tool calls to
Novadeck's MCP server, each for the terminal whose random per-shell token
(`NOVADECK_REPORT_TOKEN`) it carries. So that token authorizes every agent tool call the
terminal's agent makes (asks, tells, messages to other agents, and opening a terminal that
runs a command), and a process that reads a shell's token
can act as that shell's agent, with everything its agent may do. Processes in a shell can read
that shell's token, and so can misreport its session, which at worst resumes another session of
the same user. The runner builds the resume command itself, from a fixed program and arguments
and a session id limited to letters, digits, `.`, `_` and `-`, so a report cannot change what
the resume command runs. `open_terminal` with a command, which starts a new terminal that runs
it, is asked of the person first, with the exact command, the folder and the agent that asks,
and opens nothing unless they approve; the agent hears their answer. `close_terminal` likewise
asks before closing a terminal that runs another agent's session or a program other than its
shell, or a shell with a job in the background. The dialog writes out characters that draw as
nothing and holds the answer back until the person has seen the whole command. A command is
quoted into the shell only from characters no shell expands. The approval certifies the
command, not what it runs: a script it calls, a git filter (the `show` tool's `changes` runs
`git diff` with the folder's filters on) or a harness's settings in a folder an agent can write
can still run more, so an agent that edits files unattended remains a way around it.
The shell integration and hook live in the runner's own `shell` folder; the runner
never writes to the user's rc files or dotfiles. Only when the person connects an agent
does it install Novadeck's plugin into that agent, through the agent's own plugin
commands, and disconnecting removes it. Connecting Antigravity also edits the `statusLine` entry of its `settings.json` (in its
home folder, the one file outside Novadeck's own folders it writes): the entry reports the
session to Novadeck's hook and then runs the person's own status line, which it names;
on Windows it only reports, and is added only where the person has no line of their own.
Disconnecting puts the person's line back. The plugin's hook does nothing outside
Novadeck's shells. On Linux and macOS its MCP server starts the launcher the terminal names in `NOVADECK_MCP`, as its hook starts `NOVADECK_HOOK`'s, and otherwise the launcher of the Novadeck that connected the agent; both are the user's own environment, so a process that changes them runs nothing it couldn't run already.

Inbox asks and tells are authenticated terminal operations: an agent can create or
withdraw only its own asks, and cannot name a sender or create a person response.
Only the authenticated runner API used by the UI answers an ask. The runner binds the
answer to the exact asking session and atomically saves it with the resolved ask before
queuing delivery. Delivery says Novadeck relayed the response and adds a fresh person
mark named by the outer note, distinct from its lead mark. The standing rules recognize
only an Inbox response carrying that delivery's person mark as an approval exception;
a delivery wrapper states the exception only when its person mark is present.
Agent-written questions and choice/action labels
are quoted separately from the person's own words; earlier marks are escaped data.
Agent subjects, labels, option summaries, code paths and action instructions lose
terminal controls, invisible separators, zero-width characters and bidi marks.
The person's replies bypass the agent-messaging pause and have a separate bounded
queue, so paused peer traffic cannot deny them delivery.
Someone holding the runner's full token already has the UI's shell authority and can
answer asks too; a terminal's report token cannot call that API. Asks, tells and replies
remain in the workspace database as Messages history and can contain the person's
words. Resolved history is capped at one hundred records per terminal and a day after
resolution or the final reply outcome; pending replies retain their question until
delivered or gone. A terminal
may create ten asks or tells a minute, with independent fifty-item ask and tell caps.
Secret ask shapes and writing secrets into project files are unavailable.
