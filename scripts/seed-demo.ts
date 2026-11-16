/**
 * Seed the FICTIONAL demo project (Larkspur customer portal) into the configured data directory.
 * Requires the local account to exist (open the UI once to create it). Does not contact any model.
 *
 *   pnpm seed:demo
 */
import { createApp, loadConfig, loadDotEnv } from "@jonathon/core";
import { seedDemoProject } from "@jonathon/test-fixtures";

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const app = createApp(config);
  const user = app.ctx.db.prepare("SELECT id, username FROM users LIMIT 1").get() as { id: string; username: string } | undefined;
  if (!user) {
    console.error("Create the local account first: run `pnpm dev`, open http://127.0.0.1:3000 and complete setup. Then run this again.");
    process.exit(1);
  }
  const existing = app.ctx.db.prepare("SELECT id FROM projects WHERE is_demo = 1").get() as { id: string } | undefined;
  if (existing) {
    console.log(`A demo project already exists (${existing.id}). Nothing to do.`);
    return;
  }
  const { projectId } = await seedDemoProject(app, { kind: "user", userId: user.id, username: user.username });
  console.log(`Seeded the fictional demo project ${projectId}.`);
  console.log("Approvals in it are recorded under your account with the note 'demo seed'.");
  app.close();
}

main().catch((e) => {
  console.error(`seed failed: ${(e as Error).message}`);
  process.exit(1);
});
