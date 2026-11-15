# @novadeck/forges

Finds the pull request of a git branch on GitHub, GitLab and Azure DevOps, with the token of the
forge's own signed-in command-line tool (`gh`, `glab`, `az`). It stores no secret, never spawns a
program and never opens a connection itself: the caller hands it a `Run` and a `fetch`, so it
runs wherever those can, and tests script them. Pure JavaScript, for Node and the browser alike.

## Subpaths

- `.`: everything below.

## Parts

- `parseRemote(url)`: a git remote's address as `{ host, path, user? }`, the host lowercased and
  the path's segments without `.git`. Reads `https://` (with or without a user, password, port or
  `.git`), `ssh://`, the scp form (`git@host:owner/name`) and the `git://` forms; answers
  `undefined` for a local path, a Windows drive, `file://` and anything with fewer than two path
  segments.
- `github`, `gitlab`, `azure`: one `Forge` each, and `forges` by name.
  - `repository(remote, hosts?)`: the repository a remote names where this forge could host it.
    github.com, gitlab.com and Azure DevOps's hosts (`dev.azure.com`, `ssh.dev.azure.com`,
    `*.visualstudio.com`, `vs-ssh.visualstudio.com`, by the path's shape) are claimed outright;
    any other host only when `hosts` has it (GitHub Enterprise, self-managed GitLab). GitLab
    subgroups are kept in the project's path. Azure DevOps Server is not supported.
  - `signedIn(run)`: the hosts its tool is signed in to, or a `Problem`.
  - `token(run, host)`: a token from the tool, with `expiresAt` where the tool says (Azure's).
    `gh auth token --hostname`; `glab config get token --host`, then `glab auth status
    --show-token` where a keyring login leaves the config's token empty; `az account
    get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`.
  - `pullRequests(fetch, token, repository, branches)`: a map of branch to `PullRequest`
    (`number`, `url`, `title`, `state` of `draft`, `open`, `merged` or `closed`). GitHub asks one
    GraphQL query per repository, an aliased `pullRequests(headRefName:)` for each branch (forty
    to a query); GitLab and Azure DevOps ask their REST list once per branch. A branch with
    several pull requests answers its open one, else the latest merged, else the latest closed. A
    pull request from a fork is never taken for the repository's own, though its branch has the
    same name. A branch with none is not in the map, and a repository the token can't see answers
    an empty map.
  - `signIn(host)`: the command the person runs to sign the tool in.
- `repositoryOf(remote, signedIn, among)`: the repository a remote names among the forges given,
  trying hosts a forge is known by before hosts it is merely signed in to.
- `Problem` and `isProblem(value)`: why there is no answer. `missing` (the tool isn't installed),
  `signed-out` (with `fix`, the sign-in command), `refused` (the host turned the token away; `fix`
  where a command mends it, as `gh auth refresh --hostname <host> --scopes repo`), `unreachable`
  (offline, a 5xx, a timeout or a tool that took too long), `limited` (until an epoch-millisecond
  time, from `Retry-After` or the rate-limit headers) and `unknown` (as it said). HTTP maps as 401
  to `signed-out`, 403 to `refused` or, when its headers say a rate limit, `limited`, 404 to an
  empty map, 429 to `limited`, 5xx and network failures to `unreachable`, any other status to
  `unknown`. Azure DevOps answers an expired token with a 203 or a redirect, read as `signed-out`.
- `Run` and `Ran`: how a program is run, `(program, args) => Promise<Ran>`, answering its output
  or `missing`, `exit` or `timeout` with what it said. The caller decides where programs are
  found, their environment and timeout, and must never let one prompt.
- `Fetch`: the standard `fetch`. Requests carry the token as a bearer and a neutral
  `user-agent`; wrap `fetch` to add more.
- `Token`, `Remote`, `Repository`, `PullRequest`, `Forge`, `ForgeName`: the types that cross the
  contract.
