/*
 * Optional chatbot configuration for static hosting.
 *
 * The site can be served two ways:
 *   - By Flask (chatbot-api.py), which serves this folder and exposes
 *     /api/chat on the same origin. Nothing to set here — the chatbot
 *     finds the backend on its own.
 *   - By a static host (GitHub Pages, Surge, Netlify). There is no
 *     /api/chat on the same origin, so list your backend origins here.
 *
 * CHATBOT_API_HOSTS is an ordered list of origins (no trailing /api/chat —
 * that is appended automatically). The chatbot probes each one's
 * /api/chat/health in order and uses the first that answers, then remembers
 * that choice. Listing more than one gives you automatic failover: if the
 * first host is asleep, cold-starting, or down, the next one is used without
 * the user seeing an error and without editing this file.
 *
 * Same-origin is always tried last, so this can stay empty when Flask serves
 * the site.
 *
 * This file must never contain an API key — those live in the backend's
 * environment, which is why the backend is a separate service at all.
 */
window.CHATBOT_API_HOSTS = [
  'https://kalki-chatbot-api.onrender.com',
];
