// Inline copy overrides — public loader.
// Every visible text node on a page is a "unit" keyed by a hash of its original text (see copy-core.js).
// Admin edits are stored in Firestore at settings/copy_<page> as { entries: { <key>: { orig, text, href? } } }
// and re-applied here on every page load. The original HTML text stays in the file as the fallback,
// so deleting an entry (or the whole doc) restores the shipped copy. A scheduled GitHub Action
// (scripts/bake-copy.mjs) later writes these edits into the HTML source and redeploys.
// Visitors only ever run this file; the editor UI (inline-edit-ui.js) is loaded for admins only.

import { initializeApp, getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";
import { collectUnits, applyEntries, hrefFor, norm, hashText, validEntry } from "./copy-core.js";

export const HINT_KEY = "fp_admin_hint";
const cacheKey = page => `fp_copy_${page}`;
export { collectUnits, applyEntries, hrefFor, norm, hashText, validEntry };

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
