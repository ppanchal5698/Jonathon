import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * One end-to-end story through the real UI, API, worker and runtime adapter (fixture CLI, no network):
 * setup → project (AI consent) → upload → automatic AI drafts → review queue (approve, edit, re-approve, delete,
 * reject) → inspect extraction → ask → inspect citation → conflict resolution → MCP credential create/revoke.
 */
const DEMO = join(process.cwd(), "packages/test-fixtures/demo");
const PASSWORD = "e2e correct horse battery";

test.describe.configure({ mode: "serial" });

test("full workflow", async ({ page }) => {
  // ---- Setup ----
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByText("Data sharing notice")).toBeVisible();
  await page.getByLabel("Username").fill("parth");
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();

  // ---- Create project (the AI-processing consent box is shown and ticked by default) ----
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("E2E portal");
  await expect(page.getByRole("checkbox", { name: /Draft requirements from uploaded documents with AI/ })).toBeChecked();
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: /E2E portal/ })).toBeVisible();
  await expect(page.getByText("AI processing on")).toBeVisible();

  // ---- Upload multiple files ----
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.locator('input[type="file"]').setInputFiles([join(DEMO, "01-initial-requirements.md"), join(DEMO, "02-follow-up-email.eml"), join(DEMO, "AGENTS.md")]);
  await expect(page.getByText(/3 file\(s\) stored/)).toBeVisible();
  await expect(page.getByRole("link", { name: "01-initial-requirements.md" })).toBeVisible();
  await expect.poll(async () => page.getByText("succeeded").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
  // Uploading is enough: AI drafts are created automatically and summarised per document.
  await expect(page.getByText("AI drafts from documents")).toBeVisible({ timeout: 60_000 });
  await expect.poll(async () => page.getByText(/\d+ requirements? · \d+ questions? · /).count(), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);

  // ---- Review the AI drafts: approve, edit (back to review), re-approve, delete ----
  await page.getByRole("tab", { name: /^Review/ }).click();
  await expect(page.getByRole("heading", { name: /Requirements/, level: 2 })).toBeVisible();
  await page.getByRole("button", { name: "Approve REQ-001" }).click();
  await expect(page.getByRole("dialog")).toContainText("Approval is recorded under your name");
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("REQ-001 approved.")).toBeVisible();
  await page.getByRole("button", { name: "Delete QUESTION-001" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("QUESTION-001 deleted.")).toBeVisible();
  await page.getByRole("link", { name: "REQ-001", exact: true }).first().click();
  await expect(page.getByText(/approved by parth/)).toBeVisible();
  await page.getByRole("button", { name: "Edit REQ-001" }).click();
  await page.getByLabel("Title").fill("Email must be verified before first sign-in");
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByText("Saved as a new revision.")).toBeVisible();
  await expect(page.getByText("in review").first()).toBeVisible();
  await page.getByRole("button", { name: "Approve REQ-001" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/approved by parth/)).toBeVisible();

  // ---- Inspect extraction ----
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "E2E portal" }).click();
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.getByRole("link", { name: "01-initial-requirements.md" }).click();
  await expect(page.getByText(/Customers must verify their email address/).first()).toBeVisible();
  await expect(page.getByText(/sha256/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Download original" })).toBeVisible();
  await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Documents" }).click();

  // ---- A hand-written draft, rejected from the list ----
  await page.getByRole("tab", { name: "Requirements" }).click();
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Title").fill("Remember-me checkbox on the sign-in page");
  await page.getByLabel("Description").fill("Not from the client; an idea to discuss.");
  await page.getByRole("button", { name: "Create draft" }).click();
  const row = page.getByRole("row", { name: /Remember-me checkbox/ });
  await row.getByRole("button", { name: /^Reject REQ-/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reject" }).click();
  await expect(row.getByText("rejected")).toBeVisible();

  // ---- Ask a question and inspect a citation ----
  await page.getByRole("tab", { name: "Chat" }).click();
  await page.getByLabel("Question").fill("Must customers verify their email before signing in?");
  await page.getByLabel("Feature scope (optional)").fill("email-verification");
  await page.getByRole("button", { name: /Ask/ }).click();
  await expect(page.getByText("Sources")).toBeVisible({ timeout: 45_000 });
  await page.getByRole("button", { name: /cite_1/ }).first().click();
  await expect(page.getByText("Quote check")).toBeVisible();
  await expect(page.getByText(/found verbatim|NOT found/)).toBeVisible();
  // Follow-up in the same conversation
  await page.getByLabel("Follow-up question").fill("And what about after that?");
  await page.getByRole("button", { name: /Ask/ }).click();
  await expect(page.getByText("Sources").nth(1)).toBeVisible({ timeout: 45_000 });

  // ---- Conflict: record and resolve with a human decision ----
  await page.getByRole("tab", { name: "Conflicts" }).click();
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Title").fill("Minimum password length: 8 or 12");
  await page.getByLabel("Description").fill("Requirements say 8 characters; business rules say 12.");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("row", { name: /Minimum password length: 8 or 12/ }).getByRole("link").first().click();
  await page.getByLabel(/Selected outcome/).fill("12 characters minimum.");
  await page.getByLabel("Rationale").fill("Client confirmed by phone on 16 Nov.");
  // AI drafting may already have created conflicts, so read this one's ID from the confirmation label.
  const resolveLabel = page.getByText(/Type "resolve CONFLICT-\d+" to confirm/);
  const phrase = /"(resolve CONFLICT-\d+)"/.exec((await resolveLabel.textContent()) ?? "")?.[1] ?? "";
  await page.getByLabel(/Type "resolve CONFLICT-\d+" to confirm/).fill(phrase);
  await page.getByRole("button", { name: "Record approved decision" }).click();
  await expect(page.getByText("resolved").first()).toBeVisible();

  // ---- MCP credential: create (shown once) and revoke ----
  await page.goto("/mcp");
  await page.getByRole("checkbox", { name: "E2E portal" }).check();
  await page.getByRole("button", { name: "Create credential" }).click();
  await expect(page.getByText("New credential (shown once)")).toBeVisible();
  await expect(page.locator("pre").first()).toContainText("jon_");
  await page.getByRole("button", { name: "I stored it" }).click();
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByText("revoked")).toBeVisible();
});
