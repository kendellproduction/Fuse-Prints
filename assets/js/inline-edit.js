// Inline copy overrides — public loader.
// Every visible text node on a page is a "unit" keyed by a hash of its original text.
// Admin edits are stored in Firestore at settings/copy_<page> as { entries: { <key>: { orig, text, href? } } }
// and re-applied here on every page load. The original HTML text stays in the file as the fallback,
// so deleting an entry (or the whole doc) restores the shipped copy.
// Visitors only ever run this file; the editor UI (inline-edit-ui.js) is loaded for admins only.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";

// Text inside these is never editable: scripts/icons/form controls, and regions that JS fills from
// Firestore or animates (gallery rows, services list, stat counters, submit buttons).
export const EXCLUDE = [
  "script", "style", "noscript", "svg", "textarea", "select", "option", "code", "pre",
  "[data-no-edit]", "#fp-edit-root", "#gallery-row-1", "#gallery-row-2", "#services-list",
  ".stat-number", "form button"
].join(",");

export const HINT_KEY = "fp_admin_hint";
const cacheKey = page => `fp_copy_${page}`;

export const norm = s => s.replace(/\s+/g, " ").trim();

// FNV-1a 32-bit — stable, tiny, and the stored `orig` string guards against collisions.
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function collectUnits(root = document.body) {
  const units = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDE)) continue;
    const orig = norm(node.nodeValue);
    if (!/[A-Za-z0-9]/.test(orig)) continue; // skip whitespace and decorative glyphs
    const raw = node.nodeValue;
    const link = parent.closest('a[href^="tel:"], a[href^="mailto:"]');
    units.push({
      node, key: hashText(orig), orig,
      lead: raw.match(/^\s*/)[0], trail: raw.match(/\s*$/)[0],
      link, origHref: link ? link.getAttribute("href") : null
    });
  }
  return units;
}

// tel:/mailto: links follow their visible text so an edited phone number or email can't leave a stale href.
export function hrefFor(link, text) {
  const href = link.getAttribute("href");
  if (href.startsWith("tel:")) { const d = text.replace(/\D/g, ""); return d ? "tel:" + d : null; }
  if (href.startsWith("mailto:")) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text) ? "mailto:" + text : null; }
  return null;
}

export function applyEntries(units, entries) {
  for (const u of units) {
    const e = entries && entries[u.key];
    const hit = e && e.orig === u.orig && typeof e.text === "string" && e.text.trim();
    const text = hit ? e.text : u.orig;
    const value = u.lead + text + u.trail;
    if (u.node.nodeValue !== value) u.node.nodeValue = value;
    if (u.link) u.link.setAttribute("href", (hit && e.href) || u.origHref);
  }
}

export function getDb() {
  if (!isConfigured()) return null;
  const app = getApps()[0] || initializeApp(firebaseConfig);
  return getFirestore(app);
}

export async function initCopy(pageId) {
  const units = collectUnits();
  const store = { entries: {} };

  try { // instant paint from the last visit, then refresh from Firestore
    const cached = JSON.parse(localStorage.getItem(cacheKey(pageId)) || "null");
    if (cached) { store.entries = cached; applyEntries(units, cached); }
  } catch (_) { /* storage unavailable */ }

  const db = getDb();
  if (db) {
    try {
      const snap = await getDoc(doc(db, "settings", "copy_" + pageId));
      store.entries = snap.exists() ? (snap.data().entries || {}) : {};
      applyEntries(units, store.entries);
      try { localStorage.setItem(cacheKey(pageId), JSON.stringify(store.entries)); } catch (_) {}
    } catch (e) { console.warn("copy overrides failed:", e); }
  }

  let wantEditor = false;
  try { wantEditor = localStorage.getItem(HINT_KEY) === "1"; } catch (_) {}
  if (wantEditor || /[?&]edit=1\b/.test(location.search)) {
    import("./inline-edit-ui.js").then(m => m.mountEditor({ pageId, units, store })).catch(e => console.warn("editor failed:", e));
  }
  return { units, store };
}
