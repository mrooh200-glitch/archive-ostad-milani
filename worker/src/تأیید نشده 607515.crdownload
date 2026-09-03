/**
 * Cloudflare Worker
 *
 * دو endpoint داره:
 *  - POST /embed  → عبارت جست‌وجوی کاربر رو می‌گیره، بردارش رو با BGE-M3 برمی‌گردونه
 *  - POST /chat   → سؤال کاربر + متن‌های مرتبط رو می‌گیره، از Gemini پاسخ می‌گیره و برمی‌گردونه
 *
 * متغیر محیطی لازم (در wrangler.toml یا Cloudflare Dashboard تنظیم می‌شه):
 *  - GEMINI_API_KEY
 *  - AI (binding خودکار Workers AI، نیازی به کلید نداره)
 *  - EMBEDDING_CACHE (یک KV namespace — اختیاری؛ اگه بایند نشده باشه، کد بدون کش کار می‌کنه)
 *
 * تغییر جدید: کش مشترک بین همه‌ی کاربران برای عبارت‌های جست‌وجوی تکراری.
 * اگه کاربر A عبارتی رو جست‌وجو کنه، بردارش برای مدتی (یک ساعت) در KV ذخیره می‌شه؛
 * اگه کاربر B دقیقاً همون عبارت رو جست‌وجو کنه، به‌جای زدن دوباره به مدل bge-m3
 * (که سهمیه‌ی روزانه مصرف می‌کنه)، همون بردار کش‌شده مستقیم برگردونده می‌شه.
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // اگه خواستی امن‌تر بشه، به‌جای * آدرس دقیق سایتت رو بذار
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const EMBEDDING_CACHE_TTL_SECONDS = 60 * 60; // یک ساعت

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

// ---------- ساخت کلید کش از متن عبارت (نرمال‌سازی ساده: trim + یکسان‌سازی حروف) ----------
async function embeddingCacheKey(text) {
  const normalized = text.trim().toLowerCase();
  const data = new TextEncoder().encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return "embed:" + hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    // درخواست‌های preflight مرورگر (CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/embed" && request.method === "POST") {
        return await handleEmbed(request, env);
      }

      if (url.pathname === "/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }

      return jsonResponse({ error: "مسیر یا متد نامعتبر" }, 404);
    } catch (err) {
      console.error(err);
      return jsonResponse({ error: "خطای داخلی سرور", detail: String(err) }, 500);
    }
  },
};

// ---------- /embed : ساخت بردار عبارت جست‌وجو (با کش مشترک بین کاربران) ----------
async function handleEmbed(request, env) {
  const body = await request.json();
  const query = (body.query || "").trim();

  if (!query) {
    return jsonResponse({ error: "پارامتر query لازمه" }, 400);
  }

  // اول کش رو چک کن — اگه یک کاربر دیگه اخیراً دقیقاً همین عبارت رو جست‌وجو کرده،
  // بردارش رو مستقیم برگردون، بدون تماس با مدل.
  let cacheKey = null;
  if (env.EMBEDDING_CACHE) {
    cacheKey = await embeddingCacheKey(query);
    const cached = await env.EMBEDDING_CACHE.get(cacheKey, "json");
    if (cached) {
      return jsonResponse({ vector: cached });
    }
  }

  const result = await env.AI.run("@cf/baai/bge-m3", { text: [query] });
  // result.data شکل [[...vector...]] داره چون یک متن فرستادیم
  const vector = result.data[0];

  if (env.EMBEDDING_CACHE && cacheKey) {
    await env.EMBEDDING_CACHE.put(cacheKey, JSON.stringify(vector), {
      expirationTtl: EMBEDDING_CACHE_TTL_SECONDS,
    });
  }

  return jsonResponse({ vector });
}

// ---------- /chat : پاسخ‌سازی با Gemini بر اساس متن‌های مرتبط ----------
// (بدون تغییر نسبت به نسخه‌ی فعلی — فعلاً کاری به این بخش نداریم)
async function handleChat(request, env) {
  const body = await request.json();
  const question = (body.question || "").trim();
  const contextChunks = Array.isArray(body.context) ? body.context : [];

  if (!question) {
    return jsonResponse({ error: "پارامتر question لازمه" }, 400);
  }
  if (contextChunks.length === 0) {
    return jsonResponse({ error: "پارامتر context (آرایه‌ای از متن‌های مرتبط) لازمه" }, 400);
  }

  const contextText = contextChunks
    .map((c, i) => `[بخش ${i + 1}]\n${c}`)
    .join("\n\n");

  const systemPrompt = `شما دستیار پژوهشی آرشیو دیجیتال متون استاد میلانی هستید. پاسخ خود را صرفاً بر اساس متن‌های زیر که از کتاب‌ها استخراج شده، به‌صورت دقیق، رسمی و علمی ارائه دهید. در صورتی که پاسخ در این متن‌ها یافت نشد، صادقانه اعلام کنید که در منابع موجود پاسخی یافت نشد؛ از افزودن مطلبی که مستند به متن نیست خودداری کنید.

متن‌های مرتبط:
${contextText}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const geminiRes = await fetch(geminiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemPrompt}\n\nسؤال کاربر: ${question}` }],
        },
      ],
    }),
  });

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return jsonResponse({ error: "خطا در تماس با Gemini", detail: errText }, 502);
  }

  const geminiJson = await geminiRes.json();
  const answer =
    geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی دریافت نشد.";

  return jsonResponse({ answer });
}
