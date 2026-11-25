import { choose, time, type Candidate } from "./choose.js"
import { failure, offline, parse } from "./cli.js"
import type {
  Check,
  Ci,
  Fetch,
  Forge,
  Problem,
  PullRequest,
  Ran,
  Remote,
  Repository,
  Review,
  Run,
  Token,
} from "./forge.js"
import { headers, pooled, record, send } from "./http.js"

const defaultHost = "gitlab.com"

const signIn = (host: string): string => `glab auth login --hostname ${host}`

const repository = (remote: Remote, hosts: readonly string[] = []): Repository | undefined => {
  if (remote.path.length < 2) return undefined
  if (remote.host !== defaultHost && !hosts.includes(remote.host)) return undefined
  return { forge: "gitlab", host: remote.host, path: remote.path.join("/") }
}

// The hosts a JSON status reports signed in: those with a user and no error.
const jsonHosts = (text: string): string[] | undefined => {
  const hosts = record(parse(text))?.["hosts"]
  if (!Array.isArray(hosts)) return undefined
  return hosts.flatMap((each) => {
    const host = record(each)
    return host !== undefined &&
      typeof host["host"] === "string" &&
      typeof host["user"] === "string" &&
      host["user"] !== "" &&
      host["error"] === undefined
      ? [host["host"]]
      : []
  })
}

// Everything a run wrote, out and error alike: glab reports its status on standard error.
const textOf = (ran: Ran): string => (ran.ok ? `${ran.out}\n${ran.said ?? ""}` : ran.said)

const signedIn: Forge["signedIn"] = async (run) => {
  // glab exits non-zero when any one host fails, yet still reports the others.
  const json = await run("glab", ["auth", "status", "--output", "json"])
  if (!json.ok && json.kind !== "exit")
    return failure(json, () => ({ kind: "unknown", said: json.said }))
  const reported = jsonHosts(json.ok ? json.out : json.said)
  if (reported !== undefined) return [...new Set(reported)]
  // An older glab without JSON: its text, as "✓ Logged in to gitlab.com as name (config)".
  const ran = await run("glab", ["auth", "status"])
  if (!ran.ok && ran.kind !== "exit")
    return failure(ran, () => ({ kind: "unknown", said: ran.said }))
  const hosts = [...textOf(ran).matchAll(/Logged in to (\S+)/g)].flatMap((match) => match[1] ?? [])
  return [...new Set(hosts)]
}

const usable = (value: string): string | undefined => {
  const text = value.trim()
  return text === "" || /^\*+$/.test(text) ? undefined : text
}

// The token a status shows: "Token found in <where>: <token>" (older: "Token: <token>").
const shownToken = (text: string): string | undefined => {
  const shown = /Token(?: found(?: in [^:\n]+)?)?:\s*(\S+)/.exec(text)?.[1]
  return shown === undefined ? undefined : usable(shown)
}

// The status asks the host who is signed in, which renews an OAuth login whose token ran out,
// and it reads the keyring a keyring login keeps its token in. What it writes is never passed
// on: with --show-token, it holds the token.
const token = async (run: Run, host: string): Promise<Token | Problem> => {
  const signedOut: Problem = { kind: "signed-out", fix: signIn(host) }
  const status = await run("glab", ["auth", "status", "--hostname", host, "--show-token"])
  // The status asks the host, so it fails offline too: that is no sign-out.
  if (!status.ok)
    return failure(status, (said) => (offline(said) ? { kind: "unreachable" } : signedOut))
  const shown = shownToken(textOf(status))
  if (shown !== undefined) return { value: shown }
  // A glab that shows no token line keeps it in its config.
  const direct = await run("glab", ["config", "get", "token", "--host", host])
  if (!direct.ok) return failure(direct, () => signedOut)
  const value = usable(direct.out)
  return value === undefined ? signedOut : { value }
}

const states: Record<string, PullRequest["state"]> = {
  opened: "open",
  locked: "open",
  merged: "merged",
  closed: "closed",
}

const candidate = (item: unknown): Candidate | undefined => {
  const mr = record(item)
  if (mr === undefined) return undefined
  if (mr["source_project_id"] !== mr["target_project_id"]) return undefined
  const state = states[String(mr["state"])]
  const { iid, web_url: url, title } = mr
  if (
    state === undefined ||
    typeof iid !== "number" ||
    typeof url !== "string" ||
    typeof title !== "string"
  ) {
    return undefined
  }
  const draft = state === "open" && (mr["draft"] === true || mr["work_in_progress"] === true)
  const target = mr["target_branch"]
  return {
    pull: {
      number: iid,
      url,
      title,
      state: draft ? "draft" : state,
      ...(typeof target === "string" && target !== "" && { base: target }),
    },
    at: time(mr["merged_at"]) || time(mr["closed_at"]) || time(mr["updated_at"]),
  }
}

