import { ENTITY_SPECS, type EntityType, type KnowledgeEntity, type SourceRef, type Statement } from "@jonathon/contracts";
import { audit } from "../audit";
import { all, one, run } from "../db";
import { actorLabel, assertAccess, assertHuman, type Principal } from "../security/principal";
import type { EntityDoc } from "../storage/entity-format";
import { parseEntity, semanticHash } from "../storage/entity-format";
import { AppError, newId, nowIso, sha256 } from "../util";
import { type Ctx, knowledgeRevision, requireProject } from "./context";
import { parseAddition } from "./extraction";

type Draft = { title: string; fields?: Record<string, unknown>; sections?: Record<string, unknown>; source_refs?: SourceRef[] };

/** Allowed status transitions per entity type. Approval-like targets need a human + typed confirmation. */
const TRANSITIONS: Record<EntityType, Record<string, string[]>> = {
  requirement: {
    draft: ["in_review", "approved", "rejected"],
    in_review: ["draft", "approved", "rejected"],
    approved: ["superseded"],
    rejected: ["draft"],
    superseded: [],
  },
  decision: {
    draft: ["in_review", "approved", "rejected"],
    in_review: ["draft", "approved", "rejected"],
    approved: ["superseded"],
    rejected: ["draft"],
    superseded: [],
  },
  open_question: { open: ["withdrawn"], answered: ["open"], withdrawn: ["open"] },
  conflict: { open: ["dismissed"], resolved: [], dismissed: ["open"] },
  change_proposal: { open: ["accepted", "rejected"], accepted: [], rejected: [], stale: [] },
};

/** Targets that need "<verb> <HUMAN-ID>" typed by the human. */
const CONFIRM_VERB: Record<string, string> = {
  approved: "approve",
  rejected: "reject",
  superseded: "supersede",
  dismissed: "dismiss",
  accepted: "accept",
  withdrawn: "withdraw",
};

export interface FeatureSpec {
  snapshot_id: string;
  project_id: string;
  feature: string;
  approved_only: boolean;
  knowledge_revision: number;
  implementation_ready: boolean;
  readiness_reasons: string[];
  requirements: KnowledgeEntity[];
  decisions: KnowledgeEntity[];
  open_questions: KnowledgeEntity[];
  conflicts: KnowledgeEntity[];
  excluded_unapproved: { human_id: string; status: string; title: string }[];
  warnings: string[];
  markdown: string;
  stale: boolean;
}

export class KnowledgeService {
  constructor(private readonly ctx: Ctx) {}

  list(principal: Principal, projectId: string, filter: { types?: EntityType[]; statuses?: string[] } = {}): KnowledgeEntity[] {
    requireProject(this.ctx, principal, projectId, "read");
    return this.ctx.store.list(projectId, filter);
  }

  get(principal: Principal, projectId: string, humanId: string, revision?: number): KnowledgeEntity {
    requireProject(this.ctx, principal, projectId, "read");
    const e = revision ? this.ctx.store.getRevision(projectId, humanId, revision) : this.ctx.store.get(projectId, humanId);
    return e;
  }

  history(principal: Principal, projectId: string, humanId: string): { revisions: number[]; events: Array<Record<string, unknown>> } {
    requireProject(this.ctx, principal, projectId, "read");
    const e = this.ctx.store.get(projectId, humanId);
    return {
      revisions: this.ctx.store.listRevisions(projectId, e.human_id),
      events: all(
        this.ctx.db,
        "SELECT id, revision, action, actor_id, note, at FROM approval_events WHERE project_id = ? AND entity_id = ? ORDER BY at",
        projectId,
        e.id,
      ),
    };
  }

  /** Line diff between two stored revisions (both read from history files). */
  diff(principal: Principal, projectId: string, humanId: string, from: number, to: number): { from: number; to: number; lines: { op: " " | "+" | "-"; text: string }[] } {
    requireProject(this.ctx, principal, projectId, "read");
    const a = this.ctx.store.readHistoryRaw(projectId, humanId, from);
    const b = this.ctx.store.readHistoryRaw(projectId, humanId, to);
    if (a == null || b == null) throw new AppError("ENTITY_NOT_FOUND", "revision not found");
    return { from, to, lines: lineDiff(a.split("\n"), b.split("\n")) };
  }

  createDraft(principal: Principal, projectId: string, type: EntityType, draft: Draft, origin = "human_authored"): KnowledgeEntity {
    requireProject(this.ctx, principal, projectId, "write");
    if (type === "change_proposal") throw new AppError("VALIDATION_FAILED", "use propose_requirement_change to create proposals");
    const doc = this.ctx.store.newDoc(projectId, type, {
      ...draft,
      fields: { ...draft.fields, origin },
    });
    this.ctx.store.create(doc, { principal, action: "entity.created", details: { origin } });
    return this.ctx.store.get(projectId, doc.human_id);
  }

