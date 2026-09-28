"use strict";

/**
 * Line-ending coverage: differing-EOL highlight and (later) newline selection.
 *
 * Run:  npm run test:selection   (runs after selection-chaotic-drag.js)
 *       node tests/newline-selection.js
 * Needs: Playwright Chromium (`npx playwright install chromium`)
 *
 * Soft-exits 0 when Playwright or its browsers are missing. Starts
 * `node server.js` on an ephemeral port with a temporary SOCHA_DATA_DIR so
 * settings changes never touch the checkout's own settings file.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const EOL_A = path.join(ROOT, "sample", "eol-a");
const EOL_B = path.join(ROOT, "sample", "eol-b");
const SEL_A = path.join(ROOT, "sample", "sel-a");
const SEL_B = path.join(ROOT, "sample", "sel-b");

const PASS = [];
const FAIL = [];

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

function assert(name, cond, detail) {
  if (cond) {
    PASS.push(name);
    log(`  \u2713 ${name}`);
  } else {
    FAIL.push(name);
    log(`  \u2717 ${name}${detail ? ` - ${detail}` : ""}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

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

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: "localhost",
        port,
        path: urlPath,
        method,
        timeout: 5000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {},
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      await request(port, "GET", "/api/settings");
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`Server did not start on ${port}`);
      await sleep(100);
    }
  }
}

async function setIgnoreWhitespace(port, value) {
  const current = await request(port, "GET", "/api/settings");
  await request(port, "POST", "/api/settings", {
    ignoredDirectories: current.ignoredDirectories,
    ignoreWhitespace: value,
  });
}

async function openCompare(page, baseUrl, folderA, folderB, opts = {}) {
  const view = opts.view === "unified" ? "&view=unified" : "";
  await page.goto(`${baseUrl}/?a=${encodeURIComponent(folderA)}&b=${encodeURIComponent(folderB)}&run=1${view}`, {
    waitUntil: "networkidle",
  });
  await page.waitForSelector(".file-diff", { timeout: 15000 });
  const wantWs = !!opts.whitespace;
  const isWs = await page.evaluate(() => document.getElementById("whitespace-btn").getAttribute("aria-pressed") === "true");
  if (wantWs !== isWs) {
    await page.click("#whitespace-btn");
    await sleep(150);
  }
  await page.evaluate((file) => {
    for (const d of document.querySelectorAll("details.file-diff")) {
      const name = (d.querySelector(".name") || {}).textContent || "";
      d.open = !file || name === file;
    }
  }, opts.file || null);
  await page.waitForSelector("details.file-diff[open] .text-content", { timeout: 10000 });
  await sleep(150);
}

/** Per-row EOL facts for one open file: [{ left:{...}, right:{...} }] (side-by-side) or rows (unified). */
function eolFacts(page, file) {
  return page.evaluate((fileName) => {
    const details = Array.from(document.querySelectorAll("details.file-diff")).find(
      (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
    );
    if (!details) return null;
    const rowFacts = (tr) => {
      const tc = tr.querySelector(".text-content");
      const changedEol = tc ? tc.querySelector(".eol-changed") : null;
      return {
        type: tr.className.split(" ")[0],
        eolChanged: !!changedEol,
        eolChangedWs: !!(changedEol && changedEol.classList.contains("ws-eol")),
        eolChangedWidth: changedEol ? Math.round(changedEol.getBoundingClientRect().width) : 0,
        eolChangedBg: changedEol ? getComputedStyle(changedEol).backgroundColor : "",
        wordChanged: !!(tc && tc.querySelector(".diff-changed")),
      };
    };
    const unified = details.querySelector(".unified-diff");
    if (unified) return { unified: Array.from(unified.querySelectorAll("tbody > tr")).map(rowFacts) };
    const left = Array.from(details.querySelectorAll(".left-pane tbody > tr")).map(rowFacts);
    const right = Array.from(details.querySelectorAll(".right-pane tbody > tr")).map(rowFacts);
    return { left, right };
  }, file);
}

async function runScenario(name, fn) {
  log(`\n\u25B8 ${name}`);
  try {
    await fn();
  } catch (err) {
    assert(`${name} (threw)`, false, err && err.stack ? err.stack.split("\n")[0] : String(err));
  }
}

// ── pixel sampling (PNG decode; no dependencies) ─────────────────────────
const zlib = require("zlib");

/** Decode an 8-bit, non-interlaced RGB/RGBA PNG (what Playwright screenshots produce). */
function decodePng(buf) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 2;
  const idat = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error("unsupported PNG (bit depth / interlace)");
      colorType = data[9];
    }
    if (type === "IDAT") idat.push(data);
    offset += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!bpp) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y ? out[(y - 1) * stride + x - bpp] : 0;
      let v = raw[line + x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  const pixels = [];
  for (let i = 0; i < out.length; i += bpp) pixels.push({ r: out[i], g: out[i + 1], b: out[i + 2] });
  return { width, height, colorType, pixels };
}

