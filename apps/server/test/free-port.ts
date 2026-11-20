import { createServer } from "node:net";

/**
 * Ask the OS for a free loopback port. Fixed or random ranges can land in Windows' excluded port ranges (Hyper-V and
 * Docker reserve blocks such as 49682-49981), which made `listen` fail with EACCES.
 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });
}
