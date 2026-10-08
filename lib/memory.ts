// In-memory conversation memory per session id, window size 6, drop in pairs.
//
// Compaction (minimal port of the legacy agent_py every_30_turns mode): pairs
// evicted from the sliding window accumulate in a pending buffer; once enough
// have piled up an LLM compresses them (plus the previous summary) into a
// rolling ≤1200-char summary that chat/chatStream inject into the system
// prompt. The compaction call is fire-and-forget — it never blocks an answer,
// and a failure keeps the old summary and the pending pairs for a later retry.
import { generateText, type ModelMessage } from "ai";
import { quickModel } from "@/lib/ai/models";
import { MEMORY_SUMMARY_ENABLED, MEMORY_WINDOW_SIZE } from "@/lib/config";

// P2-19 fix: LRU eviction to prevent unbounded memory growth.
// Map preserves insertion order in JS, so we re-insert on access to move
// the entry to the "most recently used" position, and evict the oldest
// entry when the cap is exceeded.
const MAX_SESSIONS = 100;
const memoryMap = new Map<string, SimpleMemory>();

export function getSimpleMemory(id: string): SimpleMemory {
  const existing = memoryMap.get(id);
  if (existing) {
    // Move to end (most recently used).
    memoryMap.delete(id);
    memoryMap.set(id, existing);
    return existing;
  }
  // Evict oldest session if at capacity.
  if (memoryMap.size >= MAX_SESSIONS) {
    const oldestKey = memoryMap.keys().next().value;
    if (oldestKey !== undefined) memoryMap.delete(oldestKey);
  }
  const mem = new SimpleMemory(id);
  memoryMap.set(id, mem);
  return mem;
}

// Compaction tuning. SUMMARY_TRIGGER_PAIRS is the scaled-down analogue of the
// legacy every_30_turns trigger: with MEMORY_WINDOW_SIZE=6 the window only
// leaks 2 pairs per turn, so 6 pending pairs (~3 full exchanges beyond the
// window) is the point where folding them into the summary pays off.
export const SUMMARY_TRIGGER_PAIRS = 6;
// Legacy hard cap for injected summaries (streaming.py memory: ≤1200 chars).
export const SUMMARY_MAX_CHARS = 1200;
// A failed compaction keeps pending pairs for a later retry; cap the buffer
// so a dead LLM endpoint cannot grow it without bound (oldest pairs dropped).
const MAX_PENDING_PAIRS = 12;

export function shouldTriggerSummary(pendingPairs: number): boolean {
  return pendingPairs >= SUMMARY_TRIGGER_PAIRS;
}

// Hard cap after the LLM returned (models overshoot): normalize whitespace,
// cut to max chars with an ellipsis marker.
export function capSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const normalized = text.split(/\s+/).join(" ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

// The system-prompt section for the rolling summary. Empty summary → empty
// string (nothing injected). Kept as a pure formatter so chat.ts and the
// smoke test share one definition.
export function summarySection(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed === "") return "";
  return `\n\n## Conversation summary\n${trimmed}`;
}

// The compaction instruction handed to the model (pure: builds on the old
// summary so facts survive across folds).
export function buildSummaryPrompt(
  oldSummary: string,
  pairs: ModelMessage[],
): string {
  const transcript = pairs.map((m) => `${m.role}: ${textOf(m)}`).join("\n");
  const head =
    oldSummary.trim() === ""
      ? "Summarize the conversation so far into a single compact summary."
      : `Existing summary:\n${oldSummary.trim()}\n\nExtend it with the newer messages into a single compact summary.`;
  return `${head}

Rules:
- At most ${SUMMARY_MAX_CHARS} characters.
- Keep user intent, decisions, entity names, numbers, and open questions.
- Plain prose or terse bullets, no preamble, same language as the conversation.

Messages:
${transcript}`;
}

function textOf(msg: ModelMessage): string {
  const { content } = msg;
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

export class SimpleMemory {
  readonly id: string;
  messages: ModelMessage[] = [];
  readonly maxWindowSize = MEMORY_WINDOW_SIZE;
  // Rolling compaction state (all server-side, never sent to the client).
  private pending: ModelMessage[] = [];
  private summary = "";
  private compacting = false;

  constructor(id: string) {
    this.id = id;
  }

  // Append a message; when over the window, drop an even number from the front
  // to keep user/assistant pairs aligned. Dropped pairs feed the summary
  // buffer instead of vanishing.
  setMessages(msg: ModelMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxWindowSize) {
      let excess = this.messages.length - this.maxWindowSize;
      if (excess % 2 !== 0) excess++;
      this.pending.push(...this.messages.slice(0, excess));
      this.messages = this.messages.slice(excess);
      const cap = MAX_PENDING_PAIRS * 2;
      if (this.pending.length > cap) this.pending = this.pending.slice(-cap);
    }
  }

  getMessages(): ModelMessage[] {
    return this.messages;
  }

  getSummary(): string {
    return this.summary;
  }

  pendingPairCount(): number {
    return this.pending.length / 2;
  }

  // Fire-and-forget compaction: when the pending buffer crosses the threshold,
  // fold it into the rolling summary with quickModel. Never throws — on any
  // failure the previous summary is kept and the pairs stay pending.
  async maybeSummarize(): Promise<void> {
    if (!MEMORY_SUMMARY_ENABLED) return;
    if (this.compacting) return;
    if (!shouldTriggerSummary(this.pendingPairCount())) return;
    const folded = this.pending;
    const oldSummary = this.summary;
    this.compacting = true;
    try {
      const { text } = await generateText({
        model: quickModel,
        prompt: buildSummaryPrompt(oldSummary, folded),
      });
      const next = capSummary(text);
      // Only commit when something came back; an empty reply must not wipe
      // the existing summary.
      if (next !== "") {
        this.summary = next;
        // Drop exactly the messages that were folded (removed by identity,
        // so pairs appended or buffer-capped during the LLM call survive).
        this.pending = this.pending.filter((m) => !folded.includes(m));
      }
    } catch (e) {
      console.warn(
        `[memory] summary compaction failed for ${this.id}:`,
        e instanceof Error ? e.message : String(e),
      );
    } finally {
      this.compacting = false;
    }
  }
}
