import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * One end-to-end story through the real UI, API, worker and runtime adapter (fixture CLI, no network):
 * setup → project → upload → inspect extraction → draft → review/approve → ask → inspect citation →
 * conflict resolution → MCP credential create/revoke.
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
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  // ---- Create project ----
  await page.getByRole("button", { name: "New project" }).click();
  await page.getByLabel("Project name").fill("E2E portal");
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: /E2E portal/ })).toBeVisible();

  // ---- Enable AI processing (explicit consent) ----
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // ---- Upload multiple files ----
  await page.getByRole("tab", { name: "Documents" }).click();
  await page.locator('input[type="file"]').setInputFiles([join(DEMO, "01-initial-requirements.md"), join(DEMO, "02-follow-up-email.eml"), join(DEMO, "AGENTS.md")]);
  await expect(page.getByText(/3 file\(s\) stored/)).toBeVisible();
  await expect(page.getByRole("link", { name: "01-initial-requirements.md" })).toBeVisible();
  await expect.poll(async () => page.getByText("succeeded").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(3);

  // ---- Inspect extraction ----
  await page.getByRole("link", { name: "01-initial-requirements.md" }).click();
  await expect(page.getByText(/Customers must verify their email address/).first()).toBeVisible();
  await expect(page.getByText(/sha256/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Download original" })).toBeVisible();
  await page.getByRole("link", { name: "← Documents" }).click();

  // ---- Create a draft requirement and approve it ----
  await page.getByRole("tab", { name: "Requirements" }).click();
  await page.getByRole("button", { name: "New draft" }).click();
  await page.getByLabel("Title").fill("Email must be verified before first sign-in");
  await page.getByLabel("Description").fill("Customers must verify their email address before they can sign in for the first time.");
  await page.getByLabel("Feature scopes").fill("email-verification");
  await page.getByRole("button", { name: "Create draft" }).click();
  await page.getByRole("link", { name: "REQ-001" }).click();
  await expect(page.getByRole("heading", { name: /REQ-001/ })).toBeVisible();
  await page.getByLabel("Change status to").selectOption("approved");
  const apply = page.getByRole("button", { name: "Apply" });
  await expect(apply).toBeDisabled();
  await page.getByLabel('Type "approve REQ-001" to confirm').fill("approve REQ-001");
  await apply.click();
  await expect(page.getByText(/approved by parth/)).toBeVisible();

  // ---- Ask a question and inspect a citation ----
  await page.goto(page.url().replace(/\/entities\/.*$/, "?tab=chat"));
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
  await page.getByRole("link", { name: "CONFLICT-001" }).click();
  await page.getByLabel(/Selected outcome/).fill("12 characters minimum.");
  await page.getByLabel("Rationale").fill("Client confirmed by phone on 16 Nov.");
  await page.getByLabel('Type "resolve CONFLICT-001" to confirm').fill("resolve CONFLICT-001");
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
