import {
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { config } from "@/lib/config";

export const digestToken = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function digestCode(email: string, purpose: string, code: string) {
  if (config.account.secret.length < 32)
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  return createHmac("sha256", config.account.secret)
    .update(JSON.stringify([email, purpose, code]))
    .digest("hex");
}

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
}
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${(await derive(password, salt)).toString("hex")}`;
}
export async function verifyPassword(password: string, hash: string | null) {
  const [algorithm, salt, key] = (hash ?? "").split(":");
  const valid =
    algorithm === "scrypt" &&
    /^[a-f0-9]{32}$/.test(salt ?? "") &&
    /^[a-f0-9]{128}$/.test(key ?? "");
  // Also run the KDF for nonexistent / passwordless accounts.
  const candidate = await derive(
    password,
    valid ? salt : "00000000000000000000000000000000",
  );
  return valid && timingSafeEqual(candidate, Buffer.from(key, "hex"));
}
