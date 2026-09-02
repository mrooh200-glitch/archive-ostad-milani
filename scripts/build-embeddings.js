/**
 * build-embeddings.js
 *
 * این اسکریپت روی GitHub Actions اجرا می‌شه (نه سیستم شخصی).
 * کارش: خوندن همهٔ فایل‌های .htm کتاب‌ها، تقسیم متن به بخش‌های کوچک،
 * و ساخت بردار معنایی (embedding) برای هر بخش با Cloudflare Workers AI (مدل BGE-M3).
 * نتیجه در فایل embeddings.json ذخیره می‌شه.
 *
 * اجرا: node scripts/build-embeddings.js
 * نیاز به دو متغیر محیطی: CLOUDFLARE_API_TOKEN و CLOUDFLARE_ACCOUNT_ID
 */

const fs = require("fs");
const path = require("path");
const cheerio = require("cheerio");

const ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
const API_TOKEN = process.env.CLOUDFLARE_API_TOKEN;

if (!ACCOUNT_ID || !API_TOKEN) {
  console.error("خطا: متغیرهای CLOUDFLARE_ACCOUNT_ID و CLOUDFLARE_API_TOKEN تنظیم نشدن.");
  process.exit(1);
}

const REPO_ROOT = path.join(__dirname, ".."); // فرض: این اسکریپت در scripts/ داخل ریشهٔ مخزن قرار داره
const OUTPUT_FILE = path.join(REPO_ROOT, "embeddings.json");

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

// ---------- ۲. استخراج پاراگراف‌های تمیز از هر فایل htm ----------
function extractParagraphs(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const $ = cheerio.load(raw);

  // خروجی Word معمولاً متن رو داخل تگ‌های <p> می‌ذاره
  const paragraphs = [];
  $("p").each((_, el) => {
    const text = $(el).text().replace(/\s+/g, " ").trim();
    if (text.length > 0) paragraphs.push(text);
  });

  // اگه هیچ <p> پیدا نشد (ساختار متفاوت بود)، کل متن body رو بگیر و بر اساس خط جدید تقسیم کن
  if (paragraphs.length === 0) {
    const bodyText = $("body").text();
    return bodyText
      .split(/\n+/)
      .map((t) => t.replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0);
  }

  return paragraphs;
}

// ---------- ۳. تبدیل پاراگراف‌ها به تکه‌های (chunk) با طول مناسب ----------
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

// ---------- ۵ب. فشرده‌سازی بردار به base64 (به‌جای آرایهٔ متنی اعداد) ----------
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

  const allChunks = []; // { book, text }

  for (const file of files) {
    const bookName = path.basename(file, path.extname(file));
    const paragraphs = extractParagraphs(file);
    const chunks = chunkParagraphs(paragraphs);
    console.log(`  ${bookName}: ${paragraphs.length} پاراگراف → ${chunks.length} تکه`);
    for (const chunk of chunks) {
      allChunks.push({ book: bookName, source: path.basename(file), text: chunk });
    }
  }

  console.log(`جمع کل: ${allChunks.length} تکه متن. شروع ساخت بردارها...`);

  // ساخت بردار به‌صورت دسته‌ای (batch) برای جلوگیری از تعداد زیاد درخواست
  const BATCH_SIZE = 20;
  const results = [];

  for (let i = 0; i < allChunks.length; i += BATCH_SIZE) {
    const batch = allChunks.slice(i, i + BATCH_SIZE);
    const texts = batch.map((c) => c.text);
    console.log(`  ساخت بردار برای بخش ${i + 1} تا ${i + batch.length} از ${allChunks.length}...`);

    const vectors = await embedBatch(texts);

    for (let j = 0; j < batch.length; j++) {
      results.push({
        book: batch[j].book,
        source: batch[j].source,
        text: batch[j].text,
        vector: vectorToBase64(vectors[j]),
      });
    }
  }

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results));
  console.log(`تمام شد! ${results.length} بردار در ${OUTPUT_FILE} ذخیره شد.`);
}

main().catch((err) => {
  console.error("خطا در اجرای اسکریپت:", err);
  process.exit(1);
});
