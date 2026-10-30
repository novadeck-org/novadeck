import { z } from "zod"

export const id = z.uuid()
export const name = z.string().trim().min(1).max(200)
export const directory = z.string().min(1).max(4096)
