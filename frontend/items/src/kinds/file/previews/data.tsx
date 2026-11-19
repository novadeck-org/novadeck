import { dataFormatOf } from "@novadeck/viewers/data-format"
import { Braces } from "lucide-react"

import type { FilePreview, PreviewProps } from "."
import { lazyView } from "../../../lazy-view"

// The tree and its parsers (YAML's among them) load when a data file first shows, so the
// workspace never pays for them.
const DataViewer = lazyView<PreviewProps>(
  () => import("../DataViewer").then((module) => module.DataViewer),
  <div className="artifact-status" />,
)

/** Whether a file is one the tree reads, by its name. */
export const isData = (path: string): boolean => dataFormatOf(path) !== undefined

// A JSON, JSONL or YAML file reads as a tree.
export const data: FilePreview = {
  name: "data",
  matches: isData,
  icon: Braces,
  View: DataViewer,
}
