# Auto-update

Every Novadeck build either updates itself or tells the person that a newer release
exists and where to get it. Installed apps look for one through novadeck.dev, falling back to GitHub Releases,
shortly after launch and every hour. The app never restarts on its own, and the page has no restart
button: a downloaded update installs when the app next quits, and the page shows only a
progress bar while it downloads.

Every system follows one rule: a normal quit puts the new version in place before the
app has gone, so the next launch is the new version however soon it comes; a quit as the
system shuts down or the session ends installs nothing; a copy that can't install itself
says "Update available"; and an install that did not take is noticed at the next launch
(see "Install failures"). Linux swaps the AppImage as it quits, macOS swaps the app bundle
(see "macOS"), and Windows runs the installer, which closes a copy reopened before it
finishes, so its update lands all the same.

What the host says of checks, downloads and installs goes to the app's `host.log` as
`update.progress` and `update.warning` lines, and electron-updater's own messages as
`updater.info`, `updater.warning` and `updater.error`, redacted as every line of the log is
(see `@novadeck/log` and `main/logs.ts`, `updateLogOn`). The logs folder is
`~/Library/Logs/novadeck` on macOS and `logs` in the data folder elsewhere.

The repository to look in comes from `resources/app-update.yml`, which electron-builder
writes into the app from its `publish` block. The release workflow fills that block from
`github.repository` (`-c.publish.owner` and `-c.publish.repo`), and its "Check Package
Names" step asserts the file names the repository that built the release. Nothing in the
host names a repository: the release page and the voice and murmur engine downloads read
the same validated owner and repository from that file (`update-release.ts`).

## Channels

A build follows one channel, which the person picks in Preferences and the host keeps
across launches in `update.json` in the data folder. The same file keeps what the card of what is
new needs (see "What is new"): `lastRunVersion`, `whatsNewPending`, `whatsNewFrom`,
`whatsNewSettled` and `whatsNewCheckedAt`.

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
stable release, even one older than that prerelease.

electron-updater decides the release in `GitHubProvider.getLatestVersion`. With
`allowPrerelease` false it asks `/releases/latest`, which GitHub answers with the latest
non-prerelease (a 404 when there is none); with it true it takes the newest entry of the
releases feed. `stable` sets it false and `early` true.

## Checks through novadeck.dev

Checks read `https://novadeck.dev/update/<channel>/` (`stable` or `early`), a generic
feed: electron-updater fetches `latest.yml`, `latest-mac.yml` or `latest-linux.yml` there.
The website counts the request, which is how it knows how many copies are open and
launched, and answers with that file from GitHub: `stable` the latest release's, `early`
the newest release the website links, prereleases included. It rewrites the file's
download addresses to the whole GitHub address at that release, so the update itself
downloads from GitHub directly. Should the website not know the newest release for
`early`, or not answer at all, the check fails and the app checks GitHub itself (below);
should its counting not run, it redirects the checks to GitHub uncounted (novadeck-website,
README "Counts"). The generic provider ignores `allowPrerelease`, so the channel
selects the address, and multipart range requests are off for it, as GitHub does not serve
them (a differential download would fail and fall back to a full one). `resources/app-update.yml` and its GitHub config stay as they are:
the release page, the portable install and the engine downloads read them.

What the app adds to a check through the website is `x-novadeck-check` (`launch`,
`interval`, `switch` or `retry`), `x-novadeck-version` and `x-novadeck-build` (`installed`
or `portable`), and no more: it reads nothing else off the computer to send, as sending
that only for statistics would need the person's consent. Nor does it add anything that
tells one copy from another: electron-updater's own `x-user-staging-id`, a per-install
UUID, is overridden with the constant `0` on these checks (its staged-rollout decision
reads the real one locally). The check against GitHub sends it as electron-updater always
has. The headers belong to the check: they are cleared before the download starts.

The request itself says more, as any request does. The name of the update file it asks
for (`latest.yml`, `latest-mac.yml`, `latest-linux.yml` or `latest-linux-arm64.yml`)
tells the website the system and, on Linux, the architecture. It carries electron-updater's
`User-Agent` (`electron-builder`), `Cache-Control` and a `noCache` query, and the
website's network sees the address; whether Chromium's network stack adds an
`Accept-Language` is not verified. What the website keeps of it is in novadeck-website's
README, "Counts".

