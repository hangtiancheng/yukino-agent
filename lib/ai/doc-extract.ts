// PDF/DOCX text extraction for knowledge uploads — port of the Python
// `document_extraction.py` (DevFlow-AI services/rag) with its safety limits:
// 12 MB input, 500 PDF pages, 4M extracted chars, DOCX zip-bomb defenses
// (<=10000 entries, <=64 MB decompressed, OLE-encrypted files rejected),
// per-page `<!-- page: N -->` markers so chunker section labels align to pages.
//
// Previously recorded as an "ecosystem limit" (Yukino.md #12); the audit pass
// reclassified it as portable — pdf.js text extraction (via unpdf) and
// mammoth's docx->markdown cover the legacy behavior. Fidelity caveat: mammoth
// table rendering is weaker than the python-docx markdown tables, and
// scanned/image-only PDFs extract no text (rejected as in legacy).

export const MAX_DOCUMENT_BYTES = 12 * 1024 * 1024;
export const MAX_EXTRACTED_CHARS = 4_000_000;
export const MAX_PDF_PAGES = 500;
export const MAX_DOCX_ENTRIES = 10_000;
export const MAX_DOCX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export class DocumentExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocumentExtractionError";
  }
}

function ensureTextLimit(text: string, what: string): string {
  if (text.length > MAX_EXTRACTED_CHARS) {
    throw new DocumentExtractionError(
      `extracted ${what} text exceeds the ${MAX_EXTRACTED_CHARS} character limit`,
    );
  }
  return text;
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  let proxy: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    proxy = await getDocumentProxy(new Uint8Array(buffer));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/password/i.test(message)) {
      throw new DocumentExtractionError(
        "encrypted PDF files are not supported",
      );
    }
    throw new DocumentExtractionError(
      `PDF could not be read: ${message || "invalid file"}`,
    );
  }
  if (proxy.numPages > MAX_PDF_PAGES) {
    throw new DocumentExtractionError(
      `PDF exceeds the ${MAX_PDF_PAGES} page limit`,
    );
  }
  let result: Awaited<ReturnType<typeof extractText>>;
  try {
    result = await extractText(proxy, { mergePages: false });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/password/i.test(message)) {
      throw new DocumentExtractionError(
        "encrypted PDF files are not supported",
      );
    }
    throw new DocumentExtractionError(
      `PDF text extraction failed: ${message || "unreadable file"}`,
    );
  }
  const pages: string[] = [];
  let extractedChars = 0;
  const perPage = Array.isArray(result.text)
    ? result.text
    : [result.text as unknown as string];
  for (let i = 0; i < perPage.length; i++) {
    const pageText = String(perPage[i] ?? "").trim();
    if (pageText === "") continue;
    const content = `<!-- page: ${i + 1} -->\n${pageText}`;
    extractedChars += content.length + (pages.length > 0 ? 2 : 0);
    if (extractedChars > MAX_EXTRACTED_CHARS) {
      throw new DocumentExtractionError(
        `PDF text exceeds the ${MAX_EXTRACTED_CHARS} character limit`,
      );
    }
    pages.push(content);
  }
  if (pages.length === 0) {
    throw new DocumentExtractionError(
      "PDF contains no extractable text (it may be scanned images)",
    );
  }
  return ensureTextLimit(pages.join("\n\n"), "PDF");
}

