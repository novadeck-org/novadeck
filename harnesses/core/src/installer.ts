/**
 * The command that installs a harness from its vendor's script, `url` being the script
 * the vendor publishes for the machine's shell: on Windows PowerShell's, run in a
 * PowerShell of its own, so the line works from cmd and from either PowerShell alike
 * (the script's own `irm … | iex` is PowerShell's); elsewhere `curl … | <shell>`, which
 * every shell Novadeck starts reads the same.
 */
export const scriptInstaller = (
  platform: NodeJS.Platform,
  script: { readonly posix: string; readonly shell: "bash" | "sh"; readonly windows: string },
): string =>
  platform === "win32"
    ? `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm ${script.windows} | iex"`
    : `curl -fsSL ${script.posix} | ${script.shell}`
