import { choose, time, type Candidate } from "./choose.js"
import { failure, offline, parse } from "./cli.js"
import type {
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

const states: Record<string, PullRequest["state"]> = {
  active: "open",
  completed: "merged",
  abandoned: "closed",
}

const candidate = (item: unknown, pageOf: (id: number) => string): Candidate | undefined => {
  const pr = record(item)
  if (pr === undefined || (pr["forkSource"] !== undefined && pr["forkSource"] !== null))
    return undefined
  const state = states[String(pr["status"])]
  const { pullRequestId: number, title } = pr
  if (state === undefined || typeof number !== "number" || typeof title !== "string")
    return undefined
  return {
    pull: {
      number,
      url: pageOf(number),
      title,
      state: state === "open" && pr["isDraft"] === true ? "draft" : state,
    },
    at: time(pr["closedDate"]) || time(pr["creationDate"]),
  }
}

// Build validation's policy type (https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/types).
const buildPolicy = "0609b952-1397-4640-95ec-e00a01b2c241"

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

// An open pull request's checks: its build policies' evaluations and its statuses. Never fails
// the lookup: a token that can't read them (403) leaves `ci` absent.
const ciOf = async (
  fetch: Fetch,
  auth: Token,
  root: string,
  base: string,
  number: number,
  projectId: string | undefined,
): Promise<Ci | undefined> => {
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
  for (const item of evaluations ?? []) {
    const evaluation = record(item)
    const policy = record(evaluation?.["configuration"])
    const type = record(policy?.["type"])
    if (policy?.["isEnabled"] === false) continue
    if (type?.["id"] !== buildPolicy && type?.["displayName"] !== "Build") continue
    const found = evaluated[String(evaluation?.["status"])]
    if (found !== undefined) signals.push(found)
  }
  const reports = listOf(statuses)
  if (reports === undefined) complete = false
  for (const item of reports ?? []) {
    const found = reported[String(record(item)?.["state"])]
    if (found !== undefined) signals.push(found)
  }
  return combine(signals, complete)
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
  // Two more requests for each open one.
  const open = [...found].filter(([, pull]) => pull.state === "open" || pull.state === "draft")
  const cis = await pooled(open, async ([branch, pull]) => ({
    branch,
    pull,
    ci: await ciOf(fetch, auth, root, base, pull.number, projects.get(pull.number)),
  }))
  for (const { branch, pull, ci } of cis) if (ci !== undefined) found.set(branch, { ...pull, ci })
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
