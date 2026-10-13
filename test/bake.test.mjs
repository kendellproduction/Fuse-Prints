import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { read, dom, fsDoc, ROOT } from "./helpers.mjs";
import { PAGES, collectUnits, applyEntries, hashText, norm, validEntry } from "../assets/js/copy-core.js";
import { unitsFromHtml, bakeHtml, entriesFromFirestore, main } from "../scripts/bake-copy.mjs";

const entry = (orig, text) => ({ [hashText(norm(orig))]: { orig: norm(orig), text } });
const pages = Object.entries(PAGES);

test("PARITY: browser and baker see the exact same editable units on every page", () => {
  for (const [page, file] of pages) {
    const html = read(file);
    const b = collectUnits(dom(html).body).map(u => `${u.key}|${u.orig}|${u.origHref || ""}`);
    const n = unitsFromHtml(html).map(u => `${u.key}|${u.orig}|${u.link ? u.link.href : ""}`);
    assert.ok(b.length > 10, `${page}: expected real content, got ${b.length}`);
    assert.deepEqual(n, b, `${page}: unit mismatch between DOM and source parsing`);
  }
});

test("NO-OP: baking with no edits leaves every page byte-identical", () => {
  for (const [, file] of pages) { const h = read(file); assert.equal(bakeHtml(h, {}).html, h); }
});

test("CLIENT/BAKE PARITY: what a visitor sees with overrides == what the baked file shows", () => {
  const html = read("index.html");
  const units = unitsFromHtml(html);
  const phone = units.find(u => u.link && u.link.href.startsWith("tel:"));
  const longText = units.find(u => u.orig.length > 20 && !u.link);
  const pick = units.filter((u, i) => i % 9 === 0 && !u.link).slice(0, 12);
  let entries = { ...entry(phone.orig, "(555) 010-9999"), ...entry(longText.orig, "New & improved <b>copy</b>") };
  for (const u of pick) entries = { ...entries, ...entry(u.orig, u.orig + " edited") };

  const live = dom(html); applyEntries(collectUnits(live.body), entries);
  const baked = dom(bakeHtml(html, entries).html);
  assert.equal(norm(baked.body.textContent), norm(live.body.textContent));
  const links = d => [...d.querySelectorAll('a[href^="tel:"],a[href^="mailto:"]')].map(a => a.getAttribute("href"));
  assert.deepEqual(links(baked), links(live));
  assert.ok(links(baked).includes("tel:5550109999"));
  // and baking is idempotent: baked file + same entries -> no further change
  assert.equal(bakeHtml(bakeHtml(html, entries).html, entries).html, bakeHtml(html, entries).html);
});

test("SECURITY: HTML/script payloads are stored as inert text and never create elements", () => {
  const html = read("index.html");
  const target = unitsFromHtml(html).find(u => u.orig.length > 15 && !u.link);
  const payload = `</a><script>alert(1)</script><img src=x onerror=alert(2)> "quoted" 'single' &amp;`;
  const out = bakeHtml(html, entry(target.orig, payload)).html;
  const before = dom(html), after = dom(out);
  assert.equal(after.querySelectorAll("*").length, before.querySelectorAll("*").length, "element count changed");
  assert.equal(after.querySelectorAll("script").length, before.querySelectorAll("script").length);
  assert.equal(after.querySelectorAll("[onerror]").length, 0);
  assert.ok(after.body.textContent.includes("alert(1)"), "payload should appear as visible text");
  assert.ok(!out.includes("<script>alert"), "raw script tag leaked into source");
});

test("SECURITY: malformed / tampered entries are ignored (nothing changes)", () => {
  const html = read("index.html");
  const u = unitsFromHtml(html).find(x => x.orig.length > 15 && !x.link);
  const k = u.key, good = { orig: u.orig, text: "Fine" };
  assert.notEqual(bakeHtml(html, { [k]: good }).html, html, "sanity: a valid edit applies");
  const bad = {
    "wrong key":        { deadbeef: good },
    "key not hex":      { "../../etc": good },
    "orig mismatch":    { [k]: { orig: u.orig + "x", text: "Fine" } },
    "empty text":       { [k]: { orig: u.orig, text: "" } },
    "too long":         { [k]: { orig: u.orig, text: "a".repeat(1001) } },
    "control char":     { [k]: { orig: u.orig, text: "bad\u0000text" } },
    "line separator":   { [k]: { orig: u.orig, text: "bad text" } },
    "unnormalised ws":  { [k]: { orig: u.orig, text: "two  spaces" } },
    "same as original": { [k]: { orig: u.orig, text: u.orig } },
    "non-string":       { [k]: { orig: u.orig, text: { evil: 1 } } },
    "extra href ignored": null
  };
  for (const [name, e] of Object.entries(bad)) {
    if (!e) continue;
    assert.equal(bakeHtml(html, e).html, html, `should reject: ${name}`);
  }
  // a stored href is never read: a javascript: href smuggled into an entry has no effect
  const phone = unitsFromHtml(html).find(x => x.link && x.link.href.startsWith("tel:"));
  const smuggled = { [phone.key]: { orig: phone.orig, text: "(555) 010-9999", href: "javascript:alert(1)" } };
  const out = bakeHtml(html, smuggled).html;
  assert.ok(!out.includes("javascript:alert"));
  assert.ok(out.includes('href="tel:5550109999"'));
  // phone/email links must keep showing a phone/email
  assert.equal(bakeHtml(html, entry(phone.orig, "call us maybe")).html, html);
  const dd = dom(html); applyEntries(collectUnits(dd.body), entry(phone.orig, "call us maybe"));
  assert.ok(dd.body.textContent.includes(phone.orig), "client must also refuse");
});

