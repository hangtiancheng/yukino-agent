import { createHash } from "node:crypto";

export const MAX_CHUNKS_PER_DOCUMENT = 5000;

const MARKDOWN_SUFFIXES = new Set([
  ".md",
  ".markdown",
  ".mdx",
  ".pdf",
  ".docx",
]);
const STRUCTURED_DATA_SUFFIXES = new Set([".json", ".csv"]);

export interface Chunk {
  content: string;
  chunk_id: string;
  parent_id: string;
  child_index: number;
  chunk_type: string;
  section_path: string[];
  section_title: string | null;
  page: number | null;
  start_line: number | null;
  end_line: number | null;
  [key: string]: unknown;
}

interface Block {
  text: string;
  startLine: number | null;
  endLine: number | null;
  kind: string;
  sectionPath: string[];
  sectionInstance: Array<[string, number]>;
  page: number | null;
  metadata: Record<string, unknown>;
}

function block(
  text: string,
  startLine: number | null,
  endLine: number | null,
  kind = "paragraph",
  sectionPath: string[] = [],
  sectionInstance: Array<[string, number]> = [],
  page: number | null = null,
  metadata: Record<string, unknown> = {},
): Block {
  return {
    text,
    startLine,
    endLine,
    kind,
    sectionPath,
    sectionInstance,
    page,
    metadata,
  };
}

function validateLimits(maxChars: number, overlap: number): void {
  if (maxChars <= 0) throw new Error("max_chars must be greater than zero");
  if (overlap < 0 || overlap >= maxChars) {
    throw new Error("overlap must be between zero and max_chars");
  }
}

function normalizeText(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function stableId(...parts: unknown[]): string {
  const raw = parts.map((part) => String(part)).join("\x1f");
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 24);
}

function lineForOffset(
  text: string,
  offset: number,
  firstLine: number | null,
): number | null {
  if (firstLine === null) return null;
  let count = 0;
  const end = Math.max(0, Math.min(offset, text.length));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) count++;
  }
  return firstLine + count;
}

function splitLongText(b: Block, maxChars: number): Block[] {
  if (b.text.length <= maxChars) return [b];

  let units = b.text
    .split(/(?<=[。！？!?])|(?<=[.!?])\s+|\n+/)
    .filter((unit) => unit && unit.trim() !== "");
  if (units.length <= 1) {
    units = [];
    for (let index = 0; index < b.text.length; index += maxChars) {
      units.push(b.text.slice(index, index + maxChars));
    }
  }

  const pieces: string[] = [];
  let current = "";
  for (let unit of units) {
    unit = unit.trim();
    if (unit === "") continue;
    if (unit.length > maxChars) {
      if (current) {
        pieces.push(current);
        current = "";
      }
      for (let index = 0; index < unit.length; index += maxChars) {
        pieces.push(unit.slice(index, index + maxChars));
      }
      continue;
    }
    const candidate = current ? `${current}\n${unit}` : unit;
    if (current && candidate.length > maxChars) {
      pieces.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);

  const output: Block[] = [];
  let cursor = 0;
  for (const piece of pieces) {
    let offset = b.text.indexOf(piece, cursor);
    if (offset < 0) offset = cursor;
    const endOffset = Math.min(b.text.length, offset + piece.length);
    output.push(
      block(
        piece,
        lineForOffset(b.text, offset, b.startLine),
        lineForOffset(b.text, Math.max(offset, endOffset - 1), b.startLine),
        b.kind,
        b.sectionPath,
        b.sectionInstance,
        b.page,
        { ...b.metadata },
      ),
    );
    cursor = endOffset;
  }
  return output;
}

function splitLongCodeFence(b: Block, maxChars: number): Block[] {
  if (b.text.length <= maxChars) return [b];
  const lines = b.text.split("\n");
  if (lines.length === 0) return [];
  if (maxChars <= 8) {
    return splitLongText(
      block(
        b.text,
        b.startLine,
        b.endLine,
        "code_fragment",
        b.sectionPath,
        b.sectionInstance,
        b.page,
        { ...b.metadata },
      ),
      maxChars,
    );
  }

  const firstIsFence =
    lines[0] !== undefined &&
    (lines[0].trimStart().startsWith("```") ||
      lines[0].trimStart().startsWith("~~~"));
  const originalOpener = firstIsFence ? lines[0] : "```";
  const marker = originalOpener.trimStart().slice(0, 3);
  const opener = marker;
  const lastLine = lines[lines.length - 1];
  const hasCloser =
    lines.length > 1 &&
    lastLine !== undefined &&
    lastLine.trimStart().startsWith(marker);
  const body = hasCloser ? lines.slice(1, -1) : lines.slice(1);
  const closing = marker;
  const wrapperSize = opener.length + closing.length + 2;
  const bodyLimit = maxChars - wrapperSize;

  if (body.length === 0) {
    return [
      block(
        `${opener}\n${closing}`,
        b.startLine,
        b.endLine,
        b.kind,
        b.sectionPath,
        b.sectionInstance,
        b.page,
        { ...b.metadata },
      ),
    ];
  }

  const makeFenceBlock = (
    text: string,
    startLine: number | null,
    endLine: number | null,
  ): Block =>
    block(
      text,
      startLine,
      endLine,
      b.kind,
      b.sectionPath,
      b.sectionInstance,
      b.page,
      {
        ...b.metadata,
        fence_start_line: b.startLine,
        fence_end_line: hasCloser ? b.endLine : null,
      },
    );

  const output: Block[] = [];
  let current: string[] = [];
  let currentSize = 0;
  const firstBodyLine = b.startLine !== null ? b.startLine + 1 : null;
  let currentStart = firstBodyLine;

  const flush = (endLine: number | null): void => {
    if (current.length === 0) return;
    const bodyText = current.join("\n");
    output.push(
      makeFenceBlock(
        `${opener}\n${bodyText}\n${closing}`,
        currentStart,
        endLine,
      ),
    );
    current = [];
    currentSize = 0;
  };

  for (let bodyIndex = 0; bodyIndex < body.length; bodyIndex++) {
    const line = body[bodyIndex] as string;
    const index = firstBodyLine !== null ? firstBodyLine + bodyIndex : null;
    if (line.length > bodyLimit) {
      flush(index !== null ? index - 1 : null);
      for (let offset = 0; offset < line.length; offset += bodyLimit) {
        const piece = line.slice(offset, offset + bodyLimit);
        output.push(
          makeFenceBlock(`${opener}\n${piece}\n${closing}`, index, index),
        );
      }
      currentStart = index !== null ? index + 1 : null;
      continue;
    }
    const lineSize = line.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentSize + lineSize > bodyLimit) {
      flush(index !== null ? index - 1 : null);
      currentStart = index;
    }
    if (current.length === 0) currentStart = index;
    current.push(line);
    currentSize += lineSize;
  }
  let lastBodyLine: number | null = null;
  if (b.endLine !== null) lastBodyLine = b.endLine - (hasCloser ? 1 : 0);
  flush(lastBodyLine);
  return output;
}

