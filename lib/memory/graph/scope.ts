import type { Session } from "../../auth/session";
import { MATEO_OWNER_ID, USER_OWNER_ID, type ReadScope, type WriteScope } from "./types";

/**
 * Which owners a session may read, inside its own tenant. A demo visitor reads the shared
 * fictional seed (Leo and Mateo) plus their own writes; a member reads their own memories plus
 * the tenant's curated storyteller. Owner and tenant ids come only from the signed session,
 * never from the request body or query.
 */
export function readScopeFor(session: Session): ReadScope {
  const ownerIds =
    session.role === "demo"
      ? [...new Set([USER_OWNER_ID, MATEO_OWNER_ID, session.userId])]
      : [...new Set([session.userId, MATEO_OWNER_ID])];
  return { tenantId: session.tenantId, ownerIds };
}

/** Writes and deletes always target exactly the caller's own tenant and user. */
export function writeScopeFor(session: Session): WriteScope {
  return { tenantId: session.tenantId, ownerId: session.userId };
}
