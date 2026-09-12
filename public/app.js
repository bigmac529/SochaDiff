"use strict";

const form = document.getElementById("compare-form");
const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");
const compareBtn = document.getElementById("compare-btn");
const comparePendingIndicator = document.getElementById("compare-pending-indicator");
const whitespaceEye = document.getElementById("whitespace-eye");
const syncActions = document.getElementById("sync-actions");
const whitespaceBtn = document.getElementById("whitespace-btn");
const wsIndicator = document.getElementById("ws-indicator");
const toggleButtons = Array.from(document.querySelectorAll(".toggle-btn"));

let lastResult = null;
let viewMode = "side-by-side"; // or "unified"
let activeCategory = null;
let showWhitespace = false;
let resizeHandlers = [];

// Detach window resize listeners created for previously rendered diffs.
function clearResizeHandlers() {
  for (const handler of resizeHandlers) window.removeEventListener("resize", handler);
  resizeHandlers = [];
}

// ---------- small DOM helpers ----------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function td(className, text) {
  const cell = document.createElement("td");
  if (className) cell.className = className;
  // textContent keeps file contents inert (no HTML injection).
  cell.textContent = text === null || text === undefined ? "" : text;
  return cell;
}

// Map a control character to its Unicode "control picture" glyph.
function controlGlyph(code) {
  if (code === 0x7f) return "\u2421";
  if (code <= 0x1f) return String.fromCharCode(0x2400 + code);
  return "\u00B7";
}

// Render each whitespace/control character as a visible mark while keeping the
// real character in the DOM so copies stay verbatim.
function appendDecorated(container, text, ending) {
  let buffer = "";
  const flush = () => {
    if (buffer) {
      container.appendChild(document.createTextNode(buffer));
      buffer = "";
    }
  };
  for (const ch of text) {
    const code = ch.codePointAt(0);
    const isSpace = ch === " ";
    const isTab = ch === "\t";
    const isOtherWhitespace = !isSpace && !isTab && /\s/.test(ch);
    const isControl = code <= 0x1f || code === 0x7f;
    if (!isSpace && !isTab && !isOtherWhitespace && !isControl) {
      buffer += ch;
      continue;
    }
    flush();
    const span = el("span", "ws-mark");
    span.textContent = ch;
    if (isSpace || (isOtherWhitespace && !isControl)) {
      span.classList.add("ws-space");
    } else if (isTab) {
      span.classList.add("ws-tab");
    } else {
      span.classList.add("ws-ctrl");
      span.dataset.glyph = controlGlyph(code);
    }
    container.appendChild(span);
  }
  flush();
  if (ending === "crlf" || ending === "lf") {
    const eol = el("span", "ws-eol");
    eol.dataset.eol = ending === "crlf" ? "\u21B5" : "\u2193";
    container.appendChild(eol);
  }
}

function characterSegments(left, right) {
  const maxCells = 1000000;
  if (left.length * right.length > maxCells) {
    let prefix = 0;
    while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix++;
    let suffix = 0;
    while (
      suffix < left.length - prefix &&
      suffix < right.length - prefix &&
      left[left.length - suffix - 1] === right[right.length - suffix - 1]
    ) suffix++;
    return {
      left: [{ text: left.slice(0, prefix), common: true }, { text: left.slice(prefix, left.length - suffix), common: false }, { text: left.slice(left.length - suffix), common: true }].filter((part) => part.text),
      right: [{ text: right.slice(0, prefix), common: true }, { text: right.slice(prefix, right.length - suffix), common: false }, { text: right.slice(right.length - suffix), common: true }].filter((part) => part.text),
    };
  }

  const rows = left.length + 1;
  const cols = right.length + 1;
  const table = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i][j] = left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const leftCommon = new Array(left.length).fill(false);
  const rightCommon = new Array(right.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      leftCommon[i++] = true;
      rightCommon[j++] = true;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }

  if (currentIgnoreWhitespace) {
    for (let index = 0; index < left.length; index++) {
      if (/\s/.test(left[index])) leftCommon[index] = true;
    }
    for (let index = 0; index < right.length; index++) {
      if (/\s/.test(right[index])) rightCommon[index] = true;
    }
  }

  function toSegments(text, common) {
    const segments = [];
    for (let index = 0; index < text.length; index++) {
      const isCommon = common[index];
      if (segments.length && segments[segments.length - 1].common === isCommon) segments[segments.length - 1].text += text[index];
      else segments.push({ text: text[index], common: isCommon });
    }
    return segments;
  }
  return { left: toSegments(left, leftCommon), right: toSegments(right, rightCommon) };
}

function textTd(className, text, ending, segments) {
  const cell = td(className);
  const content = el("div", "text-content");
  const raw = text === null || text === undefined ? "" : text;
  if (segments) {
    for (const segment of segments) {
      const span = el("span", segment.common ? "diff-common" : "diff-changed");
      if (showWhitespace) appendDecorated(span, segment.text, "");
      else span.textContent = segment.text;
      content.appendChild(span);
    }
    if (showWhitespace && (ending === "crlf" || ending === "lf")) {
      const eol = el("span", "ws-eol");
      eol.dataset.eol = ending === "crlf" ? "\u21B5" : "\u2193";
      content.appendChild(eol);
    }
  } else if (showWhitespace) {
    appendDecorated(content, raw, /\bempty\b/.test(className || "") ? "" : ending || "");
  } else {
    content.textContent = raw;
  }
  cell.appendChild(content);
  return cell;
}

