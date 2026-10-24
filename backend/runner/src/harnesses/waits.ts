// A command means the same whichever agent ran it, so what tells a wait from a server
// left running is judged here, not in a harness.

// A script name a package manager runs that serves or watches until stopped: `dev`,
// `start:web`, `test:watch`, `watch:css`; not `dev:build` or `start:test`.
const serving =
  /^(?:(?:dev|start|serve|preview|watch|storybook)(?::(?!(?:build|test|lint|check|format|types?|clean|e2e|deploy|install|generate|migrate)\b)\S+)?|\S+:watch|watch:\S+)$/

// What a command may be run through before the program it starts: variables, wrappers,
// and a package runner, each with the flags it takes alone.
const wrappers =
  /^(?:(?:[A-Za-z_]\w*=\S*|nohup|exec|time|command|sudo|stdbuf|env|cross-env|npx|pnpx|bunx|uvx|pnpm\s+(?:exec|dlx)|yarn\s+dlx|uv\s+run|poetry\s+run|pipenv\s+run|pipx\s+run|bundle\s+exec)(?:\s+-{1,2}[\w-]+)*\s+)+/

// Programs that serve or watch until stopped, whatever they are given.
const programs = new Set([
  "nodemon",
  "ts-node-dev",
  "webpack-dev-server",
  "http-server",
  "live-server",
  "serve",
  "uvicorn",
  "gunicorn",
  "hypercorn",
  "daphne",
  "streamlit",
  "ngrok",
  "watchexec",
  "entr",
  "watch",
  "air",
  "journalctl",
])

// A program and the subcommand that serves or watches until stopped.
const subcommands: Readonly<Record<string, RegExp>> = {
  vite: /^(?:dev|serve|preview|optimize)?$/,
  next: /^(?:dev|start)$/,
  astro: /^(?:dev|preview)$/,
  nuxt: /^(?:dev|preview)$/,
  nuxi: /^(?:dev|preview)$/,
  remix: /^dev$/,
  ng: /^serve$/,
  expo: /^start$/,
  storybook: /^dev$/,
  wrangler: /^dev$/,
  webpack: /^serve$/,
  tsx: /^watch$/,
  cargo: /^watch$/,
  rails: /^(?:server|s)$/,
  flask: /^run$/,
  hugo: /^server$/,
  jekyll: /^serve$/,
  mkdocs: /^serve$/,
  cloudflared: /^tunnel$/,
  fastapi: /^(?:dev|run)$/,
  jupyter: /^(?:lab|notebook|server)$/,
  "django-admin": /^runserver$/,
}

// Flags that take the word after them, which is no subcommand.
const valued = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "-C",
  "--dir",
  "--prefix",
  "--filter",
  "-F",
  "-n",
  "--namespace",
  "--context",
  "-H",
  "--host",
  "-c",
  "--workspace",
])

const packageManagers = new Set(["npm", "pnpm", "yarn", "bun"])

const serves = (program: string, subcommand = ""): boolean =>
  subcommands[program]?.test(subcommand) ?? false

// A flag that tells any tool to watch or hot-reload, unless it is set to false.
const watching = /^--(?:watch(?:-path|All|man)?|hot)(?:=(?!false$|0$).*)?$/

