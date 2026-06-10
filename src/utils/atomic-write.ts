import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Atomically write a file.
 *
 * Plain `fs.writeFile` truncates the target and streams bytes in place, so a
 * crash mid-write (SIGKILL, OOM, power loss) leaves the only copy corrupt.
 * Instead we write to a sibling `.tmp` file and then `fs.rename()` it over the
 * target — rename is atomic on POSIX filesystems, so a reader sees either the
 * old file or the fully-written new one, never a half-written file.
 *
 * Strings are written as-is; anything else is JSON-serialized.
 */
export async function writeFileAtomic(
  file: string,
  data: string | object,
): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const body = typeof data === "string" ? data : JSON.stringify(data);
  await fs.writeFile(tmp, body);
  await fs.rename(tmp, file);
}