let selectionScope = null;
let constrainingSelection = false;
let dragSelecting = false;
let dragPanScroll = null;
let dragRaf = 0;
const dragPointer = { x: 0, y: 0 };

function scopeOf(node) {
  const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  return element ? element.closest(".select-scope") : null;
}

function selectAllInScope(scope) {
  if (!scope) return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(scope);
  constrainingSelection = true;
  selection.removeAllRanges();
  selection.addRange(range);
  constrainingSelection = false;
  selectionScope = scope;
}

document.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.key.toLowerCase() !== "a") return;
  const focusedScope = scopeOf(document.activeElement);
  const scope = focusedScope || (document.activeElement === document.body ? selectionScope : null);
  if (!scope) return;
  event.preventDefault();
  selectAllInScope(scope);
});

// Find the horizontal pan scrollbar belonging to a pane scope.
function panScrollForScope(scope) {
  const fileDiff = scope && scope.closest(".file-diff");
  if (!fileDiff) return null;
  const bars = fileDiff.querySelectorAll(".diff-pan-scroll");
  return scope.classList.contains("right-pane") ? bars[1] || null : bars[0] || null;
}

function extendSelectionToPoint(x, y) {
  let node = null;
  let offset = 0;
  if (document.caretRangeFromPoint) {
    const range = document.caretRangeFromPoint(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  } else if (document.caretPositionFromPoint) {
    const pos = document.caretPositionFromPoint(x, y);
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  }
  if (!node || scopeOf(node) !== selectionScope) return;
  const selection = window.getSelection();
  if (!selection.rangeCount) return;
  constrainingSelection = true;
  try {
    selection.extend(node, offset);
  } catch {
    /* selection.extend can throw on detached nodes; ignore */
  }
  constrainingSelection = false;
}

// While dragging near a pane edge, advance that pane's scrollbar and pull the
// selection to the character now under the cursor.
function autoScrollStep() {
  if (!dragSelecting || !dragPanScroll || !selectionScope) {
    dragRaf = 0;
    return;
  }
  const rect = selectionScope.getBoundingClientRect();
  const EDGE = 24;
  const MAX_STEP = 6;
  const SPEED = 0.15;
  let delta = 0;
  if (dragPointer.x > rect.right - EDGE) {
    delta = Math.min(MAX_STEP, (dragPointer.x - (rect.right - EDGE)) * SPEED);
  } else if (dragPointer.x < rect.left + EDGE) {
    delta = -Math.min(MAX_STEP, (rect.left + EDGE - dragPointer.x) * SPEED);
  }
  if (delta !== 0) {
    const before = dragPanScroll.scrollLeft;
    dragPanScroll.scrollLeft = before + delta;
    if (dragPanScroll.scrollLeft !== before) {
      const caretX = Math.min(Math.max(dragPointer.x, rect.left + 1), rect.right - 1);
      const caretY = Math.min(Math.max(dragPointer.y, rect.top + 1), rect.bottom - 1);
      extendSelectionToPoint(caretX, caretY);
    }
  }
  dragRaf = requestAnimationFrame(autoScrollStep);
}

document.addEventListener("mousedown", (event) => {
  selectionScope = event.target instanceof Element ? event.target.closest(".select-scope") : null;
  if (selectionScope && event.button === 0) {
    dragPanScroll = panScrollForScope(selectionScope);
    if (dragPanScroll) {
      dragSelecting = true;
      dragPointer.x = event.clientX;
      dragPointer.y = event.clientY;
      if (!dragRaf) dragRaf = requestAnimationFrame(autoScrollStep);
    }
  }
});

document.addEventListener("mousemove", (event) => {
  if (!dragSelecting) return;
  dragPointer.x = event.clientX;
  dragPointer.y = event.clientY;
});

document.addEventListener("mouseup", () => {
  dragSelecting = false;
  dragPanScroll = null;
  if (dragRaf) {
    cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }
});

// Keep any mouse-driven selection inside the A or B region where it began.
document.addEventListener("selectionchange", () => {
  if (constrainingSelection || !selectionScope) return;
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) return;
  if (scopeOf(selection.anchorNode) !== selectionScope) return;
  if (scopeOf(selection.focusNode) === selectionScope) return;

  const scopeRange = document.createRange();
  scopeRange.selectNodeContents(selectionScope);
  const focusFollowsAnchor =
    selection.anchorNode.compareDocumentPosition(selection.focusNode) & Node.DOCUMENT_POSITION_FOLLOWING;

  const range = document.createRange();
  if (focusFollowsAnchor) {
    range.setStart(selection.anchorNode, selection.anchorOffset);
    range.setEnd(scopeRange.endContainer, scopeRange.endOffset);
  } else {
    range.setStart(scopeRange.startContainer, scopeRange.startOffset);
    range.setEnd(selection.anchorNode, selection.anchorOffset);
  }

  constrainingSelection = true;
  selection.removeAllRanges();
  selection.addRange(range);
  constrainingSelection = false;
});

