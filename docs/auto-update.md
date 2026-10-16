# Auto-update

Every Novadeck build either updates itself or tells the person that a newer release
exists and where to get it. Installed apps look on GitHub Releases shortly after launch
and every four hours. The app never restarts on its own, and the page has no restart
button: a downloaded update installs when the app next quits, and the page shows only a
progress bar while it downloads.

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
  then shows "Update ready" on a floating bar above the footer for a few seconds before it
  fades; the update installs on the next quit. The bar shows
  the progress meanwhile; it has nothing to press and never takes focus. A `ready` offer
  the page did not see downloading, as at a launch, shows nothing. One download
  is tracked at a time, and a release found while it is under way waits for the next check.
- **A failed download** is tried again by a check five minutes later, once per release in a
  run; after that the four-hourly checks try it. Once its progress (or an update it
  replaces) was offered, it is offered as `retrying` meanwhile, and the page drops the
  bar at once and shows nothing in its place: no chip either, since a copy that installs itself
  has nothing for the person to do, and the retry tries again. One that failed before any progress, with no
  update waiting, goes untold, as a failed check does. Should the early retry fail too, the
  offer turns to `available`, so a copy whose downloads keep failing (a proxy, a full disk)
  shows the chip rather than fall behind unseen; the four-hourly checks still try it, and a
  download that gets going turns it back to `downloading`. A failed staging on macOS is an
  install failure: the version is marked failed, is not tried again, and the offer turns to
  `available`, for the person to fetch.
- **A newer release** found while an update waits replaces it, so one quit lands on the
  latest release rather than one per release missed. No release file carries a
  version in its name (`electron-builder.yml`), so electron-updater downloads the newer one
  beside the waiting file and renames it over that file once complete; a quit meanwhile
  installs the waiting update on Windows and Linux. The offer turns from `ready` into
  `downloading` the newer release as its progress comes in, so the page shows the bar
  again. Should the download fail, electron-updater clears its download
  folder, which likely takes the waiting file too: the newer release is offered as
  `retrying` until the retry downloads it. Quitting ends the schedule first,
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
  offer. The offer is `available`: the person must fetch the release themselves. `available`
  means that and nothing else (a tell-mode build, a portable copy, an install that failed, or a
  download whose early retry failed too), and the footer chip is for it; a failed download
  that will be retried (`retrying`) shows nothing. An installed
  copy shows a quiet "Update available" chip in the footer (no panel or Later) whose press opens the release page,
  `https://github.com/<owner>/<repo>/releases/tag/v<version>`, in the browser. A portable
  copy has its install entry instead.
- A quit caused by the system shutting down or the session ending installs nothing, as the
  system may kill the installer halfway. On macOS Squirrel.Mac installs a staged update on
  any exit; it swaps the bundle whole, so an interrupted install leaves the old app.

### Install failures

Only an error raised while installing counts as a failed install: one raised after the
updater's `install` (the quit-time install) was called, which the host wraps to know, and on macOS one raised while Squirrel stages the download. The
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

### Quitting by a signal on Linux

Electron 44 on Linux turns SIGTERM, SIGINT and SIGHUP into an ordinary quit: `before-quit`,
`will-quit` and `quit` with exit code 0, even when the main process has its own
`process.on("SIGTERM")` handler, which never runs. electron-updater installs on such a quit,
so a desktop logout or `kill` could kill an AppImage swap halfway. The host tells the orderly quits, the person's,
from signals by marking them before they begin:

- Closing the last window.
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
exists. electron-updater's `releaseDate` is the build time, which `promote.yml` does not rewrite, so it is not used for any staleness. `DesktopBridge.portable` tells the
page whether the copy is portable, with `run`, a name that is new at each launch of the app.
The page raises its corner card by itself once per run, with or without a release, and keeps
that run in local storage, so a window closed and opened again within one run (macOS keeps the
app running with no window) is not taken for a launch and the card does not come back by
itself; the footer chip reopens it. `installApp` installs from the
copy (`portable.ts`; `install-linux.ts` on Linux, `applications-folder.ts` on macOS,
`install-windows.ts` on Windows) while this copy keeps running. Novadeck never restarts
itself for the person: the answer is `installed`, the page says the installed copy "takes
effect after you restart Novadeck", and nothing is quit, started or handed off. While it
works the host sends `InstallProgress` to the app's pages (`onInstallProgress`): `installing`
on every system, and on Windows whole-percent `downloading` before it. `PortableState.installed`
is true once this run installed, or found a newer copy already installed, and a second request answers the same without installing
again. On Linux:

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
- It starts nothing and shuts nothing down: this copy keeps running.
- An installed copy newer than the portable one is never overwritten. The answer is `newer`
  (nothing is written, and the end state is the same as `installed`). An installed copy's version is
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
    an earlier build's, which the runner sets aside and replaces with a new one; so the version must rise
    for any change but an added column (an added table, index or constraint goes unseen). A
    newer build that adds a column and changes another without raising the version is still
    taken for an earlier build's.
- A failure, such as a full disk or a folder that cannot be written, is returned with a short
  reason, as is a request while the app is already quitting ("Novadeck is quitting.").

On macOS the install is `installBundle` in `applications-folder.ts`, not Electron's
`app.moveToApplicationsFolder()`, which always quits and relaunches the app. The target is the
first installed copy found (`/Applications` first, then `~/Applications`, by `Info.plist`
version, at the launch and before an install; one whose plist cannot be read is not
replaced), else `/Applications/novadeck.app` where the person can write to `/Applications`,
else `~/Applications/novadeck.app` (the folder is made). A new copy always has the packaged
name, `novadeck.app` (the executable's name plus `.app`), whatever the running bundle was
renamed to. The running bundle is copied with `/usr/bin/ditto` into a hidden folder beside
the target (`.novadeck.app.new`), and `/usr/bin/xattr -dr com.apple.quarantine` clears the
quarantine attribute on that copy. This is required: a quarantined bundle is translocated on
its first launch, and the installed copy would then take itself for a portable one. The
swap renames the old copy aside (`.novadeck.app.old`), renames the new one into place, and
removes the old one; should the second rename fail, the old copy is put back. A copy the
person cannot write to belongs to another account, and nothing is written: "Novadeck in
Applications belongs to another account on this Mac. Remove it and try again." The portable
bundle is left where it is, and nothing is renamed for the person. An installed copy newer
than this one is not replaced: the answer is `newer`. One of the same version, or this very bundle, is left alone (a translocated copy of the one in Applications runs from another path, so it is the same-version check that catches it) and the answer is `installed`. On macOS 13 and later, replacing an existing copy in `/Applications` may need the person's consent (App Management) when the copy was installed by another app or the build is unsigned or ad hoc: the swap then fails with EPERM, and the reason says plainly that macOS didn't allow replacing the installed Novadeck. Manual check: install over an older `/Applications/novadeck.app` with an unsigned build, with App Management denied and allowed. An install interrupted by a quit, or a
rollback that itself failed, can leave the only installed copy renamed aside, or a large
half-made copy; `recoverBundles` runs before each install and at the launch of a portable
copy, in both Applications folders: it restores an aside whose copy is missing, and removes
a stale half-made copy and an aside beside a copy that is there, for the packaged name and the name of a renamed installed copy. Uninstalling on macOS removes such leftovers beside the copy it trashes, so a later launch cannot restore an uninstalled copy.
Unsigned builds are portable too: Gatekeeper on macOS 15 and later makes them rough to
open, and the installed copy only tells of updates until the app is signed. (Clearing the
quarantine attribute applies to the copy this app makes of itself, not to a download.)

Known limits. AppImageLauncher keeps the AppImage's own file name when it integrates a file
into `~/Applications`, so such a copy is not at an installed place and counts as portable. An
`XDG_DATA_HOME` set only in a shell's rc file is not seen by a copy started from the menu, which
can make an installed copy look portable.

Both copies keep their data in the same folder, so the installed app opens where the portable
left off. An older runner refuses a database a newer one has upgraded.

### The launch redirect

At launch, before the runner starts, a portable copy looks for an installed copy of the same
version or a newer one (`leaveForNewerInstalled`, with `currentOrNewerCopy` in
`install-linux.ts`). If there is one, it is started in place of this launch, without asking:
the person opened Novadeck, and the installed copy is the one they keep. One that is older,
cannot be checked, or is absent lets the launch carry on; so does a failure to list the
copies. If the installed copy will not start and is the same version, the failure is logged
and the launch carries on in the portable copy, which can open the same workspace; if it is
newer, a dialog says it did not start and the app quits, since this copy might not open the
data the newer one upgraded. A same-version redirect writes `redirected-at` in the data folder first, and the installed copy clears it as it starts (`redirectMarker`); a launch within 30
seconds of it that the installed copy never answered carries on in the portable copy instead, so an installed copy the system starts
and ends at once (a quarantined or damaged bundle) cannot make every launch open nothing. A
newer copy is never skipped this way. The lock is let go before the installed copy is
spawned, since the child must take it, and taken back (`requestSingleInstanceLock`) when the
start fails; if another process holds it by then, this one ends. The runner's
`WORKSPACE_TOO_NEW` refusal stays the fallback. Starting
is per system: on Linux `startAppImage` lets go of the single-instance lock and spawns the
image as a detached child through `/bin/bash -c`, which closes every descriptor above 2
(Chromium leaves about seventy open to a child, files in the portable's FUSE mount among
them) and `exec`s the image, with an environment lacking `APPIMAGE`, `APPDIR`, `OWD` and
`ARGV0` and the path-list entries under the portable's mount (`app.relaunch` is not used on
Linux: its child inherits no-new-privileges, which stops the AppImage runtime mounting); on
macOS `relaunchIntoCopy` relaunches into the installed bundle's executable; on Windows
`startDetached` spawns its executable after letting go of the lock.

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
  one is never overwritten: the answer is `newer`, and at launch the portable gives way to it
  (see "The launch redirect").
