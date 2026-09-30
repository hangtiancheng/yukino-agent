// Simple console logging for pipeline lifecycle events.
export function logStart(name: string): void {
  console.log(`[start]: ${name}`);
}

export function logEnd(name: string): void {
  console.log(`[end]: ${name}`);
}
