// Fuse Prints admin panel — Products + Gallery CRUD over Firestore + Storage.
// Auth: Firebase Email/Password. Admin check: doc exists at /admins/{uid}.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, addDoc, updateDoc, deleteDoc,
  getDocs, query, where, orderBy, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-storage.js";
import { firebaseConfig, isConfigured } from "../assets/js/firebase-config.js";

// ---------- Setup ----------
if (!isConfigured()) {
  document.getElementById("config-warning").classList.remove("hidden");
  throw new Error("Firebase not configured");
}

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

// ---------- Utilities ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
};

function showScreen(id) {
  ["screen-login", "screen-denied", "screen-admin"].forEach(s => $(s).classList.add("hidden"));
  $(id).classList.remove("hidden");
}

function toast(message, type = "info") {
  const t = $("toast");
  t.textContent = message;
  t.className = "toast " + type + " show";
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), 3500);
}

function openModal(id) { $(id).classList.add("active"); }
function closeModal(id) { $(id).classList.remove("active"); }

document.querySelectorAll(".modal-close").forEach(btn => {
  btn.addEventListener("click", () => closeModal(btn.dataset.modal));
});
document.querySelectorAll(".modal-bg").forEach(bg => {
  bg.addEventListener("click", e => { if (e.target === bg) closeModal(bg.id); });
});

// Drag-and-drop reordering. Saves new order to Firestore via batched write.
function setupSortable(gridId, collectionName) {
  const grid = $(gridId);
  if (!grid || !window.Sortable) return;
  if (grid._sortable) grid._sortable.destroy();
  grid._sortable = window.Sortable.create(grid, {
    animation: 180,
    ghostClass: "sortable-ghost",
    chosenClass: "sortable-chosen",
    dragClass: "sortable-drag",
    onEnd: async (evt) => {
      // Suppress next click on the dragged item
      if (evt.item) {
        evt.item.classList.add("just-dragged");
        setTimeout(() => evt.item.classList.remove("just-dragged"), 300);
      }
      const ids = Array.from(grid.querySelectorAll(".grid-item")).map(el => el.dataset.id).filter(Boolean);
      if (!ids.length) return;
      // Skip Firestore write if order didn't actually change
      if (evt.oldIndex === evt.newIndex) return;
      try {
        const batch = writeBatch(db);
        ids.forEach((id, i) => batch.update(doc(db, collectionName, id), { order: i, updatedAt: serverTimestamp() }));
        await batch.commit();
        toast("Order saved.", "success");
      } catch (e) {
        console.error(e);
        toast("Couldn't save order: " + e.message, "error");
      }
    }
  });
}

function confirmDialog(title, message) {
  return new Promise(resolve => {
    $("confirm-title").textContent = title;
    $("confirm-msg").textContent = message;
    openModal("confirm-modal");
    const ok = $("confirm-ok");
    const handle = () => {
      ok.removeEventListener("click", handle);
      closeModal("confirm-modal");
      resolve(true);
    };
    ok.addEventListener("click", handle);
    const cancelObs = () => {
      setTimeout(() => {
        if (!$("confirm-modal").classList.contains("active")) {
          ok.removeEventListener("click", handle);
          resolve(false);
        } else cancelObs();
      }, 300);
    };
    cancelObs();
  });
}

// ---------- Tabs ----------
document.querySelectorAll(".tab, .tab-link").forEach(el => {
  el.addEventListener("click", () => {
    const tab = el.dataset.tab;
    if (!tab) return;
    document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
    document.querySelectorAll(".panel").forEach(p => p.classList.toggle("hidden", p.dataset.panel !== tab));
    if (tab === "products") loadProducts();
    if (tab === "gallery") loadGallery();
    if (tab === "inquiries") loadInquiries();
    if (tab === "dashboard") loadDashboard();
  });
});

// ---------- Auth ----------
$("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const btn = $("login-btn");
  const err = $("login-error");
  btn.disabled = true; btn.textContent = "Signing in…"; err.classList.add("hidden");
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (e) {
    err.textContent = e.code === "auth/invalid-credential" || e.code === "auth/wrong-password" || e.code === "auth/user-not-found"
      ? "Invalid email or password."
      : (e.message || "Sign-in failed.");
    err.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Sign In";
  }
});

