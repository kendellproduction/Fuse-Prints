// Shared copy-editing rules. No imports and no Firebase: this exact file runs in the browser
// (inline-edit.js / inline-edit-ui.js) AND in Node (scripts/bake-copy.mjs + tests), so both sides
// agree on what counts as editable copy, how it is keyed, and what a valid edit looks like.

// A "unit" is one visible text node. Its key is a hash of its original (whitespace-normalised) text.
// Never editable: scripts/icons/form controls, and regions JS fills from Firestore or animates.
export const EXCLUDE_TAGS = ["script", "style", "noscript", "svg", "textarea", "select", "option", "code", "pre"];
export const EXCLUDE_IDS = ["fp-edit-root", "gallery-row-1", "gallery-row-2", "services-list"];
export const EXCLUDE_CLASSES = ["stat-number"];
export const EXCLUDE_ATTRS = ["data-no-edit"];
// plus: any <button> inside a <form> (its label is rewritten by the submit handler)
export const EXCLUDE_SELECTOR = [
  ...EXCLUDE_TAGS, ...EXCLUDE_ATTRS.map(a => `[${a}]`), ...EXCLUDE_IDS.map(i => `#${i}`),
  ...EXCLUDE_CLASSES.map(c => `.${c}`), "form button"
].join(",");

// Pages that carry the editor -> the source file that bake-copy.mjs rewrites.
export const PAGES = { home: "index.html", privacy: "privacy/index.html", terms: "terms/index.html" };

export const MAX_TEXT = 1000;
export const norm = s => s.replace(/\s+/g, " ").trim();
export const hasWords = s => /[A-Za-z0-9]/.test(s);

// FNV-1a 32-bit — tiny and stable; the stored `orig` string guards against collisions.
export function hashText(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

const PHONE_HREF = /^tel:/;
const MAIL_HREF = /^mailto:/;
const SAFE_EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const isContactHref = href => !!href && (PHONE_HREF.test(href) || MAIL_HREF.test(href));

// tel:/mailto: links follow their visible text so an edited phone number or email can't leave a stale href.
// Returns null when the text isn't a usable phone/email.
export function hrefFor(origHref, text) {
  if (PHONE_HREF.test(origHref)) { const d = text.replace(/\D/g, ""); return d.length >= 7 && d.length <= 15 ? "tel:" + d : null; }
  if (MAIL_HREF.test(origHref)) return SAFE_EMAIL.test(text) ? "mailto:" + text : null;
  return null;
}

// Strict validation for a stored entry. Used by the bake step on untrusted Firestore data.
export function validEntry(key, e) {
  return /^[0-9a-f]{8}$/.test(key) && e && typeof e.orig === "string" && typeof e.text === "string"
    && e.orig === norm(e.orig) && hasWords(e.orig) && hashText(e.orig) === key
    && e.text === norm(e.text) && e.text.length > 0 && e.text.length <= MAX_TEXT
    && !/[\u0000-\u001f\u007f\u2028\u2029]/.test(e.text) && e.text !== e.orig;
}

export function collectUnits(root) {
  root = root || document.body;
  const doc = root.ownerDocument, SHOW_TEXT = 4;
  const units = [];
  const walker = doc.createTreeWalker(root, SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(EXCLUDE_SELECTOR)) continue;
    const orig = norm(node.nodeValue);
    if (!hasWords(orig)) continue; // skip whitespace and decorative glyphs
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

export function applyEntries(units, entries) {
  for (const u of units) {
    const e = entries && entries[u.key];
    // Never trust stored data beyond plain text: the entry must be well-formed and match this node's original text,
    // and a link's href is always recomputed from the text (never read from storage).
    const hit = e && e.orig === u.orig && validEntry(u.key, e) && (!u.link || !!hrefFor(u.origHref, e.text));
    const text = hit ? e.text : u.orig;
    const value = u.lead + text + u.trail;
    if (u.node.nodeValue !== value) u.node.nodeValue = value;
    if (u.link) u.link.setAttribute("href", (hit && hrefFor(u.origHref, text)) || u.origHref);
  }
}
