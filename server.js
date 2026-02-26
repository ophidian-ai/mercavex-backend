// server.js — npm install express cors node-fetch dotenv
require("dotenv").config();
const express    = require("express");
const cors       = require("cors");
const fetch      = require("node-fetch");
const rateLimit  = require("express-rate-limit");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());

// Rate limiting — 20 requests per 15 minutes per IP
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(limiter);

const AYRSHARE_BASE = "https://app.ayrshare.com/api";

// ─────────────────────────────────────────────
// 1️⃣  GET /social/profiles
//     Returns the user's connected social accounts from Ayrshare.
//     Pass ?key=YOUR_KEY or set AYRSHARE_API_KEY in .env
// ─────────────────────────────────────────────
app.get("/social/profiles", async (req, res) => {
  const apiKey = req.query.key || process.env.AYRSHARE_API_KEY;
  if (!apiKey) return res.status(400).json({ status: "error", message: "No API key provided." });
  try {
    const resp = await fetch(`${AYRSHARE_BASE}/user`, {
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
// 2️⃣  POST /social/post
//     Schedules a post to one or more platforms via Ayrshare.
//     Body: { key, text, platforms, scheduleDate }
// ─────────────────────────────────────────────
app.post("/social/post", async (req, res) => {
  const { key, text, platforms, scheduleDate } = req.body;
  const apiKey = key || process.env.AYRSHARE_API_KEY;
  if (!apiKey)     return res.status(400).json({ status: "error", message: "No API key provided." });
  if (!text)       return res.status(400).json({ status: "error", message: "No post text provided." });
  if (!platforms?.length) return res.status(400).json({ status: "error", message: "No platforms selected." });

  const body = { post: text, platforms };
  if (scheduleDate) body.scheduleDate = scheduleDate;

  try {
    const resp = await fetch(`${AYRSHARE_BASE}/post`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
// 3️⃣  POST /ai/generate-ads  (optional, more secure)
//     Move Claude API calls to the backend to protect your Anthropic key.
//     Body: { businessDesc, adGoal, platforms }
// ─────────────────────────────────────────────
app.post("/ai/generate-ads", async (req, res) => {
  const { businessDesc, adGoal, platforms } = req.body;
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":    "application/json",
      "x-api-key":       process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 1000,
      system:     "You are an expert social media marketing copywriter. Return only valid JSON array — no markdown, no preamble.",
      messages: [{
        role:    "user",
        content: `Business: ${businessDesc}\nGoal: ${adGoal || "increase brand awareness"}\nPlatforms: ${platforms}\n\nCreate 3 distinct ad variants. Return ONLY a valid JSON array:\n[{"headline":"...","body":"...","cta":"...","tone":"...","platforms":["platform"]}]`,
      }],
    }),
  });
  res.json(await resp.json());
});

app.listen(process.env.PORT || 4000, () =>
  console.log(`Mercavex backend running on port ${process.env.PORT || 4000}`)
);