function expandBlock(b: Block, maxChars: number): Block[] {
  if (b.kind === "code_fence") return splitLongCodeFence(b, maxChars);
  return splitLongText(b, maxChars);
}

function overlapBlocks(blocks: Block[], overlap: number): Block[] {
  if (overlap <= 0 || blocks.length === 0) return [];
  const selected: Block[] = [];
  let remaining = overlap;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i] as Block;
    if (!b.text || b.kind === "code_fence") continue;
    const separator = selected.length > 0 ? 2 : 0;
    const allowance = remaining - separator;
    if (allowance <= 0) break;
    if (b.text.length <= allowance) {
      selected.push(b);
      remaining -= b.text.length + separator;
      continue;
    }
    const offset = b.text.length - allowance;
    const lookbackStart = Math.max(
      0,
      offset - Math.min(64, Math.max(16, allowance * 2)),
    );
    const lookback = b.text.slice(lookbackStart, offset);
    const sentenceBoundaries = [...lookback.matchAll(/[。！？.!?；;]\s*/g)];
    const wordBoundaries = [...lookback.matchAll(/\s+/g)];
    let fragmentOffset: number;
    if (sentenceBoundaries.length > 0) {
      const last = sentenceBoundaries[
        sentenceBoundaries.length - 1
      ] as RegExpExecArray;
      fragmentOffset = lookbackStart + last.index + last[0].length;
    } else if (wordBoundaries.length > 0) {
      const last = wordBoundaries[wordBoundaries.length - 1] as RegExpExecArray;
      fragmentOffset = lookbackStart + last.index + last[0].length;
    } else {
      const boundaryWindow = b.text.slice(
        offset,
        offset + Math.min(48, Math.max(8, Math.floor(allowance / 3))),
      );
      const boundary = /\s+|[。！？.!?；;]\s*/.exec(boundaryWindow);
      fragmentOffset = boundary
        ? offset + boundary.index + boundary[0].length
        : offset;
    }
    selected.push(
      block(
        b.text.slice(fragmentOffset),
        lineForOffset(b.text, fragmentOffset, b.startLine),
        b.endLine,
        b.kind,
        b.sectionPath,
        b.sectionInstance,
        b.page,
        { ...b.metadata, overlap_fragment: true },
      ),
    );
    remaining = 0;
    break;
  }
  return selected.reverse();
}

