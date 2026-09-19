"use strict";

const form = document.getElementById("compare-form");
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

async function fetchAndReportError(href) {
  try {
    const response = await fetch(href);
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || `Request failed (${response.status})`);
    }
  } catch (error) {
    showErrorModal("Could not open the path", error.message);
  }
}

function attachExplorerOpener(link) {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    fetchAndReportError(link.href);
  });
  return link;
}

function folderLink(folderPath) {
  const link = el("a", "path-value", folderPath);
  link.href = `/api/open-folder?path=${encodeURIComponent(folderPath)}`;
  link.title = "Open folder in Windows Explorer";
  return attachExplorerOpener(link);
}

// A single clickable "A" or "B" letter that opens that side's copy of a
// relative file path with its default app; right-click shows the Windows
// "Open With" picker instead.
function fileSideLink(letter, folder, relPath) {
  const link = el("a", `path-side-link ${letter === "A" ? "side-a" : "side-b"}`, letter);
  link.href = `/api/open-file?folder=${encodeURIComponent(folder)}&relPath=${encodeURIComponent(relPath)}`;
  link.title = `Open Folder ${letter}'s copy with its default app (right-click for 'Open with')`;
  attachExplorerOpener(link);
  link.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    fetchAndReportError(`/api/open-file-with?folder=${encodeURIComponent(folder)}&relPath=${encodeURIComponent(relPath)}`);
  });
  return link;
}

// Separator glyph shown between the A/B links, per result category.
const SIDE_ICON_BY_KIND = {
  diff: "\u2260", // ≠ differing
  bin: "\u2260", // ≠ differing (binary)
  ws: "\u2248", // ≈ partial equality — whitespace-only
  same: "=", // = equal — identical
};

// Narrowed space used just inside the "(" and ")" of the sides suffix.
function sidesGap() {
  return el("span", "path-sides-gap", " ");
}

