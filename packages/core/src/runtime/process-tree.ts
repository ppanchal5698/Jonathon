import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * Terminate a process and all of its descendants.
 * Windows: `taskkill /PID <pid> /T /F` (tree kill). POSIX: the child is spawned as a process-group leader
 * (`detached: true`), so signalling the negative PID reaches the whole group; SIGTERM then SIGKILL.
 */
export function killProcessTree(child: ChildProcess, graceMs = 2_000): Promise<void> {
  const pid = child.pid;
  if (!pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => resolve();
    child.once("exit", done);
    if (process.platform === "win32") {
      const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
      const tk = spawn(join(sysRoot, "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        shell: false,
      });
      tk.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          /* already gone */
        }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }, graceMs).unref();
    }
    // Never hang the caller if the exit event does not arrive.
    setTimeout(done, graceMs + 3_000).unref();
  });
}

/** Spawn options that make tree termination possible on each OS. */
export function treeSpawnOptions(): { detached: boolean; windowsHide: boolean } {
  return { detached: process.platform !== "win32", windowsHide: true };
}

/** True if a PID is still alive (used by tests to prove grandchildren were terminated). */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
