/*
 * Optional chatbot configuration for static hosting.
 *
 * The site can be served two ways:
 *   - By Flask (chatbot-api.py), which serves this folder and exposes
 *     /api/chat on the same origin. Nothing to set here.
 *   - By a static host (GitHub Pages, Surge, Netlify). There is no
 *     /api/chat, so set CHATBOT_API_URL to your hosted Flask backend.
 *
 * Leave CHATBOT_API_URL as an empty string to keep the local /api/chat
 * default. This file must never contain an API key — those stay on the
 * server, which is why the backend exists as a separate service.
 */
window.CHATBOT_API_URL = '';