// A pipeline's status (https://docs.gitlab.com/api/pipelines/); canceled, skipped and manual
// ones settle nothing, as no pipeline at all.
const pipelines: Record<string, Ci> = {
  failed: "failing",
  success: "passed",
  created: "running",
  waiting_for_resource: "running",
  preparing: "running",
  pending: "running",
  running: "running",
  scheduled: "running",
  canceled: "none",
  skipped: "none",
  manual: "none",
}

// An open merge request's pipeline, which only the single-request endpoint carries
// (`head_pipeline`, null where none ran), with its jobs, and where its review stands. Absent
// where it can't be read: this never fails the lookup, which already has the request itself.
const detailsOf = async (
  fetch: Fetch,
  auth: Token,
  repo: Repository & { readonly forge: "gitlab" },
  base: string,
  number: number,
): Promise<Pick<PullRequest, "ci" | "checks" | "review"> | undefined> => {
  const answer = await send(
    fetch,
    `${base}/${number}`,
    { headers: headers(auth.value) },
    { signIn: signIn(repo.host) },
  )
  if (!("body" in answer)) return undefined
  const mr = record(answer.body)
  const pipeline = record(mr?.["head_pipeline"])
  const status = pipeline?.["status"]
  const ci = (typeof status === "string" ? pipelines[status] : undefined) ?? "none"
  const id = pipeline?.["id"]
  const [checks, review] = await Promise.all([
    typeof id === "number" ? checksOf(fetch, auth, repo, id) : undefined,
    reviewOf(fetch, auth, base, repo, number, mr?.["detailed_merge_status"]),
  ])
  return {
    ci,
    ...(checks && checks.length > 0 && { checks }),
    ...(review !== undefined && { review }),
  }
}

// Where an open merge request's review stands: a reviewer's request for changes, as its merge
// status says (GitLab 17.1 and later), outranks approvals; then the approvals it still needs, as
// its approval rules count them (none on GitLab Free), and those it has. Where the approvals
// can't be read, only a merge status of `not_approved` says anything.
const reviewOf = async (
  fetch: Fetch,
  auth: Token,
  base: string,
  repo: Repository & { readonly forge: "gitlab" },
  number: number,
  status: unknown,
): Promise<Review | undefined> => {
  if (status === "requested_changes") return "changes_requested"
  const answer = await send(
    fetch,
    `${base}/${number}/approvals`,
    { headers: headers(auth.value) },
    { signIn: signIn(repo.host) },
  )
  const approvals = "body" in answer ? record(answer.body) : undefined
  if (approvals === undefined) return status === "not_approved" ? "required" : undefined
  const left = approvals["approvals_left"]
  if ((typeof left === "number" && left > 0) || status === "not_approved") return "required"
  const by = approvals["approved_by"]
  return Array.isArray(by) && by.length > 0 ? "approved" : "none"
}

// When a pending job was queued: the Jobs API has no `queued_at`, only `queued_duration`, the
// seconds it has waited; `created_at` is the fallback where that is absent.
const queuedSince = (job: Record<string, unknown>): number => {
  const waited = job["queued_duration"]
  if (typeof waited === "number" && Number.isFinite(waited) && waited >= 0)
    return Date.now() - waited * 1000
  return time(job["created_at"])
}

// A job's status (https://docs.gitlab.com/api/jobs/), as a check: a job `created` or
// `scheduled` waits on an earlier one, or a timer, not on a runner; one waiting for a resource
// waits on its resource group's earlier job. `preparing` has a runner, readying it. Manual and
// skipped jobs ran nothing and aren't listed, nor are ones waiting on an outside callback.
const jobStates: Record<string, { readonly state: Check["state"]; readonly hold?: Check["hold"] }> =
  {
    success: { state: "passed" },
    failed: { state: "failed" },
    canceled: { state: "failed" },
    canceling: { state: "failed" },
    running: { state: "running" },
    preparing: { state: "running" },
    pending: { state: "queued" },
    waiting_for_resource: { state: "held", hold: "concurrency" },
    created: { state: "held", hold: "earlier" },
    scheduled: { state: "held", hold: "earlier" },
  }

