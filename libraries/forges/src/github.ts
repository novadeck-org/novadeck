import { choose, time, type Candidate } from "./choose.js"
import { failure, parse } from "./cli.js"
import type { Forge, Problem, PullRequest, Remote, Repository, Run, Token } from "./forge.js"
import { headers, record, send } from "./http.js"

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
      `p${at}: pullRequests(headRefName: $b${at}, states: [OPEN, MERGED, CLOSED], first: 20, orderBy: {field: CREATED_AT, direction: DESC}) { nodes { number url title isDraft state mergedAt closedAt isCrossRepository } }`,
  ).join(" ")
  return `query($owner: String!, $name: String!, ${vars}) { repository(owner: $owner, name: $name) { ${fields} } }`
}

const states: Record<string, PullRequest["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
}

// A pull request from the repository itself; one from a fork, whose branch may share the name,
// is not the work's. Asked of GitHub rather than compared by name, which a renamed repository's
// remote still has the old of.
const candidate = (node: unknown): Candidate | undefined => {
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
  return {
    pull: {
      number,
      url,
      title,
      state: state === "open" && pr["isDraft"] === true ? "draft" : state,
    },
    at: time(pr["mergedAt"]) || time(pr["closedAt"]),
  }
}

const errorKind = (
  body: Record<string, unknown>,
): { type: string; message: string } | undefined => {
  const first = record(Array.isArray(body["errors"]) ? body["errors"][0] : undefined)
  if (first === undefined) return undefined
  return { type: String(first["type"] ?? ""), message: String(first["message"] ?? "") }
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
    group.forEach((branch, index) => {
      const nodes = record(data[`p${index}`])?.["nodes"]
      if (!Array.isArray(nodes)) return
      const pull = choose(nodes.flatMap((node) => candidate(node) ?? []))
      if (pull !== undefined) found.set(branch, pull)
    })
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