function sectionPrefix(
  path: string[],
  page: number | null,
  limit?: number,
): string {
  const parts = path.map(
    (title, index) => `${"#".repeat(Math.min(index + 1, 6))} ${title}`,
  );
  if (page !== null) parts.push(`Page ${page}`);
  const value = parts.join("\n");
  if (limit === undefined || value.length <= limit) return value;
  if (limit <= 3) return value.slice(0, limit);
  return `${value.slice(0, limit - 3).trimEnd()}...`;
}

function prefixForChunk(
  path: string[],
  page: number | null,
  maxChars: number,
  hasBody: boolean,
): string {
  if (path.length === 0 && page === null) return "";
  let limit: number;
  if (!hasBody) {
    limit = maxChars;
  } else if (maxChars <= 3) {
    limit = 0;
  } else {
    limit = Math.min(512, Math.floor(maxChars / 3), maxChars - 3);
  }
  return limit > 0 ? sectionPrefix(path, page, limit) : "";
}

function joinBlockText(blocks: Block[]): string {
  return blocks
    .filter((b) => b.text)
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

function emitChunk(
  blocks: Block[],
  opts: {
    sourcePath: string;
    chunkType: string;
    childIndex: number;
    maxChars: number;
  },
): Chunk {
  const first = blocks[0] as Block;
  const body = joinBlockText(blocks);
  const prefix = prefixForChunk(
    first.sectionPath,
    first.page,
    opts.maxChars,
    body !== "",
  );
  const content = prefix && body ? `${prefix}\n\n${body}` : prefix || body;
  const instanceKey =
    first.sectionInstance.length > 0
      ? first.sectionInstance
      : first.sectionPath.map((title) => [title, 0] as [string, number]);
  const parentId = stableId(
    "parent",
    opts.sourcePath,
    JSON.stringify(instanceKey),
    first.page,
  );
  const effectiveType = blocks.some((b) => b.kind === "code_fence")
    ? "markdown_code"
    : opts.chunkType;
  const metadata: Record<string, unknown> = {};
  for (const b of blocks) Object.assign(metadata, b.metadata);
  const startLines = blocks
    .filter((b) => b.startLine !== null)
    .map((b) => b.startLine as number);
  const endLines = blocks
    .filter((b) => b.endLine !== null)
    .map((b) => b.endLine as number);
  return {
    content,
    chunk_id: stableId("chunk", parentId, opts.childIndex, content),
    parent_id: parentId,
    child_index: opts.childIndex,
    chunk_type: effectiveType,
    section_path: first.sectionPath,
    section_title:
      first.sectionPath.length > 0
        ? (first.sectionPath[first.sectionPath.length - 1] as string)
        : null,
    page: first.page,
    start_line: startLines.length > 0 ? Math.min(...startLines) : null,
    end_line: endLines.length > 0 ? Math.max(...endLines) : null,
    ...metadata,
  };
}

function packBlocks(
  blocks: Block[],
  opts: {
    sourcePath: string;
    maxChars: number;
    overlap: number;
    chunkType: string;
  },
): Chunk[] {
  const chunks: Chunk[] = [];
  let current: Block[] = [];
  let currentKey: string | null = null;
  const childCounts = new Map<string, number>();

  const flush = (): void => {
    if (current.length === 0 || currentKey === null) return;
    const childIndex = childCounts.get(currentKey) ?? 0;
    chunks.push(
      emitChunk(current, {
        sourcePath: opts.sourcePath,
        chunkType: opts.chunkType,
        childIndex,
        maxChars: opts.maxChars,
      }),
    );
    childCounts.set(currentKey, childIndex + 1);
  };

  for (const rawBlock of blocks) {
    let key = `${JSON.stringify(rawBlock.sectionInstance)}|${rawBlock.page}`;
    const blockPrefix = prefixForChunk(
      rawBlock.sectionPath,
      rawBlock.page,
      opts.maxChars,
      rawBlock.text !== "",
    );
    const prefixSize = blockPrefix.length;
    const bodyLimit = Math.max(
      1,
      opts.maxChars - prefixSize - (prefixSize > 0 ? 2 : 0),
    );
    for (const b of expandBlock(rawBlock, bodyLimit)) {
      key = `${JSON.stringify(b.sectionInstance)}|${b.page}`;
      if (current.length > 0 && key !== currentKey) {
        flush();
        current = [];
      }
      currentKey = key;
      const candidateBody = joinBlockText([...current, b]);
      const prefix = prefixForChunk(
        b.sectionPath,
        b.page,
        opts.maxChars,
        candidateBody !== "",
      );
      const candidateSize =
        candidateBody.length + prefix.length + (prefix ? 2 : 0);
      if (current.length > 0 && candidateSize > opts.maxChars) {
        const previous = [...current];
        flush();
        current = overlapBlocks(previous, opts.overlap);
        while (current.length > 0) {
          const nextBody = joinBlockText([...current, b]);
          if (
            nextBody.length + prefix.length + (prefix ? 2 : 0) <=
            opts.maxChars
          )
            break;
          current.shift();
        }
      }
      current.push(b);
    }
  }
  flush();
  if (chunks.some((chunk) => chunk.content.length > opts.maxChars)) {
    throw new Error("chunk content exceeded max_chars");
  }
  return chunks;
}

function plainBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let current: string[] = [];
  let startLine = 1;

  const flush = (endLine: number): void => {
    const content = current.join("\n").trim();
    if (content)
      blocks.push(block(content, startLine, Math.max(startLine, endLine)));
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNumber = i + 1;
    if (line.trim() === "") {
      flush(lineNumber - 1);
      continue;
    }
    if (current.length === 0) startLine = lineNumber;
    current.push(line);
  }
  flush(lines.length);
  return blocks;
}