  /**
   * Edit content. Editing an approved entity creates a new revision in review: the old approval stays attached
   * to the old revision and does not carry over.
   */
  updateDraft(principal: Principal, projectId: string, humanId: string, expectedRevision: number, draft: Draft): KnowledgeEntity {
    requireProject(this.ctx, principal, projectId, "write");
    const current = this.ctx.store.get(projectId, humanId);
    if (current.entity_type === "change_proposal") throw new AppError("INVALID_TRANSITION", "proposals cannot be edited");
    if (["superseded", "rejected", "resolved", "accepted"].includes(current.status)) {
      throw new AppError("INVALID_TRANSITION", `${humanId} is ${current.status}; reopen it before editing`);
    }
    const wasApproved = current.approval_valid;
    this.ctx.store.update(
      projectId,
      current.human_id,
      expectedRevision,
      (doc) => {
        doc.title = draft.title;
        doc.fields = { ...doc.fields, ...(draft.fields ?? {}), origin: doc.fields.origin ?? "human_authored" };
        doc.sections = { ...doc.sections, ...(draft.sections as EntityDoc["sections"]) };
        if (draft.source_refs) doc.source_refs = draft.source_refs;
        // A human editing a question or conflict has reviewed it.
        if ((doc.entity_type === "open_question" || doc.entity_type === "conflict") && principal.kind === "user") doc.fields.reviewed = true;
        if (ENTITY_SPECS[doc.entity_type].approvalStatuses.includes(doc.status)) {
          doc.status = "in_review";
          doc.approval_event_id = null;
        }
      },
      { principal, action: wasApproved ? "entity.approved_content_edited" : "entity.updated" },
    );
    if (wasApproved) this.ctx.store.markDependentsStale(projectId, current.human_id);
    return this.ctx.store.get(projectId, current.human_id);
  }

