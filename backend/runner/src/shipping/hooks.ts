/**
 * Whether Antigravity has its PreToolUse hook on this machine: on Windows where cmd prints before
 * hooks its global plugin registers none, and only Novadeck's terminals get it, through its shim,
 * once Novadeck's cmd.exe pass-through and the folder holding the hook are in place
 * (`shell/install.ts`). Without it the shipping gate neither refuses nor sees the commands
 * Antigravity asks about, so it doesn't cover it.
 */
let registered = true

export const agyPreToolUse = (): boolean => registered

export const setAgyPreToolUse = (value: boolean): void => {
  registered = value
}
