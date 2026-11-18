import { Braces } from "lucide-react"

import type { FilePreview } from "."
import { DataViewer, isData } from "../DataViewer"

// A JSON, JSONL or YAML file reads as a tree.
export const data: FilePreview = {
  name: "data",
  matches: isData,
  icon: Braces,
  View: DataViewer,
}
