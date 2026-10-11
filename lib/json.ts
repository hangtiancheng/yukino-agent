import type { Prisma } from "@/generated/prisma/client";

/**
 * Deep-clone a value into a plain JSON value that Prisma can store in a JSON
 * column. The serialize/reparse round-trip strips `undefined`, functions and
 * class instances down to plain JSON; the assertion is how the resulting
 * `JSON.parse` output is handed to Prisma's `InputJsonValue` type.
 */
export function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
