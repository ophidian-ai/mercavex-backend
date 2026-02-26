// server.js — npm install express cors dotenv express-rate-limit
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json({ limit: "20mb" })); // allow image uploads

// Rate limiting — 20 requests per 15 minutes per IP
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20 });
app.use(limiter);

const AYRSHARE_BASE  = "https://app.ayrshare.com/api";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_HEADERS = {
  "Content-Type":      "application/json",
  "x-api-key":         process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
};

// 1️⃣  GET /social/profiles
app.get("/social/profiles", async (req, res) => {
  const apiKey = req.query.key || process.env.AYRSHARE_API_KEY;
  if (!apiKey) return res.status(400).json({ status: "error", message: "No API key provided." });
  try {
    const resp = await fetch(`${AYRSHARE_BASE}/user`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// 2️⃣  POST /social/post
app.post("/social/post", async (req, res) => {
  const { key, text, platforms, scheduleDate } = req.body;
  const apiKey = key || process.env.AYRSHARE_API_KEY;
  if (!apiKey)            return res.status(400).json({ status: "error", message: "No API key provided." });
  if (!text)              return res.status(400).json({ status: "error", message: "No post text provided." });
  if (!platforms?.length) return res.status(400).json({ status: "error", message: "No platforms selected." });
  const body = { post: text, platforms };
  if (scheduleDate) body.scheduleDate = scheduleDate;
  try {
    const resp = await fetch(`${AYRSHARE_BASE}/post`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// 3️⃣  POST /ai/generate-ads
app.post("/ai/generate-ads", async (req, res) => {
  const { businessDesc, adGoal, platforms, images = [] } = req.body;
  const contentParts = [];
  images.forEach(img => {
    contentParts.push({
      type: "image",
      source: { type: "base64", media_type: img.mediaType, data: img.data },
    });
  });
  contentParts.push({
    type: "text",
    text: `Business: ${businessDesc}\nGoal: ${adGoal || "increase brand awareness"}\nPlatforms: ${platforms}\n\nCreate 3 distinct ad variants. Return ONLY a valid JSON array, no markdown:\n[{"headline":"...","body":"...","cta":"...","tone":"...","platforms":["platform"]}]`,
  });
  try {
    const resp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "You are an expert social media marketing copywriter. Return only valid JSON array — no markdown, no preamble.",
        messages: [{ role: "user", content: contentParts }],
      }),
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// 4️⃣  POST /ai/revise-ad
app.post("/ai/revise-ad", async (req, res) => {
  const { ad, feedback } = req.body;
  try {
    const resp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: "You are an expert marketing copywriter. Revise the ad. Return only valid JSON object — no markdown.",
        messages: [{
          role: "user",
          content: `Headline: ${ad.headline}\nBody: ${ad.body}\nCTA: ${ad.cta}\n\nFeedback: ${feedback}\n\nReturn: {"headline":"...","body":"...","cta":"...","tone":"...","platforms":${JSON.stringify(ad.platforms)}}`,
        }],
      }),
    });
    res.json(await resp.json());
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

app.listen(process.env.PORT || 4000, () =>
  console.log(`Mercavex backend running on port ${process.env.PORT || 4000}`)
);
