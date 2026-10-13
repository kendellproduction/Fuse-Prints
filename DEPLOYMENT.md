# Fuse Prints — Deployment & Chris Onboarding

## 1. Deploy the new code

From the project root (NOT inside `.claude/worktrees/...`):

```bash
firebase deploy
```

That pushes everything in one shot:
- **Hosting** — new `index.html`, `service.html`, `admin/*`, `robots.txt`, `sitemap.xml`, the 3 hero mockups, and the new catch-all URL rewrite (`/:slug` → `/service.html`).
- **Firestore rules** — adds `/services/{slug}` rule (public read, admin write) so admin can save services.

To deploy individually if needed:
```bash
firebase deploy --only hosting          # site only
firebase deploy --only firestore:rules  # rules only
```

## 2. Give Chris admin access

Admin access is gated by Firestore: a user can log into `/admin/` only if there's a document in the `admins` collection with their Firebase Auth UID as the document ID.

There are two clean ways to grant Chris access:

### Option A — Have Chris sign in once, then add his UID
1. Send Chris this URL: **https://fuseprints.com/admin**
2. Tell him to click "Sign in with Google" and use **chris@fuseprints.com**.
3. He'll hit an "Access Denied" screen — that screen shows his UID.
4. Tell him to send you the UID (or copy it from the screen yourself).
5. In Firebase Console → Firestore → `admins` collection, create a new document:
   - Document ID: `<Chris's UID>`
   - Fields: `email: "chris@fuseprints.com"`, `role: "owner"`, `createdAt: <timestamp>`
6. Chris refreshes — he's in.

### Option B — Create the Firebase Auth user directly
1. Firebase Console → Authentication → Users → Add User
2. Email: `chris@fuseprints.com`, set a temporary password
3. Copy the generated UID
4. Firestore → `admins` collection → new doc with that UID
5. Send Chris his credentials with a "use Forgot Password to set your own" note

**Either way**, all admins have equal privileges. Chris can:
- Read & edit all services, products, gallery, inquiries, site images
- Create new service landing pages with custom URL slugs
- Delete his own custom services (the 7 default services are protected from deletion)
- Reset his own password from the Settings tab

## 3. What's new for Chris

### A. Service landing pages — fully editable
Each of the 7 services has a clean URL (`/banners`, `/custom-signs`, etc.) and a rich page with:
- Hero (heading, eyebrow, subheading)
- Image carousel
- Overview (long-form copy)
- Capabilities grid (icon + title + description per item)
- Materials / substrates list
- Use cases grid
- FAQ accordion
- Related services links
- Final CTA

All of this is editable from `/admin/` → Service Pages tab → click any service.

### B. Chris can add brand-new services
- `/admin/` → Service Pages → **+ New Service**
- Type the service name → URL slug auto-generates (Chris can override)
- Fills in all sections like the existing services
- Save → live immediately at `/his-new-slug`
- Custom services can be deleted; the original 7 cannot (to prevent accidents)

### C. SEO + AI search
Every service page now includes:
- Canonical URL
- Per-service `<title>` and `meta description`
- Open Graph + Twitter cards
- JSON-LD structured data: `LocalBusiness`, `Service`, `FAQPage`, `BreadcrumbList`
- Listed in `sitemap.xml`

`robots.txt` explicitly allows GPTBot, ClaudeBot, Google-Extended, PerplexityBot, and Applebot-Extended so AI search engines can index Fuse Prints content.

### D. Hero mockup options
For Chris to pick from (after deploy, accessible at these URLs):
- https://fuseprints.com/hero-mock-1.html — **Option 1**: CMYK registration mark (current)
- https://fuseprints.com/hero-mock-2.html — **Option 2**: Bold typography + stats (10+ years · 5K projects · 48 states) with marquee strips
- https://fuseprints.com/hero-mock-3.html — **Option 3**: Split layout with floating "print sheet" illustration

## 4. Post-deploy verification

1. Visit `/banners` (and a few others) — full landing page should render
2. Visit `/this-does-not-exist` — should show the 404 inline state
3. Visit `/sitemap.xml` and `/robots.txt` — should serve correctly
4. Open Chrome DevTools → Application → View Source → `<head>` — confirm JSON-LD scripts present on a service page
5. Test the admin: log in, edit a service, save, refresh the public page, confirm changes are live
6. Try creating a new service with a custom slug — confirm `/your-slug` resolves with the entered content
7. Try deleting a custom service — confirm it disappears

## 5. Things still hardcoded (can be made dynamic later if needed)
- The homepage's marquee strip text under the nav ("Backdrops, Banners, Trade Show Displays...")
- The 8-step "How It Works" process section
- The hardcoded service cards in the initial HTML (gets hydrated by JS so any custom services Chris adds will appear on the homepage too)
- Testimonials section
- FAQ section on the homepage (different from the per-service FAQ which IS editable)

## 4. Editing page copy in place (Chris)

1. Sign in at **https://fuseprints.com/admin** (once — the session is remembered in that browser).
2. Open the site (home, Privacy, Terms). A small bar appears at the bottom: **✎ Edit page copy**.
3. Click it, click any text, type. Enter is disabled (copy is single-run text). **↺ Reset this text** restores the original wording.
4. **Save & publish** — the change is live on the site immediately. **Discard** drops unsaved changes. **Done** leaves edit mode.

### What happens after Save
1. The edit is written to Firestore (`settings/copy_<page>`) and shows on the live site right away.
2. Within ~5 minutes the **"Copy sync + deploy"** GitHub Action (`.github/workflows/copy-sync-deploy.yml`) reads those edits, writes them into the HTML source (`scripts/bake-copy.mjs`), commits to `master` as `fuse-prints-bot`, deploys to Firebase Hosting and verifies the live files match the repo.
3. So GitHub always ends up with exactly what is live. To undo any edit: `git revert` the bot commit (or edit the text again).

### One-time setup so the Action can deploy
Committing to GitHub works out of the box. Deploying needs a Firebase service account stored as a repo secret:
1. Google Cloud console → IAM → Service accounts → create `github-hosting-deploy` with the single role **Firebase Hosting Admin**.
2. Create a JSON key for it and save its contents as the GitHub repo secret `FIREBASE_SERVICE_ACCOUNT_FUSE_PRINTS` (Settings → Secrets and variables → Actions). Delete the downloaded file afterwards.
3. Run the workflow once from the Actions tab ("Run workflow"). Until the secret exists the Action skips the deploy step and says so.

### Security model
- Only users with a doc in the `admins` collection get the editor; Firestore rules only let those users write `settings/*`.
- The baker treats everything in Firestore as untrusted input: strict key/length/character validation, plain text only (HTML-escaped), only existing text nodes are changed, `tel:`/`mailto:` hrefs are re-derived from the text (never read from storage), at most 200 edits per run. It cannot add tags, scripts, attributes or URLs. Tests for all of this run before every deploy.
- A compromised admin account could therefore change wording and phone/email on those pages — not inject code. Use Google sign-in with 2-step verification on the admin accounts.
- The deploy key is Hosting-only, passed via env, written to a temp file with `umask 077` and deleted at the end of the job; third-party actions are pinned to commit SHAs; the workflow has `contents: write` only.

### Limits
- Identical text on one page (e.g. every "Get a Quote" button, the scrolling ticker) changes together.
- Edited phone numbers / emails update their `tel:` / `mailto:` links, but **not** the SEO structured data (`"telephone"` in the page `<head>`) — that still needs a code change.
- Not editable in place: service landing pages (Admin → Services), gallery/products, page titles and meta descriptions.
- If a developer changes the original HTML text, an edit saved against the old text stops applying (the new code wins).
