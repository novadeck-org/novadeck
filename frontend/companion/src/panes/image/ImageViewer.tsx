import type { ImageContent } from "@novadeck/core/companion"
import { mountImage, type ImageContent as Image } from "@novadeck/viewers/image"
import { useMemo, useState } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useViewerSlot } from "../../ViewerSlot"

// An image with the header's zoom: Fit, or its actual size. Where its viewer was, by item,
// its zoom and where it was scrolled, is kept.
export const ImageViewer = ({
  item,
  content: image,
  actions,
}: ArtifactBodyProps<"image">): React.JSX.Element => {
  const [actual, setActual] = useState(false)
  const content = useMemo((): Image => ({ src: image.src, alt: item.name }), [image, item])
  const { ref, viewer } = useViewerSlot(mountImage, {
    id: item.id,
    content,
    label: item.name,
    onZoom: setActual,
  })
  return (
    <>
      <div className="artifact-meta">
        <code>{item.name}</code>
        <span>{item.detail}</span>
        <span className="artifact-meta-push" />
        <div className="artifact-zoom segmented" role="group" aria-label="Zoom">
          <button
            className="segment"
            data-state={actual ? "off" : "on"}
            aria-pressed={!actual}
            onClick={() => viewer?.zoom(false)}
          >
            Fit
          </button>
          <button
            className="segment"
            data-state={actual ? "on" : "off"}
            aria-pressed={actual}
            onClick={() => viewer?.zoom(true)}
          >
            100%
          </button>
        </div>
        {actions}
      </div>
      <div ref={ref} className="artifact-image" />
    </>
  )
}

// The image itself.
export const ImageThumb = ({ content }: { content: ImageContent }): React.JSX.Element => (
  <img src={content.src} alt="" />
)
