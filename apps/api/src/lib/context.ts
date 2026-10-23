import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestScope {
  /** Set when the request authenticated with an API key: the key only works inside this organization. */
  apiKeyOrgId?: string;
}

/** Per-request scope, readable from permission checks without threading it through every call. */
export const requestScope = new AsyncLocalStorage<RequestScope>();