// Zip-bomb + encryption guard shared by DOCX: parses the ZIP central
// directory (no decompression) and enforces the legacy zipfile.infolist()
// caps: <=10000 entries, <=64 MB declared decompressed total, per-entry
// encryption flag rejected — plus the OLE compound-file magic (Word's
// "encrypted document" container).
function guardDocxZip(buffer: Buffer): void {
  // OLE compound file magic => Word "encrypted document" container.
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe2];
  if (ole.every((byte, i) => buffer[i] === byte)) {
    throw new DocumentExtractionError("encrypted DOCX files are not supported");
  }

  // Locate the End Of Central Directory record (sig 0x06054b50) in the last
  // 66 KB (EOCD is <= 22 bytes + 64 KB comment).
  let eocd = -1;
  const scanFrom = Math.max(0, buffer.length - 66_000);
  for (let i = buffer.length - 22; i >= scanFrom; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new DocumentExtractionError("DOCX could not be read: invalid zip");
  }
  let totalEntries = buffer.readUInt16LE(eocd + 10);
  let cdOffset = buffer.readUInt32LE(eocd + 16);
  // Zip64 EOCD (locator sig 0x07064b50 in the 20 bytes before the EOCD).
  if (
    totalEntries === 0xffff ||
    buffer.readUInt32LE(eocd + 12) === 0xffffffff ||
    buffer.readUInt32LE(eocd + 16) === 0xffffffff
  ) {
    const locator = eocd - 20;
    if (locator >= 0 && buffer.readUInt32LE(locator) === 0x07064b50) {
      const z64 = Number(buffer.readBigUInt64LE(locator + 8));
      if (z64 >= 0 && z64 + 12 <= buffer.length) {
        totalEntries = Number(buffer.readBigUInt64LE(z64 + 32));
        cdOffset = Number(buffer.readBigUInt64LE(z64 + 48));
      }
    }
  }
  if (totalEntries > MAX_DOCX_ENTRIES) {
    throw new DocumentExtractionError(
      `DOCX exceeds the ${MAX_DOCX_ENTRIES} entry limit`,
    );
  }

  let total = 0;
  let pos = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new DocumentExtractionError("DOCX could not be read: corrupt zip");
    }
    const flags = buffer.readUInt16LE(pos + 8);
    if ((flags & 0x0001) !== 0) {
      throw new DocumentExtractionError(
        "encrypted DOCX files are not supported",
      );
    }
    let size = buffer.readUInt32LE(pos + 24);
    if (size === 0xffffffff) {
      // Zip64 extended information extra field (header id 0x0001) carries it.
      const nameLen = buffer.readUInt16LE(pos + 28);
      const extraLen = buffer.readUInt16LE(pos + 30);
      const extraStart = pos + 46 + nameLen;
      const extraEnd = extraStart + extraLen;
      let e = extraStart;
      while (e + 4 <= extraEnd) {
        const headerId = buffer.readUInt16LE(e);
        const headerSize = buffer.readUInt16LE(e + 2);
        if (headerId === 0x0001 && headerSize >= 8 && e + 4 + 8 <= extraEnd) {
          size = Number(buffer.readBigUInt64LE(e + 4));
          break;
        }
        e += 4 + headerSize;
      }
    }
    total += size;
    if (total > MAX_DOCX_UNCOMPRESSED_BYTES) {
      throw new DocumentExtractionError(
        `DOCX exceeds the ${MAX_DOCX_UNCOMPRESSED_BYTES} byte decompressed limit`,
      );
    }
    pos +=
      46 +
      buffer.readUInt16LE(pos + 28) +
      buffer.readUInt16LE(pos + 30) +
      buffer.readUInt16LE(pos + 32);
  }
}

async function extractDocx(buffer: Buffer): Promise<string> {
  guardDocxZip(buffer);
  // mammoth's bundled lib/index.d.ts predates the convertToMarkdown runtime
  // API (it exists since mammoth 1.5 and is exported at runtime), so the
  // boundary is typed explicitly here.
  type ConvertToMarkdown = (
    input: { buffer: Buffer },
    options?: unknown,
  ) => Promise<{ value: string; messages: unknown[] }>;
  const mod = (await import("mammoth")) as unknown as {
    default?: { convertToMarkdown?: ConvertToMarkdown };
    convertToMarkdown?: ConvertToMarkdown;
  };
  const convertToMarkdown =
    mod.convertToMarkdown ?? mod.default?.convertToMarkdown;
  if (!convertToMarkdown) {
    throw new DocumentExtractionError("DOCX converter is unavailable");
  }
  let result: { value: string; messages: unknown[] };
  try {
    result = await convertToMarkdown({ buffer });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new DocumentExtractionError(
      `DOCX could not be parsed: ${message || "invalid file"}`,
    );
  }
  const text = result.value.trim();
  if (text === "") {
    throw new DocumentExtractionError("DOCX contains no extractable text");
  }
  return ensureTextLimit(text, "DOCX");
}

// Returns the extracted text for .pdf/.docx, or null when the extension is
// not a binary document type (caller falls back to plain text handling).
export async function extractBinaryDocumentText(
  filename: string,
  buffer: Buffer,
): Promise<string | null> {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".pdf") {
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw new DocumentExtractionError(
        `PDF file exceeds the ${MAX_DOCUMENT_BYTES} byte limit`,
      );
    }
    return extractPdf(buffer);
  }
  if (ext === ".docx") {
    if (buffer.length > MAX_DOCUMENT_BYTES) {
      throw new DocumentExtractionError(
        `DOCX file exceeds the ${MAX_DOCUMENT_BYTES} byte limit`,
      );
    }
    return extractDocx(buffer);
  }
  return null;
}

// Multi-encoding text decode (port of decode_text: NUL sniff + utf-8-sig /
// utf-8 / gb18030 / latin-1 cascade).
export function decodeTextBytes(data: Buffer): string {
  if (data.subarray(0, 8192).includes(0)) {
    throw new DocumentExtractionError(
      "binary content cannot be indexed as text",
    );
  }
  for (const encoding of ["utf-8-sig", "utf-8", "gb18030", "windows-1252"]) {
    try {
      const decoded = new TextDecoder(encoding).decode(data);
      if (!decoded.includes("\uFFFD")) {
        return ensureTextLimit(decoded, "text");
      }
    } catch {
      // try the next encoding
    }
  }
  return ensureTextLimit(new TextDecoder("windows-1252").decode(data), "text");
}
