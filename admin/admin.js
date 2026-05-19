// Fuse Prints admin panel — Products + Gallery CRUD over Firestore + Storage.
// Auth: Firebase Email/Password. Admin check: doc exists at /admins/{uid}.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
  sendPasswordResetEmail, EmailAuthProvider, reauthenticateWithCredential, updatePassword,
  GoogleAuthProvider, signInWithPopup, browserPopupRedirectResolver
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, doc, getDoc, collection, addDoc, updateDoc, deleteDoc, setDoc,
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
function closeModal(id) {
  const modal = $(id);
  if (!modal) return;
  modal.classList.remove("active");
  // Reset file inputs inside the modal so a stale .click() can't reopen the picker
  modal.querySelectorAll('input[type="file"]').forEach(i => { i.value = ""; });
  // Clear any pending image state when modals are dismissed without saving
  if (id === "product-modal") _pendingProductImage = null;
  if (id === "gallery-modal") _pendingGalleryImage = null;
  if (id === "site-image-modal") _pendingSiteImage = null;
  // If the crop modal is being closed, tear down the cropper instance and reject any pending crop promise
  if (id === "crop-modal") {
    if (_cropper) { _cropper.destroy(); _cropper = null; }
    if (_cropResolver) { _cropResolver.reject(new Error("Cancelled")); _cropResolver = null; }
  }
  // Drop focus from anything inside the modal to prevent stray Enter/click reactivation
  if (document.activeElement && modal.contains(document.activeElement)) document.activeElement.blur();
}

document.querySelectorAll(".modal-close").forEach(btn => {
  btn.addEventListener("click", e => {
    e.preventDefault();
    e.stopPropagation();
    closeModal(btn.dataset.modal);
  });
});
document.querySelectorAll(".modal-bg").forEach(bg => {
  bg.addEventListener("click", e => { if (e.target === bg) closeModal(bg.id); });
});

// Close any open modal on Escape key
document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    document.querySelectorAll(".modal-bg.active").forEach(m => closeModal(m.id));
  }
});

// ----- Image cropper (Cropper.js) -----
let _cropper = null;
let _cropResolver = null;
const MAX_CROPPED_DIMENSION = 1600; // cap output for reasonable file sizes

function openCropper(file, aspectRatio) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) { reject(new Error("Not an image")); return; }
    if (!window.Cropper) { reject(new Error("Cropper not loaded")); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const img = $("crop-image");
      img.src = reader.result;
      $("crop-aspect-hint").textContent = aspectRatio === 1
        ? "Drag, zoom, and reposition. Square crop (1:1) for product cards."
        : "Drag, zoom, and reposition. Wide crop (4:3) for the carousel.";
      openModal("crop-modal");
      // Init cropper after image is in the DOM and visible
      setTimeout(() => {
        if (_cropper) _cropper.destroy();
        _cropper = new window.Cropper(img, {
          aspectRatio,
          viewMode: 1,
          dragMode: "move",
          autoCropArea: 0.95,
          background: false,
          movable: true,
          zoomable: true,
          rotatable: true,
          scalable: false,
          responsive: true,
          checkOrientation: true
        });
      }, 100);
      _cropResolver = { resolve, reject, originalName: file.name, originalType: file.type };
    };
    reader.onerror = () => reject(new Error("Couldn't read file"));
    reader.readAsDataURL(file);
  });
}

$("crop-zoom-in").addEventListener("click", () => _cropper?.zoom(0.1));
$("crop-zoom-out").addEventListener("click", () => _cropper?.zoom(-0.1));
$("crop-rotate-left").addEventListener("click", () => _cropper?.rotate(-90));
$("crop-rotate-right").addEventListener("click", () => _cropper?.rotate(90));
$("crop-reset").addEventListener("click", () => _cropper?.reset());

// Pull an existing image URL back into the cropper. Used by the "Adjust crop"
// buttons so admins can re-crop without re-uploading. Returns a File or null.
async function recropExistingImage(imageUrl, aspectRatio) {
  try {
    // Try a direct fetch first (works for Firebase Storage uploads)
    let blob;
    try {
      const res = await fetch(imageUrl, { mode: "cors" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      blob = await res.blob();
    } catch (corsErr) {
      // CORS-blocked source (common for WordPress CDN images) — render the image
      // into a canvas via crossOrigin=anonymous, then export to a blob. This works
      // for any host that allows hotlinking with crossorigin headers.
      blob = await new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          const c = document.createElement("canvas");
          c.width = img.naturalWidth; c.height = img.naturalHeight;
          c.getContext("2d").drawImage(img, 0, 0);
          c.toBlob(b => b ? resolve(b) : reject(new Error("Canvas export failed")), "image/jpeg", 0.95);
        };
        img.onerror = () => reject(new Error("Couldn't load image — CORS blocked"));
        img.src = imageUrl;
      });
    }
    const ext = (blob.type.split("/")[1] || "jpg").replace("jpeg", "jpg");
    const file = new File([blob], `recrop.${ext}`, { type: blob.type || "image/jpeg" });
    return await openCropper(file, aspectRatio);
  } catch (e) {
    if (e.message === "Cancelled") return null;
    console.error(e);
    toast("Couldn't load image for re-crop: " + e.message, "error");
    return null;
  }
}