function copyDiffSelection(event, scroll) {
  const selection = window.getSelection();
  const anchor = selection && selection.anchorNode;
  const anchorElement = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement);
  if (!selection || !anchorElement || !anchorElement.closest(".text-content")) return;

  const selectedRows = Array.from(scroll.querySelectorAll(".text-content"))
    .filter((textContent) => selection.containsNode(textContent, true));
  const copiedText = selectedRows.length > 1
    ? selectedRows.map((textContent) => textContent.textContent).join("\n")
    : selection.toString();
  event.clipboardData.setData("text/plain", copiedText);
  event.preventDefault();
}

function setStatus(message, isError) {
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    statusEl.classList.remove("error");
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
  statusEl.classList.toggle("error", !!isError);
}

function updateWhitespaceButton() {
  whitespaceBtn.classList.toggle("active", showWhitespace);
  whitespaceBtn.setAttribute("aria-pressed", String(showWhitespace));
  if (whitespaceEye) whitespaceEye.classList.toggle("closed", !showWhitespace);
}

function enableWhitespaceEyeAnimation() {
  if (whitespaceEye) requestAnimationFrame(() => whitespaceEye.classList.remove("no-transition"));
}

function setSyncActions() {
  syncActions.innerHTML = "";
  syncActions.hidden = !lastResult;
  if (!lastResult) return;

  const makeBMatchA = el("button", "sync-btn", "Make B match A");
  makeBMatchA.type = "button";
  makeBMatchA.addEventListener("click", () => syncFolders("A"));
  const makeAMatchB = el("button", "sync-btn", "Make A match B");
  makeAMatchB.type = "button";
  makeAMatchB.addEventListener("click", () => syncFolders("B"));
  syncActions.append(makeBMatchA, makeAMatchB);
}

function confirmChangedFolders() {
  const dialog = document.getElementById("content-changed-dialog");
  const okButton = document.getElementById("content-changed-ok-btn");
  if (!dialog || !okButton) return Promise.resolve(false);

  return new Promise((resolve) => {
    const dismiss = () => {
      dialog.close();
      okButton.removeEventListener("click", dismiss);
      resolve(false);
    };
    okButton.addEventListener("click", dismiss);
    dialog.showModal();
  });
}

function confirmSyncFolders(sourceLabel, targetLabel) {
  const dialog = document.getElementById("sync-confirm-dialog");
  const message = document.getElementById("sync-confirm-message");
  const okButton = document.getElementById("sync-confirm-ok-btn");
  const cancelButton = document.getElementById("sync-confirm-cancel-btn");
  if (!dialog || !message || !okButton || !cancelButton) return Promise.resolve(false);
  message.textContent = `This will create, update, and delete files in ${targetLabel} to match ${sourceLabel}. Continue?`;

  return new Promise((resolve) => {
    const finish = (confirmed) => {
      dialog.close();
      okButton.removeEventListener("click", confirm);
      cancelButton.removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", cancel);
      resolve(confirmed);
    };
    const confirm = () => finish(true);
    const cancel = () => finish(false);
    okButton.addEventListener("click", confirm);
    cancelButton.addEventListener("click", cancel);
    dialog.addEventListener("cancel", cancel);
    dialog.showModal();
  });
}