// The "( A ≠ B )" suffix appended after every displayed file path. "a"/"b"
// kinds (only-in-A / only-in-B) show just the existing side, with no separator.
function fileSidesSuffix(relPath, kind) {
  const span = el("span", "path-sides");
  if (kind === "a") {
    span.append(" (", sidesGap(), fileSideLink("A", lastResult.folderA, relPath), sidesGap(), ")");
  } else if (kind === "b") {
    span.append(" (", sidesGap(), fileSideLink("B", lastResult.folderB, relPath), sidesGap(), ")");
  } else {
    const icon = SIDE_ICON_BY_KIND[kind];
    const separator = icon ? el("span", "path-sides-icon", icon) : " - ";
    span.append(
      " (",
      sidesGap(),
      fileSideLink("A", lastResult.folderA, relPath),
      separator,
      fileSideLink("B", lastResult.folderB, relPath),
      sidesGap(),
      ")"
    );
  }
  return span;
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

// Blank / placeholder .text-content has no selectable glyph, so Chromium
// reports no getClientRects (flashing marks) and paints at most a caret-width
// streak. Seed an invisible NBSP pad so drag geometry stays contiguous; copy
// reads lineTextFromContent which strips the pad via dataset.selPad.
function ensureSelectionPad(content) {
  if (content.textContent.length > 0) return;
  const pad = el("span", "sel-pad");
  pad.textContent = "\u00a0";
  content.appendChild(pad);
  content.dataset.selPad = "1";
}

function lineTextFromContent(textContent) {
  if (!textContent) return "";
  if (textContent.dataset.selPad === "1") return "";
  return textContent.textContent;
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
  ensureSelectionPad(content);
  cell.appendChild(content);
  return cell;
}

let selectionScope = null;
let constrainingSelection = false;
let dragSelecting = false;
let dragPanScroll = null;
let dragRaf = 0;
const dragPointer = { x: 0, y: 0 };
// Row index (within the drag's pane) where the current drag started; used to
// clamp visual marking to the actual drag span, so a transient native-selection
// over-extension can't briefly highlight rows the drag never reached.
let dragAnchorRowIndex = -1;
// Set only by selectAllInScope; distinguishes a whole-file selection (which
// may include lines collapsed out of the DOM) from a partial drag selection.
let wholeFileScope = null;
// Gap indices (within the current drag's pane) armed by pointer-over-gap
// proximity (same hit target as click-to-expand / hand cursor), after an
// adjacent visible text row was already selected. Sticky until next mousedown
// so Copy still includes them after mouseup. Hidden lines are spliced into
// the copied text even though they were never rendered/selectable in the DOM.
let proximityGapIndices = new Set();

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
  wholeFileScope = scope;
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

// While drag-selecting in one pane, mark every other .select-scope inert so
// native selection cannot weave into the opposite pane (defense-in-depth with
// the selectionchange clamp below).
function clearSelectInert() {
  document.querySelectorAll(".select-scope.select-inert").forEach((el) => {
    el.classList.remove("select-inert");
  });
}

function setOppositeScopesInert(activeScope) {
  clearSelectInert();
  if (!activeScope) return;
  const root = activeScope.closest(".file-diff") || document;
  root.querySelectorAll(".select-scope").forEach((scope) => {
    if (scope !== activeScope) scope.classList.add("select-inert");
  });
}

function setDragSelecting(on) {
  dragSelecting = !!on;
  document.documentElement.classList.toggle("drag-selecting", dragSelecting);
  document.body.classList.toggle("drag-selecting", dragSelecting);
  if (dragSelecting && selectionScope) {
    setOppositeScopesInert(selectionScope);
  } else {
    clearSelectInert();
  }
}

document.addEventListener("mousedown", (event) => {
  selectionScope = event.target instanceof Element ? event.target.closest(".select-scope") : null;
  wholeFileScope = null;
  proximityGapIndices = new Set();
  dragAnchorRowIndex = -1;
  clearSelectionVisuals();
  setDragSelecting(false);
  if (selectionScope && event.button === 0) {
    const anchorTr = event.target instanceof Element ? event.target.closest("tr") : null;
    dragAnchorRowIndex = anchorTr ? Array.from(selectionScope.querySelectorAll("tbody > tr")).indexOf(anchorTr) : -1;
    dragPanScroll = panScrollForScope(selectionScope);
    // Cursor lock is independent of the pan scrollbar: any primary-button
    // mousedown in a pane is a selection drag and must keep the I-beam over
    // collapsed gaps. Auto-scroll still needs the bar.
    setDragSelecting(true);
    dragPointer.x = event.clientX;
    dragPointer.y = event.clientY;
    if (dragPanScroll && !dragRaf) dragRaf = requestAnimationFrame(autoScrollStep);
  }
}, true);

document.addEventListener("mousemove", (event) => {
  if (!dragSelecting) return;
  dragPointer.x = event.clientX;
  dragPointer.y = event.clientY;
  // Arming happens in updateSelectionVisuals (fires again on the resulting
  // selectionchange with a fresh selection); calling it here too keeps the
  // dragPointer-driven hover check responsive.
  updateSelectionVisuals();
});

// Right-clicking a side-by-side pane selects that whole file (A or B) so the
// browser's native context menu offers Copy for the entire text.
document.addEventListener("contextmenu", (event) => {
  const scope = event.target instanceof Element ? event.target.closest(".select-scope") : null;
  if (scope) selectAllInScope(scope);
});

document.addEventListener("mouseup", () => {
  setDragSelecting(false);
  dragPanScroll = null;
  if (dragRaf) {
    cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }
}, true);

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

// Row index for a selection anchor/focus node within rowEls, or -1.
function rowIndexForNode(node, rowEls) {
  const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  if (!element) return -1;
  const tr = element.closest("tr");
  return tr ? rowEls.indexOf(tr) : -1;
}

// The [firstVisibleRow, lastVisibleRow] the selection spans, derived from its
// rendered rects rather than anchor/focus nodes: when a drag ends inside an
// unselectable gap the focus can land on the pane element itself (not a row),
// which node-based lookup can't resolve. Gap rows have no .text-content and are
// skipped, so the bounds are always visible text rows.
// Empty .text-content can yield zero-width or empty client rects in Chromium;
// accept height-only rects and fall back to anchor/focus rows when needed.
function selectedRowRange(rowEls, selection) {
  if (!selection.rangeCount) return null;
  const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((r) => r.height > 0);
  let first = -1;
  let last = -1;
  if (rects.length) {
    let top = Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      top = Math.min(top, r.top);
      bottom = Math.max(bottom, r.bottom);
    }
    for (let i = 0; i < rowEls.length; i++) {
      if (!rowEls[i].querySelector(".text-content")) continue; // skip gap rows
      const b = rowEls[i].getBoundingClientRect();
      const cy = (b.top + b.bottom) / 2;
      if (cy >= top - 1 && cy <= bottom + 1) {
        if (first === -1) first = i;
        last = i;
      }
    }
  }
  if (first === -1) {
    const anchorIdx = rowIndexForNode(selection.anchorNode, rowEls);
    const focusIdx = rowIndexForNode(selection.focusNode, rowEls);
    if (anchorIdx !== -1 && focusIdx !== -1) {
      first = Math.min(anchorIdx, focusIdx);
      last = Math.max(anchorIdx, focusIdx);
    } else if (anchorIdx !== -1 || focusIdx !== -1) {
      first = last = anchorIdx !== -1 ? anchorIdx : focusIdx;
    }
  }
  return first === -1 ? null : [first, last];
}