  /** Mark every AI-proposed statement as accepted (human review step required before approval). */
  acceptProposedStatements(principal: Principal, projectId: string, humanId: string, expectedRevision: number): KnowledgeEntity {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "approve");
    this.ctx.store.update(
      projectId,
      humanId,
      expectedRevision,
      (doc) => {
        for (const [k, v] of Object.entries(doc.sections)) {
          if (Array.isArray(v) && v.length && typeof v[0] === "object") {
            doc.sections[k] = (v as Statement[]).map((s) => ({ ...s, review_state: "accepted" as const }));
          }
        }
        if (ENTITY_SPECS[doc.entity_type].approvalStatuses.includes(doc.status)) {
          doc.status = "in_review";
          doc.approval_event_id = null;
        }
      },
      { principal, action: "entity.statements_accepted" },
    );
    return this.ctx.store.get(projectId, humanId);
  }

  transition(
    principal: Principal,
    projectId: string,
    humanId: string,
    body: { to: string; expected_revision: number; confirmation?: string; note?: string },
  ): KnowledgeEntity {
    requireProject(this.ctx, principal, projectId, "read");
    const current = this.ctx.store.get(projectId, humanId);
    const allowed = TRANSITIONS[current.entity_type][current.status] ?? [];
    if (!allowed.includes(body.to)) {
      throw new AppError("INVALID_TRANSITION", `${current.human_id} cannot move from ${current.status} to ${body.to}`);
    }
    const verb = CONFIRM_VERB[body.to];
    const isApproval = ENTITY_SPECS[current.entity_type].approvalStatuses.includes(body.to);
    if (verb) {
      // Approval-like decisions are made by the human in the UI. Models, MCP tokens and the worker cannot do this.
      assertHuman(principal);
      requireProject(this.ctx, principal, projectId, "approve");
      const expected = `${verb} ${current.human_id}`;
      if ((body.confirmation ?? "").trim().toLowerCase() !== expected.toLowerCase()) {
        throw new AppError("CONFIRMATION_REQUIRED", `type "${expected}" to confirm`);
      }
    } else {
      requireProject(this.ctx, principal, projectId, "write");
    }
    if (isApproval) {
      const proposed = Object.entries(current.sections).flatMap(([k, v]) =>
        Array.isArray(v) ? (v as unknown[]).filter((s) => typeof s === "object" && (s as Statement).review_state === "proposed").map(() => k) : [],
      );
      if (proposed.length) {
        throw new AppError(
          "INVALID_TRANSITION",
          `${current.human_id} still has ${proposed.length} AI-proposed statement(s) (${[...new Set(proposed)].join(", ")}). Review and accept or remove them before approving.`,
        );
      }
      if (current.file_state !== "ok") throw new AppError("EXTERNAL_EDIT_PENDING", "reconcile external edits before approving");
    }

    const approvalId = isApproval || body.to === "rejected" ? newId("apv") : null;
    this.ctx.store.update(
      projectId,
      current.human_id,
      body.expected_revision,
      (doc) => {
        doc.status = body.to;
        doc.approval_event_id = isApproval ? approvalId : null;
      },
      {
        principal,
        action: `entity.${body.to}`,
        details: { note: body.note ? "provided" : undefined, approval_event_id: approvalId },
        beforeProjection: (doc) => {
          if (!approvalId || principal.kind !== "user") return;
          run(
            this.ctx.db,
            `INSERT INTO approval_events (id, project_id, entity_id, entity_type, human_id, revision, semantic_hash, action, actor_kind, actor_id, note, at)
             VALUES (?,?,?,?,?,?,?,?, 'user', ?, ?, ?)`,
            approvalId,
            projectId,
            doc.id,
            doc.entity_type,
            doc.human_id,
            doc.revision,
            semanticHash(doc),
            isApproval ? "approve" : "reject",
            principal.username,
            body.note ?? null,
            nowIso(),
          );
        },
      },
    );
    if (body.to === "superseded") this.ctx.store.markDependentsStale(projectId, current.human_id);
    return this.ctx.store.get(projectId, current.human_id);
  }

  private confirm(principal: Principal, projectId: string, verb: string, humanId: string, confirmation: string): void {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "approve");
    const expected = `${verb} ${humanId}`;
    if (confirmation.trim().toLowerCase() !== expected.toLowerCase()) throw new AppError("CONFIRMATION_REQUIRED", `type "${expected}" to confirm`);
  }

  /** The confirmation phrase the review UI shows for each action on an entity. */
  static reviewVerbs(type: EntityType): { accept: string; reject: string; delete: string } {
    switch (type) {
      case "requirement":
      case "decision":
        return { accept: "approve", reject: "reject", delete: "delete" };
      case "open_question":
      case "conflict":
        return { accept: "accept", reject: type === "conflict" ? "dismiss" : "withdraw", delete: "delete" };
      case "change_proposal":
        return { accept: "accept", reject: "reject", delete: "delete" };
    }
  }

  /**
   * One-step human review of an item the AI proposed from a document:
   * - requirement / decision: accept every proposed statement and approve, in ONE new revision with an approval event.
   * - open question / conflict: confirm it is real (fields.reviewed = true); it stays open until answered/resolved.
   * - change proposal: apply its structured edits to the requirement (which goes back to review) and mark it accepted.
   */
  accept(principal: Principal, projectId: string, humanId: string, body: { expected_revision: number; confirmation: string; note?: string }): { entity: KnowledgeEntity; applied_to?: KnowledgeEntity } {
    const current = this.ctx.store.get(projectId, humanId);
    this.confirm(principal, projectId, KnowledgeService.reviewVerbs(current.entity_type).accept, current.human_id, body.confirmation);
    if (current.file_state !== "ok") throw new AppError("EXTERNAL_EDIT_PENDING", "reconcile external edits first");
    const user = principal as Extract<Principal, { kind: "user" }>;

    if (current.entity_type === "requirement" || current.entity_type === "decision") {
      if (!["draft", "in_review"].includes(current.status)) throw new AppError("INVALID_TRANSITION", `${current.human_id} is ${current.status}`);
      const approvalId = newId("apv");
      this.ctx.store.update(
        projectId,
        current.human_id,
        body.expected_revision,
        (doc) => {
          for (const [k, v] of Object.entries(doc.sections)) {
            if (Array.isArray(v) && v.length && typeof v[0] === "object") {
              doc.sections[k] = (v as Statement[]).map((s) => ({ ...s, review_state: "accepted" as const }));
            }
          }
          doc.status = "approved";
          doc.approval_event_id = approvalId;
        },
        {
          principal,
          action: "entity.approved",
          details: { via: "review", approval_event_id: approvalId },
          beforeProjection: (doc) =>
            run(
              this.ctx.db,
              `INSERT INTO approval_events (id, project_id, entity_id, entity_type, human_id, revision, semantic_hash, action, actor_kind, actor_id, note, at)
               VALUES (?,?,?,?,?,?,?,'approve','user',?,?,?)`,
              approvalId,
              projectId,
              doc.id,
              doc.entity_type,
              doc.human_id,
              doc.revision,
              semanticHash(doc),
              user.username,
              body.note ?? null,
              nowIso(),
            ),
        },
      );
      return { entity: this.ctx.store.get(projectId, current.human_id) };
    }

    if (current.entity_type === "open_question" || current.entity_type === "conflict") {
      if (current.status !== "open") throw new AppError("INVALID_TRANSITION", `${current.human_id} is ${current.status}`);
      this.ctx.store.update(
        projectId,
        current.human_id,
        body.expected_revision,
        (doc) => {
          doc.fields.reviewed = true;
        },
        { principal, action: "entity.reviewed" },
      );
      return { entity: this.ctx.store.get(projectId, current.human_id) };
    }

    // change_proposal
    if (current.status !== "open") throw new AppError("INVALID_TRANSITION", `${current.human_id} is ${current.status}`);
    const reqId = String(current.fields.requirement_id ?? "");
    const description = String(current.sections.proposed_description ?? "").trim();
    const additions = ((current.sections.proposed_additions as string[]) ?? []).map(parseAddition).filter((a) => a !== null);
    const structured = description !== "" || additions.length > 0;
    let appliedTo: string | null = null;
    this.ctx.store.writeTx(() => {
      if (structured) {
        const req = this.ctx.store.get(projectId, reqId);
        if (req.entity_type !== "requirement") throw new AppError("REQUIREMENT_NOT_FOUND", `${reqId} is not a requirement`);
        if (["rejected", "superseded"].includes(req.status)) throw new AppError("INVALID_TRANSITION", `${req.human_id} is ${req.status}; reject this proposal instead`);
        if (req.file_state !== "ok") throw new AppError("EXTERNAL_EDIT_PENDING", `reconcile external edits to ${req.human_id} first`);
        // Approving a requirement adds a revision without changing its content, so compare content, not revision numbers.
        const base = Number(current.fields.base_revision ?? 0);
        if (base !== req.revision) {
          const baseText = this.ctx.store.readHistoryRaw(projectId, req.human_id, base);
          const baseHash = baseText ? semanticHash(parseEntity(baseText)) : null;
          if (baseHash !== req.semantic_hash) {
            throw new AppError("REVISION_CONFLICT", `${req.human_id} changed since this proposal was made (revision ${base} → ${req.revision}). Review it and reject or re-propose.`, {
              details: { current_revision: req.revision },
            });
          }
        }
        const wasApproved = req.approval_valid;
        this.ctx.store.update(
          projectId,
          req.human_id,
          req.revision,
          (doc) => {
            if (description) doc.sections.description = description;
            for (const a of additions) {
              const list = Array.isArray(doc.sections[a.section]) ? (doc.sections[a.section] as Statement[]) : [];
              // The human accepted the proposal, so its statements are reviewed; basis still records where they came from.
              doc.sections[a.section] = [...list, { text: a.text, basis: a.basis, review_state: "accepted" }];
            }
            const have = new Set(doc.source_refs.map((r) => `${r.revision_id}:${r.chunk_id ?? ""}`));
            doc.source_refs = [...doc.source_refs, ...current.source_refs.filter((r) => !have.has(`${r.revision_id}:${r.chunk_id ?? ""}`))];
            if (ENTITY_SPECS[doc.entity_type].approvalStatuses.includes(doc.status)) {
              doc.status = "in_review";
              doc.approval_event_id = null;
            }
          },
          { principal, action: "entity.proposal_applied", details: { proposal: current.human_id, approval_revoked: wasApproved } },
        );
        if (wasApproved) this.ctx.store.markDependentsStale(projectId, req.human_id);
        appliedTo = req.human_id;
      }
      this.ctx.store.update(
        projectId,
        current.human_id,
        body.expected_revision,
        (doc) => {
          doc.status = "accepted";
        },
        { principal, action: "entity.accepted", details: { applied_to: appliedTo } },
      );
    });
    return {
      entity: this.ctx.store.get(projectId, current.human_id),
      ...(appliedTo ? { applied_to: this.ctx.store.get(projectId, appliedTo) } : {}),
    };
  }

  /** Reject a proposed item: requirement/decision → rejected, question → withdrawn, conflict → dismissed, proposal → rejected. */
  reject(principal: Principal, projectId: string, humanId: string, body: { expected_revision: number; confirmation: string; note?: string }): KnowledgeEntity {
    const current = this.ctx.store.get(projectId, humanId);
    const to = { requirement: "rejected", decision: "rejected", open_question: "withdrawn", conflict: "dismissed", change_proposal: "rejected" }[current.entity_type];
    return this.transition(principal, projectId, current.human_id, { to, expected_revision: body.expected_revision, confirmation: body.confirmation, note: body.note });
  }

  /**
   * Permanently remove an item from the knowledge base (separate, human-confirmed workflow: "delete <ID>").
   * Its history and a tombstone stay on disk; open proposals that target a deleted requirement become stale.
   */
  remove(principal: Principal, projectId: string, humanId: string, body: { expected_revision: number; confirmation: string }): { deleted: string } {
    const current = this.ctx.store.get(projectId, humanId);
    this.confirm(principal, projectId, "delete", current.human_id, body.confirmation);
    const wasApproved = current.approval_valid;
    this.ctx.store.writeTx(() => {
      // Flag answers/specs that relied on it while its projection row still exists (the query joins on it).
      if (wasApproved || current.entity_type === "requirement" || current.entity_type === "decision") this.ctx.store.markDependentsStale(projectId, current.human_id);
      this.ctx.store.remove(projectId, current.human_id, body.expected_revision, { principal, details: { was_approved: wasApproved } });
      if (current.entity_type === "requirement") {
        for (const p of this.ctx.store.list(projectId, { types: ["change_proposal"], statuses: ["open"] })) {
          if (p.fields.requirement_id !== current.human_id) continue;
          this.ctx.store.update(projectId, p.human_id, p.revision, (d) => {
            d.status = "stale";
          }, { principal, action: "entity.stale", details: { reason: `${current.human_id} was deleted` } });
        }
      }
    });
    return { deleted: current.human_id };
  }

  /** Resolve a conflict by recording an approved human decision. One transaction for both files. */
  resolveConflict(
    principal: Principal,
    projectId: string,
    conflictId: string,
    body: { expected_revision: number; question: string; selected: string; rationale: string; options: string[]; confirmation: string },
  ): { conflict: KnowledgeEntity; decision: KnowledgeEntity } {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "approve");
    const conflict = this.ctx.store.get(projectId, conflictId);
    if (conflict.entity_type !== "conflict") throw new AppError("VALIDATION_FAILED", `${conflictId} is not a conflict`);
    if (conflict.status !== "open") throw new AppError("INVALID_TRANSITION", `${conflict.human_id} is ${conflict.status}`);
    const expected = `resolve ${conflict.human_id}`;
    if (body.confirmation.trim().toLowerCase() !== expected.toLowerCase()) throw new AppError("CONFIRMATION_REQUIRED", `type "${expected}" to confirm`);

    let decisionHumanId = "";
    this.ctx.store.writeTx(() => {
      const dec = this.ctx.store.newDoc(projectId, "decision", {
        title: `Resolution of ${conflict.human_id}: ${conflict.title}`.slice(0, 200),
        fields: {
          affected_requirements: (conflict.fields.related_requirements as string[]) ?? [],
          feature_scopes: (conflict.fields.feature_scopes as string[]) ?? [],
          resolves_conflict: conflict.human_id,
          origin: "human_authored",
        },
        sections: { question: body.question, options: body.options, selected: body.selected, rationale: body.rationale },
        source_refs: conflict.source_refs,
      });
      this.ctx.store.create(dec, { principal, action: "entity.created", details: { origin: "conflict_resolution" } });
      decisionHumanId = dec.human_id;
      const approvalId = newId("apv");
      this.ctx.store.update(
        projectId,
        dec.human_id,
        1,
        (d) => {
          d.status = "approved";
          d.approval_event_id = approvalId;
        },
        {
          principal,
          action: "entity.approved",
          beforeProjection: (d) =>
            run(
              this.ctx.db,
              `INSERT INTO approval_events (id, project_id, entity_id, entity_type, human_id, revision, semantic_hash, action, actor_kind, actor_id, note, at)
               VALUES (?,?,?,?,?,?,?,'approve','user',?,?,?)`,
              approvalId,
              projectId,
              d.id,
              d.entity_type,
              d.human_id,
              d.revision,
              semanticHash(d),
              principal.username,
              `resolves ${conflict.human_id}`,
              nowIso(),
            ),
        },
      );
      this.ctx.store.update(
        projectId,
        conflict.human_id,
        body.expected_revision,
        (c) => {
          c.status = "resolved";
          c.sections.resolution = `${body.selected}\n\nRecorded as ${dec.human_id}.`;
          c.fields.resolution_decision = dec.human_id;
        },
        { principal, action: "entity.resolved", details: { decision: dec.human_id } },
      );
      run(
        this.ctx.db,
        `INSERT INTO approval_events (id, project_id, entity_id, entity_type, human_id, revision, semantic_hash, action, actor_kind, actor_id, note, at)
         SELECT ?, project_id, id, entity_type, human_id, revision, semantic_hash, 'resolve', 'user', ?, ?, ? FROM knowledge_entities WHERE project_id = ? AND human_id = ?`,
        newId("apv"),
        principal.username,
        dec.human_id,
        nowIso(),
        projectId,
        conflict.human_id,
      );
    });
    return { conflict: this.ctx.store.get(projectId, conflict.human_id), decision: this.ctx.store.get(projectId, decisionHumanId) };
  }

  answerQuestion(
    principal: Principal,
    projectId: string,
    questionId: string,
    body: { expected_revision: number; resolution: string; confirmation: string },
  ): KnowledgeEntity {
    assertHuman(principal);
    requireProject(this.ctx, principal, projectId, "approve");
    const q = this.ctx.store.get(projectId, questionId);
    if (q.entity_type !== "open_question") throw new AppError("VALIDATION_FAILED", `${questionId} is not an open question`);
    if (q.status !== "open") throw new AppError("INVALID_TRANSITION", `${q.human_id} is ${q.status}`);
    const expected = `answer ${q.human_id}`;
    if (body.confirmation.trim().toLowerCase() !== expected.toLowerCase()) throw new AppError("CONFIRMATION_REQUIRED", `type "${expected}" to confirm`);
    this.ctx.store.update(
      projectId,
      q.human_id,
      body.expected_revision,
      (d) => {
        d.status = "answered";
        d.sections.resolution = body.resolution;
      },
      {
        principal,
        action: "entity.answered",
        beforeProjection: (d) =>
          run(
            this.ctx.db,
            `INSERT INTO approval_events (id, project_id, entity_id, entity_type, human_id, revision, semantic_hash, action, actor_kind, actor_id, note, at)
             VALUES (?,?,?,?,?,?,?,'answer','user',?,NULL,?)`,
            newId("apv"),
            projectId,
            d.id,
            d.entity_type,
            d.human_id,
            d.revision,
            semanticHash(d),
            principal.username,
            nowIso(),
          ),
      },
    );
    return this.ctx.store.get(projectId, q.human_id);
  }

  /** Developer agents (MCP "propose" scope) and the user can propose changes. Nothing is applied automatically. */
  proposeChange(
    principal: Principal,
    input: { project_id: string; requirement_id: string; base_revision: number; proposed_change: string; rationale: string; request_id: string },
  ): { proposal: KnowledgeEntity; idempotent_replay: boolean } {
    requireProject(this.ctx, principal, input.project_id, "propose");
    const scope = `proposal:${principal.kind === "mcp_token" ? principal.tokenId : principal.kind === "user" ? principal.userId : principal.name}`;
    const prior = one<{ result: string }>(this.ctx.db, "SELECT result FROM idempotency_keys WHERE scope = ? AND key = ?", scope, input.request_id);
    if (prior) {
      const r = JSON.parse(prior.result) as { project_id: string; human_id: string; fingerprint: string };
      const fp = sha256(JSON.stringify([input.project_id, input.requirement_id, input.base_revision, input.proposed_change, input.rationale]));
      if (r.project_id !== input.project_id || r.fingerprint !== fp) throw new AppError("VALIDATION_FAILED", "request_id was already used for a different proposal");
      return { proposal: this.ctx.store.get(r.project_id, r.human_id), idempotent_replay: true };
    }
    const req = this.ctx.store.get(input.project_id, input.requirement_id);
    if (req.entity_type !== "requirement") throw new AppError("REQUIREMENT_NOT_FOUND", `${input.requirement_id} is not a requirement`);
    if (req.revision !== input.base_revision) {
      throw new AppError("REVISION_CONFLICT", `${req.human_id} is at revision ${req.revision}; re-read it and propose against the current revision`, {
        details: { current_revision: req.revision },
      });
    }
    let humanId = "";
    this.ctx.store.writeTx(() => {
      const doc = this.ctx.store.newDoc(input.project_id, "change_proposal", {
        title: `Change to ${req.human_id}: ${req.title}`.slice(0, 200),
        fields: { requirement_id: req.human_id, base_revision: input.base_revision, proposed_by: actorLabel(principal), origin: principal.kind === "mcp_token" ? "mcp_proposed" : "human_authored" },
        sections: { proposed_change: input.proposed_change, rationale: input.rationale },
      });
      this.ctx.store.create(doc, { principal, action: "proposal.created", details: { requirement: req.human_id } });
      humanId = doc.human_id;
      run(
        this.ctx.db,
        "INSERT INTO idempotency_keys (scope, key, result, created_at) VALUES (?,?,?,?)",
        scope,
        input.request_id,
        JSON.stringify({
          project_id: input.project_id,
          human_id: doc.human_id,
          fingerprint: sha256(JSON.stringify([input.project_id, input.requirement_id, input.base_revision, input.proposed_change, input.rationale])),
        }),
        nowIso(),
      );
    });
    return { proposal: this.ctx.store.get(input.project_id, humanId), idempotent_replay: false };
  }

  /** Assemble a feature specification from knowledge. Server-side readiness; snapshot persisted under specifications/. */
  featureSpec(principal: Principal, projectId: string, feature: string, opts: { approvedOnly?: boolean; knowledgeRevision?: number } = {}): FeatureSpec {
    const project = requireProject(this.ctx, principal, projectId, "read");
    const approvedOnly = opts.approvedOnly ?? true;
    const f = feature.trim().toLowerCase();
    if (!f) throw new AppError("VALIDATION_FAILED", "feature is required");
    const all_ = this.ctx.store.list(projectId);
    const inScope = (e: KnowledgeEntity) => {
      const scopes = ((e.fields.feature_scopes as string[]) ?? []).map((s) => s.toLowerCase());
      const mod = String(e.fields.module ?? "").toLowerCase();
      return scopes.includes(f) || mod === f || e.title.toLowerCase().includes(f);
    };
    const reqsInScope = all_.filter((e) => e.entity_type === "requirement" && inScope(e) && !["rejected", "superseded"].includes(e.status));
    const reqIds = new Set(reqsInScope.map((r) => r.human_id));
    const touches = (e: KnowledgeEntity, key: string) => ((e.fields[key] as string[]) ?? []).some((id) => reqIds.has(id));
    const decisions = all_.filter(
      (e) => e.entity_type === "decision" && e.status !== "rejected" && e.status !== "superseded" && (inScope(e) || touches(e, "affected_requirements")),
    );
    const questions = all_.filter((e) => e.entity_type === "open_question" && e.status === "open" && (inScope(e) || touches(e, "related_requirements")));
    const conflicts = all_.filter((e) => e.entity_type === "conflict" && e.status === "open" && (inScope(e) || touches(e, "related_requirements")));

    const approvedReqs = reqsInScope.filter((r) => r.approval_valid);
    const unapprovedReqs = reqsInScope.filter((r) => !r.approval_valid);
    const approvedDecs = decisions.filter((d) => d.approval_valid);
    const unapprovedDecs = decisions.filter((d) => !d.approval_valid);
    const requirements = approvedOnly ? approvedReqs : reqsInScope;
    const decs = approvedOnly ? approvedDecs : decisions;

    const reasons: string[] = [];
    if (approvedReqs.length === 0) reasons.push(`No approved requirements are in scope for "${feature}".`);
    for (const c of conflicts.filter((c) => c.fields.blocking)) reasons.push(`Blocking conflict ${c.human_id} is open: ${c.title}`);
    for (const q of questions.filter((q) => q.fields.blocking)) reasons.push(`Blocking question ${q.human_id} is open: ${q.title}`);
    if (unapprovedReqs.length) reasons.push(`${unapprovedReqs.length} requirement(s) in scope are not approved: ${unapprovedReqs.map((r) => `${r.human_id} (${r.status})`).join(", ")}`);
    if (unapprovedDecs.length) reasons.push(`${unapprovedDecs.length} decision(s) in scope are not approved: ${unapprovedDecs.map((d) => d.human_id).join(", ")}`);
    const nonBlockingOpen = conflicts.filter((c) => !c.fields.blocking).length + questions.filter((q) => !q.fields.blocking).length;
    if (nonBlockingOpen) reasons.push(`${nonBlockingOpen} non-blocking open item(s) should be reviewed.`);
    const ready =
      approvedReqs.length > 0 &&
      !conflicts.some((c) => c.fields.blocking) &&
      !questions.some((q) => q.fields.blocking) &&
      unapprovedReqs.length === 0 &&
      unapprovedDecs.length === 0;

    const kr = knowledgeRevision(this.ctx, projectId);
    const warnings: string[] = [];
    if (opts.knowledgeRevision !== undefined && opts.knowledgeRevision !== kr) {
      warnings.push(`Knowledge changed since revision ${opts.knowledgeRevision}; this specification reflects revision ${kr}.`);
    }
    const entityRevisions: Record<string, number> = {};
    for (const e of [...requirements, ...decs, ...questions, ...conflicts]) entityRevisions[e.human_id] = e.revision;
    const markdown = renderSpec(project.name, feature, kr, approvedOnly, ready, reasons, requirements, decs, questions, conflicts, unapprovedReqs);
    const fingerprint = sha256(JSON.stringify([f, approvedOnly, entityRevisions]));
    const existing = one<{ id: string }>(
      this.ctx.db,
      "SELECT id FROM spec_snapshots WHERE project_id = ? AND feature = ? AND approved_only = ? AND entity_revisions = ? AND stale = 0",
      projectId,
      f,
      approvedOnly ? 1 : 0,
      JSON.stringify(entityRevisions),
    );
    let snapshotId = existing?.id;
    if (!snapshotId) {
      snapshotId = newId("spec");
      const path = this.ctx.files.writeSpecSnapshot(
        projectId,
        snapshotId,
        `---\nsnapshot_id: "${snapshotId}"\nproject_id: "${projectId}"\nfeature: ${JSON.stringify(feature)}\nknowledge_revision: ${kr}\napproved_only: ${approvedOnly}\nentity_revisions: ${JSON.stringify(entityRevisions)}\nfingerprint: "${fingerprint}"\ncreated_at: "${nowIso()}"\n---\n\n${markdown}`,
      );
      run(
        this.ctx.db,
        "INSERT INTO spec_snapshots (id, project_id, feature, knowledge_revision, approved_only, entity_revisions, stale, storage_path, created_at) VALUES (?,?,?,?,?,?,0,?,?)",
        snapshotId,
        projectId,
        f,
        kr,
        approvedOnly ? 1 : 0,
        JSON.stringify(entityRevisions),
        path,
        nowIso(),
      );
      audit(this.ctx.db, { principal, projectId, action: "spec.snapshot_created", entityType: "spec", entityId: snapshotId, details: { feature: f, ready } });
    }
    return {
      snapshot_id: snapshotId,
      project_id: projectId,
      feature,
      approved_only: approvedOnly,
      knowledge_revision: kr,
      implementation_ready: ready,
      readiness_reasons: ready ? [] : reasons,
      requirements,
      decisions: decs,
      open_questions: questions,
      conflicts,
      excluded_unapproved: approvedOnly ? [...unapprovedReqs, ...unapprovedDecs].map((e) => ({ human_id: e.human_id, status: e.status, title: e.title })) : [],
      warnings,
      markdown,
      stale: false,
    };
  }

  /** Pending approvals: drafts/in-review requirements and decisions, open conflicts/questions, open proposals. */
  pending(principal: Principal, projectId?: string): KnowledgeEntity[] {
    if (principal.kind !== "user") throw new AppError("FORBIDDEN", "only the local user can view the approval queue");
    const rows = projectId ? [projectId] : all<{ id: string }>(this.ctx.db, "SELECT id FROM projects").map((r) => r.id);
    return rows.flatMap((pid) =>
      this.ctx.store
        .list(pid)
        .filter(
          (e) =>
            (["requirement", "decision"].includes(e.entity_type) && ["draft", "in_review"].includes(e.status)) ||
            (["conflict", "open_question", "change_proposal"].includes(e.entity_type) && e.status === "open") ||
            e.file_state !== "ok",
        ),
    );
  }
}

