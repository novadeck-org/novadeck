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
host names a repository: the release page and the voice and murmur engine downloads read
the same validated owner and repository from that file (`update-release.ts`).

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
passes it. A downloaded update that waits is replaced by the release the new channel offers
when that is newer than the running build, as any newer release replaces it (see "Installing
and telling"): switching from `early` to `stable` with a prerelease waiting installs the
stable release, even one older than that prerelease. On macOS the schedule ends once an
update has downloaded, so a switch then applies from the next launch.

electron-updater decides the release in `GitHubProvider.getLatestVersion`. With
`allowPrerelease` false it asks `/releases/latest`, which GitHub answers with the latest
non-prerelease (a 404 when there is none); with it true it takes the newest entry of the
releases feed. `stable` sets it false and `early` true.

## Which builds update

| Build                            | Mode                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| macOS, in Applications, signed   | Installs (Squirrel.Mac)                                                           |
| macOS, in Applications, unsigned | Tells; every build is unsigned until the certificates are in place                |
| macOS, outside Applications      | Tells, signed or not; never installs itself. See "Portable builds"                |
| Windows installer (`-setup`)     | Installs                                                                          |
| Windows ZIP (unpacked app)       | Tells; never installs itself. See "Portable builds"                               |
| Linux AppImage, installed        | Installs by replacing its file if the AppImage's folder is writable; tells if not |
| Linux AppImage, portable         | Tells; never installs itself. See "Portable builds"                               |
| Any other Linux build            | No checks: Linux ships only the AppImage                                          |
| A release whose install failed   | Tells of that release only; newer ones install                                    |
| Local and pull request builds    | No checks: they carry version 0.0.0                                               |
| Development runs                 | No checks                                                                         |

`NOVADECK_UPDATES=off` turns checks off for a launch. The smoke tests and the release
workflow's package checks set it, so they never reach the network.

Squirrel.Mac refuses to install into an app that is not Developer ID signed, so a macOS
build checks its own signature once at launch with `codesign`. See
[release-signing.md](release-signing.md).

### Installing and telling

- **Installing** builds download in the background and show it. The update is offered to
  the page as `downloading` at each whole percent electron-updater reports
  (`download-progress`), from the first; only the progress of the download the host started
  counts. A download already on disk from an earlier launch reports none and is `ready` at
  once, without a flash of progress. It becomes `ready` once downloaded (on macOS, once
  Squirrel has staged it, with the percent staying where it was until then), and the page
  then raises the notice with Restart now; the update installs on the next quit or when the
  person restarts. The chip shows the progress meanwhile and raises no notice. One download
  is tracked at a time, and a release found while it is under way waits for the next check.
- **A failed download** is tried again by a check five minutes later, once per release in a
  run; after that the four-hourly checks try it. Once its progress (or an update it
  replaces) was offered, it is offered as `available` meanwhile, and the chip reads Update
  available. The page raises no notice for a download that turned `available` straight
  from its progress; it does when a newer release failed before any progress in place of
  a ready one, as the update waiting is gone, and after a reload. One that failed before
  any progress, with no update waiting, goes untold, as a failed check does. A failed
  staging on macOS (an install failure) turns the chip to Update available the same way,
  quietly; the next launch tells of it with a notice.
- **A newer release** found while an update waits replaces it, so one restart lands on the
  latest release rather than one restart per release missed. No release file carries a
  version in its name (`electron-builder.yml`), so electron-updater downloads the newer one
  beside the waiting file and renames it over that file once complete; a quit meanwhile
  installs the waiting update on Windows and Linux. The offer turns from `ready` into
  `downloading` the newer release as its progress comes in, so the page shows it and offers
  no restart until it is in. A restart asked for in the moment before its progress came in
  shows the download instead of going ahead later. Should the download fail, electron-updater clears its download
  folder, which likely takes the waiting file too: the newer release is offered as
  `available` until the retry downloads it. Quitting and restarting end the schedule first,
  so no new download starts on the way out; one under way goes on, and a quit after it
  lands installs the newer release. On Windows the newer one costs its changed ranges and
  then the whole file, and its percent starts over once: electron-updater's differential
  download pairs the waiting update's blockmap with the installed build's installer, the
  result fails its checksum, and it falls back to a full download. macOS keeps the update
  Squirrel staged and checks again at the next launch, as staging one update over another
  is untried. `updater.test.ts` pins the file names and electron-updater's handling of the
  waiting file: were the folder emptied while the updater still names the file, quitting
  would delete the running AppImage and install nothing.
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
AppImage's folder turned read-only, say. Any other error, such as a check still in flight failing offline after
the download, is only logged. The host then switches installing on quit off, so the same
failure does not come back at every quit; writes the version whose install failed (the
offered one, not the running one) to `update.json`; and re-offers the update as `available`.
From the next launch that release is only told of: the updater never downloads on its own,
the host asks for each download, and leaves out the release the mark names, which is offered
as `available`. A newer release installs as usual and the mark, being for the older one,
is ignored. The comparison is in `checkForUpdates` (`failedVersion`), where it is tested. Every write to `update.json` is synchronous and goes through a
temporary file that is renamed over, re-reading the file first, so the failure mark, which
is written as the app exits, cannot race another change.

Restarting saves every page and ends the shells before the updater installs. If the
updater returns without ending the app, the app quits after 10 seconds (30 on macOS) rather
than go on running without its shells. On Linux electron-updater starts the new AppImage
first and quits this process after, so the restart lets go of the single-instance lock just
before quitting, when the updater emits `before-quit-for-update` on Electron's `autoUpdater`,
which it does only once the install went ahead. The new version, which needs a second or more
to ask for the lock, can then take it. After a quiet failure the lock stays held.

### Quitting by a signal on Linux

Electron 44 on Linux turns SIGTERM, SIGINT and SIGHUP into an ordinary quit: `before-quit`,
`will-quit` and `quit` with exit code 0, even when the main process has its own
`process.on("SIGTERM")` handler, which never runs. electron-updater installs on such a quit,
so a desktop logout or `kill` could kill an AppImage swap halfway. The host tells the orderly quits, the person's,
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

### Linux builds

The host builds its updater itself rather than take electron-updater's `autoUpdater`. A
Linux build is an AppImage when `APPIMAGE` is set and the running executable lies inside
`APPDIR`; shells inside an AppImage inherit `APPIMAGE`, so a program started from one is told
apart by its executable. Any other packaged Linux build never checks: Linux ships only the
AppImage.

## Portable builds

A portable build runs from wherever it was put and is not meant to last: it leads the person
to the installed app, which updates itself. On Linux it is an AppImage anywhere but the two
places the installer puts it, `${XDG_DATA_HOME:-~/.local/share}/novadeck/novadeck.AppImage`
(a relative `XDG_DATA_HOME` counts as unset) and Homebrew's `~/Applications/novadeck.AppImage`;
paths are compared by their canonical form, so a link to an install counts as installed
(`install-location.ts`, shared with the sandbox fix). An AppImage run from Downloads therefore
no longer replaces its own file, as it once did in any writable folder. On macOS it is the
packaged app anywhere but an Applications folder (Electron's `app.isInApplicationsFolder()`
is false: Downloads, a translocated copy, the mounted disk image), signed or not. On Windows it
is the unpacked ZIP: a copy the NSIS installer did not make (see "Windows" below). A build that looks for no updates
(version 0.0.0, a development run, `NOVADECK_UPDATES=off`) is never portable, on any system.

A portable build still looks for releases, in `tell` mode, so it learns that a newer one
exists. Its offer carries `outdatedSince`, when this copy first learned that a newer release
exists. The host keeps it in `update.json` for the running version and starts over when that
version changes, so a newer release does not reset it. A check that finds no newer release
(`update-not-available`) clears the mark, so a copy that was behind on `early` and is current on
`stable` starts a fresh clock when `stable` later moves. electron-updater's `releaseDate` is
the build time, which `promote.yml` does not rewrite, so it is not used. The page raises the
update notice at every launch once that is 14 days ago. `DesktopBridge.portable` tells the
page whether the copy is portable, with `run`, a name that is new at each launch of the app.
The page keeps the offer whose notice it showed together with that run in local storage, so a
window closed and opened again within one run (macOS keeps the app running with no window) is
not taken for a launch and the reminder does not come back. `installApp` installs from the
copy (`portable.ts`; `install-linux.ts` on Linux, `applications-folder.ts` on macOS). On
Linux:

- It installs from the running file, with no download: the AppImage is copied beside the
  install path as `.new` and renamed over it, so a failed copy leaves nothing half-written
  (a quit in the middle of the copy can leave `<image>.new` behind, which the next install
  overwrites)
  and nothing else changed. Only then is the icon extracted with `--appimage-extract` (no FUSE
  needed); `~/.local/bin/novadeck` linked to the image; and the menu entry
  `dev.mzpk.novadeck.desktop` written, as `scripts/install/install.sh` does, with the same
  `Exec` quoting. Over an installed copy elsewhere, such as Homebrew's, it writes the file
  alone; when that place is a symlink, as Homebrew's into the Caskroom is, it replaces the file
  the link leads to and keeps the link. The AppArmor profile that turns the sandbox on still
  needs the installer's `--sandbox` step, with `sudo`.
- It then shuts down as an update does, so pages save and the runner ends its shells, lets go
  of the single-instance lock, and starts the installed AppImage as a detached child process
  (`child_process.spawn`, then `unref`) with no arguments of its own, since the portable's may
  carry `--no-sandbox`. Electron's `app.relaunch` is not used on Linux: the process it starts
  inherits no-new-privileges, so the AppImage runtime's setuid `fusermount` cannot mount the
  image and the child dies at once.
  - The child starts through `/bin/bash -c`, which closes every descriptor above 2 and then
    `exec`s the image. Chromium leaves about seventy open to a child, files inside the
    portable's FUSE mount among them, which would keep that mount and its `/tmp/.mount_*`
    alive for as long as the installed app runs. Bash is needed, as dash cannot name
    descriptors above 9; without bash at `/bin` or `/usr/bin` the image is spawned directly.
  - Its environment lacks `APPIMAGE`, `APPDIR`, `OWD` and `ARGV0`, which are the portable's,
    and every entry of `PATH`, `LD_LIBRARY_PATH`, `XDG_DATA_DIRS` and `GSETTINGS_SCHEMA_DIR`
    that is or lies under the portable's mount (`APPDIR`, as named and as resolved), which
    AppRun prefixed. Otherwise something planted at that path after the mount goes away would
    be searched first. A list left empty is dropped.
  - A file that is missing or lacks the exec bit is refused before anything is released; a
    failed spawn is caught too. Either way the shells are already gone, so a dialog names the
    path ("The installed Novadeck did not start") and the app quits. It also quits if it is
    somehow still running ten seconds after the installed copy started, or if the person quit
    while the copy was being made (then the installed copy is not started and the answer is
    `failed`, "Novadeck is quitting.").
- An installed copy newer than the portable one is never overwritten. The answer is `newer`,
  and `openInstalled` starts that copy after the same shutdown. An installed copy's version is
  read from `X-AppImage-Version` in the menu entry electron-builder writes into the AppImage.
  This does execute the installed file's own AppImage runtime, as `install-linux.ts` runs
  `<file> --appimage-extract '*.desktop'` in a temporary folder with a 20 second limit; that
  unpacks the entry and starts no app. The result has three cases:
  - The version is read.
  - The file has no version, and is replaced: its first bytes are not an ELF header with the
    AppImage marker `AI\x02` at bytes 8 to 10 (the host reads them itself), the system says
    it is no program (`ENOEXEC`), or the runtime ran (exit 0) and found no menu entry or
    version.
  - It could not be checked, and is never overwritten: the install answers `failed` with a
    short reason. This covers a non-zero exit of the runtime, which is the environment's
    doing (for instance `mkdir_p error: Permission denied` in an unwritable or full temporary
    folder), a missing temporary folder, a timeout, a missing exec bit, an unreadable file,
    and any other failure.
  - At launch an unchecked copy is ignored, so a non-executable installed file, which cannot
    be version-checked, lets the launch carry on; the runner's `WORKSPACE_TOO_NEW` refusal is
    the fallback if that copy had upgraded the data. The runner refuses a database whose
    schema version is higher than its own, or, at its own version, one where no table lacks a
    column it writes and some table has more, as a newer build can add a column without
    raising the version. A database of a lower version, or one lacking a column anywhere, is
    an earlier build's, which the runner asks the person to delete; so the version must rise
    for any change but an added column (an added table, index or constraint goes unseen). A
    newer build that adds a column and changes another without raising the version is still
    taken for an earlier build's.
- A failure, such as a full disk or a folder that cannot be written, is returned with a short
  reason, as is a request while the app is already quitting ("Novadeck is quitting.").

On macOS the install is Electron's `app.moveToApplicationsFolder()`, which the host calls
without a shutdown first (`moveToApplications` in `applications-folder.ts`). In Electron's
source (`shell/browser/ui/cocoa/electron_bundle_mover.mm`) a successful call has copied
the bundle to `/Applications` (asking for authorization when the folder is not writable),
deleted the original (`DeleteOrTrash` removes it outright and trashes it only where removal
fails, so a read-only translocated copy stays; a copy on a disk image is never deleted, and
the image is unmounted after five seconds), started a shell script that waits for this process to end, clears the
quarantine attribute of the copy and opens it, and called `Browser::Quit()` itself, all
before it returns true. That quit is the app's ordinary one: `before-quit` runs the shutdown
(pages save, the runner ends its shells) before the process ends, so nothing is lost, and the
page's answer is `installing`. A quit follows after `installFallbackMs` should the app still
run. The move is made first, not after a shutdown, because it can fail, and then the app and
its shells go on. A failure says why: Electron throws for a failed copy or a refused
authorization, and the message becomes the `failed` reason. A copy already in Applications is
replaced when it is not running, unless its `Info.plist` version is newer than this app's:
then nothing is written and the answer is `newer`, as on Linux. A copy that is running is
left alone and the answer is `failed`; the single-instance lock makes that unlikely, as both
copies share the data folder. The installed copies, `/Applications` first and then
`~/Applications`, are found by their `Info.plist` versions at the launch and before an
install; one whose plist cannot be read is not replaced. Opening a newer installed copy
shuts down the same way and then relaunches into its executable. Electron's move installs
only into `/Applications`, so an older copy kept in `~/Applications` stays beside it.
Electron's move writes only to `/Applications/<the running bundle's name>`. A portable copy
Finder or Archive Utility renamed (`novadeck 2.app`) is still checked against the installed
copy: the guard and the launch check look for the running name and for the packaged one,
`novadeck.app` (the executable's name plus `.app`), in both Applications folders. The move
itself is refused, as `failed` with a reason that says to rename this copy or remove the old
one, when the names differ and `/Applications/novadeck.app` exists, since it would otherwise
install a second copy beside the old one, which stays launchable and never runs the launch
check (`renamedMoveReason`). Nothing is renamed for the person.
Authorization limits: an account that cannot write `/Applications` gets an administrator
prompt, and the install fails (with Electron's message as the reason) if it is cancelled; once
authorized, Electron replaces a copy in `/Applications` that another account owns; a copy in
`~/Applications` is never upgraded by the move.
Unsigned builds are portable too: Gatekeeper on macOS 15 and later makes them rough to
open, and the installed copy only tells of updates until the app is signed.

Known limits. AppImageLauncher keeps the AppImage's own file name when it integrates a file
into `~/Applications`, so such a copy is not at an installed place and counts as portable. An
`XDG_DATA_HOME` set only in a shell's rc file is not seen by a copy started from the menu, which
can make an installed copy look portable.

Both copies keep their data in the same folder, so the installed app opens where the portable
left off. An older runner refuses a database a newer one has upgraded, so when a portable
build starts and finds a newer installed copy it tells the person before the runner starts,
and offers to open that copy or quit.

### Windows

The release carries `novadeck-win-x64.zip`, electron-builder's unpacked app (`win-unpacked`,
zipped after signing, with `novadeck.exe` and `resources\` at its root), beside the per-user
one-click installer `novadeck-win-x64-setup.exe`. The ZIP is not an update source: `latest.yml`
names only the setup, and a ZIP copy does not update itself. Both copies use `%APPDATA%\novadeck`
(the name is `novadeck` in code; Windows ignores case, so this is also `Novadeck`), so installing
keeps the workspace.

- **Detection** (`installedByInstaller` in `install-windows.ts`). Nothing marks the ZIP, so the
  host tells an installed copy instead: it is installed if `Uninstall <executable name>.exe` sits
  beside the running executable (`UNINSTALL_FILENAME` in electron-builder's `common.nsh`, here
  `Uninstall novadeck.exe`, which the ZIP lacks), or if the executable's folder is the
  `InstallLocation` the installer recorded or its default, `%LOCALAPPDATA%\Programs\novadeck`
  (compared without case or a trailing separator). The second test covers an install whose
  uninstaller was deleted. Everything else that looks for updates is portable. The registry is
  asked only when the uninstaller does not settle it. The error to avoid is calling an install
  portable, which would offer to overwrite it; the other way round only withholds the offer.
- **Updates.** A portable Windows copy runs the NSIS updater in `tell` mode, so it only learns
  that a release exists; it never downloads one, and nothing installs on quit. (Left in `install`
  mode it would install a separate copy on quit.)
- **Installed copies** are found from the registry keys the installer writes under the GUID
  electron-builder derives from the app id (UUID v5 of `dev.mzpk.novadeck`; `installerGuid`):
  `HKCU\Software\<guid>` `InstallLocation` and the Uninstall key's `DisplayVersion`, read with
  `reg.exe query` (no native module), plus the default folder. reg.exe writes the OEM code page
  while Node decodes UTF-8, so a profile path with letters outside ASCII reaches the host
  garbled; when the recorded folder holds no executable but the default one does, the
  (ASCII) `DisplayVersion` is trusted for the default folder. A copy whose version is not in
  the record (a missing or unreadable key) is `unchecked` and never replaced; the advice is to
  open the installed Novadeck from the Start menu or uninstall it in Windows Settings. A newer
  one is never overwritten: the answer is `newer`, and at launch the portable offers to open it
  before the runner starts, as on Linux. Opening it spawns its executable detached, after the
  shutdown and after letting go of the single-instance lock.
- **Install.** While the app runs normally, it downloads `latest.yml` and
  `novadeck-win-x64-setup.exe` from `releases/latest/download/` of the repository
  `app-update.yml` names, through Electron's `net.fetch` (so the system and PAC proxy are honoured
  as the update check does, and the file carries no Mark of the Web), into
  `%TEMP%\novadeck-setup`, emptied first. A download is given up after 60 seconds without data,
  not after a fixed time. The installed (non-portable) copy removes that folder a minute after
  launch, best effort. The release used is `latest`, unless it is missing or older than this copy
  (an `early` copy ahead of stable): then this copy's own release,
  `releases/download/v<this version>/`, supplies both files and is not compared, as it is
  never older. `latest` is missing until the first stable release, when its `latest.yml`
  answers 404. A network error or any other status at `latest` does not fall back. Installing the
  copy's own version is fine, but the installed copy then updates itself only once a release on
  its channel is newer: until a stable release is promoted, a default-channel install cannot
  update. The SHA-512 of the file must equal the `sha512` that `latest.yml` lists for it; a missing
  entry, a mismatch (the file is deleted), a network failure, or no usable release answers
  `failed` with a short reason and changes nothing. Only then: the shutdown every platform runs
  (pages save, the runner ends its shells), the single-instance lock is let go, and the setup is
  `spawn`ed detached with `/S --force-run` (never `shell.openPath`, which goes through
  SmartScreen), and this process exits as soon as the child has started. `--force-run` makes the
  installer start the installed app when it is done; `--updated` is left off, as this is not an
  update made from the running app. A fallback quit follows if the process somehow still runs.
  Should Windows refuse to start the setup, a dialog names where it is and the app quits, as the
  shells are gone by then.
- **The installer's running-app check.** electron-builder's NSIS template
  (`include/allowOnlyOneInstallerInstance.nsh`, `_CHECK_APP_RUNNING`, run at the start of the
  install section) looks for running copies of `novadeck.exe`: with PowerShell available, only
  processes whose path starts with the install folder; otherwise (`tasklist`) every
  `novadeck.exe` of the current user. A copy found is asked to close, with the message box
  answered "OK" in a silent run, then stopped with `Stop-Process` on the PowerShell path (`taskkill`
  on the fallback), forced after a second. Without
  `--updated` it adds no wait. The portable runs from another folder, so the PowerShell check
  ignores it; the `tasklist` fallback could match it, which is why the shutdown has finished and
  the process exits at the moment the setup starts: nothing is left to kill but an exiting
  process. The single-instance lock excludes a running installed copy, so the check kills
  nothing of the person's.
- **Limits.** Only a real Windows run proves this end to end. Smart App Control blocks an
  unsigned installer and, once signing is in place, SmartScreen may still warn about a fresh
  publisher; see [release-signing.md](release-signing.md). The block happens when the setup is
  started, which is after the shutdown, so the person is left with a dialog and their saved
  workspace rather than a running app. The setup is not watched
  past the spawn: a silent setup that fails after the portable has exited (a locked file, a full
  disk) leaves nothing running and shows no message.

## One instance per data folder

The host takes Electron's single-instance lock at startup. Chromium keys it on the data
folder (`userData`), not on the executable, so a portable and an installed copy exclude each
other. A second launch quits at once, before it starts anything, and the running window comes
to the front, or opens one on macOS, where the app lives on with no window. A Linux update
restart is the exception: it lets go of the lock just before quitting, so the new version,
which electron-updater starts first, can take it.

The packaged smoke test (`smoke.mjs`) and the Linux sandbox check in `release.yml` pass
`--user-data-dir`, so each gets its own lock. The other smoke launches share the default
folder, so each is stopped before the next starts. The Linux ones, which `timeout` stops
through `xvfb-run`, then wait up to 15 seconds for the process named by the folder's
`SingletonLock` to be gone, and fail if it is not, as the next launch would otherwise hand
off to it and exit. The macOS ones kill their process and wait for it, and the Windows ones
kill the process tree and wait.

## The page's view

`DesktopBridge` in `application/protocol/src/bridge.ts` carries `onUpdate` (an
`UpdateOffer` with `kind`, `version`, `notes` and, for `downloading`, a whole `percent`), `installUpdate`, `openUpdatePage`,
`updateChannel` and `setUpdateChannel`. Release notes arrive from GitHub as HTML; the host
turns them into plain-text lines (one per list item or paragraph, tags, entities and
control characters stripped, at most `updateNotesLength` lines of `updateNoteLength`
characters). The preload checks every offer again before the page sees it. Requests count
only from the main frame of the app's own page.

## Release assets

Every release uploads these assets, and each `latest*.yml` entry's `url` must name an
uploaded asset exactly:

| Asset                                              | Used by                                           |
| -------------------------------------------------- | ------------------------------------------------- |
| `novadeck-mac-universal.dmg`                       | Downloads from the website                        |
| `novadeck-mac-universal.zip`                       | `install.sh` on macOS, and updates (Squirrel.Mac) |
| `novadeck-win-x64-setup.exe`                       | The Windows installer and its updates             |
| `novadeck-win-x64.zip`                             | The portable Windows app; no update source        |
| `novadeck-linux-x86_64.AppImage`                   | The AppImage and its updates                      |
| `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | Update metadata, with each package's SHA-512      |
| `*.blockmap`                                       | Differential downloads of the installer and zip   |
| `install.sh`                                       | The Linux and macOS install script                |

`latest-linux.yml` must list the AppImage. The AppImage is built on the static type2
runtime (`toolsets.appimage` in `electron-builder.yml`), so it needs a setuid
`fusermount3`, or FUSE 2's `fusermount`, and `/dev/fuse`, rather than libfuse2;
`install.sh` names the `fuse3` package when they are missing. The workflow must not change a package after builder wrote it, as
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
  bridge has no way to withdraw one. A downloaded update stays `ready` as well, unless a stable release newer than the running
  build replaces it, and a `downloading` offer is replaced only by its own outcome.
- **Windows installs are not watched past the call.** The NSIS installer is started
  asynchronously as the app exits, so an error there is not seen by the app.