function lastIndexOfInRange(
  text: string,
  searchValue: string,
  from: number,
  to: number,
): number {
  let found = -1;
  let index = text.indexOf(searchValue, from);
  while (index !== -1 && index < to) {
    found = index;
    index = text.indexOf(searchValue, index + 1);
  }
  return found;
}

function plainChunks(
  text: string,
  opts: { sourcePath: string; maxChars: number; overlap: number },
): Chunk[] {
  const chunks: Chunk[] = [];
  const parentId = stableId("parent", opts.sourcePath, "plain");
  const { maxChars, overlap } = opts;
  let cursor = 0;
  const textLength = text.length;
  while (cursor < textLength) {
    let end = Math.min(textLength, cursor + maxChars);
    if (end < textLength) {
      const searchStart = cursor + Math.max(1, Math.floor(maxChars / 2));
      const boundary = Math.max(
        lastIndexOfInRange(text, "\n\n", searchStart, end),
        lastIndexOfInRange(text, "\n", searchStart, end),
      );
      if (boundary > cursor) {
        end = boundary + (text.startsWith("\n\n", boundary) ? 2 : 1);
      }
    }

    const raw = text.slice(cursor, end);
    const leftTrim = raw.length - raw.trimStart().length;
    const rightTrim = raw.trimEnd().length;
    const content = raw.slice(leftTrim, rightTrim);
    if (content) {
      const startOffset = cursor + leftTrim;
      const endOffset = cursor + rightTrim;
      const childIndex = chunks.length;
      chunks.push({
        content,
        chunk_id: stableId("chunk", parentId, childIndex, content),
        parent_id: parentId,
        child_index: childIndex,
        chunk_type: "text",
        section_path: [],
        section_title: null,
        page: null,
        start_line: lineForOffset(text, startOffset, 1),
        end_line: lineForOffset(text, Math.max(startOffset, endOffset - 1), 1),
      });
      if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
        throw new Error(
          `document exceeds the ${MAX_CHUNKS_PER_DOCUMENT} chunk limit`,
        );
      }
    }
    if (end >= textLength) break;
    cursor = Math.max(cursor + 1, end - overlap);
  }
  return chunks;
}

function markdownBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  const headings: Array<{ level: number; title: string; occurrence: number }> =
    [];
  const headingOccurrences = new Map<string, number>();
  let currentPage: number | null = null;
  let current: string[] = [];
  let currentStart = 1;
  let currentKind = "paragraph";
  let fenceMarker: string | null = null;
  const headingRe = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  const pageRe = /^<!--\s*page\s*:\s*(\d+)\s*-->$/i;

  const sectionPath = (): string[] => headings.map((h) => h.title);
  const sectionInstance = (): Array<[string, number]> =>
    headings.map((h) => [h.title, h.occurrence]);

  const flush = (endLine: number): void => {
    const content = current.join("\n").trim();
    if (content) {
      blocks.push(
        block(
          content,
          currentStart,
          Math.max(currentStart, endLine),
          currentKind,
          sectionPath(),
          sectionInstance(),
          currentPage,
        ),
      );
    }
    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineNumber = i + 1;
    const stripped = line.trim();
    if (fenceMarker !== null) {
      current.push(line);
      if (stripped.startsWith(fenceMarker)) {
        flush(lineNumber);
        fenceMarker = null;
        currentKind = "paragraph";
      }
      continue;
    }

    const pageMatch = pageRe.exec(stripped);
    if (pageMatch) {
      flush(lineNumber - 1);
      currentPage = Number.parseInt(pageMatch[1] as string, 10);
      continue;
    }

    const headingMatch = headingRe.exec(line);
    if (headingMatch) {
      flush(lineNumber - 1);
      const level = (headingMatch[1] as string).length;
      const title = (headingMatch[2] as string).trim();
      while (
        headings.length > 0 &&
        (headings[headings.length - 1] as { level: number }).level >= level
      ) {
        headings.pop();
      }
      const parentInstance = JSON.stringify(sectionInstance());
      const occurrenceKey = `${parentInstance}|${level}|${title}`;
      const occurrence = headingOccurrences.get(occurrenceKey) ?? 0;
      headingOccurrences.set(occurrenceKey, occurrence + 1);
      headings.push({ level, title, occurrence });
      blocks.push(
        block(
          "",
          lineNumber,
          lineNumber,
          "heading",
          sectionPath(),
          sectionInstance(),
          currentPage,
          {
            heading_line: lineNumber,
          },
        ),
      );
      continue;
    }

    if (stripped.startsWith("```") || stripped.startsWith("~~~")) {
      flush(lineNumber - 1);
      currentStart = lineNumber;
      currentKind = "code_fence";
      fenceMarker = stripped.slice(0, 3);
      current = [line];
      continue;
    }

    if (stripped === "") {
      flush(lineNumber - 1);
      continue;
    }
    if (current.length === 0) currentStart = lineNumber;
    current.push(line);
  }
  flush(lines.length);
  return blocks;
}

