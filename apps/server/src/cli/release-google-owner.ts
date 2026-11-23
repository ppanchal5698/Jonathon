/**
 * Recovery: unlink the local account from its Google identity (e.g. the owner's Google account was lost or replaced).
 * Data, approvals and tokens stay. The next Sign in with Google links the account again, but ONLY for an email listed in
 * JONATHON_GOOGLE_ALLOWED_EMAILS, so set that first.
 *
 *   docker compose --env-file docker/compose.env exec server node --import tsx src/cli/release-google-owner.ts --yes
 *   pnpm tsx apps/server/src/cli/release-google-owner.ts --yes        (native)
 */
import { audit, loadConfig, loadDotEnv, openDatabase } from "@jonathon/core";

if (!process.argv.includes("--yes")) {
  console.error("This unlinks the local account from its Google sign-in. Re-run with --yes. Set JONATHON_GOOGLE_ALLOWED_EMAILS to the new owner first.");
  process.exit(2);
}
loadDotEnv();
const config = loadConfig();
if (config.google && !config.google.allowedEmails.length) {
  console.error("Set JONATHON_GOOGLE_ALLOWED_EMAILS to the Google account that should own Jonathon, restart, then run this again.");
  process.exit(1);
}
const db = openDatabase(config.dbPath);
const user = db.prepare("SELECT id, username FROM users LIMIT 1").get() as { id: string; username: string } | undefined;
if (!user) {
  console.log("No account exists yet; nothing to release.");
} else {
  db.prepare("UPDATE users SET google_sub = NULL WHERE id = ?").run(user.id);
  db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
  audit(db, { principal: { kind: "system", name: "cli" }, action: "account.google_released", entityType: "user", entityId: user.id });
  console.log(`Released ${user.username}: all sessions ended. The next sign-in from an allowed Google account links it again.`);
}
db.close();