async function syncFolders(direction) {
  const targetLabel = direction === "A" ? "Folder B" : "Folder A";

  const folderA = document.getElementById("folderA").value.trim();
  const folderB = document.getElementById("folderB").value.trim();
  compareBtn.disabled = true;
  syncActions.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  try {
    const checkRes = await fetch("/api/sync/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderA, folderB, contentHashes: lastResult.contentHashes }),
    });
    const checkData = await checkRes.json();
    if (checkRes.status === 409) {
      await confirmChangedFolders();
      setStatus("");
      return;
    }
    if (!checkRes.ok) throw new Error(checkData.error || `Request failed (${checkRes.status})`);
    if (!await confirmSyncFolders(direction === "A" ? "Folder A" : "Folder B", targetLabel)) {
      setStatus("");
      return;
    }

    setStatus(`Updating ${targetLabel}\u2026`);
    const res = await fetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        folderA,
        folderB,
        direction,
        contentHashes: lastResult.contentHashes,
      }),
    });
    const data = await res.json();
    if (res.status === 409) {
      await confirmChangedFolders();
      return;
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    lastResult = data.result;
    activeCategory = null;
    renderResults();
    const { created, updated, deleted, errors } = data.changes;
    setStatus(`Updated ${targetLabel}: ${created.length} created, ${updated.length} updated, ${deleted.length} deleted${errors.length ? `, ${errors.length} error(s)` : ""}.`, errors.length > 0);
  } catch (err) {
    setStatus(err.message || "Could not update the folder.", true);
  } finally {
    compareBtn.disabled = false;
    syncActions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

// ---------- diff rendering ----------
function renderSideBySide(rows) {
  function paneTable(side) {
    const table = el("table", `diff-table side-by-side pane-table ${side}-pane`);
    const columns = document.createElement("colgroup");
    columns.appendChild(el("col", `line-number ${side}`));
    columns.appendChild(el("col", `line-sign ${side}`));
    columns.appendChild(el("col", `text-column ${side}`));
    table.appendChild(columns);
    const body = el("tbody");

    for (const row of rows) {
      const tr = el("tr", row.type);
      if (row.type === "gap") {
        const cell = td(
          "",
          row.expanded
            ? `\u22EF ${row.count} unchanged line${row.count === 1 ? "" : "s"} (click to hide) \u22EF`
            : `\u22EF ${row.count} unchanged line${row.count === 1 ? "" : "s"} \u22EF`
        );
        cell.colSpan = 3;
        if (row.gapIndex != null) {
          tr.dataset.gapIndex = row.gapIndex;
          tr.classList.add("gap-toggle");
        }
        tr.appendChild(cell);
      } else if (side === "left") {
        const hasText = row.leftNum !== null;
        const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).left : null;
        tr.appendChild(td("num", hasText ? row.leftNum : ""));
        tr.appendChild(td(hasText ? "sign left" : "sign", hasText && (row.type === "delete" || row.type === "replace") ? "-" : ""));
        tr.appendChild(textTd(hasText ? "text left" : "text empty left", hasText ? row.leftText : "", hasText ? row.leftEnding : "", segments));
      } else {
        const hasText = row.rightNum !== null;
        const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).right : null;
        tr.appendChild(td("num", hasText ? row.rightNum : ""));
        tr.appendChild(td(hasText ? "sign right" : "sign", hasText && (row.type === "insert" || row.type === "replace") ? "+" : ""));
        tr.appendChild(textTd(hasText ? "text right" : "text empty right", hasText ? row.rightText : "", hasText ? row.rightEnding : "", segments));
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    return table;
  }

  const view = el("div", "side-by-side-view");
  const leftPane = el("div", "diff-pane left-pane select-scope");
  const rightPane = el("div", "diff-pane right-pane select-scope");
  leftPane.tabIndex = 0;
  rightPane.tabIndex = 0;
  leftPane.appendChild(paneTable("left"));
  rightPane.appendChild(paneTable("right"));
  view.append(leftPane, rightPane);
  const scroll = el("div", "diff-scroll");
  scroll.appendChild(view);
  scroll.addEventListener("copy", (event) => copyDiffSelection(event, scroll));
  return scroll;
}

function unifiedRow(type, leftNum, rightNum, sign, text, ending, segments) {
  const tr = el("tr", type);
  tr.appendChild(td("num", leftNum === null ? "" : leftNum));
  tr.appendChild(td("num", rightNum === null ? "" : rightNum));
  tr.appendChild(td("sign", sign));
  tr.appendChild(textTd("text", text, ending, segments));
  return tr;
}

function renderUnified(rows) {
  const table = el("table", "diff-table unified-diff");
  const body = el("tbody");
  for (const row of rows) {
    if (row.type === "gap") {
      const tr = el("tr", "gap");
      const cell = td(
        "",
        row.expanded
          ? `\u22EF ${row.count} unchanged line${row.count === 1 ? "" : "s"} (click to hide) \u22EF`
          : `\u22EF ${row.count} unchanged line${row.count === 1 ? "" : "s"} \u22EF`
      );
      cell.colSpan = 4;
      if (row.gapIndex != null) {
        tr.dataset.gapIndex = row.gapIndex;
        tr.classList.add("gap-toggle");
      }
      tr.appendChild(cell);
      body.appendChild(tr);
    } else if (row.type === "equal") {
      body.appendChild(unifiedRow("equal", row.leftNum, row.rightNum, "", row.leftText, row.leftEnding));
    } else if (row.type === "delete") {
      body.appendChild(unifiedRow("delete", row.leftNum, null, "-", row.leftText, row.leftEnding));
    } else if (row.type === "insert") {
      body.appendChild(unifiedRow("insert", null, row.rightNum, "+", row.rightText, row.rightEnding));
    } else if (row.type === "replace") {
      const segments = characterSegments(row.leftText, row.rightText);
      body.appendChild(unifiedRow("delete", row.leftNum, null, "-", row.leftText, row.leftEnding, segments.left));
      body.appendChild(unifiedRow("insert", null, row.rightNum, "+", row.rightText, row.rightEnding, segments.right));
    }
  }
  table.appendChild(body);
  const scroll = el("div", "diff-scroll");
  scroll.appendChild(table);
  scroll.addEventListener("copy", (event) => copyDiffSelection(event, scroll));
  return scroll;
}

function renderFileDiff(file, autoOpen) {
  const details = el("details", "file-diff");
  const summary = el("summary");
  summary.appendChild(el("span", "name", file.path));
  if (file.stats) {
    if (file.stats.added) summary.appendChild(el("span", "stat add", `+${file.stats.added}`));
    if (file.stats.removed) summary.appendChild(el("span", "stat del", `-${file.stats.removed}`));
    if (file.stats.changed) summary.appendChild(el("span", "stat rep", `~${file.stats.changed}`));
  }
  details.appendChild(summary);
  // Build the (potentially large) diff body only when the file is expanded.
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    buildFileDiffBody(details, file);
  };
  details.addEventListener("toggle", () => {
    if (details.open) build();
  });
  if (autoOpen) {
    details.open = true;
    build();
  }
  return details;
}

