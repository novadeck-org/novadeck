import { dataFormatOf } from "@novadeck/viewers/data-format"
import { Braces } from "lucide-react"
import { lazy, Suspense } from "react"

import type { FilePreview, PreviewProps } from "."

// The tree and its parsers (YAML's among them) load when a data file first shows, so the
// workspace never pays for them.
const DataViewer = lazy(() =>
  import("../DataViewer").then((module) => ({ default: module.DataViewer })),
)

/** Whether a file is one the tree reads, by its name. */
export const isData = (path: string): boolean => dataFormatOf(path) !== undefined

// A JSON, JSONL or YAML file reads as a tree.
export const data: FilePreview = {
  name: "data",
  matches: isData,
  icon: Braces,
  View: (props: PreviewProps) => (
    <Suspense fallback={<div className="artifact-status" />}>
      <DataViewer {...props} />
    </Suspense>
  ),
}