// True for a still-collapsed gap row that was proximity-armed (or every gap
// when the whole pane is selected). Edge gaps outside the visible text span
// are only pulled in when this is true; interior gaps use isSpannedGapRow.
function isArmedGapRow(tr, treatAllAsArmed) {
  if (!tr.classList.contains("gap-toggle") || tr.dataset.expanded === "true") return false;
  return treatAllAsArmed || proximityGapIndices.has(Number(tr.dataset.gapIndex));
}

// Collapsed gap strictly between the selected text-row bounds — the selection
// spans it even if the pointer never armed it. Hidden gap.rows must copy.
function isSpannedGapRow(tr, index, firstIdx, lastIdx) {
  if (!tr.classList.contains("gap-toggle") || tr.dataset.expanded === "true") return false;
  return index > firstIdx && index < lastIdx;
}

// Gap contributes hidden lines on copy / gap-armed visuals when whole-pane,
// proximity-armed, or spanned by the current row range.
function isIncludedGapRow(tr, treatAllAsArmed, index, firstIdx, lastIdx) {
  return isArmedGapRow(tr, treatAllAsArmed) || isSpannedGapRow(tr, index, firstIdx, lastIdx);
}

// Gap rows are unselectable (see tr.gap td { user-select: none }), so the
// browser's anchor/focus can never land inside one — a leading or trailing
// armed gap sits just outside [firstIdx, lastIdx] and must be pulled in here.
function extendRangeAcrossArmedGaps(rowEls, firstIdx, lastIdx, treatAllAsArmed) {
  let first = firstIdx;
  let last = lastIdx;
  while (first > 0 && isArmedGapRow(rowEls[first - 1], treatAllAsArmed)) first--;
  while (last < rowEls.length - 1 && isArmedGapRow(rowEls[last + 1], treatAllAsArmed)) last++;
  return [first, last];
}

// Clear the "blank line selected" / "gap will be included" indicators.
function clearSelectionVisuals() {
  document.querySelectorAll(".ws-line-selected").forEach((el) => el.classList.remove("ws-line-selected"));
  document.querySelectorAll(".gap-armed").forEach((el) => el.classList.remove("gap-armed"));
}

// Arm a collapsed gap only when the pointer is directly over it (same hit
// target as click-to-expand / hand cursor) AND an adjacent non-gap row with
// visible text is already in the selected row range. Sticky: once added to
// proximityGapIndices, stays until the next mousedown clears the set.
function maybeArmGapUnderPointer(rowEls, selectedFirst, selectedLast) {
  if (!dragSelecting || !selectionScope) return;
  const el = document.elementFromPoint(dragPointer.x, dragPointer.y);
  if (!(el instanceof Element) || !selectionScope.contains(el)) return;
  const gapTr = el.closest("tr.gap-toggle");
  if (!gapTr || gapTr.dataset.expanded === "true" || !selectionScope.contains(gapTr)) return;

  const gapIdx = rowEls.indexOf(gapTr);
  if (gapIdx === -1) return;

  const adjacentSelectedText = (i) => {
    if (i < selectedFirst || i > selectedLast) return false;
    const tr = rowEls[i];
    return !!(tr && tr.querySelector(".text-content"));
  };
  if (!adjacentSelectedText(gapIdx - 1) && !adjacentSelectedText(gapIdx + 1)) return;

  proximityGapIndices.add(Number(gapTr.dataset.gapIndex));
}