// A job's place in its pipeline: the API lists the newest job first.
const order = (job: Record<string, unknown>): number =>
  typeof job["id"] === "number" ? job["id"] : 0

// Each job of a list that is one, marked as a trigger job or not.
const records = (body: unknown[], bridge: boolean) =>
  body.flatMap((item) => {
    const job = record(item)
    return job === undefined ? [] : [{ job, bridge }]
  })

/** How many of a pipeline's jobs are asked. */
const jobsAsked = 100

// A pipeline's latest jobs (not those retried since), by job id (so a retried job comes last),
// with the tags that say what kind of runner each needs, and its trigger jobs, which the jobs
// list leaves out: one that triggered a child or downstream pipeline stands for it, held by it
// while it runs. A failed job allowed to fail passes, as its pipeline counts it. Never fails the
// lookup; trigger jobs that can't be read are left out.
const checksOf = async (
  fetch: Fetch,
  auth: Token,
  repo: Repository & { readonly forge: "gitlab" },
  pipeline: number,
): Promise<Check[] | undefined> => {
  const list = (kind: "jobs" | "bridges") =>
    send(
      fetch,
      `https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.path)}/pipelines/${pipeline}/${kind}?per_page=${jobsAsked}`,
      { headers: headers(auth.value) },
      { signIn: signIn(repo.host) },
    )
  const [answer, triggers] = await Promise.all([list("jobs"), list("bridges")])
  if (!("body" in answer) || !Array.isArray(answer.body)) return undefined
  const jobs = [
    ...records(answer.body, false),
    ...("body" in triggers && Array.isArray(triggers.body) ? records(triggers.body, true) : []),
  ]
  return jobs
    .toSorted((one, other) => order(one.job) - order(other.job))
    .flatMap(({ job, bridge }): Check[] => {
      const name = job["name"]
      const known = jobStates[String(job["status"])]
      if (typeof name !== "string" || known === undefined) return []
      if (known.state === "failed" && job["status"] === "failed" && job["allow_failure"] === true)
        return [{ name, state: "passed" }]
      if (known.state === "passed" || known.state === "failed")
        return [{ name, state: known.state }]
      // A trigger job runs on no runner: until its pipeline ends, that pipeline holds it.
      if (bridge) return [{ name, state: "held", hold: "downstream" }]
      if (known.state === "held") return [{ name, state: "held", hold: known.hold }]
      const running = known.state === "running"
      const at = running ? time(job["started_at"]) : queuedSince(job)
      const tags = Array.isArray(job["tag_list"])
        ? job["tag_list"].filter((tag): tag is string => typeof tag === "string")
        : []
      return [
        {
          name,
          state: known.state,
          ...(at > 0 && { since: at }),
          ...(tags.length > 0 && { runner: tags.join(" ") }),
        },
      ]
    })
}

const pullRequests: Forge["pullRequests"] = async (fetch, auth, repo, branches) => {
  if (repo.forge !== "gitlab") return { kind: "unknown", said: "not a GitLab repository" }
  const base = `https://${repo.host}/api/v4/projects/${encodeURIComponent(repo.path)}/merge_requests`
  const unique = [...new Set(branches)]
  const answers = await pooled(unique, async (branch) => ({
    branch,
    answer: await send(
      fetch,
      `${base}?source_branch=${encodeURIComponent(branch)}&state=all&order_by=created_at&sort=desc&per_page=20`,
      { headers: headers(auth.value) },
      { signIn: signIn(repo.host) },
    ),
  }))
  const found = new Map<string, PullRequest>()
  for (const { branch, answer } of answers) {
    if ("problem" in answer) return answer.problem
    if ("absent" in answer) return new Map()
    if (!Array.isArray(answer.body)) return { kind: "unknown", said: "the answer was not a list" }
    const pull = choose(answer.body.flatMap((item) => candidate(item) ?? []))
    if (pull !== undefined) found.set(branch, pull)
  }
  // A few more requests for each open one: itself, its pipeline's jobs and its approvals.
  const open = [...found].filter(([, pull]) => pull.state === "open" || pull.state === "draft")
  const details = await pooled(open, async ([branch, pull]) => ({
    branch,
    pull,
    more: await detailsOf(fetch, auth, repo, base, pull.number),
  }))
  for (const { branch, pull, more } of details)
    if (more !== undefined) found.set(branch, { ...pull, ...more })
  return found
}

export const gitlab: Forge = {
  name: "gitlab",
  program: "glab",
  defaultHost,
  repository,
  signedIn,
  token,
  pullRequests,
  signIn,
}
