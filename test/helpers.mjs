import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const read = f => readFileSync(resolve(ROOT, f), "utf8");
export const dom = html => new JSDOM(html).window.document;
// Firestore REST shape for settings/copy_<page>
export const fsDoc = entries => ({ fields: { entries: { mapValue: { fields: Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, { mapValue: { fields: { orig: { stringValue: v.orig }, text: { stringValue: v.text } } } }])) } } } });
