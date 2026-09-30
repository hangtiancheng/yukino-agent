// One corrective retry for an invalid A2UI block: replay the conversation
// with the invalid output and the validation error, without tools, asking for
// ONLY a corrected block. Returns undefined when the retry is still invalid —
// callers must degrade honestly, never fabricate UI data.
import { generateText, type LanguageModel, type ModelMessage } from "ai";
import { providerOptions } from "../models";
import { extractA2ui } from "./extract";
import { A2UI_CLOSE_TAG, A2UI_OPEN_TAG } from "./prompt";

export async function correctA2uiBlock(params: {
  model: LanguageModel;
  system: string;
  history: ModelMessage[];
  question: string;
  rawAnswer: string;
  error: string;
}): Promise<unknown[] | undefined> {
  console.warn(`[a2ui] invalid block (${params.error}), retrying once`);
  const result = await generateText({
    model: params.model,
    system: params.system,
    messages: [
      ...params.history,
      { role: "user", content: params.question },
      { role: "assistant", content: params.rawAnswer },
      {
        role: "user",
        content: `Your A2UI block was invalid: ${params.error}. Reply with ONLY the corrected JSON array of A2UI v0.9 messages wrapped between ${A2UI_OPEN_TAG} and ${A2UI_CLOSE_TAG} — no other text.`,
      },
    ] satisfies ModelMessage[],
    providerOptions,
  });
  const retried = extractA2ui(result.text);
  if (retried.messages) return retried.messages;
  console.error(
    `[a2ui] corrective retry still invalid: ${retried.error ?? "no A2UI block found"}`,
  );
  return undefined;
}