function buildFileDiffBody(details, file) {
  const expanded = new Set();
  let currentResize = null;

  // Expand any clicked gaps by splicing their omitted rows back in.
  function effectiveRows() {
    const out = [];
    file.rows.forEach((row, index) => {
      if (row.type === "gap" && expanded.has(index) && Array.isArray(row.rows)) {
        out.push({ ...row, expanded: true, gapIndex: index });
        out.push(...row.rows);
      } else if (row.type === "gap") {
        out.push({ ...row, expanded: false, gapIndex: Array.isArray(row.rows) ? index : undefined });
      } else {
        out.push(row);
      }
    });
    return out;
  }

  function render() {
    if (currentResize) {
      window.removeEventListener("resize", currentResize);
      resizeHandlers = resizeHandlers.filter((handler) => handler !== currentResize);
      currentResize = null;
    }
    details.querySelectorAll(".diff-scroll, .diff-pan-scrolls").forEach((node) => node.remove());

    const rows = effectiveRows();
    const scroll = viewMode === "unified" ? renderUnified(rows) : renderSideBySide(rows);
    details.appendChild(scroll);
    const diffTable = scroll.querySelector(".diff-table");
    const isSideBySide = diffTable.classList.contains("side-by-side");
    const panScrolls = el(
      "div",
      isSideBySide ? "diff-pan-scrolls side-by-side" : "diff-pan-scrolls unified"
    );
    const scrollGroups = isSideBySide
      ? [
          Array.from(details.querySelectorAll(".text.left > .text-content")),
          Array.from(details.querySelectorAll(".text.right > .text-content")),
        ]
      : [Array.from(details.querySelectorAll(".text-content"))];
    const panBars = [];

    scrollGroups.forEach((textContents) => {
      const panScroll = el("div", "diff-pan-scroll");
      const panContent = el("div", "diff-pan-content");
      panScroll.appendChild(panContent);
      panScrolls.appendChild(panScroll);
      panBars.push(panScroll);

      panScroll.addEventListener("scroll", () => {
        const offset = panScroll.scrollLeft;
        for (const textContent of textContents) {
          textContent.style.transform = `translateX(-${offset}px)`;
        }
      });
    });

    details.appendChild(panScrolls);

    function sizePanScrolls() {
      panBars.forEach((panScroll, index) => {
        const textContents = scrollGroups[index];
        const maxScroll = textContents.reduce(
          (maximum, textContent) => Math.max(maximum, textContent.scrollWidth - textContent.clientWidth),
          0
        );
        if (isSideBySide) panScroll.hidden = maxScroll <= 0;
        panScroll.firstElementChild.style.width = `${maxScroll + panScroll.clientWidth}px`;
      });
    }

    requestAnimationFrame(sizePanScrolls);
    currentResize = sizePanScrolls;
    window.addEventListener("resize", sizePanScrolls);
    resizeHandlers.push(sizePanScrolls);

    scroll.addEventListener("click", (event) => {
      const gapRow = event.target.closest("tr.gap-toggle[data-gap-index]");
      if (!gapRow || !scroll.contains(gapRow)) return;
      const gapIndex = Number(gapRow.dataset.gapIndex);
      if (expanded.has(gapIndex)) expanded.delete(gapIndex);
      else expanded.add(gapIndex);
      render();
    });
  }

  render();
}

// ---------- section rendering ----------
function fileListSection(title, items, className, mapFn) {
  const section = el("section", "section");
  section.appendChild(el("h2", null, `${title} (${items.length})`));
  const ul = el("ul", "file-list");
  for (const item of items) {
    const li = el("li");
    li.appendChild(el("span", "path", item.path));
    if (mapFn) {
      const extra = mapFn(item);
      if (extra) li.appendChild(el("span", "badge", extra));
    }
    ul.appendChild(li);
  }
  section.appendChild(ul);
  return section;
}

function chip(className, category, n, label) {
  const c = el("button", `chip ${className}`);
  c.type = "button";
  c.dataset.category = category;
  c.disabled = n === 0;
  c.setAttribute("aria-pressed", activeCategory === category ? "true" : "false");
  if (activeCategory === category) c.classList.add("active");
  c.addEventListener("click", () => {
    activeCategory = activeCategory === category ? null : category;
    renderResults();
  });
  c.appendChild(el("span", "n", String(n)));
  c.appendChild(document.createTextNode(" " + label));
  return c;
}

