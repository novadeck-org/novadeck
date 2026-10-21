import type { ImageContent } from "@novadeck/core/companion"
import { mountImage, type ImageContent as Image } from "@novadeck/viewers/image"
import { useMemo } from "react"

import type { ArtifactBodyProps } from "../../ArtifactViewer"
import { useViewerSlot } from "../../ViewerSlot"

// An image, zoomed and moved on the image itself, its zoom drawn over it once it's moved or
// zoomed. Where its viewer was, by item, its zoom and the point at its centre, is kept.
export const ImageViewer = ({
  item,
  content: image,
  actions,
}: ArtifactBodyProps<"image">): React.JSX.Element => {
  const content = useMemo((): Image => ({ src: image.src, alt: item.name }), [image, item])
  const { ref } = useViewerSlot(mountImage, { id: item.id, content, label: item.name })
  return (
    <>
      <div className="artifact-meta">
        <code>{item.name}</code>
        <span>{item.detail}</span>
        <span className="artifact-meta-push" />
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
