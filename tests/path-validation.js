"use strict";

/**
 * Folder path blur validation for the Folder A/B inputs.
 *
 * Run:  npm run test:paths
 * Needs: Playwright Chromium (`npx playwright install chromium`)
 *
 * Soft-exits 0 when Playwright or its browsers are missing.
 * Starts `node server.js` on an ephemeral port for the run.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const GOOD = path.join(ROOT, "sample", "folder-a");
const MISSING = path.join(ROOT, "sample", "does-not-exist");
const FILE = path.join(ROOT, "package.json");

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

function getJson(port, urlPath) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "localhost", port, path: urlPath, timeout: 5000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

async function waitForServer(port, timeoutMs = 15000) {
  const start = Date.now();
  for (;;) {
    try {
      await getJson(port, "/api/settings");
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`Server did not start on ${port}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

async function main() {
  log("Socha Diff - folder path blur validation");
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

  const port = await getEphemeralPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socha-diff-test-"));
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SOCHA_NO_OPEN: "1", SOCHA_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(port);

    log("\n-- /api/dir-exists --");
    const q = (p) => getJson(port, `/api/dir-exists?path=${encodeURIComponent(p)}`);
    let r = await q(GOOD);
    assert("existing dir", r.body.exists === true && r.body.isDirectory === true, JSON.stringify(r.body));
    r = await q(MISSING);
    assert("missing dir", r.body.exists === false && r.body.isDirectory === false && !r.body.error, JSON.stringify(r.body));
    r = await q(FILE);
    assert("file path", r.body.exists === true && r.body.isDirectory === false, JSON.stringify(r.body));
    r = await q(`  "${GOOD}"  `);
    assert("quoted + padded dir", r.body.exists === true && r.body.isDirectory === true, JSON.stringify(r.body));
    r = await getJson(port, "/api/dir-exists?path=");
    assert("empty path is 400", r.status === 400, String(r.status));

    log("\n-- blur UI --");
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://localhost:${port}/`, { waitUntil: "networkidle" });
    const input = page.locator("#folderA");
    const status = page.locator("#folderA-status");
    const blurWith = async (value) => {
      await input.fill(value);
      const checked = value.trim()
        ? page.waitForResponse((res) => res.url().includes("/api/dir-exists"))
        : Promise.resolve();
      await page.locator("h1").click();
      await checked;
      await page.waitForTimeout(50);
    };
    const state = () =>
      page.evaluate(() => {
        const el = document.getElementById("folderA");
        return {
          invalid: el.classList.contains("path-invalid"),
          valid: el.classList.contains("path-valid"),
          aria: el.getAttribute("aria-invalid"),
          msg: document.getElementById("folderA-status").textContent,
        };
      });

    await blurWith(MISSING);
    let s = await state();
    assert("missing path marks invalid", s.invalid && s.aria === "true" && s.msg === "Folder not found", JSON.stringify(s));

    await blurWith(FILE);
    s = await state();
    assert("file path says Not a folder", s.invalid && s.msg === "Not a folder", JSON.stringify(s));

    await input.focus();
    await page.keyboard.type("x");
    s = await state();
    assert("typing clears invalid state", !s.invalid && s.msg === "", JSON.stringify(s));

    await blurWith(`"${GOOD}"`);
    s = await state();
    assert("quoted good path clears invalid, marks valid", !s.invalid && s.valid && s.msg === "", JSON.stringify(s));

    await blurWith("   ");
    s = await state();
    assert("blank value clears state", !s.invalid && !s.valid && s.msg === "", JSON.stringify(s));

    // Stale response: delay the check, change the value, and make sure the
    // late "not found" result is ignored.
    await page.route("**/api/dir-exists**", async (route) => {
      await new Promise((res) => setTimeout(res, 400));
      await route.continue();
    });
    await input.fill(MISSING);
    await page.locator("h1").click();
    await input.fill(GOOD);
    await page.waitForTimeout(700);
    s = await state();
    assert("stale response ignored after edit", !s.invalid && s.msg === "", JSON.stringify(s));
    await page.unroute("**/api/dir-exists**");
    assert("status element present", (await status.count()) === 1);
  } finally {
    server.kill("SIGTERM");
    await browser.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  log(`\npassed: ${PASS.length}`);
  log(`failed: ${FAIL.length}`);
  if (FAIL.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
