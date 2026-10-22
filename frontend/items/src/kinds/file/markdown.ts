// A markdown file reads as a document, as a plan does, not as code.
export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