A site that can't be reached or fails never blocks updating: a check through it that
fails for any reason is made again at once against GitHub (unless the app is quitting)
with the repository from `app-update.yml`, and the next check goes to novadeck.dev
again. The site's answer for `stable` is GitHub's file relayed live with `no-store`; its
answer for `early` can lag GitHub's by up to an hour (the site's own build), and the site
distrusts its record after 6 hours and answers 503, so the app falls back. A wrong answer
from the site, which only a bug of the site gives, can delay updates until it is fixed.
The app does not step back to an older `early` release the website names within 6 hours
of having offered or taken a newer one (kept per run, in memory, on a monotonic clock, and
only while that release is offered or ready: a failed download of it clears the hold): the answer is ignored,
with no download, no change of offer and nothing cleared, so a lagging answer cannot
replace a newer release found through GitHub. After 6 hours the older answer is taken, as
the release may have been withdrawn or, on macOS, rejected. GitHub's answers and the
`stable` site's are taken as they are, and the answer of a check made for a channel the
person has left meanwhile is dropped. The check that follows a version's first failed download, whichever it is (the retry, a
switch's or the hourly one), goes to GitHub alone, so a feed that checks well but
downloads badly does not fail the same way twice; the retry after a macOS prepare failure
goes through the site, and a version's later failures do not pin the copy to GitHub. Portable copies check the same way. With no
repository in `app-update.yml` there is nothing to fall back to, so checks stay on the
updater's own configuration.

In Cloudflare's fail-open mode, when the website's counting does not run, it answers a
check with a redirect to the GitHub file, and the `x-novadeck-*` headers go along to
GitHub with the request, which is harmless.

A connection the website accepts but never answers stalls checks for the run. The
request timeout of electron-updater never arms under Electron's `net`:
builder-util-runtime hooks `request.on("socket")` (`httpExecutor.js`), which Electron's
`ClientRequest` lacks. That was so against GitHub before; Cloudflare ends a stuck request
after about 100 seconds. The same holds for a GitHub request that hangs during the
fallback: later checks stall for the run, and the website's counting with them.

`NOVADECK_UPDATE_URL` replaces `https://novadeck.dev` for testing, and only with an
address on this computer: localhost, 127.0.0.1 or [::1], over http or https, as in
`NOVADECK_UPDATE_URL=http://127.0.0.1:8787`. Any other value is ignored.

## Which builds update

| Build                            | Mode                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| macOS, in Applications, signed   | Installs by swapping the app if the person can write it; else tells (see "macOS") |
| macOS, in Applications, unsigned | Tells; an update is installed only when signed by the same team                   |
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

An update is installed only when it is signed by the same team as the running app, so a
macOS build checks its own signature once at launch with `codesign`. See
[release-signing.md](release-signing.md).

### macOS

The host installs macOS updates itself, as Linux does, rather than through Squirrel.Mac.
Squirrel's ShipIt installs only once the app has exited, checks the update for about five
seconds, and gives up ("App Still Running Error") when the app is running again by then, so
a quit and a quick reopen lost every update, and the next launch downloaded it again and
said it was ready again. electron-updater still downloads the zip; with
`autoInstallOnAppQuit` off its `MacUpdater` hands nothing to Squirrel. Then
(`mac-update.ts`):

- **Prepared once downloaded.** The zip is unpacked with `ditto` into a folder of its own
  in `~/Library/Caches/dev.mzpk.novadeck.updates` (`dev.mzpk.novadeck.update-*`), which the
  system does not clear file by file as it does the temporary folder, stripped of any
  quarantine, and checked: one app, with the running app's bundle identifier and the offered version, signed through Apple's chain with a Developer ID Application certificate of the running app's team (`codesign --verify --deep --strict` with the requirement a Developer ID app carries as its own, which Squirrel.Mac held updates to: `anchor apple generic`, the Developer ID authority and application certificate fields, and `certificate leaf[subject.OU] = "<team>"`; see `updateRequirement`). The `TeamIdentifier` a signature names is not enough, as any certificate can carry one. Only then is it offered as `ready`; until then it stays `downloading` at
  the last percent. One that fails a check (`UpdateRejected`: a bad signature, not a
  `codesign` that was stopped) counts as a failed install (below); one that fails
  otherwise, as on a full disk, counts as a failed download and is tried again from
  electron-updater's copy. The folders of earlier updates go only once a newer one is
  ready, never once quitting has begun, so the one being put in place is never removed
  under it.
