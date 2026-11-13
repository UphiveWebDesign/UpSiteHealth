import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import path from "node:path";

/**
 * Writing a new private file atomically (the definitions fingerprint's
 * --out): the content goes to a temporary file created exclusively with
 * mode 0600 in the destination's folder, is flushed to disk, and is then
 * hard-linked to the final name. link() fails if the name exists, so an
 * existing file is never replaced, and the final name only ever holds the
 * complete content. The temporary file is then removed. Parent folders are
 * never created.
 */

/** The file-system calls used, so tests can make each one fail. */
export type OutputFs = Pick<
  typeof nodeFs,
  | "lstatSync"
  | "statSync"
  | "openSync"
  | "writeSync"
  | "fsyncSync"
  | "fchmodSync"
  | "closeSync"
  | "linkSync"
  | "unlinkSync"
>;

export const FILE_MODE = 0o600;

/** A file-system error as words, without anything but the code. */
export function fsReason(error: unknown): string {
  const code = (error as { code?: unknown })?.code;
  switch (code) {
    case "EEXIST":
      return "it already exists";
    case "ENOENT":
      return "its folder does not exist";
    case "ENOTDIR":
      return "a part of the path is not a folder";
    case "EACCES":
    case "EPERM":
      return "permission denied";
    case "ENOSPC":
      return "no space left on the device";
    case "EROFS":
      return "the file system is read-only";
    case "EXDEV":
    case "ENOTSUP":
    case "EOPNOTSUPP":
      return "the file system does not support hard links";
    default:
      return typeof code === "string" ? code : "an unexpected error";
  }
}

/**
 * Null when `file` can be written as a new file, else why not: it must be
 * absolute, must not exist (not even as a symbolic link), and its folder
 * must exist. Checked before connecting; writeNewFile checks again.
 */
export function outputPathProblem(
  file: string,
  fs: OutputFs = nodeFs,
): string | null {
  if (!path.isAbsolute(file)) return "--out must be an absolute path";
  if (file.endsWith(path.sep) || file.endsWith("/"))
    return "--out must name a file, not a folder";
  try {
    fs.lstatSync(file);
    return `${file} already exists; it is never overwritten`;
  } catch (error) {
    if ((error as { code?: unknown })?.code !== "ENOENT")
      return `${file} cannot be checked (${fsReason(error)})`;
  }
  const dir = path.dirname(file);
  try {
    if (!fs.statSync(dir).isDirectory()) return `${dir} is not a folder`;
  } catch (error) {
    return `${dir} cannot be used (${fsReason(error)})`;
  }
  return null;
}

/** The temporary name: hidden, next to the final file, unique. */
export function temporaryName(file: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
}

/**
 * Writes `text` to the new file `file` (mode 0600), atomically and never
 * over an existing file. On failure the final name is untouched and the
 * temporary file is removed; `leftover` names it if it could not be
 * (on success too).
 */
export function writeNewFile(
  file: string,
  text: string,
  fs: OutputFs = nodeFs,
  tmp: string = temporaryName(file),
):
  | { ok: true; leftover?: string }
  | { ok: false; error: string; leftover?: string } {
  let fd: number | undefined;
  let created = false;
  const fail = (step: string, error: unknown) => {
    if (fd !== undefined)
      try {
        fs.closeSync(fd);
      } catch {
        // Already failing; the close error adds nothing.
      }
    let leftover: string | undefined;
    if (created)
      try {
        fs.unlinkSync(tmp);
      } catch {
        leftover = tmp;
      }
    return {
      ok: false as const,
      error: `${step} (${fsReason(error)})`,
      leftover,
    };
  };
  try {
    fd = fs.openSync(tmp, "wx", FILE_MODE);
    created = true;
  } catch (error) {
    return fail("the temporary file could not be created", error);
  }
  try {
    // The mode given to open is reduced by the umask; set it exactly.
    fs.fchmodSync(fd, FILE_MODE);
    const data = Buffer.from(text, "utf8");
    let written = 0;
    while (written < data.length)
      written += fs.writeSync(fd, data, written, data.length - written);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    return fail("the temporary file could not be written", error);
  }
  try {
    fs.linkSync(tmp, file);
  } catch (error) {
    return fail(`${file} could not be created`, error);
  }
  try {
    fs.unlinkSync(tmp);
  } catch {
    // The file is complete at its final name; only the extra name remains.
    return { ok: true, leftover: tmp };
  }
  return { ok: true };
}
