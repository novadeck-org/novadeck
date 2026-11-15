import { choose, time, type Candidate } from "./choose.js"
import { failure, parse } from "./cli.js"
import type { Forge, Problem, PullRequest, Remote, Repository, Run, Token } from "./forge.js"
import { headers, pooled, record, send } from "./http.js"

const defaultHost = "dev.azure.com"
const resource = "499b84ac-1321-427f-aa17-267ca6975798"

const signIn = (): string => "az login"

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
  if (!ran.ok) return failure(ran, () => ({ kind: "signed-out", fix: signIn() }))
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

const part = (text: string): string => encodeURIComponent(text)

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
      { signIn: signIn() },
    ),
  }))
  const found = new Map<string, PullRequest>()
  for (const { branch, answer } of answers) {
    if ("problem" in answer) return answer.problem
    if ("absent" in answer) return new Map()
    const list = record(answer.body)?.["value"]
    if (!Array.isArray(list)) return { kind: "signed-out", fix: signIn() }
    const pull = choose(list.flatMap((item) => candidate(item, pageOf) ?? []))
    if (pull !== undefined) found.set(branch, pull)
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
