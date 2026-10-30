// A Markdown file reads as a document, not as code.
export const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)
