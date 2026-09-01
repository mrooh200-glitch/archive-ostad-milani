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

// ---------- بارگذاری اولیهٔ فایل embeddings.json ----------
async function loadEmbeddings() {
  if (EMBEDDINGS) return EMBEDDINGS;
  const res = await fetch("embeddings.json");
  EMBEDDINGS = await res.json();
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

// ---------- نمونهٔ اتصال به رابط کاربری (باید متناسب با HTML واقعی سایتت تنظیم بشه) ----------
// این بخش رو با ساختار HTML موجود سایتت هماهنگ کن.
// فرض شده سه عنصر با این id ها وجود دارن: searchInput, searchResults, و برای چت: chatInput, chatOutput

document.addEventListener("DOMContentLoaded", () => {
  const searchInput = document.getElementById("searchInput");
  const searchResults = document.getElementById("searchResults");

  if (searchInput && searchResults) {
    let debounceTimer;
    searchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        const query = searchInput.value.trim();
        if (!query) {
          searchResults.innerHTML = "";
          return;
        }
        searchResults.innerHTML = "در حال جست‌وجو...";
        try {
          const results = await semanticSearch(query);
          searchResults.innerHTML = results
            .map(
              (r) =>
                `<div class="search-result">
                  <strong>${r.book}</strong>
                  <p>${r.text}</p>
                  <small>میزان شباهت: ${(r.score * 100).toFixed(1)}٪</small>
                </div>`
            )
            .join("");
        } catch (err) {
          searchResults.innerHTML = "خطا در جست‌وجو. لطفاً دوباره امتحان کنید.";
          console.error(err);
        }
      }, 400); // debounce: صبر کن کاربر تایپش تموم بشه
    });
  }

  const chatForm = document.getElementById("chatForm");
  const chatInput = document.getElementById("chatInput");
  const chatOutput = document.getElementById("chatOutput");

  if (chatForm && chatInput && chatOutput) {
    chatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = chatInput.value.trim();
      if (!question) return;

      chatOutput.innerHTML = "در حال فکر کردن...";
      try {
        const { answer, sources } = await askQuestion(question);
        chatOutput.innerHTML = `
          <div class="chat-answer">${answer}</div>
          <div class="chat-sources">
            <small>منابع: ${sources.map((s) => s.book).join("، ")}</small>
          </div>
        `;
      } catch (err) {
        chatOutput.innerHTML = "خطا در دریافت پاسخ. لطفاً دوباره امتحان کنید.";
        console.error(err);
      }
    });
  }
});
