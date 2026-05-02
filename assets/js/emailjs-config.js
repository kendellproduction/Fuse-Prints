// EmailJS configuration for new inquiry notifications.
// Sign up at emailjs.com → set up an Email Service (Gmail), Template, then paste the IDs below.
// All three values are public-safe — anti-abuse is handled via EmailJS's domain allowlist.

export const emailjsConfig = {
  publicKey: "S5_thaUg6waOnC7bZ",
  serviceId: "service_akbjm1p",
  templateId: "template_gw3sk7j",
  // The "to" address is set in your EmailJS template — change it there, not here.
};

export const isEmailjsConfigured = () =>
  emailjsConfig.publicKey && !emailjsConfig.publicKey.startsWith("REPLACE_");
