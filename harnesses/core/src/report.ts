import type { AgentName } from "@novadeck/protocol"

/**
 * What an agent hook forwards: the event its agent reported in a terminal, with a
 * bounded copy of the agent's payload. The agent's harness decodes the payload (its
 * adapter's `decode.ts`); nothing here reads it.
 */
export type Report = {
  readonly terminalId: string
  readonly token: string
  readonly agent: AgentName
  /** The hook event, as the agent names it: SessionStart, PreInvocation… */
  readonly event: string
  /** When the hook started, in epoch milliseconds: a later hook reports a larger one. */
  readonly seq: number
  /**
   * When the agent fired the hook, in epoch milliseconds: when the shell it started the
   * hook in started, at or before `seq`, which comes only once that shell has (on
   * Windows seconds later, cold); absent where the relay couldn't tell.
   */
  readonly firedAt?: number
  /** The agent process that ran the hook, as a pid; null where the platform hides it. */
  readonly instance: string | null
  /** What of the hook's environment tells nested agents apart. */
  readonly env: {
    readonly cursor: boolean
    readonly codexThread?: string
    /** The terminal is narrowed (NOVADECK_NARROW): its launch grants need every answer closed. */
    readonly narrow?: true
  }
  readonly payload: { readonly [key: string]: unknown }
}
