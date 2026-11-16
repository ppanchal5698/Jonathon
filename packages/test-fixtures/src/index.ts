import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JobType, SourceRef } from "@jonathon/contracts";
import type { JonathonApp, Principal } from "@jonathon/core";
import ExcelJS from "exceljs";

const here = dirname(fileURLToPath(import.meta.url));
export const FAKE_AGY = join(here, "..", "runtime", "fake-agy.mjs");
export const DEMO_DIR = join(here, "..", "demo");

/** Business-rules spreadsheet for the fictional demo (built at runtime so no binary is committed). */
export async function buildBusinessRulesXlsx(): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Jonathon demo (fictional)";
  const ws = wb.addWorksheet("Business rules");
  ws.addRow(["Rule ID", "Area", "Rule", "Value"]);
  ws.addRow(["BR-01", "Accounts", "Minimum password length", "12 characters"]);
  ws.addRow(["BR-02", "Accounts", "Failed sign-in attempts before lockout", "5"]);
  ws.addRow(["BR-03", "Invoices", "Invoice history shown", "24 months"]);
  ws.addRow(["BR-04", "Sessions", "Idle session timeout", "30 minutes"]);
  ws.addRow(["BR-05", "Service requests", "Photos per request", { formula: "2+3", result: 5 }]);
  const notes = wb.addWorksheet("Notes");
  notes.addRow(["Note"]);
  notes.addRow(["FICTIONAL DEMONSTRATION SPREADSHEET. Larkspur Home Services is not a real company."]);
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

export async function demoSourceFiles(): Promise<{ filename: string; bytes: Uint8Array }[]> {
  const read = (n: string) => new Uint8Array(readFileSync(join(DEMO_DIR, n)));
  return [
    { filename: "01-initial-requirements.md", bytes: read("01-initial-requirements.md") },
    { filename: "02-follow-up-email.eml", bytes: read("02-follow-up-email.eml") },
    { filename: "03-business-rules.xlsx", bytes: await buildBusinessRulesXlsx() },
    { filename: "04-meeting-notes-untrusted.txt", bytes: read("04-meeting-notes-untrusted.txt") },
    { filename: "AGENTS.md", bytes: read("AGENTS.md") },
  ];
}

/** Run queued jobs in-process until none of the given types remain (tests and seeding only). */
export async function drainJobs(app: JonathonApp, types: JobType[] = ["ingest"], maxJobs = 50): Promise<string[]> {
  const handlers = app.jobHandlers();
  const done: string[] = [];
  for (let i = 0; i < maxJobs; i++) {
    const job = app.ctx.queue.claim("test-drain", 60_000, types);
    if (!job) break;
    const controller = new AbortController();
    try {
      const out = await handlers[job.type]!({ job, signal: controller.signal, progress: () => {}, log: app.ctx.log });
      app.ctx.queue.complete(job.id, "test-drain", out.status, out.result);
    } catch (e) {
      const err = e as { code?: string; message?: string };
      app.ctx.queue.fail(job.id, "test-drain", (err.code ?? "INTERNAL") as never, err.message ?? "failed");
    }
    done.push(job.id);
  }
  return done;
}

function refFor(app: JonathonApp, projectId: string, text: string, label?: string): SourceRef[] {
  const hit = app.ctx.db
    .prepare(
      "SELECT id, source_id, revision_id, locator, content_hash, text FROM chunks WHERE project_id = ? AND kind = 'evidence' AND text LIKE ? LIMIT 1",
    )
    .get(projectId, `%${text}%`) as { id: string; source_id: string; revision_id: string; locator: string; content_hash: string; text: string } | undefined;
  if (!hit) return [];
  return [
    {
      source_id: hit.source_id,
      revision_id: hit.revision_id,
      chunk_id: hit.id,
      locator: JSON.parse(hit.locator),
      excerpt: hit.text.slice(0, 300),
      content_hash: hit.content_hash,
      ...(label ? { label } : {}),
    },
  ];
}

/**
 * Seed the FICTIONAL demo project. Approvals here are recorded under the given human user with the note
 * "demo seed" so that the demo shows approved vs draft knowledge. Nothing here talks to a model.
 */
