import "server-only";
import { getModes } from "@/lib/server/config";
import { createDurableStore } from "@/lib/server/store/durable";
import { memoryStore } from "@/lib/server/store/memory";
import type { Store } from "@/lib/server/store/types";

let store: Store | undefined;

const STORES = {
  durable: createDurableStore,
  memory: () => memoryStore,
};

/** Durable Objects on Cloudflare, otherwise the in-process memory store for local development. */
export function getStore(): Store {
  store ??= STORES[getModes().store]();
  return store;
}