$("google-signin-btn").addEventListener("click", async () => {
  const btn = $("google-signin-btn");
  const err = $("login-error");
  btn.disabled = true;
  btn.querySelector("span").textContent = "Signing in…";
  err.classList.add("hidden");
  try {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await signInWithPopup(auth, provider, browserPopupRedirectResolver);
  } catch (e) {
    if (e.code !== "auth/popup-closed-by-user" && e.code !== "auth/cancelled-popup-request") {
      err.textContent = e.message || "Google sign-in failed.";
      err.classList.remove("hidden");
    }
    btn.disabled = false;
    btn.querySelector("span").textContent = "Sign in with Google";
  }
});

$("signout-btn").addEventListener("click", () => signOut(auth));
$("denied-signout").addEventListener("click", () => signOut(auth));

// Forgot password toggle
$("forgot-pw-btn").addEventListener("click", () => {
  $("login-form").classList.add("hidden");
  $("forgot-form-wrap").classList.remove("hidden");
  $("forgot-email").value = $("login-email").value || "";
  $("forgot-message").classList.add("hidden");
});
$("forgot-back-btn").addEventListener("click", () => {
  $("forgot-form-wrap").classList.add("hidden");
  $("login-form").classList.remove("hidden");
});

$("forgot-form").addEventListener("submit", async e => {
  e.preventDefault();
  const email = $("forgot-email").value.trim();
  const btn = $("forgot-btn");
  const msg = $("forgot-message");
  btn.disabled = true; btn.textContent = "Sending…"; msg.classList.add("hidden");
  try {
    await sendPasswordResetEmail(auth, email);
    msg.textContent = "✓ Check your email for a reset link.";
    msg.className = "text-green-400 text-sm text-center";
    msg.classList.remove("hidden");
  } catch (e) {
    // Don't leak whether the email exists — Firebase returns user-not-found otherwise
    msg.textContent = "If that email is registered, a reset link has been sent.";
    msg.className = "text-white/50 text-sm text-center";
    msg.classList.remove("hidden");
  } finally {
    btn.disabled = false; btn.textContent = "Send Reset Link";
  }
});

// Change password (while logged in)
$("change-pw-form").addEventListener("submit", async e => {
  e.preventDefault();
  const current = $("current-pw").value;
  const next = $("new-pw").value;
  const confirm = $("confirm-pw").value;
  const btn = $("change-pw-btn");
  if (next !== confirm) { toast("New passwords don't match.", "error"); return; }
  if (next.length < 8) { toast("Password must be at least 8 characters.", "error"); return; }
  if (next === current) { toast("New password must differ from current.", "error"); return; }
  const user = auth.currentUser;
  if (!user || !user.email) { toast("Not signed in.", "error"); return; }
  btn.disabled = true; btn.textContent = "Updating…";
  try {
    const cred = EmailAuthProvider.credential(user.email, current);
    await reauthenticateWithCredential(user, cred);
    await updatePassword(user, next);
    $("change-pw-form").reset();
    toast("Password updated.", "success");
  } catch (err) {
    const msg = err.code === "auth/wrong-password" || err.code === "auth/invalid-credential"
      ? "Current password is incorrect."
      : err.code === "auth/weak-password"
      ? "New password is too weak."
      : (err.message || "Couldn't update password.");
    toast(msg, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Update Password";
  }
});

onAuthStateChanged(auth, async user => {
  if (!user) {
    showScreen("screen-login");
    return;
  }
  try {
    const adminDoc = await getDoc(doc(db, "admins", user.uid));
    if (!adminDoc.exists()) {
      $("denied-uid").textContent = user.uid;
      showScreen("screen-denied");
      return;
    }
    $("user-email").textContent = user.email || "";
    $("settings-email").textContent = user.email || "";
    $("settings-uid").textContent = user.uid;
    showScreen("screen-admin");
    loadDashboard();
  } catch (e) {
    console.error(e);
    toast("Couldn't verify admin access: " + e.message, "error");
    showScreen("screen-denied");
    $("denied-uid").textContent = user.uid;
  }
});

// ---------- Dashboard ----------
async function loadDashboard() {
  try {
    const [prodSnap, gallSnap, inqSnap] = await Promise.all([
      getDocs(collection(db, "products")),
      getDocs(collection(db, "gallery")),
      getDocs(query(collection(db, "inquiries"), where("status", "==", "new")))
    ]);
    const activeProducts = prodSnap.docs.filter(d => d.data().active !== false).length;
    $("stat-products").textContent = activeProducts;
    $("stat-gallery").textContent = gallSnap.size;
    $("stat-inquiries").textContent = inqSnap.size;
    const badge = $("inbox-badge");
    if (inqSnap.size > 0) {
      badge.textContent = inqSnap.size;
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  } catch (e) {
    console.error(e);
  }
}

// ---------- Image upload (shared) ----------
function setupDropZone(zoneId, inputId, onFile) {
  const zone = $(zoneId);
  const input = $(inputId);
  zone.addEventListener("click", () => input.click());
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("drag"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", e => {
    e.preventDefault(); zone.classList.remove("drag");
    const f = e.dataTransfer.files[0]; if (f) onFile(f);
  });
  input.addEventListener("change", e => {
    const f = e.target.files[0]; if (f) onFile(f);
  });
}

function setDropZoneImage(zoneId, url) {
  const zone = $(zoneId);
  if (!url) {
    zone.classList.remove("has-image");
    zone.querySelector("img")?.remove();
    return;
  }
  zone.classList.add("has-image");
  let img = zone.querySelector("img");
  if (!img) {
    img = document.createElement("img");
    zone.prepend(img);
  }
  img.src = url;
}

async function uploadImage(file, pathPrefix, statusEl) {
  if (!file.type.startsWith("image/")) {
    toast("Please select an image file.", "error");
    throw new Error("Not an image");
  }
  if (file.size > 8 * 1024 * 1024) {
    toast("Image must be under 8MB.", "error");
    throw new Error("Too big");
  }
  const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
  const fileName = `${Date.now()}.${ext}`;
  const ref = storageRef(storage, `${pathPrefix}/${fileName}`);
  const task = uploadBytesResumable(ref, file);

  return new Promise((resolve, reject) => {
    task.on("state_changed",
      snap => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100);
        if (statusEl) statusEl.textContent = `Uploading… ${pct}%`;
      },
      err => { if (statusEl) statusEl.textContent = ""; reject(err); },
      async () => {
        const url = await getDownloadURL(task.snapshot.ref);
        if (statusEl) statusEl.textContent = "✓ Uploaded";
        resolve({ url, path: ref.fullPath });
      }
    );
  });
}

