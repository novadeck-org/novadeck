/**
 * Why the suite can't run here, or undefined where it can: Linux, Windows and macOS. On
 * Linux the sandbox's dead D-Bus address keeps a harness from the keyring. On Windows the
 * sandbox moves the user's folders too (see `createSandbox`), and on macOS each harness
 * that would read the login Keychain names its item after the sandbox's own folders
 * (Claude Code by `CLAUDE_CONFIG_DIR`) or is told to keep its login in a file there
 * (Codex). A harness whose login lives under a fixed name in a store no environment
 * moves, as Antigravity's does in Windows' Credential Manager and the macOS Keychain,
 * refuses to start while one is there (see `credentials.ts`).
 */
export const unsupported = (platform: NodeJS.Platform): string | undefined =>
  platform === "linux" || platform === "win32" || platform === "darwin"
    ? undefined
    : `The end-to-end suite runs on Linux, Windows and macOS, not ${platform}`
