/**
 * search-widget.js
 *
 * این فایل رو در سایتت (کنار فایل‌های htm) قرار بده و با یک تگ <script> در index.html
 * لینکش کن. دو قابلیت اضافه می‌کنه: جست‌وجوی معنایی و گفت‌وگو با آرشیو.
 *
 * قبل از استفاده، مقدار WORKER_URL رو زیر با آدرس واقعی Workerـت (بعد از deploy) عوض کن.
 * آدرس چیزی شبیه این می‌شه: https://milani-archive-ai.YOUR-SUBDOMAIN.workers.dev
 */

const WORKER_URL = "https://milani-archive-ai.mrooh200.workers.dev";

let EMBEDDINGS = null; // کل داده‌های embeddings.json بعد از بارگذاری اینجا نگه داشته می‌شه
let embeddingsLoadingPromise = null; // جلوگیری از دانلود همزمان/تکراری وقتی چند جست‌وجو هم‌پوشانی دارن

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

// ---------- گرفتن نسخهٔ فعلی از فایل کوچک نسخه ----------
// به‌جای تکیه به هدرهای HTTP (etag/last-modified) که روی GitHub Pages همیشه
// قابل‌اعتماد نیستن، یک فایل کوچک جدا به اسم embeddings-version.json داریم که
// خودِ build-embeddings.js هر بار با هش واقعی محتوای جدید می‌سازه.
async function getRemoteVersion() {
  try {
    const res = await fetch("embeddings-version.json", { cache: "no-store" });
    if (!res.ok) return null;
    const json = await res.json();
    return json.version || null;
  } catch {
    return null;
  }
}