async function deleteStorageFile(path) {
  if (!path) return;
  try { await deleteObject(storageRef(storage, path)); }
  catch (e) { console.warn("Delete storage failed (may not exist):", e.message); }
}

// ---------- Products ----------
let _pendingProductImage = null; // { url, path } from a fresh upload

setupDropZone("product-drop-zone", "product-image-input", async file => {
  const status = $("product-upload-status");
  try {
    const res = await uploadImage(file, "products", status);
    _pendingProductImage = res;
    setDropZoneImage("product-drop-zone", res.url);
  } catch (e) {
    console.error(e);
    if (e.message !== "Not an image" && e.message !== "Too big") toast("Upload failed: " + e.message, "error");
  }
});

$("add-product-btn").addEventListener("click", () => openProductModal(null));

async function loadProducts() {
  const loading = $("products-loading"), empty = $("products-empty"), grid = $("products-grid");
  loading.classList.remove("hidden"); empty.classList.add("hidden"); grid.classList.add("hidden");
  try {
    const snap = await getDocs(query(collection(db, "products"), orderBy("order", "asc")));
    loading.classList.add("hidden");
    if (snap.empty) { empty.classList.remove("hidden"); return; }
    grid.innerHTML = snap.docs.map(d => {
      const p = d.data();
      return `<article class="grid-item cursor-pointer" data-id="${d.id}">
        <img class="grid-item-img" src="${esc(p.imageUrl || "")}" alt="${esc(p.title || "")}" loading="lazy" onerror="this.style.display='none'" />
        <div class="grid-item-body">
          <div class="flex items-start justify-between gap-2 mb-2">
            <h3 class="font-display font-semibold text-base truncate flex-1">${esc(p.title || "Untitled")}</h3>
            <div class="flex flex-col gap-1 items-end">
              <span class="badge ${p.active !== false ? "badge-active" : "badge-inactive"}">${p.active !== false ? "Live" : "Hidden"}</span>
              ${p.featured ? `<span class="badge" style="background:rgba(241,101,33,.18);color:#F99970">★ Featured</span>` : ""}
            </div>
          </div>
          ${p.price ? `<p class="text-etsy font-semibold text-sm mb-2">${esc(p.price)}</p>` : ""}
          <p class="text-white/35 text-xs truncate">${esc(p.etsyUrl || "—")}</p>
        </div>
      </article>`;
    }).join("");
    grid.classList.remove("hidden");
    grid.querySelectorAll(".grid-item").forEach(el => {
      el.addEventListener("click", e => {
        // Don't open modal if user just dragged
        if (el.classList.contains("just-dragged")) { el.classList.remove("just-dragged"); return; }
        const p = snap.docs.find(d => d.id === el.dataset.id);
        if (p) openProductModal({ id: p.id, ...p.data() });
      });
    });
    setupSortable("products-grid", "products");
  } catch (e) {
    loading.classList.add("hidden");
    console.error(e);
    toast("Couldn't load products: " + e.message, "error");
  }
}

