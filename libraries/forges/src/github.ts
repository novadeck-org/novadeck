import { choose, time, type Candidate } from "./choose.js"
import { failure, parse } from "./cli.js"
import type {
  Check,
  Ci,
  Fetch,
  Forge,
  Problem,
  PullRequest,
  Remote,
  Repository,
  Run,
  Token,
} from "./forge.js"
import { headers, pooled, record, send } from "./http.js"

const defaultHost = "github.com"

const signIn = (host: string): string => `gh auth login --hostname ${host}`
const refresh = (host: string): string => `gh auth refresh --hostname ${host} --scopes repo`

// GitHub Enterprise Cloud with data residency (`<name>.ghe.com`) serves its API on `api.`, as
// github.com does; GitHub Enterprise Server serves it under `/api`.
const graphql = (host: string): string =>
  host === defaultHost
    ? "https://api.github.com/graphql"
    : host.endsWith(".ghe.com")
      ? `https://api.${host}/graphql`
      : `https://${host}/api/graphql`

const repository = (remote: Remote, hosts: readonly string[] = []): Repository | undefined => {
  const [owner, name] = remote.path
  if (owner === undefined || name === undefined || remote.path.length !== 2) return undefined
  const host =
    remote.host === "ssh.github.com" || remote.host === "www.github.com" ? defaultHost : remote.host
  if (host !== defaultHost && !hosts.includes(host)) return undefined
  return { forge: "github", host, owner, name }
}

const signedIn: Forge["signedIn"] = async (run) => {
  const ran = await run("gh", ["auth", "status", "--json", "hosts"])
  // A failing status still says what it knows (nothing signed in exits 1 with `{"hosts":{}}`).
  const text = ran.ok ? ran.out : ran.kind === "exit" ? ran.said : ""
  if (!ran.ok && ran.kind !== "exit")
    return failure(ran, () => ({ kind: "unknown", said: ran.said }))
  const hosts = record(record(parse(text))?.["hosts"])
  if (hosts === undefined) {
    return ran.ok ? { kind: "unknown", said: "gh auth status gave no hosts" } : []
  }
  return Object.entries(hosts)
    .filter(
      ([, accounts]) =>
        Array.isArray(accounts) && accounts.some((one) => record(one)?.["state"] === "success"),
    )
    .map(([host]) => host)
}

const token = async (run: Run, host: string): Promise<Token | Problem> => {
  const ran = await run("gh", ["auth", "token", "--hostname", host])
  if (!ran.ok) return failure(ran, () => ({ kind: "signed-out", fix: signIn(host) }))
  const value = ran.out.trim()
  return value === "" ? { kind: "signed-out", fix: signIn(host) } : { value }
}

const query = (count: number): string => {
  const vars = Array.from({ length: count }, (_, at) => `$b${at}: String!`).join(", ")
  const fields = Array.from(
    { length: count },
    (_, at) =>
      `p${at}: pullRequests(headRefName: $b${at}, states: [OPEN, MERGED, CLOSED], first: 20, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url title isDraft state mergedAt closedAt isCrossRepository baseRefName commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 50) { nodes { __typename ... on CheckRun { name status startedAt checkSuite { createdAt } } ... on StatusContext { context state createdAt } } } } } } } } }`,
  ).join(" ")
  return `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`
}

// The rollup of the head commit's checks and statuses; none where nothing reports on it.
const rollups: Record<string, Ci> = {
  SUCCESS: "passed",
  FAILURE: "failing",
  ERROR: "failing",
  PENDING: "running",
  EXPECTED: "running",
}

const ciOf = (pr: Record<string, unknown>, blind: boolean): Ci | undefined => {
  const commits = record(pr["commits"])?.["nodes"]
  const commit = record(Array.isArray(commits) ? record(commits[0])?.["commit"] : undefined)
  const state = record(commit?.["statusCheckRollup"])?.["state"]
  const known = typeof state === "string" ? rollups[state] : undefined
  // A rollup GraphQL answered with an error (a token that can't read checks) says nothing.
  return known ?? (blind ? undefined : "none")
}

// A check run's status: waiting for a runner, or running; COMPLETED is finished. WAITING is an
// environment's approval and PENDING a concurrency group's earlier run: held, not for a runner.
const queuedStatuses = new Set(["QUEUED", "REQUESTED"])
const heldStatuses: Record<string, "approval" | "concurrency"> = {
  WAITING: "approval",
  PENDING: "concurrency",
}

