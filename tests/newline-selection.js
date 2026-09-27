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