function jsonBlocks(text: string, maxChars: number): Block[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return plainBlocks(text);
  }

  const formatted = JSON.stringify(value, null, 2) ?? "";
  if (formatted.length <= maxChars) {
    return [
      block(
        formatted,
        1,
        Math.max(1, text.split("\n").length),
        "json_value",
        [],
        [],
        null,
        {
          json_path: "$",
        },
      ),
    ];
  }

  const blocks: Block[] = [];
  let items: Array<[string, unknown]>;
  if (Array.isArray(value)) {
    items = value.map((item, index) => [`$[${index}]`, item]);
  } else if (value !== null && typeof value === "object") {
    items = Object.entries(value as Record<string, unknown>).map(
      ([key, item]) => [`$.${key}`, { [key]: item }],
    );
  } else {
    items = [["$", value]];
  }
  for (const [jsonPath, item] of items) {
    blocks.push(
      block(
        JSON.stringify(item, null, 2) ?? "",
        null,
        null,
        "json_value",
        [jsonPath],
        [[jsonPath, 0]],
        null,
        { json_path: jsonPath },
      ),
    );
  }
  return blocks;
}

export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    row.push(field);
    field = "";
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i] as string;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }
    if (c === "\n") {
      pushRow();
      i += 1;
      continue;
    }
    if (c === "\r") {
      pushRow();
      if (text[i + 1] === "\n") i += 2;
      else i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

export function renderCsvRow(row: string[]): string {
  return row
    .map((value) => {
      if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
      return value;
    })
    .join(",");
}

function csvChunks(
  text: string,
  sourcePath: string,
  maxChars: number,
  overlap: number,
): Chunk[] {
  let rows: string[][];
  try {
    rows = parseCsvRows(text);
  } catch {
    return packBlocks(plainBlocks(text), {
      sourcePath,
      maxChars,
      overlap,
      chunkType: "text",
    });
  }
  if (rows.length === 0) return [];

  const render = (row: string[]): string => renderCsvRow(row);
  const header = render(rows[0] as string[]);
  const chunks: Chunk[] = [];
  const parentId = stableId("parent", sourcePath, "csv");

  const appendChunk = (
    content: string,
    opts: {
      rowStart: number;
      rowEnd: number;
      chunkType?: string;
      rowPart?: number | null;
      rowParts?: number | null;
      preciseLines?: boolean;
    },
  ): void => {
    const childIndex = chunks.length;
    const precise = opts.preciseLines ?? true;
    const chunk: Chunk = {
      content,
      chunk_id: stableId("chunk", parentId, childIndex, content),
      parent_id: parentId,
      child_index: childIndex,
      chunk_type: opts.chunkType ?? "csv_rows",
      section_path: [],
      section_title: null,
      page: null,
      start_line: precise ? opts.rowStart : null,
      end_line: precise ? opts.rowEnd : null,
      row_start: opts.rowStart,
      row_end: opts.rowEnd,
    };
    if (opts.rowPart !== null && opts.rowPart !== undefined) {
      chunk.row_part = opts.rowPart;
      chunk.row_parts = opts.rowParts;
    }
    chunks.push(chunk);
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(
        `document exceeds the ${MAX_CHUNKS_PER_DOCUMENT} chunk limit`,
      );
    }
  };

  let headerPrefix = "";
  if (header !== "" && header.length + 1 >= maxChars) {
    const headerParts: string[] = [];
    for (let index = 0; index < header.length; index += maxChars) {
      headerParts.push(header.slice(index, index + maxChars));
    }
    if (headerParts.length === 0) headerParts.push("");
    headerParts.forEach((part, partIndex) => {
      appendChunk(part, {
        rowStart: 1,
        rowEnd: 1,
        chunkType: "csv_header_part",
        rowPart: partIndex + 1,
        rowParts: headerParts.length,
        preciseLines: !part.includes("\n"),
      });
    });
    headerPrefix = "";
  } else {
    headerPrefix = header;
  }

  const bodyRows = rows.slice(1);
  if (bodyRows.length === 0) {
    if (chunks.length === 0) {
      appendChunk(header, {
        rowStart: 1,
        rowEnd: 1,
        preciseLines: !header.includes("\n"),
      });
    }
    return chunks;
  }

  const prefixSize = headerPrefix.length + (headerPrefix ? 1 : 0);
  const rowBudget = maxChars - prefixSize;
  interface Record_ {
    part: string;
    rowNumber: number;
    rowPart: number | null;
    rowParts: number | null;
    precise: boolean;
  }
  const records: Record_[] = [];
  for (let i = 0; i < bodyRows.length; i++) {
    const rowNumber = i + 2;
    const rendered = render(bodyRows[i] as string[]);
    const parts: string[] = [];
    for (let index = 0; index < rendered.length; index += rowBudget) {
      parts.push(rendered.slice(index, index + rowBudget));
    }
    if (parts.length === 0) parts.push("");
    parts.forEach((part, partIndex) => {
      records.push({
        part,
        rowNumber,
        rowPart: parts.length > 1 ? partIndex + 1 : null,
        rowParts: parts.length > 1 ? parts.length : null,
        precise: !rendered.includes("\n"),
      });
    });
  }

  let start = 0;
  while (start < records.length) {
    const selected: Record_[] = [];
    let index = start;
    while (index < records.length) {
      const candidateRows = selected.map((item) => item.part);
      candidateRows.push((records[index] as Record_).part);
      const candidate = headerPrefix
        ? [headerPrefix, ...candidateRows].join("\n")
        : candidateRows.join("\n");
      if (selected.length > 0 && candidate.length > maxChars) break;
      selected.push(records[index] as Record_);
      index += 1;
    }
    const selectedText = selected.map((item) => item.part);
    const content = headerPrefix
      ? [headerPrefix, ...selectedText].join("\n")
      : selectedText.join("\n");
    const rowStart = Math.min(...selected.map((item) => item.rowNumber));
    const rowEnd = Math.max(...selected.map((item) => item.rowNumber));
    const first = selected[0] as Record_;
    appendChunk(content, {
      rowStart,
      rowEnd,
      rowPart: selected.length === 1 ? first.rowPart : null,
      rowParts: selected.length === 1 ? first.rowParts : null,
      preciseLines: selected.every((item) => item.precise),
    });
    if (index >= records.length) break;
    if (overlap <= 0) {
      start = index;
      continue;
    }
    let size = 0;
    let overlapRecords = 0;
    for (let i = selected.length - 1; i >= 0; i--) {
      const record = selected[i] as Record_;
      const recordSize = record.part.length;
      if (overlapRecords > 0 && size + recordSize > overlap) break;
      size += recordSize;
      overlapRecords += 1;
      if (size >= overlap) break;
    }
    start = Math.max(start + 1, index - overlapRecords);
  }
  if (chunks.some((chunk) => chunk.content.length > maxChars)) {
    throw new Error("CSV chunk content exceeded max_chars");
  }
  return chunks;
}

function suffixOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

export function chunkDocument(
  text: string,
  sourcePath = "document.txt",
  maxChars = 1600,
  overlap = 160,
): Chunk[] {
  validateLimits(maxChars, overlap);
  if (!text) return [];
  const normalized = normalizeText(text);
  if (normalized.trim() === "") return [];

  const suffix = suffixOf(sourcePath);
  if (suffix === ".csv")
    return csvChunks(normalized, sourcePath, maxChars, overlap);
  let blocks: Block[];
  let chunkType: string;
  if (MARKDOWN_SUFFIXES.has(suffix)) {
    blocks = markdownBlocks(normalized);
    chunkType = "markdown_section";
  } else if (suffix === ".json") {
    blocks = jsonBlocks(normalized, maxChars);
    chunkType = "json_value";
  } else {
    return plainChunks(normalized, { sourcePath, maxChars, overlap });
  }
  const chunks = packBlocks(blocks, {
    sourcePath,
    maxChars,
    overlap,
    chunkType,
  });
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new Error(
      `document exceeds the ${MAX_CHUNKS_PER_DOCUMENT} chunk limit`,
    );
  }
  return chunks;
}

export function chunkDocumentText(
  text: string,
  maxChars = 1600,
  overlap = 160,
): string[] {
  return chunkDocument(text, "document.txt", maxChars, overlap).map(
    (chunk) => chunk.content,
  );
}