// The row index nearest the live cursor (dragPointer), clamped into range.
// Used to bound the marked span; robust to the cursor being above the first
// row (e.g. over the file-diff summary) or below the last.
function cursorRowFromPointer(rowEls) {
  const y = dragPointer.y;
  for (let i = 0; i < rowEls.length; i++) {
    const b = rowEls[i].getBoundingClientRect();
    if (y >= b.top && y <= b.bottom) return i;
  }
  return y < rowEls[0].getBoundingClientRect().top ? 0 : rowEls.length - 1;
}

// Mark blank/whitespace-only lines (and empty insert/delete placeholders) and
// included gaps (proximity-armed or spanned) within the current selection:
// native selection highlighting is invisible or caret-width on empty content,
// and gives no cue that a collapsed gap will be copied too.
function updateSelectionVisuals() {
  if (!selectionScope) {
    clearSelectionVisuals();
    return;
  }
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || selection.isCollapsed) {
    clearSelectionVisuals();
    return;
  }
  if (scopeOf(selection.anchorNode) !== selectionScope) {
    clearSelectionVisuals();
    return;
  }

  const rowEls = Array.from(selectionScope.querySelectorAll("tbody > tr"));
  const wholeFile = wholeFileScope === selectionScope;
  let firstIdx = 0;
  let lastIdx = rowEls.length - 1;
  if (!wholeFile) {
    let range = selectedRowRange(rowEls, selection);
    // While dragging across blank/empty rows Chromium may briefly report no
    // client rects; keep marks stable via the anchor→cursor span instead of
    // clearing (which flashed the 1px native streak).
    if (!range && dragSelecting && dragAnchorRowIndex !== -1 && rowEls.length) {
      const cursorRow = cursorRowFromPointer(rowEls);
      range = [Math.min(dragAnchorRowIndex, cursorRow), Math.max(dragAnchorRowIndex, cursorRow)];
    }
    if (!range) {
      clearSelectionVisuals();
      return;
    }
    let [rawFirst, rawLast] = range;
    if (dragSelecting && dragAnchorRowIndex !== -1) {
      // Arm only when the pointer is on a gap with adjacent text already
      // selected (sticky). Separately clamp visual marking to the drag's real
      // span (anchor → cursor) so a transient native-selection over-extension
      // can't highlight rows the drag never reached.
      maybeArmGapUnderPointer(rowEls, rawFirst, rawLast);
      const cursorRow = cursorRowFromPointer(rowEls);
      const spanLo = Math.min(dragAnchorRowIndex, cursorRow);
      const spanHi = Math.max(dragAnchorRowIndex, cursorRow);
      rawFirst = Math.max(rawFirst, spanLo);
      rawLast = Math.min(rawLast, spanHi);
      if (rawFirst > rawLast) {
        clearSelectionVisuals();
        rowEls.forEach((tr) => { if (isArmedGapRow(tr, false)) tr.classList.add("gap-armed"); });
        return;
      }
      [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, rawFirst, rawLast, false);
    } else {
      // Do not clear proximityGapIndices here — arming stays sticky until the
      // next mousedown so Copy still includes armed gaps after mouseup.
      [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, rawFirst, rawLast, false);
    }
  }

  clearSelectionVisuals();
  for (let i = firstIdx; i <= lastIdx; i++) {
    const tr = rowEls[i];
    const textContent = tr.querySelector(".text-content");
    // Include empty placeholders (insert/delete other-side) so the tint stays
    // contiguous; lineTextFromContent ignores the NBSP selection pad.
    if (textContent && !lineTextFromContent(textContent).trim()) {
      textContent.classList.add("ws-line-selected");
    }
    if (isIncludedGapRow(tr, wholeFile, i, firstIdx, lastIdx)) tr.classList.add("gap-armed");
  }
}

document.addEventListener("selectionchange", updateSelectionVisuals);