function openProductModal(product) {
  _pendingProductImage = null;
  $("product-form").reset();
  $("product-id").value = product?.id || "";
  $("product-title").value = product?.title || "";
  $("product-price").value = product?.price || "";
  $("product-order").value = product?.order ?? 0;
  $("product-desc").value = product?.description || "";
  $("product-etsy").value = product?.etsyUrl || "";
  $("product-active").checked = product?.active !== false;
  $("product-featured").checked = product?.featured === true;
  $("product-modal-title").textContent = product ? "Edit Product" : "Add Product";
  $("product-delete-btn").classList.toggle("hidden", !product);
  $("product-upload-status").textContent = "";
  setDropZoneImage("product-drop-zone", product?.imageUrl || "");
  // Stash existing image path for cleanup if replaced
  $("product-form").dataset.existingImagePath = product?.imagePath || "";
  $("product-form").dataset.existingImageUrl = product?.imageUrl || "";
  openModal("product-modal");
}

$("product-form").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("product-id").value;
  const btn = $("product-save-btn"); btn.disabled = true; btn.textContent = "Saving…";

  const existingPath = $("product-form").dataset.existingImagePath;
  const existingUrl = $("product-form").dataset.existingImageUrl;

  const data = {
    title: $("product-title").value.trim(),
    price: $("product-price").value.trim(),
    order: Number($("product-order").value) || 0,
    description: $("product-desc").value.trim(),
    etsyUrl: $("product-etsy").value.trim(),
    active: $("product-active").checked,
    featured: $("product-featured").checked,
    imageUrl: _pendingProductImage?.url || existingUrl || "",
    imagePath: _pendingProductImage?.path || existingPath || "",
    updatedAt: serverTimestamp()
  };

  if (!data.imageUrl) { toast("Please upload a product image.", "error"); btn.disabled = false; btn.textContent = "Save Product"; return; }

  try {
    if (id) {
      await updateDoc(doc(db, "products", id), data);
      // Delete old image if replaced
      if (_pendingProductImage && existingPath && existingPath !== _pendingProductImage.path) {
        deleteStorageFile(existingPath);
      }
      toast("Product updated.", "success");
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, "products"), data);
      toast("Product added.", "success");
    }
    closeModal("product-modal");
    loadProducts();
    loadDashboard();
  } catch (e) {
    console.error(e);
    toast("Save failed: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save Product";
  }
});

$("product-delete-btn").addEventListener("click", async () => {
  const id = $("product-id").value;
  if (!id) return;
  if (!(await confirmDialog("Delete this product?", "It will be removed from the site immediately."))) return;
  try {
    const existingPath = $("product-form").dataset.existingImagePath;
    await deleteDoc(doc(db, "products", id));
    if (existingPath) deleteStorageFile(existingPath);
    toast("Product deleted.", "success");
    closeModal("product-modal");
    loadProducts();
    loadDashboard();
  } catch (e) { toast("Delete failed: " + e.message, "error"); }
});

// ---------- Gallery ----------
let _pendingGalleryImage = null;

setupDropZone("gallery-drop-zone", "gallery-image-input", async file => {
  const status = $("gallery-upload-status");
  try {
    const res = await uploadImage(file, "gallery", status);
    _pendingGalleryImage = res;
    setDropZoneImage("gallery-drop-zone", res.url);
  } catch (e) {
    console.error(e);
    if (e.message !== "Not an image" && e.message !== "Too big") toast("Upload failed: " + e.message, "error");
  }
});

$("add-gallery-btn").addEventListener("click", () => openGalleryModal(null));

