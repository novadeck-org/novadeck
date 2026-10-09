# Auto-update

Installed apps look for a newer release on GitHub, download it in the background and
install it the next time the app quits. The app never restarts on its own: it
offers a restart instead, which saves every page first, as quitting does.

## Which builds update

| Build                          | Updates                                                               |
| ------------------------------ | --------------------------------------------------------------------- |
| Linux AppImage                 | Yes, replacing the AppImage file in place                             |
| Linux `.deb` and `.rpm`        | No, the package manager owns them                                     |
| Windows installer (`-setup`)   | Yes                                                                   |
| Windows portable (`-portable`) | No, it has nowhere to install to                                      |
| macOS                          | Yes, once the app is Developer ID signed; an unsigned one never tries |
| Local and pull request builds  | No, they carry version 0.0.0                                          |

Squirrel.Mac refuses to install into an app that is not Developer ID signed, so a macOS
build checks its own signature once at launch with `codesign` and stays out of the
update loop, without downloading anything, until releases are signed. See
[release-signing.md](release-signing.md).

Setting `NOVADECK_UPDATES=off` turns updating off for a launch. The smoke tests and the
release workflow's package checks set it, so they never reach the network.

## How it works

- `application/host/src/main/updater.ts` decides whether the build updates, checks about
  ten seconds after launch and every four hours, and tells the app's pages the version of
  a downloaded update. Failed checks, offline or rate limited, are logged and the next
  interval tries again.
- Checking stops once an update has downloaded; the next launch checks again. A newer
  release found meanwhile would empty the folder the downloaded file waits in while
  `electron-updater` still names that file, and quitting then could delete the running
  AppImage.
- On macOS an update counts as ready only once Squirrel.Mac, the system's updater, has
  staged it. `electron-updater` reports a download earlier, and restarting before then
  waits on Squirrel indefinitely.
- Restarting saves every page and ends the shells before the updater installs. If the
  updater then returns without ending the app, as it does when an install fails, for
  instance in a read-only folder, the app quits after 10 seconds (30 on macOS) rather than
  go on running without its shells.
- On Windows and Linux, a quit caused by the system shutting down or the session ending
  installs nothing, as the system may kill the installer halfway. Other quits install a
  waiting update. On macOS Squirrel.Mac installs a staged update on any exit; it swaps the
  bundle whole, so an interrupted install leaves the old app.
- The Linux build counts as the AppImage only when `APPIMAGE` is set and the running
  executable lies inside `APPDIR`: shells inside the app inherit `APPIMAGE`, so a deb
  started from one would otherwise pass for it.
- `electron-updater` reads GitHub Releases of `mzpkdev/novadeck`. Every release is still a
  prerelease, so the updater is told to accept prereleases.
- `electron-builder.yml`'s `publish` block makes builder write `resources/app-update.yml`
  into the app, which names that repository, and the `latest*.yml` metadata beside the
  packages, even with `--publish never`.

## Release assets

Each platform's metadata is uploaded with its packages by `.github/workflows/release.yml`,
and each file's `url` must name an uploaded asset exactly:

| File               | Describes                                                          |
| ------------------ | ------------------------------------------------------------------ |
| `latest-linux.yml` | `novadeck-linux-x86_64.AppImage`, which has no version in its name |
| `latest.yml`       | `novadeck-<version>-win-x64-setup.exe`, not the portable           |
| `latest-mac.yml`   | `novadeck-<version>-mac-universal.zip`, and the disk image         |
| `*.blockmap`       | The installer's and the macOS packages' differential download maps |

The AppImage has no version in its name because `electron-updater` renames the file on
update when the name carries one, which would break whatever launches it; with the same
name, the update replaces the file at its path. It embeds its own block map. The metadata carries the SHA-512 of each package, so
the workflow must not change a package after builder wrote it.
