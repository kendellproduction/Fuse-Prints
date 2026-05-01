// Firebase configuration for Fuse Prints
// ----------------------------------------
// Values populated by setup on 2026-04-17.
// These values are safe to commit — security is enforced by firestore.rules + storage.rules.

export const firebaseConfig = {
  apiKey: "AIzaSyDLztuQk50vgHguzuB0VdOy4Z_5ReWgII0",
  authDomain: "fuse-prints.firebaseapp.com",
  projectId: "fuse-prints",
  storageBucket: "fuse-prints.firebasestorage.app",
  messagingSenderId: "367403679147",
  appId: "1:367403679147:web:e7ee5a718d59b44de566ee"
};

export const isConfigured = () =>
  firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("REPLACE_");
