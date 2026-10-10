import assert from "node:assert/strict";
import {
  extractBinaryDocumentText,
  decodeTextBytes,
  DocumentExtractionError,
  MAX_DOCX_ENTRIES,
} from "@/lib/ai/doc-extract";
import { zipSync, strToU8 } from "fflate";

function makeDocx(entries: Map<string, string>): Buffer {
  const record: Record<string, Uint8Array> = {};
  for (const [name, data] of entries) record[name] = strToU8(data);
  return Buffer.from(zipSync(record));
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Operations Runbook</w:t></w:r></w:p>
<w:p><w:r><w:t>Restart the pod and verify.</w:t></w:r></w:p>
</w:body></w:document>`;
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

async function main() {
  const happyEntries = new Map<string, string>();
  happyEntries.set("[Content_Types].xml", CONTENT_TYPES);
  happyEntries.set("word/document.xml", DOC_XML);
  const text = await extractBinaryDocumentText(
    "runbook.docx",
    makeDocx(happyEntries),
  );
  assert.ok(text, "docx extracted");
  assert.ok(
    text!.startsWith("# Operations Runbook"),
    `heading mapping (got ${JSON.stringify(text!.slice(0, 40))})`,
  );

  const many = new Map<string, string>();
  for (let i = 0; i < MAX_DOCX_ENTRIES + 5; i++) many.set(`x${i}.xml`, "<a/>");
  many.set("[Content_Types].xml", CONTENT_TYPES);
  const manyBuf = makeDocx(many);
  let rejectedEntries = false;
  try {
    await extractBinaryDocumentText("bomb-entries.docx", manyBuf);
  } catch (e) {
    rejectedEntries =
      e instanceof DocumentExtractionError &&
      /entry limit|byte limit/.test(e.message);
  }
  assert.ok(rejectedEntries, "entry/size bomb rejected");

  const bomb: Record<string, Uint8Array> = {};
  for (let i = 0; i < 30; i++)
    bomb[`z${i}.bin`] = new Uint8Array(4 * 1024 * 1024);
  bomb["[Content_Types].xml"] = strToU8(CONTENT_TYPES);
  const bombBuf = Buffer.from(zipSync(bomb));
  assert.ok(
    bombBuf.length < 12 * 1024 * 1024,
    "bomb input under the 12MB upload cap",
  );
  let rejectedSize = false;
  try {
    await extractBinaryDocumentText("bomb-size.docx", bombBuf);
  } catch (e) {
    rejectedSize =
      e instanceof DocumentExtractionError &&
      /decompressed limit|entry limit/.test(e.message);
  }
  assert.ok(rejectedSize, "decompressed size guard rejected");

  const ole = Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe2]),
    Buffer.alloc(64),
  ]);
  await assert.rejects(
    () => extractBinaryDocumentText("enc.docx", ole),
    /encrypted DOCX/,
    "OLE encrypted rejected",
  );

  const plain = makeDocx(
    new Map([
      ["[Content_Types].xml", CONTENT_TYPES],
      ["word/document.xml", DOC_XML],
    ]),
  );
  const flagged = Buffer.from(plain);
  for (let i = 0; i + 4 < flagged.length; i++) {
    if (
      flagged[i] === 0x50 &&
      flagged[i + 1] === 0x4b &&
      flagged[i + 2] === 0x01 &&
      flagged[i + 3] === 0x02
    ) {
      flagged[i + 8] |= 0x01;
    }
  }
  await assert.rejects(
    () => extractBinaryDocumentText("flag.docx", flagged),
    /encrypted DOCX/,
    "central-directory encryption flag rejected",
  );

  await assert.rejects(
    () => extractBinaryDocumentText("x.pdf", Buffer.from("%PDF-1.4\nbroken")),
    (e: unknown) => e instanceof DocumentExtractionError,
    "broken pdf rejected with DocumentExtractionError",
  );

  assert.equal(
    await extractBinaryDocumentText("notes.md", Buffer.from("# hi")),
    null,
  );

  assert.throws(() => decodeTextBytes(Buffer.from([104, 105, 0, 1])), /binary/);
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeTextBytes(gbk), "中文");

  console.log("DOC-EXTRACT SMOKE OK");
}

main().catch((e) => {
  console.error("DOC-EXTRACT SMOKE FAILED:", e);
  process.exit(1);
});