test("SCOPE: excluded regions (counters, form buttons, service list, gallery, scripts) are never edited", () => {
  const html = `<!DOCTYPE html><html><head><title>Head Title</title></head><body>
    <p class="stat-number">Zero</p><div id="services-list">Services</div><div id="gallery-row-1">Gallery</div>
    <form><button><span>Send</span></button></form><script>var x = "Code";</script><svg><text>Vector</text></svg>
    <textarea>Area</textarea><p data-no-edit>Locked</p><p>Editable</p><button>Outside</button></body></html>`;
  const all = ["Head Title","Zero","Services","Gallery","Send","Code","Vector","Area","Locked","Editable","Outside"];
  const entries = Object.assign({}, ...all.map(t => entry(t, t + " CHANGED")));
  const out = bakeHtml(html, entries).html;
  assert.ok(out.includes("Editable CHANGED") && out.includes("Outside CHANGED"));
  for (const t of ["Head Title","Zero","Services","Gallery","Send","Code","Vector","Area","Locked"])
    assert.ok(!out.includes(t + " CHANGED"), `${t} must not be editable`);
  // the browser rule agrees
  const d = dom(html); applyEntries(collectUnits(d.body), entries);
  assert.ok(d.body.textContent.includes("Editable CHANGED") && !d.body.textContent.includes("Zero CHANGED"));
});

test("FIRESTORE: REST documents are parsed strictly (non-string values dropped)", () => {
  const doc = fsDoc({ aaaaaaaa: { orig: "A", text: "B" } });
  doc.fields.entries.mapValue.fields.bbbbbbbb = { mapValue: { fields: { orig: { integerValue: "1" }, text: { stringValue: "x" } } } };
  doc.fields.entries.mapValue.fields.cccccccc = { stringValue: "nope" };
  assert.deepEqual(entriesFromFirestore(doc), { aaaaaaaa: { orig: "A", text: "B" } });
  assert.deepEqual(entriesFromFirestore({}), {});
  assert.deepEqual(entriesFromFirestore(null), {});
});

function sandbox() {
  const dir = mkdtempSync(resolve(tmpdir(), "bake-"));
  for (const [, f] of pages) { mkdirSync(resolve(dir, f, ".."), { recursive: true }); cpSync(resolve(ROOT, f), resolve(dir, f)); }
  const fx = resolve(dir, "fx"); mkdirSync(fx);
  return { dir, fx };
}

test("END-TO-END: fixture Firestore -> baked files + summary; second run is a no-op", async () => {
  const { dir, fx } = sandbox();
  const phone = unitsFromHtml(read("index.html")).find(u => u.link && u.link.href.startsWith("tel:"));
  writeFileSync(resolve(fx, "copy_home.json"), JSON.stringify(fsDoc(entry(phone.orig, "(555) 010-9999"))));
  const r1 = await main({ root: dir, fixtureDir: fx });
  assert.equal(r1.changed, true);
  assert.match(readFileSync(resolve(dir, "index.html"), "utf8"), /href="tel:5550109999"/);
  assert.equal(readFileSync(resolve(dir, "privacy/index.html"), "utf8"), read("privacy/index.html"), "other pages untouched");
  const r2 = await main({ root: dir, fixtureDir: fx });
  assert.equal(r2.changed, false, "idempotent");
});

test("SAFETY CAP: more than 200 edits in one run aborts and writes nothing", async () => {
  const { dir, fx } = sandbox();
  const words = Array.from({ length: 250 }, (_, i) => `Paragraph number ${i}`);
  const html = `<!DOCTYPE html><html><body>${words.map(w => `<p>${w}</p>`).join("")}</body></html>`;
  writeFileSync(resolve(dir, "index.html"), html);
  writeFileSync(resolve(fx, "copy_home.json"), JSON.stringify(fsDoc(Object.assign({}, ...words.map(w => entry(w, w + " edited"))))));
  await assert.rejects(main({ root: dir, fixtureDir: fx }), /Refusing to apply 250 edits/);
  assert.equal(readFileSync(resolve(dir, "index.html"), "utf8"), html, "file must be untouched");
});

test("validEntry sanity", () => {
  const k = hashText("Hello");
  assert.equal(validEntry(k, { orig: "Hello", text: "World" }), true);
  assert.equal(validEntry(k, { orig: "Hello", text: "Hello" }), false);
});
