"use strict";

/**
 * Chaotic drag-path coverage for Socha Diff side-by-side selection UX.
 *
 * Run:  npm run test:selection
 * Needs: Playwright Chromium (`npx playwright install chromium`)
 *
 * Soft-exits 0 with install instructions when browsers are missing.
 * Starts `node server.js` on an ephemeral port for the run.
 */

const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SEL_A = path.join(ROOT, "sample", "sel-a");
const SEL_B = path.join(ROOT, "sample", "sel-b");
const BLANK_A = path.join(ROOT, "sample", "blank-a");
const BLANK_B = path.join(ROOT, "sample", "blank-b");

const PASS = [];
const FAIL = [];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function assert(name, cond, detail) {
  if (cond) {
    PASS.push(name);
    log(`  ✓ ${name}`);
  } else {
    FAIL.push(name);
    log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Pick an unused TCP port on 127.0.0.1. */
function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on("error", reject);
  });
}

function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get({ host: "localhost", port, path: "/", timeout: 1000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error(`Server did not start on ${port}`));
        else setTimeout(tryOnce, 100);
      });
      req.on("timeout", () => {
        req.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`Server did not start on ${port}`));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

async function loadPlaywright() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    log("Playwright is not installed. Add it and download Chromium:");
    log("  npm install --save-dev playwright");
    log("  npx playwright install chromium");
    process.exit(0);
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (/Executable doesn't exist|browserType\.launch/i.test(msg)) {
      log("Playwright browsers are not installed. Soft-skipping chaotic selection tests.");
      log("Install Chromium with:");
      log("  npx playwright install chromium");
      process.exit(0);
    }
    throw err;
  }
}

async function openCompare(page, baseUrl, folderA, folderB, preferFile) {
  const url =
    `${baseUrl}/?a=${encodeURIComponent(folderA)}` +
    `&b=${encodeURIComponent(folderB)}&run=1`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector(".file-diff", { timeout: 15000 });
  await page.evaluate((fileName) => {
    const details = Array.from(document.querySelectorAll("details.file-diff"));
    for (const d of details) {
      const name = (d.querySelector(".name") || {}).textContent || "";
      if (fileName) d.open = name === fileName;
      else d.open = true;
    }
  }, preferFile || null);
  if (preferFile) {
    await page.waitForFunction(
      (fileName) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
        );
        return !!(details && details.open && details.querySelector(".select-scope .text-content"));
      },
      preferFile,
      { timeout: 10000 }
    );
  } else {
    await page.waitForSelector(".select-scope .text-content", { timeout: 10000 });
  }
  await sleep(150);
}

/** Snapshot one side of the (first open) file-diff, or a named file. */
async function paneSnapshot(page, side, fileName) {
  return page.evaluate(
    ({ paneSide, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      if (!pane) return null;
      const rows = Array.from(pane.querySelectorAll("tbody > tr"));
      const sel = window.getSelection();
      const anchorEl =
        sel && sel.anchorNode
          ? sel.anchorNode.nodeType === 1
            ? sel.anchorNode
            : sel.anchorNode.parentElement
          : null;
      return {
        selectedText: sel?.toString() || "",
        selectedInPane: !!(anchorEl && pane.contains(anchorEl) && sel && !sel.isCollapsed),
        wsMarked: rows
          .map((tr, i) => (tr.querySelector(".text-content.ws-line-selected") ? i : -1))
          .filter((i) => i >= 0),
        gapArmed: rows
          .map((tr, i) => (tr.classList.contains("gap-armed") ? i : -1))
          .filter((i) => i >= 0),
        gapIndices: rows
          .map((tr, i) => (tr.classList.contains("gap-toggle") ? i : -1))
          .filter((i) => i >= 0),
        textRowIndices: rows
          .map((tr, i) => (tr.querySelector(".text-content") ? i : -1))
          .filter((i) => i >= 0),
        blankTextRows: rows
          .map((tr, i) => {
            const tc = tr.querySelector(".text-content");
            if (!tc) return -1;
            const text = tc.dataset.selPad === "1" ? "" : tc.textContent;
            return text.trim() === "" ? i : -1;
          })
          .filter((i) => i >= 0),
        rowCount: rows.length,
      };
    },
    { paneSide: side, file: fileName || null }
  );
}

/** Within the marked span, every blank row must also be marked (no holes). */
function blankMarksHaveNoHoles(blankRows, marked) {
  if (marked.length === 0) return true;
  const lo = Math.min(...marked);
  const hi = Math.max(...marked);
  return blankRows.filter((i) => i >= lo && i <= hi).every((i) => marked.includes(i));
}

async function centerOfRow(page, side, rowIndex, fileName) {
  return page.evaluate(
    ({ paneSide, idx, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      const tr = pane && pane.querySelectorAll("tbody > tr")[idx];
      if (!tr) return null;
      const tc = tr.querySelector(".text-content") || tr.querySelector("td");
      const r = (tc || tr).getBoundingClientRect();
      return { x: r.left + Math.min(40, Math.max(8, r.width / 2)), y: (r.top + r.bottom) / 2 };
    },
    { paneSide: side, idx: rowIndex, file: fileName || null }
  );
}

/** Left or right inset of a row's .text-content (for full-line vs partial drags). */
async function edgeOfRow(page, side, rowIndex, which, fileName) {
  return page.evaluate(
    ({ paneSide, idx, edge, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      const tr = pane && pane.querySelectorAll("tbody > tr")[idx];
      if (!tr) return null;
      const tc = tr.querySelector(".text-content") || tr.querySelector("td");
      const r = (tc || tr).getBoundingClientRect();
      const x = edge === "end" ? r.left + Math.min(r.width - 4, 120) : r.left + 10;
      return { x, y: (r.top + r.bottom) / 2 };
    },
    { paneSide: side, idx: rowIndex, edge: which, file: fileName || null }
  );
}


/** Point just before the last `n` characters of a row's .text-content. */
async function pointBeforeEndChars(page, side, rowIndex, n, fileName) {
  return page.evaluate(
    ({ paneSide, idx, chars, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      const tr = pane && pane.querySelectorAll("tbody > tr")[idx];
      const tc = tr && tr.querySelector(".text-content");
      if (!tc) return null;
      const full = tc.dataset.selPad === "1" ? "" : tc.textContent || "";
      if (full.length <= chars) return null;
      const target = full.length - chars;
      // Map character offset → text node + local offset across nested spans.
      let seen = 0;
      const walker = document.createTreeWalker(tc, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node) {
        const len = node.textContent.length;
        if (seen + len >= target) {
          const local = target - seen;
          const range = document.createRange();
          range.setStart(node, local);
          range.setEnd(node, local);
          const r = range.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) {
            // Fallback: interpolate within the text-content box.
            const box = tc.getBoundingClientRect();
            const frac = target / full.length;
            return { x: box.left + Math.max(8, box.width * frac), y: (box.top + box.bottom) / 2, full };
          }
          return { x: r.left, y: (r.top + r.bottom) / 2, full };
        }
        seen += len;
        node = walker.nextNode();
      }
      return null;
    },
    { paneSide: side, idx: rowIndex, chars: n, file: fileName || null }
  );
}

/**
 * Invariant for proximity-armed gaps: never .gap-armed while the gating
 * neighbor .text-content is a mid-line partial (isPartialTextContentSelection).
 * Also reports whether the neighbor is fully covered (boundary compare).
 */
async function gapNeighborInvariant(page, side, gapRowIndex, neighborRowIndex, fileName) {
  return page.evaluate(
    ({ paneSide, gapIdx, neighborIdx, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      if (!pane) return null;
      const rows = Array.from(pane.querySelectorAll("tbody > tr"));
      const gapTr = rows[gapIdx];
      const neighborTr = rows[neighborIdx];
      const tc = neighborTr && neighborTr.querySelector(".text-content");
      const sel = window.getSelection();
      const gapArmed = !!(gapTr && gapTr.classList.contains("gap-armed"));
      let neighborPartial = false;
      let neighborFullySelected = false;
      if (sel && tc && !sel.isCollapsed && sel.rangeCount) {
        const anchorEl =
          sel.anchorNode &&
          (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
        const focusEl =
          sel.focusNode &&
          (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
        const full = tc.dataset.selPad === "1" ? "" : tc.textContent || "";
        if (
          anchorEl &&
          focusEl &&
          (tc.contains(anchorEl) || tc === anchorEl) &&
          (tc.contains(focusEl) || tc === focusEl) &&
          !sel.containsNode(tc, false) &&
          full !== "" &&
          sel.toString() !== full
        ) {
          neighborPartial = true;
        }
        try {
          const contentRange = document.createRange();
          contentRange.selectNodeContents(tc);
          const selRange = sel.getRangeAt(0);
          if (selRange.intersectsNode(tc)) {
            const startOK = selRange.compareBoundaryPoints(Range.START_TO_START, contentRange) <= 0;
            const endOK = selRange.compareBoundaryPoints(Range.END_TO_END, contentRange) >= 0;
            neighborFullySelected = !neighborPartial && startOK && endOK;
          }
        } catch {
          neighborFullySelected = false;
        }
        if (sel.containsNode(tc, false)) neighborFullySelected = true;
      }
      return {
        gapArmed,
        neighborPartial,
        neighborFullySelected,
        selectedText: sel ? sel.toString() : "",
        invariantOk: !(gapArmed && neighborPartial),
      };
    },
    {
      paneSide: side,
      gapIdx: gapRowIndex,
      neighborIdx: neighborRowIndex,
      file: fileName || null,
    }
  );
}

/** Center of the line-number gutter cell for a row (falls back to sign). */
async function centerOfGutter(page, side, rowIndex, fileName) {
  return page.evaluate(
    ({ paneSide, idx, file }) => {
      let root = document;
      if (file) {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        root = details;
      } else {
        const open = document.querySelector("details.file-diff[open]") || document.querySelector("details.file-diff");
        if (open) root = open;
      }
      const pane = root.querySelector(
        paneSide === "right" ? ".right-pane.select-scope" : ".left-pane.select-scope"
      );
      const tr = pane && pane.querySelectorAll("tbody > tr")[idx];
      if (!tr) return null;
      const cell = tr.querySelector("td.num") || tr.querySelector("td.sign");
      if (!cell) return null;
      const r = cell.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: (r.top + r.bottom) / 2 };
    },
    { paneSide: side, idx: rowIndex, file: fileName || null }
  );
}

/** Drag along a polyline of {x,y} points (first = down, last = up). */
async function chaoticDrag(page, points, stepsPerSeg = 8) {
  if (!points.length) return;
  await page.mouse.move(points[0].x, points[0].y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    await page.mouse.move(p.x, p.y, { steps: stepsPerSeg });
    await sleep(16);
  }
  await page.mouse.up();
  await sleep(100);
}

async function copySelectionText(page) {
  // Prefer the app's copy handler via a real ClipboardEvent on the focused scroll.
  const viaEvent = await page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return "";
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const scroll = el && el.closest(".diff-scroll");
    if (!scroll) return null;
    let captured = null;
    const dt = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
    // Chromium may ignore constructor clipboardData; patch if needed.
    if (!event.clipboardData) {
      Object.defineProperty(event, "clipboardData", { value: dt });
    }
    scroll.dispatchEvent(event);
    captured = (event.clipboardData && event.clipboardData.getData("text/plain")) || dt.getData("text/plain");
    return captured;
  });
  if (viaEvent != null && viaEvent !== "") return viaEvent;

  // Fallback: Ctrl+C + async clipboard read (permissions granted on context).
  try {
    await page.keyboard.press("Control+c");
    await sleep(50);
    return await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch {
        return window.getSelection()?.toString() || "";
      }
    });
  } catch {
    return await page.evaluate(() => window.getSelection()?.toString() || "");
  }
}

function clearNativeSelection(page) {
  return page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    // Click inert page chrome to reset selectionScope / proximityGapIndices.
    const header = document.querySelector(".app-header") || document.body;
    const r = header.getBoundingClientRect();
    header.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 0 })
    );
    header.dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 0 })
    );
    window.getSelection()?.removeAllRanges();
  });
}

