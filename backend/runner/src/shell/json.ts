// The guard for a JSON object, and the type of its fields, shared by the shell's hook, MCP and report code.

export type Fields = { readonly [key: string]: unknown }

/** Whether `value` is a JSON object: not null, not an array. */
export const object = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value)
