import { type Db, run } from "./db";
import { actorOf, type Principal } from "./security/principal";
import { newId, nowIso } from "./util";

export interface AuditInput {
  principal: Principal;
  projectId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  /** Metadata only. Never put document text, prompts, tokens or passwords here. */
  details?: Record<string, unknown>;
  correlationId?: string | null;
}

export function audit(db: Db, a: AuditInput): void {
  const actor = actorOf(a.principal);
  run(
    db,
    `INSERT INTO audit_events (id, at, actor_kind, actor_id, project_id, action, entity_type, entity_id, details, correlation_id)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    newId("aud"),
    nowIso(),
    actor.kind,
    actor.id,
    a.projectId ?? null,
    a.action,
    a.entityType ?? null,
    a.entityId ?? null,
    JSON.stringify(a.details ?? {}),
    a.correlationId ?? null,
  );
}
