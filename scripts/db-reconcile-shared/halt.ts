import {
  accessSync,
  closeSync,
  constants,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fsReason } from "../db-readiness/secure-output";
import { type HaltState, type HaltStore } from "./run";

const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * The reconciliation's halt files, one per location (scripts/db-reconcile-shared.ts
 * uses two, in different directories). Fails closed: a halt file that cannot
 * be read, is not a regular file, or sits in a missing or unusable
 * directory counts as "unknown", which refuses every command, never as
 * "absent". Each file is created only with O_EXCL (never replaced) and mode
 * 0600.
 */
export function haltStore(files: readonly string[]): HaltStore {
  return {
    inspect(): HaltState {
      const reasons: string[] = [];
      for (const file of files) {
        const dir = path.dirname(file);
        try {
          if (!lstatSync(dir).isDirectory())
            return { state: "unknown", error: `${dir} is not a directory` };
        } catch (error) {
          return { state: "unknown", error: `${dir}: ${fsReason(error)}` };
        }
        let isFile: boolean;
        try {
          isFile = lstatSync(file).isFile();
        } catch (error) {
          if (code(error) === "ENOENT") continue;
          return { state: "unknown", error: `${file}: ${fsReason(error)}` };
        }
        if (!isFile)
          return { state: "unknown", error: `${file} is not a regular file` };
        try {
          reasons.push(readFileSync(file, "utf8").trim() || "(empty)");
        } catch (error) {
          return { state: "unknown", error: `${file}: ${fsReason(error)}` };
        }
      }
      return reasons.length
        ? { state: "present", reason: reasons.join(" | ") }
        : { state: "absent" };
    },

    writable(): string | null {
      for (const file of files) {
        const dir = path.dirname(file);
        const probe = `${file}.probe-${process.pid}`;
        try {
          if (!lstatSync(dir).isDirectory()) return `${dir} is not a directory`;
          accessSync(dir, constants.W_OK | constants.X_OK);
          closeSync(openSync(probe, "wx", 0o600));
          unlinkSync(probe);
        } catch (error) {
          return `${dir}: ${fsReason(error)}`;
        }
      }
      return null;
    },

    write(reason: string) {
      let written = 0;
      const failed: string[] = [];
      const text = `${new Date().toISOString()} ${reason}\n`;
      for (const file of files) {
        try {
          writeFileSync(file, text, { flag: "wx", mode: 0o600 });
          written++;
        } catch (error) {
          // One already there halts just the same.
          if (code(error) === "EEXIST") written++;
          else failed.push(`${file}: ${fsReason(error)}`);
        }
      }
      return { written, failed };
    },
  };
}