export function assertCanPropose(principal: Principal, projectId: string): void {
  assertAccess(principal, projectId, "propose");
}

function renderEntity(e: KnowledgeEntity): string {
  const lines = [`### ${e.human_id}: ${e.title}`, "", `Status: **${e.status}**${e.approval_valid ? ` (approved by ${e.approval?.approved_by}, revision ${e.revision})` : " (not approved)"}`];
  for (const [k, v] of Object.entries(e.sections)) {
    if (k === "_extra" || !v || (Array.isArray(v) && v.length === 0) || v === "") continue;
    lines.push("", `**${k.replace(/_/g, " ")}**`);
    if (typeof v === "string") lines.push(v);
    else
      for (const item of v as Array<string | Statement>) {
        if (typeof item === "string") lines.push(`- ${item}`);
        else lines.push(`- ${item.text}${item.basis === "ai_inferred" ? " _(AI-inferred)_" : ""}${item.review_state === "proposed" ? " _(proposed, not reviewed)_" : ""}`);
      }
  }
  if (e.source_refs.length) lines.push("", `Sources: ${e.source_refs.map((r) => `${r.source_id}@${r.revision_id}${Object.keys(r.locator).length ? ` ${JSON.stringify(r.locator)}` : ""}`).join("; ")}`);
  return lines.join("\n");
}

