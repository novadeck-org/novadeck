// A command means the same whichever agent ran it, so what tells a wait from a server
// left running is judged here, not in a harness.

// A script name a package manager runs that serves or watches until stopped.
const serving = /^(?:dev|start|serve|preview|watch|storybook)(?::\S+)?$/

// What a command may be run through before the program it starts: variables, wrappers,
// and a package runner.
const wrappers =
  /^(?:(?:[A-Za-z_]\w*=\S*|nohup|exec|time|command|sudo|stdbuf\s+-\S+|env|npx|pnpx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)(?:\s+(?:-y|--yes|--no-install))?\s+)+/

// Programs that serve or watch until stopped, whatever they are given.
const programs = new Set([
  "nodemon",
  "ts-node-dev",
  "webpack-dev-server",
  "http-server",
  "live-server",
  "uvicorn",
  "gunicorn",
  "hypercorn",
  "daphne",
  "ngrok",
  "watchexec",
  "entr",
  "watch",
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
}

const serves = (program: string, subcommand = ""): boolean =>
  subcommands[program]?.test(subcommand) ?? false

/** The commands a pipeline or script runs, one by one, each as its program and arguments. */
const segments = (command: string): string[] =>
  command
    .replace(/\d*>&\d+|&>/g, " ")
    .split(/&&|\|\||[;|&\n(){}]/)
    .map((segment) => segment.trim().replace(/^(?:do|then|else)\s+/, ""))
    .filter((segment) => segment !== "")

/** Whether one command serves or watches until stopped. */
const runsForEver = (segment: string): boolean => {
  const words = segment.replace(wrappers, "").split(/\s+/)
  const program = words[0]?.split("/").pop() ?? ""
  const rest = words.slice(1)
  const flags = new Set(rest.filter((word) => word.startsWith("-")))
  const subcommand = rest.filter((word) => !word.startsWith("-"))
  // gh's `--watch` and `watch` end once the run or the checks do.
  if (program === "gh") return false
  // `npm run dev`, `pnpm dev`, `pnpm --filter web dev`.
  if (["npm", "pnpm", "yarn", "bun"].includes(program) && subcommand.some((w) => serving.test(w)))
    return true
  if (program === "tail") return [...flags].some((flag) => /^-[a-zA-Z]*[fF]|^--follow/.test(flag))
  if (program === "sleep") return subcommand[0] === "infinity"
  if (program === "python" || program === "python3")
    return rest.join(" ").includes("-m http.server")
  if (program === "tsc") return flags.has("--watch") || flags.has("-w")
  if (program === "node" || program === "deno") return flags.has("--watch")
  const detached = flags.has("-d") || flags.has("--detach")
  if (program === "docker" && subcommand[0] === "compose" && subcommand[1] === "up")
    return !detached
  if (program === "docker-compose" && subcommand[0] === "up") return !detached
  if (program === "php" && flags.has("-S")) return true
  if (programs.has(program) || serves(program, rest[0]?.startsWith("-") ? "" : rest[0])) return true
  // Any other tool told to watch.
  return [...flags].some((flag) => /^--watch(?:All|man)?(?:=true)?$/.test(flag))
}

/**
 * Whether a command may run for ever once started, as a dev server, a watch mode or a
 * tunnel does: an agent that ended its turn with it running isn't waiting for it to finish.
 * A command that runs one of them anywhere in its script counts, whatever else it does.
 */
export const endless = (command: string): boolean => segments(command).some(runsForEver)
