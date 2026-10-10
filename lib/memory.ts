import { generateText, type ModelMessage } from "ai";
import { quickModel } from "@/lib/ai/models";
import { MEMORY_SUMMARY_ENABLED, MEMORY_WINDOW_SIZE } from "@/lib/config";

const MAX_SESSIONS = 100;
const memoryMap = new Map<string, SimpleMemory>();

export function getSimpleMemory(id: string): SimpleMemory {
  const existing = memoryMap.get(id);
  if (existing) {
    memoryMap.delete(id);
    memoryMap.set(id, existing);
    return existing;
  }
  if (memoryMap.size >= MAX_SESSIONS) {
    const oldestKey = memoryMap.keys().next().value;
    if (oldestKey !== undefined) memoryMap.delete(oldestKey);
  }
  const mem = new SimpleMemory(id);
  memoryMap.set(id, mem);
  return mem;
}

export const SUMMARY_TRIGGER_PAIRS = 6;
export const SUMMARY_MAX_CHARS = 1200;
const MAX_PENDING_PAIRS = 12;

export function shouldTriggerSummary(pendingPairs: number): boolean {
  return pendingPairs >= SUMMARY_TRIGGER_PAIRS;
}

export function capSummary(text: string, max = SUMMARY_MAX_CHARS): string {
  const normalized = text.split(/\s+/).join(" ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
}

export function summarySection(summary: string): string {
  const trimmed = summary.trim();
  if (trimmed === "") return "";
  return `\n\n## Conversation summary\n${trimmed}`;
}

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
  private pending: ModelMessage[] = [];
  private summary = "";
  private compacting = false;

  constructor(id: string) {
    this.id = id;
  }

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
      if (next !== "") {
        this.summary = next;
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