// Rebuild one side's text from the diff row model, expanding collapsed gaps
// via gap.rows. Used when assembling multi-row copies that span/arm gaps.
// Under ignore-whitespace this still omits blank-only insert/delete rows that
// were filtered out of `rows` before collapse — whole-pane copy prefers
// fullTextA/B below for that reason.
function sideTextFromRowModel(file, side) {
  if (!file || !Array.isArray(file.rows)) return "";
  const parts = [];
  for (let index = 0; index < file.rows.length; index++) {
    const row = file.rows[index];
    if (row.type === "gap") {
      const hidden = gapHiddenText(file, index, side);
      if (hidden) parts.push(hidden);
      continue;
    }
    const text = side === "left" ? row.leftText : row.rightText;
    if (text === null || text === undefined) continue;
    const ending = side === "left" ? row.leftEnding : row.rightEnding;
    parts.push(text + eolString(ending));
  }
  return parts.join("");
}

// Whole-pane copy uses the server-sent original text for that side rather
// than the diff rows: ignore-whitespace mode drops blank-only insert/delete
// rows from `rows` entirely, so they can't be recovered by walking rows/gaps.
function fullSideText(file, side) {
  const direct = side === "left" ? file.fullTextA : file.fullTextB;
  if (typeof direct === "string") return direct;
  return sideTextFromRowModel(file, side);
}

// True when the selection covers the pane's first and last *text* rows, i.e. a
// manual drag across every visible line. Leading/trailing collapsed gaps are
// user-select:none, so checking the outer <tr>s would miss a whole-pane drag;
// first/last .text-content rows are the reliable bounds. Collapsed lines (and
// ignore-whitespace blanks omitted from `rows`) then come from fullSideText.
function selectionSpansWholePane(selection, scope) {
  const textRows = Array.from(scope.querySelectorAll("tbody > tr")).filter((tr) => tr.querySelector(".text-content"));
  if (!textRows.length) return false;
  const firstContent = textRows[0].querySelector(".text-content");
  const lastContent = textRows[textRows.length - 1].querySelector(".text-content");
  return selection.containsNode(firstContent, true) && selection.containsNode(lastContent, true);
}

// Row-range form of whole-pane: every visible .text-content row lies inside
// [firstIdx, lastIdx]. Used by the copy path so we still take fullSideText
// (original file text, including ignore-whitespace blanks and end gaps) even
// if containsNode is inconclusive on a given browser/selection.
function rowRangeCoversAllTextRows(rowEls, firstIdx, lastIdx) {
  let sawText = false;
  for (let i = 0; i < rowEls.length; i++) {
    if (!rowEls[i].querySelector(".text-content")) continue;
    sawText = true;
    if (i < firstIdx || i > lastIdx) return false;
  }
  return sawText;
}

// The literal line terminator for a row's stored "crlf"/"lf"/"" ending.
function eolString(ending) {
  return ending === "crlf" ? "\r\n" : ending === "lf" ? "\n" : "";
}

// The hidden text for one side of a collapsed gap (looked up by its original
// index in file.rows, which dataset.gapIndex is set from). Preserves each
// hidden line's own CRLF/LF ending instead of assuming one for the whole gap.
function gapHiddenText(file, gapIndex, side) {
  const gapRow = file.rows[gapIndex];
  if (!gapRow || gapRow.type !== "gap" || !Array.isArray(gapRow.rows)) return "";
  return gapRow.rows
    .map((row) => {
      const text = side === "left" ? row.leftText : row.rightText;
      if (text === null || text === undefined) return null;
      const ending = side === "left" ? row.leftEnding : row.rightEnding;
      return text + eolString(ending);
    })
    .filter((text) => text !== null)
    .join("");
}

