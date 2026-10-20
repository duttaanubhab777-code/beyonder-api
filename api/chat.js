// Beyonder AI - AI proxy (Vercel serverless function  ->  POST /api/chat)
//
// Contract with the frontend (frontend/js/chat/ai.js in Beyonder-Ai-2.0):
//   request : POST { provider, systemInstruction: { parts: [{ text }] }, contents: [{ role, parts: [{ text }] }] }
//             header  Authorization: <the user's Beyonder token>
//   success : 200 { text, provider }
//   failure : 4xx / 5xx { error }      <- the app shows `error` and offers a "Try again" button
//
// Environment variables (Vercel -> Project -> Settings -> Environment Variables):
//   GEMINI_API_KEY   required for the "gemini" (Normal) model
//   GROQ_API_KEY     required for "gpt-oss" (Smart), "qwen" (Thinker), "groq" (Speedy)
//   BACKEND_URL      optional but recommended, e.g. https://anubhabdutta.pythonanywhere.com
//                    -> when set, only logged-in (and not banned) users can use the AI
//   ALLOWED_ORIGINS  optional, comma separated, e.g. https://yourname.github.io  (empty = any origin)
//   *_MODEL          optional model overrides (see MODELS below)
//   DEBUG_ERRORS     optional, "1" = show the provider's real error message in the chat

import { createHash } from "node:crypto";

const MODELS = {
    gemini: process.env.GEMINI_MODEL || "gemini-3.5-flash-lite",
    "gpt-oss": process.env.GPT_OSS_MODEL || "openai/gpt-oss-120b",
    qwen: process.env.QWEN_MODEL || "qwen/qwen3.8-27b",
    groq: process.env.GROQ_COMPOUND_MODEL || "groq/compound",
};
const GROQ_PROVIDERS = new Set(["gpt-oss", "qwen", "groq"]);

const MAX_TURNS = 60;                 // the app sends at most 40
const MAX_CONTEXT_CHARS = 100_000;    // older turns are dropped first when a chat gets this long
const MAX_SYSTEM_CHARS = 6_000;
const UPSTREAM_TIMEOUT_MS = 50_000;
const AUTH_TIMEOUT_MS = 8_000;
const AUTH_CACHE_MS = 60_000;

class ApiError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/* ---------------- CORS ---------------- */
// NOTE: "Authorization" must be listed explicitly. The app sends it, so without it the
// browser's preflight check fails and every AI request is blocked before it is sent.
function applyCors(req, res) {
    const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const origin = req.headers.origin;
    if (!allowed.length) {
        res.setHeader("Access-Control-Allow-Origin", "*");
    } else if (origin && allowed.includes(origin)) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Max-Age", "86400");
}

/* ---------------- who is asking? ---------------- */
const authCache = new Map(); // sha256(token) -> time until which it is trusted

async function requireUser(req) {
    const backend = (process.env.BACKEND_URL || "").replace(/\/+$/, "");
    if (!backend) return; // check is opt-in: set BACKEND_URL to switch it on

    const token = String(req.headers.authorization || "").trim();
    if (!token) throw new ApiError(401, "Your session has expired. Please log in again.");

    const key = createHash("sha256").update(token).digest("hex");
    if ((authCache.get(key) || 0) > Date.now()) return;

    let me;
    try {
        const res = await fetch(`${backend}/api/me`, {
            headers: { Authorization: token },
            signal: AbortSignal.timeout(AUTH_TIMEOUT_MS),
        });
        me = await res.json();
    } catch {
        throw new ApiError(503, "Couldn't verify your session. Please try again.");
    }
    if (!me || me.logged_in !== true) {
        throw new ApiError(401, "Your session has expired. Please log in again.");
    }

    if (authCache.size > 500) authCache.clear();
    authCache.set(key, Date.now() + AUTH_CACHE_MS);
}

/* ---------------- request validation ---------------- */
function textOf(turn) {
    const parts = Array.isArray(turn?.parts) ? turn.parts : [];
    return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim();
}

