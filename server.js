// server.js
// npm install express cors dotenv express-rate-limit @supabase/supabase-js
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json({ limit: "20mb" }));

// Rate limiting — 60 requests per 15 minutes per IP
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 60 });
app.use(limiter);

// ─────────────────────────────────────────────
//  SUPABASE ADMIN CLIENT
// ─────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,  // service role key — never expose to frontend
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// ─────────────────────────────────────────────
//  AUTH MIDDLEWARE
//  Verifies the Supabase JWT passed in Authorization header.
//  Attaches req.user = { id, email, ... } on success.
// ─────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ status: "error", message: "Missing or invalid auth token." });
  }
  const token = authHeader.split(" ")[1];
  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ status: "error", message: "Invalid or expired session. Please sign in again." });
    }
    req.user = data.user;
    next();
  } catch (e) {
    return res.status(401).json({ status: "error", message: "Auth error: " + e.message });
  }
}

const AYRSHARE_BASE  = "https://app.ayrshare.com/api";
const ANTHROPIC_BASE = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_HEADERS = {
  "Content-Type":      "application/json",
  "x-api-key":         process.env.ANTHROPIC_API_KEY,
  "anthropic-version": "2023-06-01",
};

// ─────────────────────────────────────────────
//  5️⃣  GET /user/profile  — load saved profile
// ─────────────────────────────────────────────
app.get("/user/profile", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profiles")
      .select("ayrshare_api_key, business_desc, full_name")
      .eq("id", req.user.id)
      .single();

    if (error && error.code !== "PGRST116") { // PGRST116 = no rows found (new user)
      throw error;
    }
    res.json(data || {});
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  6️⃣  PUT /user/profile  — save/update profile
// ─────────────────────────────────────────────
app.put("/user/profile", requireAuth, async (req, res) => {
  const { ayrshare_api_key, business_desc, full_name } = req.body;
  const updates = { id: req.user.id, updated_at: new Date().toISOString() };
  if (ayrshare_api_key !== undefined) updates.ayrshare_api_key = ayrshare_api_key;
  if (business_desc    !== undefined) updates.business_desc    = business_desc;
  if (full_name        !== undefined) updates.full_name        = full_name;

  try {
    const { error } = await supabase
      .from("profiles")
      .upsert(updates, { onConflict: "id" });
    if (error) throw error;
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  1️⃣  GET /social/profiles
// ─────────────────────────────────────────────
app.get("/social/profiles", requireAuth, async (req, res) => {
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

// ─────────────────────────────────────────────
//  IMAGE UPLOAD HELPER
//  Uploads base64 images to Supabase Storage and returns public URLs.
//  Requires a public bucket named "post-media" in Supabase Storage.
//  One-time setup SQL (run in Supabase SQL editor):
//    insert into storage.buckets (id, name, public) values ('post-media', 'post-media', true);
//    create policy "Public read" on storage.objects for select using (bucket_id = 'post-media');
//    create policy "Auth upload" on storage.objects for insert with check (bucket_id = 'post-media');
// ─────────────────────────────────────────────
async function uploadImagesToStorage(images) {
  const urls = [];
  for (const img of images) {
    const buffer   = Buffer.from(img.data, "base64");
    const ext      = (img.mediaType || "image/jpeg").split("/")[1] || "jpg";
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage
      .from("post-media")
      .upload(filename, buffer, { contentType: img.mediaType, upsert: false });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
    const { data: { publicUrl } } = supabase.storage.from("post-media").getPublicUrl(filename);
    urls.push(publicUrl);
  }
  return urls;
}

// ─────────────────────────────────────────────
//  2️⃣  POST /social/post
// ─────────────────────────────────────────────
app.post("/social/post", requireAuth, async (req, res) => {
  const { key, text, platforms, scheduleDate, images = [] } = req.body;
  const apiKey = key || process.env.AYRSHARE_API_KEY;
  if (!apiKey)            return res.status(400).json({ status: "error", message: "No API key provided." });
  if (!text)              return res.status(400).json({ status: "error", message: "No post text provided." });
  if (!platforms?.length) return res.status(400).json({ status: "error", message: "No platforms selected." });

  const body = { post: text, platforms };
  if (scheduleDate) body.scheduleDate = scheduleDate;

  // Upload images → get public URLs → pass as mediaUrls to Ayrshare
  if (images.length > 0) {
    try {
      body.mediaUrls = await uploadImagesToStorage(images);
    } catch (e) {
      console.error("Image upload error:", e.message);
      // Don't block the post — publish without images
    }
  }

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

// ─────────────────────────────────────────────
//  3️⃣  POST /ai/generate-ads
// ─────────────────────────────────────────────
app.post("/ai/generate-ads", requireAuth, async (req, res) => {
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

// ─────────────────────────────────────────────
//  4️⃣  POST /ai/revise-ad
// ─────────────────────────────────────────────
app.post("/ai/revise-ad", requireAuth, async (req, res) => {
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

// ─────────────────────────────────────────────
//  CAMPAIGNS  —  GET / POST / DELETE
// ─────────────────────────────────────────────

// List all campaigns for the authenticated user (newest first)
app.get("/campaigns", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("campaigns")
      .select("id, created_at, business_desc, ad_goal, platforms, schedule_id, post_time, ads, publish_log")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Save a new campaign record after publishing
app.post("/campaigns", requireAuth, async (req, res) => {
  const { business_desc, ad_goal, platforms, schedule_id, post_time, ads, publish_log } = req.body;
  try {
    const { data, error } = await supabase
      .from("campaigns")
      .insert({
        user_id:      req.user.id,
        business_desc,
        ad_goal,
        platforms,
        schedule_id,
        post_time,
        ads,
        publish_log,
      })
      .select("id")
      .single();
    if (error) throw error;
    res.json(data);
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// Delete a campaign (owner-gated via user_id check)
app.delete("/campaigns/:id", requireAuth, async (req, res) => {
  try {
    const { error } = await supabase
      .from("campaigns")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);
    if (error) throw error;
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", service: "Mercavex Backend" }));

app.listen(process.env.PORT || 4000, () =>
  console.log(`Mercavex backend running on port ${process.env.PORT || 4000}`)
);
