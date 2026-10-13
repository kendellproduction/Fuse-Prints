#!/usr/bin/env node
// Bakes admin copy edits (Firestore settings/copy_<page>) into the HTML source so GitHub is the source of truth.
//
// Run by .github/workflows/copy-sync-deploy.yml every few minutes. For each page it:
//   1. reads the saved edits from Firestore (public-read REST; no credentials involved),
//   2. re-validates every entry as UNTRUSTED input (copy-core.js validEntry),
//   3. replaces exactly the matching text nodes in the source file (HTML-escaped; plain text only),
//   4. rewrites tel:/mailto: hrefs from the new text (never from stored data).
// It can only change the text of text nodes that already exist, and the href of existing tel:/mailto: links.
// It never adds tags, attributes, scripts or URLs.

import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "parse5";
import {
  PAGES, EXCLUDE_TAGS, EXCLUDE_IDS, EXCLUDE_CLASSES, EXCLUDE_ATTRS,
  norm, hasWords, hashText, hrefFor, isContactHref, validEntry
} from "../assets/js/copy-core.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROJECT = "fuse-prints";
const MAX_EDITS_PER_RUN = 200;   // a runaway/tampered doc can't rewrite the whole site
const MAX_ENTRIES_READ = 2000;

export const escapeHtml = s => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Mirrors collectUnits() in copy-core.js, but over HTML source (with offsets) instead of a live DOM.
export function unitsFromHtml(html) {
  const doc = parse(html, { sourceCodeLocationInfo: true });
  const body = (function find(n) {
    for (const c of n.childNodes || []) { if (c.tagName === "body") return c; const f = find(c); if (f) return f; }
    return null;
  })(doc);
  const units = [];
  if (!body) return units;
  (function walk(node, ctx) {
    for (const c of node.childNodes || []) {
      if (c.nodeName === "#text") {
        const orig = norm(c.value);
        if (ctx.excluded || !hasWords(orig)) continue;
        const raw = html.slice(c.sourceCodeLocation.startOffset, c.sourceCodeLocation.endOffset);
        units.push({
          start: c.sourceCodeLocation.startOffset, end: c.sourceCodeLocation.endOffset,
          key: hashText(orig), orig, lead: raw.match(/^\s*/)[0], trail: raw.match(/\s*$/)[0], link: ctx.link
        });
      } else if (c.tagName) {
        const attrs = Object.fromEntries(c.attrs.map(a => [a.name, a.value]));
        const classes = (attrs.class || "").split(/\s+/);
        const isFormButton = c.tagName === "button" && ctx.inForm;
        const excluded = ctx.excluded || EXCLUDE_TAGS.includes(c.tagName) || EXCLUDE_IDS.includes(attrs.id)
          || EXCLUDE_CLASSES.some(k => classes.includes(k)) || EXCLUDE_ATTRS.some(a => a in attrs) || isFormButton;
        const link = c.tagName === "a" && isContactHref(attrs.href)
          ? { href: attrs.href, attr: c.sourceCodeLocation.attrs && c.sourceCodeLocation.attrs.href } : ctx.link;
        walk(c, { excluded, inForm: ctx.inForm || c.tagName === "form", link });
      }
    }
  })(body, { excluded: false, inForm: false, link: null });
  return units;
}

// Returns { html, edits: [{ from, to }] }. Untrusted `entries` are validated here.
export function bakeHtml(html, entries) {
  const edits = [], applied = [], seenHref = new Set();
  for (const u of unitsFromHtml(html)) {
    const e = entries[u.key];
    if (!e || e.orig !== u.orig || !validEntry(u.key, e)) continue;
    if (u.link && !hrefFor(u.link.href, e.text)) continue; // a phone/email link must keep showing a phone/email
    edits.push({ start: u.start, end: u.end, text: u.lead + escapeHtml(e.text) + u.trail });
    applied.push({ from: u.orig, to: e.text });
    if (u.link && u.link.attr && !seenHref.has(u.link.attr.startOffset)) {
      const href = hrefFor(u.link.href, e.text);
      if (href && href !== u.link.href) {
        seenHref.add(u.link.attr.startOffset);
        edits.push({ start: u.link.attr.startOffset, end: u.link.attr.endOffset, text: `href="${href}"` });
      }
    }
  }
  edits.sort((a, b) => b.start - a.start);
  for (let i = 1; i < edits.length; i++) if (edits[i].end > edits[i - 1].start) throw new Error("overlapping edits");
  let out = html;
  for (const ed of edits) out = out.slice(0, ed.start) + ed.text + out.slice(ed.end);
  return { html: out, edits: applied };
}

// Firestore REST document -> { key: { orig, text } } (strings only; anything else is dropped).
export function entriesFromFirestore(json) {
  const fields = json && json.fields && json.fields.entries && json.fields.entries.mapValue && json.fields.entries.mapValue.fields;
  const out = {};
  if (!fields) return out;
  for (const [key, v] of Object.entries(fields).slice(0, MAX_ENTRIES_READ)) {
    const f = v && v.mapValue && v.mapValue.fields;
    if (f && f.orig && f.text && typeof f.orig.stringValue === "string" && typeof f.text.stringValue === "string")
      out[key] = { orig: f.orig.stringValue, text: f.text.stringValue };
  }
  return out;
}

async function loadEntries(page, fixtureDir) {
  if (fixtureDir) {
    const p = resolve(fixtureDir, `copy_${page}.json`);
    return existsSync(p) ? entriesFromFirestore(JSON.parse(readFileSync(p, "utf8"))) : {};
  }
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/settings/copy_${page}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return {};
  if (!res.ok) throw new Error(`Firestore read failed for ${page}: HTTP ${res.status}`);
  return entriesFromFirestore(await res.json());
}

export async function main({ root = ROOT, fixtureDir = process.env.BAKE_FIXTURE_DIR || null } = {}) {
  const summary = [];
  const writes = [];
  let total = 0;
  for (const [page, file] of Object.entries(PAGES)) {
    const path = resolve(root, file);
    const before = readFileSync(path, "utf8");
    const { html, edits } = bakeHtml(before, await loadEntries(page, fixtureDir));
    if (html !== before) {
      total += edits.length;
      writes.push([path, html]);
      for (const e of edits) summary.push(`${page}: "${e.from.slice(0, 100)}" -> "${e.to.slice(0, 100)}"`);
    }
  }
  if (total > MAX_EDITS_PER_RUN) throw new Error(`Refusing to apply ${total} edits in one run (limit ${MAX_EDITS_PER_RUN})`);
  for (const [path, html] of writes) writeFileSync(path, html);
  const changed = writes.length > 0;
  console.log(changed ? `Baked ${total} edit(s):\n${summary.join("\n")}` : "No copy edits to bake.");
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
  if (process.env.BAKE_SUMMARY && changed) writeFileSync(process.env.BAKE_SUMMARY, `Bake saved copy edits into HTML\n\n${summary.join("\n")}\n`);
  return { changed, total, summary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