// The checks of the head commit that have not finished, as the rollup lists them; undefined
// where it lists none (a rollup that can't be read, or no checks at all).
const checksOf = (pr: Record<string, unknown>): Check[] | undefined => {
  const commits = record(pr["commits"])?.["nodes"]
  const commit = record(Array.isArray(commits) ? record(commits[0])?.["commit"] : undefined)
  const nodes = record(record(commit?.["statusCheckRollup"])?.["contexts"])?.["nodes"]
  if (!Array.isArray(nodes)) return undefined
  return nodes.flatMap((node): Check[] => {
    const each = record(node)
    if (each === undefined) return []
    if (each["__typename"] === "CheckRun") {
      const { name, status } = each
      if (typeof name !== "string" || typeof status !== "string") return []
      const hold = heldStatuses[status]
      const queued = queuedStatuses.has(status)
      if (!queued && hold === undefined && status !== "IN_PROGRESS") return []
      const at = time(each["startedAt"]) || time(record(each["checkSuite"])?.["createdAt"])
      return [
        {
          name,
          state: hold !== undefined ? "held" : queued ? "queued" : "running",
          ...(hold !== undefined && { hold }),
          ...(at > 0 && { since: at }),
        },
      ]
    }
    // A commit status an outside service reports, still pending.
    const { context } = each
    if (
      typeof context !== "string" ||
      (each["state"] !== "PENDING" && each["state"] !== "EXPECTED")
    )
      return []
    const at = time(each["createdAt"])
    return [{ name: context, state: "running", ...(at > 0 && { since: at }) }]
  })
}

// The head commit of each pull request found, which the runner lookup asks the runs of.
const heads = new WeakMap<PullRequest, string>()

const headOf = (pr: Record<string, unknown>): string | undefined => {
  const commits = record(pr["commits"])?.["nodes"]
  const oid = record(Array.isArray(commits) ? record(commits[0])?.["commit"] : undefined)?.["oid"]
  return typeof oid === "string" ? oid : undefined
}

const states: Record<string, PullRequest["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
}

// A pull request from the repository itself; one from a fork, whose branch may share the name,
// is not the work's. Asked of GitHub rather than compared by name, which a renamed repository's
// remote still has the old of.
const candidate = (node: unknown, blind = false): Candidate | undefined => {
  const pr = record(node)
  if (pr === undefined) return undefined
  if (pr["isCrossRepository"] !== false) return undefined
  const state = states[String(pr["state"])]
  const { number, url, title } = pr
  if (
    state === undefined ||
    typeof number !== "number" ||
    typeof url !== "string" ||
    typeof title !== "string"
  ) {
    return undefined
  }
  const open = state === "open"
  const ci = open ? ciOf(pr, blind) : undefined
  const checks = open && ci === "running" ? checksOf(pr) : undefined
  const base = pr["baseRefName"]
  const oid = headOf(pr)
  const pull: PullRequest = {
    number,
    url,
    title,
    state: open && pr["isDraft"] === true ? "draft" : state,
    ...(open && ci !== undefined && { ci }),
    ...(open && typeof base === "string" && base !== "" && { base }),
    ...(checks && checks.length > 0 && { checks }),
  }
  if (oid !== undefined && checks && checks.length > 0) heads.set(pull, oid)
  return { pull, at: time(pr["mergedAt"]) || time(pr["closedAt"]) }
}

const errorKind = (
  body: Record<string, unknown>,
): { type: string; message: string } | undefined => {
  const first = record(Array.isArray(body["errors"]) ? body["errors"][0] : undefined)
  if (first === undefined) return undefined
  return { type: String(first["type"] ?? ""), message: String(first["message"] ?? "") }
}

// The pull requests whose checks an error of the answer names (`p0/2`: the third of the first
// branch's), as a partial answer says of a token that can't read them.
const blinded = (body: Record<string, unknown>): ReadonlySet<string> =>
  new Set(
    (Array.isArray(body["errors"]) ? body["errors"] : []).flatMap((each) => {
      const path = record(each)?.["path"]
      return Array.isArray(path) && path.includes("statusCheckRollup")
        ? [`${String(path[1])}/${String(path[3])}`]
        : []
    }),
  )