$("crop-apply-btn").addEventListener("click", () => {
  if (!_cropper || !_cropResolver) return;
  const canvas = _cropper.getCroppedCanvas({
    maxWidth: MAX_CROPPED_DIMENSION,
    maxHeight: MAX_CROPPED_DIMENSION,
    imageSmoothingEnabled: true,
    imageSmoothingQuality: "high"
  });
  const { resolve, originalName, originalType } = _cropResolver;
  const outType = originalType === "image/png" ? "image/png" : "image/jpeg";
  canvas.toBlob(blob => {
    if (!blob) { closeCropper(); return; }
    // Repackage as a File so the rest of the upload flow keeps working
    const ext = outType === "image/png" ? "png" : "jpg";
    const base = (originalName || "upload").replace(/\.[^.]+$/, "");
    const cropped = new File([blob], `${base}.${ext}`, { type: outType });
    if (_cropper) { _cropper.destroy(); _cropper = null; }
    _cropResolver = null;
    closeModal("crop-modal");
    resolve(cropped);
  }, outType, 0.92);
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
    if (tab === "services") loadServices();
    if (tab === "site-images") loadSiteImages();
    if (tab === "dashboard") { loadDashboard(); loadInquiries(); }
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
    loadInquiries();
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
    // inbox-badge was removed when the standalone Inquiries tab was consolidated
    // into the dashboard — guard against stale references.
    const badge = $("inbox-badge");
    if (badge) {
      if (inqSnap.size > 0) { badge.textContent = inqSnap.size; badge.classList.remove("hidden"); }
      else badge.classList.add("hidden");
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
    const cropped = await openCropper(file, 1); // 1:1 square for product cards
    const res = await uploadImage(cropped, "products", status);
    _pendingProductImage = res;
    setDropZoneImage("product-drop-zone", res.url);
  } catch (e) {
    if (e.message === "Cancelled") return; // user closed crop modal
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
  $("product-recrop-btn").style.display = product?.imageUrl ? "inline-flex" : "none";
  openModal("product-modal");
}

$("product-recrop-btn").addEventListener("click", async () => {
  const url = $("product-form").dataset.existingImageUrl;
  if (!url) return;
  const cropped = await recropExistingImage(url, 1);
  if (!cropped) return;
  const status = $("product-upload-status");
  try {
    const res = await uploadImage(cropped, "products", status);
    _pendingProductImage = res;
    setDropZoneImage("product-drop-zone", res.url);
  } catch (e) {
    console.error(e);
    toast("Upload failed: " + e.message, "error");
  }
});

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
    const cropped = await openCropper(file, 4 / 3); // 4:3 wide for carousel cards
    const res = await uploadImage(cropped, "gallery", status);
    _pendingGalleryImage = res;
    setDropZoneImage("gallery-drop-zone", res.url);
  } catch (e) {
    if (e.message === "Cancelled") return;
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
  $("gallery-recrop-btn").style.display = item?.imageUrl ? "inline-flex" : "none";
  openModal("gallery-modal");
}

$("gallery-recrop-btn").addEventListener("click", async () => {
  const url = $("gallery-form").dataset.existingImageUrl;
  if (!url) return;
  const cropped = await recropExistingImage(url, 4 / 3);
  if (!cropped) return;
  const status = $("gallery-upload-status");
  try {
    const res = await uploadImage(cropped, "gallery", status);
    _pendingGalleryImage = res;
    setDropZoneImage("gallery-drop-zone", res.url);
  } catch (e) {
    console.error(e);
    toast("Upload failed: " + e.message, "error");
  }
});

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

// ---------- Service Pages ----------
// Default services seeded on first admin load so Chris's 7 main pages exist.
// After that, services are fully Firestore-driven — Chris can add, edit, delete any service.
const DEFAULT_SERVICES = [
  { slug: "banners",                name: "Banners",                order: 1 },
  { slug: "custom-signs",           name: "Custom Signs",           order: 2 },
  { slug: "custom-awards-plaques",  name: "Custom Awards & Plaques", order: 3 },
  { slug: "tradeshow-displays",     name: "Tradeshow Displays",     order: 4 },
  { slug: "stickers-decals",        name: "Stickers & Decals",      order: 5 },
  { slug: "wall-window-decals",     name: "Wall & Window Decals",   order: 6 },
  { slug: "home-decor-gifts",       name: "Home Décor & Gifts",     order: 7 }
];
const RESERVED_SLUGS = new Set(["admin","privacy","terms","assets","service.html","index.html","404.html","robots.txt","sitemap.xml","api","favicon.ico"]);
let _allServiceDocs = []; // [{slug, name, order, ...}] populated on loadServices()

// Common Lucide icon names admins can pick from for capabilities + use cases
const ICON_OPTIONS = [
  "square","maximize-2","maximize","shield","wind","zap","palette","truck","feather","tool",
  "scissors","layers","sun","anchor","pen-tool","crosshair","gem","edit-3","package","image","layout",
  "rotate-ccw","box","eye-off","check-circle","home","droplets","sparkles","calendar","store","briefcase",
  "building","flag","megaphone","heart","award","trophy","graduation-cap","star","gift","baby","cake",
  "map-pin","shopping-bag","shopping-cart","coffee","utensils","dumbbell","school"
];

let _currentServiceImages = [];   // [{ imageUrl, imagePath, title, order }]
let _currentServiceFeatures = []; // [{ icon, title, description }]
let _currentServiceMaterials = []; // [string]
let _currentServiceUseCases = []; // [{ icon, title, description }]
let _currentServiceFaqs = [];     // [{ q, a }]
let _currentServiceRelated = []; // [slug]

// Modal section-tab switching (delegated)
document.addEventListener("click", e => {
  const t = e.target.closest(".svc-section-tab");
  if (!t) return;
  const section = t.dataset.section;
  document.querySelectorAll(".svc-section-tab").forEach(b => b.classList.toggle("active", b.dataset.section === section));
  document.querySelectorAll(".svc-section").forEach(s => s.classList.toggle("hidden", s.dataset.section !== section));
});

async function loadServices() {
  const loading = $("services-loading"), grid = $("services-grid"), empty = $("services-empty");
  loading.classList.remove("hidden"); grid.classList.add("hidden"); empty.classList.add("hidden");
  try {
    // Fetch all service docs from Firestore
    const snap = await getDocs(query(collection(db, "services"), orderBy("order", "asc")));
    let docs = snap.docs.map(d => ({ slug: d.id, ...d.data() }));

    // Seed the 7 default services on first admin load if missing
    const seenSlugs = new Set(docs.map(d => d.slug));
    const missing = DEFAULT_SERVICES.filter(s => !seenSlugs.has(s.slug));
    if (missing.length) {
      for (const m of missing) {
        await setDoc(doc(db, "services", m.slug), {
          slug: m.slug, name: m.name, order: m.order,
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        }, { merge: true });
        docs.push({ slug: m.slug, name: m.name, order: m.order });
      }
      docs.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
    }
    _allServiceDocs = docs;

    loading.classList.add("hidden");
    if (!docs.length) { empty.classList.remove("hidden"); return; }

    grid.innerHTML = docs.map(d => {
      const imgCount = Array.isArray(d.images) ? d.images.length : 0;
      const cover = imgCount ? d.images[0].imageUrl : "";
      const isDefault = DEFAULT_SERVICES.some(def => def.slug === d.slug);
      return `<article class="grid-item cursor-pointer" data-slug="${esc(d.slug)}" style="cursor:pointer">
        <div style="aspect-ratio:1/1;background:#0a0a0a;display:flex;align-items:center;justify-content:center;overflow:hidden">
          ${cover ? `<img class="grid-item-img" src="${esc(cover)}" alt="${esc(d.name || d.slug)}" loading="lazy" onerror="this.style.display='none'" />` : `<svg class="w-12 h-12 text-white/15" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159M21 12V6a1.5 1.5 0 00-1.5-1.5H4.5A1.5 1.5 0 003 6v12a1.5 1.5 0 001.5 1.5h12.75"/></svg>`}
        </div>
        <div class="grid-item-body">
          <h3 class="font-display font-semibold text-base mb-1">${esc(d.name || d.slug)}</h3>
          <p class="text-white/40 text-xs font-mono mb-2">/${esc(d.slug)}</p>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="badge ${imgCount ? "badge-active" : "badge-inactive"}">${imgCount} image${imgCount === 1 ? "" : "s"}</span>
            <span class="badge ${d.heading ? "badge-active" : "badge-inactive"}">${d.heading ? "Content" : "Default"}</span>
            ${isDefault ? '' : '<span class="badge" style="background:rgba(100,181,246,.15);color:#64B5F6">Custom</span>'}
          </div>
        </div>
      </article>`;
    }).join("");
    grid.classList.remove("hidden");
    grid.querySelectorAll(".grid-item").forEach(el => {
      el.addEventListener("click", () => {
        const item = docs.find(d => d.slug === el.dataset.slug);
        if (item) openServiceModal({ slug: item.slug, name: item.name || item.slug, order: item.order ?? 99, isExisting: true }, item);
      });
    });
    // Drag-to-reorder
    setupSortable("services-grid", "services");
  } catch (e) {
    loading.classList.add("hidden");
    console.error(e);
    toast("Couldn't load services: " + e.message, "error");
  }
}

// "+ New Service" button — opens a blank modal for a brand-new service
$("add-service-btn").addEventListener("click", () => {
  openServiceModal({ slug: "", name: "", order: (_allServiceDocs?.length || 0) + 1, isExisting: false }, null);
});

function renderServiceImagesGrid() {
  const grid = $("service-images-grid");
  if (!_currentServiceImages.length) {
    grid.innerHTML = `<p class="col-span-full text-white/30 text-xs text-center py-6" id="service-images-empty">No images yet. Click + Add Image to upload.</p>`;
    return;
  }
  grid.innerHTML = _currentServiceImages.map((img, i) => `
    <div class="grid-item" data-idx="${i}" style="cursor:grab">
      <img class="grid-item-img" src="${esc(img.imageUrl)}" alt="${esc(img.title || "")}" loading="lazy" />
      <div class="grid-item-body" style="padding:8px 10px">
        <div class="flex items-center justify-between gap-2">
          <span class="text-white/40 text-xs">#${i + 1}</span>
          <button type="button" data-action="delete-img" data-idx="${i}" class="text-red-400 hover:text-red-300 text-xs font-semibold">Remove</button>
        </div>
      </div>
    </div>
  `).join("");
  // Wire remove buttons
  grid.querySelectorAll('[data-action="delete-img"]').forEach(btn => {
    btn.addEventListener("click", e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.idx);
      const removed = _currentServiceImages.splice(idx, 1)[0];
      if (removed?.imagePath) deleteStorageFile(removed.imagePath);
      renderServiceImagesGrid();
    });
  });
  // Sortable for reorder (local; only persisted on Save)
  if (window.Sortable) {
    if (grid._sortable) grid._sortable.destroy();
    grid._sortable = window.Sortable.create(grid, {
      animation: 180,
      ghostClass: "sortable-ghost",
      chosenClass: "sortable-chosen",
      dragClass: "sortable-drag",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const moved = _currentServiceImages.splice(evt.oldIndex, 1)[0];
        _currentServiceImages.splice(evt.newIndex, 0, moved);
        renderServiceImagesGrid();
      }
    });
  }
}

// ----- Repeatable list renderers -----
function iconSelectHtml(currentIcon) {
  return `<select class="input" data-field="icon">${ICON_OPTIONS.map(n => `<option value="${esc(n)}"${n === currentIcon ? " selected" : ""}>${esc(n)}</option>`).join("")}</select>`;
}

function renderFeaturesList() {
  const el = $("service-features-list");
  if (!_currentServiceFeatures.length) {
    el.innerHTML = `<p class="text-white/30 text-xs text-center py-6">No capabilities yet. Click + Add Capability.</p>`;
    return;
  }
  el.innerHTML = _currentServiceFeatures.map((f, i) => `
    <div class="item-row" data-idx="${i}">
      <div class="item-grid cols-2">
        ${iconSelectHtml(f.icon || "square")}
        <input type="text" class="input" data-field="title" placeholder="Title" value="${esc(f.title || "")}" />
      </div>
      <textarea class="input mt-2" rows="2" data-field="description" placeholder="Short description">${esc(f.description || "")}</textarea>
      <div class="item-actions">
        <span class="item-handle text-xs">⋮⋮ drag to reorder</span>
        <button type="button" class="btn-remove" data-action="remove-feature">Remove</button>
      </div>
    </div>
  `).join("");
  wireRepeatableRows(el, _currentServiceFeatures, renderFeaturesList);
}

function renderMaterialsList() {
  const el = $("service-materials-list");
  if (!_currentServiceMaterials.length) {
    el.innerHTML = `<p class="text-white/30 text-xs text-center py-6">No materials yet. Click + Add Material.</p>`;
    return;
  }
  el.innerHTML = _currentServiceMaterials.map((m, i) => `
    <div class="item-row flex items-center gap-3" data-idx="${i}">
      <span class="item-handle text-xs shrink-0">⋮⋮</span>
      <input type="text" class="input flex-1" data-field="value" placeholder="e.g. 13oz Vinyl" value="${esc(m)}" />
      <button type="button" class="btn-remove" data-action="remove-material">Remove</button>
    </div>
  `).join("");
  // Wire inputs (string list)
  el.querySelectorAll(".item-row").forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelector('[data-field="value"]').addEventListener("input", e => { _currentServiceMaterials[idx] = e.target.value; });
    row.querySelector('[data-action="remove-material"]').addEventListener("click", () => {
      _currentServiceMaterials.splice(idx, 1); renderMaterialsList();
    });
  });
  if (window.Sortable) {
    if (el._sortable) el._sortable.destroy();
    el._sortable = window.Sortable.create(el, {
      animation: 180, handle: ".item-handle", ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const moved = _currentServiceMaterials.splice(evt.oldIndex, 1)[0];
        _currentServiceMaterials.splice(evt.newIndex, 0, moved);
        renderMaterialsList();
      }
    });
  }
}

function renderUseCasesList() {
  const el = $("service-usecases-list");
  if (!_currentServiceUseCases.length) {
    el.innerHTML = `<p class="text-white/30 text-xs text-center py-6">No use cases yet. Click + Add Use Case.</p>`;
    return;
  }
  el.innerHTML = _currentServiceUseCases.map((u, i) => `
    <div class="item-row" data-idx="${i}">
      <div class="item-grid cols-2">
        ${iconSelectHtml(u.icon || "square")}
        <input type="text" class="input" data-field="title" placeholder="Title (e.g. Events & Weddings)" value="${esc(u.title || "")}" />
      </div>
      <textarea class="input mt-2" rows="2" data-field="description" placeholder="One-sentence description">${esc(u.description || "")}</textarea>
      <div class="item-actions">
        <span class="item-handle text-xs">⋮⋮ drag to reorder</span>
        <button type="button" class="btn-remove" data-action="remove-usecase">Remove</button>
      </div>
    </div>
  `).join("");
  wireRepeatableRows(el, _currentServiceUseCases, renderUseCasesList, "remove-usecase");
}

function renderFaqsList() {
  const el = $("service-faqs-list");
  if (!_currentServiceFaqs.length) {
    el.innerHTML = `<p class="text-white/30 text-xs text-center py-6">No FAQs yet. Click + Add FAQ.</p>`;
    return;
  }
  el.innerHTML = _currentServiceFaqs.map((f, i) => `
    <div class="item-row" data-idx="${i}">
      <input type="text" class="input" data-field="q" placeholder="Question" value="${esc(f.q || "")}" />
      <textarea class="input mt-2" rows="3" data-field="a" placeholder="Answer">${esc(f.a || "")}</textarea>
      <div class="item-actions">
        <span class="item-handle text-xs">⋮⋮ drag to reorder</span>
        <button type="button" class="btn-remove" data-action="remove-faq">Remove</button>
      </div>
    </div>
  `).join("");
  // Custom wiring (q/a, not icon/title/description)
  el.querySelectorAll(".item-row").forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelectorAll("[data-field]").forEach(input => {
      input.addEventListener("input", e => { _currentServiceFaqs[idx][e.target.dataset.field] = e.target.value; });
    });
    row.querySelector('[data-action="remove-faq"]').addEventListener("click", () => {
      _currentServiceFaqs.splice(idx, 1); renderFaqsList();
    });
  });
  if (window.Sortable) {
    if (el._sortable) el._sortable.destroy();
    el._sortable = window.Sortable.create(el, {
      animation: 180, handle: ".item-handle", ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const moved = _currentServiceFaqs.splice(evt.oldIndex, 1)[0];
        _currentServiceFaqs.splice(evt.newIndex, 0, moved);
        renderFaqsList();
      }
    });
  }
}

function renderRelatedPicker(currentSlug) {
  const el = $("service-related-list");
  el.innerHTML = SERVICE_SLOTS.filter(s => s.slug !== currentSlug).map(s => {
    const checked = _currentServiceRelated.includes(s.slug);
    return `<label class="related-pick ${checked ? "selected" : ""}">
      <input type="checkbox" value="${esc(s.slug)}" ${checked ? "checked" : ""} />
      <span>${esc(s.name)}</span>
    </label>`;
  }).join("");
  el.querySelectorAll("input[type=checkbox]").forEach(cb => {
    cb.addEventListener("change", e => {
      const v = e.target.value;
      if (e.target.checked) {
        if (!_currentServiceRelated.includes(v)) _currentServiceRelated.push(v);
      } else {
        _currentServiceRelated = _currentServiceRelated.filter(x => x !== v);
      }
      e.target.closest(".related-pick").classList.toggle("selected", e.target.checked);
    });
  });
}

// Shared wiring for icon/title/description-shaped row lists
function wireRepeatableRows(el, list, rerender, removeAction) {
  removeAction = removeAction || el.id.includes("features") ? "remove-feature" : removeAction;
  el.querySelectorAll(".item-row").forEach(row => {
    const idx = Number(row.dataset.idx);
    row.querySelectorAll("[data-field]").forEach(input => {
      input.addEventListener("input", e => { list[idx][e.target.dataset.field] = e.target.value; });
    });
    const rem = row.querySelector('[data-action="remove-feature"],[data-action="remove-usecase"]');
    if (rem) rem.addEventListener("click", () => { list.splice(idx, 1); rerender(); });
  });
  if (window.Sortable) {
    if (el._sortable) el._sortable.destroy();
    el._sortable = window.Sortable.create(el, {
      animation: 180, handle: ".item-handle", ghostClass: "sortable-ghost", chosenClass: "sortable-chosen",
      onEnd: (evt) => {
        if (evt.oldIndex === evt.newIndex) return;
        const moved = list.splice(evt.oldIndex, 1)[0];
        list.splice(evt.newIndex, 0, moved);
        rerender();
      }
    });
  }
}

// "Add" buttons
$("service-add-feature-btn").addEventListener("click", () => {
  _currentServiceFeatures.push({ icon: "square", title: "", description: "" });
  renderFeaturesList();
});
$("service-add-material-btn").addEventListener("click", () => {
  _currentServiceMaterials.push("");
  renderMaterialsList();
});
$("service-add-usecase-btn").addEventListener("click", () => {
  _currentServiceUseCases.push({ icon: "square", title: "", description: "" });
  renderUseCasesList();
});
$("service-add-faq-btn").addEventListener("click", () => {
  _currentServiceFaqs.push({ q: "", a: "" });
  renderFaqsList();
});

function slugify(s) {
  return String(s || "").toLowerCase().trim().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-").slice(0, 60);
}

function openServiceModal(slot, item) {
  $("service-form").reset();
  // Reset to first tab
  document.querySelectorAll(".svc-section-tab").forEach(b => b.classList.toggle("active", b.dataset.section === "content"));
  document.querySelectorAll(".svc-section").forEach(s => s.classList.toggle("hidden", s.dataset.section !== "content"));

  const isExisting = !!slot.isExisting;
  const slug = slot.slug || "";
  const name = slot.name || "";

  $("service-slug").value = slug;
  $("service-slug-input").value = slug;
  $("service-slug-input").readOnly = isExisting;
  $("service-slug-input").classList.toggle("opacity-60", isExisting);
  $("service-name").value = name;
  $("service-modal-title").textContent = isExisting ? `Edit: ${name || slug}` : "New Service";
  $("service-modal-url").textContent = isExisting ? `fuseprints.com/${slug}` : "fuseprints.com/your-slug";
  $("service-view-link").href = isExisting ? `/${slug}` : "#";
  $("service-view-link").style.display = isExisting ? "inline-flex" : "none";
  $("service-delete-btn").classList.toggle("hidden", !isExisting || isDefaultService(slug));

  $("service-heading").value = item?.heading || (name ? `${name} — Bradford, PA` : "");
  $("service-eyebrow").value = item?.eyebrow || (name ? `${name} · Bradford, PA` : "");
  $("service-subheading").value = item?.subheading || "";
  $("service-description").value = item?.description || "";
  $("service-seo-title").value = item?.seoTitle || (name ? `${name} in Bradford, PA | Fuse Prints` : "");
  $("service-seo-desc").value = item?.seoDescription || "";
  $("service-image-upload-status").textContent = "";

  _currentServiceImages = Array.isArray(item?.images) ? item.images.map(i => ({ ...i })) : [];
  _currentServiceImages.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  _currentServiceFeatures = Array.isArray(item?.features) ? item.features.map(f => ({ ...f })) : [];
  _currentServiceMaterials = Array.isArray(item?.materials) ? [...item.materials] : [];
  _currentServiceUseCases = Array.isArray(item?.useCases) ? item.useCases.map(u => ({ ...u })) : [];
  _currentServiceFaqs = Array.isArray(item?.faqs) ? item.faqs.map(f => ({ q: f.q || f.question || "", a: f.a || f.answer || "" })) : [];
  _currentServiceRelated = Array.isArray(item?.relatedServices) ? [...item.relatedServices] : [];

  renderServiceImagesGrid();
  renderFeaturesList();
  renderMaterialsList();
  renderUseCasesList();
  renderFaqsList();
  renderRelatedPicker(slug);

  // Auto-slug from name when creating a new service
  if (!isExisting) {
    $("service-name").oninput = e => {
      if (!$("service-slug-input").dataset.userEdited) {
        $("service-slug-input").value = slugify(e.target.value);
      }
    };
    $("service-slug-input").oninput = e => {
      e.target.dataset.userEdited = "true";
      e.target.value = slugify(e.target.value);
    };
  } else {
    $("service-name").oninput = null;
    $("service-slug-input").oninput = null;
  }

  openModal("service-modal");
}

function isDefaultService(slug) {
  return DEFAULT_SERVICES.some(d => d.slug === slug);
}

$("service-add-image-btn").addEventListener("click", () => $("service-image-input").click());

$("service-image-input").addEventListener("change", async e => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const status = $("service-image-upload-status");
  try {
    const cropped = await openCropper(file, 4 / 3); // matches gallery aspect
    const res = await uploadImage(cropped, "services", status);
    _currentServiceImages.push({
      imageUrl: res.url,
      imagePath: res.path,
      title: "",
      order: _currentServiceImages.length
    });
    renderServiceImagesGrid();
  } catch (err) {
    if (err.message === "Cancelled") return;
    console.error(err);
    if (err.message !== "Not an image" && err.message !== "Too big") toast("Upload failed: " + err.message, "error");
  }
});

$("service-form").addEventListener("submit", async e => {
  e.preventDefault();
  const existingSlug = $("service-slug").value;
  const slugInput = slugify($("service-slug-input").value);
  const name = $("service-name").value.trim();
  const btn = $("service-save-btn"); btn.disabled = true; btn.textContent = "Saving…";

  const restore = () => { btn.disabled = false; btn.textContent = "Save Service"; };

  if (!name) { toast("Service name is required.", "error"); restore(); return; }
  if (!slugInput) { toast("URL slug is required.", "error"); restore(); return; }
  if (RESERVED_SLUGS.has(slugInput)) { toast(`"${slugInput}" is a reserved path. Pick another slug.`, "error"); restore(); return; }

  const slug = existingSlug || slugInput;
  const isNew = !existingSlug;

  // For new services, make sure the slug isn't already taken
  if (isNew) {
    try {
      const existing = await getDoc(doc(db, "services", slug));
      if (existing.exists()) { toast(`Slug "${slug}" is already used by another service.`, "error"); restore(); return; }
    } catch (err) { console.warn(err); }
  }

  const existing = _allServiceDocs.find(d => d.slug === slug);
  const order = existing?.order ?? (_allServiceDocs.length + 1);

  const data = {
    slug,
    name,
    order,
    heading: $("service-heading").value.trim(),
    eyebrow: $("service-eyebrow").value.trim(),
    subheading: $("service-subheading").value.trim(),
    description: $("service-description").value.trim(),
    seoTitle: $("service-seo-title").value.trim(),
    seoDescription: $("service-seo-desc").value.trim(),
    images: _currentServiceImages.map((img, i) => ({
      imageUrl: img.imageUrl,
      imagePath: img.imagePath || "",
      title: img.title || "",
      order: i
    })),
    features: _currentServiceFeatures
      .filter(f => f.title?.trim() || f.description?.trim())
      .map(f => ({ icon: f.icon || "square", title: (f.title || "").trim(), description: (f.description || "").trim() })),
    materials: _currentServiceMaterials.map(m => (m || "").trim()).filter(Boolean),
    useCases: _currentServiceUseCases
      .filter(u => u.title?.trim() || u.description?.trim())
      .map(u => ({ icon: u.icon || "square", title: (u.title || "").trim(), description: (u.description || "").trim() })),
    faqs: _currentServiceFaqs
      .filter(f => f.q?.trim() || f.a?.trim())
      .map(f => ({ q: (f.q || "").trim(), a: (f.a || "").trim() })),
    relatedServices: _currentServiceRelated.filter(s => s !== slug),
    updatedAt: serverTimestamp()
  };

  try {
    const payload = isNew ? { ...data, createdAt: serverTimestamp() } : data;
    await setDoc(doc(db, "services", slug), payload, { merge: true });
    toast(isNew ? `Service "${name}" created. Live at /${slug}.` : "Service page saved.", "success");
    closeModal("service-modal");
    loadServices();
  } catch (err) {
    console.error(err);
    toast("Save failed: " + err.message, "error");
  } finally {
    restore();
  }
});

// Delete service (custom services only; the 7 defaults are protected)
$("service-delete-btn").addEventListener("click", async () => {
  const slug = $("service-slug").value;
  if (!slug) return;
  if (isDefaultService(slug)) {
    toast("Default services can't be deleted. You can leave them empty though.", "error");
    return;
  }
  const ok = await confirmDialog(
    "Delete this service?",
    `The page at /${slug} will be removed and any uploaded images will be unlinked. This can't be undone.`
  );
  if (!ok) return;
  try {
    // Delete uploaded images from Storage too
    _currentServiceImages.forEach(img => { if (img.imagePath) deleteStorageFile(img.imagePath); });
    await deleteDoc(doc(db, "services", slug));
    toast("Service deleted.", "success");
    closeModal("service-modal");
    loadServices();
  } catch (err) {
    console.error(err);
    toast("Delete failed: " + err.message, "error");
  }
});

// ---------- Site Images (single named slots: about-card, services-feature, etsy-bg, cta-bg) ----------
const SITE_IMAGE_SLOTS = [
  { key: "about-card",       label: "About — Bento Image",       description: "The lifestyle photo in the About bento grid (lower right cell).",          aspect: 1 },
  { key: "services-feature", label: "Services — Feature Image",  description: "The sticky 4:5 image next to the services list on desktop.",                 aspect: 4 / 5 },
  { key: "etsy-bg",          label: "Etsy Section — Background", description: "Full-bleed image behind the Etsy Collection section (overlay sits on top).", aspect: 16 / 9 },
  { key: "cta-bg",           label: "Ready CTA — Background",    description: "Full-bleed image behind the 'Ready to Print Something Bold?' CTA.",           aspect: 16 / 9 }
];
let _pendingSiteImage = null;
let _currentSiteImageSlot = null;

setupDropZone("site-image-drop-zone", "site-image-input", async file => {
  const status = $("site-image-upload-status");
  try {
    const aspect = _currentSiteImageSlot?.aspect ?? 1;
    const cropped = await openCropper(file, aspect);
    const res = await uploadImage(cropped, "site-images", status);
    _pendingSiteImage = res;
    setDropZoneImage("site-image-drop-zone", res.url);
  } catch (e) {
    if (e.message === "Cancelled") return;
    console.error(e);
    if (e.message !== "Not an image" && e.message !== "Too big") toast("Upload failed: " + e.message, "error");
  }
});

async function loadSiteImages() {
  const loading = $("site-images-loading"), grid = $("site-images-grid");
  loading.classList.remove("hidden"); grid.classList.add("hidden");
  try {
    const docs = await Promise.all(SITE_IMAGE_SLOTS.map(async slot => {
      const snap = await getDoc(doc(db, "siteImages", slot.key));
      return { slot, data: snap.exists() ? snap.data() : null };
    }));
    loading.classList.add("hidden");
    grid.innerHTML = docs.map(({ slot, data }) => `
      <article class="grid-item" data-key="${slot.key}" style="cursor:pointer">
        <img class="grid-item-img" src="${esc(data?.imageUrl || "")}" alt="${esc(slot.label)}" loading="lazy" onerror="this.style.display='none'" />
        <div class="grid-item-body">
          <h3 class="font-display font-semibold text-base mb-1">${esc(slot.label)}</h3>
          <p class="text-white/40 text-xs leading-relaxed">${esc(slot.description)}</p>
        </div>
      </article>
    `).join("");
    grid.classList.remove("hidden");
    grid.querySelectorAll(".grid-item").forEach(el => {
      el.addEventListener("click", () => {
        const slot = SITE_IMAGE_SLOTS.find(s => s.key === el.dataset.key);
        const item = docs.find(d => d.slot.key === el.dataset.key)?.data;
        if (slot) openSiteImageModal(slot, item);
      });
    });
  } catch (e) {
    loading.classList.add("hidden");
    console.error(e);
    toast("Couldn't load site images: " + e.message, "error");
  }
}

function openSiteImageModal(slot, item) {
  _pendingSiteImage = null;
  _currentSiteImageSlot = slot;
  $("site-image-form").reset();
  $("site-image-key").value = slot.key;
  $("site-image-modal-title").textContent = `Edit: ${slot.label}`;
  $("site-image-modal-desc").textContent = slot.description;
  $("site-image-upload-status").textContent = "";
  setDropZoneImage("site-image-drop-zone", item?.imageUrl || "");
  $("site-image-form").dataset.existingImagePath = item?.imagePath || "";
  $("site-image-form").dataset.existingImageUrl = item?.imageUrl || "";
  $("site-image-recrop-btn").style.display = item?.imageUrl ? "inline-flex" : "none";
  openModal("site-image-modal");
}

$("site-image-recrop-btn").addEventListener("click", async () => {
  const url = $("site-image-form").dataset.existingImageUrl;
  if (!url || !_currentSiteImageSlot) return;
  const cropped = await recropExistingImage(url, _currentSiteImageSlot.aspect);
  if (!cropped) return;
  const status = $("site-image-upload-status");
  try {
    const res = await uploadImage(cropped, "site-images", status);
    _pendingSiteImage = res;
    setDropZoneImage("site-image-drop-zone", res.url);
  } catch (e) {
    console.error(e);
    toast("Upload failed: " + e.message, "error");
  }
});

$("site-image-form").addEventListener("submit", async e => {
  e.preventDefault();
  const key = $("site-image-key").value;
  if (!key) return;
  const btn = $("site-image-save-btn"); btn.disabled = true; btn.textContent = "Saving…";
  const existingPath = $("site-image-form").dataset.existingImagePath;
  const existingUrl = $("site-image-form").dataset.existingImageUrl;
  const data = {
    imageUrl: _pendingSiteImage?.url || existingUrl || "",
    imagePath: _pendingSiteImage?.path || existingPath || "",
    updatedAt: serverTimestamp()
  };
  if (!data.imageUrl) { toast("Please upload an image.", "error"); btn.disabled = false; btn.textContent = "Save Image"; return; }
  try {
    // setDoc semantics via updateDoc fallback — since these are keyed slots, use the key as doc id
    // Upsert by slot key (about-card, services-feature, etc.)
    await setDoc(doc(db, "siteImages", key), { ...data, createdAt: serverTimestamp() }, { merge: true });
    if (_pendingSiteImage && existingPath && existingPath !== _pendingSiteImage.path) {
      deleteStorageFile(existingPath);
    }
    toast("Image updated.", "success");
    closeModal("site-image-modal");
    loadSiteImages();
  } catch (e) {
    console.error(e);
    toast("Save failed: " + e.message, "error");
  } finally {
    btn.disabled = false; btn.textContent = "Save Image";
  }
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
        <div class="mt-4 flex gap-2 flex-wrap">
          <a class="btn btn-primary !py-2 !px-4 text-xs" target="_blank" rel="noopener noreferrer" href="https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(i.email || "")}&su=${encodeURIComponent("Re: Your Fuse Prints inquiry")}&body=${encodeURIComponent("Hi " + (i.name || "there") + ",\n\nThanks for reaching out — ")}">Reply in Gmail</a>
          <a class="btn btn-ghost !py-2 !px-4 text-xs" href="mailto:${esc(i.email || "")}?subject=${encodeURIComponent("Re: Your Fuse Prints inquiry")}">Open in Mail App</a>
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
