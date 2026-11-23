/**
 * Test helper process (reliability.test.ts): one of several processes sharing one SQLite file, like the API and the
 * worker in production. "worker-*" claims and completes jobs until none are left, printing each claimed job id.
 * "api-writer" keeps committing short write transactions (like API requests) while the workers run.
 */
import { JobQueue, openDatabase, tx } from "@jonathon/core";

const [dbPath, role] = process.argv.slice(2) as [string, string];
const db = openDatabase(dbPath);

if (role === "api-writer") {
  db.exec("CREATE TABLE IF NOT EXISTS api_writes (at TEXT NOT NULL)");
  let writes = 0;
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    tx(db, () => db.prepare("INSERT INTO api_writes VALUES (?)").run(new Date().toISOString()));
    writes++;
  }
  console.log(`writes=${writes}`);
} else {
  const q = new JobQueue(db);
  let idle = 0;
  while (idle < 20) {
    const job = q.claim(role, 30_000, ["reindex"]);
    if (!job) {
      idle++;
      await new Promise((r) => setTimeout(r, 25));
      continue;
    }
    idle = 0;
    console.log(job.id);
    if (!q.complete(job.id, role, "succeeded", { by: role })) throw new Error(`lost lease on ${job.id}`);
  }
}
db.close();
