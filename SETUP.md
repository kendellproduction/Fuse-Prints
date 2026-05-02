# Fuse Prints — Admin Panel Setup

The site now has a private admin panel at `fuseprints.com/admin` (after deploy) where Chris can add/edit/delete products and gallery images. Everything he changes goes live on the site instantly.

Follow these one-time setup steps to turn it on.

## 1. Enable Firebase services

Open the [Firebase Console](https://console.firebase.google.com/project/fuse-prints/overview) for the **fuse-prints** project and enable three services:

### a. Authentication
1. Left sidebar → **Build → Authentication**
2. Click **Get started**
3. Pick **Email/Password** → toggle **Enable** → **Save**

### b. Firestore Database
1. Left sidebar → **Build → Firestore Database**
2. Click **Create database**
3. Choose **Production mode**, pick a region (us-central1 is a good default)
4. Click **Create**

### c. Storage
1. Left sidebar → **Build → Storage**
2. Click **Get started** → **Next** → **Done**

## 2. Paste your Firebase web config

1. Firebase Console → gear icon (top-left) → **Project settings**
2. Scroll to **Your apps** → click the web icon `</>` (or select an existing web app)
3. If creating a new app: name it "Fuse Prints Site" → **Register app**
4. Copy the `firebaseConfig` object shown

Open `assets/js/firebase-config.js` and paste the values in — replace the three `REPLACE_WITH_*` strings with the matching values from the console. It should look like:

```js
export const firebaseConfig = {
  apiKey: "AIzaSy...",
  authDomain: "fuse-prints.firebaseapp.com",
  projectId: "fuse-prints",
  storageBucket: "fuse-prints.appspot.com",
  messagingSenderId: "123456789",
  appId: "1:123456789:web:abc123"
};
```

> These values are safe to commit to git — security is enforced by the Firestore + Storage rules, not the API key.

## 3. Deploy the Firestore + Storage rules

From the project directory, run:

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage
```

This uploads `firestore.rules`, `firestore.indexes.json`, and `storage.rules`.

## 4. Create the admin users

Create two auth accounts — one for Chris, one for you.

### a. Create the auth accounts
In the Firebase Console → **Authentication → Users → Add user**:

1. **chris@fuseprints.com** — pick a simple starter password (Chris will change it via the admin's "Change Password" screen, or via "Forgot password?" on the login screen).
2. **kendellproduction@gmail.com** — pick a password only you know.

### b. Grant admin access
For each user, copy their **UID** from the Users table.

Go to **Firestore Database → Data → Start collection**.
- Collection ID: `admins`
- Document ID: paste the UID
- Add a field `email` (string) → the user's email (for reference only; the doc's *existence* is what grants access)
- Save

Repeat for the second user — each needs their own doc at `admins/{theirUID}`.

### c. Password handling
- **Firebase Auth stores passwords securely** (bcrypt-style server-side hashing). We never see or store plaintext.
- **Chris can reset anytime** via the "Forgot password?" link on `/admin` — it emails a reset link.
- **Change password while logged in**: Admin panel → Settings → Change Password.

## 5. Deploy the site

```bash
firebase deploy --only hosting
```

The admin panel will be live at `https://fuseprints.com/admin`.

---

## How the admin panel works

- **Dashboard** — quick stats (active products, gallery images, pending inquiries) + shortcuts
- **Products** — CRUD for the product cards shown in the Etsy Collection section. Upload an image, set title/price/description, paste the exact Etsy listing URL, toggle "Show on the live site" on/off, set a display order. The card on the landing page links straight to the Etsy listing.
- **Gallery** — CRUD for the photos in the "Our Work" marquee. Upload image, set title + category + order.
- **Inquiries** — all quote-request submissions from the site contact form. Filter by status (New / Read / Archived / All), mark as read, archive, delete, or click "Reply via Email" to open Gmail with the correct recipient.
- **Settings** — shows your email + user ID, and lets you change your password.

All edits go live immediately — no deploy needed after the initial setup.

## Collection schemas (for reference)

**`products/{id}`**
- `title` (string) — "Custom Wood Name Sign"
- `price` (string) — "$45.00" (plain text, not a number, so you can write "$45+")
- `description` (string, optional) — short blurb
- `etsyUrl` (string) — full Etsy listing URL
- `imageUrl` (string) — Firebase Storage download URL (set automatically on upload)
- `imagePath` (string) — Storage path (used for cleanup on delete)
- `order` (number) — lower first
- `active` (boolean) — true = visible on site
- `createdAt`, `updatedAt` — timestamps

**`gallery/{id}`**
- `title` (string)
- `category` (string) — "Trade Shows", "Signage", etc.
- `imageUrl` / `imagePath` — Storage references
- `order` (number)
- timestamps

**`admins/{uid}`** — just a marker doc granting admin permissions. Any fields allowed.

**`inquiries/{id}`** — contact form submissions. Created by anonymous public writes (field validation enforced in `firestore.rules`), readable + editable by admins only.
- `name`, `email`, `phone`, `projectType`, `message` (strings with size caps)
- `status` — "new" | "read" | "archived"
- `source` — currently always "website-contact-form"
- `createdAt` / `readAt` / `archivedAt` — timestamps

## Dev URLs

While running a local dev server (e.g. `python3 -m http.server 8090` from the project root), open:

- **Landing page**: http://localhost:8090/
- **Admin panel**: http://localhost:8090/admin/

> ⚠️ Don't open the HTML files directly via `file://` — ES modules + Firebase SDK fetches fail under that protocol and you'll see a blank page. Always use a dev server.

## Security notes

- **Firebase Auth** handles password hashing + verification — we never see plaintext. Login is rate-limited by Firebase.
- **All writes gated by security rules** — admin writes require the user to have a doc at `admins/{uid}`. Inquiries submissions are constrained by field shape + size validation to prevent abuse.
- **No client-side secrets** — the Firebase API key is public by design; the private key sits with Firebase.
- **User-supplied content is always HTML-escaped** on render in both the admin panel and the public product/gallery cards, so no XSS or prompt injection.
- **HTTPS enforced** by Firebase Hosting automatically.
- If you want to lock down the admin further, you can add Firebase App Check later — not included now to keep setup simple.

## Forgotten password

If Chris forgets his password, you (or he) can reset it two ways:

1. **Firebase Console** (fastest) — Authentication → Users → click the three dots next to his email → **Reset password**. Firebase emails him a reset link.
2. **Add a "Forgot password?" link on the login page** later if you want self-serve — ~10 lines of code.

## Troubleshooting

- **"Firebase Not Configured" screen** on `/admin/` — you haven't pasted the config into `firebase-config.js`, or you haven't saved the file.
- **Login succeeds, then shows "Access Denied"** — the user's UID isn't in the `admins` collection. Copy the UID shown on the denied screen and create a doc at `admins/{thatUID}`.
- **"Permission denied" when saving** — either the security rules haven't been deployed, or the user isn't in `admins`.
- **Uploaded image doesn't show up** — check the Storage tab in Firebase Console; the file should be under `/products/` or `/gallery/`. If it's there but the site doesn't show it, hard-reload (⌘⇧R) to bust the cache.
