"use strict";

/**
 * Header "?" help button: sits right of Settings with the same look, has an
 * accessible label and tooltip, and opens the guide with window.open (click
 * and F1). window.open is stubbed, so nothing is fetched from the internet.
 *
 * Run:  npm run test:help
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
const GUIDE_URL = "https://sochadiff.socha3.com/guide.html";
const TOOLTIP = "Help: open the Socha Diff guide (every control explained)";

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

function waitForServer(port) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/settings" }, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > 15000) reject(new Error(`Server did not start on ${port}`));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

async function main() {
  log("Socha Diff - header help button");
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
    env: { ...process.env, PORT: String(port), SOCHA_NO_OPEN: "1", SOCHA_DATA_DIR: dataDir, SOCHA_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer(port);
    const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
    await page.addInitScript(() => {
      window.__opened = [];
      window.open = (...args) => {
        window.__opened.push(args);
        return null;
      };
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "networkidle" });

    const settings = page.locator("#settings-open-btn");
    const help = page.locator("#help-open-btn");
    assert("? button exists", (await help.count()) === 1);
    assert("? button shows a question mark", (await help.innerText()).trim().startsWith("?"));
    assert("? button has an accessible label",
      (await help.getAttribute("aria-label")) === "Help: open the Socha Diff guide");

    const next = await settings.evaluate((el) => el.nextElementSibling && el.nextElementSibling.id);
    assert("? button is the next element after Settings", next === "help-open-btn", String(next));
    const sb = await settings.boundingBox();
    const hb = await help.boundingBox();
    assert("? button sits to the right of Settings", hb.x >= sb.x + sb.width && hb.x - (sb.x + sb.width) <= 16,
      JSON.stringify({ sb, hb }));
    assert("? button has the Settings button's height and row",
      Math.abs(hb.height - sb.height) < 0.5 && Math.abs(hb.y - sb.y) < 0.5, JSON.stringify({ sb, hb }));
    const style = (el) => {
      const s = getComputedStyle(el);
      return [s.borderTopWidth, s.borderTopStyle, s.borderTopColor, s.borderRadius, s.backgroundColor, s.color, s.fontSize].join("|");
    };
    assert("? button matches the Settings button style",
      (await help.evaluate(style)) === (await settings.evaluate(style)),
      `${await help.evaluate(style)} vs ${await settings.evaluate(style)}`);

    const tooltip = page.locator("#help-tooltip");
    assert("tooltip is linked by aria-describedby", (await help.getAttribute("aria-describedby")) === "help-tooltip");
    assert("tooltip uses the header tooltip style",
      await tooltip.evaluate((el) => el.classList.contains("header-tooltip") && el.getAttribute("role") === "tooltip"));
    const text = (await tooltip.textContent()).replace(/\s+/g, " ").trim();
    assert("tooltip text describes the button and F1", text.includes(TOOLTIP) && text.includes("F1"), text);
    assert("tooltip hidden before hover", (await tooltip.evaluate((el) => getComputedStyle(el).visibility)) === "hidden");
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.move(hb.x + hb.width / 2 + 1, hb.y + hb.height / 2 + 1);
    await page.waitForTimeout(250);
    assert("tooltip visible on hover", (await tooltip.evaluate((el) => getComputedStyle(el).visibility)) === "visible");
    const tb = await tooltip.boundingBox();
    assert("tooltip stays inside the window", tb.x >= 0 && tb.y >= 0 && tb.x + tb.width <= 1100, JSON.stringify(tb));

    await help.click();
    let opened = await page.evaluate(() => window.__opened);
    assert("click calls window.open(guide, _blank, noopener)",
      opened.length === 1 && opened[0][0] === GUIDE_URL && opened[0][1] === "_blank" && /noopener/.test(opened[0][2] || ""),
      JSON.stringify(opened));

    await page.locator("#folderA").focus();
    await page.keyboard.press("F1");
    opened = await page.evaluate(() => window.__opened);
    assert("F1 opens the guide (even while typing in a folder box)",
      opened.length === 2 && opened[1][0] === GUIDE_URL, JSON.stringify(opened));
    await page.keyboard.press("Shift+F1");
    await page.keyboard.press("Control+F1");
    opened = await page.evaluate(() => window.__opened);
    assert("F1 with modifiers does nothing", opened.length === 2, JSON.stringify(opened));
    assert("F1 does not open Settings", !(await page.locator("#settings-dialog").evaluate((d) => d.open)));
    await page.keyboard.press("Control+s");
    const settingsOpened = await page.waitForFunction(() => document.getElementById("settings-dialog").open, null, { timeout: 5000 })
      .then(() => true, () => false);
    assert("Ctrl+S still opens Settings", settingsOpened);
  } finally {
    await browser.close();
    server.kill("SIGTERM");
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
