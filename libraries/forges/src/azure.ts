import { choose, time, type Candidate } from "./choose.js"
import { failure, offline, parse } from "./cli.js"
import type {
  Check,
  Ci,
  Fetch,
  Forge,
  Problem,
  PullRequest,
  Remote,
  Repository,
  Review,
  Run,
  Token,
} from "./forge.js"
import { headers, pooled, record, send } from "./http.js"

const defaultHost = "dev.azure.com"
const resource = "499b84ac-1321-427f-aa17-267ca6975798"

// Many who use only Azure DevOps have no Azure subscription, which a plain `az login` refuses.
const signIn = (): string => "az login --allow-no-subscriptions"

const tenantId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const noTenant = "00000000-0000-0000-0000-000000000000"

/**
 * A token `az` handed out that the organization turns away is most often from another tenant
 * than the organization's (TF400813), which a plain sign-in doesn't mend. Azure DevOps names the
 * organization's tenant in `X-VSS-ResourceTenant`; signing in to that one does.
 */
const unauthorized = (answered: Headers): Problem | undefined => {
  const tenant = (answered.get("x-vss-resourcetenant") ?? "")
    .split(",")
    .map((each) => each.trim().toLowerCase())
    .find((each) => tenantId.test(each) && each !== noTenant)
  return tenant === undefined
    ? undefined
    : { kind: "refused", fix: `${signIn()} --tenant ${tenant}` }
}

const suffix = ".visualstudio.com"

/**
 * Azure DevOps Services only. The host's name and the path's shape say it: `dev.azure.com`
 * (`org/project/_git/repo`, or `v3/org/project/repo` over ssh) and `org.visualstudio.com`
 * (`[DefaultCollection/]project/_git/repo`). Always answered as `dev.azure.com`, which serves
 * both.
 */
const repository = (remote: Remote): Repository | undefined => {
  const { host } = remote
  const path = [...remote.path]
  if (host === "ssh.dev.azure.com" || host === "vs-ssh.visualstudio.com") {
    const [version, organization, project, name] = path
    if (version !== "v3" || path.length !== 4 || !organization || !project || !name)
      return undefined
    return { forge: "azure", host: defaultHost, organization, project, name }
  }
  if (host === defaultHost) {
    const [organization, project, git, name] = path
    // `org/_git/repo` is the project of the repository's own name.
    if (organization && project === "_git" && git && path.length === 3) {
      return { forge: "azure", host: defaultHost, organization, project: git, name: git }
    }
    if (!organization || !project || git !== "_git" || !name || path.length !== 4) return undefined
    return { forge: "azure", host: defaultHost, organization, project, name }
  }
  if (host.endsWith(suffix) && host.length > suffix.length) {
    const organization = host.slice(0, -suffix.length)
    if (organization.includes(".")) return undefined
    const parts = path[0]?.toLowerCase() === "defaultcollection" ? path.slice(1) : path
    const [project, git, name] = parts
    if (parts.length === 2 && project === "_git" && git) {
      return { forge: "azure", host: defaultHost, organization, project: git, name: git }
    }
    if (!project || git !== "_git" || !name || parts.length !== 3) return undefined
    return { forge: "azure", host: defaultHost, organization, project, name }
  }
  return undefined
}

const signedIn: Forge["signedIn"] = async (run) => {
  const ran = await run("az", ["account", "show", "-o", "json"])
  if (ran.ok) return [defaultHost]
  // Signed out exits non-zero ("Please run 'az login'"): no hosts, not a problem.
  return ran.kind === "exit" ? [] : failure(ran, () => ({ kind: "unknown", said: ran.said }))
}

const expiry = (body: Record<string, unknown>): number | undefined => {
  const seconds = Number(body["expires_on"])
  if (body["expires_on"] !== undefined && Number.isFinite(seconds)) return seconds * 1000
  // `expiresOn` is local time without a zone ("2026-11-15 10:00:00.000000").
  const parsed =
    typeof body["expiresOn"] === "string" ? Date.parse(body["expiresOn"].replace(" ", "T")) : NaN
  return Number.isNaN(parsed) ? undefined : parsed
}

const token = async (run: Run, _host: string): Promise<Token | Problem> => {
  const ran = await run("az", ["account", "get-access-token", "--resource", resource, "-o", "json"])
  // A token past its hour is renewed over the network, so this fails offline too.
  if (!ran.ok)
    return failure(ran, (said) =>
      offline(said) ? { kind: "unreachable" } : { kind: "signed-out", fix: signIn() },
    )
  const body = record(parse(ran.out))
  const value = body?.["accessToken"]
  if (body === undefined || typeof value !== "string" || value === "") {
    return { kind: "signed-out", fix: signIn() }
  }
  const expiresAt = expiry(body)
  return expiresAt === undefined ? { value } : { value, expiresAt }
}

