/**
 * search-widget.js
 *
 * این فایل رو در سایتت (کنار فایل‌های htm) قرار بده و با یک تگ <script> در index.html
 * لینکش کن. دو قابلیت اضافه می‌کنه: جست‌وجوی معنایی و گفت‌وگو با آرشیو.
 *
 * قبل از استفاده، مقدار WORKER_URL رو زیر با آدرس واقعی Workerـت (بعد از deploy) عوض کن.
 * آدرس چیزی شبیه این می‌شه: https://milani-archive-ai.YOUR-SUBDOMAIN.workers.dev
 */

const WORKER_URL = "https://milani-archive-ai.YOUR-SUBDOMAIN.workers.dev";

let EMBEDDINGS = null; // کل داده‌های embeddings.json بعد از بارگذاری اینجا نگه داشته می‌شه

const DB_NAME = "milani-ai-cache";
const STORE_NAME = "embeddings";
const CACHE_KEY = "embeddings-data";

// ---------- باز کردن (یا ساخت) پایگاه‌دادهٔ محلی مرورگر ----------
function openCacheDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getCachedEmbeddings() {
  try {
    const db = await openCacheDB();
    return await new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(CACHE_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null; // اگه IndexedDB در دسترس نبود، بی‌خیال کش می‌شیم، مشکلی نیست
  }
}

async function setCachedEmbeddings(record) {
  try {
    const db = await openCacheDB();
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(record, CACHE_KEY);
  } catch {
    // ذخیره‌نشدن کش خطای مهمی نیست، جست‌وجو همچنان کار می‌کنه
  }
}

// ---------- تبدیل رشتهٔ base64 به بردار عددی (Float32Array) ----------
// چون build-embeddings.js بردارها رو فشرده (base64) ذخیره می‌کنه تا حجم فایل کم بشه،
// اینجا باید دوباره به آرایهٔ عددی قابل‌استفاده تبدیلشون کنیم.
function base64ToVector(b64) {
  const binaryString = atob(b64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new Float32Array(bytes.buffer);
}

// ---------- بارگذاری embeddings.json با کش محلی ----------
// اول یک درخواست سبک HEAD می‌زنیم تا ببینیم فایل از آخرین بار عوض شده یا نه.
// اگه عوض نشده، از نسخهٔ ذخیره‌شده در مرورگر (IndexedDB) استفاده می‌کنیم؛
// دیگه نه دانلود کامل لازمه، نه دوباره‌کدگذاری بردارها.
async function loadEmbeddings() {
  if (EMBEDDINGS) return EMBEDDINGS;

  let currentVersion = null;
  try {
    const headRes = await fetch("embeddings.json", { method: "HEAD" });
    currentVersion = headRes.headers.get("etag") || headRes.headers.get("last-modified");
  } catch {
    // اگه HEAD جواب نداد، می‌ریم سراغ دانلود کامل معمولی
  }

  const cached = await getCachedEmbeddings();
  if (cached && currentVersion && cached.version === currentVersion) {
    EMBEDDINGS = cached.data; // از کش استفاده کن، نیازی به دانلود نیست
    return EMBEDDINGS;
  }

  const res = await fetch("embeddings.json");
  const raw = await res.json();
  const decoded = raw.map((item) => ({ ...item, vector: base64ToVector(item.vector) }));

  EMBEDDINGS = decoded;

  const version = currentVersion || res.headers.get("etag") || res.headers.get("last-modified");
  if (version) {
    setCachedEmbeddings({ version, data: decoded }); // برای دفعات بعد ذخیره کن
  }

  return EMBEDDINGS;
}

// ---------- محاسبهٔ شباهت کسینوسی بین دو بردار ----------
function cosineSimilarity(a, b) {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ---------- جست‌وجوی معنایی ----------
// query: متن جست‌وجوی کاربر
// topK: چند نتیجهٔ برتر برگردونده بشه
async function semanticSearch(query, topK = 5) {
  const data = await loadEmbeddings();

  // گرفتن بردار عبارت جست‌وجو از Worker
  const embedRes = await fetch(`${WORKER_URL}/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  if (!embedRes.ok) throw new Error("خطا در دریافت بردار جست‌وجو");
  const { vector: queryVector } = await embedRes.json();

  // مقایسهٔ شباهت با همهٔ بخش‌های ذخیره‌شده
  const scored = data.map((item) => ({
    ...item,
    score: cosineSimilarity(queryVector, item.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------- گفت‌وگو (پرسش‌وپاسخ بر اساس متن‌های مرتبط) ----------
async function askQuestion(question) {
  // اول مرتبط‌ترین بخش‌ها رو با همون جست‌وجوی معنایی پیدا کن
  const relevant = await semanticSearch(question, 5);
  const contextTexts = relevant.map((r) => r.text);

  const chatRes = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, context: contextTexts }),
  });
  if (!chatRes.ok) throw new Error("خطا در دریافت پاسخ از دستیار");
  const { answer } = await chatRes.json();

  return { answer, sources: relevant };
}

// ---------- اتصال به رابط کاربری واقعی سایت (تب «دستیار هوشمند») ----------
// این id ها عمداً با پیشوند ai نگه داشته شدن تا با سیستم جست‌وجوی کلمه‌ای
// موجود سایت (که از id های searchInput/searchResults استفاده می‌کنه) تداخل نداشته باشن.

document.addEventListener("DOMContentLoaded", () => {
  const aiSearchInput = document.getElementById("aiSearchInput");
  const aiSearchResults = document.getElementById("aiSearchResults");
  const aiSearchStatus = document.getElementById("aiSearchStatus");

  if (aiSearchInput && aiSearchResults) {
    let debounceTimer;
    aiSearchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = aiSearchInput.value.trim();
        if (!query) {
          aiSearchResults.innerHTML = "";
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          return;
        }
        if (aiSearchStatus) aiSearchStatus.textContent = "در حال جست‌وجو…";
        try {
          const results = await semanticSearch(query);
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          aiSearchResults.innerHTML = results
            .map(
              (r) =>
                `<a class="ai-search-result" href="${encodeURI(r.source)}" target="_blank" rel="noopener">
                  <strong>${r.book}</strong>
                  <p>${r.text}</p>
                  <small>میزان تطابق مفهومی: ${(r.score * 100).toFixed(1)}٪ — برای مشاهدهٔ کتاب کلیک کنید</small>
                </a>`
            )
            .join("");
        } catch (err) {
          if (aiSearchStatus) aiSearchStatus.textContent = "در جست‌وجو خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
          console.error(err);
        }
      }, 400); // debounce: صبر کن کاربر تایپش تموم بشه
    });
  }

  const aiChatForm = document.getElementById("aiChatForm");
  const aiChatInput = document.getElementById("aiChatInput");
  const aiChatOutput = document.getElementById("aiChatOutput");

  if (aiChatForm && aiChatInput && aiChatOutput) {
    aiChatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = aiChatInput.value.trim();
      if (!question) return;

      aiChatOutput.innerHTML = "در حال بررسی و تنظیم پاسخ…";
      try {
        const { answer, sources } = await askQuestion(question);
        const sourceLinks = sources
          .map((s) => `<a href="${encodeURI(s.source)}" target="_blank" rel="noopener">${s.book}</a>`)
          .join("، ");
        aiChatOutput.innerHTML = `
          <div class="ai-chat-answer">${answer}</div>
          <div class="ai-chat-sources">
            مآخذ: ${sourceLinks}
          </div>
        `;
      } catch (err) {
        aiChatOutput.innerHTML = "در دریافت پاسخ خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
        console.error(err);
      }
    });
  }
});