async function loadGallery() {
  const loading = $("gallery-loading"), empty = $("gallery-empty"), grid = $("gallery-grid");
  loading.classList.remove("hidden"); empty.classList.add("hidden"); grid.classList.add("hidden");
  try {
    const snap = await getDocs(query(collection(db, "gallery"), orderBy("order", "asc")));
    loading.classList.add("hidden");
    if (snap.empty) { empty.classList.remove("hidden"); return; }
    grid.innerHTML = snap.docs.map(d => {
      const g = d.data();
      return `<article class="grid-item cursor-pointer" data-id="${d.id}">
        <img class="grid-item-img" src="${esc(g.imageUrl || "")}" alt="${esc(g.title || "")}" loading="lazy" onerror="this.style.display='none'" />
        <div class="grid-item-body">
          <h3 class="font-display font-semibold text-base truncate mb-1">${esc(g.title || "Untitled")}</h3>
          <p class="text-white/40 text-xs">${esc(g.category || "—")} · order ${g.order ?? 0}</p>
        </div>
      </article>`;
    }).join("");
    grid.classList.remove("hidden");
    grid.querySelectorAll(".grid-item").forEach(el => {
      el.addEventListener("click", e => {
        if (el.classList.contains("just-dragged")) { el.classList.remove("just-dragged"); return; }
        const g = snap.docs.find(d => d.id === el.dataset.id);
        if (g) openGalleryModal({ id: g.id, ...g.data() });
      });
    });
    setupSortable("gallery-grid", "gallery");
  } catch (e) {
    loading.classList.add("hidden");
    console.error(e);
    toast("Couldn't load gallery: " + e.message, "error");
  }
}

function openGalleryModal(item) {
  _pendingGalleryImage = null;
  $("gallery-form").reset();
  $("gallery-id").value = item?.id || "";
  $("gallery-title").value = item?.title || "";
  $("gallery-category").value = item?.category || "";
  $("gallery-order").value = item?.order ?? 0;
  $("gallery-modal-title").textContent = item ? "Edit Image" : "Add Gallery Image";
  $("gallery-delete-btn").classList.toggle("hidden", !item);
  $("gallery-upload-status").textContent = "";
  setDropZoneImage("gallery-drop-zone", item?.imageUrl || "");
  $("gallery-form").dataset.existingImagePath = item?.imagePath || "";
  $("gallery-form").dataset.existingImageUrl = item?.imageUrl || "";
  openModal("gallery-modal");
}

$("gallery-form").addEventListener("submit", async e => {
  e.preventDefault();
  const id = $("gallery-id").value;
  const btn = $("gallery-save-btn"); btn.disabled = true; btn.textContent = "Saving…";

  const existingPath = $("gallery-form").dataset.existingImagePath;
  const existingUrl = $("gallery-form").dataset.existingImageUrl;

  const data = {
    title: $("gallery-title").value.trim(),
    category: $("gallery-category").value.trim(),
    order: Number($("gallery-order").value) || 0,
    imageUrl: _pendingGalleryImage?.url || existingUrl || "",
    imagePath: _pendingGalleryImage?.path || existingPath || "",
    updatedAt: serverTimestamp()
  };

  if (!data.imageUrl) { toast("Please upload an image.", "error"); btn.disabled = false; btn.textContent = "Save Image"; return; }

  try {
    if (id) {
      await updateDoc(doc(db, "gallery", id), data);
      if (_pendingGalleryImage && existingPath && existingPath !== _pendingGalleryImage.path) {
        deleteStorageFile(existingPath);
      }
      toast("Image updated.", "success");
    } else {
      data.createdAt = serverTimestamp();
      await addDoc(collection(db, "gallery"), data);
      toast("Image added.", "success");
    }
    closeModal("gallery-modal");
    loadGallery();
    loadDashboard();
  } catch (e) {
    console.error(e);
    toast("Save failed: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save Image";
  }
});

$("gallery-delete-btn").addEventListener("click", async () => {
  const id = $("gallery-id").value;
  if (!id) return;
  if (!(await confirmDialog("Delete this image?", "It will be removed from the site immediately."))) return;
  try {
    const existingPath = $("gallery-form").dataset.existingImagePath;
    await deleteDoc(doc(db, "gallery", id));
    if (existingPath) deleteStorageFile(existingPath);
    toast("Image deleted.", "success");
    closeModal("gallery-modal");
    loadGallery();
    loadDashboard();
  } catch (e) { toast("Delete failed: " + e.message, "error"); }
});

// ---------- Inquiries ----------
let _inquiryFilter = "new";

document.querySelectorAll(".inq-filter").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".inq-filter").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    _inquiryFilter = btn.dataset.filter;
    loadInquiries();
  });
});

