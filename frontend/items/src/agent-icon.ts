import { isNova } from "@novadeck/core/terminals/agent-look"
import { AntigravityIcon } from "@novadeck/toolkit/icons/AntigravityIcon"
import { ClaudeIcon } from "@novadeck/toolkit/icons/ClaudeIcon"
import { CodexIcon } from "@novadeck/toolkit/icons/CodexIcon"
import { NovaIcon } from "@novadeck/toolkit/icons/NovaIcon"
import { OpencodeIcon } from "@novadeck/toolkit/icons/OpencodeIcon"
import { PiIcon } from "@novadeck/toolkit/icons/PiIcon"
import type { LucideIcon } from "lucide-react"

// The agents' marks, by program name.
// A map, so `constructor` and `toString` are no agents.
const agentIcons: ReadonlyMap<string, LucideIcon> = new Map([
  ["claude", ClaudeIcon],
  ["codex", CodexIcon],
  ["agy", AntigravityIcon],
  ["opencode", OpencodeIcon],
  ["pi", PiIcon],
])

// The mark of the agent a program is, none for any other program. Nova has
// Novadeck's mark where the runner says (`nova`); the person's pi keeps Pi's.
export const agentIcon = (program: string, nova?: boolean): LucideIcon | undefined =>
  isNova(program, nova) ? NovaIcon : agentIcons.get(program)