const TINT = { r: 0x31, g: 0x6a, b: 0xc5 };
function isTint(px) {
  return Math.abs(px.r - TINT.r) <= 12 && Math.abs(px.g - TINT.g) <= 12 && Math.abs(px.b - TINT.b) <= 12;
}

/**
 * Share of the newline cell's pixels that carry the selection tint.
 *
 * Samples the whole cell box instead of one pixel: with whitespace chars on the
 * cell also shows the gray EOL glyph, and its antialiased edges land on
 * different pixels per platform (Windows ClearType/DirectWrite subpixel AA
 * tints single channels next to the stem; fractional device scale shifts it
 * too). A single fixed pixel beside the glyph is therefore not a stable probe.
 * An unpainted cell has ~0% tint, a painted one ~100% (no glyph) or ~55-65%
 * (glyph drawn over the tint).
 */
async function eolTintShare(page, row) {
  const x0 = Math.ceil(row.eolL);
  const x1 = Math.floor(row.eolR);
  const y0 = Math.ceil(row.eolT);
  const y1 = Math.floor(row.eolB);
  if (!(x1 > x0 && y1 > y0)) return { share: 0, detail: `empty cell box ${JSON.stringify([row.eolL, row.eolR, row.eolT, row.eolB])}` };
  const img = decodePng(await page.screenshot({ clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }));
  const tinted = img.pixels.filter(isTint).length;
  const counts = new Map();
  for (const p of img.pixels) {
    const key = `${p.r},${p.g},${p.b}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const common = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `rgb(${k})x${n}`);
  const share = tinted / img.pixels.length;
  return { share, detail: `tint ${tinted}/${img.pixels.length} (${Math.round(share * 100)}%), ${img.width}x${img.height}px, most common ${common.join(" ")}` };
}

// Painted: the tint must cover a clear majority of the glyph-free area. Unpainted: none.
const PAINTED_MIN_SHARE = 0.4;
const UNPAINTED_MAX_SHARE = 0.05;

const RED = /rgba\(255, 120, 120/;
const GREEN = /rgba\(112, 224, 145/;

async function eolHighlightScenarios(page, baseUrl, port) {
  await setIgnoreWhitespace(port, false);

  for (const whitespace of [false, true]) {
    const label = whitespace ? "ws on" : "ws off";
    await runScenario(`EOL highlight side-by-side (${label})`, async () => {
      await openCompare(page, baseUrl, EOL_A, EOL_B, { whitespace });
      const crlf = await eolFacts(page, "crlf-vs-lf.txt");
      assert(`[${label}] CRLF/LF file renders 5 rows per side`, crlf && crlf.left.length === 5 && crlf.right.length === 5, JSON.stringify(crlf && crlf.left.length));
      assert(`[${label}] every A row has eol-changed`, crlf.left.every((r) => r.eolChanged), JSON.stringify(crlf.left));
      assert(`[${label}] every B row has eol-changed`, crlf.right.every((r) => r.eolChanged), JSON.stringify(crlf.right));
      assert(`[${label}] EOL-only rows have no word-level highlight`, crlf.left.concat(crlf.right).every((r) => !r.wordChanged));
      assert(`[${label}] A EOL uses the red changed emphasis`, crlf.left.every((r) => RED.test(r.eolChangedBg)), crlf.left[0].eolChangedBg);
      assert(`[${label}] B EOL uses the green changed emphasis`, crlf.right.every((r) => GREEN.test(r.eolChangedBg)), crlf.right[0].eolChangedBg);
      assert(
        `[${label}] highlighted EOL cell is about one character wide`,
        crlf.left.concat(crlf.right).every((r) => r.eolChangedWidth >= 4 && r.eolChangedWidth <= 14),
        JSON.stringify(crlf.left.map((r) => r.eolChangedWidth))
      );
      if (whitespace) assert(`[${label}] highlighted EOL is the glyph`, crlf.left.every((r) => r.eolChangedWs));

      const mixed = await eolFacts(page, "mixed.txt");
      const flags = (side) => mixed[side].map((r) => (r.eolChanged ? 1 : 0)).join("");
      // alpha | beta(crlf/lf) | gamma one/two (crlf/lf) | delta | epsilon three/four | zeta | last (none/lf)
      assert(`[${label}] mixed A: EOL marks on beta and gamma only`, flags("left") === "0110000", flags("left"));
      assert(`[${label}] mixed B: EOL marks on beta, gamma and last`, flags("right") === "0110001", flags("right"));
      assert(`[${label}] mixed: content+EOL row keeps word highlight`, mixed.left[2].wordChanged && mixed.right[2].wordChanged);
      assert(`[${label}] mixed: content-only row has no EOL mark`, !mixed.left[4].eolChanged && mixed.left[4].wordChanged);
      assert(`[${label}] mixed: EOL-only beta row is a replace pair`, mixed.left[1].type === "replace" && !mixed.left[1].wordChanged);
    });
  }

  await runScenario("EOL highlight unified view", async () => {
    for (const whitespace of [false, true]) {
      await openCompare(page, baseUrl, EOL_A, EOL_B, { whitespace, view: "unified" });
      const crlf = await eolFacts(page, "crlf-vs-lf.txt");
      const rows = crlf && crlf.unified ? crlf.unified : [];
      const del = rows.filter((r) => r.type === "delete");
      const ins = rows.filter((r) => r.type === "insert");
      const label = whitespace ? "ws on" : "ws off";
      assert(`[unified ${label}] 5 delete + 5 insert rows`, del.length === 5 && ins.length === 5, `${del.length}/${ins.length}`);
      assert(`[unified ${label}] delete rows carry red EOL mark`, del.every((r) => r.eolChanged && RED.test(r.eolChangedBg)));
      assert(`[unified ${label}] insert rows carry green EOL mark`, ins.every((r) => r.eolChanged && GREEN.test(r.eolChangedBg)));
    }
  });

  await runScenario("ignore-whitespace mode never marks EOL", async () => {
    await setIgnoreWhitespace(port, true);
    await openCompare(page, baseUrl, EOL_A, EOL_B, { whitespace: true, file: "mixed.txt" });
    const names = await page.evaluate(() => Array.from(document.querySelectorAll("details.file-diff .name")).map((n) => n.textContent));
    assert("CRLF/LF-only file is not listed as differing", !names.includes("crlf-vs-lf.txt"), JSON.stringify(names));
    const mixed = await eolFacts(page, "mixed.txt");
    const any = mixed && mixed.left.concat(mixed.right).some((r) => r.eolChanged);
    assert("no eol-changed marks while whitespace is ignored", mixed && !any);
    await setIgnoreWhitespace(port, false);
  });
}

// ── newline selection helpers ─────────────────────────────────────────────

/** Geometry of every row in one pane of a named file. */
function paneRows(page, file, side) {
  return page.evaluate(
    ({ fileName, paneSide }) => {
      const details = Array.from(document.querySelectorAll("details.file-diff")).find(
        (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
      );
      if (!details) return null;
      details.scrollIntoView({ block: "start" });
      const pane = details.querySelector(paneSide === "right" ? ".right-pane" : ".left-pane");
      return Array.from(pane.querySelectorAll("tbody > tr")).map((tr, i) => {
        const tc = tr.querySelector(".text-content");
        if (!tc) return { i, gap: true };
        const eol = tc.lastElementChild && tc.lastElementChild.classList.contains("eol") ? tc.lastElementChild : null;
        const box = tc.getBoundingClientRect();
        const eb = eol ? eol.getBoundingClientRect() : null;
        const num = tr.querySelector("td.num").getBoundingClientRect();
        return {
          i,
          text: tc.textContent.slice(0, eol ? -1 : undefined),
          top: box.top,
          mid: (box.top + box.bottom) / 2,
          left: box.left,
          textStart: box.left + 9,
          eolL: eb ? eb.left : null,
          eolR: eb ? eb.right : null,
          eolW: eb ? eb.width : 0,
          eolT: eb ? eb.top : null,
          eolB: eb ? eb.bottom : null,
          gutterX: (num.left + num.right) / 2,
        };
      });
    },
    { fileName: file, paneSide: side }
  );
}

async function drag(page, from, to) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await sleep(80);
}

/** Dispatch a copy event through the app's handler and return text/plain. */
function copyText(page) {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    const node = sel.anchorNode;
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    const scroll = el && el.closest(".diff-scroll");
    if (!scroll) return null;
    const dt = new DataTransfer();
    const event = new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData: dt });
    if (!event.clipboardData) Object.defineProperty(event, "clipboardData", { value: dt });
    scroll.dispatchEvent(event);
    return (event.clipboardData && event.clipboardData.getData("text/plain")) || dt.getData("text/plain") || "";
  });
}

/** Which EOL cells (by row index) of a pane are inside the selection. */
function selectedEolRows(page, file, side) {
  return page.evaluate(
    ({ fileName, paneSide }) => {
      const details = Array.from(document.querySelectorAll("details.file-diff")).find(
        (d) => ((d.querySelector(".name") || {}).textContent || "") === fileName
      );
      const pane = details.querySelector(paneSide === "right" ? ".right-pane" : ".left-pane");
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return [];
      const range = sel.getRangeAt(0);
      return Array.from(pane.querySelectorAll("tbody > tr"))
        .map((tr, i) => {
          const eol = tr.querySelector(".text-content > .eol");
          if (!eol || !eol.firstChild) return -1;
          return range.comparePoint(eol.firstChild, 0) === 0 && range.comparePoint(eol.firstChild, 1) === 0 ? i : -1;
        })
        .filter((i) => i >= 0);
    },
    { fileName: file, paneSide: side }
  );
}

async function clearSelection(page) {
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    const header = document.querySelector(".app-header");
    const r = header.getBoundingClientRect();
    for (const type of ["mousedown", "mouseup"]) {
      header.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4, button: 0 }));
    }
    window.getSelection()?.removeAllRanges();
  });
}

const BIG = "big.txt";

async function newlineSelectionScenarios(page, baseUrl, port) {
  await setIgnoreWhitespace(port, true);

  for (const whitespace of [false, true]) {
    const label = whitespace ? "ws on" : "ws off";
    await openCompare(page, baseUrl, SEL_A, SEL_B, { whitespace, file: BIG });
    const rows = await paneRows(page, BIG, "left");
    const text = rows.filter((r) => !r.gap);
    // Rows: [gap] line 7 .. line 13 [gap]
    const l8 = text.find((r) => r.text === "line 8");
    const l9 = text.find((r) => r.text === "line 9");
    const l10 = text.find((r) => /^line 10 /.test(r.text));
    const l13 = text.find((r) => r.text === "line 13");
    const trailingGap = rows[rows.length - 1];

    await runScenario(`[${label}] EOL cell on every line`, async () => {
      assert(`[${label}] every visible line has a 1ch EOL cell`, text.every((r) => r.eolW >= 5 && r.eolW <= 12), JSON.stringify(text.map((r) => r.eolW)));
      assert(`[${label}] EOL cell sits right after the text`, !!l8 && l8.eolL > l8.textStart + 20 && l8.eolL < l8.textStart + 60, JSON.stringify(l8));
    });

    await runScenario(`[${label}] single line with and without its newline`, async () => {
      await clearSelection(page);
      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l8.eolL + 1, y: l8.mid });
      let copied = await copyText(page);
      assert(`[${label}] drag to end of text copies no newline`, copied === "line 8", JSON.stringify(copied));
      let eols = await selectedEolRows(page, BIG, "left");
      assert(`[${label}] newline cell not selected`, eols.length === 0, JSON.stringify(eols));
      let tint = await eolTintShare(page, l8);
      assert(`[${label}] unselected newline cell is not painted`, tint.share <= UNPAINTED_MAX_SHARE, tint.detail);

      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l8.eolR + 30, y: l8.mid });
      copied = await copyText(page);
      assert(`[${label}] drag past the newline copies it`, copied === "line 8\n", JSON.stringify(copied));
      eols = await selectedEolRows(page, BIG, "left");
      assert(`[${label}] newline cell selected`, eols.length === 1 && eols[0] === l8.i, JSON.stringify(eols));
      tint = await eolTintShare(page, l8);
      assert(`[${label}] selected newline cell paints with the selection tint`, tint.share >= PAINTED_MIN_SHARE, tint.detail);

      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l8.eolL + l8.eolW * 0.8, y: l8.mid });
      copied = await copyText(page);
      assert(`[${label}] dragging onto the newline cell selects it`, copied === "line 8\n", JSON.stringify(copied));
    });

    await runScenario(`[${label}] multi-line with and without the last newline`, async () => {
      await clearSelection(page);
      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l10.eolL + 1, y: l10.mid });
      let copied = await copyText(page);
      assert(`[${label}] 3 lines, last without newline`, copied === "line 8\nline 9\nline 10 CHANGED A", JSON.stringify(copied));
      let eols = await selectedEolRows(page, BIG, "left");
      assert(`[${label}] only interior newlines selected`, JSON.stringify(eols) === JSON.stringify([l8.i, l9.i]), JSON.stringify(eols));
      const tint9 = await eolTintShare(page, l9);
      assert(`[${label}] interior newline paints`, tint9.share >= PAINTED_MIN_SHARE, tint9.detail);

      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l10.eolR + 40, y: l10.mid });
      copied = await copyText(page);
      assert(`[${label}] 3 lines, last with newline`, copied === "line 8\nline 9\nline 10 CHANGED A\n", JSON.stringify(copied));
      eols = await selectedEolRows(page, BIG, "left");
      assert(`[${label}] all three newlines selected`, eols.length === 3, JSON.stringify(eols));

      // Onto the next line's start also takes the newline.
      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l9.textStart - 6, y: l9.mid });
      copied = await copyText(page);
      assert(`[${label}] drag onto next line's start copies line 8 with newline`, /^line 8\n/.test(copied || "") && !/line 9/.test(copied || ""), JSON.stringify(copied));
    });

    await runScenario(`[${label}] reverse drag keeps newline rule`, async () => {
      await clearSelection(page);
      await drag(page, { x: l9.eolL + 1, y: l9.mid }, { x: l8.textStart, y: l8.mid });
      let copied = await copyText(page);
      assert(`[${label}] bottom-up from line 9 text end`, copied === "line 8\nline 9", JSON.stringify(copied));
      await drag(page, { x: l9.eolR + 30, y: l9.mid }, { x: l8.textStart, y: l8.mid });
      copied = await copyText(page);
      assert(`[${label}] bottom-up from past line 9 newline`, copied === "line 8\nline 9\n", JSON.stringify(copied));
    });

    await runScenario(`[${label}] gutter and triple-click take the newline`, async () => {
      await clearSelection(page);
      await page.mouse.click(l9.gutterX, l9.mid);
      await sleep(60);
      let copied = await copyText(page);
      assert(`[${label}] gutter click copies line with newline`, copied === "line 9\n", JSON.stringify(copied));
      await clearSelection(page);
      await page.mouse.click(l9.textStart + 12, l9.mid, { clickCount: 3 });
      await sleep(60);
      copied = await copyText(page);
      assert(`[${label}] triple-click copies line with newline`, copied === "line 9\n", JSON.stringify(copied));
      await clearSelection(page);
      await page.mouse.click(l10.textStart + 70, l10.mid, { clickCount: 2 });
      await sleep(60);
      copied = await copyText(page);
      assert(`[${label}] double-click word has no newline`, /^CHANGED ?$/.test(copied || ""), JSON.stringify(copied));
    });

    await runScenario(`[${label}] gap arming with newline`, async () => {
      await clearSelection(page);
      const l11 = text.find((r) => r.text === "line 11");
      await drag(page, { x: l11.textStart, y: l11.mid }, { x: l13.eolL + 1, y: l13.mid });
      let copied = await copyText(page);
      let armed = await page.evaluate((f) => {
        const d = Array.from(document.querySelectorAll("details.file-diff")).find((x) => x.querySelector(".name").textContent === f);
        return d.querySelectorAll(".left-pane tr.gap-armed").length;
      }, BIG);
      assert(`[${label}] last line text only: no newline, gap not armed`, copied === "line 11\nline 12\nline 13" && armed === 0, `${JSON.stringify(copied)} armed=${armed}`);

      await drag(page, { x: l11.textStart, y: l11.mid }, { x: l13.eolR + 40, y: l13.mid });
      copied = await copyText(page);
      armed = await page.evaluate((f) => {
        const d = Array.from(document.querySelectorAll("details.file-diff")).find((x) => x.querySelector(".name").textContent === f);
        return d.querySelectorAll(".left-pane tr.gap-armed").length;
      }, BIG);
      assert(`[${label}] full last line with newline still does not arm the gap`, copied === "line 11\nline 12\nline 13\n" && armed === 0, `${JSON.stringify(copied)} armed=${armed}`);

      const gapBox = await page.evaluate((f) => {
        const d = Array.from(document.querySelectorAll("details.file-diff")).find((x) => x.querySelector(".name").textContent === f);
        const rowsEl = d.querySelectorAll(".left-pane tbody > tr");
        const r = rowsEl[rowsEl.length - 1].getBoundingClientRect();
        return { x: r.left + 60, y: (r.top + r.bottom) / 2 };
      }, BIG);
      await drag(page, { x: l11.textStart, y: l11.mid }, gapBox);
      copied = await copyText(page) || "";
      assert(`[${label}] dragging onto the gap arms it and copies hidden lines`, /^line 11\nline 12\nline 13\nline 14\n/.test(copied) && /line 20\n?$/.test(copied), JSON.stringify(copied.slice(0, 60)));

      // Rule check straight against the gate: the line above a gap counts as
      // fully selected only with its newline.
      const gate = await page.evaluate((f) => {
        const d = Array.from(document.querySelectorAll("details.file-diff")).find((x) => x.querySelector(".name").textContent === f);
        const pane = d.querySelector(".left-pane");
        const rowEls = Array.from(pane.querySelectorAll("tbody > tr"));
        const gapIdx = rowEls.length - 1;
        const tc13 = rowEls[gapIdx - 1].querySelector(".text-content");
        const tc11 = rowEls[gapIdx - 3].querySelector(".text-content");
        const sel = window.getSelection();
        const set = (endNode, endOffset) => {
          const range = document.createRange();
          range.setStart(tc11.firstChild.nodeType === 3 ? tc11.firstChild : tc11, 0);
          range.setEnd(endNode, endOffset);
          sel.removeAllRanges();
          sel.addRange(range);
          return adjacentSelectionAllowsGap(rowEls, gapIdx, gapIdx - 3, gapIdx - 1, sel);
        };
        const eol = tc13.lastElementChild;
        const lastText = eol.previousSibling;
        const withoutNewline = set(lastText.nodeType === 3 ? lastText : lastText.lastChild, (lastText.textContent || "").length);
        const withNewline = set(eol.firstChild, 1);
        sel.removeAllRanges();
        return { withoutNewline, withNewline };
      }, BIG);
      assert(`[${label}] gate: text without newline does not allow the gap below`, gate.withoutNewline === false, JSON.stringify(gate));
      assert(`[${label}] gate: text plus newline allows the gap below`, gate.withNewline === true, JSON.stringify(gate));
      await clearSelection(page);
    });

    await runScenario(`[${label}] no cross-pane bleed and right-click keeps newline`, async () => {
      await clearSelection(page);
      await drag(page, { x: l8.textStart, y: l8.mid }, { x: l9.eolR + 30, y: l9.mid });
      const right = await selectedEolRows(page, BIG, "right");
      assert(`[${label}] right pane EOL cells untouched`, right.length === 0, JSON.stringify(right));
      await page.mouse.click(l8.textStart + 10, l8.mid, { button: "right" });
      await sleep(80);
      const kept = await copyText(page);
      assert(`[${label}] right-click keeps the selection with newlines`, kept === "line 8\nline 9\n", JSON.stringify(kept));
      await page.keyboard.press("Escape");
      await clearSelection(page);
    });
  }

  await setIgnoreWhitespace(port, false);
  await runScenario("CRLF copy uses the file's own terminator; blank line is its newline", async () => {
    await openCompare(page, baseUrl, EOL_A, EOL_B, { whitespace: false, file: "crlf-vs-lf.txt" });
    const left = (await paneRows(page, "crlf-vs-lf.txt", "left")).filter((r) => !r.gap);
    const right = (await paneRows(page, "crlf-vs-lf.txt", "right")).filter((r) => !r.gap);
    await clearSelection(page);
    await drag(page, { x: left[0].textStart, y: left[0].mid }, { x: left[0].eolR + 30, y: left[0].mid });
    let copied = await copyText(page);
    assert("A (CRLF) line with newline copies \\r\\n", copied === "first line\r\n", JSON.stringify(copied));
    await drag(page, { x: left[0].textStart, y: left[0].mid }, { x: left[0].eolL + 1, y: left[0].mid });
    copied = await copyText(page);
    assert("A (CRLF) line without newline", copied === "first line", JSON.stringify(copied));
    await clearSelection(page);
    await drag(page, { x: right[0].textStart, y: right[0].mid }, { x: right[0].eolR + 30, y: right[0].mid });
    copied = await copyText(page);
    assert("B (LF) line with newline copies \\n", copied === "first line\n", JSON.stringify(copied));

    // Rows 2..3: "second line" then a blank line (just a newline).
    await clearSelection(page);
    await drag(page, { x: left[1].textStart, y: left[1].mid }, { x: left[2].left + 4, y: left[2].mid });
    copied = await copyText(page);
    assert("blank line left before its newline cell contributes nothing", copied === "second line\r\n", JSON.stringify(copied));
    await drag(page, { x: left[1].textStart, y: left[1].mid }, { x: left[2].eolR + 30, y: left[2].mid });
    copied = await copyText(page);
    assert("blank line with its newline copies \\r\\n", copied === "second line\r\n\r\n", JSON.stringify(copied));
    const tint = await eolTintShare(page, left[2]);
    assert("blank line newline cell paints", tint.share >= PAINTED_MIN_SHARE, tint.detail);
    const marked = await page.evaluate(() => document.querySelectorAll(".left-pane .text-content.ws-line-selected.eol-only").length);
    assert("blank line still carries ws-line-selected", marked === 1, String(marked));

    // Whole pane by drag, stopping before the final newline.
    await clearSelection(page);
    await drag(page, { x: left[0].textStart, y: left[0].mid }, { x: left[4].eolL + 1, y: left[4].mid });
    copied = await copyText(page);
    assert("whole-pane drag without final newline", copied === "first line\r\nsecond line\r\n\r\nfourth line\r\nfifth line", JSON.stringify(copied));
    await drag(page, { x: left[0].textStart, y: left[0].mid }, { x: left[4].eolR + 30, y: left[4].mid });
    copied = await copyText(page);
    assert("whole-pane drag with final newline", copied === "first line\r\nsecond line\r\n\r\nfourth line\r\nfifth line\r\n", JSON.stringify(copied));
    await clearSelection(page);
  });

  await runScenario("unified view renders EOL cells and stays unselectable", async () => {
    await setIgnoreWhitespace(port, true);
    for (const whitespace of [false, true]) {
      await openCompare(page, baseUrl, SEL_A, SEL_B, { whitespace, file: BIG, view: "unified" });
      const facts = await page.evaluate((f) => {
        const d = Array.from(document.querySelectorAll("details.file-diff")).find((x) => x.querySelector(".name").textContent === f);
        const tcs = Array.from(d.querySelectorAll(".unified-diff .text-content"));
        return {
          lines: tcs.length,
          withEol: tcs.filter((tc) => tc.lastElementChild && tc.lastElementChild.classList.contains("eol")).length,
          userSelect: tcs.length ? getComputedStyle(tcs[0]).userSelect : "",
        };
      }, BIG);
      const label = whitespace ? "ws on" : "ws off";
      assert(`[unified ${label}] every line has an EOL cell`, facts.lines > 0 && facts.withEol === facts.lines, JSON.stringify(facts));
      assert(`[unified ${label}] text selection stays disabled`, facts.userSelect === "none", JSON.stringify(facts));
    }
  });
}

async function main() {
  log("Socha Diff - line-ending highlight and newline selection");
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    log("Playwright is not installed; soft-skipping.");
    process.exit(0);
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (/Executable doesn't exist|browserType\.launch/i.test(String(err && err.message))) {
      log("Playwright browsers are not installed; soft-skipping. Run: npx playwright install chromium");
      process.exit(0);
    }
    throw err;
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socha-diff-test-"));
  const port = await getEphemeralPort();
  const baseUrl = `http://localhost:${port}`;
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SOCHA_NO_OPEN: "1", SOCHA_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(port);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      permissions: ["clipboard-read", "clipboard-write"],
    });
    const page = await context.newPage();
    await eolHighlightScenarios(page, baseUrl, port);
    await newlineSelectionScenarios(page, baseUrl, port);
  } finally {
    server.kill("SIGTERM");
    await browser.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  log("\n\u2500\u2500 summary \u2500\u2500");
  log(`passed: ${PASS.length}`);
  log(`failed: ${FAIL.length}`);
  if (FAIL.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