// The REST API of the host, which lists a workflow job's runner labels (GraphQL doesn't).
const rest = (host: string): string =>
  host === defaultHost
    ? "https://api.github.com"
    : host.endsWith(".ghe.com")
      ? `https://api.${host}`
      : `https://${host}/api/v3`

/** The most workflow runs of one commit whose jobs are asked, and jobs read of each. */
const runsAsked = 5

const jobStates = new Set(["queued", "in_progress", "waiting", "pending", "requested"])

/** What a job's runner labels and queue time were; they don't change, so they are read once. */
type Job = { readonly runner?: string | undefined; readonly created: number }

/** How many jobs are remembered, oldest forgotten first. */
const jobsKept = 4000

/** How long a check no job was found for is left alone before it is asked again. */
const unmatchedMs = 5 * 60_000

/** How long the REST API is left alone for a repository after a refusal that names no reset. */
const refusedMs = 5 * 60_000

// By repository, commit and check name. A check no job was found for is kept as `undefined`,
// with when, so a check no run names (a status an app reports) is not asked of every look.
const jobs = new Map<string, { readonly job: Job | undefined; readonly at: number }>()

// The moment, by repository, before which the REST API is not asked (rate limited or refused).
const backoff = new Map<string, number>()

const keyOf = (
  repo: Repository & { readonly forge: "github" },
  oid: string,
  name: string,
): string => `${repo.host}/${repo.owner}/${repo.name}\0${oid}\0${name}`

const remember = (key: string, job: Job | undefined, at: number): void => {
  jobs.delete(key)
  jobs.set(key, { job, at })
  if (jobs.size > jobsKept) jobs.delete(jobs.keys().next().value!)
}

/** Forgets what was read of workflow jobs and any back off, as a fresh start does. */
export const forgetJobs = (): void => {
  jobs.clear()
  backoff.clear()
}

// The runner labels and queue time of the jobs of the commit's unfinished workflow runs, by job
// name, read into `jobs`. Never fails the lookup: a token that can't read Actions leaves the
// checks as they were, and a rate limit or refusal leaves REST alone for the repository until
// the reset, or a few minutes.
const readJobs = async (
  fetch: Fetch,
  auth: Token,
  repo: Repository & { readonly forge: "github" },
  oid: string,
  names: readonly string[],
): Promise<void> => {
  const where = `${repo.host}/${repo.owner}/${repo.name}`
  const now = Date.now()
  if ((backoff.get(where) ?? 0) > now) return
  const base = `${rest(repo.host)}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/actions/runs`
  const get = async (url: string) => {
    const got = await send(
      fetch,
      url,
      { headers: headers(auth.value) },
      { signIn: signIn(repo.host) },
    )
    if ("problem" in got) {
      const { problem } = got
      if (problem.kind === "limited") backoff.set(where, problem.until)
      else if (problem.kind === "refused") backoff.set(where, Date.now() + refusedMs)
    }
    return got
  }
  const runs = await get(`${base}?head_sha=${encodeURIComponent(oid)}&per_page=20`)
  // Neither answer says what the checks run on: they are asked again at the next look.
  if (!("body" in runs)) return
  const list = record(runs.body)?.["workflow_runs"]
  if (!Array.isArray(list)) return
  const open = list.flatMap((run) => {
    const each = record(run)
    return each !== undefined &&
      typeof each["id"] === "number" &&
      jobStates.has(String(each["status"]))
      ? [each["id"]]
      : []
  })
  const asked = open.slice(0, runsAsked)
  const answers = await pooled(asked, (id) => get(`${base}/${id}/jobs?filter=latest&per_page=100`))
  if (answers.some((each) => "problem" in each)) return
  const found = new Set<string>()
  for (const answer of answers) {
    const listed = "body" in answer ? record(answer.body)?.["jobs"] : undefined
    if (!Array.isArray(listed)) continue
    for (const job of listed) {
      const each = record(job)
      if (each === undefined || typeof each["name"] !== "string") continue
      if (!jobStates.has(String(each["status"]))) continue
      const labels = Array.isArray(each["labels"])
        ? each["labels"].filter((label): label is string => typeof label === "string")
        : []
      found.add(each["name"])
      remember(
        keyOf(repo, oid, each["name"]),
        {
          ...(labels.length > 0 && { runner: labels.join(" ") }),
          created: time(each["created_at"]),
        },
        now,
      )
    }
  }
  for (const name of names) if (!found.has(name)) remember(keyOf(repo, oid, name), undefined, now)
}

