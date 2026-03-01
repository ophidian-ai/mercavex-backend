// server.js
// npm install express cors dotenv express-rate-limit @supabase/supabase-js stripe
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
const { createClient } = require("@supabase/supabase-js");
const Stripe    = require("stripe");

const stripe = process.env.STRIPE_SECRET_KEY
  ? Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// ─────────────────────────────────────────────
//  Stripe plan → price ID map
//  Set these in your Render environment variables.
// ─────────────────────────────────────────────
const STRIPE_PRICE_IDS = {
  pro:      process.env.STRIPE_PRO_PRICE_ID      || null,
  business: process.env.STRIPE_BUSINESS_PRICE_ID || null,
  agency:   process.env.STRIPE_AGENCY_PRICE_ID   || null,
};

const PLAN_LIMITS = {
  free:     { campaigns: 3,    video: false, image: false, platforms: 2,  teamSeats: 0, export: false, whitelabel: false, analytics: "basic" },
  pro:      { campaigns: 25,   video: true,  image: true,  platforms: 10, teamSeats: 0, export: true,  whitelabel: false, analytics: "full"  },
  business: { campaigns: 9999, video: true,  image: true,  platforms: 10, teamSeats: 0, export: true,  whitelabel: false, analytics: "full"  },
  agency:   { campaigns: 9999, video: true,  image: true,  platforms: 10, teamSeats: 4, export: true,  whitelabel: true,  analytics: "full"  },
  dev:      { campaigns: 9999, video: true,  image: true,  platforms: 10, teamSeats: 4, export: true,  whitelabel: true,  analytics: "full"  },
};

// ─────────────────────────────────────────────
//  DEV ACCOUNTS — set DEV_USER_IDS in Render
//  environment as a comma-separated list of
//  Supabase user UUIDs. Dev accounts always
//  receive agency-level limits and bypass all
//  plan gates. Never exposed to the client.
// ─────────────────────────────────────────────
const DEV_USER_IDS = new Set(
  (process.env.DEV_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean)
);
const isDevUser = (userId) => DEV_USER_IDS.has(userId);

// ─────────────────────────────────────────────
//  PLAN HELPER — fetch plan + campaign count
//  Returns { plan, limits, campaignsThisMonth }
// ─────────────────────────────────────────────
async function getPlanAndUsage(userId) {
  // Dev accounts bypass Stripe entirely
  if (isDevUser(userId)) {
    return { plan: "dev", limits: PLAN_LIMITS.dev, campaignsThisMonth: 0 };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("plan")
    .eq("id", userId)
    .single();

  const plan   = profile?.plan || "free";
  const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

  // Count campaigns created this calendar month
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { count } = await supabase
    .from("campaigns")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .gte("created_at", monthStart.toISOString());

  return { plan, limits, campaignsThisMonth: count || 0 };
}

// ─────────────────────────────────────────────
//  Supabase SQL — run once in SQL editor:
//
//  ALTER TABLE profiles
//    ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
//    ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free',
//    ADD COLUMN IF NOT EXISTS plan_period_end TIMESTAMPTZ;
// ─────────────────────────────────────────────

const app = express();
app.use(cors({ origin: process.env.FRONTEND_URL }));

// ⚠️  Stripe webhook MUST be registered before express.json() —
//     it needs the raw request body to verify the signature.
app.post(
  "/billing/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const sig    = req.headers["stripe-signature"];
    const secret = process.env.STRIPE_WEBHOOK_SECRET;

    if (!stripe || !secret) {
      return res.status(400).json({ error: "Stripe not configured." });
    }

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, secret);
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    const obj = event.data.object;

    // Helper — update profiles row by stripe_customer_id
    const updatePlan = async (customerId, plan, periodEnd) => {
      const { error } = await supabase
        .from("profiles")
        .update({
          plan,
          plan_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
        })
        .eq("stripe_customer_id", customerId);
      if (error) console.error("Supabase plan update error:", error.message);
    };

    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated": {
        const priceId = obj.items?.data?.[0]?.price?.id;
        let plan = "free";
        if (priceId === STRIPE_PRICE_IDS.agency)   plan = "agency";
        else if (priceId === STRIPE_PRICE_IDS.business) plan = "business";
        else if (priceId === STRIPE_PRICE_IDS.pro) plan = "pro";
        // Downgrade to free if subscription is cancelled/unpaid
        if (["canceled", "unpaid", "incomplete_expired"].includes(obj.status)) plan = "free";
        await updatePlan(obj.customer, plan, obj.current_period_end);
        break;
      }
      case "customer.subscription.deleted": {
        await updatePlan(obj.customer, "free", null);
        break;
      }
      default:
        break;
    }

    res.json({ received: true });
  }
);

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

