import assert from "node:assert/strict";
import {
  createA2uiStreamFilter,
  extractA2ui,
  parseA2uiBlock,
} from "@/lib/ai/a2ui/extract";
import {
  A2UI_CATALOG_ID,
  A2UI_CLOSE_TAG,
  A2UI_OPEN_TAG,
  A2UI_PROMPT_SECTION,
} from "@/lib/ai/a2ui/prompt";

function checkPromptExamples() {
  assert.ok(
    A2UI_PROMPT_SECTION.includes(A2UI_OPEN_TAG),
    "prompt section must contain the a2ui opening tag",
  );
  assert.ok(
    A2UI_PROMPT_SECTION.includes(A2UI_CLOSE_TAG),
    "prompt section must contain the a2ui closing tag",
  );
  assert.ok(
    A2UI_PROMPT_SECTION.includes(A2UI_CATALOG_ID),
    "prompt section must reference the shadcn catalog id",
  );

  let cursor = 0;
  let found = 0;
  for (;;) {
    const start = A2UI_PROMPT_SECTION.indexOf(A2UI_OPEN_TAG, cursor);
    if (start === -1) break;
    const end = A2UI_PROMPT_SECTION.indexOf(
      A2UI_CLOSE_TAG,
      start + A2UI_OPEN_TAG.length,
    );
    assert.ok(end !== -1, "prompt example block is never closed");
    const raw = A2UI_PROMPT_SECTION.slice(start + A2UI_OPEN_TAG.length, end);
    cursor = end + A2UI_CLOSE_TAG.length;
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
      continue;
    }
    const parsed = parseA2uiBlock(raw);
    assert.equal(
      parsed.error,
      undefined,
      `invalid prompt example: ${parsed.error}`,
    );
    assert.ok(
      Array.isArray(parsed.messages) && parsed.messages.length > 0,
      "prompt example must yield at least one message",
    );
    found++;
  }
  assert.ok(
    found >= 3,
    `expected the OnCall few-shot examples (>=3), found ${found}`,
  );
  console.log(`prompt examples: ${found} blocks all validate`);
}

function runFilterChunked(chunks: string[], expectedText: string): string[] {
  const filter = createA2uiStreamFilter();
  let text = "";
  const blocks: string[] = [];
  for (const chunk of chunks) {
    const out = filter.push(chunk);
    text += out.text ?? "";
    blocks.push(...out.blocks);
  }
  const rest = filter.flush();
  assert.equal(rest, "", "no unterminated block expected here");
  assert.equal(text, expectedText, "pass-through text mismatch");
  return blocks;
}

function checkStreamFilter() {
  const inner = JSON.stringify([
    {
      version: "v0.9",
      createSurface: { surfaceId: "s1", catalogId: A2UI_CATALOG_ID },
    },
  ]);
  const full = `before ${A2UI_OPEN_TAG}${inner}${A2UI_CLOSE_TAG} after`;
  const expectedText = "before  after";

  let blocks = runFilterChunked([full], expectedText);
  assert.deepEqual(blocks, [inner], "single-chunk block mismatch");

  blocks = runFilterChunked(full.split(""), expectedText);
  assert.deepEqual(blocks, [inner], "char-by-char block mismatch");

  blocks = runFilterChunked(
    ["before <a2u", `i-json>${inner}${A2UI_CLOSE_TAG} after`],
    expectedText,
  );
  assert.deepEqual(blocks, [inner], "mid-open-tag split mismatch");

  blocks = runFilterChunked(
    [
      `before ${A2UI_OPEN_TAG}${inner.slice(0, 5)}`,
      `${inner.slice(5)}</a2ui-j`,
      `son> after`,
    ],
    expectedText,
  );
  assert.deepEqual(blocks, [inner], "mid-close-tag split mismatch");

  blocks = runFilterChunked(["hello ", "world"], "hello world");
  assert.deepEqual(blocks, [], "plain text must not yield blocks");

  const filter = createA2uiStreamFilter();
  const out = filter.push(`prefix ${A2UI_OPEN_TAG}[{"version"`);
  assert.equal(out.text, "prefix ");
  assert.deepEqual(out.blocks, []);
  const rest = filter.flush();
  assert.ok(
    rest.startsWith(A2UI_OPEN_TAG),
    "flush must restore the unterminated opening tag",
  );

  console.log(
    "stream filter: chunk splits + unterminated-block flush verified",
  );
}

function checkValidationSemantics() {
  const badJson = parseA2uiBlock("{not json");
  assert.ok(
    badJson.error?.startsWith("invalid JSON"),
    "invalid JSON must error",
  );
  assert.equal(badJson.messages, undefined);

  const good = parseA2uiBlock(
    JSON.stringify([
      {
        version: "v0.9",
        createSurface: { surfaceId: "s", catalogId: A2UI_CATALOG_ID },
      },
    ]),
  );
  assert.equal(good.error, undefined, `valid block errored: ${good.error}`);
  assert.equal(good.messages?.length, 1);

  const badMessage = parseA2uiBlock(
    JSON.stringify([{ createSurface: { surfaceId: "s" } }]),
  );
  assert.ok(
    badMessage.error !== undefined,
    "schema-invalid message must error",
  );
  assert.equal(badMessage.messages, undefined);

  const plain = extractA2ui("just an answer");
  assert.equal(plain.cleanText, "just an answer");
  assert.equal(plain.error, undefined);
  assert.equal(plain.messages, undefined);

  const unclosed = extractA2ui(`answer ${A2UI_OPEN_TAG}[`);
  assert.equal(unclosed.cleanText, "answer");
  assert.ok(
    unclosed.error?.includes("never closed"),
    "unclosed tag must error",
  );

  const tagged = extractA2ui(
    `intro ${A2UI_OPEN_TAG}${JSON.stringify([
      {
        version: "v0.9",
        createSurface: { surfaceId: "s", catalogId: A2UI_CATALOG_ID },
      },
    ])}${A2UI_CLOSE_TAG} outro`,
  );
  assert.equal(tagged.cleanText, "intro  outro");
  assert.equal(tagged.messages?.length, 1);

  console.log("validation semantics: invalid/valid/unclosed cases verified");
}

try {
  checkPromptExamples();
  checkStreamFilter();
  checkValidationSemantics();
  console.log("A2UI SMOKE OK");
} catch (e) {
  console.error("SMOKE FAILED:", e);
  process.exit(1);
}
