(function () {
  "use strict";

  const ignoredTags = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "IFRAME",
    "SVG",
    "CANVAS",
    "MARK",
    "TEXTAREA",
    "INPUT",
    "BUTTON",
    "SELECT",
    "OPTION"
  ]);

  let matches = [];
  let currentMatch = -1;
  let searchBoxElement = null;
  let resultsPanelElement = null;
  let archiveOverlayElement = null;
  const selectedMatchIndexes = new Set();
  const activeDerivativeKeys = new Set();

  async function copyTextToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // fall through to the legacy fallback below
    }

    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();

      const successful = document.execCommand("copy");
      document.body.removeChild(textarea);

      return successful;
    } catch (error) {
      return false;
    }
  }

  // Copies both a plain-text version (for targets that only accept
  // text) and an HTML version (for targets that accept rich paste -
  // Word, Gmail, WhatsApp/Telegram desktop, etc.). The HTML version
  // turns each long reference URL into a short clickable "لینک منبع"
  // link instead of dumping the raw address into the pasted text.
  async function copyRichTextToClipboard(text, html) {
    try {
      if (
        navigator.clipboard &&
        window.isSecureContext &&
        typeof ClipboardItem !== "undefined" &&
        navigator.clipboard.write
      ) {
        await navigator.clipboard.write([
          new ClipboardItem({
            "text/plain": new Blob([text], { type: "text/plain" }),
            "text/html": new Blob([html], { type: "text/html" })
          })
        ]);
        return true;
      }
    } catch (error) {
      // fall through to the plain-text-only fallback below
    }

    return copyTextToClipboard(text);
  }

  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ۀ/g, "ه")
      .replace(/ة/g, "ه")
      // Strip Arabic/Persian diacritics (اعراب) and tatweel so a query
      // typed WITHOUT diacritics still matches text that HAS them
      // (e.g. "کتاب" finds "کِتاب").
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  // ---- Root-based (stemming) search --------------------------------
  // Two layers, applied in order:
  //  1) Arabic root-and-pattern (وزن) extraction, a simplified version
  //     of the classic ISRI algorithm: recognizes the most common
  //     "augment letter" positions (سألتمونيه) in 4/5/6-letter words
  //     and strips them to reach the 3-letter triliteral root. This
  //     is what connects surface-different words like حادثه / حدوث /
  //     حوادث / حادث, or کتاب / کاتب / مکتوب / الکتاب, which no
  //     amount of prefix/suffix stripping alone can do.
  //  2) A light Persian/Arabic affix stripper (prefixes می‌/نمی‌/بی‌/
  //     ال, suffixes ها/ان/تر/ترین/...) for words the pattern step
  //     doesn't fully resolve.
  // Pattern extraction runs BEFORE the generic suffix stripper so that
  // real root letters aren't cannibalized by an accidentally-matching
  // generic suffix (e.g. "کریم" ends in "یم", which is also a common
  // verb suffix - resolving the فعیل pattern first keeps the "م" that
  // a naive suffix strip would have removed).
  // Not a full morphological analyzer or dictionary lookup - it will
  // still miss irregular/weak-letter verbs and occasionally produce a
  // wrong or overly short root. Good enough for connecting the common
  // derivational families in this archive; a dictionary-based
  // approach (e.g. the Arramooz word/root database) would be the next
  // step up in accuracy if ever needed.

  const STEM_MIN_ROOT_LENGTH = 2;

  // Note: single-letter Arabic proclitics (و/ف/ب/ل/ک) are deliberately
  // NOT included here - they falsely strip the first letter of countless
  // ordinary Persian words (e.g. "کتاب" -> "تاب"), doing far more harm
  // than good on this mostly-Persian corpus.
  const STEM_PREFIXES = [
    "نمی", "می", "بی",
    "وال", "بال", "فال", "کال", "لل",
    "ال"
  ].sort((a, b) => b.length - a.length);

  const STEM_SUFFIXES = [
    "هایمان", "هایتان", "هایشان",
    "هایم", "هایت", "هایش",
    "ترین", "های", "گان",
    "یم", "ید", "ند", "تر",
    "ها", "ان", "ات", "ون", "ین", "یه",
    "ی", "ه"
  ].sort((a, b) => b.length - a.length);

  // "سألتمونيه" - the classic set of Arabic augment letters (with ي
  // normalized to ی), used when deciding whether a leading/trailing
  // letter on a long word is likely an augment rather than a root
  // letter.
  const AUGMENT_LETTERS = new Set(
    ["ا", "و", "ی", "ت", "ن", "م", "س", "ه"]
  );

  const WORD_PATTERN = /[\u0621-\u06FF]+(?:\u200c[\u0621-\u06FF]+)*/g;

  function stripDiacritics(text) {
    return (text || "")
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, "")
      .replace(/[\u200c\u200e\u200f]/g, "")
      .replace(/[أإآ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ی");
  }

  function cleanWord(word) {
    return normalize(stripDiacritics(word));
  }

  // Reduce a 4-letter word to its 3-letter root by removing one
  // augment letter at the position where a known measure (وزن) puts
  // it. Returns null if no recognized pattern applies.
  function reduceFourLetter(word) {
    const c0 = word[0];
    const c1 = word[1];
    const c2 = word[2];
    const c3 = word[3];

    if (c1 === "ا") return c0 + c2 + c3; // فاعل  (حادث -> حدث)
    if (c2 === "ا") return c0 + c1 + c3; // فِعال (کتاب -> کتب)
    if (c2 === "و") return c0 + c1 + c3; // فعول  (حدوث -> حدث)
    if (c2 === "ی") return c0 + c1 + c3; // فعیل  (کریم -> کرم)
    if (c0 === "م") return c1 + c2 + c3; // مفعل  (مکتب -> کتب)
    if (c0 === "ت") return c1 + c2 + c3; // تفعّل (تعلم -> علم)

    return null;
  }

  // Reduce a 5-letter word to its 3-letter root by removing two
  // augment letters at known measure positions.
  function reduceFiveLetter(word) {
    const c0 = word[0];
    const c1 = word[1];
    const c2 = word[2];
    const c3 = word[3];
    const c4 = word[4];

    if (c1 === "و" && c2 === "ا") return c0 + c3 + c4; // فواعل (حوادث -> حدث)
    if (c0 === "م" && c2 === "ا") return c1 + c3 + c4; // مفاعل (مساجد -> سجد)
    if (c0 === "م" && c3 === "و") return c1 + c2 + c4; // مفعول (مکتوب -> کتب)
    if (c0 === "ت" && c3 === "ی") return c1 + c2 + c4; // تفعیل (توحید -> وحد)
    if (c1 === "ت" && c3 === "ا") return c0 + c2 + c4; // تفاعل-ish
    if (c2 === "ا" && c3 === "ی") return c0 + c1 + c4; // فعائل (رسائل -> رسل)

    return null;
  }

  // For 6+ letter words, fall back to peeling one plausible augment
  // letter off either end and letting the loop in deaugmentToRoot()
  // retry the shorter word.
  function reduceLongWord(word) {
    const first = word[0];

    if (AUGMENT_LETTERS.has(first) && word.length - 1 >= 4) {
      return word.slice(1);
    }

    const last = word[word.length - 1];

    if (AUGMENT_LETTERS.has(last) && word.length - 1 >= 4) {
      return word.slice(0, -1);
    }

    return null;
  }

  function deaugmentToRoot(word) {
    let w = word;
    let guard = 0;

    while (w.length > 3 && guard < 4) {
      guard += 1;

      let reduced = null;

      if (w.length === 4) {
        reduced = reduceFourLetter(w);
      } else if (w.length === 5) {
        reduced = reduceFiveLetter(w);
      } else if (w.length >= 6) {
        reduced = reduceLongWord(w);
      }

      if (reduced === null || reduced.length >= w.length) {
        break;
      }

      w = reduced;
    }

    return w;
  }

  function stripOnePrefix(word) {
    for (const prefix of STEM_PREFIXES) {
      if (
        word.startsWith(prefix) &&
        word.length - prefix.length >= STEM_MIN_ROOT_LENGTH
      ) {
        return word.slice(prefix.length);
      }
    }

    return word;
  }

  function stripSuffixes(word) {
    let result = word;

    for (let pass = 0; pass < 2; pass++) {
      for (const suffix of STEM_SUFFIXES) {
        if (
          result.endsWith(suffix) &&
          result.length - suffix.length >= STEM_MIN_ROOT_LENGTH
        ) {
          result = result.slice(0, -suffix.length);
          break;
        }
      }
    }

    return result;
  }

  function stemWord(word) {
    let w = stripOnePrefix(cleanWord(word));

    if (w.length > 3) {
      const patternResult = deaugmentToRoot(w);

      if (patternResult.length === 3) {
        return patternResult;
      }

      w = patternResult;
    }

    w = stripSuffixes(w);

    if (w.length > 3) {
      w = deaugmentToRoot(w);
    }

    return w;
  }

  function getQueryStems(query) {
    return query
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map(stemWord)
      .filter(Boolean);
  }

  function isRootSearchEnabled() {
    const toggle = document.getElementById("inPageSearchRoot");
    return !!(toggle && toggle.checked);
  }

  // The derivatives block is opt-in (separate from root-search itself)
  // so that turning on root search alone doesn't automatically eat up
  // screen space - the reader has to explicitly ask to see it.
  function isDerivativesViewEnabled() {
    const toggle = document.getElementById("inPageShowDerivatives");
    return !!(toggle && toggle.checked);
  }

  // Only relevant while root search is on. Keeps the checkbox out of
  // the way (and unchecked) the rest of the time.
  function updateDerivativesToggleVisibility() {
    const label = document.getElementById("inPageShowDerivativesLabel");

    if (!label) {
      return;
    }

    label.style.display = isRootSearchEnabled() ? "inline-flex" : "none";
  }

  // The derivatives block is sticky, stacked directly beneath the
  // (also sticky) search box, so it doesn't scroll out of view. Its
  // "top" has to match the search box's actual rendered height, which
  // can change (title wrapping, narrow screens), so this is
  // recalculated rather than hard-coded.
  function updateDerivativesBlockPosition() {
    const block = document.getElementById("inPageDerivativesBlock");

    if (!block || !searchBoxElement) {
      return;
    }

    block.style.top = searchBoxElement.offsetHeight + "px";
  }

  const bookTitlesByFileName = {
    "Aghaye-Javadi-va-Hodous.htm": "آقای جوادی و حدوث",
    "Esbat-e-Towhid-va-Botlan-e-Vahdat-e-Vojoud.htm":
      "اثبات توحید و بطلان وحدت وجود",
    "Faratar-az-Erfan.htm": "فراتر از عرفان",
    "Osoul-al-Maaref-al-Elahiyya.htm": "اصول المعارف الالهیة",
    "al-Elan-an-Asrar-al-Falsafa-wal-Erfan.htm":
      "الإعلان عن اسرار الفلسفة والعرفان",
    "marefatollah-mohashsha.htm": "متن درس معرفة الله (محشّی)"
  };

  function getPageTitle() {
    const fileName = decodeURIComponent(
      (location.pathname.split("/").pop() || "").trim()
    );

    if (bookTitlesByFileName[fileName]) {
      return bookTitlesByFileName[fileName];
    }

    return document.title || "";
  }

  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // Character-variant equivalence classes - the same letter pairs
  // normalize() treats as identical (ي/ی/ى, ك/ک, ة/ه/ۀ). Building the
  // search regex with these classes (instead of the literal typed
  // character) means a query typed with a Persian keyboard (ک) still
  // matches - and highlights - the Arabic form (ك) wherever it occurs
  // in the source text, and vice versa, without needing to rewrite
  // the original text or remap character offsets.
  const CHAR_VARIANTS = {
    "ي": "يیى", "ی": "يیى", "ى": "يیى",
    "ك": "كک", "ک": "كک",
    "ة": "ةه", "ه": "ةهۀ", "ۀ": "ۀه"
  };

  function charClassFor(ch) {
    const variants = CHAR_VARIANTS[ch];

    if (variants) {
      const unique = [...new Set(variants.split(""))];
      return `[${unique.join("")}]`;
    }

    return escapeRegExp(ch);
  }

  // Boundary used so normal (non-root) search only matches whole
  // words - e.g. searching "وجود" must not match inside "الوجود" or
  // "موجودات". \b doesn't work here since JS regex \w is ASCII-only
  // and doesn't recognize Arabic/Persian letters, so this uses an
  // explicit lookaround against the Arabic Unicode letter block
  // (plus ZWNJ, so a half-spaced compound like "کتاب‌خانه" still
  // counts as one word and isn't matched by "کتاب" alone).
  const WORD_BOUNDARY_CHARS = "\\u0621-\\u06FF\\u200c";

  // Optional run of diacritics/tatweel allowed BETWEEN each typed
  // character when matching against the real (undiacritized-query,
  // possibly-diacritized-source) page text - this is what lets a
  // plain query still highlight a diacritized occurrence like
  // "کِتاب" in the actual page content.
  const DIACRITIC_GAP = "[\\u064B-\\u065F\\u0670\\u06D6-\\u06ED\\u0640]*";

  function buildQueryPattern(query) {
    const collapsed = query.trim().replace(/\s+/g, " ");

    if (!collapsed) {
      return "";
    }

    const charPattern = collapsed
      .split("")
      .map(ch => (ch === " " ?
        "\\s+" :
        charClassFor(ch) + DIACRITIC_GAP))
      .join("");

    return (
      `(?<![${WORD_BOUNDARY_CHARS}])` +
      charPattern +
      `(?![${WORD_BOUNDARY_CHARS}])`
    );
  }

  function createSearchBox() {
    const box = document.createElement("section");

    box.id = "inPageSearchBox";
    box.innerHTML = `
      <h2 id="inPageSearchTitle">${getPageTitle()}</h2>

      <div class="in-page-search-row">
        <label for="inPageSearchInput">جست‌وجو در همین متن</label>

        <input
          id="inPageSearchInput"
          type="search"
          placeholder="کلمه یا عبارت مورد نظر را بنویسید."
          autocomplete="off">

        <button id="inPageSearchPrevious" type="button" disabled>
          قبلی
        </button>

        <button id="inPageSearchNext" type="button" disabled>
          بعدی
        </button>

        <button id="inPageSearchClear" type="button" disabled>
          پاک کردن
        </button>

        <button
          id="inPageVoiceInput"
          type="button"
          class="in-page-voice-input-button"
          title="جست‌وجوی صوتی">
          🎤 جست‌وجوی صوتی
        </button>

        <label class="in-page-search-root-label" for="inPageSearchRoot">
          <input id="inPageSearchRoot" type="checkbox">
          جست‌وجوی ریشه‌ای
        </label>

        <label
          id="inPageShowDerivativesLabel"
          class="in-page-search-derivatives-toggle-label"
          for="inPageShowDerivatives"
          style="display:none;">
          <input id="inPageShowDerivatives" type="checkbox">
          برای مشاهده مشتقات، این تیک را بزنید
        </label>

        <button id="inPageArchiveToggle" type="button">
          آرشیو نتایج
        </button>
      </div>

      <p id="inPageSearchStatus" aria-live="polite"></p>
    `;

    document.body.insertBefore(box, document.body.firstChild);
    searchBoxElement = box;

    const resultsPanel = document.createElement("aside");
    resultsPanel.id = "inPageSearchResults";
    resultsPanel.setAttribute("aria-label", "نتایج جست‌وجو");

    const derivativesBlock = document.createElement("div");
    derivativesBlock.id = "inPageDerivativesBlock";
    derivativesBlock.className = "in-page-derivatives-block";
    derivativesBlock.setAttribute("aria-label", "مشتقات یافت‌شده");
    derivativesBlock.style.display = "none";

    document.body.insertBefore(derivativesBlock, box.nextSibling);
    document.body.insertBefore(resultsPanel, derivativesBlock.nextSibling);
    resultsPanelElement = resultsPanel;

    const archiveOverlay = document.createElement("div");
    archiveOverlay.id = "inPageArchiveOverlay";
    archiveOverlay.innerHTML = `<div id="inPageArchivePanel" role="dialog" aria-label="آرشیو نتایج"></div>`;
    document.body.insertBefore(archiveOverlay, resultsPanel.nextSibling);
    archiveOverlayElement = archiveOverlay;

    archiveOverlay.addEventListener("click", event => {
      if (event.target === archiveOverlay) {
        closeArchivePanel();
      }
    });

    const style = document.createElement("style");
    style.textContent = `
      #inPageSearchBox {
        position: sticky;
        top: 0;
        z-index: 9999;
        box-sizing: border-box;
        padding: 10px 14px;
        border-bottom: 1px solid #cbd5e1;
        background: #ffffff;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.10);
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl !important;
        text-align: right !important;
      }

      #inPageSearchTitle {
        width: min(1100px, 100%);
        margin: 0 auto 10px;
        padding: 0 26px 8px;
        border-bottom: 3px solid #2563eb;
        color: #b45309;
        font-size: 1.05rem;
        font-weight: bold;
        line-height: 1.6;
        direction: rtl !important;
        text-align: right !important;
      }

      .in-page-search-row {
        display: flex;
        flex-wrap: nowrap;
        overflow-x: auto;
        align-items: center;
        gap: 8px;
        width: min(1100px, 100%);
        margin: 0 auto;
      }

      .in-page-search-row label {
        color: #173b63;
        font-size: 0.92rem;
        font-weight: bold;
      }

      .in-page-search-row button,
      .in-page-search-row > label {
        flex-shrink: 0;
      }

      #inPageSearchInput {
        flex: 1 1 220px;
        min-width: 140px;
        padding: 8px 10px;
        border: 1px solid #94a3b8;
        border-radius: 7px;
        outline: none;
        font: inherit;
      }

      #inPageSearchInput:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15);
      }

      #inPageSearchBox button {
        padding: 7px 11px;
        border: 1px solid #93c5fd;
        border-radius: 7px;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font: inherit;
        font-size: 0.86rem;
      }

      #inPageSearchBox button:hover:not(:disabled) {
        background: #dbeafe;
      }

      #inPageSearchBox button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      .in-page-search-root-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #173b63;
        font-size: 0.84rem;
        font-weight: normal;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .in-page-search-root-label input {
        margin: 0;
        cursor: pointer;
      }

      #inPageSearchStatus {
        width: min(1100px, 100%);
        min-height: 20px;
        margin: 6px auto 0;
        color: #475569;
        font-size: 0.84rem;
      }

      mark.in-page-search-match {
        padding: 1px 2px;
        border-radius: 2px;
        background: #fde68a;
        color: inherit;
      }

      mark.in-page-search-match.current-match {
        outline: 2px solid #ea580c;
        background: #fbbf24;
      }

      @media (max-width: 600px) {
        #inPageSearchBox {
          padding: 8px 10px;
        }

        .in-page-search-row {
          flex-wrap: wrap;
          overflow-x: visible;
          gap: 6px;
        }

        .in-page-search-row label {
          width: 100%;
        }

        #inPageSearchInput {
          flex-basis: 100%;
        }
      }

      .in-page-voice-input-button {
        padding: 8px 12px;
        border: 1px solid #93c5fd;
        border-radius: 8px;
        background: #eff6ff;
        color: #1d4ed8;
        cursor: pointer;
        font: inherit;
        font-size: 0.8rem;
        white-space: nowrap;
      }

      .in-page-voice-input-button:hover:not(:disabled) {
        background: #dbeafe;
      }

      .in-page-voice-input-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .in-page-voice-input-button.is-listening {
        background: #fee2e2;
        border-color: #fca5a5;
        color: #b91c1c;
      }

      #inPageSearchResults {
        display: none;
        box-sizing: border-box;
        overflow-y: auto;
        background: #ffffff;
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      #inPageSearchResults.has-results {
        display: block;
      }

      #inPageSearchResults .in-page-search-results-header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        flex-wrap: wrap;
        padding: 8px 12px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #173b63;
        font-size: 0.82rem;
        font-weight: bold;
      }

      #inPageSearchResults .in-page-search-results-actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
      }

      .in-page-search-copy-button {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        font: inherit;
        font-size: 0.74rem;
        padding: 4px 8px;
        cursor: pointer;
      }

      .in-page-search-copy-button:hover:not(:disabled) {
        background: #dbeafe;
      }

      .in-page-search-copy-button:disabled {
        opacity: 0.45;
        cursor: not-allowed;
      }

      #inPageSearchResults .in-page-search-results-close {
        border: none;
        background: transparent;
        color: #64748b;
        font-size: 1.05rem;
        line-height: 1;
        cursor: pointer;
        padding: 2px 6px;
      }

      #inPageSearchResults .in-page-search-results-close:hover {
        color: #1d4ed8;
      }

      .in-page-search-result-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        width: 100%;
        padding: 9px 12px;
        border-bottom: 1px solid #eef2f7;
      }

      .in-page-search-result-item:last-child {
        border-bottom: none;
      }

      .in-page-result-checkbox {
        margin: 5px 0 0;
        flex-shrink: 0;
        cursor: pointer;
      }

      .in-page-search-result-jump {
        flex: 1;
        min-width: 0;
        padding: 0;
        border: none;
        background: transparent;
        color: #334155;
        font: inherit;
        font-size: 0.85rem;
        line-height: 1.9;
        text-align: right;
        direction: rtl;
        cursor: pointer;
      }

      .in-page-search-result-jump:hover {
        text-decoration: underline;
      }

      .in-page-search-result-item.active {
        background: #dbeafe;
        border-right: 3px solid #2563eb;
        padding-right: 9px;
      }

      .in-page-search-result-item mark {
        padding: 1px 2px;
        border-radius: 2px;
        background: #fde68a;
      }

      @media (min-width: 861px) {
        #inPageSearchResults {
          position: fixed;
          top: 0;
          left: 0;
          width: 220px;
          max-width: 90vw;
          bottom: 0;
          border-left: 1px solid #cbd5e1;
          box-shadow: 3px 0 10px rgba(15, 23, 42, 0.08);
        }

        /* Item 8 fix: the results panel above is position:fixed and
           sits on top of the page, so without this the left edge of
           the actual book text is hidden underneath it. Push the
           whole page content to the right by the panel's width
           whenever it's open, so nothing is covered. */
        body.in-page-search-results-open {
          margin-left: 220px;
          transition: margin-left 0.15s ease;
        }
      }

      @media (max-width: 860px) {
        #inPageSearchResults {
          position: static;
          width: 100%;
          max-height: 320px;
          border-top: 1px solid #cbd5e1;
        }
      }

      #inPageDerivativesBlock {
        position: sticky;
        z-index: 9998;
        margin: 12px 0 0;
        padding: 10px 12px;
        background: #f8fafc;
        border: 1px solid #cbd5e1;
        border-radius: 8px;
        box-shadow: 0 3px 10px rgba(15, 23, 42, 0.08);
      }

      .in-page-search-derivatives-toggle-label {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #173b63;
        font-size: 0.84rem;
        font-weight: normal;
        white-space: nowrap;
        cursor: pointer;
        user-select: none;
      }

      .in-page-search-derivatives-toggle-label input {
        margin: 0;
        cursor: pointer;
      }

      .in-page-derivatives-title {
        font-size: 0.9rem;
        font-weight: 600;
        color: #334155;
        margin: 0 0 8px;
      }

      .in-page-derivatives-list {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }

      .in-page-derivatives-empty {
        font-size: 0.85rem;
        color: #64748b;
      }

      .in-page-derivatives-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        font-size: 0.9rem;
        border: 1px solid #cbd5e1;
        border-radius: 9999px;
        background: #ffffff;
        color: #334155;
        cursor: pointer;
        user-select: none;
      }

      .in-page-derivatives-item.is-active {
        background: #0f766e;
        border-color: #0f766e;
        color: #ffffff;
      }

      #inPageArchiveOverlay {
        display: none;
        position: fixed;
        inset: 0;
        z-index: 10001;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background: rgba(15, 23, 42, 0.45);
      }

      #inPageArchiveOverlay.open {
        display: flex;
      }

      #inPageArchivePanel {
        width: min(560px, 100%);
        max-height: 80vh;
        overflow-y: auto;
        background: #ffffff;
        border-radius: 14px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.25);
        font-family: Tahoma, Arial, sans-serif;
        direction: rtl;
        text-align: right;
      }

      #inPageArchivePanel .archive-header {
        position: sticky;
        top: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 16px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #173b63;
        font-weight: bold;
      }

      #inPageArchivePanel .archive-header-actions {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .archive-item {
        padding: 10px 16px;
        border-bottom: 1px solid #eef2f7;
      }

      .archive-item:last-child {
        border-bottom: none;
      }

      .archive-item-title {
        color: #b45309;
        font-size: 0.78rem;
        font-weight: bold;
        margin-bottom: 4px;
      }

      .archive-item-text {
        margin: 0 0 6px;
        color: #334155;
        font-size: 0.86rem;
        line-height: 1.8;
      }

      .archive-item-actions {
        display: flex;
        gap: 8px;
      }

      .archive-item-actions a,
      .archive-item-actions button,
      #inPageArchivePanel .archive-header-actions button {
        border: 1px solid #93c5fd;
        border-radius: 6px;
        background: #eff6ff;
        color: #1d4ed8;
        font: inherit;
        font-size: 0.74rem;
        padding: 4px 8px;
        cursor: pointer;
        text-decoration: none;
      }

      .archive-item-actions a:hover,
      .archive-item-actions button:hover,
      #inPageArchivePanel .archive-header-actions button:hover {
        background: #dbeafe;
      }

      .archive-empty {
        padding: 26px 16px;
        color: #64748b;
        text-align: center;
        font-size: 0.86rem;
      }
    `;

    document.head.appendChild(style);

    reserveScrollOffsetForStickyBox();
    window.addEventListener("resize", reserveScrollOffsetForStickyBox);
  }

  function reserveScrollOffsetForStickyBox() {
    if (!searchBoxElement) {
      return;
    }

    const boxHeight = searchBoxElement.offsetHeight;
    let totalHeight = boxHeight;

    if (resultsPanelElement) {
      // Has no effect when the panel is position:static (mobile),
      // but keeps the fixed desktop side panel below the sticky bar
      // instead of hidden behind it.
      resultsPanelElement.style.top = boxHeight + "px";

      if (
        resultsPanelElement.classList.contains("has-results") &&
        getComputedStyle(resultsPanelElement).position !== "fixed"
      ) {
        totalHeight += resultsPanelElement.offsetHeight;
      }
    }

    document.documentElement.style.setProperty(
      "scroll-padding-top",
      totalHeight + "px"
    );
  }

  function isSearchInterface(node) {
    return node.parentElement &&
      (
        node.parentElement.closest("#inPageSearchBox") ||
        node.parentElement.closest("#inPageSearchResults")
      );
  }

  function removeHighlights() {
    document.querySelectorAll("mark.in-page-search-match").forEach(mark => {
      const parent = mark.parentNode;

      parent.replaceChild(
        document.createTextNode(mark.textContent),
        mark
      );

      parent.normalize();
    });

    matches = [];
    currentMatch = -1;
    selectedMatchIndexes.clear();
  }

  function getSearchableTextNodes() {
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;

          if (
            !parent ||
            ignoredTags.has(parent.tagName) ||
            isSearchInterface(node) ||
            !node.nodeValue.trim()
          ) {
            return NodeFilter.FILTER_REJECT;
          }

          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );

    const nodes = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode);
    }

    return nodes;
  }

  function wrapRanges(node, ranges) {
    const originalText = node.nodeValue;
    const fragment = document.createDocumentFragment();
    const createdMatches = [];
    let lastIndex = 0;

    ranges.forEach(range => {
      if (range.start > lastIndex) {
        fragment.appendChild(
          document.createTextNode(
            originalText.slice(lastIndex, range.start)
          )
        );
      }

      const mark = document.createElement("mark");
      mark.className = "in-page-search-match";
      mark.textContent = originalText.slice(range.start, range.end);

      fragment.appendChild(mark);
      createdMatches.push(mark);

      lastIndex = range.end;
    });

    if (lastIndex < originalText.length) {
      fragment.appendChild(
        document.createTextNode(originalText.slice(lastIndex))
      );
    }

    node.parentNode.replaceChild(fragment, node);

    return createdMatches;
  }

  function highlightLiteralMatches(query) {
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
      return [];
    }

    const patternSource = buildQueryPattern(query);

    if (!patternSource) {
      return [];
    }

    const createdMatches = [];

    getSearchableTextNodes().forEach(node => {
      const originalText = node.nodeValue;
      const normalizedText = normalize(originalText);

      if (!normalizedText.includes(normalizedQuery)) {
        return;
      }

      const pattern = new RegExp(patternSource, "gi");

      if (!pattern.test(originalText)) {
        return;
      }

      pattern.lastIndex = 0;

      const ranges = [];
      let match;

      while ((match = pattern.exec(originalText)) !== null) {
        ranges.push({
          start: match.index,
          end: match.index + match[0].length
        });
      }

      createdMatches.push(...wrapRanges(node, ranges));
    });

    return createdMatches;
  }

  function highlightStemMatches(query) {
    const queryStems = getQueryStems(query);

    if (queryStems.length === 0) {
      return [];
    }

    const createdMatches = [];

    getSearchableTextNodes().forEach(node => {
      const originalText = node.nodeValue;
      const ranges = [];
      let match;

      WORD_PATTERN.lastIndex = 0;

      while ((match = WORD_PATTERN.exec(originalText)) !== null) {
        const wordStem = stemWord(match[0]);

        if (wordStem && queryStems.includes(wordStem)) {
          ranges.push({
            start: match.index,
            end: match.index + match[0].length
          });
        }
      }

      if (ranges.length === 0) {
        return;
      }

      createdMatches.push(...wrapRanges(node, ranges));
    });

    return createdMatches;
  }

  function highlightMatches(query) {
    if (!query.trim()) {
      return [];
    }

    return isRootSearchEnabled() ?
      highlightStemMatches(query) :
      highlightLiteralMatches(query);
  }

  function updateButtons() {
    const previousButton = document.getElementById("inPageSearchPrevious");
    const nextButton = document.getElementById("inPageSearchNext");
    const clearButton = document.getElementById("inPageSearchClear");

    const enabled = matches.length > 0;

    previousButton.disabled = !enabled;
    nextButton.disabled = !enabled;
    clearButton.disabled = matches.length === 0 &&
      !document.getElementById("inPageSearchInput").value;
  }

  function updateStatus() {
    const status = document.getElementById("inPageSearchStatus");

    if (!document.getElementById("inPageSearchInput").value.trim()) {
      status.textContent = "";
      return;
    }

    if (matches.length === 0) {
      status.textContent = "عبارتی پیدا نشد.";
      return;
    }

    status.textContent =
      `نتیجهٔ ${currentMatch + 1} از ${matches.length}`;
  }

  // ---- Results panel (Word-style "find" side list) -----------------

  const SNIPPET_BLOCK_TAGS = new Set([
    "P", "LI", "DIV", "TD", "TH", "BLOCKQUOTE",
    "H1", "H2", "H3", "H4", "H5", "H6",
    "DD", "DT", "FIGCAPTION", "SECTION", "ARTICLE"
  ]);

  const SNIPPET_SENTENCE_ENDERS = /[.!?؟۔]/;
  const SNIPPET_MAX_LENGTH = 240;

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function getSnippetContainer(mark) {
    let el = mark.parentElement;

    while (el && el !== document.body) {
      if (SNIPPET_BLOCK_TAGS.has(el.tagName)) {
        return el;
      }

      el = el.parentElement;
    }

    return mark.parentElement || document.body;
  }

  function getTextOffsetBefore(container, node) {
    const range = document.createRange();

    range.selectNodeContents(container);
    range.setEndBefore(node);

    return range.toString().length;
  }

  function getSnippetBounds(mark) {
    const container = getSnippetContainer(mark);
    const rawText = container.textContent;
    const startOffset = getTextOffsetBefore(container, mark);
    const endOffset = startOffset + mark.textContent.length;

    let sentenceStart = startOffset;

    while (
      sentenceStart > 0 &&
      !SNIPPET_SENTENCE_ENDERS.test(rawText[sentenceStart - 1])
    ) {
      sentenceStart--;
    }

    let sentenceEnd = endOffset;

    while (
      sentenceEnd < rawText.length &&
      !SNIPPET_SENTENCE_ENDERS.test(rawText[sentenceEnd - 1])
    ) {
      sentenceEnd++;
    }

    if (sentenceEnd - sentenceStart > SNIPPET_MAX_LENGTH) {
      const half = Math.floor(SNIPPET_MAX_LENGTH / 2);

      sentenceStart = Math.max(sentenceStart, startOffset - half);
      sentenceEnd = Math.min(sentenceEnd, endOffset + half);
    }

    return { rawText, startOffset, endOffset, sentenceStart, sentenceEnd };
  }

  function buildSnippetHtml(mark) {
    const {
      rawText, startOffset, endOffset, sentenceStart, sentenceEnd
    } = getSnippetBounds(mark);

    const before = rawText
      .slice(sentenceStart, startOffset)
      .replace(/\s+/g, " ")
      .trim();

    const matchedText = rawText.slice(startOffset, endOffset);

    const after = rawText
      .slice(endOffset, sentenceEnd)
      .replace(/\s+/g, " ")
      .trim();

    const prefix = sentenceStart > 0 ? "…" : "";
    const suffix = sentenceEnd < rawText.length ? "…" : "";

    return (
      `${prefix}${escapeHtml(before)} ` +
      `<mark>${escapeHtml(matchedText)}</mark> ` +
      `${escapeHtml(after)}${suffix}`
    ).replace(/\s+/g, " ").trim();
  }

  function getSnippetPlainText(mark) {
    const { rawText, sentenceStart, sentenceEnd } = getSnippetBounds(mark);

    const prefix = sentenceStart > 0 ? "…" : "";
    const suffix = sentenceEnd < rawText.length ? "…" : "";

    return (
      prefix +
      rawText.slice(sentenceStart, sentenceEnd).replace(/\s+/g, " ").trim() +
      suffix
    );
  }

  // Item 3: builds a direct link back to a specific match - a
  // plain URL to this page with a browser text-fragment
  // (#:~:text=...) pointing at the exact matched text, so pasting it
  // lets the reader jump straight back to that spot.
  function buildMatchUrl(mark) {
    const base = location.origin + location.pathname;
    const fragmentText = mark.textContent.trim();

    if (!fragmentText) {
      return base;
    }

    return `${base}#:~:text=${encodeURIComponent(fragmentText)}`;
  }

  // ---- Results archive (item 7) -------------------------------------
  // Saved results persist in localStorage under one shared key so
  // items saved from any book page (and from the site-wide search on
  // index.htm, which uses the same key/shape) show up together.
  const ARCHIVE_STORAGE_KEY = "milaniSearchResultsArchive";

  function loadArchive() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ARCHIVE_STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }

  function saveArchive(items) {
    try {
      localStorage.setItem(ARCHIVE_STORAGE_KEY, JSON.stringify(items));
    } catch (error) {
      // Storage unavailable or full - archive just won't persist.
    }
  }

  function addSelectedToArchive() {
    const selected = [...selectedMatchIndexes]
      .sort((a, b) => a - b)
      .map(index => matches[index])
      .filter(Boolean);

    if (selected.length === 0) {
      return;
    }

    const title = getPageTitle();
    const archive = loadArchive();

    selected.forEach(mark => {
      archive.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        title: title,
        text: getSnippetPlainText(mark),
        url: buildMatchUrl(mark),
        savedAt: new Date().toISOString()
      });
    });

    saveArchive(archive);
    renderArchivePanel();

    const button = document.getElementById("inPageAddToArchive");

    if (button) {
      const originalText = button.textContent;
      button.textContent = "به آرشیو افزوده شد!";
      setTimeout(() => { button.textContent = originalText; }, 1500);
    }
  }

  function removeFromArchive(id) {
    saveArchive(loadArchive().filter(item => item.id !== id));
    renderArchivePanel();
  }

  function clearArchive() {
    saveArchive([]);
    renderArchivePanel();
  }

  function renderArchivePanel() {
    const panel = document.getElementById("inPageArchivePanel");

    if (!panel) {
      return;
    }

    const items = loadArchive().slice().reverse();

    const listHtml = items.length === 0 ?
      `<p class="archive-empty">هنوز نتیجه‌ای در آرشیو ذخیره نشده است.</p>` :
      items.map(item => `
        <div class="archive-item">
          <div class="archive-item-title">${escapeHtml(item.title || "")}</div>
          <p class="archive-item-text">"${escapeHtml(item.text || "")}"</p>
          <div class="archive-item-actions">
            <a href="${escapeHtml(item.url || "#")}" target="_blank" rel="noopener">
              بازکردن
            </a>
            <button type="button" data-archive-id="${escapeHtml(item.id)}">
              حذف
            </button>
          </div>
        </div>
      `).join("");

    panel.innerHTML = `
      <div class="archive-header">
        <span>آرشیو نتایج (${items.length})</span>
        <div class="archive-header-actions">
          <button type="button" id="inPageArchiveClear">پاک‌کردن همه</button>
          <button type="button" id="inPageArchiveClose">بستن</button>
        </div>
      </div>
      ${listHtml}
    `;

    const clearButton = panel.querySelector("#inPageArchiveClear");
    if (clearButton) {
      clearButton.addEventListener("click", clearArchive);
    }

    const closeButton = panel.querySelector("#inPageArchiveClose");
    if (closeButton) {
      closeButton.addEventListener("click", closeArchivePanel);
    }

    panel.querySelectorAll("[data-archive-id]").forEach(button => {
      button.addEventListener("click", () => {
        removeFromArchive(button.dataset.archiveId);
      });
    });
  }

  function openArchivePanel() {
    renderArchivePanel();
    archiveOverlayElement.classList.add("open");
  }

  function closeArchivePanel() {
    archiveOverlayElement.classList.remove("open");
  }

  // ---- Derivative keys (visual grouping, item 2/3) ------------------
  // Two surface forms that look identical to the reader must be one
  // entry in the derivatives block, even if they differ technically
  // (e.g. with/without a diacritic). So the grouping key strips
  // diacritics, ZWNJ/ZWJ, and normalises letter variants.
  const VISUAL_DIACRITICS = /[\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;
  const VISUAL_INVISIBLE = /[\u200C-\u200F]/g;

  function getVisualWordKey(word) {
    return (word || "")
      .replace(VISUAL_DIACRITICS, "")
      .replace(VISUAL_INVISIBLE, "")
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/[ۀة]/g, "ه")
      .replace(/[أإآ]/g, "ا")
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ی")
      .toLowerCase()
      .trim();
  }

  function getVisualWordLabel(word) {
    return (word || "")
      .replace(VISUAL_DIACRITICS, "")
      .replace(VISUAL_INVISIBLE, "")
      .trim();
  }

  function getMatchVisualKey(mark) {
    return getVisualWordKey(mark.textContent);
  }

  function isMatchVisible(index) {
    if (!isRootSearchEnabled() || activeDerivativeKeys.size === 0) {
      return true;
    }

    const mark = matches[index];
    return mark ? activeDerivativeKeys.has(getMatchVisualKey(mark)) : false;
  }

  function renderDerivativesBlock() {
    const block = document.getElementById("inPageDerivativesBlock");

    if (!block) {
      return;
    }

    if (!isRootSearchEnabled() || !isDerivativesViewEnabled() || matches.length === 0) {
      block.innerHTML = "";
      block.style.display = "none";
      return;
    }

    const grouped = new Map();

    matches.forEach(mark => {
      const key = getMatchVisualKey(mark);

      if (!key) {
        return;
      }

      if (!grouped.has(key)) {
        grouped.set(key, {
          key: key,
          label: getVisualWordLabel(mark.textContent),
          count: 0
        });
      }

      grouped.get(key).count += 1;
    });

    if (grouped.size === 0) {
      block.innerHTML = "";
      block.style.display = "none";
      return;
    }

    const derivatives = [...grouped.values()].sort((a, b) =>
      a.label.localeCompare(b.label, "fa")
    );

    block.innerHTML =
      `<div class="in-page-derivatives-title">مشتقات یافت‌شده (${derivatives.length})</div>` +
      `<div class="in-page-derivatives-list">` +
        derivatives.map(d => {
          const active = activeDerivativeKeys.has(d.key) ? " is-active" : "";
          return (
            `<span class="in-page-derivatives-item${active}" data-deriv-key="${escapeHtml(d.key)}" role="button" tabindex="0">` +
              `${escapeHtml(d.label)} <span class="deriv-count">(${d.count})</span>` +
            `</span>`
          );
        }).join("") +
      `</div>`;

    block.style.display = "block";
    updateDerivativesBlockPosition();

    block.querySelectorAll(".in-page-derivatives-item").forEach(item => {
      const toggle = () => {
        const key = item.dataset.derivKey;

        if (activeDerivativeKeys.has(key)) {
          activeDerivativeKeys.delete(key);
        } else {
          activeDerivativeKeys.add(key);
        }

        renderDerivativesBlock();
        renderResultsPanel();
      };

      item.addEventListener("click", toggle);
      item.addEventListener("keydown", event => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  function renderResultsPanel() {
    if (!resultsPanelElement) {
      return;
    }

    if (matches.length === 0) {
      resultsPanelElement.innerHTML = "";
      resultsPanelElement.classList.remove("has-results");
      document.body.classList.remove("in-page-search-results-open");
      selectedMatchIndexes.clear();
      renderDerivativesBlock();
      reserveScrollOffsetForStickyBox();
      return;
    }

    const visibleMatches = matches
      .map((mark, index) => ({ mark, index }))
      .filter(item => isMatchVisible(item.index));

    const items = visibleMatches
      .map(({ mark, index }) => {
        const snippetHtml = buildSnippetHtml(mark);
        const activeClass = index === currentMatch ? " active" : "";
        const checkedAttr = selectedMatchIndexes.has(index) ? "checked" : "";

        return (
          `<div class="in-page-search-result-item${activeClass}" data-index="${index}">` +
            `<input type="checkbox" class="in-page-result-checkbox" data-index="${index}" ${checkedAttr} aria-label="انتخاب این نتیجه">` +
            `<button type="button" class="in-page-search-result-jump" data-index="${index}">` +
              snippetHtml +
            `</button>` +
          `</div>`
        );
      })
      .join("");

    const filteredNote = activeDerivativeKeys.size > 0
      ? ` (${visibleMatches.length} از ${matches.length})`
      : "";

    resultsPanelElement.innerHTML = `
      <div class="in-page-search-results-header">
        <span>${matches.length} نتیجه${filteredNote}</span>
        <div class="in-page-search-results-actions">
          <button type="button" id="inPageSelectAll" class="in-page-search-copy-button" title="انتخاب همه نتایج قابل مشاهده">
            انتخاب همه
          </button>
          <button type="button" id="inPageClearSelection" class="in-page-search-copy-button" disabled>
            حذف انتخاب
          </button>
          <button type="button" id="inPageRemoveSelected" class="in-page-search-copy-button" disabled>
            حذف موارد انتخاب‌شده
          </button>
          <button type="button" id="inPageAddToArchive" class="in-page-search-copy-button" disabled>
            افزودن به آرشیو
          </button>
          <button type="button" id="inPageCopySelected" class="in-page-search-copy-button" disabled>
            کپی انتخاب‌شده‌ها
          </button>
          <button type="button" class="in-page-search-results-close" aria-label="بستن فهرست نتایج">×</button>
        </div>
      </div>
      ${items}
    `;

    resultsPanelElement.classList.add("has-results");
    document.body.classList.add("in-page-search-results-open");

    resultsPanelElement
      .querySelectorAll(".in-page-search-result-jump")
      .forEach(button => {
        button.addEventListener("click", () => {
          showMatch(parseInt(button.dataset.index, 10));
        });
      });

    resultsPanelElement
      .querySelectorAll(".in-page-result-checkbox")
      .forEach(checkbox => {
        checkbox.addEventListener("change", () => {
          const index = parseInt(checkbox.dataset.index, 10);

          if (checkbox.checked) {
            selectedMatchIndexes.add(index);
          } else {
            selectedMatchIndexes.delete(index);
          }

          updateCopySelectedButton();
        });
      });

    const closeButton = resultsPanelElement.querySelector(
      ".in-page-search-results-close"
    );

    if (closeButton) {
      closeButton.addEventListener("click", () => {
        resultsPanelElement.classList.remove("has-results");
        document.body.classList.remove("in-page-search-results-open");
        reserveScrollOffsetForStickyBox();
      });
    }

    const copyButton = resultsPanelElement.querySelector("#inPageCopySelected");

    if (copyButton) {
      copyButton.addEventListener("click", handleCopySelectedMatches);
    }

    const archiveButton = resultsPanelElement.querySelector("#inPageAddToArchive");

    if (archiveButton) {
      archiveButton.addEventListener("click", addSelectedToArchive);
    }

    const selectAllButton = resultsPanelElement.querySelector("#inPageSelectAll");

    if (selectAllButton) {
      selectAllButton.addEventListener("click", () => {
        visibleMatches.forEach(({ index }) => {
          selectedMatchIndexes.add(index);
        });
        renderResultsPanel();
      });
    }

    const clearSelectionButton =
      resultsPanelElement.querySelector("#inPageClearSelection");

    if (clearSelectionButton) {
      clearSelectionButton.addEventListener("click", () => {
        selectedMatchIndexes.clear();
        renderResultsPanel();
      });
    }

    const removeSelectedButton =
      resultsPanelElement.querySelector("#inPageRemoveSelected");

    if (removeSelectedButton) {
      removeSelectedButton.addEventListener("click", removeSelectedMatches);
    }

    updateCopySelectedButton();
    reserveScrollOffsetForStickyBox();
  }

  function removeSelectedMatches() {
    const indexes = [...selectedMatchIndexes].sort((a, b) => a - b);

    if (indexes.length === 0) {
      return;
    }

    indexes.forEach(index => {
      const mark = matches[index];

      if (!mark || !mark.parentNode) {
        return;
      }

      const parent = mark.parentNode;
      parent.replaceChild(
        document.createTextNode(mark.textContent),
        mark
      );
      parent.normalize();
    });

    matches = Array.from(
      document.querySelectorAll("mark.in-page-search-match")
    );

    currentMatch = matches.length > 0 ? 0 : -1;

    if (matches[0]) {
      matches[0].classList.add("current-match");
    }

    selectedMatchIndexes.clear();

    if (isRootSearchEnabled()) {
      renderDerivativesBlock();
    }

    renderResultsPanel();
    updateButtons();
    updateStatus();
  }

  function updateCopySelectedButton() {
    if (!resultsPanelElement) {
      return;
    }

    const button = resultsPanelElement.querySelector("#inPageCopySelected");
    const archiveButton = resultsPanelElement.querySelector("#inPageAddToArchive");
    const clearSelectionButton =
      resultsPanelElement.querySelector("#inPageClearSelection");
    const removeSelectedButton =
      resultsPanelElement.querySelector("#inPageRemoveSelected");

    if (!button) {
      return;
    }

    const count = selectedMatchIndexes.size;

    button.disabled = count === 0;
    button.textContent = count > 0 ?
      `کپی انتخاب‌شده‌ها (${count})` :
      "کپی انتخاب‌شده‌ها";

    if (archiveButton) {
      archiveButton.disabled = count === 0;
      archiveButton.textContent = count > 0 ?
        `افزودن به آرشیو (${count})` :
        "افزودن به آرشیو";
    }

    if (clearSelectionButton) {
      clearSelectionButton.disabled = count === 0;
    }

    if (removeSelectedButton) {
      removeSelectedButton.disabled = count === 0;
      removeSelectedButton.textContent = count > 0 ?
        `حذف موارد انتخاب‌شده (${count})` :
        "حذف موارد انتخاب‌شده";
    }
  }

  async function handleCopySelectedMatches() {
    const button = resultsPanelElement.querySelector("#inPageCopySelected");

    const selected = [...selectedMatchIndexes]
      .sort((a, b) => a - b)
      .map(index => matches[index])
      .filter(Boolean);

    if (selected.length === 0) {
      return;
    }

    // Item 2: the file's own title is shown once, in a clearly
    // separated header line, rather than repeated per snippet (all
    // selected matches necessarily come from this same page).
    // Item 3: each snippet gets its own reference link right under
    // it, so a pasted result can be traced back to its exact spot.
    // The link itself is kept short and clickable: in plain-text
    // targets the raw URL still appears (there's no way around that
    // in plain text), but anywhere rich/HTML paste is supported, it
    // collapses to a short "لینک منبع" hyperlink instead.
    const pageTitle = getPageTitle();
    const header = `——— عنوان: ${pageTitle} ———`;

    const textBody = selected
      .map((mark, index) => {
        const snippet = getSnippetPlainText(mark);
        const url = buildMatchUrl(mark);
        return `${index + 1}. "${snippet}"\nلینک منبع: ${url}`;
      })
      .join("\n\n");

    const text = `${header}\n\n${textBody}`;

    const htmlBody = selected
      .map((mark, index) => {
        const snippet = escapeHtml(getSnippetPlainText(mark));
        const url = escapeHtml(buildMatchUrl(mark));
        return (
          `<p>${index + 1}. "${snippet}"<br>` +
          `<a href="${url}">لینک منبع</a></p>`
        );
      })
      .join("");

    const html =
      `<p><strong>——— عنوان: ${escapeHtml(pageTitle)} ———</strong></p>` +
      htmlBody;

    const ok = await copyRichTextToClipboard(text, html);

    if (button) {
      button.textContent = ok ? "کپی شد!" : "خطا در کپی";
      setTimeout(updateCopySelectedButton, 1500);
    }
  }

  function updateResultsPanelActiveState() {
    if (!resultsPanelElement) {
      return;
    }

    resultsPanelElement
      .querySelectorAll(".in-page-search-result-item")
      .forEach((item, index) => {
        item.classList.toggle("active", index === currentMatch);
      });

    const activeItem = resultsPanelElement.querySelector(
      ".in-page-search-result-item.active"
    );

    if (activeItem) {
      activeItem.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }

  function showMatch(index) {
    if (matches.length === 0) {
      return;
    }

    matches.forEach(match => {
      match.classList.remove("current-match");
    });

    currentMatch = (index + matches.length) % matches.length;

    const selected = matches[currentMatch];
    selected.classList.add("current-match");

    selected.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });

    updateResultsPanelActiveState();
    updateStatus();
  }

  // ---- Voice input (item 1) ------------------------------------------
  // Mirrors the site-wide search's voice-typing button (index.htm) so
  // the same "speak your query" option exists in this file's own
  // in-page search box, not just on the main search page.
  let inPageVoiceRecognition = null;

  function getSpeechRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function toggleInPageVoiceInput() {
    const Ctor = getSpeechRecognitionCtor();
    const button = document.getElementById("inPageVoiceInput");
    const input = document.getElementById("inPageSearchInput");

    if (!Ctor) {
      if (button) {
        button.textContent = "🎤 پشتیبانی نمی‌شود";
      }
      return;
    }

    if (inPageVoiceRecognition) {
      inPageVoiceRecognition.stop();
      return;
    }

    inPageVoiceRecognition = new Ctor();
    inPageVoiceRecognition.lang = "fa-IR";
    inPageVoiceRecognition.interimResults = false;
    inPageVoiceRecognition.maxAlternatives = 1;

    inPageVoiceRecognition.addEventListener("start", () => {
      if (button) {
        button.classList.add("is-listening");
        button.textContent = "🎤 در حال شنیدن…";
      }
    });

    inPageVoiceRecognition.addEventListener("result", event => {
      const transcript = event.results[0][0].transcript;
      input.value = transcript;
      performSearch();
    });

    inPageVoiceRecognition.addEventListener("end", () => {
      if (button) {
        button.classList.remove("is-listening");
        button.textContent = "🎤 جست‌وجوی صوتی";
      }
      inPageVoiceRecognition = null;
    });

    inPageVoiceRecognition.start();
  }

  function performSearch() {
    const input = document.getElementById("inPageSearchInput");
    const query = input.value.trim();

    activeDerivativeKeys.clear();
    removeHighlights();

    if (!query) {
      updateButtons();
      updateStatus();
      renderResultsPanel();
      return;
    }

    matches = highlightMatches(query);
    renderResultsPanel();
    renderDerivativesBlock();

    if (matches.length > 0) {
      showMatch(0);
    } else {
      updateStatus();
    }

    updateButtons();
  }

  function clearSearch() {
    const input = document.getElementById("inPageSearchInput");

    input.value = "";
    activeDerivativeKeys.clear();
    removeHighlights();
    updateButtons();
    updateStatus();
    renderResultsPanel();
  }

  // Item 3: "رفتن به عبارت یافت‌شده" on the main site search links here
  // with a target string identifying ONE specific occurrence: the bare
  // matched text, exactly as built by index.htm's buildFragmentText.
  // getMatchFragmentText() below rebuilds that same bare string for
  // each highlighted match here, so the one the link actually pointed
  // at can be found and jumped to.
  //
  // That target string is read from the "frag" query-string param,
  // NOT from the "#:~:text=" hash. Chrome/Edge strip the text-fragment
  // directive out of the URL before a destination page's own scripts
  // run (it's consumed internally for the browser's native jump/
  // highlight, then removed via history.replaceState), so
  // location.hash never actually contains it by the time this script
  // runs - reading it from there always missed and silently fell back
  // to match #1. The query-string copy survives navigation intact.
  // The old hash-based read is kept as a fallback for browsers that
  // don't implement text fragments (and so never strip the hash).
  function getTextFragmentFromHash() {
    const fromQuery = new URLSearchParams(location.search).get("frag");

    if (fromQuery) {
      return fromQuery;
    }

    const marker = "#:~:text=";
    const hash = location.hash || "";
    const index = hash.indexOf(marker);

    if (index === -1) {
      return null;
    }

    const raw = hash.slice(index + marker.length);

    try {
      return decodeURIComponent(raw);
    } catch (error) {
      return raw;
    }
  }

  function getMatchFragmentText(mark) {
    // Must mirror index.htm's buildFragmentText exactly: that function
    // sends ONLY the matched text (no trailing words) as the "frag"
    // param, so this side has to build the same bare string or the
    // comparison in findMatchIndexForFragment never lines up and the
    // link silently falls back to match #1.
    const matchText = mark.textContent.replace(/\s+/g, " ").trim();

    return normalize(matchText);
  }

  function findMatchIndexForFragment(fragmentText) {
    if (!fragmentText) {
      return -1;
    }

    const normalizedFragment = normalize(fragmentText);

    return matches.findIndex(
      mark => getMatchFragmentText(mark) === normalizedFragment
    );
  }

  function applyIncomingQueryFromUrl() {
    const params = new URLSearchParams(location.search);
    const incomingQuery = params.get("q");

    if (!incomingQuery) {
      return;
    }

    const input = document.getElementById("inPageSearchInput");
    const rootToggle = document.getElementById("inPageSearchRoot");

    if (!input) {
      return;
    }

    input.value = incomingQuery;

    if (rootToggle && params.get("root") === "1") {
      rootToggle.checked = true;
      updateDerivativesToggleVisibility();
    }

    performSearch();

    // Land on the exact occurrence the link pointed at, if it can be
    // found among this file's matches; otherwise leave performSearch's
    // default of match #1.
    const targetIndex = findMatchIndexForFragment(getTextFragmentFromHash());

    if (targetIndex !== -1) {
      showMatch(targetIndex);
    }
  }

  function initialize() {
    // Item 5: make the browser tab (and the window/history entry)
    // show the Persian/Arabic title of this book instead of falling
    // back to the raw URL, which is what a page with no <title> text
    // shows in the tab.
    document.title = getPageTitle();

    createSearchBox();

    const input = document.getElementById("inPageSearchInput");
    const previousButton = document.getElementById("inPageSearchPrevious");
    const nextButton = document.getElementById("inPageSearchNext");
    const clearButton = document.getElementById("inPageSearchClear");

    let searchTimer;

    input.addEventListener("input", () => {
      clearTimeout(searchTimer);

      searchTimer = setTimeout(performSearch, 250);
    });

    input.addEventListener("keydown", event => {
      if (event.key === "Enter") {
        event.preventDefault();

        if (event.shiftKey) {
          showMatch(currentMatch - 1);
        } else {
          showMatch(currentMatch + 1);
        }
      }

      if (event.key === "Escape") {
        clearSearch();
      }
    });

    previousButton.addEventListener("click", () => {
      showMatch(currentMatch - 1);
    });

    nextButton.addEventListener("click", () => {
      showMatch(currentMatch + 1);
    });

    clearButton.addEventListener("click", clearSearch);

    const voiceButton = document.getElementById("inPageVoiceInput");
    if (voiceButton) {
      voiceButton.addEventListener("click", toggleInPageVoiceInput);
    }

    const rootToggle = document.getElementById("inPageSearchRoot");
    const showDerivativesToggle = document.getElementById("inPageShowDerivatives");

    rootToggle.addEventListener("change", () => {
      activeDerivativeKeys.clear();
      updateDerivativesToggleVisibility();

      if (!rootToggle.checked && showDerivativesToggle) {
        showDerivativesToggle.checked = false;
      }

      if (input.value.trim()) {
        performSearch();
      } else {
        renderResultsPanel();
        renderDerivativesBlock();
      }
    });

    if (showDerivativesToggle) {
      showDerivativesToggle.addEventListener("change", () => {
        if (!showDerivativesToggle.checked) {
          activeDerivativeKeys.clear();
          renderResultsPanel();
        }

        renderDerivativesBlock();
      });
    }

    updateDerivativesToggleVisibility();

    window.addEventListener("resize", updateDerivativesBlockPosition);

    if (typeof ResizeObserver !== "undefined" && searchBoxElement) {
      new ResizeObserver(updateDerivativesBlockPosition).observe(searchBoxElement);
    }

    const archiveToggleButton = document.getElementById("inPageArchiveToggle");
    if (archiveToggleButton) {
      archiveToggleButton.addEventListener("click", openArchivePanel);
    }

    document.addEventListener("keydown", event => {
      const isMac = navigator.platform.toUpperCase().includes("MAC");

      if (
        (isMac && event.metaKey && event.key.toLowerCase() === "f") ||
        (!isMac && event.ctrlKey && event.key.toLowerCase() === "f")
      ) {
        event.preventDefault();
        input.focus();
        input.select();
      }
    });

    applyIncomingQueryFromUrl();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
