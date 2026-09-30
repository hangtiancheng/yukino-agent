// P3-3 fix: shared utility extracted from indexer.ts and retriever.ts to
// eliminate the float32ToBuffer duplication.

// float[] -> Float32 little-endian Buffer (Redis VECTOR FLOAT32 wire format).
// NOTE: Float32Array.buffer assumes the host is little-endian. All common
// platforms (x86, x86_64, ARM64) are little-endian, so this is safe in
// practice. If a big-endian platform is ever targeted, add a byte-swap.
export function float32ToBuffer(floats: number[]): Buffer {
  return Buffer.from(new Float32Array(floats).buffer);
}