function renderResults() {
  clearResizeHandlers();
  resultsEl.innerHTML = "";
  if (!lastResult) return;
  const r = {
    ...lastResult,
    differing: Array.isArray(lastResult.differing) ? lastResult.differing : [],
    onlyInA: Array.isArray(lastResult.onlyInA) ? lastResult.onlyInA : [],
    onlyInB: Array.isArray(lastResult.onlyInB) ? lastResult.onlyInB : [],
    binaryDiffering: Array.isArray(lastResult.binaryDiffering) ? lastResult.binaryDiffering : [],
    whitespaceOnly: Array.isArray(lastResult.whitespaceOnly) ? lastResult.whitespaceOnly : [],
    errors: Array.isArray(lastResult.errors) ? lastResult.errors : [],
    identical: Array.isArray(lastResult.identical) ? lastResult.identical : [],
  };
  const s = r.summary;

  // Summary chips
  const summary = el("div", "summary");
  summary.appendChild(chip("diff", "differing", s.differing, "differing"));
  summary.appendChild(chip("a", "onlyInA", s.onlyInA, "only in A"));
  summary.appendChild(chip("b", "onlyInB", s.onlyInB, "only in B"));
  summary.appendChild(chip("", "whitespaceOnly", s.whitespaceOnly, "whitespace-only (ignored)"));
  summary.appendChild(chip("", "binaryDiffering", s.binaryDiffering, "binary diff"));
  summary.appendChild(chip("", "identical", s.identical, "identical"));
  summary.appendChild(chip("", "errors", s.errors, "errors"));
  resultsEl.appendChild(summary);
  setSyncActions();

  const paths = el("div", "paths");
  const pathColA = el("div", "path-col path-col-a");
  pathColA.appendChild(el("span", "path-label a-label", "A:"));
  pathColA.appendChild(el("span", "path-value", r.folderA));
  const pathColB = el("div", "path-col path-col-b");
  pathColB.appendChild(el("span", "path-label b-label", "B:"));
  pathColB.appendChild(el("span", "path-value", r.folderB));
  paths.append(pathColA, pathColB);
  resultsEl.appendChild(paths);

  const nothing =
    s.differing === 0 && s.onlyInA === 0 && s.onlyInB === 0 && s.binaryDiffering === 0;
  if (nothing) {
    const msg = el("p", "hint");
    msg.textContent =
      s.whitespaceOnly > 0
        ? `No non-whitespace differences. ${s.whitespaceOnly} file(s) differ only in whitespace and were ignored.`
        : "No non-whitespace differences found. The folders match.";
    resultsEl.appendChild(msg);
  }

  // Differing files (the main event)
  if ((!activeCategory || activeCategory === "differing") && r.differing.length) {
    const section = el("section", "section");
    section.appendChild(el("h2", null, `Differing files (${r.differing.length})`));
    // Auto-expand only for small comparisons; large ones stay collapsed to save memory.
    const autoOpen = r.differing.length <= 25;
    for (const file of r.differing) {
      section.appendChild(renderFileDiff(file, autoOpen));
    }
    resultsEl.appendChild(section);
  }

  if ((!activeCategory || activeCategory === "onlyInA") && r.onlyInA.length) {
    resultsEl.appendChild(fileListSection("Only in A", r.onlyInA, "a"));
  }
  if ((!activeCategory || activeCategory === "onlyInB") && r.onlyInB.length) {
    resultsEl.appendChild(fileListSection("Only in B", r.onlyInB, "b"));
  }
  if ((!activeCategory || activeCategory === "binaryDiffering") && r.binaryDiffering.length) {
    resultsEl.appendChild(
      fileListSection("Binary / non-text files that differ", r.binaryDiffering, "bin", (i) => i.note)
    );
  }
  if ((!activeCategory || activeCategory === "whitespaceOnly") && r.whitespaceOnly.length) {
    resultsEl.appendChild(
      fileListSection("Differ only in whitespace (ignored)", r.whitespaceOnly, "ws")
    );
  }
  if ((!activeCategory || activeCategory === "errors") && r.errors.length) {
    resultsEl.appendChild(fileListSection("Errors", r.errors, "err", (i) => i.message));
  }
  if ((!activeCategory || activeCategory === "identical") && r.identical.length) {
    resultsEl.appendChild(fileListSection("Identical", r.identical, "same"));
  }
  saveSession();
}

const SESSION_KEY = "folderDiffSession";

// Read the settings snapshot saved alongside the last persisted session, if any.
function readPersistedComparedSettingsKey() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return saved && typeof saved.comparedSettingsKey === "string" ? saved.comparedSettingsKey : null;
  } catch {
    return null;
  }
}

// Persist the current results and view state so navigating away and back keeps them.
function saveSession() {
  try {
    if (!lastResult || isResultTooLargeToPersist(lastResult)) return;
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        result: lastResult,
        viewMode,
        activeCategory,
        showWhitespace,
        comparedSettingsKey: lastComparedSettingsKey,
      })
    );
  } catch {
    // Ignore storage quota or serialization errors; results simply won't persist.
  }
}

// Avoid serializing huge comparisons (memory + quota) for cross-page persistence.
function isResultTooLargeToPersist(result) {
  const files = Array.isArray(result.differing) ? result.differing : [];
  if (files.length > 150) return true;
  let rows = 0;
  for (const file of files) {
    rows += file.rows ? file.rows.length : 0;
    if (rows > 20000) return true;
  }
  return false;
}

function restoreSession() {
  let saved = null;
  try {
    saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
  } catch {
    saved = null;
  }
  if (!saved || !saved.result) return false;
  lastResult = saved.result;
  activeCategory = saved.activeCategory || null;
  showWhitespace = !!saved.showWhitespace;
  if (saved.viewMode === "unified" || saved.viewMode === "side-by-side") viewMode = saved.viewMode;
  toggleButtons.forEach((b) => b.classList.toggle("active", b.dataset.view === viewMode));
  updateWhitespaceButton();
  renderResults();
  return true;
}

// ---------- events ----------
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const folderA = document.getElementById("folderA").value.trim();
  const folderB = document.getElementById("folderB").value.trim();
  if (!folderA || !folderB) {
    setStatus("Please enter both folder paths.", true);
    return;
  }

  compareBtn.disabled = true;
  setStatus("Comparing\u2026");
  resultsEl.innerHTML = "";
  try {
    const res = await fetch("/api/compare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folderA, folderB }),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    lastResult = data;
    lastComparedSettingsKey = settingsKey(currentIgnoreWhitespace, currentIgnoredDirectories);
    setComparePending(false);
    setStatus("");
    renderResults();
  } catch (err) {
    lastResult = null;
    setStatus(err.message || "Something went wrong.", true);
  } finally {
    compareBtn.disabled = false;
  }
});

toggleButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view === viewMode) return;
    viewMode = view;
    toggleButtons.forEach((b) => b.classList.toggle("active", b === btn));
    renderResults();
  });
});

