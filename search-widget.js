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

// ---------- بارگذاری اولیهٔ فایل embeddings.json ----------
async function loadEmbeddings() {
  if (EMBEDDINGS) return EMBEDDINGS;
  const res = await fetch("embeddings.json");
  const raw = await res.json();
  // بردار هر بخش رو یک‌بار (نه هر بار جست‌وجو) از base64 به عدد تبدیل می‌کنیم
  EMBEDDINGS = raw.map((item) => ({ ...item, vector: base64ToVector(item.vector) }));
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
        if (aiSearchStatus) aiSearchStatus.textContent = "در حال جست‌وجو...";
        try {
          const results = await semanticSearch(query);
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          aiSearchResults.innerHTML = results
            .map(
              (r) =>
                `<div class="ai-search-result">
                  <strong>${r.book}</strong>
                  <p>${r.text}</p>
                  <small>میزان شباهت: ${(r.score * 100).toFixed(1)}٪</small>
                </div>`
            )
            .join("");
        } catch (err) {
          if (aiSearchStatus) aiSearchStatus.textContent = "خطا در جست‌وجو. لطفاً دوباره امتحان کنید.";
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

      aiChatOutput.innerHTML = "در حال فکر کردن...";
      try {
        const { answer, sources } = await askQuestion(question);
        aiChatOutput.innerHTML = `
          <div class="ai-chat-answer">${answer}</div>
          <div class="ai-chat-sources">
            منابع: ${sources.map((s) => s.book).join("، ")}
          </div>
        `;
      } catch (err) {
        aiChatOutput.innerHTML = "خطا در دریافت پاسخ. لطفاً دوباره امتحان کنید.";
        console.error(err);
      }
    });
  }
});