function formatDate(ts) {
  if (!ts) return "—";
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

async function loadInquiries() {
  const loading = $("inquiries-loading"), empty = $("inquiries-empty"), list = $("inquiries-list");
  loading.classList.remove("hidden"); empty.classList.add("hidden"); list.classList.add("hidden");
  try {
    let q;
    if (_inquiryFilter === "all") {
      q = query(collection(db, "inquiries"), orderBy("createdAt", "desc"));
    } else {
      q = query(collection(db, "inquiries"), where("status", "==", _inquiryFilter), orderBy("createdAt", "desc"));
    }
    const snap = await getDocs(q);
    loading.classList.add("hidden");
    if (snap.empty) { empty.classList.remove("hidden"); return; }

    list.innerHTML = snap.docs.map(d => {
      const i = d.data();
      const statusBadge = i.status === "new" ? '<span class="badge badge-active">New</span>'
        : i.status === "read" ? '<span class="badge" style="background:rgba(100,181,246,.15);color:#64B5F6">Read</span>'
        : '<span class="badge badge-inactive">Archived</span>';
      return `<article class="card p-5" data-id="${d.id}">
        <div class="flex items-start justify-between gap-4 mb-3 flex-wrap">
          <div class="min-w-0">
            <div class="flex items-center gap-3 mb-1">
              <h3 class="font-display font-semibold text-lg truncate">${esc(i.name || "Unknown")}</h3>
              ${statusBadge}
            </div>
            <p class="text-white/40 text-xs">${esc(formatDate(i.createdAt))} · ${esc(i.projectType || "General inquiry")}</p>
          </div>
          <div class="flex gap-2 flex-wrap">
            ${i.status === "new" ? `<button class="btn btn-ghost !py-2 !px-3 text-xs" data-action="read">Mark Read</button>` : ""}
            ${i.status !== "archived" ? `<button class="btn btn-ghost !py-2 !px-3 text-xs" data-action="archive">Archive</button>` : `<button class="btn btn-ghost !py-2 !px-3 text-xs" data-action="unarchive">Unarchive</button>`}
            <button class="btn btn-danger !py-2 !px-3 text-xs" data-action="delete">Delete</button>
          </div>
        </div>
        <div class="grid sm:grid-cols-2 gap-x-6 gap-y-1 mb-3 text-sm">
          <div><span class="text-white/40">Email:</span> <a class="text-brand hover:underline" href="mailto:${esc(i.email || "")}">${esc(i.email || "—")}</a></div>
          ${i.phone ? `<div><span class="text-white/40">Phone:</span> <a class="text-brand hover:underline" href="tel:${esc(i.phone)}">${esc(i.phone)}</a></div>` : ""}
        </div>
        <div class="text-white/70 text-sm leading-relaxed whitespace-pre-wrap">${esc(i.message || "")}</div>
        <div class="mt-4 flex gap-2">
          <a class="btn btn-primary !py-2 !px-4 text-xs" href="mailto:${esc(i.email || "")}?subject=${encodeURIComponent("Re: Your Fuse Prints inquiry")}">Reply via Email</a>
        </div>
      </article>`;
    }).join("");

    list.classList.remove("hidden");
    list.querySelectorAll("[data-action]").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const article = btn.closest("article");
        const id = article.dataset.id;
        const action = btn.dataset.action;
        btn.disabled = true;
        try {
          if (action === "delete") {
            if (!(await confirmDialog("Delete this inquiry?", "This can't be undone."))) { btn.disabled = false; return; }
            await deleteDoc(doc(db, "inquiries", id));
            toast("Inquiry deleted.", "success");
          } else if (action === "read") {
            await updateDoc(doc(db, "inquiries", id), { status: "read", readAt: serverTimestamp() });
            toast("Marked as read.", "success");
          } else if (action === "archive") {
            await updateDoc(doc(db, "inquiries", id), { status: "archived", archivedAt: serverTimestamp() });
            toast("Archived.", "success");
          } else if (action === "unarchive") {
            await updateDoc(doc(db, "inquiries", id), { status: "read" });
            toast("Unarchived.", "success");
          }
          loadInquiries();
          loadDashboard();
        } catch (err) {
          console.error(err);
          toast("Action failed: " + err.message, "error");
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    loading.classList.add("hidden");
    console.error(e);
    toast("Couldn't load inquiries: " + e.message, "error");
  }
}

// Style the active filter tab
const filterStyle = document.createElement("style");
filterStyle.textContent = `.inq-filter.active{background:rgba(33,150,243,.15);color:#64B5F6;border-color:rgba(33,150,243,.35)}`;
document.head.appendChild(filterStyle);