const count = (value: unknown): number => (typeof value === "number" ? value : 0)

const states: Record<string, PullRequest["state"]> = {
  active: "open",
  completed: "merged",
  abandoned: "closed",
}

// Where review stands by the reviewers' votes (10 approved, 5 approved with suggestions, 0 no
// vote, -5 waiting for the author, -10 rejected): a rejection or a wait for the author outranks
// approvals; a required reviewer who hasn't voted leaves it required.
const votesOf = (reviewers: unknown): Review => {
  const each = Array.isArray(reviewers)
    ? reviewers.flatMap((reviewer) => {
        const one = record(reviewer)
        return one === undefined || one["hasDeclined"] === true
          ? []
          : [{ vote: count(one["vote"]), required: one["isRequired"] === true }]
      })
    : []
  if (each.some(({ vote }) => vote < 0)) return "changes_requested"
  if (each.some(({ vote, required }) => required && vote === 0)) return "required"
  return each.some(({ vote }) => vote > 0) ? "approved" : "none"
}

const candidate = (item: unknown, pageOf: (id: number) => string): Candidate | undefined => {
  const pr = record(item)
  if (pr === undefined || (pr["forkSource"] !== undefined && pr["forkSource"] !== null))
    return undefined
  const state = states[String(pr["status"])]
  const { pullRequestId: number, title } = pr
  if (state === undefined || typeof number !== "number" || typeof title !== "string")
    return undefined
  const target = pr["targetRefName"]
  const base = typeof target === "string" ? target.replace(/^refs\/heads\//, "") : ""
  return {
    pull: {
      number,
      url: pageOf(number),
      title,
      state: state === "open" && pr["isDraft"] === true ? "draft" : state,
      ...(base !== "" && { base }),
      ...(state === "open" && { review: votesOf(pr["reviewers"]) }),
    },
    at: time(pr["closedDate"]) || time(pr["creationDate"]),
  }
}

// Build validation's and minimum number of reviewers' policy types
// (https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/types).
const buildPolicy = "0609b952-1397-4640-95ec-e00a01b2c241"
const reviewersPolicy = "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd"

// Each policy evaluation's status (…/policy/evaluations/list), for Build policies only; and each
// status's state (…/git/pull-request-statuses/list). `broken`, `notApplicable` and `notSet`
// say nothing of the checks.
const evaluated: Record<string, Ci> = {
  rejected: "failing",
  queued: "running",
  running: "running",
  approved: "passed",
}
const reported: Record<string, Ci> = {
  failed: "failing",
  error: "failing",
  pending: "running",
  succeeded: "passed",
  partiallySucceeded: "passed",
}
const statusChecks: Record<string, Check["state"]> = {
  failed: "failed",
  error: "failed",
  pending: "running",
  succeeded: "passed",
  partiallySucceeded: "passed",
}

const rank: readonly Ci[] = ["failing", "running", "passed"]

// What the signals come to: the worst of them. Where one couldn't be read, only a failing or
// running one still says something; "passed" or "none" would be a guess.
const combine = (signals: readonly Ci[], complete: boolean): Ci | undefined => {
  const worst = rank.find((each) => signals.includes(each))
  if (worst === "failing" || worst === "running") return worst
  return complete ? (worst ?? "none") : undefined
}

const part = (text: string): string => encodeURIComponent(text)

/** What an open pull request's policies and statuses say. */
type Standing = {
  readonly ci: Ci | undefined
  // Its statuses' checks, the newest of each context; absent where they couldn't be read.
  readonly reported: readonly Check[] | undefined
  // Whether a minimum number of reviewers policy is yet to be met.
  readonly reviewersMissing: boolean
}

// An open pull request's checks: its build policies' evaluations and its statuses. Never fails
// the lookup: a token that can't read them (403) leaves `ci` absent.
const ciOf = async (
  fetch: Fetch,
  auth: Token,
  root: string,
  base: string,
  number: number,
  projectId: string | undefined,
): Promise<Standing> => {
  const get = (url: string) =>
    send(
      fetch,
      url,
      { headers: headers(auth.value), redirect: "manual" },
      { signIn: signIn(), unauthorized },
    )
  const artifact = `vstfs:///CodeReview/CodeReviewId/${projectId ?? ""}/${number}`
  const [policies, statuses] = await Promise.all([
    projectId === undefined
      ? undefined
      : get(
          `${root}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifact)}&api-version=7.1-preview.1`,
        ),
    get(`${base}/${number}/statuses?api-version=7.1`),
  ])
  const signals: Ci[] = []
  let complete = true
  const listOf = (answer: typeof policies): unknown[] | undefined => {
    const list =
      answer !== undefined && "body" in answer ? record(answer.body)?.["value"] : undefined
    return Array.isArray(list) ? list : undefined
  }
  const evaluations = listOf(policies)
  if (evaluations === undefined) complete = false
  // Only the current evaluation of each policy counts: the newest started.
  const current = new Map<string, { at: number; found: Ci | undefined }>()
  let reviewersMissing = false
  for (const item of evaluations ?? []) {
    const evaluation = record(item)
    const policy = record(evaluation?.["configuration"])
    const type = record(policy?.["type"])
    if (policy?.["isEnabled"] === false) continue
    if (type?.["id"] === reviewersPolicy && policy?.["isBlocking"] !== false) {
      if (evaluation?.["status"] === "queued" || evaluation?.["status"] === "rejected")
        reviewersMissing = true
      continue
    }
    if (type?.["id"] !== buildPolicy && type?.["displayName"] !== "Build") continue
    const key = String(policy?.["id"] ?? evaluation?.["evaluationId"])
    const at = time(evaluation?.["startedDate"])
    const known = current.get(key)
    if (known === undefined || at >= known.at)
      current.set(key, { at, found: evaluated[String(evaluation?.["status"])] })
  }
  for (const { found } of current.values()) if (found !== undefined) signals.push(found)
  const reports = listOf(statuses)
  if (reports === undefined) complete = false
  // The list is the whole history, across iterations and repeated posts: only the newest status
  // of each context (genre and name) counts, the latest iteration's first, then the highest id.
  const newest = new Map<
    string,
    { order: [number, number]; found: Ci | undefined; check: Check | undefined }
  >()
  for (const item of reports ?? []) {
    const report = record(item)
    const context = record(report?.["context"])
    const genre = typeof context?.["genre"] === "string" ? context["genre"] : ""
    const name = typeof context?.["name"] === "string" ? context["name"] : ""
    const key = `${genre}/${name}`
    const order: [number, number] = [count(report?.["iterationId"]), count(report?.["id"])]
    const known = newest.get(key)
    if (
      known === undefined ||
      order[0] > known.order[0] ||
      (order[0] === known.order[0] && order[1] >= known.order[1])
    ) {
      const state = statusChecks[String(report?.["state"])]
      const named = genre === "" ? name : name === "" ? genre : `${genre}/${name}`
      newest.set(key, {
        order,
        found: reported[String(report?.["state"])],
        check: state === undefined || named === "" ? undefined : { name: named, state },
      })
    }
  }
  for (const { found } of newest.values()) if (found !== undefined) signals.push(found)
  return {
    ci: combine(signals, complete),
    reported:
      reports === undefined ? undefined : [...newest.values()].flatMap(({ check }) => check ?? []),
    reviewersMissing,
  }
}

// The kind of runner a build needs: its own agent pool; for the hosted pool, which is named
// "Azure Pipelines" whatever the image, the agent specification where the build says one
// (`ubuntu-latest`), else none, so the check is listed under the unnamed kind.
const runnerOf = (build: Record<string, unknown>): string | undefined => {
  const pool = record(record(build["queue"])?.["pool"])
  const name = pool?.["name"]
  if (typeof name !== "string" || name === "") return undefined
  if (pool?.["isHosted"] !== true && name !== "Azure Pipelines") return name
  const image = record(build["agentSpecification"])?.["identifier"]
  return typeof image === "string" && image !== "" ? image : undefined
}

// A build's status, and a completed one's result, as a check: one not started, or postponed,
// waits for an agent; one cancelling is cancelled, so failed. A result of `none` says nothing.
const buildStates: Record<string, Check["state"]> = {
  notStarted: "queued",
  postponed: "queued",
  inProgress: "running",
  cancelling: "failed",
}
const buildResults: Record<string, Check["state"]> = {
  succeeded: "passed",
  partiallySucceeded: "passed",
  failed: "failed",
  canceled: "failed",
}

/** How many of a pull request's builds are asked, newest first. */
const buildsAsked = 100

// The builds of a pull request's merge ref, the newest of each pipeline (the list comes newest
// first), in the list's order: each unfinished one with the agent pool it needs, which is the
// kind of runner Azure names. Never fails the lookup.
const checksOf = async (
  fetch: Fetch,
  auth: Token,
  root: string,
  number: number,
): Promise<Check[] | undefined> => {
  const answer = await send(
    fetch,
    `${root}/_apis/build/builds?branchName=${encodeURIComponent(`refs/pull/${number}/merge`)}&queryOrder=queueTimeDescending&$top=${buildsAsked}&api-version=7.1`,
    { headers: headers(auth.value), redirect: "manual" },
    { signIn: signIn(), unauthorized },
  )
  const list = "body" in answer ? record(answer.body)?.["value"] : undefined
  if (!Array.isArray(list)) return undefined
  const newest = new Map<string, Check | undefined>()
  for (const item of list) {
    const build = record(item)
    const definition = record(build?.["definition"])
    const name = definition?.["name"]
    if (build === undefined || typeof name !== "string") continue
    const key = String(definition?.["id"] ?? name)
    if (newest.has(key)) continue
    const status = String(build["status"])
    const state =
      status === "completed" ? buildResults[String(build["result"])] : buildStates[status]
    if (state === undefined || state === "passed" || state === "failed") {
      newest.set(key, state && { name, state })
      continue
    }
    const at = state === "running" ? time(build["startTime"]) : time(build["queueTime"])
    const runner = runnerOf(build)
    newest.set(key, {
      name,
      state,
      ...(at > 0 && { since: at }),
      ...(runner !== undefined && { runner }),
    })
  }
  return [...newest.values()].flatMap((check) => check ?? [])
}

const pullRequests: Forge["pullRequests"] = async (fetch, auth, repo, branches) => {
  if (repo.forge !== "azure") return { kind: "unknown", said: "not an Azure DevOps repository" }
  const root = `https://${repo.host}/${part(repo.organization)}/${part(repo.project)}`
  const base = `${root}/_apis/git/repositories/${part(repo.name)}/pullrequests`
  const pageOf = (id: number): string => `${root}/_git/${part(repo.name)}/pullrequest/${id}`
  const unique = [...new Set(branches)]
  const answers = await pooled(unique, async (branch) => ({
    branch,
    answer: await send(
      fetch,
      `${base}?searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=20&api-version=7.1`,
      // An expired token is answered with a redirect or a 203 sign-in page, not a 401.
      { headers: headers(auth.value), redirect: "manual" },
      { signIn: signIn(), unauthorized },
    ),
  }))
  const found = new Map<string, PullRequest>()
  // The id of each pull request's project, which a policy evaluation's artifact names.
  const projects = new Map<number, string>()
  for (const { branch, answer } of answers) {
    if ("problem" in answer) return answer.problem
    if ("absent" in answer) return new Map()
    const list = record(answer.body)?.["value"]
    if (!Array.isArray(list)) return { kind: "signed-out", fix: signIn() }
    for (const item of list) {
      const id = record(item)?.["pullRequestId"]
      const project = record(record(record(item)?.["repository"])?.["project"])?.["id"]
      if (typeof id === "number" && typeof project === "string") projects.set(id, project)
    }
    const pull = choose(list.flatMap((item) => candidate(item, pageOf) ?? []))
    if (pull !== undefined) found.set(branch, pull)
  }
  // Three more requests for each open one: its policies, its statuses and its builds.
  const open = [...found].filter(([, pull]) => pull.state === "open" || pull.state === "draft")
  const read = await pooled(open, async ([branch, pull]) => {
    const [standing, builds] = await Promise.all([
      ciOf(fetch, auth, root, base, pull.number, projects.get(pull.number)),
      checksOf(fetch, auth, root, pull.number),
    ])
    return { branch, pull, standing, builds }
  })
  for (const { branch, pull, standing, builds } of read) {
    const { ci, reviewersMissing } = standing
    const posted = standing.reported
    // A pull request no vote holds back still needs the reviewers its policy asks for.
    const review =
      reviewersMissing && pull.review !== "changes_requested" ? "required" : pull.review
    const checks =
      builds === undefined && posted === undefined
        ? undefined
        : [...(builds ?? []), ...(posted ?? [])]
    found.set(branch, {
      ...pull,
      ...(ci !== undefined && { ci }),
      ...(ci !== undefined && checks && checks.length > 0 && { checks }),
      ...(review !== undefined && { review }),
    })
  }
  return found
}

export const azure: Forge = {
  name: "azure",
  program: "az",
  defaultHost,
  repository,
  signedIn,
  token,
  pullRequests,
  signIn,
}
