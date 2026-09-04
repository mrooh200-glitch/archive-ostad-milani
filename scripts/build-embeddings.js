/**
 * build-embeddings.js
 *
 * این اسکریپت روی GitHub Actions اجرا می‌شه (نه سیستم شخصی).
 * کارش: خوندن همهٔ فایل‌های .htm کتاب‌ها، تقسیم متن به بخش‌های کوچک،
 * و ساخت بردار معنایی (embedding) برای هر بخش با Cloudflare Workers AI (مدل BGE-M3).
 * نتیجه در فایل embeddings.json ذخیره می‌شه.
 *
 * Item جدید (بهینه‌سازی مصرف Workers AI): این نسخه دیگه هر بار همهٔ
 * تکه‌های متن رو از نو embed نمی‌کنه. embeddings.json قبلی رو می‌خونه،
 * و برای هر تکه‌ای که متنش دقیقاً با دفعهٔ قبل یکیه، بردار قبلی‌ش رو
 * دوباره استفاده می‌کنه (بدون تماس با API). فقط تکه‌های واقعاً جدید یا
 * تغییرکرده به Cloudflare فرستاده می‌شن. این هم سهمیهٔ رایگان روزانهٔ
 * نورون رو صرفه‌جویی می‌کنه، هم اجرای اسکریپت رو سریع‌تر می‌کنه.
 *
 * توجه: چون تکه‌بندی بر اساس ترتیب پاراگراف‌هاست، اگه یک پاراگراف اول
 * فایل تغییر کنه، ممکنه مرز تکه‌های بعدی هم جابه‌جا بشه و آنها هم
 * (درست، نه اشتباه) دوباره embed بشن. این طبیعیه و رفتار درستیه.
 *
 * اجرا: node scripts/build-embeddings.js
 * نیاز به دو متغیر محیطی: CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const cheerio = require("cheerio");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("خطا: متغیرهای CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN تنظیم نشدن.");
  process.exit(1);
}

const REPO_ROOT = path.join(__dirname, ".."); // فرض: این اسکریپت در scripts/ داخل ریشهٔ مخزن قرار داره
const OUTPUT_FILE = path.join(REPO_ROOT, "embeddings.json");
// فایل کوچک نسخه که سمت مرورگر (search-widget.js) برای تشخیص «آیا embeddings.json
// عوض شده یا نه» می‌خونه، به‌جای تکیه به هدرهای HTTP نامطمئن GitHub Pages.
const VERSION_FILE = path.join(REPO_ROOT, "embeddings-version.json");

// حداقل و حداکثر طول هر تکه متن (بر حسب کاراکتر، نه توکن -- تقریبی)
const MIN_CHUNK_LENGTH = 100;
const MAX_CHUNK_LENGTH = 800;

// ---------- ۱. پیدا کردن فایل‌های htm کتاب‌ها ----------
function findHtmFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const entry of entries) {
    // پوشه‌های node_modules، .git و غیره رو نادیده بگیر
    if (entry.isDirectory()) {
      if (["node_modules", ".git", ".github", "scripts"].includes(entry.name)) continue;
      files = files.concat(findHtmFiles(path.join(dir, entry.name)));
    } else if (entry.name.toLowerCase().endsWith(".htm") || entry.name.toLowerCase().endsWith(".html")) {
      // فایل index.html که خود سایته رو رد کن
      if (entry.name.toLowerCase() === "index.html") continue;
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

// ---------- ۲. تشخیص این‌که آیا تگ <title> واقعاً عنوان کتابه یا باقیمانده‌ی یه ابزار/افزونه ----------
// بعضی از خروجی‌های Word (مثلاً افزونه‌های فارسی‌ساز فاصله‌گذاری) به‌جای عنوان واقعی،
// اسم یه دستور یا ماکرو داخلی رو تو تگ <title> می‌ذارن. این تابع همچین حالت‌هایی رو تشخیص می‌ده.
function looksLikeToolArtifactTitle(title) {
  const junkPatterns = [
    /فاصله[\s\S]*ورد/, // مثلاً «حذف فاصله مخفی‌ها ... برای ورد»
    /ورد[\s\S]*فاصله/,
    /^document\d*$/i,
    /^untitled/i,
    /^microsoft\s*word/i,
  ];
  return junkPatterns.some((re) => re.test(title));
}

// ---------- ۳. تعیین عنوان نهایی کتاب، با اولویت: <title> معتبر ← اسم فایل ----------
// توجه: قبلاً اینجا یه heuristic هم بود که وقتی <title> معتبر نبود، سعی می‌کرد از
// روی بزرگ‌ترین فونتِ پاراگراف‌های ابتدای سند عنوان رو حدس بزنه. اون روش حذف شد،
// چون هم گاهی جمله‌های مهمِ متن اصلی (نه فقط عنوان) رو با فونت بزرگ اشتباه می‌گرفت،
// هم تو بعضی فایل‌ها ترتیب حروف رو به‌هم می‌ریخت. الان اگه <title> معتبر نباشه،
// فقط و فقط به اسم فایل برمی‌گردیم — امن‌ترین حالت، بدون هیچ حدس‌زدنی.
function extractBookTitle($, filePath) {
  const titleTag = $("title").text().replace(/\s+/g, " ").trim();
  if (titleTag && !looksLikeToolArtifactTitle(titleTag)) {
    return titleTag;
  }

  return path.basename(filePath, path.extname(filePath));
}

// ---------- ۴. استخراج عنوان و پاراگراف‌های تمیز از هر فایل htm ----------
function extractBookContent(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(raw);

  const title = extractBookTitle($, filePath);

  // خروجی Word معمولاً متن رو داخل تگ‌های <p> می‌ذاره
  const paragraphs = [];
  $("p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length > 0) paragraphs.push(text);
  });

  // اگه هیچ <p> پیدا نشد (ساختار متفاوت بود)، کل متن body رو بگیر و بر اساس خط جدید تقسیم کن
  if (paragraphs.length === 0) {
    const bodyText = $("body").text();
    return {
      title,
      paragraphs: bodyText
        .split(/\n+/)
        .map((t) => t.replace(/\s+/g, " ").trim())
        .filter((t) => t.length > 0),
    };
  }

  return { title, paragraphs };
}

// ---------- ۵. تبدیل پاراگراف‌ها به تکه‌های (chunk) با طول مناسب ----------
function chunkParagraphs(paragraphs) {
  const chunks = [];
  let current = "";

  for (const para of paragraphs) {
    if ((current + " " + para).length > MAX_CHUNK_LENGTH && current.length >= MIN_CHUNK_LENGTH) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? current + " " + para : para;
    }
  }
  if (current.trim().length > 0) chunks.push(current.trim());

  return chunks;
}

// ---------- ۴. فراخوانی Cloudflare Workers AI برای گرفتن بردار ----------
async function embedBatch(texts) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/run/@cf/baai/bge-m3`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: texts }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Cloudflare AI error (${res.status}): ${errText}`);
  }

  const json = await res.json();
  if (!json.success) {
    throw new Error(`Cloudflare AI returned failure: ${JSON.stringify(json.errors)}`);
  }

  // خروجی مدل bge-m3 در Workers AI به‌صورت { result: { data: [[...],[...]] } } برمی‌گرده
  return json.result.data;
}

// ---------- ۵الف. کلید یکتا برای هر تکه (برای تشخیص «همون تکهٔ قبلیه») ----------
// source + متن دقیق تکه، چون اگه حتی یک کلمه عوض بشه باید دوباره embed بشه.
function chunkKey(sourceFile, text) {
  return `${sourceFile}:::${text}`;
}

// ---------- ۵ب. خوندن embeddings.json قبلی (اگه وجود داشته باشه) ----------
// و ساخت یک Map از کلید تکه -> رکورد کامل قبلی (شامل بردار base64)،
// تا بشه بردارهای تکه‌های تغییرنکرده رو بدون تماس با API دوباره استفاده کرد.
function loadPreviousEmbeddingsMap() {
  const map = new Map();
  if (!fs.existsSync(OUTPUT_FILE)) return map;

  try {
    const prevRaw = fs.readFileSync(OUTPUT_FILE, "utf-8");
    const prevData = JSON.parse(prevRaw);
    for (const item of prevData) {
      map.set(chunkKey(item.source, item.text), item);
    }
  } catch (err) {
    console.warn("هشدار: خوندن embeddings.json قبلی ناموفق بود، همه‌چیز از نو embed می‌شه.", err.message);
  }
  return map;
}

// ---------- ۵ج. فشرده‌سازی بردار به base64 (به‌جای آرایهٔ متنی اعداد) ----------
// یک بردار ۱۰۲۴ عددی به‌صورت متن JSON خیلی حجیم می‌شه (هر عدد با کلی رقم اعشار).
// با تبدیل به Float32Array و بعد base64، حجم حدود ۳ تا ۴ برابر کوچیک‌تر می‌شه.
function vectorToBase64(vector) {
  const floatArray = new Float32Array(vector);
  return Buffer.from(floatArray.buffer).toString("base64");
}

// ---------- ۶. تابع اصلی ----------
async function main() {
  console.log("در حال جست‌وجوی فایل‌های htm...");
  const files = findHtmFiles(REPO_ROOT);
  console.log(`${files.length} فایل پیدا شد:`, files.map((f) => path.basename(f)));

  const allChunks = []; // { book, source, text }

  for (const file of files) {
    const { title: bookName, paragraphs } = extractBookContent(file);
    const chunks = chunkParagraphs(paragraphs);
    console.log(`  ${bookName}: ${paragraphs.length} پاراگراف → ${chunks.length} تکه`);
    for (const chunk of chunks) {
      allChunks.push({ book: bookName, source: path.basename(file), text: chunk });
    }
  }

  console.log(`جمع کل: ${allChunks.length} تکه متن.`);

  // ---------- تفکیک تکه‌های «قبلاً embed شده و بدون تغییر» از «جدید/تغییرکرده» ----------
  const previousMap = loadPreviousEmbeddingsMap();
  const results = new Array(allChunks.length); // نتیجهٔ نهایی، هم‌ترتیب با allChunks
  const toEmbed = []; // { index, text } — فقط اونایی که واقعاً باید به API فرستاده بشن

  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    const key = chunkKey(chunk.source, chunk.text);
    const prev = previousMap.get(key);

    if (prev && prev.vector) {
      // این تکه دقیقاً قبلاً هم بوده و متنش عوض نشده -- بردار قبلی رو نگه دار
      results[i] = { book: chunk.book, source: chunk.source, text: chunk.text, vector: prev.vector };
    } else {
      toEmbed.push({ index: i, text: chunk.text });
    }
  }

  console.log(
    `${allChunks.length - toEmbed.length} تکه بدون تغییر (بردار قبلی دوباره استفاده شد)، ` +
      `${toEmbed.length} تکه جدید/تغییرکرده باید embed بشه.`
  );

  if (toEmbed.length === 0) {
    console.log("هیچ تکهٔ جدیدی برای embed کردن نیست. فقط embeddings.json با همون محتوای قبلی بازنویسی می‌شه.");
  } else {
    // ساخت بردار به‌صورت دسته‌ای (batch) برای جلوگیری از تعداد زیاد درخواست
    const BATCH_SIZE = 20;

    for (let i = 0; i < toEmbed.length; i += BATCH_SIZE) {
      const batch = toEmbed.slice(i, i + BATCH_SIZE);
      const texts = batch.map((c) => c.text);
      console.log(`  ساخت بردار برای بخش ${i + 1} تا ${i + batch.length} از ${toEmbed.length} تکهٔ جدید...`);

      const vectors = await embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const originalIndex = batch[j].index;
        const chunk = allChunks[originalIndex];
        results[originalIndex] = {
          book: chunk.book,
          source: chunk.source,
          text: chunk.text,
          vector: vectorToBase64(vectors[j]),
        };
      }
    }
  }

  const resultsJson = JSON.stringify(results);
  fs.writeFileSync(OUTPUT_FILE, resultsJson);

  // نسخه = هش محتوای واقعی. یعنی اگه حتی یک کلمه از یک تکه عوض بشه،
  // نسخه هم عوض می‌شه و مرورگرها کش قدیمی‌شون رو باطل می‌کنن؛ اگه هیچی
  // عوض نشده باشه، نسخه هم یکی می‌مونه و کاربرها دوباره دانلود نمی‌کنن.
  const versionHash = crypto.createHash("sha256").update(resultsJson).digest("hex").slice(0, 16);
  fs.writeFileSync(VERSION_FILE, JSON.stringify({ version: versionHash, builtAt: new Date().toISOString() }));

  console.log(`تمام شد! ${results.length} بردار در ${OUTPUT_FILE} ذخیره شد. نسخه: ${versionHash}`);
}

main().catch((err) => {
  console.error("خطا در اجرای اسکریپت:", err);
  process.exit(1);
});
