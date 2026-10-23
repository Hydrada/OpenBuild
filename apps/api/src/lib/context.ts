import { AsyncLocalStorage } from "node:async_hooks";
import type { Tool } from "./tools.js";

export interface RequestScope {
  /** Set when the request authenticated with an API key: the key only works inside this organization. */
  apiKeyOrgId?: string;
  /** The project tool the current route belongs to, for permission templates. */
  tool?: Tool | null;
}

/** Per-request scope, readable from permission checks without threading it through every call. */
export const requestScope = new AsyncLocalStorage<RequestScope>();
