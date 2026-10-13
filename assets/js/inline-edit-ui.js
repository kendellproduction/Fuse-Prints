// Inline copy editor — loaded only for signed-in admins (see inline-edit.js).
// createEditor() is pure UI/logic with an injected save(); mountEditor() wires it to Firebase Auth + Firestore.

import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc, setDoc, deleteField, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { getDb, applyEntries, hrefFor, norm, validEntry, HINT_KEY } from "./inline-edit.js";
import { getApps } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";

const MAX_LEN = 1000;
const PAGE_STYLE = `
  fp-t{display:inline}
  [data-fp-t]{outline:1px dashed rgba(56,189,248,.6);outline-offset:2px;border-radius:2px;cursor:text}
  [data-fp-t]:hover{background:rgba(56,189,248,.14)}
  [data-fp-t]:focus{outline:2px solid #38bdf8;background:rgba(56,189,248,.2)}
  [data-fp-t].fp-changed{outline-color:#f59e0b}`;
const BAR_STYLE = `
  :host{all:initial}
  .bar{position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:8px;align-items:center;
    background:#0b1220;color:#e6edf7;border:1px solid rgba(255,255,255,.15);border-radius:999px;padding:8px 10px 8px 16px;
    font:500 13px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.5);max-width:calc(100vw - 24px);flex-wrap:wrap;justify-content:center}
  button{font:inherit;border:0;border-radius:999px;padding:8px 14px;cursor:pointer;background:rgba(255,255,255,.1);color:inherit}
  button:hover:not(:disabled){background:rgba(255,255,255,.2)} button:disabled{opacity:.4;cursor:default}
  button.primary{background:#2196f3;color:#fff} button.primary:hover:not(:disabled){background:#42a5f5}
  .msg{opacity:.8;min-width:90px} .err{color:#fca5a5;opacity:1} .ok{color:#86efac;opacity:1}`;

