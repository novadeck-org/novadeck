// What a backend knows of a terminal's foreground process, as the runner reports it:
// its name, and its command line where the platform tells.
export type ForegroundProcess = {
  readonly name: string
  readonly argv: readonly string[] | null
}

// Programs that wait for commands rather than doing work of their own.
const shells = new Set([
  "bash",
  "zsh",
  "fish",
  "sh",
  "dash",
  "ksh",
  "mksh",
  "tcsh",
  "csh",
  "ash",
  "pwsh",
  "powershell",
  "cmd",
  "nu",
  "elvish",
  "xonsh",
])

// Node CLIs whose foreground process is "node": the script it runs names the program,
// either the package's entry point or an installed launcher named after the program.
const nodeLaunchers: readonly { readonly script: string; readonly program: string }[] = [
  { script: "/@openai/codex/bin/codex.js", program: "codex" },
  { script: "/@anthropic-ai/claude-code/cli.js", program: "claude" },
]
const nodePrograms = new Set(nodeLaunchers.map((launcher) => launcher.program))

// "/usr/bin/zsh", "-zsh" (a login shell) and "pwsh.exe" all name the program "zsh" or "pwsh".
const baseName = (path: string): string =>
  (path.split(/[\\/]/).at(-1) ?? path)
    .replace(/^-/, "")
    .replace(/\.exe$/i, "")
    .toLowerCase()

const launchedProgram = (script: string): string | undefined => {
  const path = script.replaceAll("\\", "/")
  const name = path.split("/").at(-1)!
  if (nodePrograms.has(name)) return name
  return nodeLaunchers.find((launcher) => path.endsWith(launcher.script))?.program
}

// The program a terminal runs, as the UI knows it: the process's normalized name, or for
// Node the known CLI it launched. Only argv[1], the script Node executes, counts; later
// arguments may mention another program without changing what runs.
export const programName = ({ name, argv }: ForegroundProcess): string => {
  const program = baseName(name)
  const script = argv?.[1]
  if ((program !== "node" && program !== "nodejs") || !script) return program
  return launchedProgram(script) ?? program
}

// Takes a name from `programName`.
export const isShellProcess = (program: string): boolean => shells.has(program)