function parseBody(body) {
    if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== "object") throw new ApiError(400, "Invalid request.");

    const provider = body.provider ?? "gemini";
    if (typeof provider !== "string" || !Object.hasOwn(MODELS, provider)) {
        throw new ApiError(400, "Unknown AI model.");
    }

    if (!Array.isArray(body.contents) || !body.contents.length) throw new ApiError(400, "Nothing to answer.");
    if (body.contents.length > MAX_TURNS) throw new ApiError(413, "That conversation is too long. Please start a new chat.");

    let turns = [];
    for (const turn of body.contents) {
        const text = textOf(turn);
        if (text) turns.push({ role: turn.role === "model" ? "model" : "user", text });
    }

    // Keep the newest turns that fit; a conversation must start with a user turn.
    const size = (list) => list.reduce((sum, t) => sum + t.text.length, 0);
    while (turns.length > 1 && (size(turns) > MAX_CONTEXT_CHARS || turns[0].role !== "user")) turns.shift();
    if (!turns.length || turns[0].role !== "user") throw new ApiError(400, "Nothing to answer.");
    if (size(turns) > MAX_CONTEXT_CHARS) throw new ApiError(413, "That message is too long. Try a shorter one.");

    const systemText = textOf(body.systemInstruction).slice(0, MAX_SYSTEM_CHARS);
    return { provider, systemText, turns };
}

/* ---------------- talking to the AI providers ---------------- */
function misconfigured(envName) {
    console.error(`Missing environment variable: ${envName}`);
    return new ApiError(500, "The AI service isn't configured yet.");
}

async function callUpstream(name, url, headers, payload) {
    let res;
    try {
        res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...headers },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
    } catch (err) {
        if (err?.name === "TimeoutError" || err?.name === "AbortError") {
            throw new ApiError(504, "The AI took too long to answer. Please try again.");
        }
        console.error(`${name} network error:`, err);
        throw new ApiError(502, "The AI service is having trouble. Please try again.");
    }

    let data = {};
    try { data = await res.json(); } catch { /* non-JSON reply */ }

    if (!res.ok || data.error) {
        const detail = data.error?.message || (typeof data.error === "string" ? data.error : "") || `HTTP ${res.status}`;
        console.error(`${name} error ${res.status}:`, JSON.stringify(data.error || data).slice(0, 500));
        if (process.env.DEBUG_ERRORS === "1") throw new ApiError(502, `${name} error: ${detail}`);
        if (res.status === 429) throw new ApiError(429, "Too many requests right now. Please wait a moment and try again.");
        throw new ApiError(502, "The AI service is having trouble. Please try again.");
    }
    return data;
}

async function askGemini(systemText, turns) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw misconfigured("GEMINI_API_KEY");

    const payload = { contents: turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })) };
    if (systemText) payload.systemInstruction = { parts: [{ text: systemText }] };

    const data = await callUpstream(
        "Gemini",
        `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.gemini}:generateContent`,
        { "x-goog-api-key": key },
        payload
    );

    const candidate = data.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || "").join("").trim();
    if (text) return text;

    if (data.promptFeedback?.blockReason || candidate?.finishReason === "SAFETY") {
        throw new ApiError(422, "The AI couldn't answer that one (blocked by its safety filters). Try rewording it.");
    }
    throw new ApiError(502, "The AI returned an empty answer. Please try again.");
}

async function askGroq(provider, systemText, turns) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw misconfigured("GROQ_API_KEY");

    const messages = [];
    if (systemText) messages.push({ role: "system", content: systemText });
    for (const t of turns) messages.push({ role: t.role === "model" ? "assistant" : "user", content: t.text });

    const payload = { model: MODELS[provider], messages };
    if (provider === "qwen") {
        payload.max_completion_tokens = 800;
        payload.reasoning_effort = "none";
    } else {
        payload.max_tokens = 1024;
    }

    const data = await callUpstream(
        "Groq",
        "https://api.groq.com/openai/v1/chat/completions",
        { Authorization: `Bearer ${key}` },
        payload
    );

    const text = String(data.choices?.[0]?.message?.content || "").trim();
    if (!text) throw new ApiError(502, "The AI returned an empty answer. Please try again.");
    return text;
}

/* ---------------- entry point ---------------- */
export default async function handler(req, res) {
    applyCors(req, res);

    if (req.method === "OPTIONS") return res.status(204).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Only POST is allowed." });

    try {
        await requireUser(req);
        const { provider, systemText, turns } = parseBody(req.body);
        const text = GROQ_PROVIDERS.has(provider)
            ? await askGroq(provider, systemText, turns)
            : await askGemini(systemText, turns);
        return res.status(200).json({ text, provider });
    } catch (err) {
        if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
        console.error(err);
        return res.status(500).json({ error: "Something went wrong on the server. Please try again." });
    }
}
    
