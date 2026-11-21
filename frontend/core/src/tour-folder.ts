// Whether a project's folder is the tour's sandbox, `~/.novadeck/tour` where the runner made it:
// the one project where the Worktrees panel and the Files overlay show whatever the person's
// Agent worktrees setting says, so the tour can show the agents' work.
export const isTourFolder = (directory: string): boolean =>
  /(^|[\\/])\.novadeck[\\/]tour[\\/]?$/.test(directory)
