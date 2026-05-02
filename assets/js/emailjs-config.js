// EmailJS configuration for new inquiry notifications.
// Sign up at emailjs.com → set up an Email Service (Gmail), Template, then paste the IDs below.
// All three values are public-safe — anti-abuse is handled via EmailJS's domain allowlist.

export const emailjsConfig = {
  publicKey: "REPLACE_WITH_YOUR_PUBLIC_KEY",
  serviceId: "REPLACE_WITH_YOUR_SERVICE_ID",
  templateId: "REPLACE_WITH_YOUR_TEMPLATE_ID",
  // The "to" address is set in your EmailJS template — change it there, not here.
};

export const isEmailjsConfigured = () =>
  emailjsConfig.publicKey && !emailjsConfig.publicKey.startsWith("REPLACE_");
