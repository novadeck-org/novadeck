/**
 * Whether Antigravity's PreToolUse hook is registered on this machine: it isn't on Windows where
 * cmd prints before hooks, and the install says so (`shell/install.ts`). Without it the shipping
 * gate neither refuses nor sees the commands Antigravity asks about, so it doesn't cover it.
 */
let registered = true

export const agyPreToolUse = (): boolean => registered

export const setAgyPreToolUse = (value: boolean): void => {
  registered = value
}
