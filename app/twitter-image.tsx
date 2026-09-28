// Next treats opengraph-image and twitter-image as separate file conventions (node_modules/next/dist/docs/
// 01-app/03-api-reference/03-file-conventions/01-metadata/opengraph-image.md): neither falls back to the other.
// Re-exporting keeps one design in one file.
export { default, alt, size, contentType } from "./opengraph-image";
