import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";

function resolvePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return resolve(homedir(), filePath.slice(2));
  }
  if (isAbsolute(filePath)) {
    return filePath;
  }
  return resolve(homedir(), filePath);
}

export async function fileRead(path: string): Promise<string> {
  try {
    const resolved = resolvePath(path);
    const content = await readFile(resolved, "utf-8");
    return content;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR reading file: ${msg}`;
  }
}

export async function fileWrite(
  path: string,
  content: string,
): Promise<string> {
  try {
    const resolved = resolvePath(path);
    await mkdir(dirname(resolved), { recursive: true });
    await writeFile(resolved, content, "utf-8");
    return `OK: Written to ${resolved}`;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return `ERROR writing file: ${msg}`;
  }
}
