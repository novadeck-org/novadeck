// Whether a project's folder is one the runner made for the tour: `~/.novadeck/tour`, or
// `tour-2`, `tour-3` and so on where the person kept an earlier one. They are the projects where
// the Worktrees panel and the Files overlay show whatever the person's Agent worktrees setting
// says, so the tour can show the agents' work, and a game the person kept goes on showing it.
export const isTourFolder = (directory: string): boolean =>
  /(^|[\\/])\.novadeck[\\/]tour(-[1-9]\d?)?[\\/]?$/.test(directory)