const FAL_BASE       = "https://fal.run";
const FAL_QUEUE_BASE = "https://queue.fal.run";
const FAL_KEY        = process.env.FAL_API_KEY;
const falHeaders     = { "Authorization": `Key ${FAL_KEY}`, "Content-Type": "application/json" };

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
  const { key, text, platforms, scheduleDate, images = [], mediaUrls: directMediaUrls } = req.body;
  const apiKey = key || process.env.AYRSHARE_API_KEY;
  if (!apiKey)            return res.status(400).json({ status: "error", message: "No API key provided." });
  if (!text)              return res.status(400).json({ status: "error", message: "No post text provided." });
  if (!platforms?.length) return res.status(400).json({ status: "error", message: "No platforms selected." });

  const body = { post: text, platforms };
  if (scheduleDate) body.scheduleDate = scheduleDate;

  // Use pre-generated media URLs, or upload base64 images to storage
  if (directMediaUrls?.length > 0) {
    body.mediaUrls = directMediaUrls;
  } else if (images.length > 0) {
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

  // ── Plan gates ──
  try {
    const { plan, limits, campaignsThisMonth } = await getPlanAndUsage(req.user.id);

    // Campaign count gate
    if (campaignsThisMonth >= limits.campaigns) {
      return res.status(403).json({
        status: "error", code: "PLAN_LIMIT",
        message: `You've used all ${limits.campaigns} campaigns for this month on the ${plan === "free" ? "Free" : "Pro"} plan. Upgrade to ${plan === "free" ? "Pro" : "Business"} for unlimited campaigns.`,
        used: campaignsThisMonth, limit: limits.campaigns,
      });
    }

    // Platform count gate
    const platformList = Array.isArray(platforms) ? platforms : (platforms || "").split(",").map(p => p.trim()).filter(Boolean);
    if (platformList.length > limits.platforms) {
      return res.status(403).json({
        status: "error", code: "PLAN_LIMIT",
        message: `The Free plan supports up to ${limits.platforms} platforms. Upgrade to Pro for all 10.`,
        limit: limits.platforms,
      });
    }
  } catch (e) {
    // Non-fatal — allow through if plan check fails
    console.error("Plan check error:", e.message);
  }
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
//  AI IMAGE GENERATION  —  POST /ai/generate-image
//  1. Claude writes a rich visual prompt from the ad copy
//  2. fal.ai Flux generates the image (text-to-image or img2img)
//  3. Result downloaded → uploaded to Supabase Storage → URL returned
// ─────────────────────────────────────────────
app.post("/ai/generate-image", requireAuth, async (req, res) => {
  const { businessDesc, adHeadline, adBody, platforms, sourceImageBase64, sourceMediaType } = req.body;
  if (!FAL_KEY) return res.status(500).json({ status: "error", message: "FAL_API_KEY not configured on server." });

  // ── Plan gate: image is Pro/Agency only ──
  try {
    const { limits } = await getPlanAndUsage(req.user.id);
    if (!limits.image) {
      return res.status(403).json({
        status: "error", code: "PLAN_LIMIT",
        message: "AI image generation is available on Pro, Business, and Agency plans. Upgrade to unlock.",
      });
    }
  } catch (e) {
    return res.status(403).json({ status: "error", code: "PLAN_LIMIT", message: "Could not verify plan. Please try again." });
  }

  try {
    // Step 1: Claude crafts the visual prompt
    const promptResp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 300,
        system: "You are an elite creative director writing prompts for AI image generation. Return ONLY the prompt string — no explanation, no quotes, no preamble.",
        messages: [{
          role: "user",
          content: `Business: ${businessDesc}
Ad Headline: ${adHeadline}
Ad Body: ${adBody}
Platforms: ${platforms || "Instagram, Facebook"}

Write a single detailed image generation prompt for a stunning, professional social media ad creative.
Requirements:
- Photorealistic or high-end commercial photography style
- Evoke the emotional tone of the ad copy
- Strong composition, cinematic lighting, shallow depth of field
- Colors that feel premium and intentional
- NO text, words, logos, or watermarks in the image
- Optimised for landscape 16:9 social media format
Return only the prompt.`,
        }],
      }),
    });
    const promptData   = await promptResp.json();
    const imagePrompt  = promptData.content?.find(b => b.type === "text")?.text?.trim() || `Premium product advertisement, ${businessDesc}, cinematic lighting, professional photography`;

    // Step 2: Generate image with fal.ai Flux
    let falBody;
    let falEndpoint;

    if (sourceImageBase64) {
      // Image-to-image: transform user's product photo into polished ad creative
      falEndpoint = `${FAL_BASE}/fal-ai/flux/dev/image-to-image`;
      falBody = {
        prompt:           imagePrompt,
        image_url:        `data:${sourceMediaType || "image/jpeg"};base64,${sourceImageBase64}`,
        strength:         0.72,
        num_inference_steps: 28,
        guidance_scale:   3.5,
        image_size:       "landscape_16_9",
        num_images:       1,
        enable_safety_checker: true,
      };
    } else {
      // Text-to-image: generate from scratch
      falEndpoint = `${FAL_BASE}/fal-ai/flux/dev`;
      falBody = {
        prompt:           imagePrompt,
        num_inference_steps: 28,
        guidance_scale:   3.5,
        image_size:       "landscape_16_9",
        num_images:       1,
        enable_safety_checker: true,
      };
    }

    const falResp = await fetch(falEndpoint, {
      method:  "POST",
      headers: falHeaders,
      body:    JSON.stringify(falBody),
    });
    const falData = await falResp.json();

    if (!falData.images?.[0]?.url) {
      throw new Error(falData.detail || falData.error || "fal.ai returned no image.");
    }

    const tempUrl = falData.images[0].url;

    // Step 3: Download image → upload to Supabase Storage for a permanent URL
    const imgResp  = await fetch(tempUrl);
    const imgBuf   = Buffer.from(await imgResp.arrayBuffer());
    const ext      = "jpg";
    const filename = `ai-img-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    const { error: uploadErr } = await supabase.storage
      .from("post-media")
      .upload(filename, imgBuf, { contentType: "image/jpeg", upsert: false });
    if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

    const { data: { publicUrl } } = supabase.storage.from("post-media").getPublicUrl(filename);

    res.json({ status: "ok", imageUrl: publicUrl, prompt: imagePrompt });
  } catch (e) {
    console.error("Image generation error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  AI VIDEO GENERATION  —  POST /ai/generate-video
//  Submits an async job to fal.ai Kling v1.6.
//  Returns requestId immediately — client polls /ai/video-status/:id
// ─────────────────────────────────────────────
app.post("/ai/generate-video", requireAuth, async (req, res) => {
  const { imageUrl, adHeadline, adBody, businessDesc } = req.body;
  if (!FAL_KEY)   return res.status(500).json({ status: "error", message: "FAL_API_KEY not configured on server." });
  if (!imageUrl)  return res.status(400).json({ status: "error", message: "imageUrl is required to generate a video." });

  // ── Plan gate: video is Pro/Agency only ──
  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", req.user.id)
      .single();
    const plan = profile?.plan || "free";
    if (!PLAN_LIMITS[plan]?.video) {
      return res.status(403).json({
        status: "error",
        code:   "PLAN_LIMIT",
        message: "AI video generation is available on Pro, Business, and Agency plans. Upgrade to unlock.",
      });
    }
  } catch (e) {
    // Non-blocking — if profile fetch fails, deny by default
    return res.status(403).json({ status: "error", code: "PLAN_LIMIT", message: "Could not verify plan. Please try again." });
  }

  try {
    // Claude writes a cinematic motion prompt for the video
    const promptResp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        system: "You write video motion prompts for AI video generation. Return ONLY the prompt — no explanation, no preamble.",
        messages: [{
          role: "user",
          content: `Business: ${businessDesc}
