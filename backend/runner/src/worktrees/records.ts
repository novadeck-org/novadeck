/** A git worktree Novadeck tracks, as the store keeps it. */
export type WorktreeRecord = {
  /** The worktree's top folder, as a real path. */
  readonly path: string
  /** Its repository's git common dir. */
  readonly commonDir: string
  readonly branch: string
  /** The commit it started from. */
  readonly base: string
  readonly projectId: string
  /** The terminal that owns it, live or in History; null once orphaned. */
  readonly terminalId: string | null
  /** Whether some other tool made it and an agent took it. */
  readonly adopted: boolean
  /** Whether it has ever differed from `base`. */
  readonly diverged: boolean
  /** When it was recorded, in epoch milliseconds. */
  readonly createdAt: number
}

/** Where the runner keeps its worktrees' ownership: its metadata store. */
export type WorktreeRecords = {
  insertWorktree(record: WorktreeRecord): void
  /** Hands a worktree to a terminal; whether there was a row. */
  setWorktreeOwner(path: string, terminalId: string): boolean
  /** Leaves a worktree with no owner; whether there was a row. */
  orphanWorktree(path: string): boolean
  /** A project's worktrees, oldest first. */
  worktreesOfProject(projectId: string): readonly WorktreeRecord[]
  /** A terminal's worktrees, oldest first. */
  worktreesOfTerminal(terminalId: string): readonly WorktreeRecord[]
  /** Every worktree, oldest first. */
  worktrees(): readonly WorktreeRecord[]
  worktree(path: string): WorktreeRecord | undefined
  /** Deletes one row; whether there was one. */
  removeWorktree(path: string): boolean
}
