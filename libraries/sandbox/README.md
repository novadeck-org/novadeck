# @novadeck/sandbox

An isolated environment for tests and benchmarks that run real shells and programs, so a
program under test can't reach the developer's configuration, logins or keyring, and nothing it
started outlives the run. Node only.

## Subpaths

- `.`: `createSandbox(options)` makes a throwaway root with a home and a project, and an
  environment made only of what the sandbox sets: HOME and the XDG folders inside it, a PATH of
  the programs under test, Node through a folder of its own and the system's folders, a dead
  D-Bus address, the proxy when given, and an ssh for git that reads none of the user's
  `~/.ssh`. Should making it fail, its root is removed. On Windows the user's folders
  (USERPROFILE, APPDATA, LOCALAPPDATA, TEMP) move inside it too, and git and PowerShell 7 come
  by their own installs.
  `gitBash()` finds Git for Windows' bash. The caller removes `root`.
- `./reap`: `reap(sandbox)` ends what still runs in the sandbox (started since it was made,
  working inside it or with its home, and on Linux and macOS what one of those started or a
  process in its group, never through the caller's own group), asking first, then forcibly,
  its waits ending within 15 seconds, and returns what had to be ended. Linux reads `/proc`,
  macOS asks `ps` and `lsof`, Windows compiles a small process lister with the C# compiler
  every Windows has. On Windows a forcible end goes through the `trees`
  option, a reader that ends a process and what it started, each only as the one it read;
  without it, a forcible end takes the process alone, as taskkill's tree goes by recorded parent
  pids, which may name an unrelated process, and the next round finds what it started.
  `census(sandbox)` names, on Windows, what runs in the sandbox now, each with how its recorded
  parent stands, ending nothing.
- `./tripwire`: `tripwire(sandbox, watches)` notes paths in the developer's real home before a
  run and returns, after it, those a program that escaped the sandbox wrote to.

## What it doesn't cover

- **Stores outside the environment.** The macOS Keychain and defaults, the Windows registry and
  Credential Manager and the Linux kernel keyring are the user's whatever the environment says;
  a program that keeps its login there needs a guard of the caller's own. So does git: the
  system's own git configuration (Git for Windows' `credential.helper=manager`, the Xcode git's
  `osxkeychain`) still applies, and hands a sandboxed `git` the developer's credentials for an
  HTTPS remote.
- **`ssh` run by itself.** OpenSSH finds `~/.ssh` by the user's passwd entry, not HOME. Git's
  ssh is told to read none of it, but an `ssh` a program runs itself reads the developer's
  configuration and keys, and writes their `known_hosts`. The agent socket is cut, as
  `SSH_AUTH_SOCK` isn't passed on.
- **A process that leaves.** One that has left the sandbox's folder and has another HOME is
  found only through its parent or a process in its group, while one of those still runs: a
  backgrounded job whose shell has exited, or a daemon, as ssh-agent is, goes unseen. On Linux
  that is so too of any process made non-dumpable (as setuid programs are), which hides its
  folder and environment even from its own user, and on macOS of its own programs, whose
  environment `ps` doesn't show. On Windows no process is found through its parent.
- **The system's folders on PATH.** `/usr/bin` and `/bin` come on PATH as they are; `forbidden`
  is checked against the tool folders Windows adds, not against those. Where Node or a program
  under test is installed there, as some distributions do, a program run by name that isn't in
  `bins` finds it.
- **The network.** The proxy only reaches programs that honour it. On Linux, run the whole job in
  a network namespace whose only interface is loopback: `node scripts/e2e/isolated/main.ts --
  <command>`.