- **Install.** First two refusals, before anything is downloaded. The copy may not run from
  the install folder (the recorded `InstallLocation` or the default one, compared as a
  case-insensitive path prefix, so a sibling such as `novadeck-portable` counts too;
  `insideInstallFolder`), since the setup replaces what is there: `failed`, "Novadeck can't install
  while this copy runs from a folder whose name starts with <folder>. Move this copy somewhere
  else, like Downloads, and try again." And PowerShell must be able to do the installer's running-app
  check (below): `failed`, "Novadeck can't install itself while it runs on this PC. Quit
  Novadeck, then run the installer from the Releases page." Then, while the app runs
  normally, it downloads `latest.yml` and
  `novadeck-win-x64-setup.exe` from `releases/latest/download/` of the repository
  `app-update.yml` names, through Electron's `net.fetch` (so the system and PAC proxy are honoured
  as the update check does, and the file carries no Mark of the Web), into
  `%TEMP%\novadeck-setup`, emptied first, with whole-percent progress against the `size`
  `latest.yml` lists for the setup, or the response's `Content-Length`. A download is given up after 60 seconds without data,
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
  `failed` with a short reason and changes nothing. Only then is the setup `spawn`ed detached
  with `/S` alone (never `shell.openPath`, which goes through SmartScreen), while this copy
  keeps running, holds its lock and exits nothing. There is no `--force-run`, so the setup
  starts nothing when done; `--updated` is left off too. The host waits for the setup to exit,
  up to five minutes (it is not killed at the timeout; if no copy is found then, the answer is
  "The installer is still running. Try again in a few minutes.", and a retry that cannot clear
  the locked setup folder says the same), and then trusts nothing about how it
  ended: `findInstalledWindows` must find a copy of the release's version or newer with its
  executable, and only then is the answer `installed`; otherwise `failed`. The setup folder is
  deleted afterwards. If Windows refuses to start the setup, the answer is `failed`.