function lineWindows(
  lines: string[],
  startLine: number,
  endLine: number,
  maxChars: number,
  overlapLines = 6,
): Array<{ content: string; start: number; end: number }> {
  const output: Array<{ content: string; start: number; end: number }> = [];
  let cursor = Math.max(0, startLine - 1);
  const stop = Math.min(lines.length, endLine);
  while (cursor < stop) {
    const cursorLine = lines[cursor] as string;
    if (cursorLine.length > maxChars) {
      for (let offset = 0; offset < cursorLine.length; offset += maxChars) {
        output.push({
          content: cursorLine.slice(offset, offset + maxChars),
          start: cursor + 1,
          end: cursor + 1,
        });
      }
      cursor += 1;
      continue;
    }
    let size = 0;
    let end = cursor;
    while (end < stop) {
      const lineSize = (lines[end] as string).length + (end > cursor ? 1 : 0);
      if (end > cursor && size + lineSize > maxChars) break;
      size += lineSize;
      end += 1;
    }
    if (end > cursor) {
      const content = lines
        .slice(cursor, end)
        .join("\n")
        .replace(/^[\n]+|[\n]+$/g, "");
      if (content) output.push({ content, start: cursor + 1, end });
    }
    if (end >= stop) break;
    cursor = Math.max(cursor + 1, end - overlapLines);
  }
  return output;
}

interface SymbolPattern {
  pattern: RegExp;
  kind: string;
}

