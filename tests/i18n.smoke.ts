import assert from "node:assert/strict";
import en from "@/messages/en.json";
import zhCN from "@/messages/zh-CN.json";
import { defaultLocale, isLocale, locales } from "@/lib/i18n/config";
import { negotiateLocale } from "@/lib/i18n/negotiate";

type CatalogNode = string | { [key: string]: CatalogNode };

function collectLeaves(
  node: CatalogNode,
  prefix: string,
  out: Map<string, string>,
) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") {
      assert(value.length > 0, `empty message at "${path}"`);
      out.set(path, value);
    } else {
      assert(
        typeof value === "object" && value !== null && !Array.isArray(value),
        `unexpected non-string leaf at "${path}"`,
      );
      collectLeaves(value, path, out);
    }
  }
}

function argumentNames(message: string): string[] {
  const names = new Set<string>();
  for (const match of message.matchAll(/\{(\w+)\s*[,}]/g)) {
    names.add(match[1]);
  }
  return [...names].sort();
}

const enLeaves = new Map<string, string>();
const zhLeaves = new Map<string, string>();
collectLeaves(en as CatalogNode, "", enLeaves);
collectLeaves(zhCN as CatalogNode, "", zhLeaves);

assert.deepEqual(
  [...enLeaves.keys()].sort(),
  [...zhLeaves.keys()].sort(),
  "en.json and zh-CN.json key trees differ",
);

for (const [key, enMessage] of enLeaves) {
  assert.deepEqual(
    argumentNames(enMessage),
    argumentNames(zhLeaves.get(key)!),
    `ICU arguments differ for "${key}"`,
  );
}

assert.equal(negotiateLocale("zh-CN,zh;q=0.9,en;q=0.8"), "zh-CN");
assert.equal(negotiateLocale("en-US,en;q=0.9"), "en");
assert.equal(negotiateLocale("en;q=0.4,zh;q=0.9"), "zh-CN");
assert.equal(negotiateLocale("zh-Hant-TW"), "zh-CN");
assert.equal(negotiateLocale("fr-FR,fr;q=0.9"), defaultLocale);
assert.equal(negotiateLocale("*"), defaultLocale);
assert.equal(negotiateLocale(null), defaultLocale);
assert.equal(negotiateLocale(undefined), defaultLocale);

assert(isLocale("en"));
assert(isLocale("zh-CN"));
assert(!isLocale("fr"));
assert(locales.includes(defaultLocale));

console.log(
  `i18n smoke OK: ${enLeaves.size} keys x ${locales.length} locales, negotiation verified`,
);
