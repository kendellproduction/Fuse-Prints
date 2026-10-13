import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { parse } from "yaml";
import { ROOT } from "./helpers.mjs";
import { resolve } from "node:path";

const dir = resolve(ROOT, ".github/workflows");
const files = readdirSync(dir).filter(f => /\.ya?ml$/.test(f));

test("workflows: valid YAML, every third-party action pinned to a full commit SHA", () => {
  assert.ok(files.length > 0);
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), "utf8");
    const wf = parse(src);
    assert.ok(wf.jobs, `${f}: no jobs`);
    for (const m of src.matchAll(/uses:\s*([^\s#]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${f}: unpinned action ${m[1]}`);
  }
});

test("workflows: least privilege, no dangerous triggers, no untrusted interpolation in shell", () => {
  for (const f of files) {
    const src = readFileSync(resolve(dir, f), "utf8"); const wf = parse(src);
    assert.deepEqual(wf.permissions, { contents: "write" }, `${f}: permissions should be exactly contents:write`);
    assert.ok(!("pull_request_target" in (wf.on || {})), `${f}: pull_request_target is unsafe here`);
    for (const job of Object.values(wf.jobs)) for (const step of job.steps) {
      if (!step.run) continue;
      assert.ok(!/\$\{\{\s*(github\.event|github\.head_ref|inputs)/.test(step.run), `${f}: untrusted expression inside run: ${step.name || step.run.slice(0, 40)}`);
      assert.ok(!/\$\{\{\s*secrets\./.test(step.run), `${f}: secrets must go through env, not inline in run`);
    }
  }
});

test("workflows: deploy is gated behind tests, and the key is deleted afterwards", () => {
  const wf = parse(readFileSync(resolve(dir, "copy-sync-deploy.yml"), "utf8"));
  const names = wf.jobs["sync-and-deploy"].steps.map(s => s.name || s.uses || s.run);
  const idx = n => names.findIndex(x => x && x.includes(n));
  assert.ok(idx("Test") > -1 && idx("Test") < idx("Bake") && idx("Bake") < idx("Deploy"));
  assert.ok(idx("Remove credentials") > idx("Deploy"));
  assert.ok(wf.jobs["sync-and-deploy"].steps.find(s => s.name === "Remove credentials")["if"] === "always()");
  assert.equal(wf.concurrency["cancel-in-progress"], false);
});

test("hosting: internal files are excluded from deploy and security headers are present", () => {
  const h = JSON.parse(readFileSync(resolve(ROOT, "firebase.json"), "utf8")).hosting;
  for (const p of ["**/*.md", "firestore.rules", "storage.rules", "storage-cors.json", "package.json", "scripts/**", "test/**"])
    assert.ok(h.ignore.includes(p), `firebase.json should ignore ${p}`);
  const all = h.headers.find(x => x.source === "**").headers.map(x => x.key);
  for (const k of ["X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) assert.ok(all.includes(k), k);
  const admin = h.headers.filter(x => x.source.startsWith("/admin")).flatMap(x => x.headers);
  assert.ok(admin.some(x => x.key === "X-Frame-Options" && x.value === "DENY"));
});

test("pages: CDN scripts are pinned with SRI (font CSS and the Tailwind play CDN are the known exceptions)", () => {
  for (const f of ["index.html", "service.html", "admin/index.html"]) {
    const html = readFileSync(resolve(ROOT, f), "utf8");
    const tags = [...html.matchAll(/<script\b[^>]*\bsrc="(https:\/\/[^"]+)"[^>]*>/g), ...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="(https:\/\/[^"]+)"[^>]*>|<link\b[^>]*href="(https:\/\/[^"]+)"[^>]*rel="stylesheet"[^>]*>/g)];
    for (const m0 of tags) {
      const m = [m0[0], m0[1] || m0[2]];
      if (["fonts.googleapis", "api.fontshare.com", "cdn.tailwindcss.com"].some(h => m[1].includes(h))) continue; // font CSS + Tailwind play CDN are dynamic: cannot be hashed
      assert.match(m[0], /integrity="sha384-/, `${f}: ${m[1]} lacks SRI`);
      assert.ok(!/@latest|@\d+\/|@\d+"/.test(m[1]), `${f}: ${m[1]} is not pinned to an exact version`);
    }
  }
});

test("phone number: new number present everywhere, old number gone", () => {
  for (const f of ["index.html", "service.html", "privacy/index.html", "terms/index.html"]) {
    const html = readFileSync(resolve(ROOT, f), "utf8");
    assert.ok(!/877.{0,3}575.{0,3}3873/.test(html), `${f} still has the old number`);
  }
  const home = readFileSync(resolve(ROOT, "index.html"), "utf8");
  assert.ok(home.includes('tel:8143313110') && home.includes("(814) 331-3110") && home.includes("+1-814-331-3110"));
});
