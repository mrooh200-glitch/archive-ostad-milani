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

// ---------- تلاش دوباره برای خطاهای موقتی Gemini (کد 503 / status UNAVAILABLE) ----------
// این فقط دورِ خودِ تماس با Gemini رو می‌گیره؛ به بقیهٔ کد کاری نداره.
// اگه بار اول موفق بشه (حالت معمول)، هیچ تأخیر اضافه‌ای ایجاد نمی‌کنه.
async function fetchGeminiWithRetry(geminiUrl, requestBody, maxAttempts = 3) {
  let lastRes;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    lastRes = await fetch(geminiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: requestBody,
    });

    if (lastRes.ok) return lastRes;

    // فقط برای خطای 503 (شلوغی موقت مدل) دوباره تلاش کن؛ بقیهٔ خطاها
    // (مثلاً کلید نامعتبر) با تلاش دوباره درست نمی‌شن، پس فوراً برگردون.
    if (lastRes.status !== 503 || attempt === maxAttempts) return lastRes;

    await new Promise((r) => setTimeout(r, 500 * attempt)); // کمی صبر قبل از تلاش بعدی
  }
  return lastRes;
}

// ---------- /chat : پاسخ‌سازی با Gemini بر اساس متن‌های مرتبط ----------
async function handleChat(request, env) {
  const body = await request.json();
  const question = (body.question || "").trim();
  const contextChunks = Array.isArray(body.context) ? body.context : [];
  // Item جدید (دو حالت پاسخ): "grounded" (پیش‌فرض، فقط بر اساس متون
  // آرشیو) یا "general" (پاسخ آزاد - دانش عمومی Gemini، بدون محدودیت
  // به متون؛ مناسب برای سلام‌واحوال‌پرسی و سؤال‌های عمومی).
  const mode = body.mode === "general" ? "general" : "grounded";
  // Item جدید (گفتگوی ادامه‌دار): تاریخچهٔ تبادل‌های قبلی همین نشست
  // (بدون سؤال فعلی) - هر آیتم باید {question, answer} با متن غیرخالی
  // باشه؛ هر آیتم ناقص یا نامعتبر نادیده گرفته می‌شه، نه این‌که کل
  // درخواست رد بشه.
  const history = Array.isArray(body.history)
    ? body.history
        .map((turn) => ({
          question: typeof turn?.question === "string" ? turn.question.trim() : "",
          answer: typeof turn?.answer === "string" ? turn.answer.trim() : "",
        }))
        .filter((turn) => turn.question && turn.answer)
    : [];

  if (!question) {
    return jsonResponse({ error: "پارامتر question لازمه" }, 400);
  }
  // Item جدید: نیاز به context فقط تو حالت grounded هست - حالت general
  // اصلاً بر پایهٔ متون آرشیو کار نمی‌کنه، پس این پارامتر رو لازم نداره.
  if (mode === "grounded" && contextChunks.length === 0) {
    return jsonResponse({ error: "پارامتر context (آرایه‌ای از متن‌های مرتبط) لازمه" }, 400);
  }

  const contextText = contextChunks
    .map((c, i) => `[بخش ${i + 1}]\n${c}`)
    .join("\n\n");

  const historyNote = history.length > 0
    ? "\n\nاین سؤال، ادامهٔ همین گفتگوست - به سؤال‌ها و پاسخ‌های قبلی که پیش از این پیام آمده توجه کن و در صورت نیاز (مثلاً اگر سؤال به «آن»، «همان مطلب»، یا موضوع قبلی اشاره داشت) پاسخ را با در نظر گرفتن آن‌ها بساز."
    : "";

  // Item جدید (پاسخ آزاد): بدون محدودیت به متون آرشیو - دستیار می‌تونه
  // از دانش عمومی خودش هم استفاده کنه و به سلام/احوال‌پرسی و سؤال‌های
  // عمومی هم طبیعی جواب بده. توجه: این هنوز دانش عمومیِ خودِ Gemini‌ـه،
  // نه جست‌وجوی زندهٔ گوگل - Gemini به‌تنهایی به اینترنت زنده دسترسی
  // نداره؛ برای اتصال واقعی به نتایج جست‌وجوی گوگل باید از قابلیت جدا و
  // پولیِ "Grounding with Google Search" در API جیمینای استفاده کرد که
  // فعلاً در این کد پیاده نشده.
  const systemPrompt = mode === "general"
    ? `شما دستیار آرشیو دیجیتال متون استاد میلانی هستید. الان در حالت «پاسخ آزاد» هستید - یعنی برخلاف حالت عادی، مجبور نیستید پاسخ را فقط از متون آرشیو بسازید. به‌صورت طبیعی، دوستانه و مختصر پاسخ بدید - از جمله به سلام، احوال‌پرسی، و سؤال‌های عمومی که ربطی به متون آرشیو ندارند. اگه سؤال به موضوعات تخصصی این آرشیو (فلسفه، عرفان، کلام اسلامی) مربوط بود، از دانش عمومی خودتون کمک بگیرید، ولی صادقانه بگید این پاسخ مستند به متون آرشیو نیست.${historyNote}`
    : `شما دستیار پژوهشی آرشیو دیجیتال متون استاد میلانی هستید. پاسخ خود را صرفاً بر اساس متن‌های زیر که از کتاب‌ها استخراج شده، به‌صورت دقیق، رسمی و علمی ارائه دهید. در صورتی که پاسخ در این متن‌ها یافت نشد، صادقانه اعلام کنید که در منابع موجود پاسخی یافت نشد؛ از افزودن مطلبی که مستند به متن نیست خودداری کنید.

مطلب را مستقیم و قاطع بیان کنید — پاسخ را با عباراتی مانند «طبق این متون...»، «بر اساس منابع فوق...» یا هر مقدمه‌چینی مشابه شروع نکنید؛ این نوع عبارات، با وجود قصد بی‌طرفی، عملاً به اعتبار و قاطعیت پاسخ خدشه وارد می‌کند. کافی است در پایان پاسخ، مآخذ ذکر شود (که به‌صورت خودکار در رابط کاربری اضافه می‌شود)؛ نیازی به تکرار «طبق متن» در ابتدای هر جمله یا پاراگراف نیست.${historyNote}

مهم (برای تشخیص منابع واقعاً مرتبط): هر «بخش» زیر یه شماره داره. ممکنه بعضی از این بخش‌ها اصلاً به سؤال ربطی نداشته باشن (چون جست‌وجوی معنایی صرفاً نزدیک‌ترین‌ها رو آورده، نه لزوماً مرتبط‌ترین‌ها). در **آخرین خط** پاسخ خودتون (بعد از یه خط خالی، جدا از متن اصلی پاسخ)، دقیقاً به این شکل بنویسید کدوم شماره‌بخش‌ها واقعاً در ساختن این پاسخ استفاده شدن:
REFERENCES: 1,3
(اگه فقط از یه بخش استفاده شد: REFERENCES: 2 — اگه هیچ‌کدوم واقعاً مرتبط نبودن: REFERENCES: none)
این خط رو دقیقاً با همین قالب (REFERENCES: به انگلیسی، بدون توضیح اضافه) بنویسید؛ رابط کاربری این خط رو خودش پردازش می‌کنه و از دید کاربر حذفش می‌کنه.

متن‌های مرتبط:
${contextText}`;

  const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  // Item جدید (گفتگوی ادامه‌دار): هر تبادل قبلیِ همین نشست، به‌صورت یک
  // نوبت واقعی user + یک نوبت واقعی model قبل از سؤال فعلی اضافه می‌شه -
  // این‌جوری Gemini واقعاً می‌بینه چه سؤال‌هایی قبلاً پرسیده شده و چه
  // جوابی داده، نه این‌که هر بار انگار اولین سؤاله. متن‌های مرتبط
  // (context) چون برای هر سؤال جدا از نو با جست‌وجوی معنایی پیدا می‌شن،
  // فقط به نوبت فعلی (نه نوبت‌های قبلی تاریخچه) ضمیمه می‌شن.
  const contents = [];

  for (const turn of history) {
    contents.push({ role: "user", parts: [{ text: turn.question }] });
    contents.push({ role: "model", parts: [{ text: turn.answer }] });
  }

  // Item جدید (پیوست عکس): اگه کاربر یه عکس همراه پرسش فرستاده باشه،
  // به‌عنوان یه قسمت جدا (inline_data) کنار متن سؤال به Gemini داده
  // می‌شه - فقط برای همین یه پرسش، نه برای کل تاریخچه.
  const parts = [{ text: `${systemPrompt}\n\nسؤال کاربر: ${question}` }];

  if (body.image && typeof body.image.base64 === "string" && typeof body.image.mimeType === "string") {
    parts.push({
      inline_data: {
        mime_type: body.image.mimeType,
        data: body.image.base64,
      },
    });
  }

  contents.push({ role: "user", parts });

  const geminiRequestBody = JSON.stringify({ contents });

  const geminiRes = await fetchGeminiWithRetry(geminiUrl, geminiRequestBody);

  if (!geminiRes.ok) {
    const errText = await geminiRes.text();
    return jsonResponse({ error: "خطا در تماس با Gemini", detail: errText }, 502);
  }

  const geminiJson = await geminiRes.json();
  const rawAnswer =
    geminiJson.candidates?.[0]?.content?.parts?.[0]?.text || "پاسخی دریافت نشد.";

  // آیتم ۱۰ (فیلتر ارتباط): خط REFERENCES رو از متنِ دیده‌شده توسط
  // کاربر جدا می‌کنیم و اندیس‌های استفاده‌شده رو استخراج می‌کنیم - تا
  // فقط منابعی که واقعاً استفاده شدن (نه هرچی که جست‌وجوی معنایی
  // برگردونده) به کاربر نشون داده بشه.
  let answer = rawAnswer;
  let usedReferences = null; // null یعنی "نمی‌دونیم" (مثلاً حالت general)

  if (mode === "grounded") {
    const match = rawAnswer.match(/\n?REFERENCES:\s*([^\n]*)\s*$/i);
    if (match) {
      answer = rawAnswer.slice(0, match.index).trim();
      const refsRaw = match[1].trim().toLowerCase();
      usedReferences = refsRaw === "none" || refsRaw === ""
        ? []
        : refsRaw.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
    }
  }

  return jsonResponse({ answer, usedReferences });
}