// ---------- بارگذاری embeddings.json با کش محلی ----------
// اول فایل کوچک نسخه رو می‌خونیم. اگه با نسخهٔ ذخیره‌شده در مرورگر (IndexedDB)
// یکی بود، از همون کش استفاده می‌کنیم؛ دیگه نه دانلود کامل لازمه، نه
// دوباره‌کدگذاری بردارها. علاوه بر این، اگه چند جست‌وجو هم‌زمان (یا با هم‌پوشانی)
// این تابع رو صدا بزنن، همه به یک Promise در حال اجرا وصل می‌شن تا فایل
// حجیم embeddings.json به‌جای یک‌بار، چندبار موازی دانلود نشه.
async function loadEmbeddings() {
  if (EMBEDDINGS) return EMBEDDINGS;
  if (embeddingsLoadingPromise) return embeddingsLoadingPromise;

  embeddingsLoadingPromise = (async () => {
    const currentVersion = await getRemoteVersion();

    const cached = await getCachedEmbeddings();
    if (cached && currentVersion && cached.version === currentVersion) {
      EMBEDDINGS = cached.data; // از کش استفاده کن، نیازی به دانلود نیست
      return EMBEDDINGS;
    }

    // شماره‌نسخه رو به‌عنوان query string به آدرس اضافه می‌کنیم تا وقتی محتوا عوض
    // می‌شه، آدرس درخواست هم عوض بشه — این‌جوری نه کش مرورگر، نه کش سرویس‌دهندهٔ
    // GitHub Pages (که با هدر cache به‌تنهایی کنترل نمی‌شه) نمی‌تونه جواب قدیمی
    // برگردونه، چون از نظر فنی این یه URL کاملاً متفاوته. اگه گرفتن نسخه شکست
    // خورده باشه (currentVersion خالیه)، مثل قبل بدون query string درخواست می‌دیم.
    const embeddingsUrl = currentVersion
      ? `embeddings.json?v=${encodeURIComponent(currentVersion)}`
      : "embeddings.json";
    const res = await fetch(embeddingsUrl, { cache: "no-store" });
    const raw = await res.json();
    const decoded = raw.map((item) => ({ ...item, vector: base64ToVector(item.vector) }));

    EMBEDDINGS = decoded;

    if (currentVersion) {
      setCachedEmbeddings({ version: currentVersion, data: decoded }); // برای دفعات بعد ذخیره کن
    }

    return EMBEDDINGS;
  })();

  try {
    return await embeddingsLoadingPromise;
  } finally {
    embeddingsLoadingPromise = null; // اگه خطا داد، دفعهٔ بعد اجازهٔ تلاش دوباره بده
  }
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
  if (!embedRes.ok) {
    // اگه Worker یه پیام فارسی مشخص برگردونده (مثلاً سهمیهٔ روزانه تموم شده
    // یا سرویس موقتاً شلوغه)، همون رو نشون بده؛ وگرنه پیام عمومی.
    let message = "خطا در دریافت بردار جست‌وجو";
    try {
      const errBody = await embedRes.json();
      if (errBody && errBody.error) message = errBody.error;
    } catch {
      // بدنهٔ خطا JSON نبود، از پیام پیش‌فرض استفاده کن
    }
    throw new Error(message);
  }
  const { vector: queryVector } = await embedRes.json();

  // مقایسهٔ شباهت با همهٔ بخش‌های ذخیره‌شده
  const scored = data.map((item) => ({
    ...item,
    score: cosineSimilarity(queryVector, item.vector),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// ---------- ساخت لینک به همان قطعهٔ متنی داخل صفحه (Text Fragment مرورگر) ----------
// این یه ویژگی استاندارد مرورگرهاست: با اضافه‌کردن #:~:text=... به انتهای لینک،
// مرورگر خودش صفحه رو تا اون متن اسکرول و هایلایتش می‌کنه — بدون نیاز به id یا
// هیچ تغییری تو فایل‌های htm کتاب‌ها. چون متن‌های تکه‌ها می‌تونن طولانی باشن،
// به‌جای کل متن، فقط چند کلمهٔ اول و چند کلمهٔ آخرش رو به‌عنوان «شروع» و «پایان»
// بازه‌ی هایلایت می‌فرستیم؛ مرورگر خودش بین این دو رو کامل هایلایت می‌کنه.
function textFragmentUrl(baseUrl, text) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return baseUrl;

  const startWords = words.slice(0, 6).join(" ");
  const endWords = words.length > 12 ? words.slice(-6).join(" ") : null;

  const fragment = endWords
    ? `${encodeURIComponent(startWords)},${encodeURIComponent(endWords)}`
    : encodeURIComponent(startWords);

  return `${baseUrl}#:~:text=${fragment}`;
}

// ---------- گفت‌وگو (پرسش‌وپاسخ بر اساس متن‌های مرتبط) ----------
// Item جدید (گفتگوی ادامه‌دار): history آرایه‌ای از تبادل‌های قبلی همین
// نشست است ({question, answer})، نه شامل سؤال فعلی. این آرایه به Worker
// فرستاده می‌شود تا (بعد از این‌که سمت worker/src/index.js هم همین
// تاریخچه را به پرامپت Gemini اضافه کند) پاسخ بعدی واقعاً با در نظر
// گرفتن سؤال‌های قبلی همین گفتگو ساخته شود - نه این‌که هر پرسش، بی‌خبر
// از پرسش‌های قبلی، از صفر پاسخ داده شود.
async function askQuestion(question, history = []) {
  // اول مرتبط‌ترین بخش‌ها رو با همون جست‌وجوی معنایی پیدا کن
  const relevant = await semanticSearch(question, 5);
  const contextTexts = relevant.map((r) => r.text);

  const chatRes = await fetch(`${WORKER_URL}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question, context: contextTexts, history }),
  });
  if (!chatRes.ok) {
    let message = "خطا در دریافت پاسخ از دستیار";
    try {
      const errBody = await chatRes.json();
      if (errBody && errBody.error) message = errBody.error;
    } catch {
      // بدنهٔ خطا JSON نبود، از پیام پیش‌فرض استفاده کن
    }
    throw new Error(message);
  }
  const { answer } = await chatRes.json();

  return { answer, sources: relevant };
}

// ============================================================
// Item جدید: کپی، خروجی‌های سه‌گانه (Text/Word/PDF)، و افزودن به نشانه‌ها
// برای جست‌وجوی معنایی و گفت‌وگو — هم‌خانواده با قابلیت مشابهی که قبلاً
// برای جست‌وجوی متنی سایت (index.htm) ساخته شده. از همون کلید
// localStorage استفاده می‌کنیم تا این نتایج هم توی همون پنل «نشانه‌ها»ی
// سایت، کنار نتایج جست‌وجوی متنی، نشون داده بشن.
//
// رفع اشکال بحرانی: قبلاً این‌جا اشتباهاً از کلید آرشیو
// ("milaniSearchResultsArchive") استفاده می‌شد، نه کلید واقعی نشانه‌ها
// ("milaniBookmarks" — همون چیزی که in-page-search.js و دکمهٔ
// «🔖 نشانه‌ها» می‌خونن). یعنی دکمهٔ «افزودن به نشانه» تو این بخش،
// درواقع داشت آیتم رو تو آرشیو ذخیره می‌کرد، نه نشانه‌ها — برای همین
// چیزی که اضافه می‌شد، هیچ‌وقت تو پنل «نشانه‌ها» دیده نمی‌شد.
// ============================================================

const AI_BOOKMARKS_STORAGE_KEY = "milaniBookmarks";

function escapeHtmlAi(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function downloadTextFileAi(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType || "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyTextToClipboardAi(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // به روش قدیمی‌تر زیر برمی‌گردیم
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

// کپی به‌صورت متن غنی، تا هرجا پیست بشه (جیمیل، Word، واتس‌اپ وب) یه
// لینک کوتاه و کلیک‌پذیر «لینک منبع» نشون بده، نه آدرس کامل و طولانی.
async function copyRichTextAi(plainText, html) {
  try {
    if (navigator.clipboard && window.isSecureContext && window.ClipboardItem) {
      const item = new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([plainText], { type: "text/plain" }),
      });
      await navigator.clipboard.write([item]);
      return true;
    }
  } catch {
    // به روش قدیمی‌تر زیر برمی‌گردیم
  }
  try {
    const container = document.createElement("div");
    container.innerHTML = html;
    container.style.position = "fixed";
    container.style.opacity = "0";
    container.style.direction = "rtl";
    document.body.appendChild(container);
    const range = document.createRange();
    range.selectNodeContents(container);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const ok = document.execCommand("copy");
    selection.removeAllRanges();
    document.body.removeChild(container);
    return ok;
  } catch {
    return copyTextToClipboardAi(plainText);
  }
}

function loadBookmarksAi() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_BOOKMARKS_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveBookmarksAi(items) {
  try {
    localStorage.setItem(AI_BOOKMARKS_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ذخیره‌نشدن نشانه خطای مهمی نیست، کاربر می‌تونه دوباره امتحان کنه
  }
}

function addItemsToBookmarksAi(items) {
  const bookmarks = loadBookmarksAi();
  items.forEach((item) => {
    bookmarks.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: item.title,
      text: item.text,
      url: item.url,
      // این فیلدها رو هم‌شکل با نشانه‌های ساخته‌شده تو in-page-search.js
      // نگه می‌داریم (حتی اگه اینجا همیشه خالی/پیش‌فرض باشن) تا پنل
      // مشترک «نشانه‌ها» بدون فرض اضافه، هر دو نوع نشانه رو یکسان رندر کنه.
      tags: [],
      links: [],
      occurrenceIndex: 1,
      page: item.page || null,
      savedAt: new Date().toISOString(),
    });
  });
  saveBookmarksAi(bookmarks);
}

// ---------- آرشیو گفتگوها (تاریخچهٔ کامل گفتگوهای پیشین با دستیار) ----------
const AI_CHAT_ARCHIVE_STORAGE_KEY = "milaniChatConversationsArchive";

function loadChatArchiveAi() {
  try {
    const parsed = JSON.parse(localStorage.getItem(AI_CHAT_ARCHIVE_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveChatArchiveAi(items) {
  try {
    localStorage.setItem(AI_CHAT_ARCHIVE_STORAGE_KEY, JSON.stringify(items));
  } catch {
    // ذخیره‌نشدن آرشیو گفتگو خطای مهمی نیست
  }
}

// Item جدید: فهرست یکتای همهٔ کتاب‌هایی که در طول کل گفتگو (همهٔ
// تبادل‌ها، نه فقط آخری) به‌عنوان منبع استفاده شدن، هرکدوم با شماره
// صفحه‌اش - دقیقاً همون چیزی که برای عنوان آیتم آرشیوشده لازمه.
function collectConversationSourcesAi(chatTurns) {
  const seenBooks = new Set();
  const sourcesInfo = [];
  chatTurns.forEach((turn) => {
    (turn.sourcesInfo || []).forEach((s) => {
      if (seenBooks.has(s.book)) return;
      seenBooks.add(s.book);
      sourcesInfo.push(s);
    });
  });
  return sourcesInfo;
}

// اگه گفتگوی فعلی خالی نباشه، کل آن رو به‌عنوان یک آیتم به آرشیو
// گفتگوها اضافه می‌کنه؛ گفتگوی خالی (هیچ سؤالی پرسیده نشده) ذخیره نمی‌شه.
function archiveCurrentChatConversationAi(chatTurns) {
  if (!chatTurns || chatTurns.length === 0) return;

  const archive = loadChatArchiveAi();
  archive.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    turns: chatTurns.map((turn) => ({
      question: turn.question,
      answer: turn.answer,
      sourcesInfo: turn.sourcesInfo || [],
    })),
    sourcesInfo: collectConversationSourcesAi(chatTurns),
    savedAt: new Date().toISOString(),
  });
  saveChatArchiveAi(archive);
}

function removeChatConversationAi(id) {
  saveChatArchiveAi(loadChatArchiveAi().filter((c) => c.id !== id));
  renderChatArchivePanelAi();
}

// Item جدید: هر گفتگوی آرشیوشده، دقیقاً با همون قالب سؤال/پاسخ‌ازکتاب
// که برای خروجی تک‌تبادلی ساختیم رندر می‌شه - فقط پشت‌سرهم، برای همهٔ
// تبادل‌های همون گفتگو.
function renderChatArchivePanelAi() {
  const panel = document.getElementById("aiChatArchivePanel");
  if (!panel) return;

  const conversations = loadChatArchiveAi().slice().reverse();

  const listHtml = conversations.length === 0
    ? `<p class="archive-empty">هنوز گفتگویی در آرشیو ذخیره نشده است.</p>`
    : conversations
        .map((conv) => {
          const headerSources = formatSourcesInfoLineAi(conv.sourcesInfo);
          const turnsHtml = conv.turns
            .map((turn) => {
              const sourcesLine = formatSourcesInfoLineAi(turn.sourcesInfo);
              return `
                <div class="ai-chat-turn">
                  <div class="ai-chat-question">${escapeHtmlAi(normalizeQuestionTextAi(turn.question))}</div>
                  ${sourcesLine ? `<div class="ai-chat-sources">پاسخ از کتاب ${escapeHtmlAi(sourcesLine)}</div>` : ""}
                  <div class="ai-chat-answer">${turn.answer}</div>
                </div>
              `;
            })
            .join("");

          return `
            <div class="archive-item">
              <div class="archive-item-title">${headerSources ? escapeHtmlAi(headerSources) : "کتاب‌های نامشخص"}</div>
              ${turnsHtml}
              <div class="archive-item-actions">
                <button type="button" data-chat-archive-id="${escapeHtmlAi(conv.id)}">حذف</button>
              </div>
            </div>
          `;
        })
        .join("");

  panel.innerHTML = `
    <div class="archive-header">
      <span>آرشیو گفتگوها (${conversations.length})</span>
      <div class="archive-header-actions">
        <button type="button" id="aiChatArchiveClose">بستن</button>
      </div>
    </div>
    ${listHtml}
  `;

  const closeButton = panel.querySelector("#aiChatArchiveClose");
  if (closeButton) {
    closeButton.addEventListener("click", closeChatArchivePanelAi);
  }

  panel.querySelectorAll("[data-chat-archive-id]").forEach((button) => {
    button.addEventListener("click", () => {
      removeChatConversationAi(button.dataset.chatArchiveId);
    });
  });
}

function openChatArchivePanelAi() {
  renderChatArchivePanelAi();
  const overlay = document.getElementById("aiChatArchiveOverlay");
  if (overlay) overlay.classList.add("open");
}

function closeChatArchivePanelAi() {
  const overlay = document.getElementById("aiChatArchiveOverlay");
  if (overlay) overlay.classList.remove("open");
}

// ---------- ساخت متن ساده / HTML غنی / سند Word / برگهٔ چاپی از یک لیست آیتم {title, text, url} ----------
// Item جدید: سؤال گاهی به‌خاطر فاصله‌های اضافه یا خط‌جدیدهای نامرتب (مثلاً
// از کپی‌پیست) به‌هم‌ریخته است؛ این تابع فقط همین فاصله‌گذاری رو یکسان و
// مرتب می‌کنه - نه غلط‌گیری املایی یا بازنویسی معنایی سؤال.
function normalizeQuestionTextAi(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// Item جدید: خط «پاسخ از کتاب...» برای خروجی‌های گفتگو - هر کتاب یک‌بار،
// با شماره صفحه‌اش کنارش (فقط اگه آن کتاب صفحه داشته باشه).
function formatSourcesInfoLineAi(sourcesInfo) {
  if (!Array.isArray(sourcesInfo) || sourcesInfo.length === 0) return "";
  return sourcesInfo
    .map((s) => (s.page ? `${s.book} (صفحهٔ ${s.page})` : s.book))
    .join("، ");
}

function buildPlainTextForItemsAi(items) {
  const divider = "─".repeat(32);
  return items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoLineAi(item.sourcesInfo);
        return (
          `${i + 1}. سؤال: ${normalizeQuestionTextAi(item.question)}\n` +
          (sourcesLine ? `   پاسخ از کتاب ${sourcesLine}:\n` : "   پاسخ:\n") +
          `${divider}\n«${item.answer}»`
        );
      }

      return (
        `${i + 1}. 📘 ${item.title}${item.page ? ` — صفحهٔ ${item.page}` : ""}\n${divider}\n«${item.text}»` +
        (item.url ? `\n🔗 لینک: ${item.url}` : "")
      );
    })
    .join("\n\n");
}

function buildRichHtmlForItemsAi(items) {
  return items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoLineAi(item.sourcesInfo);
        return (
          `<div dir="ltr" style="margin:0 0 16px;text-align:right;">` +
          `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `font-weight:bold;color:#173b63;text-align:right;">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</p>` +
          (sourcesLine
            ? `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;` +
              `color:#1d4ed8;text-align:right;">پاسخ از کتاب ${escapeHtmlAi(sourcesLine)}:</p>`
            : "") +
          `<p dir="ltr" style="margin:0;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `line-height:1.9;color:#1f2937;text-align:right;">«${escapeHtmlAi(item.answer)}»</p>` +
          `</div>`
        );
      }

      return (
        `<div dir="ltr" style="margin:0 0 16px;text-align:right;">` +
        `<table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 8px;">` +
        `<tr><td style="padding:9px 14px;background:#eff6ff;border-right:4px solid #2563eb;` +
        `font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;color:#173b63;text-align:right;">` +
        `📘\u00a0${escapeHtmlAi(item.title)}${item.page ? `\u00a0—\u00a0صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</td></tr></table>` +
        `<p dir="ltr" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
        `line-height:1.9;color:#1f2937;text-align:right;"><strong>${i + 1}.</strong>\u00a0«${escapeHtmlAi(item.text)}»</p>` +
        (item.url
          ? `<p dir="ltr" style="margin:0;font-family:Tahoma,Arial,sans-serif;font-size:12px;text-align:right;">🔗 ` +
            `<a href="${escapeHtmlAi(item.url)}" style="color:#1d4ed8;text-decoration:none;">لینک منبع</a></p>`
          : "") +
        `</div>`
      );
    })
    .join("");
}