async function runScenario(name, fn) {
  log(`\n▸ ${name}`);
  try {
    await fn();
  } catch (err) {
    assert(`${name} (threw)`, false, err && err.stack ? err.stack.split("\n")[0] : String(err));
  }
}

async function main() {
  log("Socha Diff — chaotic selection drag coverage");
  log(`Fixtures: sel=${SEL_A} / blank=${BLANK_A}`);

  const browser = await loadPlaywright();
  const port = await getEphemeralPort();
  const baseUrl = `http://localhost:${port}`;

  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const shutdown = async () => {
    try {
      server.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    try {
      await browser.close();
    } catch {
      /* ignore */
    }
  };

  try {
    await waitForServer(port);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();

    // ── sel-a / sel-b: gaps + reverse + weave + cross-pane ──────────────
    await openCompare(page, baseUrl, SEL_A, SEL_B, "big.txt");

    const fileCount = await page.locator(".file-diff").count();
    assert("sel fixtures rendered at least one file-diff", fileCount >= 1, `count=${fileCount}`);

    let left = await paneSnapshot(page, "left", "big.txt");
    assert("left pane present with rows", !!(left && left.rowCount > 0), JSON.stringify(left));
    assert("sel fixture exposes collapsed gaps", left.gapIndices.length >= 1, `gaps=${left.gapIndices}`);
    assert("sel fixture exposes text rows", left.textRowIndices.length >= 3, `text=${left.textRowIndices}`);

    const textRows = left.textRowIndices;
    const gaps = left.gapIndices;
    const firstText = textRows[0];
    const midText = textRows[Math.floor(textRows.length / 2)];
    const lastText = textRows[textRows.length - 1];
    const topGap = gaps.find((g) => g < firstText);
    const bottomGap = gaps.find((g) => g > lastText);
    const FILE = "big.txt";

    await runScenario("single-pane forward drag (no cross-pane bleed)", async () => {
      await clearNativeSelection(page);
      const a = await centerOfRow(page, "left", firstText, FILE);
      const b = await centerOfRow(page, "left", lastText, FILE);
      const mid = await centerOfRow(page, "left", midText, FILE);
      await chaoticDrag(page, [
        a,
        { x: a.x + 18, y: (a.y + mid.y) / 2 },
        { x: mid.x - 12, y: mid.y },
        { x: b.x + 8, y: b.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      const right = await paneSnapshot(page, "right", FILE);
      assert("selection anchored in left pane", left.selectedInPane, left.selectedText.slice(0, 40));
      assert(
        "right pane has no ws-line-selected bleed",
        right.wsMarked.length === 0,
        `right marks=${right.wsMarked}`
      );
      assert(
        "right pane has no gap-armed bleed",
        right.gapArmed.length === 0,
        `right armed=${right.gapArmed}`
      );
      assert(
        "left blank marks have no holes in span",
        blankMarksHaveNoHoles(left.blankTextRows, left.wsMarked),
        `marks=${left.wsMarked}`
      );
    });

    await runScenario("reverse drag (bottom → top)", async () => {
      await clearNativeSelection(page);
      const start = await centerOfRow(page, "left", lastText, FILE);
      const end = await centerOfRow(page, "left", firstText, FILE);
      await chaoticDrag(page, [
        start,
        { x: start.x + 22, y: (start.y + end.y) / 2 },
        { x: end.x - 10, y: end.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      const right = await paneSnapshot(page, "right", FILE);
      assert("reverse drag keeps selection in left", left.selectedInPane);
      assert("reverse drag does not bleed to right", right.wsMarked.length === 0 && right.gapArmed.length === 0);
      const copied = await copySelectionText(page);
      assert(
        "reverse drag copy includes CHANGED A",
        /CHANGED A/.test(copied) || /CHANGED A/.test(left.selectedText),
        `copy=${JSON.stringify((copied || left.selectedText).slice(0, 120))}`
      );
      assert(
        "reverse drag copy stays single-pane (no CHANGED B)",
        !/CHANGED B/.test(copied || "")
      );
    });

    await runScenario("gap arm when pointer crosses adjacent collapsed gap", async () => {
      if (topGap == null) {
        assert("top gap present for arm scenario", false, "no top gap");
        return;
      }
      await clearNativeSelection(page);
      // Start near the end of the adjacent line so dragging onto the leading gap
      // covers the whole line (gap arming requires a full-line neighbor).
      const textPt = await edgeOfRow(page, "left", firstText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      await chaoticDrag(page, [
        textPt,
        { x: textPt.x - 8, y: textPt.y },
        { x: gapPt.x, y: gapPt.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "adjacent gap becomes gap-armed",
        left.gapArmed.includes(topGap),
        `armed=${left.gapArmed} expected ${topGap}`
      );
      const right = await paneSnapshot(page, "right", FILE);
      assert("gap arm stays single-pane", right.gapArmed.length === 0);
      // Sticky proximity arm must survive mouseup so Copy pulls hidden gap.rows
      // (lines 1–6 in sel-a) even though the gap itself is user-select:none.
      const copied = await copySelectionText(page);
      assert(
        "armed-gap copy includes hidden line 1",
        /line 1/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );
      assert(
        "armed-gap copy includes hidden line 6",
        /line 6/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );
      assert(
        "armed-gap copy stays single-pane (no CHANGED B)",
        !/CHANGED B/.test(copied || "")
      );
    });

    await runScenario("gap no-arm when drag stays on interior text only", async () => {
      const interior = textRows.filter((i) => i !== firstText && i !== lastText);
      if (interior.length < 2) {
        assert("enough interior text rows", false, `interior=${interior}`);
        return;
      }
      await clearNativeSelection(page);
      const a = await centerOfRow(page, "left", interior[0], FILE);
      const b = await centerOfRow(page, "left", interior[interior.length - 1], FILE);
      await chaoticDrag(page, [a, { x: a.x + 10, y: (a.y + b.y) / 2 }, b]);
      left = await paneSnapshot(page, "left", FILE);
      const edgeArmed = left.gapArmed.filter((i) => i === topGap || i === bottomGap);
      assert(
        "edge gaps stay unarmed without pointer proximity",
        edgeArmed.length === 0,
        `armed=${left.gapArmed}`
      );
    });

    await runScenario("partial neighbor does not arm trailing gap", async () => {
      const botGap = gaps.find((g) => g > lastText);
      assert("trailing gap present for partial no-arm", botGap != null, `gaps=${gaps}`);
      if (botGap == null) return;
      await clearNativeSelection(page);
      // Anchor mid-line (before the last 2 chars) then drag onto the trailing
      // gap. Extending into the gap still leaves the line prefix unselected, so
      // the neighbor is not fully selected — must NOT arm.
      // (Anchoring at the start then dragging to the gap would cover the rest of
      // the line and correctly arm; that is not a partial-neighbor case.)
      const mid = await pointBeforeEndChars(page, "left", lastText, 2, FILE);
      const gapPt = await centerOfRow(page, "left", botGap, FILE);
      assert("partial+gap points", !!(mid && gapPt), JSON.stringify({ mid, gapPt }));
      if (!mid || !gapPt) return;
      await chaoticDrag(page, [
        mid,
        { x: mid.x + 6, y: mid.y },
        { x: gapPt.x, y: gapPt.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "trailing gap stays unarmed on partial neighbor",
        !left.gapArmed.includes(botGap),
        `armed=${left.gapArmed} selected=${JSON.stringify((left.selectedText || "").slice(0, 80))}`
      );
    });

    await runScenario("full last line without gap pointer does not arm", async () => {
      const botGap = gaps.find((g) => g > lastText);
      assert("trailing gap present for full-line no-arm", botGap != null, `gaps=${gaps}`);
      if (botGap == null) return;
      await clearNativeSelection(page);
      const start = await edgeOfRow(page, "left", lastText, "start", FILE);
      const end = await edgeOfRow(page, "left", lastText, "end", FILE);
      assert("full-line points", !!(start && end), JSON.stringify({ start, end }));
      if (!start || !end) return;
      // Stay on the text row — never enter the gap hit zone.
      await chaoticDrag(page, [start, { x: (start.x + end.x) / 2, y: start.y }, end]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "trailing gap stays unarmed when pointer never hits it",
        !left.gapArmed.includes(botGap),
        `armed=${left.gapArmed} selected=${JSON.stringify((left.selectedText || "").slice(0, 80))}`
      );
    });

    await runScenario("full last line plus gap pointer arms trailing gap", async () => {
      const botGap = gaps.find((g) => g > lastText);
      assert("trailing gap present for full+pointer arm", botGap != null, `gaps=${gaps}`);
      if (botGap == null) return;
      await clearNativeSelection(page);
      const start = await edgeOfRow(page, "left", lastText, "start", FILE);
      const end = await edgeOfRow(page, "left", lastText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", botGap, FILE);
      assert("full+gap points", !!(start && end && gapPt), JSON.stringify({ start, end, gapPt }));
      if (!start || !end || !gapPt) return;
      await chaoticDrag(page, [start, end, { x: gapPt.x, y: gapPt.y }]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "trailing gap arms when neighbor fully selected and pointer on gap",
        left.gapArmed.includes(botGap),
        `armed=${left.gapArmed} selected=${JSON.stringify((left.selectedText || "").slice(0, 80))}`
      );
      const copied = await copySelectionText(page);
      assert(
        "full+gap armed copy includes a hidden trailing line",
        /line 1[4-9]|line 20/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 160))}`
      );
    });

    await runScenario("bottom-up partial below does not arm leading gap", async () => {
      if (topGap == null) {
        assert("top gap present for bottom-up partial", false, "no top gap");
        return;
      }
      await clearNativeSelection(page);
      // Start mid-line on the text row immediately below the leading gap, then
      // drag upward onto the gap — neighbor is only partially selected, so the
      // gap must not arm (bottom-up full-line gate).
      const mid = await centerOfRow(page, "left", firstText, FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      assert("bottom-up partial points", !!(mid && gapPt), JSON.stringify({ mid, gapPt }));
      if (!mid || !gapPt) return;
      await chaoticDrag(page, [
        mid,
        { x: mid.x - 6, y: mid.y },
        { x: gapPt.x, y: gapPt.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "leading gap stays unarmed on bottom-up partial neighbor",
        !left.gapArmed.includes(topGap),
        `armed=${left.gapArmed} selected=${JSON.stringify((left.selectedText || "").slice(0, 80))}`
      );
    });

    await runScenario("bottom-up full below plus gap pointer arms leading gap", async () => {
      if (topGap == null) {
        assert("top gap present for bottom-up full arm", false, "no top gap");
        return;
      }
      await clearNativeSelection(page);
      // Select the below neighbor right-to-left (end→start) so the line is fully
      // covered, then drag upward onto the leading gap. LTR then-up onto a
      // user-select:none gap often collapses the native selection in Chromium.
      const start = await edgeOfRow(page, "left", firstText, "start", FILE);
      const end = await edgeOfRow(page, "left", firstText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      assert("bottom-up full+gap points", !!(start && end && gapPt), JSON.stringify({ start, end, gapPt }));
      if (!start || !end || !gapPt) return;
      await chaoticDrag(page, [end, start, { x: gapPt.x, y: gapPt.y }]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "leading gap arms when below neighbor fully selected and pointer on gap",
        left.gapArmed.includes(topGap),
        `armed=${left.gapArmed} selected=${JSON.stringify((left.selectedText || "").slice(0, 80))}`
      );
    });

    await runScenario("top-down mouse-off gap disarms trailing proximity arm", async () => {
      const botGap = gaps.find((g) => g > lastText);
      assert("trailing gap present for mouse-off disarm", botGap != null, `gaps=${gaps}`);
      if (botGap == null) return;
      await clearNativeSelection(page);
      // Full above neighbor → onto trailing gap (arms) → back onto the neighbor
      // in the same drag (pointer off gap). Proximity must disarm immediately
      // even if clamp left the neighbor fully selected — no sticky .gap-armed
      // after leaving the gap chrome.
      const start = await edgeOfRow(page, "left", lastText, "start", FILE);
      const end = await edgeOfRow(page, "left", lastText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", botGap, FILE);
      const backOnNeighbor = end || (await centerOfRow(page, "left", lastText, FILE));
      assert(
        "top-down mouse-off points",
        !!(start && end && gapPt && backOnNeighbor),
        JSON.stringify({ start, end, gapPt, backOnNeighbor })
      );
      if (!start || !end || !gapPt || !backOnNeighbor) return;

      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await sleep(16);
      await page.mouse.move(gapPt.x, gapPt.y, { steps: 8 });
      await sleep(30);
      let snap = await paneSnapshot(page, "left", FILE);
      assert(
        "top-down mouse-off: gap arms while pointer on gap",
        snap.gapArmed.includes(botGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );

      await page.mouse.move(backOnNeighbor.x, backOnNeighbor.y, { steps: 10 });
      await sleep(40);
      snap = await paneSnapshot(page, "left", FILE);
      assert(
        "top-down mouse-off: gap disarms when pointer leaves gap onto neighbor",
        !snap.gapArmed.includes(botGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );
      let inv = await gapNeighborInvariant(page, "left", botGap, lastText, FILE);
      assert(
        "top-down mouse-off live: never gap-armed with partial above neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );

      await page.mouse.up();
      await sleep(100);
      snap = await paneSnapshot(page, "left", FILE);
      assert(
        "top-down mouse-off mouseup: trailing gap stays unarmed",
        !snap.gapArmed.includes(botGap),
        `armed=${snap.gapArmed}`
      );
      inv = await gapNeighborInvariant(page, "left", botGap, lastText, FILE);
      assert(
        "top-down mouse-off mouseup: never gap-armed with partial above neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      const copied = await copySelectionText(page);
      assert(
        "top-down mouse-off copy excludes hidden trailing lines",
        !/line 1[4-9]|line 20/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 160))}`
      );
    });

    await runScenario("bottom-up mouse-off gap disarms leading proximity arm", async () => {
      if (topGap == null) {
        assert("top gap present for mouse-off disarm", false, "no top gap");
        return;
      }
      await clearNativeSelection(page);
      // Full below neighbor (RTL) → onto leading gap (arms) → back onto the
      // neighbor in the same drag. Proximity must disarm on pointer leave.
      const start = await edgeOfRow(page, "left", firstText, "start", FILE);
      const end = await edgeOfRow(page, "left", firstText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      const backOnNeighbor = start || (await centerOfRow(page, "left", firstText, FILE));
      assert(
        "bottom-up mouse-off points",
        !!(start && end && gapPt && backOnNeighbor),
        JSON.stringify({ start, end, gapPt, backOnNeighbor })
      );
      if (!start || !end || !gapPt || !backOnNeighbor) return;

      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y, { steps: 8 });
      await sleep(16);
      await page.mouse.move(gapPt.x, gapPt.y, { steps: 8 });
      await sleep(30);
      let snap = await paneSnapshot(page, "left", FILE);
      assert(
        "bottom-up mouse-off: gap arms while pointer on gap",
        snap.gapArmed.includes(topGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );

      await page.mouse.move(backOnNeighbor.x, backOnNeighbor.y, { steps: 10 });
      await sleep(40);
      snap = await paneSnapshot(page, "left", FILE);
      assert(
        "bottom-up mouse-off: gap disarms when pointer leaves gap onto neighbor",
        !snap.gapArmed.includes(topGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );
      let inv = await gapNeighborInvariant(page, "left", topGap, firstText, FILE);
      assert(
        "bottom-up mouse-off live: never gap-armed with partial below neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );

      await page.mouse.up();
      await sleep(100);
      snap = await paneSnapshot(page, "left", FILE);
      assert(
        "bottom-up mouse-off mouseup: leading gap stays unarmed",
        !snap.gapArmed.includes(topGap),
        `armed=${snap.gapArmed}`
      );
      inv = await gapNeighborInvariant(page, "left", topGap, firstText, FILE);
      assert(
        "bottom-up mouse-off mouseup: never gap-armed with partial below neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      const copied = await copySelectionText(page);
      assert(
        "bottom-up mouse-off copy excludes hidden line 1",
        !/line 1/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );
    });

    await runScenario("top-down retreat never arms gap with partial above neighbor", async () => {
      const botGap = gaps.find((g) => g > lastText);
      assert("trailing gap present for top-down retreat", botGap != null, `gaps=${gaps}`);
      if (botGap == null) return;
      await clearNativeSelection(page);
      // Full line above the trailing gap → onto gap (arms) → peel trailing chars
      // on that above line (like unselecting "16"). Invariant: never .gap-armed
      // while the neighbor is a mid-line partial — either disarm or re-extend.
      const start = await edgeOfRow(page, "left", lastText, "start", FILE);
      const end = await edgeOfRow(page, "left", lastText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", botGap, FILE);
      const peel = await pointBeforeEndChars(page, "left", lastText, 2, FILE);
      const partial = start && { x: start.x + 16, y: start.y };
      assert(
        "top-down retreat points",
        !!(start && end && gapPt && (peel || partial)),
        JSON.stringify({ start, end, gapPt, peel, partial })
      );
      if (!start || !end || !gapPt || !(peel || partial)) return;
      const retreat = peel || partial;

      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(end.x, end.y, { steps: 8 });
      await sleep(16);
      await page.mouse.move(gapPt.x, gapPt.y, { steps: 8 });
      await sleep(30);
      let snap = await paneSnapshot(page, "left", FILE);
      assert(
        "top-down: gap arms when pointer on gap with full above neighbor",
        snap.gapArmed.includes(botGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );

      await page.mouse.move(retreat.x, retreat.y, { steps: 10 });
      await sleep(40);
      let inv = await gapNeighborInvariant(page, "left", botGap, lastText, FILE);
      assert(
        "top-down live: never gap-armed with partial above neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      assert(
        "top-down live: armed ⇒ neighbor fully selected (or disarmed)",
        inv && (!inv.gapArmed || inv.neighborFullySelected),
        `inv=${JSON.stringify(inv)}`
      );

      await page.mouse.up();
      await sleep(100);
      inv = await gapNeighborInvariant(page, "left", botGap, lastText, FILE);
      assert(
        "top-down mouseup: never gap-armed with partial above neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      assert(
        "top-down mouseup: armed ⇒ neighbor fully selected (or disarmed)",
        inv && (!inv.gapArmed || inv.neighborFullySelected),
        `inv=${JSON.stringify(inv)}`
      );
      // If disarmed, copy must not pull hidden trailing gap lines; if still
      // armed, neighbor must be full so copy may include them.
      if (inv && !inv.gapArmed) {
        const copied = await copySelectionText(page);
        assert(
          "top-down disarmed copy excludes hidden trailing lines",
          !/line 1[4-9]|line 20/.test(copied || ""),
          `copy=${JSON.stringify((copied || "").slice(0, 160))}`
        );
      }
    });

    await runScenario("bottom-up retreat never arms gap with partial below neighbor", async () => {
      if (topGap == null) {
        assert("top gap present for bottom-up retreat", false, "no top gap");
        return;
      }
      await clearNativeSelection(page);
      // Full line below the leading gap → onto gap (arms) → peel so neighbor is
      // only a prefix/suffix. Invariant: never .gap-armed + partial neighbor.
      // RTL (end→start) then up onto the gap — same path as the arm scenario;
      // LTR then-up onto user-select:none often collapses native selection.
      const start = await edgeOfRow(page, "left", firstText, "start", FILE);
      const end = await edgeOfRow(page, "left", firstText, "end", FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      // Peel leading chars off the end-anchored selection (suffix shrinks).
      const peel = end && { x: end.x - 20, y: end.y };
      assert(
        "bottom-up retreat points",
        !!(start && end && peel && gapPt),
        JSON.stringify({ start, end, peel, gapPt })
      );
      if (!start || !end || !peel || !gapPt) return;

      await page.mouse.move(end.x, end.y);
      await page.mouse.down();
      await page.mouse.move(start.x, start.y, { steps: 8 });
      await sleep(16);
      await page.mouse.move(gapPt.x, gapPt.y, { steps: 8 });
      await sleep(30);
      let snap = await paneSnapshot(page, "left", FILE);
      assert(
        "bottom-up: gap arms when pointer on gap with full below neighbor",
        snap.gapArmed.includes(topGap),
        `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 80))}`
      );

      await page.mouse.move(peel.x, peel.y, { steps: 10 });
      await sleep(40);
      let inv = await gapNeighborInvariant(page, "left", topGap, firstText, FILE);
      assert(
        "bottom-up live: never gap-armed with partial below neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      assert(
        "bottom-up live: armed ⇒ neighbor fully selected (or disarmed)",
        inv && (!inv.gapArmed || inv.neighborFullySelected),
        `inv=${JSON.stringify(inv)}`
      );

      await page.mouse.up();
      await sleep(100);
      inv = await gapNeighborInvariant(page, "left", topGap, firstText, FILE);
      assert(
        "bottom-up mouseup: never gap-armed with partial below neighbor",
        inv && inv.invariantOk,
        `inv=${JSON.stringify(inv)}`
      );
      assert(
        "bottom-up mouseup: armed ⇒ neighbor fully selected (or disarmed)",
        inv && (!inv.gapArmed || inv.neighborFullySelected),
        `inv=${JSON.stringify(inv)}`
      );
      if (inv && !inv.gapArmed) {
        const copied = await copySelectionText(page);
        assert(
          "bottom-up disarmed copy excludes hidden line 1",
          !/line 1/.test(copied || ""),
          `copy=${JSON.stringify((copied || "").slice(0, 120))}`
        );
      }
    });

    await runScenario("weave toward opposite pane still clamps to start pane", async () => {
      await clearNativeSelection(page);
      const leftStart = await centerOfRow(page, "left", firstText, FILE);
      const leftEnd = await centerOfRow(page, "left", lastText, FILE);
      const rightMid = await centerOfRow(page, "right", midText, FILE);
      // Mid-drag: enter the opposite pane and assert select-inert + no native
      // focus there before completing the path (proves proactive inert, not
      // only post-mouseup clamp cleanup).
      await page.mouse.move(leftStart.x, leftStart.y);
      await page.mouse.down();
      await page.mouse.move(leftStart.x + 30, (leftStart.y + leftEnd.y) / 2, { steps: 6 });
      await page.mouse.move(rightMid.x, rightMid.y, { steps: 10 });
      await sleep(30);
      const midDrag = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        const leftPane = details.querySelector(".left-pane.select-scope");
        const rightPane = details.querySelector(".right-pane.select-scope");
        const sel = window.getSelection();
        let focusInRight = false;
        let anchorInRight = false;
        if (sel && sel.rangeCount && !sel.isCollapsed) {
          const focusEl =
            sel.focusNode &&
            (sel.focusNode.nodeType === 1 ? sel.focusNode : sel.focusNode.parentElement);
          const anchorEl =
            sel.anchorNode &&
            (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement);
          focusInRight = !!(focusEl && rightPane.contains(focusEl));
          anchorInRight = !!(anchorEl && rightPane.contains(anchorEl));
        }
        return {
          rightInert: rightPane.classList.contains("select-inert"),
          leftInert: leftPane.classList.contains("select-inert"),
          focusInRight,
          anchorInRight,
          rightWs: rightPane.querySelectorAll(".ws-line-selected").length,
        };
      }, FILE);
      assert("mid-drag opposite pane is select-inert", !!(midDrag && midDrag.rightInert), JSON.stringify(midDrag));
      assert("mid-drag active pane is not select-inert", !!(midDrag && !midDrag.leftInert), JSON.stringify(midDrag));
      assert(
        "mid-drag native selection not in opposite pane",
        !!(midDrag && !midDrag.focusInRight && !midDrag.anchorInRight),
        JSON.stringify(midDrag)
      );
      assert("mid-drag no right ws-line-selected", !!(midDrag && midDrag.rightWs === 0), JSON.stringify(midDrag));
      await page.mouse.move(leftEnd.x, leftEnd.y, { steps: 8 });
      await page.mouse.up();
      await sleep(100);
      left = await paneSnapshot(page, "left", FILE);
      const right = await paneSnapshot(page, "right", FILE);
      assert(
        "weave ends with left-pane selection",
        left.selectedInPane || left.wsMarked.length > 0 || left.gapArmed.length > 0
      );
      assert(
        "weave does not mark right pane",
        right.wsMarked.length === 0 && right.gapArmed.length === 0,
        `right ws=${right.wsMarked} gap=${right.gapArmed}`
      );
      const rightCleared = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        const rightPane = details && details.querySelector(".right-pane.select-scope");
        return rightPane ? !rightPane.classList.contains("select-inert") : false;
      }, FILE);
      assert("mouseup clears select-inert on opposite pane", rightCleared);
      const copied = await copySelectionText(page);
      if (copied) {
        assert("weave copy has no right-pane CHANGED B", !/CHANGED B/.test(copied), `copy=${copied.slice(0, 80)}`);
      }
    });

    await runScenario("pointercancel clears select-inert without mouseup", async () => {
      await clearNativeSelection(page);
      const leftStart = await centerOfRow(page, "left", firstText, FILE);
      const leftEnd = await centerOfRow(page, "left", lastText, FILE);
      await page.mouse.move(leftStart.x, leftStart.y);
      await page.mouse.down();
      await page.mouse.move(leftStart.x + 12, (leftStart.y + leftEnd.y) / 2, { steps: 6 });
      await sleep(20);
      const mid = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        const rightPane = details && details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          dragSelecting: document.body.classList.contains("drag-selecting"),
        };
      }, FILE);
      assert("pre-cancel opposite pane is select-inert", !!(mid && mid.rightInert && mid.dragSelecting), JSON.stringify(mid));
      // Cancel without mouseup (touch/stylus / WebView2).
      await page.evaluate(() => {
        document.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, cancelable: true }));
      });
      await sleep(40);
      const after = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        const rightPane = details && details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          inertCount: document.querySelectorAll(".select-inert").length,
          dragSelecting: document.body.classList.contains("drag-selecting"),
          rightUserSelect: rightPane
            ? getComputedStyle(rightPane.querySelector(".text-content") || rightPane).userSelect
            : null,
        };
      }, FILE);
      assert(
        "pointercancel clears select-inert",
        !!(after && !after.rightInert && after.inertCount === 0 && !after.dragSelecting),
        JSON.stringify(after)
      );
      assert(
        "pointercancel restores opposite pane user-select",
        !!(after && after.rightUserSelect && after.rightUserSelect !== "none"),
        JSON.stringify(after)
      );
      // Swallow any lingering button state so later scenarios start clean.
      await page.mouse.up().catch(() => {});
      await sleep(30);
    });

    await runScenario("contextmenu without mouseup clears select-inert", async () => {
      await clearNativeSelection(page);
      const leftStart = await centerOfRow(page, "left", firstText, FILE);
      const leftEnd = await centerOfRow(page, "left", lastText, FILE);
      await page.mouse.move(leftStart.x, leftStart.y);
      await page.mouse.down();
      await page.mouse.move(leftStart.x + 12, (leftStart.y + leftEnd.y) / 2, { steps: 6 });
      await sleep(20);
      const mid = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        const rightPane = details && details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          dragSelecting: document.body.classList.contains("drag-selecting"),
        };
      }, FILE);
      assert("pre-contextmenu opposite pane is select-inert", !!(mid && mid.rightInert && mid.dragSelecting), JSON.stringify(mid));
      // Fire contextmenu and intentionally omit mouseup (Windows / WebView2).
      await page.evaluate(({ x, y }) => {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.dispatchEvent(
            new MouseEvent("contextmenu", {
              bubbles: true,
              cancelable: true,
              clientX: x,
              clientY: y,
              button: 2,
            })
          );
        }
      }, { x: leftStart.x + 12, y: (leftStart.y + leftEnd.y) / 2 });
      await sleep(40);
      const after = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        const rightPane = details && details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          inertCount: document.querySelectorAll(".select-inert").length,
          dragSelecting: document.body.classList.contains("drag-selecting"),
          rightUserSelect: rightPane
            ? getComputedStyle(rightPane.querySelector(".text-content") || rightPane).userSelect
            : null,
        };
      }, FILE);
      assert(
        "contextmenu clears select-inert without mouseup",
        !!(after && !after.rightInert && after.inertCount === 0 && !after.dragSelecting),
        JSON.stringify(after)
      );
      assert(
        "contextmenu restores opposite pane user-select",
        !!(after && after.rightUserSelect && after.rightUserSelect !== "none"),
        JSON.stringify(after)
      );
      await page.mouse.up().catch(() => {});
      await sleep(30);
    });

    await runScenario("window blur clears select-inert without mouseup", async () => {
      await clearNativeSelection(page);
      const leftStart = await centerOfRow(page, "left", firstText, FILE);
      const rightMid = await centerOfRow(page, "right", midText, FILE);
      await page.mouse.move(leftStart.x, leftStart.y);
      await page.mouse.down();
      await page.mouse.move(rightMid.x, rightMid.y, { steps: 10 });
      await sleep(30);
      const mid = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        const rightPane = details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          dragSelecting: document.documentElement.classList.contains("drag-selecting"),
        };
      }, FILE);
      assert("pre-blur opposite pane is select-inert", !!(mid && mid.rightInert && mid.dragSelecting), JSON.stringify(mid));

      // Synthetic window blur (alt-tab / WebView2 focus loss) — same handler as
      // the real blur event; mouseup may never arrive.
      await page.evaluate(() => {
        window.dispatchEvent(new Event("blur"));
      });
      await sleep(30);
      const after = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return null;
        const rightPane = details.querySelector(".right-pane.select-scope");
        return {
          rightInert: !!(rightPane && rightPane.classList.contains("select-inert")),
          inertCount: document.querySelectorAll(".select-inert").length,
          dragSelecting: document.documentElement.classList.contains("drag-selecting"),
          rightUserSelect: rightPane
            ? getComputedStyle(rightPane.querySelector(".text-content") || rightPane).userSelect
            : null,
        };
      }, FILE);
      assert(
        "blur clears select-inert",
        !!(after && !after.rightInert && after.inertCount === 0 && !after.dragSelecting),
        JSON.stringify(after)
      );
      assert(
        "blur restores opposite pane user-select",
        !!(after && after.rightUserSelect && after.rightUserSelect !== "none"),
        JSON.stringify(after)
      );
      await page.mouse.up().catch(() => {});
      await sleep(30);
    });

    await runScenario("whole-pane contextmenu copy includes collapsed gaps", async () => {
      await clearNativeSelection(page);
      const textPt = await centerOfRow(page, "left", firstText, FILE);
      // Right-click selects the whole pane (A) so Copy includes collapsed gap lines.
      await page.mouse.click(textPt.x, textPt.y, { button: "right" });
      await sleep(50);
      const copied = await copySelectionText(page);
      assert(
        "whole-pane copy includes leading collapsed line 1",
        /line 1/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );
      assert(
        "whole-pane copy includes trailing collapsed line 20",
        /line 20/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(-80))}`
      );
      assert(
        "whole-pane copy includes CHANGED A",
        /CHANGED A/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 160))}`
      );
      assert(
        "whole-pane copy stays single-pane (no CHANGED B)",
        !/CHANGED B/.test(copied || "")
      );
      // Dismiss any native menu side-effects for later scenarios.
      await page.keyboard.press("Escape").catch(() => {});
      await page.mouse.click(5, 5).catch(() => {});
      await sleep(30);
    });

    // Chromium triple-click selects a line but often paints the next row's
    // gutters and parks focus at offset 0 of the next .text-content. Copy must
    // not pull that neighboring line in (selectedRowRange ignores gutter-only hits).
    await runScenario("triple-click line copy does not include next row", async () => {
      await clearNativeSelection(page);
      const line7Idx = await page.evaluate((fileName) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
        );
        const rows = Array.from(details.querySelectorAll(".left-pane tbody > tr"));
        return rows.findIndex((tr) => {
          const tc = tr.querySelector(".text-content");
          return tc && tc.textContent.trim() === "line 7";
        });
      }, FILE);
      assert("line 7 row present for triple-click", line7Idx >= 0, `idx=${line7Idx}`);
      if (line7Idx < 0) return;
      const pt = await centerOfRow(page, "left", line7Idx, FILE);
      await page.mouse.click(pt.x, pt.y, { clickCount: 3 });
      await sleep(50);
      const copied = await copySelectionText(page);
      const text = copied || "";
      assert(
        "triple-click copy includes line 7",
        /^line 7\r?\n?$/.test(text) || text.trim() === "line 7",
        `copy=${JSON.stringify(text)}`
      );
      assert(
        "triple-click copy excludes line 8",
        !/line 8/.test(text),
        `copy=${JSON.stringify(text)}`
      );
      assert(
        "triple-click copy has no gutter leakage",
        !/^\d+\t/m.test(text) && !/unchanged lines/.test(text),
        `copy=${JSON.stringify(text)}`
      );
      await clearNativeSelection(page);
    });

    // Double-click / partial drag inside one .text-content must copy the
    // selected word/chars, not expand to the full rebuilt line (multi-row
    // copy still joins whole lines). Caret-only must not invent a line.
    await runScenario("partial single-row copy stays verbatim", async () => {
      await clearNativeSelection(page);
      const wordBox = await page.evaluate((fileName) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
        );
        const tc = Array.from(details.querySelectorAll(".left-pane .text-content")).find((el) =>
          el.textContent.includes("CHANGED")
        );
        if (!tc) return null;
        const walker = document.createTreeWalker(tc, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const idx = node.textContent.indexOf("CHANGED");
          if (idx < 0) continue;
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + "CHANGED".length);
          const r = range.getBoundingClientRect();
          return {
            x: (r.left + r.right) / 2,
            y: (r.top + r.bottom) / 2,
            left: r.left,
            right: r.right,
          };
        }
        return null;
      }, FILE);
      assert("CHANGED word box present", !!wordBox, JSON.stringify(wordBox));
      if (!wordBox) return;

      await page.mouse.click(wordBox.x, wordBox.y, { clickCount: 2 });
      await sleep(50);
      let native = await page.evaluate(() => window.getSelection()?.toString() || "");
      let copied = await copySelectionText(page);
      assert(
        "double-click native selects CHANGED",
        native === "CHANGED",
        `native=${JSON.stringify(native)}`
      );
      assert(
        "double-click copy is just CHANGED (not full line)",
        copied === "CHANGED",
        `copy=${JSON.stringify(copied)}`
      );
      assert(
        "double-click copy excludes neighbor tokens",
        !/line 10/.test(copied || "") && !/CHANGED B/.test(copied || ""),
        `copy=${JSON.stringify(copied)}`
      );

      await clearNativeSelection(page);
      await page.mouse.move(wordBox.left + 1, wordBox.y);
      await page.mouse.down();
      await page.mouse.move(wordBox.right - 1, wordBox.y, { steps: 6 });
      await page.mouse.up();
      await sleep(50);
      native = await page.evaluate(() => window.getSelection()?.toString() || "");
      copied = await copySelectionText(page);
      assert(
        "partial drag native is CHANGED",
        native === "CHANGED",
        `native=${JSON.stringify(native)}`
      );
      assert(
        "partial drag copy stays verbatim",
        copied === "CHANGED",
        `copy=${JSON.stringify(copied)}`
      );

      // Caret-only: handler must not preventDefault with a synthetic full line.
      await clearNativeSelection(page);
      const caretPt = await centerOfRow(page, "left", firstText, FILE);
      await page.mouse.click(caretPt.x, caretPt.y);
      await sleep(40);
      const caretResult = await page.evaluate(() => {
        const sel = window.getSelection();
        if (!sel || !sel.rangeCount) return { collapsed: true, copy: "", prevented: false };
        const node = sel.anchorNode;
        const el = node && (node.nodeType === 1 ? node : node.parentElement);
        const scroll = el && el.closest(".diff-scroll");
        if (!scroll) return { collapsed: sel.isCollapsed, copy: "", prevented: false };
        const dt = new DataTransfer();
        const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
        if (!event.clipboardData) Object.defineProperty(event, "clipboardData", { value: dt });
        scroll.dispatchEvent(event);
        return {
          collapsed: sel.isCollapsed,
          copy: (event.clipboardData && event.clipboardData.getData("text/plain")) || dt.getData("text/plain") || "",
          prevented: event.defaultPrevented,
        };
      });
      assert("caret click is collapsed", caretResult.collapsed, JSON.stringify(caretResult));
      assert(
        "caret copy does not synthesize a line",
        !caretResult.prevented && caretResult.copy === "",
        JSON.stringify(caretResult)
      );
      await clearNativeSelection(page);
    });


    await runScenario("drag near pane edge stays in-scope", async () => {
      await clearNativeSelection(page);
      const a = await centerOfRow(page, "left", firstText, FILE);
      const b = await centerOfRow(page, "left", lastText, FILE);
      const edgeX = await page.evaluate(() => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === "big.txt"
        );
        const pane = details.querySelector(".left-pane.select-scope");
        const r = pane.getBoundingClientRect();
        return r.right - 8;
      });
      await chaoticDrag(page, [
        a,
        { x: edgeX, y: (a.y + b.y) / 2 },
        { x: b.x, y: b.y },
      ]);
      left = await paneSnapshot(page, "left", FILE);
      const right = await paneSnapshot(page, "right", FILE);
      assert("edge skim selection remains left", left.selectedInPane || /line /.test(left.selectedText));
      assert("edge skim no right bleed", right.wsMarked.length === 0 && right.gapArmed.length === 0);
    });

    // Line-number / sign gutters are user-select:none; dragging them must still
    // synthesize whole-line selection + clean copy (no gutter digits / signs).
    await runScenario("gutter drag selects whole lines and copies cleanly", async () => {
      await clearNativeSelection(page);
      const startIdx = firstText;
      const endIdx = textRows.find((i) => i > startIdx && i !== startIdx) ?? midText;
      const g0 = await centerOfGutter(page, "left", startIdx, FILE);
      const g1 = await centerOfGutter(page, "left", endIdx, FILE);
      assert("gutter start cell present", !!(g0 && g0.x), JSON.stringify(g0));
      assert("gutter end cell present", !!(g1 && g1.x), JSON.stringify(g1));
      if (!g0 || !g1) return;
      await chaoticDrag(page, [g0, { x: g0.x, y: (g0.y + g1.y) / 2 }, g1]);
      left = await paneSnapshot(page, "left", FILE);
      const right = await paneSnapshot(page, "right", FILE);
      assert(
        "gutter drag keeps selection in left pane",
        left.selectedInPane || /line /.test(left.selectedText),
        left.selectedText.slice(0, 60)
      );
      assert(
        "gutter drag no right-pane bleed",
        right.wsMarked.length === 0 && right.gapArmed.length === 0,
        `right ws=${right.wsMarked} armed=${right.gapArmed}`
      );
      const copied = await copySelectionText(page);
      const text = copied || "";
      assert(
        "gutter drag copy includes first visible line",
        /line 7/.test(text),
        `copy=${JSON.stringify(text.slice(0, 120))}`
      );
      assert(
        "gutter drag copy has no gutter leakage",
        !/^\d+\t/m.test(text) && !/unchanged lines/.test(text) && !/CHANGED B/.test(text),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      await clearNativeSelection(page);
    });

    await runScenario("Shift+gutter click extends whole-line selection", async () => {
      await clearNativeSelection(page);
      const startIdx = firstText;
      const endIdx = midText;
      const g0 = await centerOfGutter(page, "left", startIdx, FILE);
      const g1 = await centerOfGutter(page, "left", endIdx, FILE);
      assert("shift gutter cells present", !!(g0 && g1), JSON.stringify({ g0, g1 }));
      if (!g0 || !g1) return;
      await page.mouse.click(g0.x, g0.y);
      await sleep(40);
      await page.keyboard.down("Shift");
      await page.mouse.click(g1.x, g1.y);
      await page.keyboard.up("Shift");
      await sleep(50);
      const copied = await copySelectionText(page);
      const text = copied || "";
      assert(
        "shift+gutter copy includes start line",
        /line 7/.test(text),
        `copy=${JSON.stringify(text.slice(0, 120))}`
      );
      assert(
        "shift+gutter copy includes mid span",
        text.split(/\r?\n/).filter(Boolean).length >= 2,
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert(
        "shift+gutter copy has no gutter leakage",
        !/^\d+\t/m.test(text) && !/CHANGED B/.test(text),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      await clearNativeSelection(page);
    });

    await runScenario("gutter drag onto adjacent gap arms collapsed lines", async () => {
      await clearNativeSelection(page);
      const topGap = gaps.find((g) => g < firstText);
      assert("leading gap present for gutter arm", topGap != null, `gaps=${gaps}`);
      if (topGap == null) return;
      const gText = await centerOfGutter(page, "left", firstText, FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      assert("gutter+gap points present", !!(gText && gapPt), JSON.stringify({ gText, gapPt }));
      if (!gText || !gapPt) return;
      await chaoticDrag(page, [gText, { x: gText.x, y: (gText.y + gapPt.y) / 2 }, gapPt]);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "gutter-to-gap arms leading gap",
        left.gapArmed.includes(topGap),
        `armed=${left.gapArmed} expected ${topGap}`
      );
      const copied = await copySelectionText(page);
      const text = copied || "";
      assert(
        "gutter-armed copy includes hidden line 1",
        /line 1/.test(text),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert(
        "gutter-armed copy stays single-pane",
        !/CHANGED B/.test(text)
      );
      await clearNativeSelection(page);
    });

    await runScenario("Shift+click collapsed gap extends and arms (no expand)", async () => {
      await clearNativeSelection(page);
      const topGap = gaps.find((g) => g < firstText);
      const botGap = gaps.find((g) => g > textRows[textRows.length - 1]);
      assert("leading+trailing gaps for shift-click", topGap != null && botGap != null, `gaps=${gaps}`);
      if (topGap == null || botGap == null) return;

      const firstPt = await centerOfRow(page, "left", firstText, FILE);
      const leadGapPt = await centerOfRow(page, "left", topGap, FILE);
      assert("shift-gap points present", !!(firstPt && leadGapPt), JSON.stringify({ firstPt, leadGapPt }));
      if (!firstPt || !leadGapPt) return;

      await page.mouse.click(firstPt.x, firstPt.y);
      await sleep(40);
      await page.keyboard.down("Shift");
      await page.mouse.click(leadGapPt.x, leadGapPt.y);
      await page.keyboard.up("Shift");
      await sleep(50);

      left = await paneSnapshot(page, "left", FILE);
      assert(
        "shift+gap arms leading gap",
        left.gapArmed.includes(topGap),
        `armed=${left.gapArmed} expected ${topGap}`
      );
      const stillCollapsed = await page.evaluate((fileName) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
        );
        const pane = details && details.querySelector(".left-pane.select-scope");
        const gaps = pane ? Array.from(pane.querySelectorAll("tr.gap-toggle")) : [];
        return gaps.every((tr) => tr.dataset.expanded !== "true");
      }, FILE);
      assert("shift+gap does not expand gaps", stillCollapsed);

      let copied = await copySelectionText(page);
      let text = copied || "";
      const leadLines = text.split(/\r?\n/).filter(Boolean);
      assert(
        "shift+leading-gap copy includes hidden line 1",
        leadLines.includes("line 1"),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert(
        "shift+leading-gap copy includes visible line 7",
        leadLines.includes("line 7"),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert("shift+leading-gap copy stays single-pane", !/CHANGED B/.test(text));

      // Trailing gap from last visible text row (avoids whole-pane fullSideText).
      await clearNativeSelection(page);
      const lastText = textRows[textRows.length - 1];
      const lastPt = await centerOfRow(page, "left", lastText, FILE);
      const trailGapPt = await centerOfRow(page, "left", botGap, FILE);
      await page.mouse.click(lastPt.x, lastPt.y);
      await sleep(40);
      await page.keyboard.down("Shift");
      await page.mouse.click(trailGapPt.x, trailGapPt.y);
      await page.keyboard.up("Shift");
      await sleep(50);
      left = await paneSnapshot(page, "left", FILE);
      assert(
        "shift+gap arms trailing gap",
        left.gapArmed.includes(botGap),
        `armed=${left.gapArmed} expected ${botGap}`
      );
      copied = await copySelectionText(page);
      text = copied || "";
      const trailLines = text.split(/\r?\n/).filter(Boolean);
      assert(
        "shift+trailing-gap copy includes line 20",
        trailLines.includes("line 20"),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert(
        "shift+trailing-gap copy keeps last visible line",
        trailLines.includes("line 13"),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      assert(
        "shift+trailing-gap copy excludes earlier visible line 7",
        !trailLines.includes("line 7"),
        `copy=${JSON.stringify(text.slice(0, 160))}`
      );
      await clearNativeSelection(page);
    });

    await runScenario("Shift+text click keeps drag anchor for later Shift+gutter", async () => {
      await clearNativeSelection(page);
      const early = textRows[0];
      const mid = textRows[Math.min(2, textRows.length - 1)];
      const later = textRows[Math.min(4, textRows.length - 1)];
      assert(
        "shift-text-anchor rows distinct",
        early != null && mid != null && later != null && early < mid && mid < later,
        JSON.stringify({ early, mid, later, textRows })
      );
      if (early == null || mid == null || later == null || !(early < mid && mid < later)) return;

      const earlyPt = await centerOfRow(page, "left", early, FILE);
      const midPt = await centerOfRow(page, "left", mid, FILE);
      const laterPt = await centerOfRow(page, "left", later, FILE);
      const midGutter = await centerOfGutter(page, "left", mid, FILE);
      const laterGutter = await centerOfGutter(page, "left", later, FILE);
      assert(
        "shift-text-anchor points present",
        !!(earlyPt && midPt && laterPt && midGutter && laterGutter)
      );
      if (!earlyPt || !midPt || !laterPt || !midGutter || !laterGutter) return;

      // Drag early → mid (dragAnchor = early).
      await chaoticDrag(page, [earlyPt, midPt]);
      await sleep(40);

      // Shift+click later text extends native selection; must NOT rewrite dragAnchor
      // to `later` (that previously made Shift+gutter mid drop `early`).
      await page.keyboard.down("Shift");
      await page.mouse.click(laterPt.x, laterPt.y);
      await page.keyboard.up("Shift");
      await sleep(50);

      await page.keyboard.down("Shift");
      await page.mouse.click(midGutter.x, midGutter.y);
      await page.keyboard.up("Shift");
      await sleep(50);

      // Rect-based check: old bug set dragAnchor=later, so Shift+gutter mid
      // selected only mid..later and dropped early.
      const midShrink = await page.evaluate(
        ({ fileName, earlyIdx, midIdx }) => {
          const details = Array.from(document.querySelectorAll("details.file-diff")).find(
            (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
          );
          const pane = details && details.querySelector(".left-pane.select-scope");
          if (!pane) return { early: false, mid: false };
          const rows = Array.from(pane.querySelectorAll("tbody > tr"));
          const sel = window.getSelection();
          const rects = sel.rangeCount ? Array.from(sel.getRangeAt(0).getClientRects()) : [];
          const hit = (idx) => {
            const tc = rows[idx] && rows[idx].querySelector(".text-content");
            if (!tc) return false;
            const box = tc.getBoundingClientRect();
            return rects.some(
              (r) =>
                r.height > 0 &&
                r.bottom > box.top + 1 &&
                r.top < box.bottom - 1 &&
                r.right > box.left + 1 &&
                r.left < box.right - 1
            );
          };
          return { early: hit(earlyIdx), mid: hit(midIdx), text: (sel.toString() || "").slice(0, 160) };
        },
        { fileName: FILE, earlyIdx: early, midIdx: mid }
      );
      assert(
        "after Shift+text then Shift+gutter mid, early row stays selected",
        midShrink.early,
        JSON.stringify(midShrink)
      );
      assert(
        "after Shift+text then Shift+gutter mid, mid row stays selected",
        midShrink.mid,
        JSON.stringify(midShrink)
      );

      // Re-extend to later via Shift+gutter: full early→later span with preserved anchor.
      await page.keyboard.down("Shift");
      await page.mouse.click(laterGutter.x, laterGutter.y);
      await page.keyboard.up("Shift");
      await sleep(50);
      const fullSpan = await page.evaluate(
        ({ fileName, earlyIdx, laterIdx }) => {
          const details = Array.from(document.querySelectorAll("details.file-diff")).find(
            (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
          );
          const pane = details && details.querySelector(".left-pane.select-scope");
          if (!pane) return { early: false, later: false };
          const rows = Array.from(pane.querySelectorAll("tbody > tr"));
          const sel = window.getSelection();
          const rects = sel.rangeCount ? Array.from(sel.getRangeAt(0).getClientRects()) : [];
          const hit = (idx) => {
            const tc = rows[idx] && rows[idx].querySelector(".text-content");
            if (!tc) return false;
            const box = tc.getBoundingClientRect();
            return rects.some(
              (r) =>
                r.height > 0 &&
                r.bottom > box.top + 1 &&
                r.top < box.bottom - 1 &&
                r.right > box.left + 1 &&
                r.left < box.right - 1
            );
          };
          return { early: hit(earlyIdx), later: hit(laterIdx), text: (sel.toString() || "").slice(0, 200) };
        },
        { fileName: FILE, earlyIdx: early, laterIdx: later }
      );
      assert(
        "Shift+gutter later from preserved anchor keeps early row",
        fullSpan.early,
        JSON.stringify(fullSpan)
      );
      assert(
        "Shift+gutter later from preserved anchor keeps later row",
        fullSpan.later,
        JSON.stringify(fullSpan)
      );
      await clearNativeSelection(page);
    });

    await runScenario("Ctrl+A then click-drag reselections partially", async () => {
      await clearNativeSelection(page);
      const changedBox = await page.evaluate((fileName) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
        );
        const pane = details && details.querySelector(".left-pane.select-scope");
        if (!pane) return null;
        const tc = Array.from(pane.querySelectorAll(".text-content")).find((el) =>
          /CHANGED/.test(el.textContent || "")
        );
        if (!tc) return null;
        const walker = document.createTreeWalker(tc, NodeFilter.SHOW_TEXT);
        let node;
        let pos = 0;
        let startNode = null;
        let startOff = 0;
        let endNode = null;
        let endOff = 0;
        const full = tc.textContent || "";
        const i0 = full.indexOf("CHANGED");
        if (i0 < 0) return null;
        const i1 = i0 + "CHANGED".length;
        while ((node = walker.nextNode())) {
          const next = pos + node.length;
          if (!startNode && i0 >= pos && i0 < next) {
            startNode = node;
            startOff = i0 - pos;
          }
          if (!endNode && i1 > pos && i1 <= next) {
            endNode = node;
            endOff = i1 - pos;
          }
          pos = next;
        }
        if (!startNode || !endNode) return null;
        const range = document.createRange();
        range.setStart(startNode, startOff);
        range.setEnd(endNode, endOff);
        const br = range.getBoundingClientRect();
        return { left: br.left + 1, right: br.right - 1, y: br.top + br.height / 2, mid: br.left + br.width / 2 };
      }, FILE);
      assert("CHANGED word box for Ctrl+A reselection", !!changedBox, JSON.stringify(changedBox));
      if (!changedBox) return;

      await page.mouse.click(changedBox.mid, changedBox.y);
      await sleep(30);
      await page.keyboard.press("Control+a");
      await sleep(40);
      let copied = await copySelectionText(page);
      assert(
        "Ctrl+A copy is whole file first",
        /line 1/.test(copied || "") && /line 20/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );

      await page.mouse.move(changedBox.left, changedBox.y);
      await page.mouse.down();
      await page.mouse.move(changedBox.right, changedBox.y, { steps: 10 });
      await page.mouse.up();
      await sleep(50);

      const native = await page.evaluate(() => window.getSelection()?.toString() || "");
      copied = await copySelectionText(page);
      assert("after Ctrl+A drag native is CHANGED", native === "CHANGED", `native=${JSON.stringify(native)}`);
      assert(
        "after Ctrl+A drag copy is just CHANGED",
        copied === "CHANGED",
        `copy=${JSON.stringify(copied)}`
      );
      assert(
        "after Ctrl+A drag copy is not whole file",
        !/line 20/.test(copied || ""),
        `copy=${JSON.stringify((copied || "").slice(0, 120))}`
      );
      await clearNativeSelection(page);
    });


    // ── sel-a / sel-b span.txt: interior gap full-line gate (bottom-up) ──
    const SPAN_FILE = "span.txt";
    await openCompare(page, baseUrl, SEL_A, SEL_B, SPAN_FILE);
    {
      const spanLeft = await paneSnapshot(page, "left", SPAN_FILE);
      assert("span fixture present", !!(spanLeft && spanLeft.rowCount > 0), JSON.stringify(spanLeft));
      const spanGaps = (spanLeft && spanLeft.gapIndices) || [];
      const spanText = (spanLeft && spanLeft.textRowIndices) || [];
      // Interior collapsed gap: has text-row neighbors both above and below.
      const interiorGap = spanGaps.find(
        (g) => spanText.some((t) => t < g) && spanText.some((t) => t > g)
      );
      assert("span fixture exposes interior gap", interiorGap != null, `gaps=${spanGaps} text=${spanText}`);

      await runScenario("bottom-up span partial below does not arm interior gap", async () => {
        if (interiorGap == null) return;
        const below = spanText.find((t) => t > interiorGap);
        const above = [...spanText].reverse().find((t) => t < interiorGap);
        assert("interior neighbors", below != null && above != null, JSON.stringify({ above, below, interiorGap }));
        if (below == null || above == null) return;
        await clearNativeSelection(page);
        // Anchor before the last 2 chars of the below neighbor (true mid-line
        // partial), then extend upward through the gap onto the row above —
        // gap must stay unarmed because the below neighbor is never fully
        // selected. centerOfRow on short lines can sit near the start and
        // accidentally cover the whole line when extended upward.
        const midBelow = await pointBeforeEndChars(page, "left", below, 2, SPAN_FILE);
        const abovePt = await centerOfRow(page, "left", above, SPAN_FILE);
        assert("span partial points", !!(midBelow && abovePt), JSON.stringify({ midBelow, abovePt }));
        if (!midBelow || !abovePt) return;
        await chaoticDrag(page, [
          midBelow,
          { x: midBelow.x + 4, y: midBelow.y },
          { x: midBelow.x, y: (midBelow.y + abovePt.y) / 2 },
          abovePt,
        ]);
        const snap = await paneSnapshot(page, "left", SPAN_FILE);
        assert(
          "interior gap stays unarmed on bottom-up partial below",
          !snap.gapArmed.includes(interiorGap),
          `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 100))}`
        );
      });

      await runScenario("bottom-up span full neighbors may include interior gap", async () => {
        if (interiorGap == null) return;
        const below = spanText.find((t) => t > interiorGap);
        const above = [...spanText].reverse().find((t) => t < interiorGap);
        assert("interior neighbors for full span", below != null && above != null, JSON.stringify({ above, below }));
        if (below == null || above == null) return;
        await clearNativeSelection(page);
        // Gutter drag from the below neighbor up through the gap onto the above
        // neighbor selects whole lines on both sides — interior gap may arm/include.
        const gBelow = await centerOfGutter(page, "left", below, SPAN_FILE);
        const gAbove = await centerOfGutter(page, "left", above, SPAN_FILE);
        assert("span gutter points", !!(gBelow && gAbove), JSON.stringify({ gBelow, gAbove }));
        if (!gBelow || !gAbove) return;
        await chaoticDrag(page, [
          gBelow,
          { x: gBelow.x, y: (gBelow.y + gAbove.y) / 2 },
          gAbove,
        ]);
        const snap = await paneSnapshot(page, "left", SPAN_FILE);
        assert(
          "interior gap included when both neighbors fully selected",
          snap.gapArmed.includes(interiorGap),
          `armed=${snap.gapArmed} selected=${JSON.stringify((snap.selectedText || "").slice(0, 120))}`
        );
      });
    }

    // ── blank-a / blank-b: blank-row marks ───────────────────────────────
    const BLANK_FILE = "lines.txt";
    await openCompare(page, baseUrl, BLANK_A, BLANK_B, BLANK_FILE);

    await runScenario("blank-row drag marks empty lines contiguously", async () => {
      left = await paneSnapshot(page, "left", BLANK_FILE);
      assert(
        "blank fixture has blank text rows",
        !!(left && left.blankTextRows.length),
        JSON.stringify(left && left.blankTextRows)
      );
      if (!left) return;

      const startIdx = left.textRowIndices[0];
      const endIdx = left.textRowIndices[left.textRowIndices.length - 1];
      const a = await centerOfRow(page, "left", startIdx, BLANK_FILE);
      const b = await centerOfRow(page, "left", endIdx, BLANK_FILE);
      const midY = (a.y + b.y) / 2;
      await chaoticDrag(page, [
        a,
        { x: a.x + 25, y: midY - 6 },
        { x: a.x - 15, y: midY + 6 },
        { x: b.x + 10, y: b.y },
      ]);
      left = await paneSnapshot(page, "left", BLANK_FILE);
      const right = await paneSnapshot(page, "right", BLANK_FILE);
      assert(
        "blank rows received ws-line-selected",
        left.blankTextRows.some((i) => left.wsMarked.includes(i)),
        `blanks=${left.blankTextRows} marked=${left.wsMarked}`
      );
      assert(
        "blank marks have no holes in selected span",
        blankMarksHaveNoHoles(left.blankTextRows, left.wsMarked),
        `blanks=${left.blankTextRows} marks=${left.wsMarked}`
      );
      assert("blank drag no right-pane bleed", right.wsMarked.length === 0);

      const copied = await copySelectionText(page);
      const text = copied || left.selectedText || "";
      assert("blank drag copy includes alpha", /alpha/.test(text), `copy=${JSON.stringify(text.slice(0, 100))}`);
      assert("blank drag copy includes gamma", /gamma/.test(text), `copy=${JSON.stringify(text.slice(0, 100))}`);
    });

    await runScenario("blank selection paint is narrow not full-width", async () => {
      await clearNativeSelection(page);
      left = await paneSnapshot(page, "left", BLANK_FILE);
      if (!left || !left.blankTextRows.length) {
        assert("blank rows for narrow paint", false, JSON.stringify(left));
        return;
      }
      const blanks = left.blankTextRows;
      const startIdx = blanks[0];
      const endIdx = blanks.length > 1 ? blanks[1] : blanks[0];
      // Prefer two consecutive blanks when present (seam / width case).
      let aIdx = startIdx;
      let bIdx = endIdx;
      for (let i = 0; i < blanks.length - 1; i++) {
        if (blanks[i + 1] === blanks[i] + 1) {
          aIdx = blanks[i];
          bIdx = blanks[i + 1];
          break;
        }
      }
      const a = await centerOfRow(page, "left", aIdx, BLANK_FILE);
      const b = await centerOfRow(page, "left", bIdx, BLANK_FILE);
      await chaoticDrag(page, [a, { x: a.x + 8, y: (a.y + b.y) / 2 }, b]);
      const widths = await page.evaluate((file) => {
        const details = Array.from(document.querySelectorAll("details.file-diff")).find(
          (d) => ((d.querySelector(".name") || {}).textContent || "") === file
        );
        if (!details) return [];
        const pane = details.querySelector(".left-pane.select-scope");
        return Array.from(pane.querySelectorAll(".text-content.ws-line-selected")).map((tc) => {
          const pad = tc.querySelector(".sel-pad");
          const box = (pad || tc).getBoundingClientRect();
          return {
            tcW: Math.round(tc.getBoundingClientRect().width),
            paintW: Math.round(box.width),
            hasPad: !!pad,
          };
        });
      }, BLANK_FILE);
      assert("blank ws-line-selected present for width check", widths.length > 0, JSON.stringify(widths));
      const narrow = widths.every((w) => w.paintW > 0 && w.paintW < 40);
      assert(
        "blank paint width is caret-sized (<40px)",
        narrow,
        JSON.stringify(widths)
      );
      const notFullPane = widths.every((w) => w.paintW < w.tcW / 4);
      assert(
        "blank paint is not full .text-content width",
        notFullPane,
        JSON.stringify(widths)
      );
    });

    await runScenario("right-pane-only reverse drag (no left bleed)", async () => {
      await clearNativeSelection(page);
      const rightBefore = await paneSnapshot(page, "right", BLANK_FILE);
      if (!rightBefore || rightBefore.textRowIndices.length < 2) {
        assert("right pane has text rows", false);
        return;
      }
      const rows = rightBefore.textRowIndices;
      const start = await centerOfRow(page, "right", rows[rows.length - 1], BLANK_FILE);
      const end = await centerOfRow(page, "right", rows[0], BLANK_FILE);
      await chaoticDrag(page, [
        start,
        { x: start.x - 20, y: (start.y + end.y) / 2 },
        end,
      ]);
      const right = await paneSnapshot(page, "right", BLANK_FILE);
      const leftAfter = await paneSnapshot(page, "left", BLANK_FILE);
      assert("right reverse selection in right pane", right.selectedInPane || right.wsMarked.length > 0);
      assert(
        "right reverse does not mark left",
        leftAfter.wsMarked.length === 0 && leftAfter.gapArmed.length === 0,
        `left ws=${leftAfter.wsMarked}`
      );
    });

    await context.close();
  } finally {
    await shutdown();
  }

  log("\n── summary ──");
  log(`passed: ${PASS.length}`);
  log(`failed: ${FAIL.length}`);
  if (FAIL.length) {
    log("failures:");
    for (const f of FAIL) log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    log("all chaotic selection assertions passed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