function renderSpec(
  projectName: string,
  feature: string,
  kr: number,
  approvedOnly: boolean,
  ready: boolean,
  reasons: string[],
  reqs: KnowledgeEntity[],
  decs: KnowledgeEntity[],
  qs: KnowledgeEntity[],
  cs: KnowledgeEntity[],
  unapproved: KnowledgeEntity[],
): string {
  const out = [
    `# Feature specification: ${feature}`,
    "",
    `Project: ${projectName}. Knowledge revision: ${kr}. ${approvedOnly ? "Approved knowledge only." : "Includes unapproved drafts (labelled)."}`,
    "",
    `Implementation ready: **${ready ? "yes" : "no"}**`,
  ];
  if (reasons.length) out.push("", ...reasons.map((r) => `- ${r}`));
  out.push("", "## Requirements", "", reqs.length ? reqs.map(renderEntity).join("\n\n") : "_None._");
  out.push("", "## Decisions", "", decs.length ? decs.map(renderEntity).join("\n\n") : "_None._");
  out.push("", "## Open conflicts", "", cs.length ? cs.map(renderEntity).join("\n\n") : "_None._");
  out.push("", "## Open questions", "", qs.length ? qs.map(renderEntity).join("\n\n") : "_None._");
  if (approvedOnly && unapproved.length) out.push("", "## Excluded (not approved)", "", ...unapproved.map((u) => `- ${u.human_id} (${u.status}): ${u.title}`));
  return out.join("\n");
}

/** Small LCS line diff (inputs are single entity files, a few hundred lines at most). */
export function lineDiff(a: string[], b: string[]): { op: " " | "+" | "-"; text: string }[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: " " | "+" | "-"; text: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "-", text: a[i++]! });
    else out.push({ op: "+", text: b[j++]! });
  }
  while (i < n) out.push({ op: "-", text: a[i++]! });
  while (j < m) out.push({ op: "+", text: b[j++]! });
  return out;
}