function buildWordDocForItemsAi(items) {
  const itemsHtml = items
    .map((item, i) => {
      const topMargin = i === 0 ? "0" : "18px";

      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoLineAi(item.sourcesInfo);
        return (
          `<p dir="rtl" style="margin:${topMargin} 0 3px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `font-weight:bold;color:#173b63;text-align:right;">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</p>` +
          (sourcesLine
            ? `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;` +
              `color:#1d4ed8;text-align:right;">پاسخ از کتاب ${escapeHtmlAi(sourcesLine)}:</p>`
            : "") +
          `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
          `line-height:1.9;color:#1f2937;text-align:right;">«${escapeHtmlAi(item.answer)}»</p>`
        );
      }

      return (
        `<table dir="ltr" role="presentation" style="width:100%;border-collapse:collapse;margin:${topMargin} 0 8px;">` +
        `<tr><td style="padding:9px 14px;background:#eff6ff;border-right:4px solid #2563eb;` +
        `font-family:Tahoma,Arial,sans-serif;font-size:14px;font-weight:bold;color:#173b63;text-align:right;">` +
        `📘\u00a0${escapeHtmlAi(item.title)}${item.page ? `\u00a0—\u00a0صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</td></tr></table>` +
        `<p dir="rtl" style="margin:0 0 3px;font-family:Tahoma,Arial,sans-serif;font-size:14px;` +
        `line-height:1.9;color:#1f2937;text-align:right;"><strong>${i + 1}.</strong>\u00a0«${escapeHtmlAi(item.text)}»</p>` +
        (item.url
          ? `<p dir="rtl" style="margin:0 0 4px;font-family:Tahoma,Arial,sans-serif;font-size:12px;text-align:right;">🔗 ` +
            `<a href="${escapeHtmlAi(item.url)}" style="color:#1d4ed8;text-decoration:none;">لینک منبع</a></p>`
          : "")
      );
    })
    .join("");

  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta charset="utf-8">
      <title>خروجی دستیار هوشمند</title>
      <!--[if gte mso 9]>
      <xml><w:WordDocument><w:View>Print</w:View><w:DoNotOptimizeForBrowser/></w:WordDocument></xml>
      <![endif]-->
    </head>
    <body dir="rtl" style="font-family:Tahoma,Arial,sans-serif;">${itemsHtml}</body>
  </html>`;
}

function openPrintableForItemsAi(items) {
  const itemsHtml = items
    .map((item, i) => {
      if (item.kind === "chat") {
        const sourcesLine = formatSourcesInfoLineAi(item.sourcesInfo);
        return `
      <div class="export-item">
        <div class="export-book-title">${i + 1}. سؤال: ${escapeHtmlAi(normalizeQuestionTextAi(item.question))}</div>
        ${sourcesLine ? `<p class="export-page">پاسخ از کتاب ${escapeHtmlAi(sourcesLine)}:</p>` : ""}
        <p class="export-snippet">«${escapeHtmlAi(item.answer)}»</p>
      </div>`;
      }

      return `
      <div class="export-item">
        <div class="export-book-title">📘 ${escapeHtmlAi(item.title)}${item.page ? ` — صفحهٔ ${escapeHtmlAi(String(item.page))}` : ""}</div>
        <p class="export-snippet"><strong>${i + 1}.</strong>&nbsp;«${escapeHtmlAi(item.text)}»</p>
        ${item.url ? `<p class="export-link">🔗 <a href="${escapeHtmlAi(item.url)}">لینک منبع</a></p>` : ""}
      </div>`;
    })
    .join("");

  const doc = `<!DOCTYPE html>
    <html lang="fa" dir="rtl">
    <head>
      <meta charset="utf-8">
      <title>خروجی دستیار هوشمند</title>
      <style>
        * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        body { font-family: Tahoma, Arial, sans-serif; direction: rtl; text-align: right; color: #1f2937; margin: 24px; }
        .export-item { padding: 10px 0; border-bottom: 1px solid #e2e8f0; }
        .export-book-title { margin: 0 0 6px; padding: 8px 12px; background: #eff6ff; border-right: 4px solid #2563eb; border-radius: 6px; font-size: 14px; font-weight: bold; color: #173b63; }
        .export-snippet { margin: 0 0 4px; font-size: 15px; line-height: 2; }
        .export-page { margin: 0 0 4px; font-size: 12px; color: #1d4ed8; }
        .export-link { margin: 0; font-size: 12px; }
        .export-link a { color: #1d4ed8; text-decoration: none; }
        @media print { body { margin: 10mm; } }
      </style>
    </head>
    <body>${itemsHtml}<script>window.onload = () => window.print();<\/script></body>
    </html>`;

  const printWindow = window.open("", "_blank");
  if (!printWindow) return;
  printWindow.document.open();
  printWindow.document.write(doc);
  printWindow.document.close();
}

// ---------- ساخت نوار ابزار (کپی / Text / Word / PDF / نشانه) ----------
// getItems: تابعی که هروقت روی دکمه‌ای کلیک شد، لیست فعلی آیتم‌های
// {title, text, url} رو برمی‌گردونه — برای جست‌وجو: موارد تیک‌خورده؛
// برای چت: همون یک پاسخ فعلی.
function createAiToolbar(getItems, emptyMessage) {
  const bar = document.createElement("div");
  bar.className = "ai-result-toolbar";
  bar.innerHTML = `
    <button type="button" class="ai-toolbar-btn" data-action="copy">📋 کپی</button>
    <button type="button" class="ai-toolbar-btn" data-action="text">دریافت Text</button>
    <button type="button" class="ai-toolbar-btn" data-action="word">دریافت Word</button>
    <button type="button" class="ai-toolbar-btn" data-action="pdf">دریافت PDF</button>
    <button type="button" class="ai-toolbar-btn" data-action="bookmark">⭐ افزودن به نشانه</button>
    <button type="button" class="ai-toolbar-btn" data-action="view-bookmarks">🔖 مشاهدهٔ نشانه‌ها</button>
    <span class="ai-toolbar-status" aria-live="polite"></span>
  `;

  const status = bar.querySelector(".ai-toolbar-status");
  function setStatus(msg) {
    if (!status) return;
    status.textContent = msg;
    setTimeout(() => { status.textContent = ""; }, 1800);
  }

  bar.addEventListener("click", async (e) => {
    const btn = e.target.closest(".ai-toolbar-btn");
    if (!btn) return;

    const action = btn.dataset.action;

    // Item جدید: مشاهدهٔ نشانه‌ها به آیتم انتخاب‌شده نیازی نداره - برخلاف
    // بقیهٔ دکمه‌ها، همیشه باید کار کنه، حتی وقتی چیزی انتخاب/تولید نشده.
    if (action === "view-bookmarks") {
      if (typeof openBookmarksPanel === "function") {
        openBookmarksPanel();
      }
      return;
    }

    const items = getItems();
    if (!items || items.length === 0) {
      setStatus(emptyMessage || "چیزی انتخاب نشده");
      return;
    }

    if (action === "copy") {
      const ok = await copyRichTextAi(buildPlainTextForItemsAi(items), buildRichHtmlForItemsAi(items));
      setStatus(ok ? "کپی شد!" : "خطا در کپی");
    } else if (action === "text") {
      downloadTextFileAi("خروجی-دستیار-هوشمند.txt", buildPlainTextForItemsAi(items));
    } else if (action === "word") {
      downloadTextFileAi("خروجی-دستیار-هوشمند.doc", buildWordDocForItemsAi(items), "application/msword;charset=utf-8");
    } else if (action === "pdf") {
      openPrintableForItemsAi(items);
    } else if (action === "bookmark") {
      addItemsToBookmarksAi(items);
      setStatus("به نشانه‌ها افزوده شد");
    }
  });

  return bar;
}

// ---------- استایل کمی برای ردیف چک‌باکس و نوار ابزار جدید ----------
// چون این کلاس‌ها تو stylesheet خودِ index.htm تعریف نشدن، همین‌جا با JS
// تزریق می‌شن تا نیازی به دست‌کاری index.htm نباشه. از رنگ/فونت‌های
// هماهنگ با ظاهر فعلی سایت استفاده شده.
function injectAiToolbarStyles() {
  if (document.getElementById("ai-toolbar-styles")) return; // فقط یک‌بار
  const style = document.createElement("style");
  style.id = "ai-toolbar-styles";
  style.textContent = `
    .ai-search-result-row {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      margin-bottom: 10px;
    }
    .ai-search-result-row .ai-result-marker {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      margin-top: 4px;
    }
    .ai-search-result-row .ai-result-marker .result-number {
      font-size: 0.85rem;
      color: #64748b;
    }
    .ai-search-result-row .ai-result-marker .ai-result-page {
      font-size: 0.72rem;
      padding: 1px 6px;
      border-radius: 9999px;
      background: #eff6ff;
      color: #1d4ed8;
      white-space: nowrap;
    }
    .ai-search-result-row .ai-search-result {
      flex: 1;
      min-width: 0;
    }
    .ai-result-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      margin: 10px 0;
      padding: 8px 10px;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      background: #f8fafc;
    }
    .ai-toolbar-btn {
      border: 1px solid #cbd5e1;
      background: #fff;
      border-radius: 6px;
      padding: 4px 10px;
      font-size: 0.85rem;
      cursor: pointer;
      color: #1f2937;
    }
    .ai-toolbar-btn:hover {
      background: #eff6ff;
      border-color: #93c5fd;
    }
    .ai-toolbar-status {
      font-size: 0.82rem;
      color: #16a34a;
    }
    /* Item جدید: گفتگوی ادامه‌دار - هر تبادل (سؤال+پاسخ) یه بلوک جدا،
       زیر بلوک قبلی، بدون این‌که گفتگوی قبلی پاک بشه. */
    .ai-chat-turn {
      margin-bottom: 16px;
      padding-bottom: 14px;
      border-bottom: 1px solid #e2e8f0;
    }
    .ai-chat-turn:last-child {
      border-bottom: none;
    }
    .ai-chat-question {
      font-weight: bold;
      color: #173b63;
      margin-bottom: 6px;
    }
    .ai-chat-question::before {
      content: "❓ ";
    }
    .ai-chat-pending {
      color: #64748b;
      font-size: 0.9rem;
      padding: 6px 0;
    }
    .ai-chat-error {
      color: #b91c1c;
      font-size: 0.9rem;
      padding: 6px 0;
    }
  `;
  document.head.appendChild(style);
}

// ---------- اتصال به رابط کاربری واقعی سایت (تب «دستیار هوشمند») ----------
// این id ها عمداً با پیشوند ai نگه داشته شدن تا با سیستم جست‌وجوی کلمه‌ای
// موجود سایت (که از id های searchInput/searchResults استفاده می‌کنه) تداخل نداشته باشن.

document.addEventListener("DOMContentLoaded", () => {
  injectAiToolbarStyles();

  const aiSearchInput = document.getElementById("aiSearchInput");
  const aiSearchResults = document.getElementById("aiSearchResults");
  const aiSearchStatus = document.getElementById("aiSearchStatus");

  if (aiSearchInput && aiSearchResults) {
    let debounceTimer;
    let searchToken = 0; // شمارندهٔ نسل: هر بار تایپ، شماره‌ای جدید می‌گیره
    let latestSearchResults = []; // نتایج جست‌وجوی آخر، برای نوار ابزار زیرش
    const searchSelectedIndexes = new Set(); // ایندکس‌های تیک‌خورده در همین نتایج

    // نوار ابزار یک‌بار ساخته و بعد از باکس نتایج قرار می‌گیره؛ هر بار
    // که نتایج جدید بیاد، همین نوار می‌مونه، فقط لیست انتخاب‌ها خالی می‌شه.
    const searchToolbar = createAiToolbar(
      () =>
        [...searchSelectedIndexes]
          .sort((a, b) => a - b)
          .map((i) => latestSearchResults[i])
          .filter(Boolean)
          .map((r) => ({ title: r.book, text: r.text, url: r.source, page: r.page })),
      "ابتدا یک یا چند نتیجه را با تیک انتخاب کنید"
    );
    aiSearchResults.insertAdjacentElement("afterend", searchToolbar);

    aiSearchInput.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const myToken = ++searchToken; // این تلاش، صاحب همین شماره‌ست

      debounceTimer = setTimeout(async () => {
        const query = aiSearchInput.value.trim();
        if (!query) {
          aiSearchResults.innerHTML = "";
          latestSearchResults = [];
          searchSelectedIndexes.clear();
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          return;
        }
        if (aiSearchStatus) aiSearchStatus.textContent = "در حال جست‌وجو…";
        try {
          const results = await semanticSearch(query);
          // اگه در این فاصله کاربر متن رو پاک کرده یا چیز دیگه‌ای تایپ کرده،
          // این جواب دیگه منسوخ شده و نباید روی وضعیت فعلی بشینه.
          if (myToken !== searchToken) return;
          if (aiSearchStatus) aiSearchStatus.textContent = "";
          latestSearchResults = results;
          searchSelectedIndexes.clear();
          aiSearchResults.innerHTML = results
            .map(
              (r, i) =>
                `<div class="ai-search-result-row">
                  <div class="ai-result-marker">
                    <span class="result-number">${i + 1}</span>
                    <input type="checkbox" class="result-checkbox ai-result-checkbox" data-ai-index="${i}" title="انتخاب برای کپی/خروجی/نشانه">
                    ${r.page ? `<span class="ai-result-page" title="شمارهٔ صفحهٔ چاپی">ص ${r.page}</span>` : ""}
                  </div>
                  <a class="ai-search-result" href="${textFragmentUrl(encodeURI(r.source), r.text)}" target="_blank" rel="noopener">
                    <strong>${r.book}</strong>
                    <p>${r.text}</p>
                    <small>میزان تطابق مفهومی: ${(r.score * 100).toFixed(1)}٪ — برای مشاهدهٔ کتاب کلیک کنید</small>
                  </a>
                </div>`
            )
            .join("");
        } catch (err) {
          if (myToken !== searchToken) return;
          if (aiSearchStatus) aiSearchStatus.textContent = err.message || "در جست‌وجو خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
          console.error(err);
        }
      }, 400); // debounce: صبر کن کاربر تایپش تموم بشه
    });

    // تیک‌زدن هر چک‌باکس، فقط انتخاب رو به‌روز می‌کنه؛ کلیک روی خودِ لینک
    // (برای رفتن به کتاب) دست‌نخورده می‌مونه چون این‌ها دو المان جدان.
    aiSearchResults.addEventListener("change", (e) => {
      const checkbox = e.target.closest(".ai-result-checkbox");
      if (!checkbox) return;
      const index = Number(checkbox.dataset.aiIndex);
      if (checkbox.checked) {
        searchSelectedIndexes.add(index);
      } else {
        searchSelectedIndexes.delete(index);
      }
    });
  }

  const aiChatForm = document.getElementById("aiChatForm");
  const aiChatInput = document.getElementById("aiChatInput");
  const aiChatOutput = document.getElementById("aiChatOutput");

  if (aiChatForm && aiChatInput && aiChatOutput) {
    let chatToken = 0; // همون منطق نسل، برای پرسش‌های پشت‌سرهم در تب گفت‌وگو
    // Item جدید (گفتگوی ادامه‌دار): کل تبادل‌های همین نشست، به ترتیب -
    // هم برای نمایش هر تبادل زیر تبادل قبلی (نه جایگزینیش)، هم برای
    // ساخت history‌ای که به askQuestion داده می‌شه.
    const chatTurns = [];

    const chatToolbar = createAiToolbar(
      () =>
        chatTurns.map((turn) => ({
          kind: "chat",
          title: `پرسش: ${turn.question}`,
          text: turn.answer,
          url: turn.sourcesText,
          question: turn.question,
          answer: turn.answer,
          sourcesInfo: turn.sourcesInfo,
        })),
      "ابتدا یک پاسخ دریافت کنید"
    );
    aiChatOutput.insertAdjacentElement("afterend", chatToolbar);

    function renderChatTurns() {
      aiChatOutput.innerHTML = chatTurns
        .map(
          (turn) => `
            <div class="ai-chat-turn">
              <div class="ai-chat-question">${turn.question}</div>
              <div class="ai-chat-answer">${turn.answer}</div>
              <div class="ai-chat-sources">مآخذ: ${turn.sourceLinksHtml}</div>
            </div>
          `
        )
        .join("");
      aiChatOutput.scrollTop = aiChatOutput.scrollHeight;
    }

    aiChatForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const question = aiChatInput.value.trim();
      if (!question) return;

      const myToken = ++chatToken;
      // Item جدید: به‌جای پاک‌کردن گفتگوی قبلی، فقط یه نشونهٔ «در حال
      // پاسخ» زیرش اضافه می‌شه؛ سؤالات و جواب‌های قبلی همچنان دیده می‌شن.
      aiChatInput.value = "";
      renderChatTurns();
      aiChatOutput.insertAdjacentHTML(
        "beforeend",
        `<div class="ai-chat-pending" id="aiChatPending-${myToken}">در حال بررسی و تنظیم پاسخ…</div>`
      );
      aiChatOutput.scrollTop = aiChatOutput.scrollHeight;

      try {
        // Item جدید (گفتگوی ادامه‌دار): تاریخچهٔ تبادل‌های قبلی همین
        // نشست، جدا از پرسش فعلی، به askQuestion فرستاده می‌شه.
        const history = chatTurns.map((turn) => ({ question: turn.question, answer: turn.answer }));
        const { answer, sources } = await askQuestion(question, history);
        if (myToken !== chatToken) return; // پرسش جدیدتری در همین حین ارسال شده

        const sourceLinksHtml = sources
          .map((s) => `<a href="${textFragmentUrl(encodeURI(s.source), s.text)}" target="_blank" rel="noopener">${s.book}</a>`)
          .join("، ");

        // Item جدید: فهرست یکتای کتاب‌هایی که پاسخ از آن‌ها گرفته شده،
        // هرکدوم با شماره صفحه‌اش (اگه داشت) - برای خط «پاسخ از کتاب...»
        // در خروجی‌ها و آرشیو. اگه یک کتاب چند بار در منابع تکرار بشه
        // (چند تکه از یک کتاب)، فقط یک‌بار (اولین صفحه‌اش) نگه داشته می‌شه.
        const sourcesInfo = [];
        const seenBooks = new Set();
        sources.forEach((s) => {
          if (seenBooks.has(s.book)) return;
          seenBooks.add(s.book);
          sourcesInfo.push({ book: s.book, page: s.page || null });
        });

        chatTurns.push({
          question,
          answer,
          sourceLinksHtml,
          sourcesText: sources.map((s) => s.source).join("، "),
          sourcesInfo,
        });
        renderChatTurns();
      } catch (err) {
        if (myToken !== chatToken) return;
        const pendingEl = document.getElementById(`aiChatPending-${myToken}`);
        const message = err.message || "در دریافت پاسخ خطایی رخ داد. لطفاً مجدداً تلاش کنید.";
        if (pendingEl) {
          pendingEl.textContent = message;
        } else {
          aiChatOutput.insertAdjacentHTML("beforeend", `<div class="ai-chat-error">${message}</div>`);
        }
        console.error(err);
      }
    });

    // Item جدید: گفتگوی جدید - قبل از خالی‌کردن گفتگوی فعلی، کل آن
    // (اگه خالی نبود) به‌عنوان یک آیتم کامل به آرشیو گفتگوها منتقل
    // می‌شه - دقیقاً مثل محیط‌های چت معمولی که با «گفتگوی جدید» زدن،
    // گفتگوی قبلی از دست نمی‌ره، فقط به تاریخچه/آرشیو می‌ره.
    const aiChatResetButton = document.getElementById("aiChatResetButton");
    if (aiChatResetButton) {
      aiChatResetButton.addEventListener("click", () => {
        archiveCurrentChatConversationAi(chatTurns);
        chatTurns.length = 0;
        aiChatOutput.innerHTML = "";
      });
    }

    const aiChatArchiveButton = document.getElementById("aiChatArchiveButton");
    if (aiChatArchiveButton) {
      aiChatArchiveButton.addEventListener("click", openChatArchivePanelAi);
    }

    const aiChatArchiveOverlayEl = document.getElementById("aiChatArchiveOverlay");
    if (aiChatArchiveOverlayEl) {
      aiChatArchiveOverlayEl.addEventListener("click", (event) => {
        if (event.target === aiChatArchiveOverlayEl) {
          closeChatArchivePanelAi();
        }
      });
    }
  }
});
