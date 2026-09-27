import { createDemoBackend } from "../backend/demo"
import type { CreateBackend } from "../backend/port"

// The only place that chooses a backend adapter.
export const selectBackend: CreateBackend = createDemoBackend
