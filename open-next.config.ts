import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// The prerendered routes (the page shell, the icons, the OpenGraph image) never revalidate, so they are served
// straight from the build's static assets instead of being rendered again by the worker on every request.
export default defineCloudflareConfig({ incrementalCache: staticAssetsIncrementalCache });
