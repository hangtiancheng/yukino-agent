import { readFile } from "node:fs/promises";
import path from "node:path";

export interface LoadedDoc {
  content: string;
  source: string;
}

export async function loadFile(filePath: string): Promise<LoadedDoc> {
  const content = await readFile(filePath, "utf-8");
  const source = path.basename(filePath);
  return { content, source };
}
