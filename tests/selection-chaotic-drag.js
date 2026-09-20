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
      const textPt = await centerOfRow(page, "left", firstText, FILE);
      const gapPt = await centerOfRow(page, "left", topGap, FILE);
      await chaoticDrag(page, [
        textPt,
        { x: textPt.x + 6, y: textPt.y },
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