whitespaceBtn.addEventListener("click", () => {
  showWhitespace = !showWhitespace;
  updateWhitespaceButton();
  if (lastResult) renderResults();
});

// Reflect the persisted ignore-whitespace setting in the header indicator.
let currentIgnoredDirectories = [];
let currentIgnoreWhitespace = true;
// Settings snapshot captured at the last successful comparison; restored across reloads.
let lastComparedSettingsKey = readPersistedComparedSettingsKey();

function settingsKey(ignoreWhitespace, ignoredDirectories) {
  const dirs = (Array.isArray(ignoredDirectories) ? ignoredDirectories : [])
    .map((name) => String(name).trim().toLowerCase())
    .filter(Boolean)
    .sort();
  return JSON.stringify({ ignoreWhitespace: ignoreWhitespace !== false, dirs });
}

// Only flag settings as pending if they now differ from the last comparison.
// Returns whether the current settings still need a Compare re-run to apply.
function markSettingsChanged() {
  const pending = settingsKey(currentIgnoreWhitespace, currentIgnoredDirectories) !== lastComparedSettingsKey;
  setComparePending(pending);
  return pending;
}

function applyWhitespaceIndicator(ignore) {
  if (!wsIndicator) return;
  currentIgnoreWhitespace = ignore !== false;
  const label = wsIndicator.querySelector(".ws-indicator-label");
  const tooltip = wsIndicator.querySelector(".header-tooltip-text");
  wsIndicator.classList.toggle("ws-on", ignore);
  wsIndicator.classList.toggle("ws-off", !ignore);
  if (label) label.textContent = ignore ? "Whitespace ignored" : "Whitespace aware";
  if (tooltip) {
    tooltip.textContent = ignore
      ? "Whitespace differences are ignored by the file comparer. Click to change to whitespace ware."
      : "The file comparer is whitespace aware. Click to change to whitespace ignored.";
  }
  // Single source of truth: keep the Settings checkbox in lockstep with the header indicator.
  if (ignoreWhitespaceInput) ignoreWhitespaceInput.checked = currentIgnoreWhitespace;
}

async function refreshWhitespaceIndicator() {
  if (!wsIndicator) return;
  let ignore = true;
  try {
    const res = await fetch("/api/settings");
    if (res.ok) {
      const settings = await res.json();
      ignore = settings.ignoreWhitespace !== false;
      currentIgnoredDirectories = Array.isArray(settings.ignoredDirectories) ? settings.ignoredDirectories : [];
    }
  } catch {
    // Fall back to the default (ignored) if settings cannot be loaded.
  }
  applyWhitespaceIndicator(ignore);
  // Re-check pending state now that real settings are known, if a prior comparison was restored.
  if (lastComparedSettingsKey !== null) markSettingsChanged();
}

async function toggleWhitespaceSetting() {
  if (!wsIndicator || wsIndicator.dataset.busy) return;
  const next = !wsIndicator.classList.contains("ws-on");
  wsIndicator.dataset.busy = "1";
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignoredDirectories: currentIgnoredDirectories, ignoreWhitespace: next }),
    });
    if (res.ok) {
      const settings = await res.json();
      currentIgnoredDirectories = Array.isArray(settings.ignoredDirectories)
        ? settings.ignoredDirectories
        : currentIgnoredDirectories;
      applyWhitespaceIndicator(settings.ignoreWhitespace !== false);
      markSettingsChanged();
    }
  } catch {
    // Leave the indicator unchanged if the update fails.
  } finally {
    delete wsIndicator.dataset.busy;
  }
}

if (wsIndicator) {
  wsIndicator.setAttribute("role", "button");
  wsIndicator.setAttribute("tabindex", "0");
  wsIndicator.addEventListener("click", toggleWhitespaceSetting);
  wsIndicator.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggleWhitespaceSetting();
    }
  });
}

refreshWhitespaceIndicator();

// Keep a cursor-following tooltip's bottom edge pinned 3px above and 20px to the side of the pointer tip.
const CURSOR_TOOLTIP_GAP_Y = 3;
const CURSOR_TOOLTIP_GAP_X = 20;

function trackCursorTooltip(trigger, tooltip, align = "left") {
  if (!trigger || !tooltip) return;
  const offsetX = align === "right" ? CURSOR_TOOLTIP_GAP_X : -CURSOR_TOOLTIP_GAP_X;
  trigger.addEventListener("mousemove", (event) => {
    tooltip.style.left = `${event.clientX + offsetX}px`;
    tooltip.style.top = `${event.clientY - CURSOR_TOOLTIP_GAP_Y}px`;
  });
  trigger.addEventListener("focus", () => {
    const rect = trigger.getBoundingClientRect();
    const anchorX = align === "right" ? rect.left : rect.right;
    tooltip.style.left = `${anchorX + offsetX}px`;
    tooltip.style.top = `${rect.top - CURSOR_TOOLTIP_GAP_Y}px`;
  });
}

trackCursorTooltip(wsIndicator, document.getElementById("ws-tooltip"));

// ---------- settings modal ----------
const settingsDialog = document.getElementById("settings-dialog");
const settingsOpenBtn = document.getElementById("settings-open-btn");
const settingsCloseBtn = document.getElementById("settings-close-btn");
const ignoredDirectoriesInput = document.getElementById("ignored-directories");
const ignoreWhitespaceInput = document.getElementById("ignore-whitespace");
const resetSettingsBtn = document.getElementById("reset-settings-btn");
const settingsStatus = document.getElementById("settings-status");
let settingsSaveTimer = 0;
let settingsStatusFadeTimer = 0;