// Names each unfinished check's runner kind, and when a queued one was queued, by its job. The
// jobs are asked only where a queued or running check's job isn't known yet.
const withRunners = async (
  fetch: Fetch,
  auth: Token,
  repo: Repository & { readonly forge: "github" },
  pull: PullRequest,
  oid: string,
): Promise<PullRequest> => {
  if (!pull.checks) return pull
  const known = (name: string): boolean => {
    const seen = jobs.get(keyOf(repo, oid, name))
    return seen !== undefined && (seen.job !== undefined || Date.now() - seen.at < unmatchedMs)
  }
  const unknown = pull.checks.flatMap((check) =>
    check.state !== "held" && !known(check.name) ? [check.name] : [],
  )
  if (unknown.length > 0) await readJobs(fetch, auth, repo, oid, unknown)
  return {
    ...pull,
    checks: pull.checks.map((check) => {
      const job = jobs.get(keyOf(repo, oid, check.name))?.job
      if (job === undefined || check.state === "held") return check
      const since = check.state === "queued" && job.created > 0 ? job.created : check.since
      return {
        ...check,
        ...(job.runner !== undefined && { runner: job.runner }),
        ...(since !== undefined && { since }),
      }
    }),
  }
}

const chunk = 40

const pullRequests: Forge["pullRequests"] = async (fetch, auth, repo, branches) => {
  if (repo.forge !== "github") return { kind: "unknown", said: "not a GitHub repository" }
  const found = new Map<string, PullRequest>()
  const unique = [...new Set(branches)]
  for (let at = 0; at < unique.length; at += chunk) {
    const group = unique.slice(at, at + chunk)
    const variables: Record<string, string> = { owner: repo.owner, name: repo.name }
    group.forEach((branch, index) => (variables[`b${index}`] = branch))
    // eslint-disable-next-line no-await-in-loop -- Groups go one after another, to be gentle on the API.
    const answer = await send(
      fetch,
      graphql(repo.host),
      {
        method: "POST",
        headers: { ...headers(auth.value), "content-type": "application/json" },
        body: JSON.stringify({ query: query(group.length), variables }),
      },
      { signIn: signIn(repo.host), refused: refresh(repo.host) },
    )
    if ("problem" in answer) return answer.problem
    if ("absent" in answer) return new Map()
    const body = record(answer.body)
    if (body === undefined) return { kind: "unknown", said: "the answer was not an object" }
    const error = errorKind(body)
    const data = record(record(body["data"])?.["repository"])
    if (data === undefined) {
      if (error?.type === "NOT_FOUND") return new Map()
      if (error?.type === "RATE_LIMITED") return { kind: "limited", until: Date.now() + 60_000 }
      if (error?.type === "FORBIDDEN") return { kind: "refused", fix: refresh(repo.host) }
      return error === undefined ? new Map() : { kind: "unknown", said: error.message }
    }
    const blind = blinded(body)
    group.forEach((branch, index) => {
      const nodes = record(data[`p${index}`])?.["nodes"]
      if (!Array.isArray(nodes)) return
      const pull = choose(
        nodes.flatMap((node, nth) => candidate(node, blind.has(`p${index}/${nth}`)) ?? []),
      )
      if (pull !== undefined) found.set(branch, pull)
    })
    // One lookup of the runs for each pull request whose checks are unfinished.
    const unfinished = [...found].flatMap(([branch, pull]) => {
      const oid = heads.get(pull)
      return oid !== undefined && group.includes(branch) ? [{ branch, pull, oid }] : []
    })
    // eslint-disable-next-line no-await-in-loop -- Groups go one after another, to be gentle on the API.
    const enriched = await pooled(unfinished, ({ pull, oid }) =>
      withRunners(fetch, auth, repo, pull, oid),
    )
    unfinished.forEach(({ branch }, index) => found.set(branch, enriched[index]!))
  }
  return found
}

export const github: Forge = {
  name: "github",
  program: "gh",
  defaultHost,
  repository,
  signedIn,
  token,
  pullRequests,
  signIn,
}