function copyDiffSelection(event, scroll, file) {
  const selection = window.getSelection();
  const anchor = selection && selection.anchorNode;
  const anchorElement = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement);
  if (!selection || !anchorElement) return;

  // A selection covering an entire pane — via right-click/Ctrl+A, or a manual
  // drag spanning its first line to its last — must include lines collapsed
  // into unexpanded gaps, so read the full row model instead of DOM text.
  const scope = scopeOf(anchorElement);
  if (scope && scroll.contains(scope) && (wholeFileScope === scope || selectionSpansWholePane(selection, scope))) {
    const side = scope.classList.contains("right-pane") ? "right" : "left";
    event.clipboardData.setData("text/plain", fullSideText(file, side));
    event.preventDefault();
    return;
  }

  if (!anchorElement.closest(".text-content")) return;

  // Within a side-by-side pane, rebuild from the side/row model: proximity-
  // armed gaps, gaps the selection spans, and (when every visible text row
  // is covered) the full original side text — so collapsed / ignore-
  // whitespace-hidden lines are not dropped just because they are not in
  // the painted DOM.
  if (scope && scroll.contains(scope)) {
    const side = scope.classList.contains("right-pane") ? "right" : "left";
    const rowEls = Array.from(scope.querySelectorAll("tbody > tr"));
    const range = selectedRowRange(rowEls, selection);

    if (range) {
      if (rowRangeCoversAllTextRows(rowEls, range[0], range[1])) {
        event.clipboardData.setData("text/plain", fullSideText(file, side));
        event.preventDefault();
        return;
      }
      // Extend for proximity-armed edge gaps, then include any collapsed gap
      // the selection spans (interior) or armed — hidden text from gap.rows.
      const [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, range[0], range[1], false);
      const parts = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const tr = rowEls[i];
        if (tr.dataset.hasText === "false") continue; // no line exists on this side; contributes nothing
        const textContent = tr.querySelector(".text-content");
        if (textContent) {
          parts.push(lineTextFromContent(textContent) + eolString(tr.dataset.ending));
        } else if (isIncludedGapRow(tr, false, i, firstIdx, lastIdx)) {
          const hidden = gapHiddenText(file, Number(tr.dataset.gapIndex), side);
          if (hidden) parts.push(hidden);
        }
      }
      event.clipboardData.setData("text/plain", parts.join(""));
      event.preventDefault();
      return;
    }
  }

  const selectedRows = Array.from(scroll.querySelectorAll(".text-content"))
    .filter((textContent) => selection.containsNode(textContent, true));
  const copiedText = selectedRows.length > 1
    ? selectedRows.map((textContent) => lineTextFromContent(textContent)).join("\n")
    : (selectedRows.length === 1 ? lineTextFromContent(selectedRows[0]) : selection.toString());
  event.clipboardData.setData("text/plain", copiedText);
  event.preventDefault();
}

// Blocking error modal: shows a title + message and resolves once OK is clicked.
function showErrorModal(title, message) {
  const dialog = document.getElementById("error-dialog");
  const titleEl = document.getElementById("error-dialog-title");
  const messageEl = document.getElementById("error-dialog-message");
  const okButton = document.getElementById("error-dialog-ok-btn");
  if (!dialog || !titleEl || !messageEl || !okButton) return Promise.resolve();

  titleEl.textContent = title;
  messageEl.textContent = message;
  return new Promise((resolve) => {
    const dismiss = () => {
      dialog.close();
      okButton.removeEventListener("click", dismiss);
      resolve();
    };
    okButton.addEventListener("click", dismiss);
    dialog.showModal();
  });
}

let infoToastHideTimer = null;

// Small, titleless, non-blocking toast. Transient messages (isTransient=true)
// show a spinner and stay until hideInfoModal() is called; others show plain
// text and fade out on their own after a short delay.
function showInfoModal(isTransient, message) {
  const toast = document.getElementById("info-toast");
  const spinner = document.getElementById("info-toast-spinner");
  const messageEl = document.getElementById("info-toast-message");
  if (!toast || !spinner || !messageEl) return;

  if (infoToastHideTimer) {
    clearTimeout(infoToastHideTimer);
    infoToastHideTimer = null;
  }
  messageEl.textContent = message;
  spinner.hidden = !isTransient;
  toast.classList.add("visible");
  if (!isTransient) infoToastHideTimer = setTimeout(hideInfoModal, 3500);
}