/** The commands a script runs, one by one; text in quotes is not one, except a shell's `-c`. */
const segments = (command: string): string[] => {
  const inner: string[] = []
  const plain = command
    .replace(
      /\b(?:ba|z|da)?sh\s+(?:-\w+\s+)*-\w*c\s+(["'])([\s\S]*?)\1/g,
      (_, __, body: string) => {
        inner.push(body)
        return " "
      },
    )
    .replace(/(["'])(?:\\.|(?!\1)[\s\S])*\1/g, '""')
    .replace(/\d*>&\d+|&>/g, " ")
  return [
    ...plain
      .split(/&&|\|\||[;|&\n(){}]/)
      .map((segment) => segment.trim().replace(/^(?:do|then|else)\s+/, ""))
      .filter((segment) => segment !== ""),
    ...inner.flatMap(segments),
  ]
}

/** The words of an invocation that are no flag, nor a flag's value. */
const positional = (words: readonly string[]): string[] =>
  words.flatMap((word, index) =>
    word === "" ||
    word.startsWith("-") ||
    (index > 0 && valued.has(words[index - 1]!) && !words[index - 1]!.includes("="))
      ? []
      : [word],
  )

/** Whether one command serves or watches until stopped. */
const runsForEver = (segment: string): boolean => {
  const words = segment.replace(wrappers, "").split(/\s+/)
  const program = words[0]?.split("/").pop() ?? ""
  const rest = words.slice(1)
  const flags = new Set(rest.filter((word) => word.startsWith("-")))
  const args = positional(rest)
  const detached = flags.has("-d") || flags.has("--detach")
  // gh's `--watch` and `watch` end once the run or the checks do, and a timeout bounds
  // whatever it runs.
  if (program === "gh" || program === "timeout") return false
  if (packageManagers.has(program)) {
    // `npm run dev`, `pnpm dev`, `pnpm --filter web dev`; or a binary it runs, `pnpm vite`.
    const named = args.filter((word) => word !== "run" && word !== "exec" && word !== "x")
    if (named.some((word) => serving.test(word))) return true
    const binary = named[0]
    if (
      binary !== undefined &&
      !flags.has("--watch") &&
      runsForEver(`${binary} ${rest.slice(rest.indexOf(binary) + 1).join(" ")}`)
    )
      return true
  }
  if (program === "tail" || program === "journalctl")
    return [...flags].some((flag) => /^-[a-zA-Z]*[fF]|^--follow/.test(flag))
  if (program === "sleep") return args[0] === "infinity"
  if (/^python[\d.]*$/.test(program)) {
    const module = rest.indexOf("-m")
    if (module >= 0 && rest[module + 1] === "http.server") return true
    if (module >= 0 && rest[module + 1] && runsForEver(rest.slice(module + 1).join(" ")))
      return true
    return rest.some((word) => word.endsWith("manage.py")) && args.includes("runserver")
  }
  if (program === "tsc") return flags.has("--watch") || flags.has("-w")
  if (program === "deno" && args[0] === "task" && serving.test(args[1] ?? "")) return true
  if (program === "turbo" && args.some((word) => serving.test(word))) return true
  if (program === "make") return /^(?:dev|serve|run|watch)$/.test(args[0] ?? "")
  if (program === "php") return flags.has("-S") || (args[0] === "artisan" && args[1] === "serve")
  const finite = flags.has("--abort-on-container-exit") || flags.has("--exit-code-from")
  if (program === "docker" || program === "docker-compose") {
    const kind = program === "docker" ? args.slice(0, 2) : ["compose", ...args.slice(0, 1)]
    if (kind[0] === "compose" && kind[1] === "up")
      return !detached && !finite && !flags.has("--wait")
    if (kind[0] === "compose" && args.includes("logs"))
      return flags.has("-f") || flags.has("--follow")
    return args[0] === "logs" && (flags.has("-f") || flags.has("--follow"))
  }
  if (program === "kubectl") {
    if (args[0] === "port-forward") return true
    if (args[0] === "logs") return flags.has("-f") || flags.has("--follow")
    if (args[0] === "get") return flags.has("-w") || flags.has("--watch")
    // A rollout's status ends with the rollout, watched or not.
    if (args[0] === "rollout") return false
  }
  if (programs.has(program)) return true
  if (program === "bun" && flags.has("--hot")) return true
  if (serves(program, rest[0]?.startsWith("-") ? "" : rest[0])) return true
  // Any other tool told to watch.
  return [...flags].some((flag) => watching.test(flag))
}

/**
 * Whether a command may run for ever once started, as a dev server, a watch mode or a
 * tunnel does: an agent that ended its turn with it running isn't waiting for it to finish.
 * A command that runs one of them anywhere in its script counts, whatever else it does,
 * unless a `timeout` bounds it.
 */
export const endless = (command: string): boolean => {
  // A loop that never ends by its condition is endless unless the script leaves it.
  const leaves = /\b(?:break|exit)\b/.test(command)
  return segments(command).some((segment) =>
    /^while\s+(?:true|:)$/.test(segment) ? !leaves : runsForEver(segment),
  )
}