export async function seedDemoProject(app: JonathonApp, user: Extract<Principal, { kind: "user" }>): Promise<{ projectId: string }> {
  const project = app.projects.create(user, {
    name: "Larkspur customer portal (DEMO, fictional)",
    description: "Fictional demonstration project. Larkspur Home Services is not a real company. Shows evidence, drafts, approvals, a conflict, an unresolved rule and a prompt-injection document.",
    // AI stays off while seeding so ingestion never queues AI interpretation (a running worker would otherwise claim
    // those jobs before they could be cancelled). It is switched on at the end.
    ai_enabled: false,
    is_demo: true,
  });
  const pid = project.id;
  for (const f of await demoSourceFiles()) app.sources.ingest(user, pid, { filename: f.filename, bytes: f.bytes });
  await drainJobs(app, ["ingest"]);
  // A separately running worker may have claimed some ingest jobs: wait until every one has finished before
  // switching AI on, or those jobs would queue AI interpretation.
  for (let i = 0; i < 600; i++) {
    const busy = app.ctx.queue.list({ projectId: pid }).some((j) => j.type === "ingest" && ["queued", "running", "retrying"].includes(j.status));
    if (!busy) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  const k = app.knowledge;
  const r1 = k.createDraft(user, pid, "requirement", {
    title: "Email must be verified before first sign-in",
    fields: { type: "functional", module: "accounts", actors: ["Customer"], feature_scopes: ["email-verification"] },
    sections: {
      description: "After sign-up the portal sends a verification link. A customer cannot sign in until the email address is verified.",
      behavior: [
        { text: "After sign-up, the portal sends a verification link to the customer's email address.", basis: "source_stated", review_state: "accepted" },
        { text: "A customer whose email is not verified cannot sign in.", basis: "source_stated", review_state: "accepted" },
      ],
      acceptance_criteria: [{ text: "Signing in with an unverified email shows a message explaining that verification is required.", basis: "human_authored", review_state: "accepted" }],
      open_questions: ["How long the verification link stays valid is not decided (see QUESTION-001)."],
    },
    source_refs: refFor(app, pid, "verify their email address before they can sign in"),
  });
  k.transition(user, pid, r1.human_id, { to: "approved", expected_revision: r1.revision, confirmation: `approve ${r1.human_id}`, note: "demo seed" });

  k.createDraft(
    user,
    pid,
    "requirement",
    {
      title: "Customers can request a new verification email",
      fields: { type: "functional", module: "accounts", actors: ["Customer"], feature_scopes: ["email-verification"] },
      sections: {
        description: "From the follow-up email: customers should be able to request a new verification email.",
        behavior: [{ text: "A customer can request a new verification email from the sign-in screen.", basis: "source_stated", review_state: "proposed" }],
        acceptance_criteria: [{ text: "Requesting a new email invalidates the previous link.", basis: "ai_inferred", review_state: "proposed" }],
      },
      source_refs: refFor(app, pid, "request a new verification email"),
    },
    "ai_proposed",
  );

  const r3 = k.createDraft(user, pid, "requirement", {
    title: "Minimum password length",
    fields: { type: "business_rule", module: "accounts", actors: ["Customer"], feature_scopes: ["account-registration"] },
    sections: { description: "Passwords must meet a minimum length. The sources disagree on the value (see CONFLICT-001)." },
    source_refs: [...refFor(app, pid, "at least 8 characters"), ...refFor(app, pid, "Minimum password length")],
  });
  k.transition(user, pid, r3.human_id, { to: "in_review", expected_revision: r3.revision });

  const r4 = k.createDraft(user, pid, "requirement", {
    title: "Invoice history covers 24 months",
    fields: { type: "functional", module: "invoices", actors: ["Customer"], feature_scopes: ["invoices"] },
    sections: {
      description: "Signed-in customers can view and download invoices from the last 24 months as PDF.",
      behavior: [{ text: "Invoice history shows the last 24 months.", basis: "source_stated", review_state: "accepted" }],
    },
    source_refs: refFor(app, pid, "last 24 months"),
  });
  k.transition(user, pid, r4.human_id, { to: "approved", expected_revision: r4.revision, confirmation: `approve ${r4.human_id}`, note: "demo seed" });

  const d1 = k.createDraft(user, pid, "decision", {
    title: "Invoice history window is 24 months",
    fields: { affected_requirements: [r4.human_id], feature_scopes: ["invoices"] },
    sections: {
      question: "How far back should invoice history go?",
      options: ["12 months", "24 months", "All history"],
      selected: "24 months",
      rationale: "Stated in both the requirements document and the business rules sheet; confirmed by the client.",
    },
    source_refs: [...refFor(app, pid, "last 24 months"), ...refFor(app, pid, "Invoice history shown")],
  });
  k.transition(user, pid, d1.human_id, { to: "approved", expected_revision: d1.revision, confirmation: `approve ${d1.human_id}`, note: "demo seed" });

  k.createDraft(user, pid, "conflict", {
    title: "Minimum password length: 8 or 12 characters",
    fields: { blocking: true, feature_scopes: ["account-registration"], related_requirements: [r3.human_id] },
    sections: {
      description: "The requirements document says passwords need at least 8 characters; the business rules sheet says 12.",
      sides: ["Side 1: at least 8 characters (requirements v1)", "Side 2: 12 characters (business rules sheet, BR-01)"],
    },
    source_refs: [...refFor(app, pid, "at least 8 characters", "side 1"), ...refFor(app, pid, "Minimum password length", "side 2")],
  });

  k.createDraft(user, pid, "open_question", {
    title: "How long is the email verification link valid?",
    fields: { blocking: true, feature_scopes: ["email-verification"], related_requirements: [r1.human_id] },
    sections: {
      question: "How long does the verification link stay valid before it expires?",
      context: "The client explicitly said this has not been decided and asked us not to assume a value.",
    },
    source_refs: refFor(app, pid, "how long the verification link stays valid"),
  });
  app.projects.update(user, pid, { ai_enabled: true });
  return { projectId: pid };
}