Ad Headline: ${adHeadline}
Ad Body: ${adBody}

Write a short (1-2 sentence) motion prompt describing subtle, cinematic camera movement and ambient motion for a 5-second social media ad video.
The video starts from a static ad image. Describe ONLY the motion/animation — gentle parallax, slow zoom, particle effects, bokeh shift, etc.
Make it feel premium and professional. Return only the motion prompt.`,
        }],
      }),
    });
    const pData       = await promptResp.json();
    const videoPrompt = pData.content?.find(b => b.type === "text")?.text?.trim()
      || "Slow cinematic zoom in with gentle bokeh blur in background, subtle light rays, premium feel";

    // Submit async video job to fal.ai Kling v1.6
    const falResp = await fetch(`${FAL_QUEUE_BASE}/fal-ai/kling-video/v1.6/standard/image-to-video`, {
      method:  "POST",
      headers: falHeaders,
      body:    JSON.stringify({
        image_url:    imageUrl,
        prompt:       videoPrompt,
        duration:     "5",
        aspect_ratio: "16:9",
      }),
    });
    const falData = await falResp.json();

    if (!falData.request_id) {
      throw new Error(falData.detail || falData.error || "fal.ai did not return a request_id.");
    }

    res.json({ status: "ok", requestId: falData.request_id, prompt: videoPrompt });
  } catch (e) {
    console.error("Video submit error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  VIDEO STATUS POLL  —  GET /ai/video-status/:requestId
//  Polls fal.ai queue. On completion downloads the video,
//  uploads to Supabase Storage, and returns the permanent URL.
// ─────────────────────────────────────────────
app.get("/ai/video-status/:requestId", requireAuth, async (req, res) => {
  const { requestId } = req.params;
  if (!FAL_KEY) return res.status(500).json({ status: "error", message: "FAL_API_KEY not configured." });

  try {
    const MODEL = "fal-ai/kling-video/v1.6/standard/image-to-video";

    // Check status first
    const statusResp = await fetch(`${FAL_QUEUE_BASE}/${MODEL}/requests/${requestId}/status`, {
      headers: falHeaders,
    });
    const statusData = await statusResp.json();

    if (statusData.status === "IN_QUEUE" || statusData.status === "IN_PROGRESS") {
      return res.json({ status: "processing" });
    }

    if (statusData.status === "FAILED") {
      return res.json({ status: "failed", message: "Video generation failed on fal.ai." });
    }

    if (statusData.status === "COMPLETED") {
      // Fetch the result
      const resultResp = await fetch(`${FAL_QUEUE_BASE}/${MODEL}/requests/${requestId}`, {
        headers: falHeaders,
      });
      const resultData = await resultResp.json();

      const tempVideoUrl = resultData.video?.url;
      if (!tempVideoUrl) throw new Error("No video URL in fal.ai result.");

      // Download and upload to Supabase for a permanent URL
      const vidResp  = await fetch(tempVideoUrl);
      const vidBuf   = Buffer.from(await vidResp.arrayBuffer());
      const filename = `ai-vid-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;

      const { error: uploadErr } = await supabase.storage
        .from("post-media")
        .upload(filename, vidBuf, { contentType: "video/mp4", upsert: false });
      if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

      const { data: { publicUrl } } = supabase.storage.from("post-media").getPublicUrl(filename);
      return res.json({ status: "completed", videoUrl: publicUrl });
    }

    // Unknown status — treat as still processing
    res.json({ status: "processing" });
  } catch (e) {
    console.error("Video status error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  🔄  GET /social/history  — live post statuses from Ayrshare
//  Returns a map of { ayrshareId → status } for
//  quick cross-referencing with stored campaigns.
// ─────────────────────────────────────────────
app.get("/social/history", requireAuth, async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ status: "error", message: "No Ayrshare API key provided." });

  try {
    const resp = await fetch(`${AYRSHARE_BASE}/history`, {
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });
    const data = await resp.json();

    // Ayrshare returns an array of posts (or { posts: [...] })
    const posts = Array.isArray(data) ? data : (data.posts || []);

    // Build a lookup map: ayrshareId → { status, postIds }
    const statusMap = {};
    for (const post of posts) {
      const id = post.id || post._id;
      if (!id) continue;

      // Derive overall status from individual platform postIds
      const postIds   = post.postIds || [];
      const succeeded = postIds.filter(p => p.status === "success").length;
      const total     = postIds.length;

      let liveStatus;
      if (post.status === "success" || (succeeded > 0 && succeeded === total)) {
        liveStatus = "success";
      } else if (succeeded > 0) {
        liveStatus = "partial";
      } else if (post.status === "error") {
        liveStatus = "error";
      } else if (post.status === "queued") {
        liveStatus = "scheduled"; // Ayrshare alias for immediate posts in-flight
      } else {
        liveStatus = post.status || "unknown";
      }

      statusMap[id] = {
        status:    liveStatus,
        postIds:   postIds,
        createdAt: post.created || post.createdAt,
      };
    }

    res.json({ statusMap, totalPosts: posts.length });
  } catch (e) {
    console.error("History fetch error:", e.message);
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
//  ANALYTICS  —  GET /analytics
//  Pulls per-post metrics from Ayrshare for
//  every post ID stored in the user's campaigns.
//  Falls back to history data if per-post
//  analytics are unavailable.
// ─────────────────────────────────────────────
app.get("/analytics", requireAuth, async (req, res) => {
  const apiKey = req.query.key;
  if (!apiKey) return res.status(400).json({ status: "error", message: "No Ayrshare API key provided." });

  try {
    // 1. Load all campaigns for this user
    const { data: campaigns, error } = await supabase
      .from("campaigns")
      .select("id, created_at, business_desc, publish_log")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false });
    if (error) throw error;

    // 2. Collect post refs that have an Ayrshare post ID
    const postRefs = [];
    for (const campaign of campaigns || []) {
      for (const entry of campaign.publish_log || []) {
        if (entry.ayrshareId) {
          postRefs.push({
            campaignId:   campaign.id,
            businessDesc: campaign.business_desc,
            ayrshareId:   entry.ayrshareId,
            adTitle:      entry.adTitle,
            scheduleDate: entry.scheduleDate,
            platforms:    entry.platforms || [],
            createdAt:    campaign.created_at,
          });
        }
      }
    }

    if (postRefs.length === 0) {
      return res.json({ posts: [], platforms: {}, topPost: null, trend: [], totalPosts: 0 });
    }

    // 3. Try Ayrshare analytics for each post in parallel
    const analyticsResults = await Promise.allSettled(
      postRefs.map(ref =>
        fetch(`${AYRSHARE_BASE}/analytics/post`, {
          method:  "POST",
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body:    JSON.stringify({ id: ref.ayrshareId, platforms: ref.platforms }),
        }).then(r => r.json())
      )
    );

    // 4. Check if analytics returned actual data
    let hasAnalyticsData = false;
    for (const result of analyticsResults) {
      if (result.status === "fulfilled" && result.value.analytics && Object.keys(result.value.analytics).length > 0) {
        hasAnalyticsData = true;
        break;
      }
    }

    // 5. If analytics endpoint returned no data, fallback to history endpoint
    let historyMap = {};
    if (!hasAnalyticsData) {
      try {
        const histResp = await fetch(`${AYRSHARE_BASE}/history`, {
          headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        });
        const histData = await histResp.json();
        const histPosts = Array.isArray(histData) ? histData : (histData.posts || []);
        for (const hp of histPosts) {
          const hid = hp.id || hp._id;
          if (hid) {
            historyMap[hid] = hp;
          }
        }
      } catch (histErr) {
        console.error("History fallback error:", histErr.message);
      }
    }

    // 6. Aggregate stats per post and per platform
    const posts          = [];
    const platformTotals = {};

    for (let i = 0; i < postRefs.length; i++) {
      const ref    = postRefs[i];
      const result = analyticsResults[i];

      let totalImpressions = 0, totalEngagements = 0, totalClicks = 0;
      let hasMetrics = false;

      // Try structured analytics first
      if (result.status === "fulfilled") {
        const analytics = result.value.analytics || {};
        for (const [platform, m] of Object.entries(analytics)) {
          const imp = m.impressions      || m.reach              || 0;
          const eng = m.engagements      || m.totalEngagements   || m.likes || 0;
          const cli = m.clicks           || m.linkClicks         || 0;

          if (imp > 0 || eng > 0 || cli > 0) hasMetrics = true;

          totalImpressions += imp;
          totalEngagements += eng;
          totalClicks      += cli;

          if (!platformTotals[platform]) {
            platformTotals[platform] = { impressions: 0, engagements: 0, clicks: 0, posts: 0 };
          }
          platformTotals[platform].impressions += imp;
          platformTotals[platform].engagements += eng;
          platformTotals[platform].clicks      += cli;
          platformTotals[platform].posts       += 1;
        }
      }

      // Fallback: use history data to at least show post presence per platform
      if (!hasMetrics && historyMap[ref.ayrshareId]) {
        const hp = historyMap[ref.ayrshareId];
        const hPostIds = hp.postIds || [];
        for (const pid of hPostIds) {
          const platform = pid.platform;
          if (!platform) continue;
          const eng = pid.likes || pid.comments || 0;
          totalEngagements += eng;

          if (!platformTotals[platform]) {
            platformTotals[platform] = { impressions: 0, engagements: 0, clicks: 0, posts: 0 };
          }
          platformTotals[platform].posts += 1;
          platformTotals[platform].engagements += eng;
        }
      }

      posts.push({
        ...ref,
        impressions:    totalImpressions,
        engagements:    totalEngagements,
        clicks:         totalClicks,
        engagementRate: totalImpressions > 0
          ? ((totalEngagements / totalImpressions) * 100).toFixed(1)
          : "0.0",
        status: historyMap[ref.ayrshareId]?.status || (result.status === "fulfilled" ? "tracked" : "pending"),
      });
    }

    // 7. Top performer by engagements
    const topPost = posts.length > 0
      ? [...posts].sort((a, b) => b.engagements - a.engagements)[0]
      : null;

    // 8. Weekly engagement trend (grouped by week-start Sunday)
    const trendMap = {};
    for (const post of posts) {
      const dateStr = post.scheduleDate || post.createdAt;
      if (!dateStr) continue;
      const d = new Date(dateStr);
      d.setDate(d.getDate() - d.getDay());
      const key = d.toISOString().split("T")[0];
      if (!trendMap[key]) trendMap[key] = { date: key, impressions: 0, engagements: 0 };
      trendMap[key].impressions += post.impressions;
      trendMap[key].engagements += post.engagements;
    }
    const trend = Object.values(trendMap).sort((a, b) => a.date.localeCompare(b.date));

    res.json({ posts, platforms: platformTotals, topPost, trend, totalPosts: posts.length });
  } catch (e) {
    console.error("Analytics error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  🤖  POST /ai/chat  — Mercavex helper chatbot
//  Proxies conversation to Anthropic with a
//  Mercavex-aware system prompt so the bot can
//  guide users through platform features.
// ─────────────────────────────────────────────
const CHAT_SYSTEM_PROMPT = `You are the Mercavex AI Assistant — a helpful, concise guide built into the Mercavex marketing platform by OphidianAI.

Your role is to help users get the most out of Mercavex. You know the platform inside and out:

PLATFORM FEATURES:
• Campaign Creation — users describe their business + ad goal, pick platforms (Instagram, Facebook, LinkedIn, X/Twitter, TikTok, Pinterest, YouTube, Reddit, Telegram, Google Business), and Mercavex AI generates 3 ad variants.
• Ad Review & Revision — users approve or request revisions to each variant using natural-language feedback.
• AI Visuals — per-ad AI image generation (Flux Dev) and video generation (Kling v1.6).
• Posting — approved ads are posted to all selected platforms via Ayrshare integration. "Post Now" publishes immediately.
• Campaign Dashboard — view, duplicate, or delete past campaigns with full publish logs.
• Analytics — per-post performance metrics, platform breakdown, top performer detection, and engagement trend charts.
• Account Settings — update display name, change password, manage Ayrshare API key.

GETTING STARTED FLOW:
1. Connect Ayrshare API key (from ayrshare.com dashboard)
2. Enter business description + ad goal
3. Select target platforms
4. Optionally upload product photos
5. Generate → Review → Approve → Create Visuals → Post

GUIDELINES:
- Be warm, concise, and action-oriented. Use short paragraphs.
- If a user seems stuck, suggest the next logical step.
- Never reveal API keys, internal endpoints, or implementation details.
- If asked something outside Mercavex scope, politely redirect.
- Use the brand voice: premium, confident, helpful — think concierge, not chatbot.`;

app.post("/ai/chat", requireAuth, async (req, res) => {
  const { messages } = req.body;
  if (!messages?.length) {
    return res.status(400).json({ status: "error", message: "No messages provided." });
  }

  // Sanitise: only keep role + content, cap history at 20 turns
  const cleaned = messages.slice(-20).map(m => ({
    role: m.role === "assistant" ? "assistant" : "user",
    content: String(m.content).slice(0, 2000),
  }));

  try {
    const resp = await fetch(ANTHROPIC_BASE, {
      method: "POST",
      headers: ANTHROPIC_HEADERS,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 600,
        system: CHAT_SYSTEM_PROMPT,
        messages: cleaned,
      }),
    });
    const data = await resp.json();
    const reply = data?.content?.[0]?.text || "Sorry, I couldn't process that. Please try again.";
    res.json({ reply });
  } catch (e) {
    console.error("Chat error:", e.message);
    res.status(500).json({ status: "error", message: "Chat unavailable. Please try again." });
  }
});

// ─────────────────────────────────────────────
//  BILLING — GET /billing/status
//  Returns the user's current plan, period end,
//  and Stripe customer ID (if any).
// ─────────────────────────────────────────────
app.get("/billing/status", requireAuth, async (req, res) => {
  try {
    // Dev accounts return full agency-level capabilities, no Stripe lookup needed
    if (isDevUser(req.user.id)) {
      return res.json({
        plan:               "agency",
        planPeriodEnd:      null,
        hasCustomer:        false,
        campaignsThisMonth: 0,
        campaignLimit:      9999,
        platformLimit:      10,
        imageEnabled:       true,
        videoEnabled:       true,
        teamEnabled:        true,
        teamSeats:          4,
        exportEnabled:      true,
        whitelabelEnabled:  true,
        analyticsLevel:     "full",
      });
    }

    const { data, error } = await supabase
      .from("profiles")
      .select("plan, plan_period_end, stripe_customer_id")
      .eq("id", req.user.id)
      .single();
    if (error && error.code !== "PGRST116") throw error;

    const plan   = data?.plan || "free";
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.free;

    // Campaign count this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const { count: campaignsThisMonth } = await supabase
      .from("campaigns")
      .select("id", { count: "exact", head: true })
      .eq("user_id", req.user.id)
      .gte("created_at", monthStart.toISOString());

    res.json({
      plan,
      planPeriodEnd:       data?.plan_period_end || null,
      hasCustomer:         !!data?.stripe_customer_id,
      campaignsThisMonth:  campaignsThisMonth || 0,
      campaignLimit:       limits.campaigns,
      platformLimit:       limits.platforms,
      imageEnabled:        limits.image,
      videoEnabled:        limits.video,
      teamEnabled:         limits.teamSeats > 0,
      teamSeats:           limits.teamSeats,
      exportEnabled:       limits.export,
      whitelabelEnabled:   limits.whitelabel,
      analyticsLevel:      limits.analytics,
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  BILLING — POST /billing/create-checkout
//  Creates a Stripe Checkout Session and returns
//  the hosted URL. The frontend redirects there.
// ─────────────────────────────────────────────
app.post("/billing/create-checkout", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ status: "error", message: "Stripe not configured on server." });

  const { plan } = req.body;
  const priceId  = STRIPE_PRICE_IDS[plan];
  if (!priceId)  return res.status(400).json({ status: "error", message: `No Stripe price ID configured for plan: ${plan}` });

  try {
    // Get or create Stripe customer linked to this user
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id, full_name")
      .eq("id", req.user.id)
      .single();

    let customerId = profile?.stripe_customer_id;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email:    req.user.email,
        name:     profile?.full_name || req.user.email,
        metadata: { supabase_user_id: req.user.id },
      });
      customerId = customer.id;
      // Save customer ID for future sessions / webhook lookups
      await supabase
        .from("profiles")
        .update({ stripe_customer_id: customerId })
        .eq("id", req.user.id);
    }

    const session = await stripe.checkout.sessions.create({
      customer:            customerId,
      mode:                "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${process.env.FRONTEND_URL}?billing=success&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL}?billing=cancel`,
      subscription_data: {
        metadata: { supabase_user_id: req.user.id, plan },
      },
      allow_promotion_codes: true,
    });

    res.json({ url: session.url });
  } catch (e) {
    console.error("Checkout error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  BILLING — POST /billing/create-portal
//  Creates a Stripe Billing Portal session so
//  the user can manage/cancel their subscription.
// ─────────────────────────────────────────────
app.post("/billing/create-portal", requireAuth, async (req, res) => {
  if (!stripe) return res.status(500).json({ status: "error", message: "Stripe not configured on server." });

  try {
    const { data: profile } = await supabase
      .from("profiles")
      .select("stripe_customer_id")
      .eq("id", req.user.id)
      .single();

    if (!profile?.stripe_customer_id) {
      return res.status(400).json({ status: "error", message: "No billing account found. Please subscribe first." });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer:   profile.stripe_customer_id,
      return_url: `${process.env.FRONTEND_URL}?billing=portal-return`,
    });

    res.json({ url: portalSession.url });
  } catch (e) {
    console.error("Portal error:", e.message);
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ─────────────────────────────────────────────
//  TEAM MANAGEMENT
//
//  Supabase SQL — run once in SQL editor:
//
//  CREATE TABLE IF NOT EXISTS team_members (
//    id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
//    owner_id      UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
//    invitee_email TEXT NOT NULL,
//    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
//    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted')),
//    invited_at    TIMESTAMPTZ DEFAULT NOW(),
//    UNIQUE(owner_id, invitee_email)
//  );
//
//  ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
//
//  -- Owner can do anything with their own team rows
//  CREATE POLICY "owner_all" ON team_members
//    FOR ALL USING (owner_id = auth.uid());
//
// ─────────────────────────────────────────────

// Middleware — Agency plan only
const requireAgency = async (req, res, next) => {
  try {
    const { data } = await supabase
      .from("profiles")
      .select("plan")
      .eq("id", req.user.id)
      .single();
    if (data?.plan !== "agency") {
      return res.status(403).json({ status: "error", message: "Team management requires an Agency plan." });
    }
    next();
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
};

// Helper — normalise a DB row into the shape both UI components expect
// AccountScreen reads m.member_email; standalone TeamManagement reads m.invitee_email
const normaliseRow = (row) => ({
  id:             row.id,
  owner_id:       row.owner_id,
  invitee_email:  row.invitee_email,
  member_email:   row.invitee_email,   // alias for AccountScreen
  role:           row.role,
  status:         row.status,
  invited_at:     row.invited_at,
});

// ── GET /team  (AccountScreen — expects { members: [] })
app.get("/team", requireAuth, requireAgency, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("owner_id", req.user.id)
      .order("invited_at", { ascending: true });
    if (error) throw error;
    res.json({ members: (data || []).map(normaliseRow) });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ── GET /team/members  (standalone TeamManagement — expects raw array)
app.get("/team/members", requireAuth, requireAgency, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("team_members")
      .select("*")
      .eq("owner_id", req.user.id)
      .order("invited_at", { ascending: true });
    if (error) throw error;
    res.json((data || []).map(normaliseRow));
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ── POST /team/invite
app.post("/team/invite", requireAuth, requireAgency, async (req, res) => {
  const { email, role = "member" } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ status: "error", message: "A valid email address is required." });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanRole  = ["admin", "member"].includes(role) ? role : "member";

  // Block inviting yourself
  if (cleanEmail === req.user.email?.toLowerCase()) {
    return res.status(400).json({ status: "error", message: "You cannot invite yourself." });
  }

  try {
    // Enforce 4-seat limit
    const { count } = await supabase
      .from("team_members")
      .select("id", { count: "exact", head: true })
      .eq("owner_id", req.user.id);

    if ((count || 0) >= 4) {
      return res.status(403).json({ status: "error", message: "Seat limit reached. Agency plans support up to 4 team members." });
    }

    // Upsert — re-inviting an existing member updates their role without creating a duplicate
    const { data, error } = await supabase
      .from("team_members")
      .upsert(
        { owner_id: req.user.id, invitee_email: cleanEmail, role: cleanRole, status: "pending" },
        { onConflict: "owner_id,invitee_email", ignoreDuplicates: false }
      )
      .select()
      .single();

    if (error) throw error;

    res.json({
      status:  "ok",
      message: `Invite sent to ${cleanEmail}. They'll appear as pending until they sign in.`,
      member:  normaliseRow(data),
    });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ── PATCH /team/:id  (update role — owner-gated)
app.patch("/team/:id", requireAuth, requireAgency, async (req, res) => {
  const { role } = req.body;
  if (!["admin", "member"].includes(role)) {
    return res.status(400).json({ status: "error", message: "Role must be 'admin' or 'member'." });
  }

  try {
    const { data, error } = await supabase
      .from("team_members")
      .update({ role })
      .eq("id",       req.params.id)
      .eq("owner_id", req.user.id)      // owner-gate: can only update own team
      .select()
      .single();

    if (error) throw error;
    if (!data)  return res.status(404).json({ status: "error", message: "Member not found." });

    res.json({ status: "ok", member: normaliseRow(data) });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ── DELETE /team/:id  (AccountScreen)
app.delete("/team/:id", requireAuth, requireAgency, async (req, res) => {
  try {
    const { error } = await supabase
      .from("team_members")
      .delete()
      .eq("id",       req.params.id)
      .eq("owner_id", req.user.id);    // owner-gate

    if (error) throw error;
    res.json({ status: "ok" });
  } catch (e) {
    res.status(500).json({ status: "error", message: e.message });
  }
});

// ── DELETE /team/members/:id  (standalone TeamManagement — alias)
app.delete("/team/members/:id", requireAuth, requireAgency, async (req, res) => {
  try {
    const { error } = await supabase
      .from("team_members")
      .delete()
      .eq("id",       req.params.id)
      .eq("owner_id", req.user.id);

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
