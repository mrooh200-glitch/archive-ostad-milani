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
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // اگه خواستی امن‌تر بشه، به‌جای * آدرس دقیق سایتت رو بذار
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
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

// ---------- /embed : ساخت بردار عبارت جست‌وجو ----------
async function handleEmbed(request, env) {
  const body = await request.json();
  const query = (body.query || "").trim();

  if (!query) {
    return jsonResponse({ error: "پارامتر query لازمه" }, 400);
  }

  const result = await env.AI.run("@cf/baai/bge-m3", { text: [query] });
  // result.data شکل [[...vector...]] داره چون یک متن فرستادیم
  const vector = result.data[0];

  return jsonResponse({ vector });
}

// ---------- /chat : پاسخ‌سازی با Gemini بر اساس متن‌های مرتبط ----------
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

  const systemPrompt = `تو دستیار آرشیو دیجیتال متون استاد میلانی هستی. فقط بر اساس متن‌های زیر که از کتاب‌ها استخراج شده، به سؤال کاربر پاسخ بده. اگه پاسخ در این متن‌ها نبود، صادقانه بگو که در منابع موجود پاسخی پیدا نشد؛ چیزی رو از خودت اضافه نکن.

متن‌های مرتبط:
${contextText}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${env.GEMINI_API_KEY}`;

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
