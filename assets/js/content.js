// Public site content loader — reads products + gallery from Firestore.
// Falls back silently if Firebase isn't configured or empty.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import { getFirestore, collection, query, where, orderBy, getDocs, addDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
import { firebaseConfig, isConfigured } from "./firebase-config.js";

let _db = null;
function db() {
  if (_db) return _db;
  if (!isConfigured()) return null;
  try {
    const app = initializeApp(firebaseConfig);
    _db = getFirestore(app);
    return _db;
  } catch (e) {
    console.warn("Firebase init failed:", e);
    return null;
  }
}

export async function fetchProducts({ featuredOnly = false } = {}) {
  const d = db();
  if (!d) return [];
  try {
    const snap = await getDocs(query(
      collection(d, "products"),
      where("active", "==", true),
      orderBy("order", "asc")
    ));
    const items = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    return featuredOnly ? items.filter(p => p.featured === true) : items;
  } catch (e) {
    console.warn("fetchProducts failed:", e);
    return [];
  }
}

export async function submitInquiry(data) {
  const d = db();
  if (!d) throw new Error("offline");
  // Only include fields we want stored — never persist unknown keys
  const payload = {
    name: String(data.name || "").slice(0, 200),
    email: String(data.email || "").slice(0, 200),
    phone: String(data.phone || "").slice(0, 50),
    projectType: String(data.projectType || "").slice(0, 100),
    message: String(data.message || "").slice(0, 5000),
    status: "new",
    source: "website-contact-form",
    createdAt: serverTimestamp()
  };
  return addDoc(collection(d, "inquiries"), payload);
}

export async function fetchSiteImages() {
  const d = db();
  if (!d) return {};
  try {
    const snap = await getDocs(collection(d, "siteImages"));
    const out = {};
    snap.docs.forEach(doc => { out[doc.id] = doc.data(); });
    return out;
  } catch (e) {
    console.warn("fetchSiteImages failed:", e);
    return {};
  }
}

export async function fetchHero() {
  const d = db();
  if (!d) return [];
  try {
    const snap = await getDocs(query(collection(d, "hero"), orderBy("order", "asc")));
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (e) {
    console.warn("fetchHero failed:", e);
    return [];
  }
}

export async function fetchGallery() {
  const d = db();
  if (!d) return [];
  try {
    const snap = await getDocs(query(
      collection(d, "gallery"),
      orderBy("order", "asc")
    ));
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (e) {
    console.warn("fetchGallery failed:", e);
    return [];
  }
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function renderProducts(products, container) {
  if (!container) return;
  if (!products.length) {
    // Hide the section if empty and there's no fallback
    if (container.dataset.hideWhenEmpty === "true") {
      const section = container.closest("section");
      if (section) section.style.display = "none";
    }
    return;
  }
  container.innerHTML = products.map(p => `
    <a href="${escapeHtml(p.etsyUrl || "#")}" target="_blank" rel="noopener noreferrer" class="product-card group">
      <div class="product-card-img-wrap">
        <img src="${escapeHtml(p.imageUrl || "")}" alt="${escapeHtml(p.title || "")}" loading="lazy" class="product-card-img" />
        <div class="product-card-hover">
          <span class="product-card-cta">View on Etsy
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="-rotate-45"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
          </span>
        </div>
      </div>
      <div class="product-card-body">
        <h3 class="product-card-title">${escapeHtml(p.title || "Untitled")}</h3>
        ${p.price ? `<p class="product-card-price">${escapeHtml(p.price)}</p>` : ""}
        ${p.description ? `<p class="product-card-desc">${escapeHtml(p.description)}</p>` : ""}
      </div>
    </a>
  `).join("");
  container.dataset.populated = "true";
}

export function renderGallery(items, container, cardBuilder) {
  if (!container || !items.length) return;
  container.innerHTML = items.map(cardBuilder).join("");
  container.dataset.populated = "true";
}
