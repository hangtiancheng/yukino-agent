// In-memory conversation memory per session id, window size 6, drop in pairs.
import { type ModelMessage } from "ai";
import { MEMORY_WINDOW_SIZE } from "@/lib/config";

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

export class SimpleMemory {
  readonly id: string;
  messages: ModelMessage[] = [];
  readonly maxWindowSize = MEMORY_WINDOW_SIZE;

  constructor(id: string) {
    this.id = id;
  }

  // Append a message; when over the window, drop an even number from the front
  // to keep user/assistant pairs aligned.
  setMessages(msg: ModelMessage): void {
    this.messages.push(msg);
    if (this.messages.length > this.maxWindowSize) {
      let excess = this.messages.length - this.maxWindowSize;
      if (excess % 2 !== 0) excess++;
      this.messages = this.messages.slice(excess);
    }
  }

  getMessages(): ModelMessage[] {
    return this.messages;
  }
}
