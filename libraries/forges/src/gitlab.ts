import { choose, time, type Candidate } from "./choose.js"
import { failure, offline, parse } from "./cli.js"
import type {
  Ci,
  Fetch,
  Forge,
  Problem,
  PullRequest,
  Ran,
  Remote,
  Repository,
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
  return {
    pull: { number: iid, url, title, state: draft ? "draft" : state },
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
// (`head_pipeline`, null where none ran). Absent where it can't be read: this never fails the
// lookup, which already has the request itself.
const ciOf = async (
  fetch: Fetch,
  auth: Token,
  repo: Repository & { readonly forge: "gitlab" },
  base: string,
  number: number,
): Promise<Ci | undefined> => {
  const answer = await send(
    fetch,
    `${base}/${number}`,
    { headers: headers(auth.value) },
    { signIn: signIn(repo.host) },
  )
  if (!("body" in answer)) return undefined
  const pipeline = record(record(answer.body)?.["head_pipeline"])
  if (pipeline === undefined) return "none"
  const status = pipeline["status"]
  return (typeof status === "string" ? pipelines[status] : undefined) ?? "none"
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
  // One more request for each open one.
  const open = [...found].filter(([, pull]) => pull.state === "open" || pull.state === "draft")
  const cis = await pooled(open, async ([branch, pull]) => ({
    branch,
    pull,
    ci: await ciOf(fetch, auth, repo, base, pull.number),
  }))
  for (const { branch, pull, ci } of cis) if (ci !== undefined) found.set(branch, { ...pull, ci })
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
