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

  function buildQueryPattern(query) {
    const collapsed = query.trim().replace(/\s+/g, " ");

    if (!collapsed) {
      return "";
    }

    return escapeRegExp(collapsed).replace(/ /g, "\\s+");
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
          placeholder="عبارت مورد نظر را بنویسید…"
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
      </div>

      <p id="inPageSearchStatus" aria-live="polite"></p>
    `;

    document.body.insertBefore(box, document.body.firstChild);

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
    `;

    document.head.appendChild(style);

    function reserveScrollOffsetForStickyBox() {
      const boxHeight = box.offsetHeight;

      document.documentElement.style.setProperty(
        "scroll-padding-top",
        boxHeight + "px"
      );
    }

    reserveScrollOffsetForStickyBox();
    window.addEventListener("resize", reserveScrollOffsetForStickyBox);
  }

  function isSearchInterface(node) {
    return node.parentElement &&
      node.parentElement.closest("#inPageSearchBox");
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

  function highlightMatches(query) {
    const normalizedQuery = normalize(query);

    if (!normalizedQuery) {
      return [];
    }

    const patternSource = buildQueryPattern(query);

    if (!patternSource) {
      return [];
    }

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

    const createdMatches = [];

    nodes.forEach(node => {
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

      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let match;

      while ((match = pattern.exec(originalText)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendChild(
            document.createTextNode(
              originalText.slice(lastIndex, match.index)
            )
          );
        }

        const mark = document.createElement("mark");
        mark.className = "in-page-search-match";
        mark.textContent = match[0];

        fragment.appendChild(mark);
        createdMatches.push(mark);

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < originalText.length) {
        fragment.appendChild(
          document.createTextNode(
            originalText.slice(lastIndex)
          )
        );
      }

      node.parentNode.replaceChild(fragment, node);
    });

    return createdMatches;
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

    updateStatus();
  }

  function performSearch() {
    const input = document.getElementById("inPageSearchInput");
    const query = input.value.trim();

    removeHighlights();

    if (!query) {
      updateButtons();
      updateStatus();
      return;
    }

    matches = highlightMatches(query);

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
