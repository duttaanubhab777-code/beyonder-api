# Beyonder API

The small AI proxy behind **Beyonder AI**. It runs as a single Vercel serverless function (`api/chat.js`).

Why a proxy? The AI provider keys must never be shipped to the browser. The chat app sends the conversation here, this function adds the secret key, asks the right AI model and returns plain text.

```
Beyonder AI (browser)  ──►  beyonder-api (Vercel)  ──►  Gemini / Groq
        ▲                          │
        └────────  { text }  ──────┘
```

## Endpoint

`POST /api/chat`

Request (sent by `frontend/js/chat/ai.js`):

```json
{
  "provider": "gemini",
  "systemInstruction": { "parts": [{ "text": "You are Beyonder AI..." }] },
  "contents": [
    { "role": "user",  "parts": [{ "text": "Hello" }] },
    { "role": "model", "parts": [{ "text": "Hi! How can I help?" }] },
    { "role": "user",  "parts": [{ "text": "Explain gravity simply" }] }
  ]
}
```

Header: `Authorization: <the user's Beyonder login token>`

| Result | Body |
|---|---|
| `200` | `{ "text": "...", "provider": "gemini" }` |
| `400` | bad request (unknown provider, empty conversation) |
| `401` | not logged in / session expired (only when `BACKEND_URL` is set) |
| `413` | a single message is too long |
| `422` | the AI refused the prompt (safety filter) |
| `429` | rate limited by the AI provider |
| `502` / `504` | the AI provider failed / timed out |
| `503` | could not verify the session |

Every error is `{ "error": "message" }`. The app shows that message with a **Try again** button, and a failed answer is never saved as if it were a real reply.

## Models

| `provider` | App label | Model (default) | Needs |
|---|---|---|---|
| `gemini` | ✨ Normal | `gemini-3.5-flash-lite` | `GEMINI_API_KEY` |
| `gpt-oss` | ⚡ Smart | `openai/gpt-oss-120b` | `GROQ_API_KEY` |
| `qwen` | 🧠 Thinker | `qwen/qwen3.8-27b` (reasoning off, 800 token cap) | `GROQ_API_KEY` |
| `groq` | 🚀 Speedy | `groq/compound` | `GROQ_API_KEY` |

Each model name can be changed from the Vercel dashboard without touching code (see below).

## Environment variables

Set them in **Vercel → your project → Settings → Environment Variables**, then redeploy.

| Variable | Required | What it does |
|---|---|---|
| `GEMINI_API_KEY` | for Normal | Google AI Studio key |
| `GROQ_API_KEY` | for Smart / Thinker / Speedy | Groq key |
| `BACKEND_URL` | recommended | e.g. `https://anubhabdutta.pythonanywhere.com`. When set, the proxy checks the user's token against `GET {BACKEND_URL}/api/me`, so only logged-in, non-banned users can spend your AI quota. Results are cached for 60 s. If the backend can't be reached the request is refused (fail closed). When **not** set, anyone who knows the URL can use the AI. |
| `ALLOWED_ORIGINS` | optional | Comma separated list, e.g. `https://yourname.github.io`. Empty = any origin. |
| `GEMINI_MODEL`, `GPT_OSS_MODEL`, `QWEN_MODEL`, `GROQ_COMPOUND_MODEL` | optional | Override the model names above. |
| `DEBUG_ERRORS` | optional | `1` = show the provider's real error text in the chat (handy for a wrong model name). Turn it off again afterwards. |

## Good to know

- **CORS**: the app sends an `Authorization` header, so `Authorization` is listed in `Access-Control-Allow-Headers`. If you ever remove it, browsers block every AI call at the preflight step.
- Long chats are trimmed on the server: the newest turns that fit into ~100,000 characters are kept, and the conversation always starts with a user turn.
- Only `contents` and `systemInstruction` are forwarded to Gemini; nothing else from the request body is passed through.
- Real provider errors are written to the Vercel function logs (**Project → Logs**), not shown to users.

## Deploy

1. Push this repo to GitHub and import it in Vercel.
2. Add the environment variables.
3. Put the resulting URL (`https://<project>.vercel.app/api/chat`) into `AI_API_URL` in `frontend/js/core/config.js` of the main app.
