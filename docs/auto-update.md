# Auto-update

Every Novadeck build either updates itself or tells the person that a newer release
exists and where to get it. Installed apps look on GitHub Releases shortly after launch
and every four hours. The app never restarts on its own: a downloaded update installs
when the app next quits, or when the person chooses to restart, which saves every page
first, as quitting does.

The repository to look in comes from `resources/app-update.yml`, which electron-builder
writes into the app from its `publish` block. The release workflow fills that block from
`github.repository` (`-c.publish.owner` and `-c.publish.repo`), and its "Check Package
Names" step asserts the file names the repository that built the release. Nothing in the
host names a repository: the release page and the voice engine download read the same
validated owner and repository from that file (`update-release.ts`).

## Channels

A build follows one channel, which the person picks in Preferences and the host keeps
across launches in `update.json` in the data folder:

| Channel  | Follows                                          |
| -------- | ------------------------------------------------ |
| `stable` | GitHub's latest release that is not a prerelease |
| `early`  | Every release, prereleases included              |

Builds start on `stable`. The release workflow publishes every build as a prerelease;
the "Promote to Stable" workflow (`.github/workflows/promote.yml`, run by hand with an
optional version) runs `gh release edit --prerelease=false --latest`, which is what
`stable` builds then see. Before the first promotion a `stable` check finds no release,
which is logged as a failed check; nothing is offered and nothing crashes.

Switching applies to the next check, and one runs about two seconds later. Switching
back to `stable` never downgrades: an `early` build newer than stable waits until stable
passes it. Once an update has downloaded the schedule has ended, so a switch then applies
from the next launch; it does not discard the download.

electron-updater decides the release in `GitHubProvider.getLatestVersion`. With
`allowPrerelease` false it asks `/releases/latest`, which GitHub answers with the latest
non-prerelease (a 404 when there is none); with it true it takes the newest entry of the
releases feed. `stable` sets it false and `early` true.

## Which builds update

| Build                          | Mode                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| macOS, Developer ID signed     | Installs (Squirrel.Mac)                                                                  |
| macOS, unsigned                | Tells; every build is unsigned until the certificates are in place                       |
| Windows installer (`-setup`)   | Installs. There is no portable build                                                     |
| Linux AppImage                 | Installs by replacing its file if the AppImage's folder is writable; tells if not        |
| Linux `.deb` and `.rpm`        | Installs through the package manager with `pkexec`, which asks for the person's password |
| A release whose install failed | Tells of that release only; newer ones install                                           |
| Local and pull request builds  | No checks: they carry version 0.0.0                                                      |
| Development runs               | No checks                                                                                |

`NOVADECK_UPDATES=off` turns checks off for a launch. The smoke tests and the release
workflow's package checks set it, so they never reach the network.

Squirrel.Mac refuses to install into an app that is not Developer ID signed, so a macOS
build checks its own signature once at launch with `codesign`. See
[release-signing.md](release-signing.md).

### Installing and telling

- **Installing** builds download in the background. The update is offered to the page as
  `ready` once downloaded (on macOS, once Squirrel has staged it) and installs on the next
  quit or when the person restarts.
- **Telling** builds download nothing and keep checking, so a newer release replaces the
  offer. The offer is `available`, and the page's button opens the release page,
  `https://github.com/<owner>/<repo>/releases/tag/v<version>`, in the browser.
- **Notes** are shown only when the update information names the offered release (its
  release name, "Novadeck v<version>", ends in the version). When the promoted tag is not in
  the releases feed electron-updater falls back to the newest entry, whose notes belong to
  another version, and the offer carries none.
- A quit caused by the system shutting down or the session ending installs nothing, as the
  system may kill the installer halfway. On macOS Squirrel.Mac installs a staged update on
  any exit; it swaps the bundle whole, so an interrupted install leaves the old app.

### Install failures

