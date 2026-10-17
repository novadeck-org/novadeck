// Only Node imports this subpath, so the browser check leaves it out.
import { spawn } from "node:child_process"

export const start = () => spawn("sh")