trackCursorTooltip(settingsOpenBtn, document.getElementById("settings-shortcut-tooltip"));
trackCursorTooltip(comparePendingIndicator, document.getElementById("compare-pending-tooltip"), "right");

function setSettingsStatus(message, isError) {
  if (!settingsStatus) return;
  clearTimeout(settingsStatusFadeTimer);
  settingsStatus.textContent = message || "";
  settingsStatus.classList.toggle("error", !!isError);
  settingsStatus.classList.remove("fade-out");
  if (message) {
    settingsStatusFadeTimer = setTimeout(() => {
      settingsStatus.classList.add("fade-out");
    }, 5000);
  }
}

function setComparePending(pending) {
  if (comparePendingIndicator) comparePendingIndicator.hidden = !pending;
}

function populateSettings(settings) {
  const dirs = Array.isArray(settings.ignoredDirectories) ? settings.ignoredDirectories : [];
  currentIgnoredDirectories = dirs;
  if (ignoredDirectoriesInput) ignoredDirectoriesInput.value = dirs.join("\n");
  applyWhitespaceIndicator(settings.ignoreWhitespace !== false);
}

async function openSettings() {
  setSettingsStatus("");
  try {
    const res = await fetch("/api/settings");
    if (res.ok) populateSettings(await res.json());
  } catch {
    setSettingsStatus("Could not load settings.", true);
  }
  if (settingsDialog && typeof settingsDialog.showModal === "function") settingsDialog.showModal();
}

if (settingsOpenBtn) settingsOpenBtn.addEventListener("click", openSettings);
if (settingsCloseBtn) settingsCloseBtn.addEventListener("click", () => settingsDialog.close());
document.addEventListener("keydown", (event) => {
  if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (settingsDialog && !settingsDialog.open) openSettings();
  }
});
if (settingsDialog) {
  // Close when clicking the backdrop area outside the dialog content.
  settingsDialog.addEventListener("click", (event) => {
    if (event.target === settingsDialog) settingsDialog.close();
  });
}

// Persist settings immediately whenever they change (no explicit save button).
async function autoSaveSettings() {
  const ignoredDirectories = ignoredDirectoriesInput.value
    .split(/\r?\n/)
    .map((name) => name.trim())
    .filter(Boolean);
  setSettingsStatus("Saving\u2026");
  try {
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ignoredDirectories, ignoreWhitespace: ignoreWhitespaceInput.checked }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    // Update state and indicator without rewriting the textarea while editing.
    currentIgnoredDirectories = Array.isArray(data.ignoredDirectories)
      ? data.ignoredDirectories
      : currentIgnoredDirectories;
    applyWhitespaceIndicator(data.ignoreWhitespace !== false);
    const pending = markSettingsChanged();
    setSettingsStatus(pending ? "Saved. Run a new comparison to apply the changes." : "Saved.");
  } catch (err) {
    setSettingsStatus(err.message || "Could not save settings.", true);
  }
}

if (ignoreWhitespaceInput) {
  ignoreWhitespaceInput.addEventListener("change", autoSaveSettings);
}

if (ignoredDirectoriesInput) {
  ignoredDirectoriesInput.addEventListener("input", () => {
    clearTimeout(settingsSaveTimer);
    settingsSaveTimer = setTimeout(autoSaveSettings, 600);
  });
  ignoredDirectoriesInput.addEventListener("change", () => {
    clearTimeout(settingsSaveTimer);
    autoSaveSettings();
  });
}

if (resetSettingsBtn) {
  resetSettingsBtn.addEventListener("click", async () => {
    resetSettingsBtn.disabled = true;
    setSettingsStatus("Resetting\u2026");
    try {
      const res = await fetch("/api/settings/reset", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      populateSettings(data);
      const pending = markSettingsChanged();
      setSettingsStatus(pending ? "Reset to default. Run a new comparison to apply the changes." : "Reset to default.");
    } catch (err) {
      setSettingsStatus(err.message || "Could not reset settings.", true);
    } finally {
      resetSettingsBtn.disabled = false;
    }
  });
}

// Load the last saved paths first, then let deep-link query parameters override
// them so bookmarked comparisons continue to take precedence.
(async function initPaths() {
  try {
    const res = await fetch("/api/last-comparison");
    if (res.ok) {
      const saved = await res.json();
      if (saved.folderA) document.getElementById("folderA").value = saved.folderA;
      if (saved.folderB) document.getElementById("folderB").value = saved.folderB;
    }
  } catch {
    // Saved paths are optional; query parameters and manual entry still work.
  }

  const params = new URLSearchParams(window.location.search);
  const a = params.get("a");
  const b = params.get("b");
  const view = params.get("view");
  if (view === "unified") {
    const btn = toggleButtons.find((x) => x.dataset.view === "unified");
    if (btn) btn.click();
  }
  if (a) document.getElementById("folderA").value = a;
  if (b) document.getElementById("folderB").value = b;
  if (a && b && params.get("run")) {
    form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
  } else {
    // No fresh comparison requested; restore any results from the last visit.
    restoreSession();
  }
  enableWhitespaceEyeAnimation();
})();