- **Put in place on quitting**, once every page has saved and the shells have ended, and
  before the process exits. When the person can write both the app and the folder holding
  it, the whole bundle is swapped; when only the app can be written, as for a standard
  account whose app is its own in an Applications folder it can't write, its `Contents`
  are, inside the bundle. Either way the new one is first staged beside the old
  (`.novadeck.app.new`, or `.Contents.new` in the bundle), renamed there or, across
  volumes, copied with `ditto` while the old app is still whole; then two renames in that one folder put the old one aside and the new one in place, between which alone there is no app at its path. The prepared app is checked again just before, as it waited in a folder anything the person runs can write; one that can't be checked then, as when `codesign` is stopped, is left alone with the old app, and a later session prepares and installs it again (`recheckMacUpdate`, `InstallPostponed`). Any failed step puts the old app back. A second quit meanwhile, as a logout's, waits for the swap. The old app then moves into the prepared folder, as removing it would hold up the quit, and the next launch removes it; where that crosses volumes an old app stays beside the bundle until then, and old `Contents` are removed at once, as left in the bundle they would break its seal. A prepared folder changed in the last ten minutes is left, as another copy on its own data folder may be installing from it; what a swap leaves beside the bundle is not guarded so. A bundle that is no longer the
  running version, as one install.sh replaced, is left alone. A quit as the session ends,
  and the uninstall, install nothing.