Only an error raised while installing counts as a failed install: one raised after the
updater's `install` (the quit-time install) or `quitAndInstall` (a restart) was called, which
the host wraps to know, and on macOS one raised while Squirrel stages the download. The
person dismissed the `pkexec` prompt, no polkit agent was running, or the folder turned
read-only, say. Any other error, such as a check still in flight failing offline after
the download, is only logged. The host then switches installing on quit off, so the same
prompt does not come back at every quit; writes the version whose install failed (the
offered one, not the running one) to `update.json`; and re-offers the update as `available`.
From the next launch that release is only told of: the updater never downloads on its own,
the host asks for each download, and leaves out the release the mark names, which is offered
as `available`. A newer release installs as usual and the mark, being for the older one,
is ignored. The comparison is in `checkForUpdates` (`failedVersion`), where it is tested. Every write to `update.json` is synchronous and goes through a
temporary file that is renamed over, re-reading the file first, so the failure mark, which
is written as the app exits, cannot race another change.

Restarting saves every page and ends the shells before the updater installs. If the
updater returns without ending the app, the app quits after 10 seconds (30 on macOS) rather
than go on running without its shells. A deb or rpm install blocks the app on the password
prompt, and that wait starts only once it returns.

### Quitting by a signal on Linux

Electron 44 on Linux turns SIGTERM, SIGINT and SIGHUP into an ordinary quit: `before-quit`,
`will-quit` and `quit` with exit code 0, even when the main process has its own
`process.on("SIGTERM")` handler, which never runs. electron-updater installs on such a quit,
so a desktop logout or `kill` would show a `pkexec` prompt in the middle of ending the
session, or kill an AppImage swap halfway. The host tells the orderly quits, the person's,
from signals by marking them before they begin:

- Closing the last window.
- Restarting into the update.
- Ctrl+Q and File > Quit. Electron's default menu is present on Linux even with the menu
  bar hidden, and its Quit is a role that cannot be told from a signal, so the host sets
  the same menu (File, Edit, View and Window) with a Quit of its own on the same
  accelerator (`menu.ts`). Checked under Electron 44 with xvfb: a synthetic Ctrl+Q key
  event sent to an otherwise empty page reaches that item's handler although the bar is
  hidden. Not tested with a terminal focused: xterm.js may consume Ctrl+Q (it sends XON to
  the shell), in which case the accelerator does not fire and File > Quit from the menu bar
  (Alt) or closing the window is the way.

The app has no tray and no page command that quits. A `before-quit` without the mark, which
is what a signal gives, switches installing on quit off.

### Linux package types

A deb installs with one privileged command, `apt-get -o DPkg::Lock::Timeout=60 install -y <file>` (`dpkg -i` where
there is no apt-get), run through electron-updater's `pkexec`/`sudo` helper by a subclass of
its `DebUpdater` (`package-updaters.ts`). electron-updater's own install runs `dpkg -i` and,
when that fails, `apt-get install -f -y`: a dismissed prompt then shows a second one, and
approving it installs nothing from the file yet succeeds, so the app relaunched into the old
version and offered the same download again. The subclass fails on a non-zero exit and,
after the command, compares the version `dpkg-query` reports for `novadeck` with the
offered one, treating a mismatch as a failure. The lock timeout makes apt wait up to a
minute for unattended-upgrades or PackageKit (apt before 1.9.11 ignores it). A lock that
outlasts it still counts as a failed install and marks the release tell-only: apt exits
100 for that and for other apt errors, and telling them apart would take its message. The rpm uses electron-updater's `RpmUpdater`
unchanged: it runs one command, and `spawnSync` raises on a non-zero exit, but the
installed version is not checked.

The host builds its updater itself rather than take electron-updater's `autoUpdater`, which
picks a class from `resources/package-type`, a file electron-builder writes into the deb and
rpm. A build is an AppImage when `APPIMAGE` is set and the running executable lies inside
`APPDIR`. Otherwise `package-type` (`deb` or `rpm`) decides. Shells inside an AppImage
inherit `APPIMAGE`, so a deb started from one is told apart by its executable, and a
`package-type` that leaked into an AppImage cannot make it a deb.