- **The installer's running-app check.** electron-builder's NSIS template
  (`include/allowOnlyOneInstallerInstance.nsh`, `_CHECK_APP_RUNNING`, run at the start of the
  install section) looks for running copies of `novadeck.exe`: with PowerShell available, only
  processes whose path starts with the install folder; otherwise (`tasklist`) every
  `novadeck.exe` of the current user, which would include this portable copy, and the
  fallback would stop it. A copy found is asked to close, with the message box answered "OK"
  in a silent run, then stopped with `Stop-Process` on the PowerShell path (`taskkill` on the
  fallback), forced after a second. So the host first runs the installer's own availability
  test (`IS_POWERSHELL_AVAILABLE`: `Get-CimInstance` exists, and the Process-scope execution
  policy is not `Restricted`; `powershellUsable`), with the 32-bit `SysWOW64` PowerShell when
  present, since the NSIS stub is 32-bit, and refuses to install where it fails. With
  PowerShell available, the check stops processes whose path starts with the install folder:
  a plain case-insensitive prefix (`StartsWith($INSTDIR, CurrentCultureIgnoreCase)`), with
  no separator after it. The host mirrors that exactly (`insideInstallFolder`), so a portable
  copy in a sibling such as `...\Programs\novadeck-portable` is refused too; one anywhere
  else is ignored. The
  single-instance lock excludes a running installed copy, so the check kills nothing of the
  person's. Residual risks: the installer runs its own PowerShell check again when it starts; if that fails transiently after the host's probe passed, it falls back to stopping every `novadeck.exe` by name (`taskkill`), which would close the portable copy. And the setup also stops any process running from the install folder,
  such as an older installed copy's relay, which the person might notice.
- **Limits.** Only a real Windows run proves this end to end. Smart App Control blocks an
  unsigned installer and, once signing is in place, SmartScreen may still warn about a fresh
  publisher; see [release-signing.md](release-signing.md). The block happens when the setup is
  started; this copy is still running, so the answer is `failed` and nothing else changes. A
  silent setup that fails midway (a locked file, a full disk) is caught by the check of what
  it left, not by its exit.

## One instance per data folder

The host takes Electron's single-instance lock at startup. Chromium keys it on the data
folder (`userData`), not on the executable, so a portable and an installed copy exclude each
other. A second launch quits at once, before it starts anything, and the running window comes
to the front, or opens one on macOS, where the app lives on with no window. So after a
portable copy installs, the installed copy cannot run beside it: opening Novadeck brings the
portable window forward until the person quits it, and the next open is the installed copy.
The launch redirect is the exception: at that point nothing has started, and it lets go of
the lock before the installed copy starts (`releaseLock`), so it can take it.

The packaged smoke test (`smoke.mjs`) and the Linux sandbox check in `release.yml` pass
`--user-data-dir`, so each gets its own lock. The other smoke launches share the default
folder, so each is stopped before the next starts. The Linux ones, which `timeout` stops
through `xvfb-run`, then wait up to 15 seconds for the process named by the folder's
`SingletonLock` to be gone, and fail if it is not, as the next launch would otherwise hand
off to it and exit. The macOS ones kill their process and wait for it, and the Windows ones
kill the process tree and wait.

## The page's view

`DesktopBridge` in `application/protocol/src/bridge.ts` carries `onUpdate` (an
`UpdateOffer` with `kind` (`downloading`, `ready`, `retrying` or `available`), `version` and, for `downloading`, a whole `percent`), `openUpdatePage`,
`updateChannel` and `setUpdateChannel`. The app shows no release notes. `onPortableState`
pushes the `PortableState` to every window when it changes: an install answering
`installed` or `newer` sets `installed` for the rest of the run. The preload checks every offer again before the page sees it. Requests count
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
- **Windows updates are not watched past the call.** An installed copy's update runs the
  NSIS installer asynchronously as the app exits, so an error there is not seen by the app.
  (A portable copy's install is watched: see Portable builds.)