function patternsForSuffix(suffix: string): SymbolPattern[] {
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(suffix)) {
    return [
      {
        pattern:
          /^\s*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
        kind: "symbol",
      },
      {
        pattern:
          /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/,
        kind: "function",
      },
    ];
  }
  if (suffix === ".go") {
    return [
      {
        pattern: /^\s*(?:func\s+(?:\([^)]*\)\s*)?|type\s+)([A-Za-z_]\w*)/,
        kind: "symbol",
      },
    ];
  }
  if (suffix === ".rs") {
    return [
      {
        pattern:
          /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:fn|struct|enum|trait|impl)\s+([A-Za-z_]\w*)/,
        kind: "symbol",
      },
    ];
  }
  if (
    [
      ".java",
      ".kt",
      ".kts",
      ".cs",
      ".cpp",
      ".c",
      ".h",
      ".hpp",
      ".php",
      ".rb",
      ".swift",
      ".scala",
    ].includes(suffix)
  ) {
    return [
      {
        pattern:
          /^\s*(?:(?:public|private|protected|internal|static|final|abstract|sealed|data|open)\s+)*(?:class|interface|enum|struct|trait|record)\s+([A-Za-z_]\w*)/,
        kind: "type",
      },
    ];
  }
  if (suffix === ".sql") {
    return [
      {
        pattern:
          /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE|TABLE|VIEW)\s+([\w.]+)/i,
        kind: "sql_object",
      },
    ];
  }
  if ([".sh", ".bash", ".zsh", ".ps1"].includes(suffix)) {
    return [
      {
        pattern: /^\s*(?:function\s+)?([A-Za-z_]\w*)\s*(?:\(\))?\s*\{/,
        kind: "function",
      },
    ];
  }
  if (suffix === ".py") {
    return [
      { pattern: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
      { pattern: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    ];
  }
  return [];
}

function genericSymbol(
  line: string,
  suffix: string,
): { name: string; kind: string } | null {
  for (const { pattern, kind } of patternsForSuffix(suffix)) {
    const match = pattern.exec(line);
    if (match) return { name: match[1] as string, kind };
  }
  return null;
}

function genericRegions(
  text: string,
  suffix: string,
): Array<{ start: number; end: number; symbol: string; kind: string }> {
  const lines = text.split("\n");
  const starts: Array<{ line: number; name: string; kind: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const symbol = genericSymbol(lines[i] as string, suffix);
    if (symbol)
      starts.push({ line: i + 1, name: symbol.name, kind: symbol.kind });
  }
  if (starts.length === 0) {
    return lines.length > 0
      ? [{ start: 1, end: lines.length, symbol: "module", kind: "module" }]
      : [];
  }
  const regions: Array<{
    start: number;
    end: number;
    symbol: string;
    kind: string;
  }> = [];
  if ((starts[0] as { line: number }).line > 1) {
    regions.push({
      start: 1,
      end: (starts[0] as { line: number }).line - 1,
      symbol: "module",
      kind: "module",
    });
  }
  for (let i = 0; i < starts.length; i++) {
    const { line, name, kind } = starts[i] as {
      line: number;
      name: string;
      kind: string;
    };
    const next = starts[i + 1];
    regions.push({
      start: line,
      end: next ? next.line - 1 : lines.length,
      symbol: name,
      kind,
    });
  }
  return regions;
}

function languageForPath(path: string): string {
  const suffix = suffixOf(path).replace(/^\./, "");
  if (suffix) return suffix;
  return (path.split(/[\\/]/).pop() ?? path).toLowerCase();
}

export function chunkCodeText(
  text: string,
  path: string,
  maxChars = 2200,
): Chunk[] {
  if (maxChars <= 0) throw new Error("max_chars must be greater than zero");
  const normalized = normalizeText(text);
  if (normalized.trim() === "") return [];
  const suffix = suffixOf(path);
  const language = languageForPath(path);

  if (
    MARKDOWN_SUFFIXES.has(suffix) ||
    STRUCTURED_DATA_SUFFIXES.has(suffix) ||
    suffix === ".txt"
  ) {
    const documentChunks = chunkDocument(
      normalized,
      path,
      maxChars,
      Math.max(0, Math.min(160, Math.floor(maxChars / 10))),
    );
    const output: Chunk[] = [];
    for (const chunk of documentChunks) {
      const symbol = chunk.section_title ?? "document";
      const header = `File: ${path}\nSection: ${symbol}\nLines: ${chunk.start_line}-${chunk.end_line}`;
      output.push({
        ...chunk,
        symbol,
        symbol_kind: chunk.chunk_type,
        language,
        header,
      });
    }
    return output;
  }

  const lines = normalized.split("\n");
  let regions = genericRegions(normalized, suffix);
  if (regions.length === 0)
    regions = [
      { start: 1, end: lines.length, symbol: "module", kind: "module" },
    ];

  const chunks: Chunk[] = [];
  const symbolOccurrences = new Map<string, number>();
  for (const { start, end, symbol, kind } of regions) {
    const occurrence = symbolOccurrences.get(symbol) ?? 0;
    symbolOccurrences.set(symbol, occurrence + 1);
    const parentId = stableId("code-parent", path, symbol, occurrence);
    const windows = lineWindows(lines, start, end, maxChars);
    for (let partIndex = 0; partIndex < windows.length; partIndex++) {
      const {
        content,
        start: partStart,
        end: partEnd,
      } = windows[partIndex] as {
        content: string;
        start: number;
        end: number;
      };
      if (!content.trim()) continue;
      const chunkId = stableId("code", parentId, partIndex, content);
      const partSuffix = partIndex > 0 ? ` (part ${partIndex + 1})` : "";
      chunks.push({
        content,
        start_line: partStart,
        end_line: partEnd,
        symbol,
        symbol_kind: kind,
        language,
        chunk_type: symbol !== "module" ? "code_symbol" : "code_module",
        chunk_id: chunkId,
        parent_id: parentId,
        child_index: partIndex,
        symbol_occurrence: occurrence,
        header: `File: ${path}\nLanguage: ${language}\nSymbol: ${symbol}${partSuffix}\nLines: ${partStart}-${partEnd}`,
        section_path: [],
        section_title: symbol !== "module" ? symbol : null,
        page: null,
      });
    }
  }
  return chunks;
}

export function chunkPrFiles(
  files: Array<{ filename?: string; patch?: string | null }>,
  maxChars = 1800,
): Array<{
  filename: string;
  chunk_index: number;
  chunk_id: string;
  content: string;
}> {
  const chunks: Array<{
    filename: string;
    chunk_index: number;
    chunk_id: string;
    content: string;
  }> = [];
  for (const file of files) {
    const patch = file.patch ?? "";
    const filename = file.filename || "patch.diff";
    const contents = chunkDocumentText(patch, maxChars, 0);
    contents.forEach((content, index) => {
      chunks.push({
        filename,
        chunk_index: index,
        chunk_id: stableId("patch", filename, content),
        content,
      });
    });
  }
  return chunks;
}

export function siblingIdsByParent(
  chunks: Chunk[],
  idFor: (runningIndex: number) => string,
): string[][] {
  const groups = new Map<string, Array<{ running: number; child: number }>>();
  chunks.forEach((chunk, running) => {
    const list = groups.get(chunk.parent_id) ?? [];
    list.push({ running, child: chunk.child_index });
    groups.set(chunk.parent_id, list);
  });
  for (const list of groups.values()) list.sort((a, b) => a.child - b.child);

  return chunks.map((chunk, running) => {
    const list = groups.get(chunk.parent_id) ?? [];
    const pos = list.findIndex((entry) => entry.running === running);
    const ownId = idFor(running);
    if (pos < 0 || list.length <= 1) return ["", ownId, ""];
    const prev =
      pos > 0 ? idFor((list[pos - 1] as { running: number }).running) : "";
    const next =
      pos < list.length - 1
        ? idFor((list[pos + 1] as { running: number }).running)
        : "";
    return [prev, ownId, next];
  });
}
