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

  function normalize(text) {
    return (text || "")
      .toLowerCase()
      .replace(/[يى]/g, "ی")
      .replace(/ك/g, "ک")
      .replace(/ۀ/g, "ه")
      .replace(/ة/g, "ه")
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

  // Boundary used so normal (non-root) search only matches whole
  // words - e.g. searching "وجود" must not match inside "الوجود" or
  // "موجودات". \b doesn't work here since JS regex \w is ASCII-only
  // and doesn't recognize Arabic/Persian letters, so this uses an
  // explicit lookaround against the Arabic Unicode letter block
  // (plus ZWNJ, so a half-spaced compound like "کتاب‌خانه" still
  // counts as one word and isn't matched by "کتاب" alone).
  const WORD_BOUNDARY_CHARS = "\\u0621-\\u06FF\\u200c";

  function buildQueryPattern(query) {
    const collapsed = query.trim().replace(/\s+/g, " ");

    if (!collapsed) {
      return "";
    }

    const escaped = escapeRegExp(collapsed).replace(/ /g, "\\s+");

    return (
      `(?<![${WORD_BOUNDARY_CHARS}])` +
      escaped +
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

        <label class="in-page-search-root-label" for="inPageSearchRoot">
          <input id="inPageSearchRoot" type="checkbox">
          جست‌وجوی ریشه‌ای
        </label>
      </div>

      <p id="inPageSearchStatus" aria-live="polite"></p>
    `;

    document.body.insertBefore(box, document.body.firstChild);
    searchBoxElement = box;

    const resultsPanel = document.createElement("aside");
    resultsPanel.id = "inPageSearchResults";
    resultsPanel.setAttribute("aria-label", "نتایج جست‌وجو");
    document.body.insertBefore(resultsPanel, box.nextSibling);
    resultsPanelElement = resultsPanel;

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
        flex-wrap: wrap;
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

      #inPageSearchInput {
        flex: 1 1 250px;
        min-width: 180px;
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
          gap: 6px;
        }

        .in-page-search-row label {
          width: 100%;
        }

        #inPageSearchInput {
          flex-basis: 100%;
        }
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
        padding: 8px 12px;
        border-bottom: 1px solid #e2e8f0;
        background: #f8fafc;
        color: #173b63;
        font-size: 0.82rem;
        font-weight: bold;
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
        display: block;
        width: 100%;
        padding: 9px 12px;
        border: none;
        border-bottom: 1px solid #eef2f7;
        background: transparent;
        color: #334155;
        font: inherit;
        font-size: 0.85rem;
        line-height: 1.9;
        text-align: right;
        direction: rtl;
        cursor: pointer;
      }

      .in-page-search-result-item:last-child {
        border-bottom: none;
      }

      .in-page-search-result-item:hover {
        background: #eef2ff;
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
          width: 300px;
          max-width: 90vw;
          bottom: 0;
          border-left: 1px solid #cbd5e1;
          box-shadow: 3px 0 10px rgba(15, 23, 42, 0.08);
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

  function buildSnippetHtml(mark) {
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

  function renderResultsPanel() {
    if (!resultsPanelElement) {
      return;
    }

    if (matches.length === 0) {
      resultsPanelElement.innerHTML = "";
      resultsPanelElement.classList.remove("has-results");
      reserveScrollOffsetForStickyBox();
      return;
    }

    const items = matches
      .map((mark, index) => {
        const snippetHtml = buildSnippetHtml(mark);
        const activeClass = index === currentMatch ? " active" : "";

        return (
          `<button type="button" class="in-page-search-result-item${activeClass}" data-index="${index}">` +
          snippetHtml +
          `</button>`
        );
      })
      .join("");

    resultsPanelElement.innerHTML = `
      <div class="in-page-search-results-header">
        <span>${matches.length} نتیجه</span>
        <button type="button" class="in-page-search-results-close" aria-label="بستن فهرست نتایج">×</button>
      </div>
      ${items}
    `;

    resultsPanelElement.classList.add("has-results");

    resultsPanelElement
      .querySelectorAll(".in-page-search-result-item")
      .forEach(item => {
        item.addEventListener("click", () => {
          showMatch(parseInt(item.dataset.index, 10));
        });
      });

    const closeButton = resultsPanelElement.querySelector(
      ".in-page-search-results-close"
    );

    if (closeButton) {
      closeButton.addEventListener("click", () => {
        resultsPanelElement.classList.remove("has-results");
        reserveScrollOffsetForStickyBox();
      });
    }

    reserveScrollOffsetForStickyBox();
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

  function performSearch() {
    const input = document.getElementById("inPageSearchInput");
    const query = input.value.trim();

    removeHighlights();

    if (!query) {
      updateButtons();
      updateStatus();
      renderResultsPanel();
      return;
    }

    matches = highlightMatches(query);
    renderResultsPanel();

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
    removeHighlights();
    updateButtons();
    updateStatus();
    renderResultsPanel();
  }

  function initialize() {
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

    const rootToggle = document.getElementById("inPageSearchRoot");

    rootToggle.addEventListener("change", () => {
      if (input.value.trim()) {
        performSearch();
      }
    });

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
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
  } else {
    initialize();
  }
})();
