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
function appendDecorated(container, text) {
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
}

// Every line that ends in CRLF/LF gets a trailing one-character EOL cell: a
// real NBSP inside span.eol, so the newline is a selectable character (native
// caret placement, ::selection paint) exactly like any other character. The
// visible glyph (whitespace chars on) is drawn over it by .ws-eol::after.
// lineTextFromContent strips the cell; copy emits the file's own CRLF/LF for
// a line only when isEolSelected says its cell is inside the selection.
const EOL_GLYPHS = { crlf: "\u21B5", lf: "\u2193" };
let eolCellProto = null;
function appendEolCell(content, ending, changed) {
  if (ending !== "crlf" && ending !== "lf") return null;
  if (!eolCellProto) {
    eolCellProto = document.createElement("span");
    eolCellProto.className = "eol";
    eolCellProto.textContent = "\u00a0";
  }
  const eol = eolCellProto.cloneNode(true);
  if (showWhitespace) {
    eol.classList.add("ws-eol");
    eol.dataset.eol = EOL_GLYPHS[ending];
  }
  if (changed) eol.classList.add("eol-changed");
  // A blank line is just its newline: the cell doubles as the selection pad.
  if (content.firstChild === null) content.classList.add("eol-only");
  content.appendChild(eol);
  return eol;
}

function eolCellOf(content) {
  const last = content && content.lastChild;
  return last && last.nodeType === Node.ELEMENT_NODE && last.classList.contains("eol") ? last : null;
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
  const text = textContent.textContent;
  return eolCellOf(textContent) ? text.slice(0, -1) : text;
}

// True when a replace pair's line endings differ and should get the
// changed-character emphasis. Ignore-whitespace treats CRLF/LF as common.
function eolDiffers(row) {
  return !currentIgnoreWhitespace && row.type === "replace" && (row.leftEnding || "") !== (row.rightEnding || "");
}

function textTd(className, text, ending, segments, eolChanged) {
  const cell = td(className);
  const content = el("div", "text-content");
  const raw = text === null || text === undefined ? "" : text;
  if (segments) {
    for (const segment of segments) {
      const span = el("span", segment.common ? "diff-common" : "diff-changed");
      if (showWhitespace) appendDecorated(span, segment.text);
      else span.textContent = segment.text;
      content.appendChild(span);
    }
  } else if (showWhitespace) {
    appendDecorated(content, raw);
  } else if (raw) {
    content.textContent = raw;
  }
  // With whitespace chars off a differing ending is still visible: the blank
  // EOL cell carries the .eol-changed emphasis.
  if (!/\bempty\b/.test(className || "")) appendEolCell(content, ending, !!eolChanged);
  ensureSelectionPad(content);
  cell.appendChild(content);
  return cell;
}

let selectionScope = null;
let constrainingSelection = false;
let dragSelecting = false;
// True when the current drag started on a line-number / sign gutter
// (user-select:none): we synthesize whole-line ranges on mousemove.
let gutterLineDrag = false;
let dragPanScroll = null;
let dragRaf = 0;
const dragPointer = { x: 0, y: 0 };
// Row index (within the drag's pane) where the current drag started; used to
// clamp visual marking to the actual drag span, so a transient native-selection
// over-extension can't briefly highlight rows the drag never reached.
let dragAnchorRowIndex = -1;
// Cached tbody rows for the active drag — avoid querySelectorAll on every mousemove.
let dragRowEls = null;
// Set only by selectAllInScope; distinguishes a whole-file selection (which
// may include lines collapsed out of the DOM) from a partial drag selection.
let wholeFileScope = null;
// Gap indices (within the current drag's pane) armed by pointer-over-gap
// proximity (same hit target as click-to-expand / hand cursor), after an
// adjacent visible text row was already selected. During dragSelecting the
// set is live: a gap stays proximity-armed only while the pointer remains on
// that gap's hit zone (dropProximityArmsNotUnderPointer); clamp keeps gating
// neighbors fully selected while armed; pruneProximityGapArming hard-drops
// any arm whose full-neighbor gate still fails. Spanned inclusion does not
// use this set — isSpannedGapRow covers interior gaps separately. After
// mouseup, arms that still satisfy the gate stay sticky until the next
// mousedown so Copy includes them. Hidden lines are spliced into the copied
// text even though they were never rendered/selectable in the DOM.
let proximityGapIndices = new Set();
// Re-entrancy guard: clamp/prune may rewrite the Selection, which synchronously
// re-fires selectionchange → updateSelectionVisuals.
let updatingSelectionVisuals = false;

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

// End an in-progress drag (clear select-inert + I-beam lock + auto-scroll).
// mouseup is the normal path; pointercancel / blur / contextmenu must also
// end it — Windows/WebView2 often swallow mouseup after right-click, and
// touch/stylus cancel never fires mouseup, leaving the opposite pane stuck
// with user-select:none.
function endDragSelecting() {
  setDragSelecting(false);
  gutterLineDrag = false;
  dragPanScroll = null;
  dragRowEls = null;
  if (dragRaf) {
    cancelAnimationFrame(dragRaf);
    dragRaf = 0;
  }
}

// Line-number / sign gutters are user-select:none (so native drag is a no-op).
// Treat them as whole-line hit targets, matching common IDE / diff-viewer UX.
function isGutterCell(target) {
  if (!(target instanceof Element)) return false;
  const cell = target.closest("td.num, td.sign");
  return !!(cell && !cell.closest("tr.gap-toggle"));
}

// Collapsed gap row under the pointer (click-to-expand target). Expanded gap
// markers stay clickable to collapse and are not selection-extend targets.
function isCollapsedGapToggle(target) {
  if (!(target instanceof Element)) return false;
  const tr = target.closest("tr.gap-toggle");
  return !!(tr && tr.dataset.expanded !== "true");
}

// Anchor row for a Shift+extend click: keep the prior drag anchor when we
// have one; otherwise the end of the existing selection farther from the click
// (classic text-editor Shift-click behavior).
function shiftExtendAnchorIdx(prevAnchor, existing, clickedIdx) {
  if (prevAnchor !== -1) return prevAnchor;
  if (!existing) return -1;
  return Math.abs(clickedIdx - existing[0]) >= Math.abs(clickedIdx - existing[1])
    ? existing[0]
    : existing[1];
}

// Nearest .text-content row adjacent to a gap row index, preferring the side
// toward fromIdx when both neighbors exist.
function adjacentTextRowIndex(rowEls, gapIdx, fromIdx) {
  const before = gapIdx > 0 && rowEls[gapIdx - 1].querySelector(".text-content") ? gapIdx - 1 : -1;
  const after =
    gapIdx < rowEls.length - 1 && rowEls[gapIdx + 1].querySelector(".text-content") ? gapIdx + 1 : -1;
  if (before === -1) return after;
  if (after === -1) return before;
  if (fromIdx === -1) return before;
  return Math.abs(before - fromIdx) <= Math.abs(after - fromIdx) ? before : after;
}

// Build a DOM selection covering every .text-content from fromIdx..toIdx
// (gap rows in between have no text node and are skipped for the range ends;
// copy / gap-arming still pull them in via isIncludedGapRow).
function selectWholeLineRange(scope, fromIdx, toIdx) {
  if (!scope) return;
  const rowEls = Array.from(scope.querySelectorAll("tbody > tr"));
  if (!rowEls.length) return;
  let lo = Math.min(fromIdx, toIdx);
  let hi = Math.max(fromIdx, toIdx);
  lo = Math.max(0, Math.min(lo, rowEls.length - 1));
  hi = Math.max(0, Math.min(hi, rowEls.length - 1));
  let firstTc = null;
  let lastTc = null;
  for (let i = lo; i <= hi; i++) {
    const tc = rowEls[i].querySelector(".text-content");
    if (!tc) continue;
    if (!firstTc) firstTc = tc;
    lastTc = tc;
  }
  if (!firstTc || !lastTc) return;
  const selection = window.getSelection();
  const range = document.createRange();
  range.setStart(firstTc, 0);
  range.setEnd(lastTc, lastTc.childNodes.length);
  constrainingSelection = true;
  selection.removeAllRanges();
  selection.addRange(range);
  constrainingSelection = false;
  selectionScope = scope;
  wholeFileScope = null;
}