- **A copy the person can't write** only tells. When it is signed and installed, the offer
  says an administrator can allow it (`allow`), and the footer chip reads "Allow updates":
  it asks for an administrator's password once (`osascript … with administrator
  privileges`) to hand the bundle to the person, and the copy then checks again as one that
  installs. Turned down, as by a person with no administrator to ask, the chip becomes
  "Update available" for the rest of the run and opens the release page.
- The schedule goes on once an update is ready, and a newer release replaces it, as on the
  other systems. The waiting update stays ready until the newer one is, so a quit
  meanwhile installs the waiting one.

Squirrel.Mac stays in the bundle, as electron-builder puts it there, unused. A copy from
before this installs its next update through Squirrel, once.

### Installing and telling

- **Installing** builds download in the background and show it. The update is offered to
  the page as `downloading` at each whole percent electron-updater reports
  (`download-progress`), from the first; only the progress of the download the host started
  counts. A download already on disk from an earlier launch reports none and is `ready` at
  once, without a flash of progress. It becomes `ready` once downloaded (on macOS, once
  prepared, with the percent staying where it was until then), and the page
  then shows "Update ready" on a floating bar above the footer for a few seconds before it
  fades; the update installs on the next quit, which on macOS the bar names as quitting
  Novadeck, since closing its last window there leaves the app running. The bar shows
  the progress meanwhile; it has nothing to press and never takes focus. A `ready` offer
  the page did not see downloading, as at a launch, shows nothing. One download
  is tracked at a time, and a release found while it is under way waits for the next check.
- **A failed download** is tried again by a check five minutes later, once per release in a
  run; after that the hourly checks try it. Once its progress (or an update it
  replaces) was offered, it is offered as `retrying` meanwhile, and the page drops the
  bar at once and shows nothing in its place: no chip either, since a copy that installs itself
  has nothing for the person to do, and the retry tries again. One that failed before any progress, with no
  update waiting, goes untold, as a failed check does. Should the early retry fail too, the
  offer turns to `available`, so a copy whose downloads keep failing (a proxy, a full disk)
  shows the chip rather than fall behind unseen; the hourly checks still try it, and a
  download that gets going turns it back to `downloading`. A macOS download that fails its
  checks is an install failure: the version is marked failed, is not tried again, and the
  offer turns to `available`, for the person to fetch.
- **A newer release** found while an update waits replaces it, so one quit lands on the
  latest release rather than one per release missed. No release file carries a
  version in its name (`electron-builder.yml`), so electron-updater downloads the newer one
  beside the waiting file and renames it over that file once complete; a quit meanwhile
  installs the waiting update. The offer turns from `ready` into
  `downloading` the newer release as its progress comes in, so the page shows the bar
  again. Should the download fail, electron-updater clears its download
  folder, which likely takes the waiting file too: the newer release is offered as
  `retrying` until the retry downloads it. Quitting ends the schedule first,
  so no new download starts on the way out; one under way goes on, and a quit after it
  lands installs the newer release. On Windows the newer one costs its changed ranges and
  then the whole file, and its percent starts over once: electron-updater's differential
  download pairs the waiting update's blockmap with the installed build's installer, the
  result fails its checksum, and it falls back to a full download. On macOS the waiting update stays in place until the newer one is prepared, so a quit meanwhile installs the waiting one. `updater.test.ts` pins the file names and electron-updater's handling of the
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
  system may kill the installer halfway.

### Install failures

Only an error raised while installing counts as a failed install: one raised after the
updater's `install` (the quit-time install) was called, which the host wraps to know, and
on macOS a download that fails its checks or a swap that fails. The
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

An install that fails after the app has gone, as the Windows installer may, is noticed at
the next launch: as a quit begins an install it writes the version to `update.json`
(`installing`), and a launch that installs updates and finds itself still older than that
version marks it failed as above (`installOutcome`), then clears it either way. A copy
that only tells, such as a portable one sharing the data folder, leaves it for the
installed copy.

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
itself for the person: the install ends `installed`, the page says the installed copy "takes
effect after you restart Novadeck", and nothing is quit, started or handed off. `installApp`
answers nothing: the host owns the install's phase (`PortableState.install`, starting `idle`)
and pushes the whole `PortableState` to every window at each change (`onPortableState`):
`installing` at once, as the answer to the click; on Windows then `downloading` with each new
whole percent and `installing` again while the setup runs; then `installed`, `newer` (with the
installed version) or `failed` (with a reason). Only the window that asked raises its card with
the answer; the others show it on the footer chip. A request
while it downloads or installs, or after it ended `installed` or `newer`, does nothing; after
`failed` it starts over. A copy that is not portable, or a sender that is not the app's own page,
does nothing either. On Linux:

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
- **Install.** First one refusal before anything is downloaded: a copy unpacked into the
  install folder (the recorded `InstallLocation` or the default one, whole path segments;
  `insideInstallFolder`) is `failed`, "Novadeck can't install while this copy runs from its
  install folder. Move this copy somewhere else, like Downloads, and try again." Where an
  installed copy with the old uninstaller exists, two more apply; see "Legacy uninstallers"
  below. Then, while the app runs
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
  (`include/allowOnlyOneInstallerInstance.nsh`, `CHECK_APP_RUNNING`, run at the start of the
  install section and in `un.checkAppRunning` of the uninstaller) normally stops every
  `novadeck.exe` of the user by name where PowerShell is unusable, which would include this
  portable copy. It calls `customCheckAppRunning` instead when a build defines it, and
  `apps/desktop/resources/installer.nsh` does (builder includes that file by name).
  One rule, in terms of the install folder alone. Novadeck runs from it when any process but
  the setup has a path inside `<install folder>\` (found with PowerShell, which also sees
  helpers such as ConPTY's `OpenConsole.exe` that outlive `novadeck.exe`); where PowerShell
  does not answer, when `novadeck.exe` there cannot be opened for writing. A copy running
  from any other folder (the portable one) is never seen, let alone stopped.
  - The installer's silent run without `--updated`, which is how this copy runs the setup,
    closes nothing: with Novadeck running from the install folder it ends with exit code 3
    and changes nothing, and the install answers `failed` ("Novadeck can't install while
    something from its install folder is still running. Quit Novadeck there, or restart
    Windows, then try again."; any other
    exit with no copy left is the generic "did not finish").
  - A self-update by an installed copy (`--updated`; the app is quitting) and a silent
    uninstaller (an update's run of the old one, or `/S` from a script) wait one round, then
    close what still runs from the install folder. An interactive uninstaller (Windows
    Settings, or Preferences' Uninstall, which starts it and quits 250 ms later) waits two
    rounds the same way, then asks (OK/Cancel) before closing; an interactive installer
    asks in round 1. Closing is polite (`CloseMainWindow`) for its first two rounds, then
    forced (`Stop-Process -Force`). A round is one second plus the closing. The check runs again at the start of
    each round, so round 7 only finds out whether the last forced close worked: if
    something still runs, every `--updated` run, silent or not, and every silent uninstaller
    ends with exit code 3, and an interactive run offers Retry (which forces again). Each
    PowerShell call has a 15 s timeout, and a timeout counts as a failed query. The two
    environment variables the queries read are cleared once the check passes.
  - Closing is by PowerShell, only processes whose path starts with `<install folder>\`,
    separator included, never this setup itself, so never by name. Without PowerShell
    nothing is closed: a silent install that is not a self-update ends at once, a silent
    self-update or uninstaller ends with exit code 3 at round 7; an interactive run shows the
    "click OK to close it" box but closes nothing, and offers Retry at round 7 for the
    person to close Novadeck by hand.
  - `install-windows.test.ts` pins that the builder in use still reaches the hook from the
    install section, the uninstaller and `CHECK_APP_RUNNING`, that `installer.nsh` is still
    included by name from `directories.buildResources`, and that the install section still
    runs `customInstall`.
- **Legacy uninstallers.** The setup first runs the installed copy's own uninstaller
  (`uninstallOldVersion` in `installUtil.nsh`, `/S --updated`). An install made before the
  macro carries builder's old check. With PowerShell passing its two availability tests it
  stops processes by a plain path prefix with no separator, so a portable in a sibling
  folder such as `...\Programs\novadeck-portable` dies; without it, `taskkill /IM
  novadeck.exe` stops any portable. The installer therefore writes a `RunningCheck` value
  next to `InstallLocation` (`HKCU\Software\<guid>`, from `customInstall`); builder's
  uninstaller deletes that whole key. The host treats an install as legacy
  (`readLegacyUninstaller`) when the registry records one, an `UninstallString` or an
  `InstallLocation` (whether or not `novadeck.exe` is still there), without the marker, or
  when the registry cannot be read. Then it also refuses a portable whose folder path merely
  starts with the install folder's (`legacyPrefixFolder`; "...from a folder whose name
  starts with <folder>...") and where those two PowerShell tests fail (`powershellUsable`;
  "Novadeck can't install itself while it runs on this PC. Quit Novadeck, then run the
  installer from the Releases page."). This guard is marked LEGACY in code. Delete it once
  no install without the marker matters. Residual risks: the old uninstaller still stops
  anything running from inside the install folder, and it runs its own PowerShell test
  again when it starts. If that fails, even briefly after the host's check passed, it runs
  `taskkill /IM novadeck.exe`, which closes the portable copy. The guard narrows this and
  cannot remove it.
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

The packaged smoke test (`smoke.mjs`) and the Linux sandbox check in `package.yml` pass
`--user-data-dir`, so each gets its own lock. The other smoke launches share the default
folder, so each is stopped before the next starts. The Linux ones, which `timeout` stops
through `xvfb-run`, then wait up to 15 seconds for the process named by the folder's
`SingletonLock` to be gone, and fail if it is not, as the next launch would otherwise hand
off to it and exit. The macOS ones kill their process and wait for it, and the Windows ones
kill the process tree and wait.

## The page's view

`DesktopBridge` in `contract/protocol/src/bridge.ts` carries `onUpdate` (an
`UpdateOffer` with `kind` (`downloading`, `ready`, `retrying` or `available`), `version` and, for `downloading`, a whole `percent`), `openUpdatePage`,
`updateChannel` and `setUpdateChannel`. After an update the app shows one card of what is new (see
"What is new" below), through `whatsNew`, `dismissWhatsNew` and `openWhatsNewPage`. `onPortableState`
pushes the `PortableState` to every window when it changes, each step of an install included.
The preload checks every offer and portable state again, with the protocol's parsers, before the
page sees it: a bad offer is dropped, and so is a bad pushed state; a bad answer to `portable` counts as not portable. Requests count
only from the main frame of the app's own page.

## What is new

The app tells of an update in one place, a card of highlights for the version it updated to and
the releases it skipped on the way, shown at each launch until the person dismisses it or the
releases turn out to have none. The notes come from the releases themselves: each prerelease, and
again its promotion to stable, writes a hidden `<!-- novadeck:notes {json} -->` block in its body,
before the "All commits" details (`scripts/release-notes`), and the host reads it with
`readNotesBlock` from the release API (`/releases/tags/v{version}`, then `/releases` for the
skipped ones), never from the page.

The card gathers the highlights of the version's own release and of every release after
`whatsNewFrom` (the version updated from, or the newest settled when that is newer), newest first,
at most four, a highlight two releases share told once. A promotion's notes tell everything since
the stable release before it, so a prerelease older than the newest promotion among them is left
out. The list is read newest first, a hundred to a page, until it reaches `whatsNewFrom`, three
pages at most; a list that can't be read, or is not one, fails the read as the release's own
would.

At launch the host records the version it runs in `update.json` as `lastRunVersion`, and marks
that version `whatsNewPending` when it is newer than the one the last launch recorded. A first
launch marks nothing; an install from before the version was kept counts as updated when the
data folder holds the runner's `workspace.sqlite`. The mark is settled, and the version
recorded as `whatsNewSettled`, when the person dismisses the card or the release is read and
has nothing to show (no block, no highlights, or GitHub's own JSON 404); nothing at or below
a settled version is offered again. A read that fails for a reason that may pass (offline,
timeout, 403, 429, 5xx, or an answer that is not that release) is tried once more two minutes
later in the same launch, and the page's one request waits for it; if that fails too, the mark
stays for a later launch. A prerelease's own notes carry up to two highlights, so early builds
show the card too. A prerelease whose notes are not written yet, or that gathers no highlights,
is read at most once a day (`whatsNewCheckedAt`), as its notes or its promotion may still write
some onto the same tag. Builds that look
for no updates (version 0.0.0, no release repository) never offer a card.

## Release assets

Every release uploads these assets, and each `latest*.yml` entry's `url` must name an
uploaded asset exactly:

| Asset                                              | Used by                                         |
| -------------------------------------------------- | ----------------------------------------------- |
| `novadeck-mac-universal.dmg`                       | Downloads from the website                      |
| `novadeck-mac-universal.zip`                       | `install.sh` on macOS, and updates              |
| `novadeck-win-x64-setup.exe`                       | The Windows installer and its updates           |
| `novadeck-win-x64.zip`                             | The portable Windows app; no update source      |
| `novadeck-linux-x86_64.AppImage`                   | The AppImage and its updates                    |
| `latest.yml`, `latest-mac.yml`, `latest-linux.yml` | Update metadata, with each package's SHA-512    |
| `*.blockmap`                                       | Differential downloads of the installer and zip |
| `install.sh`                                       | The Linux and macOS install script              |

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

- **On macOS a signal quits like ⌘Q.** Linux tells an orderly quit from SIGTERM, SIGINT or
  SIGHUP and installs only on the former; macOS has no such mark, so a `kill` puts a ready
  update in place as a normal quit would. A logout or shutdown installs nothing.
- **A Mac with several administrators** hands the bundle to whoever allowed updates last;
  another account then finds it can't write it, and its chip asks again.
- **A Windows copy reopened while its installer runs** may mark that update failed in
  `update.json` before the installer closes it and finishes; the release then installed
  is the running one, so nothing more comes of it than a line in the log.
- **macOS App Management** may refuse the swap (`EPERM`) where the person has not let
  Novadeck manage apps. The install then fails as any other: the log says where to allow
  it in System Settings, and the page offers the release as "Update available".
- **A channel switch does not cancel work in progress.** An `early` build that is already
  downloading a prerelease when the person switches to `stable` finishes the download and
  installs it on quit. The same switch made during an in-flight check drops that
  check's answer, and the new channel is checked at once when it ends.
- **Offers are not retracted.** After switching from `early` to `stable`, an `available`
  offer for an early-only release stays until a later check offers another version; the
  bridge has no way to withdraw one. A downloaded update stays `ready` as well, unless a stable release newer than the running
  build replaces it, and a `downloading` offer is replaced only by its own outcome.
- **Windows updates are not watched past the call.** An installed copy's update runs the
  NSIS installer asynchronously as the app exits, so an error there is not seen by the app
  until the next launch finds itself still on the old version (see "Install failures").
  (A portable copy's install is watched: see Portable builds.)
