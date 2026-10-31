// Whether a path lies in a folder, lexically, in the rules the two are written in.
import { flavourOf } from "../paths.js"

/** Whether `path` is `root` or lies inside it; false unless both are absolute. */
export const inside = (path: string, root: string): boolean => {
  const rules = flavourOf(path, root)
  if (!rules.isAbsolute(path) || !rules.isAbsolute(root)) return false
  const relative = rules.relative(rules.resolve(root), rules.resolve(path))
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${rules.sep}`) && !rules.isAbsolute(relative))
  )
}