function hideInfoModal() {
  const toast = document.getElementById("info-toast");
  if (!toast) return;
  if (infoToastHideTimer) {
    clearTimeout(infoToastHideTimer);
    infoToastHideTimer = null;
  }
  toast.classList.remove("visible");
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

const CONTENT_CHANGED_MESSAGE =
  "The folder contents changed after the last comparison. Match was aborted. Run Compare again before mirroring.";

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

// Re-enable action buttons immediately, rather than waiting on an awaited
// modal's dismissal, so they don't look stuck-disabled while it's open.
function reenableActionButtons() {
  compareBtn.disabled = false;
  syncActions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
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
      reenableActionButtons();
      await showErrorModal("Folder contents changed", CONTENT_CHANGED_MESSAGE);
      return;
    }
    if (!checkRes.ok) throw new Error(checkData.error || `Request failed (${checkRes.status})`);
    reenableActionButtons();
    if (!await confirmSyncFolders(direction === "A" ? "Folder A" : "Folder B", targetLabel)) {
      return;
    }
    compareBtn.disabled = true;
    syncActions.querySelectorAll("button").forEach((button) => { button.disabled = true; });

    showInfoModal(true, `Updating ${targetLabel}\u2026`);
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
      hideInfoModal();
      reenableActionButtons();
      await showErrorModal("Folder contents changed", CONTENT_CHANGED_MESSAGE);
      return;
    }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    lastResult = data.result;
    activeCategory = null;
    renderResults();
    const { created, updated, deleted, errors } = data.changes;
    hideInfoModal();
    const summary = `Updated ${targetLabel}: ${created.length} created, ${updated.length} updated, ${deleted.length} deleted${errors.length ? `, ${errors.length} error(s)` : ""}.`;
    if (errors.length > 0) {
      reenableActionButtons();
      await showErrorModal("Sync completed with errors", summary);
    } else {
      showInfoModal(false, summary);
    }
  } catch (err) {
    hideInfoModal();
    reenableActionButtons();
    await showErrorModal("Could not update the folder", err.message || "Could not update the folder.");
  } finally {
    compareBtn.disabled = false;
    syncActions.querySelectorAll("button").forEach((button) => { button.disabled = false; });
  }
}

// ---------- diff rendering ----------
function renderSideBySide(rows, file) {
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
          tr.dataset.expanded = row.expanded ? "true" : "false";
          tr.classList.add("gap-toggle");
        }
        tr.appendChild(cell);
      } else if (side === "left") {
        const hasText = row.leftNum !== null;
        const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).left : null;
        tr.dataset.hasText = hasText ? "true" : "false";
        if (hasText) tr.dataset.ending = row.leftEnding || "";
        tr.appendChild(td("num", hasText ? row.leftNum : ""));
        tr.appendChild(td(hasText ? "sign left" : "sign", hasText && (row.type === "delete" || row.type === "replace") ? "-" : ""));
        tr.appendChild(textTd(hasText ? "text left" : "text empty left", hasText ? row.leftText : "", hasText ? row.leftEnding : "", segments));
      } else {
        const hasText = row.rightNum !== null;
        const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).right : null;
        tr.dataset.hasText = hasText ? "true" : "false";
        if (hasText) tr.dataset.ending = row.rightEnding || "";
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
  scroll.addEventListener("copy", (event) => copyDiffSelection(event, scroll, file));
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

function renderUnified(rows, file) {
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
  scroll.addEventListener("copy", (event) => copyDiffSelection(event, scroll, file));
  return scroll;
}

function renderFileDiff(file, autoOpen) {
  const details = el("details", "file-diff");
  const summary = el("summary");
  summary.appendChild(el("span", "name", file.path));
  summary.appendChild(fileSidesSuffix(file.path, "diff"));
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
    const scroll = viewMode === "unified" ? renderUnified(rows, file) : renderSideBySide(rows, file);
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
function fileListSection(title, items, kind, mapFn) {
  const section = el("section", "section");
  section.appendChild(el("h2", null, `${title} (${items.length})`));
  const ul = el("ul", "file-list");
  for (const item of items) {
    const li = el("li");
    li.appendChild(el("span", "path", item.path));
    li.appendChild(fileSidesSuffix(item.path, kind));
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
  pathColA.appendChild(folderLink(r.folderA));
  const pathColB = el("div", "path-col path-col-b");
  pathColB.appendChild(el("span", "path-label b-label", "B:"));
  pathColB.appendChild(folderLink(r.folderB));
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

const SESSION_KEY = "sochaDiffSession";

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
    await showErrorModal("Missing folder paths", "Please enter both folder paths.");
    return;
  }

  compareBtn.disabled = true;
  showInfoModal(true, "Comparing\u2026");
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
    hideInfoModal();
    renderResults();
  } catch (err) {
    lastResult = null;
    hideInfoModal();
    compareBtn.disabled = false;
    await showErrorModal("Compare failed", err.message || "Something went wrong.");
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
      ? "Whitespace differences are ignored by the file comparer. Click to change to whitespace aware."
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