document.addEventListener("mousedown", (event) => {
  const prevScope = selectionScope;
  const prevAnchor = dragAnchorRowIndex;
  const targetScope = event.target instanceof Element ? event.target.closest(".select-scope") : null;

  // The custom Copy menu acts on the current selection: pressing its item must
  // not reset gesture state (selectionScope / proximity arms) or strip the
  // .gap-armed paint, and must not move focus / the native selection.
  if (diffContextMenu && event.target instanceof Node && diffContextMenu.contains(event.target)) {
    event.preventDefault();
    return;
  }

  // Non-primary buttons (right-click for the Copy menu, middle-click) are not
  // selection gestures. The reset below used to run before the button check,
  // so a right-click cleared .gap-armed / spanned-gap paint (and proximity
  // arms) while the native selection stayed put — no selectionchange followed
  // to repaint, leaving the highlight out of sync with what Copy includes.
  // Keep all selection/gap state; only end a stuck drag. The contextmenu
  // handler decides whether to keep the selection or select the whole pane.
  if (event.button !== 0) {
    if (dragSelecting) endDragSelecting();
    // Stop Chromium from collapsing / moving the native selection (it may
    // place a caret or select a word under the pointer on right-click).
    if (event.button === 2 && targetScope) event.preventDefault();
    return;
  }

  // Plain gap clicks are expand/collapse controls, not selection gestures. Keep
  // the toggle O(gap), but do not return before transferring selection ownership
  // to the clicked pane and resetting gesture state. Skipping that O(1) setup
  // left selectionScope pointing at the previous pane, so later Shift+gap and
  // drag/spanned-gap paint were evaluated against stale pane state.
  const plainGapToggle =
    event.button === 0 &&
    !event.shiftKey &&
    event.target instanceof Element &&
    event.target.closest("tr.gap-toggle[data-gap-index]");
  if (plainGapToggle) {
    event.preventDefault();
    selectionScope = targetScope;
    wholeFileScope = null;
    // A real click arrives after the previous mouseup, so keep this branch O(1).
    // Only run the broader inert-state cleanup for an abnormal overlapping drag.
    if (dragSelecting) endDragSelecting();
    else {
      gutterLineDrag = false;
      dragPanScroll = null;
    }
    dragAnchorRowIndex = -1;
    dragRowEls = null;
    const gapIndex = Number(plainGapToggle.dataset.gapIndex);
    if (!Number.isNaN(gapIndex)) proximityGapIndices.delete(gapIndex);
    return;
  }

  selectionScope = targetScope;
  wholeFileScope = null;
  // Same-scope Shift+extend keeps proximity-armed edge gaps; a fresh click
  // (or pane switch) starts a new selection and clears them.
  const sameScopeShift = !!(event.shiftKey && prevScope && selectionScope === prevScope);
  if (!sameScopeShift) proximityGapIndices = new Set();
  clearSelectionVisuals();
  setDragSelecting(false);
  gutterLineDrag = false;
  dragAnchorRowIndex = -1;
  if (!selectionScope || event.button !== 0) return;

  const rowEls = Array.from(selectionScope.querySelectorAll("tbody > tr"));
  dragRowEls = rowEls;
  const anchorTr = event.target instanceof Element ? event.target.closest("tr") : null;
  const clickedIdx = anchorTr ? rowEls.indexOf(anchorTr) : -1;
  dragPanScroll = panScrollForScope(selectionScope);
  dragPointer.x = event.clientX;
  dragPointer.y = event.clientY;

  if (isGutterCell(event.target) && clickedIdx !== -1) {
    // Prevent the browser's empty native selection on user-select:none gutters.
    event.preventDefault();
    if (event.shiftKey && prevScope === selectionScope) {
      const sel = window.getSelection();
      const existing = sel && !sel.isCollapsed ? selectedRowRange(rowEls, sel) : null;
      const anchorIdx = shiftExtendAnchorIdx(prevAnchor, existing, clickedIdx);
      if (anchorIdx !== -1) {
        dragAnchorRowIndex = anchorIdx;
        selectWholeLineRange(selectionScope, anchorIdx, clickedIdx);
        updateSelectionVisuals();
        return;
      }
    }
    dragAnchorRowIndex = clickedIdx;
    gutterLineDrag = true;
    selectWholeLineRange(selectionScope, clickedIdx, clickedIdx);
    // Cursor lock is independent of the pan scrollbar: any primary-button
    // mousedown in a pane is a selection drag and must keep the I-beam over
    // collapsed gaps. Auto-scroll still needs the bar.
    setDragSelecting(true);
    if (dragPanScroll && !dragRaf) dragRaf = requestAnimationFrame(autoScrollStep);
    updateSelectionVisuals();
    return;
  }

  // Shift+click a collapsed gap: extend/arm like a drag onto the gap, and do
  // not toggle expand (click handler also ignores shiftKey).
  if (isCollapsedGapToggle(event.target) && clickedIdx !== -1) {
    if (event.shiftKey && prevScope === selectionScope) {
      event.preventDefault();
      const sel = window.getSelection();
      const existing = sel && !sel.isCollapsed ? selectedRowRange(rowEls, sel) : null;
      let anchorIdx = shiftExtendAnchorIdx(prevAnchor, existing, clickedIdx);
      const adjIdx = adjacentTextRowIndex(rowEls, clickedIdx, anchorIdx);
      if (adjIdx !== -1) {
        if (anchorIdx === -1) anchorIdx = adjIdx;
        const gapIndex = Number(rowEls[clickedIdx].dataset.gapIndex);
        if (!Number.isNaN(gapIndex)) proximityGapIndices.add(gapIndex);
        dragAnchorRowIndex = anchorIdx;
        selectWholeLineRange(selectionScope, anchorIdx, adjIdx);
        updateSelectionVisuals();
        return;
      }
    }
    // Plain gap click falls through so click-to-expand still runs; avoid
    // starting a text-selection drag on the unselectable gap chrome.
    return;
  }

  // Ctrl+A / right-click select-all leave a broad DOM selection; a following
  // click-drag would otherwise start HTML5 drag-and-drop of that text instead
  // of a new caret selection. Collapse first (non-Shift only).
  if (!event.shiftKey) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) sel.removeAllRanges();
  }

  // Shift+click text must keep the original selection anchor. Overwriting it
  // with clickedIdx made a later Shift+gutter / Shift+gap shrink the range
  // back toward this click and drop earlier rows.
  if (sameScopeShift) {
    const sel = window.getSelection();
    const existing = sel && !sel.isCollapsed ? selectedRowRange(rowEls, sel) : null;
    const anchorIdx = shiftExtendAnchorIdx(prevAnchor, existing, clickedIdx);
    dragAnchorRowIndex = anchorIdx !== -1 ? anchorIdx : clickedIdx;
  } else {
    dragAnchorRowIndex = clickedIdx;
  }
  // Cursor lock is independent of the pan scrollbar: any primary-button
  // mousedown in a pane is a selection drag and must keep the I-beam over
  // collapsed gaps. Auto-scroll still needs the bar.
  setDragSelecting(true);
  if (dragPanScroll && !dragRaf) dragRaf = requestAnimationFrame(autoScrollStep);
}, true);

// Diff panes are not content-editable: never allow HTML5 drag of selected text
// (it swallows mouseup and blocks click-drag reselection after Ctrl+A).
document.addEventListener("dragstart", (event) => {
  if (event.target instanceof Element && event.target.closest(".select-scope")) {
    event.preventDefault();
  }
}, true);

document.addEventListener("mousemove", (event) => {
  if (!dragSelecting) return;
  dragPointer.x = event.clientX;
  dragPointer.y = event.clientY;
  if (!dragRowEls && selectionScope) {
    dragRowEls = Array.from(selectionScope.querySelectorAll("tbody > tr"));
  }
  if (gutterLineDrag && selectionScope && dragAnchorRowIndex !== -1) {
    const rowEls = dragRowEls || [];
    if (rowEls.length) {
      selectWholeLineRange(selectionScope, dragAnchorRowIndex, cursorRowFromPointer(rowEls));
    }
  }
  // Arming happens in updateSelectionVisuals (fires again on the resulting
  // selectionchange with a fresh selection); calling it here too keeps the
  // dragPointer-driven hover check responsive.
  updateSelectionVisuals();
});

// Custom dark Copy menu on diff panes (replaces the native context menu).
let diffContextMenu = null;
let diffContextMenuScroll = null;
let diffContextMenuFile = null;

function hideDiffContextMenu() {
  if (diffContextMenu) {
    diffContextMenu.remove();
    diffContextMenu = null;
  }
  diffContextMenuScroll = null;
  diffContextMenuFile = null;
}

function runDiffContextCopy() {
  const scroll = diffContextMenuScroll;
  const file = diffContextMenuFile;
  hideDiffContextMenu();
  if (!scroll || !file) return;
  const selection = window.getSelection();
  const scope = selectionScope || (scroll.querySelector(".select-scope"));
  // Empty / outside selection: match prior right-click UX by taking the whole pane.
  if (scope && scroll.contains(scope)) {
    if (!selection || selection.isCollapsed || scopeOf(selection.anchorNode) !== scope) {
      selectAllInScope(scope);
    }
  }
  const dt = new DataTransfer();
  const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
  if (!event.clipboardData) {
    Object.defineProperty(event, "clipboardData", { value: dt });
  }
  scroll.dispatchEvent(event);
  const text = (event.clipboardData && event.clipboardData.getData("text/plain")) || dt.getData("text/plain") || "";
  if (text && navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
}

function showDiffContextMenu(clientX, clientY, scroll, file) {
  hideDiffContextMenu();
  diffContextMenuScroll = scroll;
  diffContextMenuFile = file;
  const menu = el("div", "diff-context-menu");
  menu.setAttribute("role", "menu");
  const item = el("button", "diff-context-menu-item", "Copy");
  item.type = "button";
  item.setAttribute("role", "menuitem");
  item.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    runDiffContextCopy();
  });
  menu.appendChild(item);
  document.body.appendChild(menu);
  diffContextMenu = menu;
  const pad = 6;
  const rect = menu.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - rect.width - pad);
  if (top + rect.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - rect.height - pad);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

document.addEventListener("contextmenu", (event) => {
  endDragSelecting();
  const target = event.target instanceof Element ? event.target : null;
  const scope = target ? target.closest(".select-scope") : null;
  if (!scope) {
    hideDiffContextMenu();
    return;
  }
  const scroll = scope.closest(".diff-scroll");
  const fileDiff = scope.closest(".file-diff");
  // file payload is stashed on the scroll via dataset during render; fall back
  // to looking up from lastResult by path on the summary name.
  let file = scroll && scroll._sochaFile;
  if (!file && fileDiff && lastResult && Array.isArray(lastResult.differing)) {
    const name = ((fileDiff.querySelector(".name") || {}).textContent || "").trim();
    file = lastResult.differing.find((f) => f.path === name) || null;
  }
  if (!scroll || !file) return;
  event.preventDefault();
  // Keep an existing in-scope selection (with its armed / spanned gaps);
  // otherwise arm whole-pane for Copy.
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || scopeOf(selection.anchorNode) !== scope) {
    proximityGapIndices = new Set();
    selectAllInScope(scope);
  } else {
    selectionScope = scope;
  }
  // Re-sync gap paint with the (unchanged) selection: no selectionchange fires
  // when the selection is kept, so repaint explicitly.
  updateSelectionVisuals();
  showDiffContextMenu(event.clientX, event.clientY, scroll, file);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideDiffContextMenu();
}, true);

