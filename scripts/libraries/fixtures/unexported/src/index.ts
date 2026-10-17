// Reached through "main" alone, so nothing says whether the browser may import it.
import { homedir } from "node:os"

export const home = () => homedir()