## Moving to Applications

On a packaged macOS launch from outside the Applications folder, before any window or the
runner starts, the app asks once per launch whether to move there, because it can only
update itself from Applications; only a Developer ID signed build is asked, as an unsigned
one only tells of updates. The signature (`codesign`) is checked only once nothing else rules
the offer out (already in Applications, declined), so most launches do not wait for it, and
the check is shared with the update plan. "Move to Applications" calls
`app.moveToApplicationsFolder()` and the app starts again from there; "Not Now" carries on
and asks again next launch. Ticking "Don't ask again" is kept in `update.json` whichever
button is pressed. A copy already in Applications is replaced unless it is running or its `Info.plist`
version is newer than this app's, in which case the move is cancelled and the person is told a newer
Novadeck is already in Applications, with the choice of starting that one (the app relaunches into the
copy's executable and this launch ends; if the executable is missing it carries on here) or
carrying on here. Builds
with version 0.0.0, development runs and `NOVADECK_UPDATES=off` never ask. The decision is
a pure function in `applications-folder.ts`.

## The page's view

`DesktopBridge` in `application/protocol/src/bridge.ts` carries `onUpdate` (an
`UpdateOffer` with `kind`, `version` and `notes`), `installUpdate`, `openUpdatePage`,
`updateChannel` and `setUpdateChannel`. Release notes arrive from GitHub as HTML; the host
turns them into plain-text lines (one per list item or paragraph, tags, entities and
control characters stripped, at most `updateNotesLength` lines of `updateNoteLength`
characters). The preload checks every offer again before the page sees it. Requests count
only from the main frame of the app's own page.

## Release assets

Every release uploads these assets, and each `latest*.yml` entry's `url` must name an
uploaded asset exactly:

| Asset                                              | Used by                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `novadeck-mac-universal.dmg`                       | Downloads from the website                      |
| `novadeck-mac-universal.zip`                       | macOS updates (Squirrel.Mac)                    |
| `novadeck-win-x64-setup.exe`                       | The Windows installer and its updates           |
| `novadeck-linux-x86_64.AppImage`                   | The AppImage and its updates                    |
| `novadeck-linux-amd64.deb`                         | The deb and its updates                         |
| `novadeck-linux-x86_64.rpm`                        | The rpm and its updates                         |
| `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | Update metadata, with each package's SHA-512    |
| `*.blockmap`                                       | Differential downloads of the installer and zip |
| `install.sh`                                       | The Linux install script                        |

`latest-linux.yml` must list the AppImage, the deb and the rpm: the deb and rpm updaters
look for their own extension in it. The AppImage needs libfuse2, which `install.sh` hints
at when it is missing. The workflow must not change a package after builder wrote it, as
the metadata carries its checksum.

Names carry no version. For the AppImage that is deliberate: electron-updater renames the
file on update when its name carries one, which would break whatever launches it. For the
installer and zip, differential downloads derive the previous version's block map by
replacing the new version with the old one in the download path, which holds the tag
(`.../download/v1.2.3/novadeck-win-x64-setup.exe`), so the versionless name still maps to
`.../download/v1.2.2/novadeck-win-x64-setup.exe.blockmap`. Once an update has been
installed the block map is cached, and a failed differential download falls back to a
full one.

## Known limits

- **A channel switch does not cancel work in progress.** An `early` build that is already
  downloading a prerelease when the person switches to `stable` finishes the download and
  installs it on quit. The same switch made during an in-flight check can use the old
  channel's answer; the next check, within four hours, corrects it.
- **Offers are not retracted.** After switching from `early` to `stable`, an `available`
  offer for an early-only release stays until a later check offers another version; the
  bridge has no way to withdraw one. A downloaded update stays `ready` as well.
- **Windows installs are not watched past the call.** The NSIS installer is started
  asynchronously as the app exits, so an error there is not seen by the app.