document.addEventListener("pointerdown", (event) => {
  if (!diffContextMenu) return;
  if (event.target instanceof Element && diffContextMenu.contains(event.target)) return;
  hideDiffContextMenu();
}, true);

document.addEventListener("scroll", () => hideDiffContextMenu(), true);

document.addEventListener("mouseup", () => {
  endDragSelecting();
}, true);

document.addEventListener("pointercancel", () => {
  endDragSelecting();
}, true);

window.addEventListener("blur", () => {
  endDragSelecting();
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

// Row index for a selection anchor/focus node within rowEls, or -1.
// Only resolves nodes inside .text-content so gutter (td.num / td.sign) hits
// do not count as selecting that row — Chromium triple-click often parks the
// focus at offset 0 of the next row's text while painting only that row's
// gutters, which previously pulled an extra line into copy.
function rowIndexForNode(node, rowEls) {
  const element = node && (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement);
  if (!element) return -1;
  const textContent = element.closest(".text-content");
  if (!textContent) return -1;
  const tr = textContent.closest("tr");
  return tr ? rowEls.indexOf(tr) : -1;
}

// True when a selection client rect overlaps a .text-content box in both axes.
// Vertical-midpoint-in-span is too coarse: a gutter-only strip on the next row
// still puts that row's midpoint inside the selection's top/bottom.
function textContentIntersectsRects(textContent, rects) {
  const box = textContent.getBoundingClientRect();
  for (const r of rects) {
    const vert = r.bottom > box.top + 1 && r.top < box.bottom - 1;
    const horiz = r.right > box.left + 1 && r.left < box.right - 1;
    if (vert && horiz) return true;
  }
  return false;
}

// The [firstVisibleRow, lastVisibleRow] the selection spans, derived from its
// rendered rects rather than anchor/focus nodes: when a drag ends inside an
// unselectable gap the focus can land on the pane element itself (not a row),
// which node-based lookup can't resolve. Gap rows have no .text-content and are
// skipped, so the bounds are always visible text rows.
// Empty .text-content can yield zero-width or empty client rects in Chromium;
// accept height-only rects and fall back to anchor/focus rows when needed.
// Rect hits must overlap .text-content (not merely td.num / td.sign): native
// line selection often paints the next row's gutters without selecting its text.
function selectedRowRange(rowEls, selection) {
  if (!selection.rangeCount) return null;
  const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((r) => r.height > 0);
  let first = -1;
  let last = -1;
  if (rects.length) {
    for (let i = 0; i < rowEls.length; i++) {
      const textContent = rowEls[i].querySelector(".text-content");
      if (!textContent) continue; // skip gap rows
      if (!textContentIntersectsRects(textContent, rects)) continue;
      if (first === -1) first = i;
      last = i;
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

// True when every adjacent text-row neighbor that lies inside [firstIdx, lastIdx]
// is fully selected, and at least one such neighbor exists. Gates both proximity
// arming and spanned inclusion: a partial mid-line select on either side must
// not pull in the collapsed gap (bottom-up and top-down).
function adjacentSelectionAllowsGap(rowEls, gapIdx, firstIdx, lastIdx, selection) {
  if (!rowEls || !selection || gapIdx < 0) return false;
  const above = gapIdx - 1;
  const below = gapIdx + 1;
  const aboveIn = above >= firstIdx && above <= lastIdx;
  const belowIn = below >= firstIdx && below <= lastIdx;
  if (!aboveIn && !belowIn) return false;

  const neighborFullySelected = (i) => {
    const tr = rowEls[i];
    const tc = tr && tr.querySelector(".text-content");
    if (!tc) return false;
    return isGapNeighborFullySelected(selection, tc, i < gapIdx);
  };
  if (aboveIn && !neighborFullySelected(above)) return false;
  if (belowIn && !neighborFullySelected(below)) return false;
  return true;
}

// "Fully selected" for the gap gate means the neighbor's text plus its
// newline toward the gap: the line above a gap must have its EOL cell
// selected (the hidden lines start after that newline); the line below only
// needs its text from column 0, since its own newline points away from the
// gap. Rows without an EOL cell (last line with no final newline, placeholder
// rows) fall back to the text-only check.
function isGapNeighborFullySelected(selection, textContent, aboveGap) {
  if (!isTextContentFullySelected(selection, textContent)) return false;
  if (aboveGap && eolCellOf(textContent)) return isEolSelected(selection, textContent);
  return true;
}

// Collapsed gap strictly between the selected text-row bounds — the selection
// spans it even if the pointer never armed it. Hidden gap.rows must copy, but
// only when every in-range adjacent text neighbor is fully selected (same gate
// as proximity arming).
function isSpannedGapRow(tr, index, firstIdx, lastIdx, rowEls, selection) {
  if (!tr.classList.contains("gap-toggle") || tr.dataset.expanded === "true") return false;
  if (!(index > firstIdx && index < lastIdx)) return false;
  return adjacentSelectionAllowsGap(rowEls, index, firstIdx, lastIdx, selection);
}

// Gap contributes hidden lines on copy / gap-armed visuals when whole-pane,
// proximity-armed, or spanned by the current row range (with full-line gate).
// Proximity-armed gaps still require the full-neighbor gate so paint/copy never
// show .gap-armed beside a partial neighbor (defense in depth with prune).
function isIncludedGapRow(tr, treatAllAsArmed, index, firstIdx, lastIdx, rowEls, selection) {
  if (isSpannedGapRow(tr, index, firstIdx, lastIdx, rowEls, selection)) return true;
  if (!isArmedGapRow(tr, treatAllAsArmed)) return false;
  if (treatAllAsArmed) return true;
  return adjacentSelectionAllowsGap(rowEls, index, firstIdx, lastIdx, selection);
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

// True when the selection's client rects (or containsNode) overlap a .text-content.
function selectionOverlapsTextContent(selection, textContent) {
  if (!selection || !textContent || !selection.rangeCount) return false;
  if (selection.containsNode(textContent, true)) return true;
  const rects = Array.from(selection.getRangeAt(0).getClientRects()).filter((r) => r.height > 0);
  return textContentIntersectsRects(textContent, rects);
}

// Character offset of (node, offset) within textContent's concatenated text,
// or 0 / length when the point lies entirely before / after the content.
// Used by isTextContentFullySelected: Chromium's containsNode(text, false) and
// compareBoundaryPoints both mis-report mid-node / (text,0) vs (el,0) cases
// when the selection extends into gap chrome.
function textOffsetInContent(textContent, node, offset) {
  if (!textContent || !node) return -1;
  const fullLen = () => lineTextFromContent(textContent).length;
  if (node === textContent) {
    let chars = 0;
    const kids = textContent.childNodes;
    for (let i = 0; i < offset && i < kids.length; i++) {
      chars += (kids[i].textContent || "").length;
    }
    return chars;
  }
  if (textContent.contains(node)) {
    let chars = 0;
    const walker = document.createTreeWalker(textContent, NodeFilter.SHOW_TEXT);
    let n = walker.nextNode();
    while (n) {
      if (n === node) return chars + offset;
      chars += n.textContent.length;
      n = walker.nextNode();
    }
    return chars;
  }
  // Ancestor of textContent (e.g. selection focus parked on the pane after
  // dragging into user-select:none gap chrome): map child index to before/after.
  if (node.nodeType === Node.ELEMENT_NODE && node.contains(textContent)) {
    let child = textContent;
    while (child.parentNode && child.parentNode !== node) child = child.parentNode;
    if (child.parentNode === node) {
      const childIndex = Array.prototype.indexOf.call(node.childNodes, child);
      // offset <= childIndex → at/before tc; offset > childIndex → after tc.
      return offset <= childIndex ? 0 : fullLen();
    }
  }
  // Outside sibling/elsewhere: before → 0; after → full length.
  const pos = node.compareDocumentPosition(textContent);
  if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return 0;
  if (pos & Node.DOCUMENT_POSITION_PRECEDING) return fullLen();
  return -1;
}

// True when every character of .text-content is inside the selection (or the
// row is blank/pad-only and the selection intersects it). Used to gate gap
// arming: a collapsed gap may only arm when the adjacent visible text row
// toward the selection is fully selected — not a mid-line partial.
// Prefer character-offset coverage (reliable across gap-adjacent extends and
// mid-line partials). Treat isPartialTextContentSelection as definite not-full.
// Avoid brittle selection.toString() equality and Chromium containsNode /
// compareBoundaryPoints false positives/negatives around gap chrome.
function isTextContentFullySelected(selection, textContent) {
  if (!selection || !textContent || selection.isCollapsed || !selection.rangeCount) return false;
  const full = lineTextFromContent(textContent);
  if (full === "") return selectionOverlapsTextContent(selection, textContent);
  // Definite not-full: selection confined to this line but missing characters.
  if (isPartialTextContentSelection(selection, textContent)) return false;
  // Entire line element inside the selection (multi-row interior / whole-line range).
  if (selection.containsNode(textContent, false)) return true;
  try {
    const selRange = selection.getRangeAt(0);
    if (!selRange.intersectsNode(textContent)) return false;
    const startOff = textOffsetInContent(textContent, selRange.startContainer, selRange.startOffset);
    const endOff = textOffsetInContent(textContent, selRange.endContainer, selRange.endOffset);
    if (startOff < 0 || endOff < 0) return false;
    return startOff === 0 && endOff >= full.length;
  } catch {
    return false;
  }
}

// Arm a collapsed gap only when the pointer is directly over it (same hit
// target as click-to-expand / hand cursor) AND every adjacent text row that
// already lies in the selection range is fully selected (entire .text-content,
// not a partial mid-line). Newly arming requires pointer-on-gap. During drag,
// proximity arms are dropped as soon as the pointer leaves that gap (see
// dropProximityArmsNotUnderPointer); the hard full-neighbor prune still runs
// as defense in depth. Fully selecting the neighbor without the pointer on
// the gap must not arm it.
// Resolve the collapsed gap under the pointer. Prefer elementFromPoint inside
// the active pane; fall back to geometry when the hit target is file chrome
// (details summary / .paths) sitting directly above a leading gap — common for
// the first .file-diff in the results, where summary/paths steal hits that
// later files rarely see mid-viewport.
function collapsedGapTrUnderPointer(rowEls) {
  if (!selectionScope || !rowEls || !rowEls.length) return null;
  const x = dragPointer.x;
  const y = dragPointer.y;
  const el = document.elementFromPoint(x, y);
  if (el instanceof Element && selectionScope.contains(el)) {
    const gapTr = el.closest("tr.gap-toggle");
    if (gapTr && gapTr.dataset.expanded !== "true" && selectionScope.contains(gapTr)) return gapTr;
  }

  const paneBox = selectionScope.getBoundingClientRect();
  if (x < paneBox.left || x > paneBox.right) return null;

  const fileDiff = selectionScope.closest(".file-diff");
  if (el instanceof Element && fileDiff) {
    const summary = fileDiff.querySelector(":scope > summary");
    const onSummary = summary && (el === summary || summary.contains(el));
    const paths = document.querySelector(".paths");
    const onPaths = paths && (el === paths || paths.contains(el));
    const firstFile = document.querySelector("details.file-diff");
    const isFirstFile = firstFile && fileDiff === firstFile;
    if (onSummary || (onPaths && isFirstFile)) {
      const lead = rowEls[0];
      if (lead && lead.classList.contains("gap-toggle") && lead.dataset.expanded !== "true") {
        return lead;
      }
    }
  }

  // Subpixel miss between summary bottom and gap top: match by row geometry.
  let lo = 0;
  let hi = rowEls.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = rowEls[mid].getBoundingClientRect();
    if (y < b.top) hi = mid - 1;
    else if (y > b.bottom) lo = mid + 1;
    else {
      const tr = rowEls[mid];
      if (tr.classList.contains("gap-toggle") && tr.dataset.expanded !== "true") return tr;
      return null;
    }
  }
  return null;
}

function maybeArmGapUnderPointer(rowEls, selectedFirst, selectedLast) {
  if (!dragSelecting || !selectionScope) return;
  const gapTr = collapsedGapTrUnderPointer(rowEls);
  if (!gapTr) return;

  const gapIdx = rowEls.indexOf(gapTr);
  if (gapIdx === -1) return;

  const selection = window.getSelection();
  // Require every in-range adjacent text neighbor to be fully selected — not
  // OR either side. Bottom-up extends can fully select the above row while the
  // below (start) line is still only partial; OR would wrongly arm the gap.
  if (!adjacentSelectionAllowsGap(rowEls, gapIdx, selectedFirst, selectedLast, selection)) return;

  proximityGapIndices.add(Number(gapTr.dataset.gapIndex));
}

// During drag, proximity arms are only valid while the pointer remains on that
// gap's hit zone. Mouse-off back onto the neighbor (or away from gap chrome)
// in the same gesture drops the arm immediately — even when clamp left the
// neighbor fully selected — so .gap-armed does not stick after leaving the
// gap. Interior gaps the selection cleanly spans still paint/copy via
// isSpannedGapRow (full-neighbor gate) without needing proximityGapIndices.
// After mouseup this is not called; sticky arms rely on pruneProximityGapArming.
function dropProximityArmsNotUnderPointer(rowEls) {
  if (!dragSelecting || !proximityGapIndices.size || !rowEls || !selectionScope) return;
  const gapTr = collapsedGapTrUnderPointer(rowEls);
  const underGapIndex = gapTr ? Number(gapTr.dataset.gapIndex) : NaN;
  for (const gapIndex of [...proximityGapIndices]) {
    if (gapIndex !== underGapIndex) proximityGapIndices.delete(gapIndex);
  }
}

// While a proximity gap stays armed, keep every in-range gating neighbor's
// .text-content fully selected (gap armed ⇒ full neighbor). If focus/anchor
// retreats inside that neighbor (e.g. peels trailing "16"), extend the range
// to cover selectNodeContents. If the user retreats off the neighbor entirely
// (neighbor leaves the selected row range), leave it alone — hard prune drops
// the arm next. Call before pruneProximityGapArming.
function clampSelectionToArmedGapNeighbors(rowEls, selectedFirst, selectedLast, selection) {
  if (!proximityGapIndices.size || !rowEls || !selection || !selection.rangeCount) return;
  let changed = false;
  for (const gapIndex of [...proximityGapIndices]) {
    const gapTr = rowEls.find((tr) => Number(tr.dataset.gapIndex) === gapIndex);
    if (!gapTr || gapTr.dataset.expanded === "true") continue;
    const gapIdx = rowEls.indexOf(gapTr);
    if (gapIdx === -1) continue;

    const neighborIdxs = [];
    const above = gapIdx - 1;
    const below = gapIdx + 1;
    if (above >= selectedFirst && above <= selectedLast) neighborIdxs.push(above);
    if (below >= selectedFirst && below <= selectedLast) neighborIdxs.push(below);

    for (const i of neighborIdxs) {
      const tc = rowEls[i] && rowEls[i].querySelector(".text-content");
      if (!tc || (lineTextFromContent(tc) === "" && !eolCellOf(tc))) continue;
      if (isGapNeighborFullySelected(selection, tc, i < gapIdx)) continue;
      // Still overlapping / in-range but not full — re-extend to the whole line
      // so a peeled suffix cannot coexist with an armed gap.
      if (!selectionOverlapsTextContent(selection, tc) && !isPartialTextContentSelection(selection, tc)) {
        continue;
      }
      try {
        const contentRange = document.createRange();
        contentRange.selectNodeContents(tc);
        const selRange = selection.getRangeAt(0);
        const next = selRange.cloneRange();
        if (next.compareBoundaryPoints(Range.START_TO_START, contentRange) > 0) {
          next.setStart(contentRange.startContainer, contentRange.startOffset);
        }
        if (next.compareBoundaryPoints(Range.END_TO_END, contentRange) < 0) {
          next.setEnd(contentRange.endContainer, contentRange.endOffset);
        }
        constrainingSelection = true;
        selection.removeAllRanges();
        selection.addRange(next);
        constrainingSelection = false;
        changed = true;
      } catch {
        /* ignore range errors on detached nodes */
      }
    }
  }
  return changed;
}

// Drop proximity-armed gaps that the current selection no longer justifies.
// Hard prune: any arm whose adjacentSelectionAllowsGap gate fails is dropped
// immediately (during drag and on mouseup). No soft exception for Chromium
// gap-label false-negatives — those are handled by character-offset full-line
// checks and clampSelectionToArmedGapNeighbors (which restores a full neighbor
// before this runs while the arm is still live). During drag, pointer-leave
// disarm is handled separately by dropProximityArmsNotUnderPointer; this prune
// enforces the adjacent-character / full-neighbor rule for remaining arms.
function pruneProximityGapArming(rowEls, selectedFirst, selectedLast, selection) {
  if (!proximityGapIndices.size || !rowEls || !selection) return;
  for (const gapIndex of [...proximityGapIndices]) {
    const gapTr = rowEls.find((tr) => Number(tr.dataset.gapIndex) === gapIndex);
    if (!gapTr || gapTr.dataset.expanded === "true") {
      proximityGapIndices.delete(gapIndex);
      continue;
    }
    const gapIdx = rowEls.indexOf(gapTr);
    if (gapIdx === -1) {
      proximityGapIndices.delete(gapIndex);
      continue;
    }
    if (!adjacentSelectionAllowsGap(rowEls, gapIdx, selectedFirst, selectedLast, selection)) {
      proximityGapIndices.delete(gapIndex);
    }
  }
}

// The row index nearest the live cursor (dragPointer), clamped into range.
// Used to bound the marked span; robust to the cursor being above the first
// row (e.g. over the file-diff summary) or below the last.
function cursorRowFromPointer(rowEls) {
  if (!rowEls.length) return 0;
  const y = dragPointer.y;
  const firstBox = rowEls[0].getBoundingClientRect();
  if (y < firstBox.top) return 0;
  const lastBox = rowEls[rowEls.length - 1].getBoundingClientRect();
  if (y > lastBox.bottom) return rowEls.length - 1;
  // Binary search: avoid O(file) getBoundingClientRect during mousemove.
  let lo = 0;
  let hi = rowEls.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const b = rowEls[mid].getBoundingClientRect();
    if (y < b.top) hi = mid - 1;
    else if (y > b.bottom) lo = mid + 1;
    else return mid;
  }
  return Math.max(0, Math.min(lo, rowEls.length - 1));
}

// Mark blank/whitespace-only lines (and empty insert/delete placeholders) and
// included gaps (proximity-armed or spanned) within the current selection:
// native selection highlighting is invisible or caret-width on empty content,
// and gives no cue that a collapsed gap will be copied too.
function updateSelectionVisuals() {
  if (updatingSelectionVisuals) return;
  updatingSelectionVisuals = true;
  try {
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

  const rowEls = (dragSelecting && dragRowEls && dragRowEls.length)
    ? dragRowEls
    : Array.from(selectionScope.querySelectorAll("tbody > tr"));
  if (dragSelecting) dragRowEls = rowEls;
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
      // selected. Drop proximity arms as soon as the pointer leaves that gap
      // in the same drag (do not keep sticky arms after mouse-off). While
      // still armed, clamp peels back onto a full neighbor; then hard-prune
      // any arm whose full-neighbor gate still fails. Separately clamp visual
      // marking to the drag's real span (anchor → cursor) so a transient
      // native-selection over-extension can't highlight rows the drag never
      // reached.
      maybeArmGapUnderPointer(rowEls, rawFirst, rawLast);
      dropProximityArmsNotUnderPointer(rowEls);
      clampSelectionToArmedGapNeighbors(rowEls, rawFirst, rawLast, selection);
      let liveRange = selectedRowRange(rowEls, selection);
      if (liveRange) [rawFirst, rawLast] = liveRange;
      pruneProximityGapArming(rowEls, rawFirst, rawLast, selection);
      const cursorRow = cursorRowFromPointer(rowEls);
      const spanLo = Math.min(dragAnchorRowIndex, cursorRow);
      const spanHi = Math.max(dragAnchorRowIndex, cursorRow);
      rawFirst = Math.max(rawFirst, spanLo);
      rawLast = Math.min(rawLast, spanHi);
      if (rawFirst > rawLast) {
        // Cursor left every selected text row — disarm; never paint .gap-armed
        // without a fully selected neighbor.
        proximityGapIndices.clear();
        clearSelectionVisuals();
        return;
      }
      // Re-clamp/prune against the visual span so a retreated cursor drops
      // arms whose neighbor fell outside the real drag range.
      clampSelectionToArmedGapNeighbors(rowEls, rawFirst, rawLast, selection);
      liveRange = selectedRowRange(rowEls, selection);
      if (liveRange) {
        rawFirst = Math.max(liveRange[0], spanLo);
        rawLast = Math.min(liveRange[1], spanHi);
        if (rawFirst > rawLast) {
          proximityGapIndices.clear();
          clearSelectionVisuals();
          return;
        }
      }
      pruneProximityGapArming(rowEls, rawFirst, rawLast, selection);
      [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, rawFirst, rawLast, false);
    } else {
      // Sticky until mousedown for Copy, but clamp then hard-drop arms that
      // no longer satisfy the full-neighbor gate (orphans from a retreated
      // drag before mouseup).
      clampSelectionToArmedGapNeighbors(rowEls, rawFirst, rawLast, selection);
      const liveRange = selectedRowRange(rowEls, selection);
      if (liveRange) [rawFirst, rawLast] = liveRange;
      pruneProximityGapArming(rowEls, rawFirst, rawLast, selection);
      [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, rawFirst, rawLast, false);
    }
  }

  clearSelectionVisuals();
  for (let i = firstIdx; i <= lastIdx; i++) {
    const tr = rowEls[i];
    const textContent = tr.querySelector(".text-content");
    // Blank / whitespace-only / empty placeholder: paint only when the real
    // Selection overlaps this .text-content (or the drag span kept the row in
    // range while Chromium briefly dropped rects). Non-blank rows rely on
    // native ::selection so partial mid-line selects stay partial; never mark
    // a whole non-blank line while copy would be partial.
    if (textContent && !lineTextFromContent(textContent).trim()) {
      // Prefer real Selection overlap so paint matches copy. While dragging,
      // Chromium may briefly drop blank-row rects — keep marks stable for any
      // blank still inside the resolved span.
      const overlaps =
        wholeFile || selectionOverlapsTextContent(selection, textContent) || dragSelecting;
      if (overlaps) textContent.classList.add("ws-line-selected");
    }
    if (isIncludedGapRow(tr, wholeFile, i, firstIdx, lastIdx, rowEls, selection)) tr.classList.add("gap-armed");
  }
  } finally {
    updatingSelectionVisuals = false;
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

// True when the selection lives entirely inside one .text-content but does not
// cover that whole line — word / character selects must copy verbatim, not the
// full rebuilt line (multi-row copy still joins whole lines below).
// True when the line's EOL cell (its newline) lies wholly inside the
// selection. Range.comparePoint is an exact DOM boundary comparison, so a
// selection ending at the end of the text (just before the cell) reports
// false, and one ending after the cell, on the next row, or in gap chrome
// below reports true.
function isEolSelected(selection, textContent) {
  const eol = eolCellOf(textContent);
  const text = eol && eol.firstChild;
  if (!text || !selection || selection.isCollapsed || !selection.rangeCount) return false;
  try {
    const range = selection.getRangeAt(0);
    return range.comparePoint(text, 0) === 0 && range.comparePoint(text, 1) === 0;
  } catch {
    return false;
  }
}

function isPartialTextContentSelection(selection, textContent) {
  if (!selection || !textContent || selection.isCollapsed || !selection.rangeCount) return false;
  const anchorEl =
    selection.anchorNode &&
    (selection.anchorNode.nodeType === Node.ELEMENT_NODE
      ? selection.anchorNode
      : selection.anchorNode.parentElement);
  const focusEl =
    selection.focusNode &&
    (selection.focusNode.nodeType === Node.ELEMENT_NODE
      ? selection.focusNode
      : selection.focusNode.parentElement);
  if (!anchorEl || !focusEl) return false;
  if (!textContent.contains(anchorEl) && textContent !== anchorEl) return false;
  if (!textContent.contains(focusEl) && textContent !== focusEl) return false;
  // Entire line element is inside the selection (e.g. triple-click / select-all-chars).
  if (selection.containsNode(textContent, false)) return false;
  const full = lineTextFromContent(textContent);
  if (full === "") return false; // blank / pad-only row — keep full-line path
  // Character offsets, not toString(): the EOL cell's NBSP would make a
  // whole-line-plus-newline selection look partial.
  const [start, end] = selectedTextOffsets(selection, textContent);
  if (start < 0 || end < 0) return selection.toString() !== full;
  return !(start <= 0 && end >= full.length);
}

// [start, end] character offsets of the selection within textContent's
// concatenated text (the EOL cell counts as one character after the text).
function selectedTextOffsets(selection, textContent) {
  try {
    const range = selection.getRangeAt(0);
    return [
      textOffsetInContent(textContent, range.startContainer, range.startOffset),
      textOffsetInContent(textContent, range.endContainer, range.endOffset),
    ];
  } catch {
    return [-1, -1];
  }
}

// Clipboard text for a selection within one visible row: the selected
// characters of the line, plus the file's own line terminator only when the
// row's EOL cell is selected.
function singleRowCopyText(selection, textContent, ending) {
  const full = lineTextFromContent(textContent);
  let [start, end] = selectedTextOffsets(selection, textContent);
  if (start < 0) start = 0;
  if (end < 0) end = full.length;
  const body = full.slice(Math.min(start, full.length), Math.min(Math.max(start, end), full.length));
  return body + (isEolSelected(selection, textContent) ? eolString(ending) : "");
}

// A manual drag over every visible row copies the whole side, but if it
// stops before the final line's newline (no trailing gap, so that line is
// the file's last visible line) the terminator is left off.
function trimUnselectedFinalEol(text, scope, selection) {
  const rowEls = scope.querySelectorAll("tbody > tr");
  for (let i = rowEls.length - 1; i >= 0; i--) {
    const tr = rowEls[i];
    if (tr.classList.contains("gap-toggle") || tr.classList.contains("gap")) return text;
    if (tr.dataset.hasText === "false") continue;
    const tc = tr.querySelector(".text-content");
    if (!tc) return text;
    if (!eolCellOf(tc) || isEolSelected(selection, tc)) return text;
    const eol = eolString(tr.dataset.ending);
    const tail = lineTextFromContent(tc) + eol;
    return eol && text.endsWith(tail) ? text.slice(0, -eol.length) : text;
  }
  return text;
}

function copyDiffSelection(event, scroll, file) {
  const selection = window.getSelection();
  const anchor = selection && selection.anchorNode;
  const anchorElement = anchor && (anchor.nodeType === Node.ELEMENT_NODE ? anchor : anchor.parentElement);
  // Caret-only: do not synthesize a whole-line clipboard payload.
  if (!selection || !anchorElement || selection.isCollapsed) return;

  // A selection covering an entire pane — via right-click/Ctrl+A, or a manual
  // drag spanning its first line to its last — must include lines collapsed
  // into unexpanded gaps, so read the full row model instead of DOM text.
  const scope = scopeOf(anchorElement);
  if (scope && scroll.contains(scope) && (wholeFileScope === scope || selectionSpansWholePane(selection, scope))) {
    const side = scope.classList.contains("right-pane") ? "right" : "left";
    let text = fullSideText(file, side);
    if (wholeFileScope !== scope) text = trimUnselectedFinalEol(text, scope, selection);
    event.clipboardData.setData("text/plain", text);
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
        event.clipboardData.setData("text/plain", trimUnselectedFinalEol(fullSideText(file, side), scope, selection));
        event.preventDefault();
        return;
      }
      // Extend for proximity-armed edge gaps, then include any collapsed gap
      // the selection spans (interior) or armed — hidden text from gap.rows.
      const [firstIdx, lastIdx] = extendRangeAcrossArmedGaps(rowEls, range[0], range[1], false);
      // Single visible text row: copy exactly the selected characters, plus
      // the newline only when its EOL cell is selected.
      if (firstIdx === lastIdx) {
        const tr = rowEls[firstIdx];
        const textContent = tr.querySelector(".text-content");
        if (textContent) {
          const text = tr.dataset.hasText === "false" ? "" : singleRowCopyText(selection, textContent, tr.dataset.ending);
          event.clipboardData.setData("text/plain", text);
          event.preventDefault();
          return;
        }
      }
      // Multi-row: whole lines (existing convention), each followed by its own
      // CRLF/LF only when that line's EOL cell is selected — in practice every
      // row but possibly the last.
      const parts = [];
      for (let i = firstIdx; i <= lastIdx; i++) {
        const tr = rowEls[i];
        if (tr.dataset.hasText === "false") continue; // no line exists on this side; contributes nothing
        const textContent = tr.querySelector(".text-content");
        if (textContent) {
          parts.push(lineTextFromContent(textContent) + (isEolSelected(selection, textContent) ? eolString(tr.dataset.ending) : ""));
        } else if (isIncludedGapRow(tr, false, i, firstIdx, lastIdx, rowEls, selection)) {
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
  let copiedText;
  if (selectedRows.length > 1) {
    copiedText = selectedRows.map((textContent) => lineTextFromContent(textContent)).join("\n");
  } else if (selectedRows.length === 1 && isPartialTextContentSelection(selection, selectedRows[0])) {
    copiedText = selection.toString();
  } else if (selectedRows.length === 1) {
    copiedText = lineTextFromContent(selectedRows[0]);
  } else {
    copiedText = selection.toString();
  }
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

// Prototype <tr> for equal side-by-side rows — cloneNode is far cheaper than
// createElement×5 per line when expanding large gaps (~1k lines).
let sbsEqualRowProto = null;
function getSbsEqualRowProto() {
  if (sbsEqualRowProto) return sbsEqualRowProto;
  const tr = document.createElement("tr");
  tr.className = "equal";
  tr.dataset.hasText = "true";
  const num = document.createElement("td");
  num.className = "num";
  const sign = document.createElement("td");
  sign.className = "sign";
  const textCell = document.createElement("td");
  textCell.className = "text left";
  const content = document.createElement("div");
  content.className = "text-content";
  textCell.appendChild(content);
  tr.append(num, sign, textCell);
  sbsEqualRowProto = tr;
  return tr;
}

let unifiedEqualRowProto = null;
function getUnifiedEqualRowProto() {
  if (unifiedEqualRowProto) return unifiedEqualRowProto;
  const tr = document.createElement("tr");
  tr.className = "equal";
  const numL = document.createElement("td");
  numL.className = "num";
  const numR = document.createElement("td");
  numR.className = "num";
  const sign = document.createElement("td");
  sign.className = "sign";
  const textCell = document.createElement("td");
  textCell.className = "text";
  const content = document.createElement("div");
  content.className = "text-content";
  textCell.appendChild(content);
  tr.append(numL, numR, sign, textCell);
  unifiedEqualRowProto = tr;
  return tr;
}

// Whitespace decoration for bulk gap expands is deferred so the first paint
// after click stays cheap; glyphs land in idle/rAF chunks afterward. Chunks
// are time-budgeted and cancelable so a later small gap toggle is not stuck
// behind a stale whole-file decorate job.
let wsDecorateRaf = 0;
let wsDecorateIdle = 0;
const wsDecorateQueue = [];

function cancelWsDecoratePump() {
  if (wsDecorateRaf) {
    cancelAnimationFrame(wsDecorateRaf);
    wsDecorateRaf = 0;
  }
  if (wsDecorateIdle && typeof cancelIdleCallback === "function") {
    cancelIdleCallback(wsDecorateIdle);
    wsDecorateIdle = 0;
  }
}

function scheduleWsDecoratePump() {
  if (wsDecorateRaf || wsDecorateIdle || !wsDecorateQueue.length) return;
  if (typeof requestIdleCallback === "function") {
    wsDecorateIdle = requestIdleCallback((deadline) => {
      wsDecorateIdle = 0;
      flushWsDecorateChunk(deadline);
    }, { timeout: 120 });
  } else {
    wsDecorateRaf = requestAnimationFrame(() => {
      wsDecorateRaf = 0;
      flushWsDecorateChunk(null);
    });
  }
}

function enqueueWsDecorate(content, ending) {
  if (!content) return;
  content.dataset.wsPending = "1";
  if (ending === "crlf" || ending === "lf") content.dataset.wsEnding = ending;
  else delete content.dataset.wsEnding;
  wsDecorateQueue.push(content);
  scheduleWsDecoratePump();
}

function flushWsDecorateChunk(deadline) {
  const started = performance.now();
  const timeBudget = 6; // ms — keep post-toggle frames interactive
  let n = 0;
  while (wsDecorateQueue.length) {
    if (n > 0) {
      const outOfTime = deadline && typeof deadline.timeRemaining === "function"
        ? deadline.timeRemaining() <= 0
        : performance.now() - started >= timeBudget;
      if (outOfTime) break;
    }
    const content = wsDecorateQueue.shift();
    if (!content || !content.isConnected || content.dataset.wsPending !== "1") continue;
    const ending = content.dataset.wsEnding || "";
    const raw = lineTextFromContent(content);
    content.textContent = "";
    content.classList.remove("eol-only");
    delete content.dataset.wsPending;
    delete content.dataset.wsEnding;
    delete content.dataset.selPad;
    appendDecorated(content, raw);
    appendEolCell(content, ending, false);
    ensureSelectionPad(content);
    n++;
  }
  if (wsDecorateQueue.length) scheduleWsDecoratePump();
}

function fillGapTextContent(content, text, ending, lazyWs) {
  const raw = text === null || text === undefined ? "" : text;
  content.classList.remove("eol-only");
  if (lazyWs && showWhitespace) {
    content.textContent = raw;
    appendEolCell(content, ending || "", false);
    ensureSelectionPad(content);
    enqueueWsDecorate(content, ending || "");
  } else if (showWhitespace) {
    content.textContent = "";
    appendDecorated(content, raw);
    appendEolCell(content, ending || "", false);
    ensureSelectionPad(content);
  } else {
    content.textContent = raw;
    appendEolCell(content, ending || "", false);
    ensureSelectionPad(content);
  }
}

// Fast equal-row builders used by gap expand (gap.rows are always type "equal").
function buildSbsEqualRow(side, row, lazyWs) {
  const tr = getSbsEqualRowProto().cloneNode(true);
  const hasText = side === "left" ? row.leftNum !== null : row.rightNum !== null;
  const num = side === "left" ? row.leftNum : row.rightNum;
  const text = side === "left" ? row.leftText : row.rightText;
  const ending = side === "left" ? row.leftEnding : row.rightEnding;
  tr.dataset.hasText = hasText ? "true" : "false";
  if (hasText) tr.dataset.ending = ending || "";
  else delete tr.dataset.ending;
  tr.children[0].textContent = hasText && num !== null && num !== undefined ? String(num) : "";
  const textCell = tr.children[2];
  textCell.className = hasText
    ? side === "left" ? "text left" : "text right"
    : side === "left" ? "text empty left" : "text empty right";
  fillGapTextContent(textCell.firstChild, hasText ? text : "", hasText ? ending : "", lazyWs);
  return tr;
}

function buildSbsEqualRowPair(row, lazyWs) {
  const left = buildSbsEqualRow("left", row, lazyWs);
  // Structural clone; retarget right pane classes / numbers. Text only rewritten
  // when ignore-whitespace made the lines equal but the raw strings differ.
  const right = left.cloneNode(true);
  const rightHas = row.rightNum !== null;
  right.dataset.hasText = rightHas ? "true" : "false";
  if (rightHas) right.dataset.ending = row.rightEnding || "";
  else delete right.dataset.ending;
  right.children[0].textContent =
    rightHas && row.rightNum !== null && row.rightNum !== undefined ? String(row.rightNum) : "";
  const textCell = right.children[2];
  textCell.className = rightHas ? "text right" : "text empty right";
  if (!rightHas || row.leftText !== row.rightText || row.leftEnding !== row.rightEnding) {
    const content = textCell.firstChild;
    content.textContent = "";
    delete content.dataset.selPad;
    delete content.dataset.wsPending;
    delete content.dataset.wsEnding;
    fillGapTextContent(content, rightHas ? row.rightText : "", rightHas ? row.rightEnding : "", lazyWs);
  } else if (lazyWs && showWhitespace) {
    // Cloned node is already queued via left's content identity? No — clone is a
    // separate node that copied dataset.wsPending; re-queue it.
    const content = textCell.firstChild;
    if (content.dataset.wsPending === "1") enqueueWsDecorate(content, content.dataset.wsEnding || "");
  }
  return { left, right };
}

function buildUnifiedEqualRow(row, lazyWs) {
  const tr = getUnifiedEqualRowProto().cloneNode(true);
  tr.children[0].textContent = row.leftNum === null || row.leftNum === undefined ? "" : String(row.leftNum);
  tr.children[1].textContent = row.rightNum === null || row.rightNum === undefined ? "" : String(row.rightNum);
  fillGapTextContent(tr.children[3].firstChild, row.leftText, row.leftEnding || "", lazyWs);
  return tr;
}

function clearRowSelectionDecor(tr) {
  const content = tr.querySelector && tr.querySelector(".text-content");
  if (content) content.classList.remove("ws-line-selected");
}

function requeuePendingWsInFragment(frag) {
  if (!showWhitespace || !frag || !frag.querySelectorAll) return;
  for (const content of frag.querySelectorAll(".text-content[data-ws-pending='1']")) {
    enqueueWsDecorate(content, content.dataset.wsEnding || "");
  }
}

function gapToggleLabel(count, isExpanded) {
  const noun = count === 1 ? "line" : "lines";
  return isExpanded
    ? `\u22EF ${count} unchanged ${noun} (click to hide) \u22EF`
    : `\u22EF ${count} unchanged ${noun} \u22EF`;
}

function sideBySideGapRow(row) {
  const tr = el("tr", "gap");
  const cell = td("", gapToggleLabel(row.count, !!row.expanded));
  cell.colSpan = 3;
  if (row.gapIndex != null) {
    tr.dataset.gapIndex = row.gapIndex;
    tr.dataset.expanded = row.expanded ? "true" : "false";
    tr.classList.add("gap-toggle");
  }
  tr.appendChild(cell);
  return tr;
}

function sideBySideContentRow(side, row) {
  const tr = el("tr", row.type);
  if (side === "left") {
    const hasText = row.leftNum !== null;
    const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).left : null;
    tr.dataset.hasText = hasText ? "true" : "false";
    if (hasText) tr.dataset.ending = row.leftEnding || "";
    tr.appendChild(td("num", hasText ? row.leftNum : ""));
    tr.appendChild(td(hasText ? "sign left" : "sign", hasText && (row.type === "delete" || row.type === "replace") ? "-" : ""));
    tr.appendChild(textTd(hasText ? "text left" : "text empty left", hasText ? row.leftText : "", hasText ? row.leftEnding : "", segments, eolDiffers(row)));
  } else {
    const hasText = row.rightNum !== null;
    const segments = row.type === "replace" ? characterSegments(row.leftText, row.rightText).right : null;
    tr.dataset.hasText = hasText ? "true" : "false";
    if (hasText) tr.dataset.ending = row.rightEnding || "";
    tr.appendChild(td("num", hasText ? row.rightNum : ""));
    tr.appendChild(td(hasText ? "sign right" : "sign", hasText && (row.type === "insert" || row.type === "replace") ? "+" : ""));
    tr.appendChild(textTd(hasText ? "text right" : "text empty right", hasText ? row.rightText : "", hasText ? row.rightEnding : "", segments, eolDiffers(row)));
  }
  return tr;
}

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
      body.appendChild(row.type === "gap" ? sideBySideGapRow(row) : sideBySideContentRow(side, row));
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
  scroll._sochaFile = file;
  scroll.addEventListener("copy", (event) => copyDiffSelection(event, scroll, file));
  return scroll;
}

function unifiedRow(type, leftNum, rightNum, sign, text, ending, segments, eolChanged) {
  const tr = el("tr", type);
  tr.appendChild(td("num", leftNum === null ? "" : leftNum));
  tr.appendChild(td("num", rightNum === null ? "" : rightNum));
  tr.appendChild(td("sign", sign));
  tr.appendChild(textTd("text", text, ending, segments, eolChanged));
  return tr;
}

function unifiedGapRow(row) {
  const tr = el("tr", "gap");
  const cell = td("", gapToggleLabel(row.count, !!row.expanded));
  cell.colSpan = 4;
  if (row.gapIndex != null) {
    tr.dataset.gapIndex = row.gapIndex;
    tr.dataset.expanded = row.expanded ? "true" : "false";
    tr.classList.add("gap-toggle");
  }
  tr.appendChild(cell);
  return tr;
}

// Append one model row's <tr>s (replace → two rows) into a fragment or tbody.
function appendUnifiedModelRow(parent, row) {
  if (row.type === "equal") {
    parent.appendChild(unifiedRow("equal", row.leftNum, row.rightNum, "", row.leftText, row.leftEnding));
  } else if (row.type === "delete") {
    parent.appendChild(unifiedRow("delete", row.leftNum, null, "-", row.leftText, row.leftEnding));
  } else if (row.type === "insert") {
    parent.appendChild(unifiedRow("insert", null, row.rightNum, "+", row.rightText, row.rightEnding));
  } else if (row.type === "replace") {
    const segments = characterSegments(row.leftText, row.rightText);
    const eolChanged = eolDiffers(row);
    parent.appendChild(unifiedRow("delete", row.leftNum, null, "-", row.leftText, row.leftEnding, segments.left, eolChanged));
    parent.appendChild(unifiedRow("insert", null, row.rightNum, "+", row.rightText, row.rightEnding, segments.right, eolChanged));
  }
}

function renderUnified(rows, file) {
  const table = el("table", "diff-table unified-diff");
  const body = el("tbody");
  for (const row of rows) {
    if (row.type === "gap") body.appendChild(unifiedGapRow(row));
    else appendUnifiedModelRow(body, row);
  }
  table.appendChild(body);
  const scroll = el("div", "diff-scroll");
  scroll.appendChild(table);
  scroll._sochaFile = file;
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
  // Mutable pan-scroll state kept across gap toggles so we don't tear down
  // scrollbars / listeners on every expand-collapse.
  let panBars = [];
  let scrollGroups = [];
  let scrollGroupMembers = [];
  let panMaxScrolls = [];
  let panMaxColumns = [];
  let panGrowthRafs = [];
  let isSideBySide = false;
  // Direct references keep a gap click O(gap): resolving the marker in each
  // pane must not query through every row in a large file.
  const gapRowsByIndex = new Map();

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

  function refreshScrollGroups() {
    if (isSideBySide) {
      scrollGroups = [
        Array.from(details.querySelectorAll(".text.left > .text-content")),
        Array.from(details.querySelectorAll(".text.right > .text-content")),
      ];
    } else {
      scrollGroups = [Array.from(details.querySelectorAll(".text-content"))];
    }
    scrollGroupMembers = scrollGroups.map((group) => new WeakSet(group));
    panMaxScrolls = scrollGroups.map(() => 0);
    panMaxColumns = scrollGroups.map(() => 0);
  }

  function displayColumns(content) {
    const text = lineTextFromContent(content);
    let columns = 0;
    for (const char of text) columns = char === "\t" ? columns + (8 - (columns % 8)) : columns + 1;
    return columns;
  }

  // Register only newly inserted gap rows. The initial whole-file groups are
  // built once by render(); toggles extend them without querying the file.
  function registerPanContents(frag, sideIndex) {
    const added = [];
    if (!frag || !frag.querySelectorAll) return added;
    const group = scrollGroups[sideIndex] || (scrollGroups[sideIndex] = []);
    const members = scrollGroupMembers[sideIndex] || (scrollGroupMembers[sideIndex] = new WeakSet());
    for (const content of frag.querySelectorAll(".text-content")) {
      added.push(content);
      if (!members.has(content)) {
        members.add(content);
        group.push(content);
      }
    }
    return added;
  }

  function sizePanScrolls() {
    pruneScrollGroups();
    panBars.forEach((panScroll, index) => {
      const textContents = scrollGroups[index] || [];
      let maxScroll = 0;
      let maxColumns = 0;
      for (const textContent of textContents) {
        if (!textContent.isConnected) continue;
        maxScroll = Math.max(maxScroll, textContent.scrollWidth - textContent.clientWidth);
        maxColumns = Math.max(maxColumns, displayColumns(textContent));
      }
      panMaxScrolls[index] = maxScroll;
      panMaxColumns[index] = maxColumns;
      if (isSideBySide) panScroll.hidden = maxScroll <= 0;
      panScroll.firstElementChild.style.width = `${maxScroll + panScroll.clientWidth}px`;
    });
  }

  // Drop detached .text-content nodes so pan scroll / resize never walks a
  // whole-file list of stale nodes after collapse (O(file) transform/scrollWidth).
  function pruneScrollGroups() {
    scrollGroups = scrollGroups.map((group) => {
      const next = [];
      for (const content of group || []) {
        if (content && content.isConnected) next.push(content);
      }
      return next;
    });
    scrollGroupMembers = scrollGroups.map((group) => new WeakSet(group));
  }

  function cancelPanGrowthRafs() {
    for (const id of panGrowthRafs) cancelAnimationFrame(id);
    panGrowthRafs = [];
  }

  // A small gap almost never changes horizontal overflow. Compare its lines to
  // the longest line already measured; only a new longest line gets a bounded
  // post-paint measurement. Collapse deliberately keeps the prior maximum.
  // Never rescans the whole file's scrollWidth.
  function schedulePanGrowth(addedGroups) {
    cancelPanGrowthRafs();
    addedGroups.forEach((contents, index) => {
      let newMaxColumns = panMaxColumns[index] || 0;
      const candidates = [];
      for (const content of contents) {
        const columns = displayColumns(content);
        if (columns > newMaxColumns) {
          newMaxColumns = columns;
          candidates.length = 0;
          candidates.push(content);
        } else if (columns === newMaxColumns && columns > (panMaxColumns[index] || 0)) {
          candidates.push(content);
        }
      }
      if (!candidates.length) return;
      panMaxColumns[index] = newMaxColumns;
      const raf = requestAnimationFrame(() => {
        panGrowthRafs = panGrowthRafs.filter((id) => id !== raf);
        const panScroll = panBars[index];
        if (!panScroll) return;
        let maxScroll = panMaxScrolls[index] || 0;
        for (const content of candidates) {
          if (content.isConnected) {
            maxScroll = Math.max(maxScroll, content.scrollWidth - content.clientWidth);
          }
        }
        panMaxScrolls[index] = maxScroll;
        if (isSideBySide) panScroll.hidden = maxScroll <= 0;
        panScroll.firstElementChild.style.width = `${maxScroll + panScroll.clientWidth}px`;
      });
      panGrowthRafs.push(raf);
    });
  }

  // Incremental expand/collapse: splice only the gap's rows into each pane
  // tbody instead of rebuilding the whole file body. Aggressive path:
  // prototype-cloned equal rows, left→right structural clone, detach-to-cache
  // on collapse (re-expand is a move), lazy whitespace decorate after paint,
  // and deferred pan remeasure (no sync scrollWidth scan of the whole file).
  const gapDomCache = new Map();

  function detachFollowingRows(gapTr, count) {
    const frag = document.createDocumentFragment();
    let left = count;
    while (left-- > 0 && gapTr.nextElementSibling) {
      const row = gapTr.nextElementSibling;
      clearRowSelectionDecor(row);
      frag.appendChild(row);
    }
    return frag;
  }

  function applyPanToFragmentRows(frag, sideIndex) {
    const offset = (panBars[sideIndex] && panBars[sideIndex].scrollLeft) || 0;
    if (!offset) return;
    for (const tr of frag.childNodes) {
      if (tr.nodeType !== 1) continue;
      const content = tr.querySelector && tr.querySelector(".text-content");
      if (content) content.style.transform = `translateX(-${offset}px)`;
    }
  }

  function rememberGapRow(gapIndex, side, gapTr) {
    const entry = gapRowsByIndex.get(gapIndex) || {};
    entry[side || "unified"] = gapTr;
    gapRowsByIndex.set(gapIndex, entry);
  }

  function toggleGapInPlace(gapIndex, clickedGapTr) {
    const gapModel = file.rows[gapIndex];
    if (!gapModel || gapModel.type !== "gap" || !Array.isArray(gapModel.rows)) return false;
    const scroll = details.querySelector(":scope > .diff-scroll");
    if (!scroll) return false;

    const willExpand = !expanded.has(gapIndex);
    const gapMeta = { type: "gap", count: gapModel.count, gapIndex, expanded: willExpand };
    const hidden = gapModel.rows;
    const lazyWs = showWhitespace && hidden.length > 12;

    // The clicked marker is authoritative; its peer comes from the registry
    // populated at render time and maintained by each incremental replacement.
    if (clickedGapTr) {
      const clickedSide = isSideBySide
        ? clickedGapTr.closest(".right-pane") ? "right" : "left"
        : null;
      rememberGapRow(gapIndex, clickedSide, clickedGapTr);
    }
    const entry = gapRowsByIndex.get(gapIndex) || {};
    const targets = isSideBySide
      ? ["left", "right"].map((side) => ({ side, gapTr: entry[side] }))
      : [{ side: null, gapTr: entry.unified }];
    if (targets.some(({ gapTr }) => !gapTr || !gapTr.isConnected || !scroll.contains(gapTr))) return false;
    const addedPanContents = scrollGroups.map(() => []);

    if (willExpand) expanded.add(gapIndex);
    else expanded.delete(gapIndex);

    if (willExpand) {
      const cached = gapDomCache.get(gapIndex);
      if (cached && isSideBySide && cached.left && cached.right) {
        const leftFrag = document.createDocumentFragment();
        const rightFrag = document.createDocumentFragment();
        const leftGap = sideBySideGapRow(gapMeta);
        const rightGap = sideBySideGapRow(gapMeta);
        leftFrag.appendChild(leftGap);
        rightFrag.appendChild(rightGap);
        leftFrag.appendChild(cached.left);
        rightFrag.appendChild(cached.right);
        requeuePendingWsInFragment(leftFrag);
        requeuePendingWsInFragment(rightFrag);
        applyPanToFragmentRows(leftFrag, 0);
        applyPanToFragmentRows(rightFrag, 1);
        addedPanContents[0].push(...registerPanContents(leftFrag, 0));
        addedPanContents[1].push(...registerPanContents(rightFrag, 1));
        targets[0].gapTr.replaceWith(leftFrag);
        targets[1].gapTr.replaceWith(rightFrag);
        rememberGapRow(gapIndex, "left", leftGap);
        rememberGapRow(gapIndex, "right", rightGap);
        gapDomCache.delete(gapIndex);
      } else if (cached && !isSideBySide && cached.unified) {
        const frag = document.createDocumentFragment();
        const unifiedGap = unifiedGapRow(gapMeta);
        frag.appendChild(unifiedGap);
        frag.appendChild(cached.unified);
        requeuePendingWsInFragment(frag);
        applyPanToFragmentRows(frag, 0);
        addedPanContents[0].push(...registerPanContents(frag, 0));
        targets[0].gapTr.replaceWith(frag);
        rememberGapRow(gapIndex, null, unifiedGap);
        gapDomCache.delete(gapIndex);
      } else if (isSideBySide) {
        const leftFrag = document.createDocumentFragment();
        const rightFrag = document.createDocumentFragment();
        const leftGap = sideBySideGapRow(gapMeta);
        const rightGap = sideBySideGapRow(gapMeta);
        leftFrag.appendChild(leftGap);
        rightFrag.appendChild(rightGap);
        for (const row of hidden) {
          if (row.type === "equal") {
            const pair = buildSbsEqualRowPair(row, lazyWs);
            leftFrag.appendChild(pair.left);
            rightFrag.appendChild(pair.right);
          } else {
            leftFrag.appendChild(sideBySideContentRow("left", row));
            rightFrag.appendChild(sideBySideContentRow("right", row));
          }
        }
        applyPanToFragmentRows(leftFrag, 0);
        applyPanToFragmentRows(rightFrag, 1);
        addedPanContents[0].push(...registerPanContents(leftFrag, 0));
        addedPanContents[1].push(...registerPanContents(rightFrag, 1));
        targets[0].gapTr.replaceWith(leftFrag);
        targets[1].gapTr.replaceWith(rightFrag);
        rememberGapRow(gapIndex, "left", leftGap);
        rememberGapRow(gapIndex, "right", rightGap);
      } else {
        const frag = document.createDocumentFragment();
        const unifiedGap = unifiedGapRow(gapMeta);
        frag.appendChild(unifiedGap);
        for (const row of hidden) {
          if (row.type === "equal") frag.appendChild(buildUnifiedEqualRow(row, lazyWs));
          else appendUnifiedModelRow(frag, row);
        }
        applyPanToFragmentRows(frag, 0);
        addedPanContents[0].push(...registerPanContents(frag, 0));
        targets[0].gapTr.replaceWith(frag);
        rememberGapRow(gapIndex, null, unifiedGap);
      }
    } else {
      // Detach expanded rows into a cache instead of destroying them so a
      // later re-expand is only a DOM move (+ fresh gap marker).
      const stash = {};
      for (const { side, gapTr } of targets) {
        const detached = detachFollowingRows(gapTr, hidden.length);
        if (side === "left") stash.left = detached;
        else if (side === "right") stash.right = detached;
        else stash.unified = detached;
        const collapsedGap = side ? sideBySideGapRow(gapMeta) : unifiedGapRow(gapMeta);
        gapTr.replaceWith(collapsedGap);
        rememberGapRow(gapIndex, side, collapsedGap);
      }
      gapDomCache.set(gapIndex, stash);
    }

    proximityGapIndices.delete(gapIndex);
    if (!willExpand) {
      cancelPanGrowthRafs();
      pruneScrollGroups();
    } else {
      schedulePanGrowth(addedPanContents);
    }
    return true;
  }

  function render() {
    gapRowsByIndex.clear();
    gapDomCache.clear();
    cancelPanGrowthRafs();
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
    isSideBySide = diffTable.classList.contains("side-by-side");
    for (const gapTr of scroll.querySelectorAll("tr.gap-toggle[data-gap-index]")) {
      const gapIndex = Number(gapTr.dataset.gapIndex);
      if (Number.isNaN(gapIndex)) continue;
      const side = isSideBySide ? (gapTr.closest(".right-pane") ? "right" : "left") : null;
      rememberGapRow(gapIndex, side, gapTr);
    }
    const panScrolls = el(
      "div",
      isSideBySide ? "diff-pan-scrolls side-by-side" : "diff-pan-scrolls unified"
    );
    refreshScrollGroups();
    panBars = [];

    scrollGroups.forEach((_, index) => {
      const panScroll = el("div", "diff-pan-scroll");
      const panContent = el("div", "diff-pan-content");
      panScroll.appendChild(panContent);
      panScrolls.appendChild(panScroll);
      panBars.push(panScroll);

      panScroll.addEventListener("scroll", () => {
        const offset = panScroll.scrollLeft;
        const group = scrollGroups[index] || [];
        for (let i = 0; i < group.length; i++) {
          const textContent = group[i];
          if (!textContent.isConnected) continue;
          textContent.style.transform = offset ? `translateX(-${offset}px)` : "";
        }
      });
    });

    details.appendChild(panScrolls);

    requestAnimationFrame(sizePanScrolls);
    currentResize = sizePanScrolls;
    window.addEventListener("resize", sizePanScrolls);
    resizeHandlers.push(sizePanScrolls);

    scroll.addEventListener("click", (event) => {
      // Shift+click extends/arms selection (see mousedown); do not toggle expand.
      if (event.shiftKey) return;
      const gapRow = event.target.closest("tr.gap-toggle[data-gap-index]");
      if (!gapRow || !scroll.contains(gapRow)) return;
      const gapIndex = Number(gapRow.dataset.gapIndex);
      if (Number.isNaN(gapIndex)) return;
      if (!toggleGapInPlace(gapIndex, gapRow)) {
        // DOM targets missing — flip Set and full-rebuild as a safe fallback.
        if (expanded.has(gapIndex)) expanded.delete(gapIndex);
        else expanded.add(gapIndex);
        render();
      }
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

// ---------- folder path validation ----------
// Mirrors server.js normalizeFolderPath: trim whitespace and one matching pair
// of surrounding quotes, as pasted by Windows "Copy as path".
function normalizeFolderInput(value) {
  let folder = String(value || "").trim();
  if (folder.length >= 2 && (folder[0] === '"' || folder[0] === "'") && folder[folder.length - 1] === folder[0]) {
    folder = folder.slice(1, -1).trim();
  }
  return folder;
}

function setPathState(input, state, message) {
  const status = document.getElementById(`${input.id}-status`);
  input.classList.toggle("path-invalid", state === "invalid");
  input.classList.toggle("path-valid", state === "valid");
  if (state === "invalid") input.setAttribute("aria-invalid", "true");
  else input.removeAttribute("aria-invalid");
  if (status) status.textContent = state === "invalid" ? message : "";
}

// Advisory only: never blocks Compare. A per-input token drops responses that
// arrive after the value changed or a newer check started.
function setupPathValidation(input) {
  let token = 0;
  input.addEventListener("input", () => {
    token++;
    setPathState(input, "none");
  });
  input.addEventListener("blur", async () => {
    const folder = normalizeFolderInput(input.value);
    const myToken = ++token;
    if (!folder) {
      setPathState(input, "none");
      return;
    }
    let data;
    try {
      const res = await fetch(`/api/dir-exists?path=${encodeURIComponent(folder)}`);
      if (!res.ok) return;
      data = await res.json();
    } catch {
      return;
    }
    if (myToken !== token || normalizeFolderInput(input.value) !== folder) return;
    if (data.error) setPathState(input, "invalid", data.error === "EACCES" ? "Access denied" : "Folder not accessible");
    else if (!data.exists) setPathState(input, "invalid", "Folder not found");
    else if (!data.isDirectory) setPathState(input, "invalid", "Not a folder");
    else setPathState(input, "valid");
  });
}

setupPathValidation(document.getElementById("folderA"));
setupPathValidation(document.getElementById("folderB"));

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