export function createEditor({ pageId, units, store, save, who, onSaved }) {
  const host = document.createElement("div");
  host.id = "fp-edit-root";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `<style>${BAR_STYLE}</style><div class="bar"></div>`;
  const bar = shadow.querySelector(".bar");
  document.body.appendChild(host);

  let editing = false, active = null, pageStyle = null;
  const spanUnits = () => units.filter(u => u.span);

  function textOf(u) { return norm(u.span ? u.span.textContent : u.node.nodeValue); }
  function savedText(u) { const e = store.entries[u.key]; return e && e.orig === u.orig && e.text ? e.text : u.orig; }

  // Per-key view of what's on screen vs what's saved.
  function changes() {
    const byKey = new Map();
    for (const u of spanUnits()) if (!byKey.has(u.key)) byKey.set(u.key, u);
    const out = [];
    for (const [key, u] of byKey) {
      const now = textOf(u), was = savedText(u);
      if (now !== was) out.push({ key, u, now, was });
    }
    return out;
  }

  function setMsg(text, cls = "") { const m = bar.querySelector(".msg"); if (m) { m.textContent = text; m.className = "msg " + cls; } }

  function render() {
    if (!editing) {
      bar.innerHTML = `<span class="msg">Signed in as ${esc(who)}</span><button class="primary" data-a="edit">✎ Edit page copy</button>`;
    } else {
      const n = changes().length;
      bar.innerHTML = `<span class="msg">${n ? n + " unsaved change" + (n > 1 ? "s" : "") : "Click any text to edit"}</span>
        <button data-a="revert" ${active ? "" : "disabled"} title="Put this text back to the original wording">↺ Reset this text</button>
        <button data-a="discard" ${n ? "" : "disabled"}>Discard</button>
        <button class="primary" data-a="save" ${n ? "" : "disabled"}>Save &amp; publish</button>
        <button data-a="done">Done</button>`;
    }
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function wrap(u) {
    // Custom element (not <span>) so the page's `.hero-word span`-style selectors and GSAP tweens never touch it.
    const span = document.createElement("fp-t");
    span.setAttribute("data-fp-t", u.key);
    try { span.contentEditable = "plaintext-only"; } catch (_) { span.contentEditable = "true"; }
    span.spellcheck = true;
    span.textContent = norm(u.node.nodeValue);
    u.pre = document.createTextNode(u.lead); u.post = document.createTextNode(u.trail);
    u.node.replaceWith(u.pre, span, u.post);
    u.span = span;
  }
  function unwrap(u, text) {
    const node = document.createTextNode(u.lead + text + u.trail);
    u.pre.remove(); u.post.remove(); u.span.replaceWith(node);
    u.node = node; u.span = u.pre = u.post = null;
  }

  function onInput(e) {
    const s = e.target.closest("[data-fp-t]"); if (!s) return;
    if (s.textContent.length > MAX_LEN) s.textContent = s.textContent.slice(0, MAX_LEN);
    for (const u of spanUnits()) { // identical strings (marquee clones, repeated CTAs) stay in sync
      if (u.key === s.getAttribute("data-fp-t") && u.span !== s) u.span.textContent = s.textContent;
    }
    markChanged(); render();
  }
  function markChanged() {
    for (const u of spanUnits()) u.span.classList.toggle("fp-changed", textOf(u) !== savedText(u));
  }
  function onKeydown(e) {
    if (!e.target.closest || !e.target.closest("[data-fp-t]")) return;
    if (e.key === "Enter") e.preventDefault(); // copy is single-run text; no new blocks
    if (e.key === "Escape") e.target.blur();
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") { e.preventDefault(); doSave(); }
  }
  function onPaste(e) { // plain text only, even if the browser lacks plaintext-only editing
    if (!e.target.closest || !e.target.closest("[data-fp-t]")) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData.getData("text/plain") || "").replace(/\s+/g, " "));
  }
  function onFocusIn(e) { const s = e.target.closest && e.target.closest("[data-fp-t]"); if (s) { active = s; render(); } }
  function onClickCapture(e) { // links and buttons must not navigate or submit while editing
    if (host.contains(e.target) || e.composedPath().includes(host)) return;
    if (e.target.closest && e.target.closest("a, button, summary, label")) {
      e.preventDefault();
      e.stopPropagation(); // also keeps the page's own click handlers (smooth-scroll, menus) from firing
    }
  }
  function beforeUnload(e) { if (changes().length) { e.preventDefault(); e.returnValue = ""; } }

  function start() {
    editing = true;
    pageStyle = document.createElement("style"); pageStyle.textContent = PAGE_STYLE; document.head.appendChild(pageStyle);
    units.forEach(wrap);
    document.addEventListener("input", onInput, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("paste", onPaste, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("click", onClickCapture, true);
    window.addEventListener("beforeunload", beforeUnload);
    render();
  }
  function stop() {
    for (const u of spanUnits()) unwrap(u, savedText(u));
    applyEntries(units, store.entries); // restores any tel:/mailto: hrefs too
    pageStyle && pageStyle.remove();
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("click", onClickCapture, true);
    window.removeEventListener("beforeunload", beforeUnload);
    editing = false; active = null; render();
  }

  function setAll(key, text) { for (const u of spanUnits()) if (u.key === key) u.span.textContent = text; }
  function discard() { for (const c of changes()) setAll(c.key, c.was); markChanged(); render(); }
  function revertActive() {
    if (!active) return;
    const key = active.getAttribute("data-fp-t"), u = units.find(x => x.key === key);
    setAll(key, u.orig); markChanged(); render();
  }

  async function doSave() {
    const list = changes();
    if (!list.length) return;
    const empty = list.find(c => !c.now);
    if (empty) { setMsg("A text box is empty — type something or reset it.", "err"); return; }
    const entries = {};
    for (const c of list) {
      if (c.now === c.u.orig) { entries[c.key] = deleteField(); continue; } // back to original → drop override
      const e = { orig: c.u.orig, text: c.now };
      const link = units.find(x => x.key === c.key && x.link);
      if (link && !hrefFor(link.origHref, c.now)) { // links follow their text, so it must be a usable phone/email
        setMsg(`"${c.now}" isn't a valid ${link.origHref.startsWith("tel:") ? "phone number" : "email"}.`, "err"); return;
      }
      if (!validEntry(c.key, e)) { setMsg("That text can't be saved (control characters or too long).", "err"); return; }
      entries[c.key] = e;
    }
    // Edits already baked into the HTML (or otherwise orphaned) no longer match any text on the page: drop them,
    // so an old edit can never resurface if the wording is later changed back.
    const inert = Object.keys(store.entries).filter(k => !units.some(u => u.key === k && store.entries[k].orig === u.orig));
    for (const k of inert) entries[k] = deleteField();
    bar.querySelectorAll("button").forEach(b => b.disabled = true);
    setMsg("Saving…");
    try {
      await save(entries);
      for (const k of inert) delete store.entries[k];
      for (const c of list) { // fold into the local store so `changes()` is clean
        if (c.now === c.u.orig) delete store.entries[c.key];
        else store.entries[c.key] = entries[c.key];
      }
      onSaved && onSaved(store.entries);
      markChanged(); render(); setMsg("Saved — live on the site now.", "ok");
    } catch (e) {
      console.error(e); render();
      setMsg(e && e.code === "permission-denied" ? "Not allowed — is this account an admin?" : "Save failed: " + (e.message || e), "err");
    }
  }

  bar.addEventListener("click", e => {
    const a = e.target.closest("button")?.dataset.a;
    if (a === "edit") start();
    else if (a === "save") doSave();
    else if (a === "discard") discard();
    else if (a === "revert") revertActive();
    else if (a === "done") { if (changes().length && !confirm("Discard your unsaved changes?")) return; stop(); }
  });

  render();
  return { start, stop, changes, save: doSave, host, isEditing: () => editing };
}

export function mountEditor({ pageId, units, store }) {
  const db = getDb();
  if (!db) return;
  const auth = getAuth(getApps()[0]);
  let editor = null;
  onAuthStateChanged(auth, async user => {
    if (editor) { editor.host.remove(); editor = null; }
    if (!user) { try { localStorage.removeItem(HINT_KEY); } catch (_) {} return; }
    try {
      const isAdmin = (await getDoc(doc(db, "admins", user.uid))).exists();
      if (!isAdmin) return;
      try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
      editor = createEditor({
        pageId, units, store, who: user.email || "admin",
        save: entries => setDoc(doc(db, "settings", "copy_" + pageId),
          { entries, updatedAt: serverTimestamp(), updatedBy: user.email || user.uid }, { merge: true }),
        onSaved: all => { try { localStorage.setItem("fp_copy_" + pageId, JSON.stringify(all)); } catch (_) {} }
      });
    } catch (e) { console.warn("admin check failed:", e); }
  });
}
