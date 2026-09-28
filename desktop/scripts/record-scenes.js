// Records the download site's animated demos (site/assets/home-demo.* and guide-*.*) from REAL
// Socha Diff sessions. Linux only: needs Xvfb, xdotool, ffmpeg and Playwright Chromium
// (npx playwright install chromium). Encode the raw captures with encode-demos.sh.
//
//   node desktop/scripts/record-scenes.js              # every scene
//   node desktop/scripts/record-scenes.js home copy    # just these
//   desktop/scripts/encode-demos.sh                    # raw/*.mkv -> site/assets/*.webp|gif
//
// What it does (self-contained and reproducible):
// - Copies sample/demo-a and sample/demo-b into a scratch folder as directories literally named
//   "C:\Projects\shop-v1" and "C:\Projects\shop-v2" and runs server.js with that folder as its
//   working directory. On Linux a relative path may contain "\" and ":", so the app shows the
//   Windows-looking paths while it compares real folders (the fixtures are fresh for every scene).
// - Starts its own Xvfb, a Socha Diff server (temp SOCHA_DATA_DIR, default settings) and a kiosk
//   Chromium window at 0,0, so page CSS px == screen px.
// - Drives the page with real X input via xdotool (so the real cursor, hover states and native
//   tooltips show); Playwright is only used to launch the browser and read element positions.
// - Key captions (e.g. "Ctrl + S") are a recording-only overlay injected into the page; the app
//   has no such UI.
// Output: $REC_WORK/raw/<scene>.mkv (x11grab, 30 fps, near-lossless).
"use strict";
const path = require("path");
const fs = require("fs");
const { execFileSync, spawn } = require("child_process");
const REPO = path.resolve(__dirname, "..", "..");
const { chromium } = require(path.join(REPO, "node_modules", "playwright"));

const WORK = process.env.REC_WORK || "/tmp/socha-rec";
const RAW = path.join(WORK, "raw");
const CWD = path.join(WORK, "cwd");
const DATA = path.join(WORK, "data");
const PORT = Number(process.env.REC_PORT || 3931);
const URL = `http://127.0.0.1:${PORT}/`;
const DIR_A = "C:\\Projects\\shop-v1";
const DIR_B = "C:\\Projects\\shop-v2";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- environment
let DISPLAY = null;
let xvfb = null;
let env = process.env;
const xdo = (...args) => execFileSync("xdotool", args.map(String), { env });

async function startDisplay(w, h) {
  if (xvfb) { xvfb.kill(); await sleep(300); }
  DISPLAY = process.env.REC_DISPLAY || ":78";
  xvfb = spawn("Xvfb", [DISPLAY, "-screen", "0", `${w}x${h}x24`, "-nolisten", "tcp"], { stdio: "ignore" });
  env = { ...process.env, DISPLAY };
  for (let i = 0; i < 50; i++) {
    try { execFileSync("xdotool", ["getmouselocation"], { env, stdio: "ignore" }); return; } catch { await sleep(100); }
  }
  throw new Error("Xvfb did not start on " + DISPLAY);
}

function resetFixtures() {
  // Empty CWD but keep the directory itself: it is the server's working directory, and
  // relative fs calls would fail against a deleted one.
  fs.mkdirSync(CWD, { recursive: true });
  for (const name of fs.readdirSync(CWD)) fs.rmSync(path.join(CWD, name), { recursive: true, force: true });
  fs.cpSync(path.join(REPO, "sample", "demo-a"), path.join(CWD, DIR_A), { recursive: true });
  fs.cpSync(path.join(REPO, "sample", "demo-b"), path.join(CWD, DIR_B), { recursive: true });
}

let server = null;
async function startServer() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  resetFixtures();
  server = spawn(process.execPath, [path.join(REPO, "server.js")], {
    cwd: CWD,
    env: { ...process.env, PORT: String(PORT), SOCHA_HOST: "127.0.0.1", SOCHA_NO_OPEN: "1", SOCHA_DATA_DIR: DATA },
    stdio: "ignore",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(URL + "api/health")).ok) return; } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

// Fresh fixtures, default settings, no saved paths.
async function freshState() {
  resetFixtures();
  await fetch(URL + "api/settings/reset", { method: "POST" });
  fs.rmSync(path.join(DATA, ".socha-diff-state.json"), { force: true });
}

// ---------------------------------------------------------------- input helpers
let cur = { x: 10, y: 10 };
async function moveTo(x, y, ms = 450) {
  const steps = Math.max(8, Math.round(ms / 16));
  const from = { ...cur };
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    xdo("mousemove", Math.round(from.x + (x - from.x) * e), Math.round(from.y + (y - from.y) * e));
    await sleep(ms / steps);
  }
  cur = { x: Math.round(x), y: Math.round(y) };
}
async function box(locator) {
  await locator.waitFor({ state: "visible", timeout: 5000 });
  const b = await locator.boundingBox();
  if (!b) throw new Error("no box for " + locator);
  return b;
}
async function hover(locator, ms = 500, dx = 0.5, dy = 0.5) {
  const b = await box(locator);
  await moveTo(b.x + b.width * dx, b.y + b.height * dy, ms);
}
async function click(locator, ms = 500, button = 1) {
  await hover(locator, ms);
  await sleep(120);
  xdo("click", button);
}
async function type(text, delay = 28) {
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    if (line) xdo("type", "--delay", delay, line);
    if (i < lines.length - 1) xdo("key", "Return");
  });
}
async function wheelUntil(page, locator, targetTop) {
  for (let i = 0; i < 80; i++) {
    const b = await locator.boundingBox();
    if (b && b.y <= targetTop) return;
    xdo("click", 5);
    await sleep(40);
  }
}
async function wheelToTop(page) {
  for (let i = 0; i < 80; i++) {
    if ((await page.evaluate(() => window.scrollY)) <= 0) return;
    xdo("click", "--repeat", "3", "--delay", "15", 4);
    await sleep(30);
  }
}
async function dragSelect(page, first, last) {
  const a = await box(first);
  const end = await last.evaluate((n) => {
    const r = document.createRange();
    r.selectNodeContents(n);
    const rects = [...r.getClientRects()].filter((q) => q.width > 0);
    const q = rects[rects.length - 1];
    return { x: q.right + 2, y: q.top + q.height / 2 };
  });
  await moveTo(a.x + 2, a.y + a.height / 2, 600);
  await sleep(150);
  xdo("mousedown", 1);
  const sx = cur.x, sy = cur.y;
  for (let i = 1; i <= 36; i++) {
    const t = i / 36;
    xdo("mousemove", Math.round(sx + (end.x - sx) * t), Math.round(sy + (end.y - sy) * t));
    await sleep(22);
  }
  cur = { x: Math.round(end.x), y: Math.round(end.y) };
  xdo("mouseup", 1);
}

// Recording-only caption overlay (bottom centre). html may contain <kbd>.
async function caption(page, html) {
  await page.evaluate((html) => {
    let el = document.getElementById("rec-caption");
    if (!el) {
      const style = document.createElement("style");
      style.textContent = `#rec-caption{position:fixed;left:50%;bottom:26px;transform:translateX(-50%) translateY(8px);z-index:2147483647;
        pointer-events:none;opacity:0;transition:opacity .18s,transform .18s;padding:10px 18px;border-radius:12px;
        font:600 17px/1.35 "Segoe UI",system-ui,sans-serif;color:#f0f4fa;background:rgba(12,17,26,.92);
        border:1px solid rgba(120,160,255,.45);box-shadow:0 10px 30px rgba(0,0,0,.55);white-space:nowrap}
        #rec-caption.on{opacity:1;transform:translateX(-50%)}
        #rec-caption kbd{display:inline-block;min-width:1.6em;padding:1px 9px;margin:0 2px;border-radius:7px;text-align:center;
        font:700 15px/1.5 "Segoe UI",system-ui,sans-serif;color:#fff;background:linear-gradient(#2a3650,#1b2437);
        border:1px solid #4b5f86;border-bottom-width:3px}`;
      document.head.appendChild(style);
      el = document.createElement("div");
      el.id = "rec-caption";
      document.body.appendChild(el);
    }
    if (html) { el.innerHTML = html; el.classList.add("on"); } else el.classList.remove("on");
  }, html || "");
}

// ---------------------------------------------------------------- browser + capture
let ctx = null;
let page = null;
let size = null;
async function ensureBrowser(w, h) {
  if (size && size[0] === w && size[1] === h) return;
  if (ctx) await ctx.close();
  await startDisplay(w, h);
  const profile = path.join(WORK, "profile");
  fs.rmSync(profile, { recursive: true, force: true });
  ctx = await chromium.launchPersistentContext(profile, {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--kiosk", "--window-position=0,0", `--window-size=${w},${h}`, "--no-first-run", "--force-device-scale-factor=1",
      "--disable-features=Translate,MediaRouter", "--password-store=basic"],
    env,
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
  page = ctx.pages()[0] || (await ctx.newPage());
  size = [w, h];
}

// Load the app; with compare=true it runs the demo comparison before recording starts.
async function openApp({ compare = false } = {}) {
  await page.goto(URL + "about-blank-reset");
  await page.evaluate(() => sessionStorage.clear()).catch(() => {});
  const q = compare ? `?a=${encodeURIComponent(DIR_A)}&b=${encodeURIComponent(DIR_B)}&run=1` : "";
  await page.goto(URL + q);
  await page.waitForLoadState("networkidle");
  if (compare) await page.waitForSelector(".summary");
  await page.evaluate(() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); });
  cur = { x: size[0] - 40, y: size[1] - 40 };
  xdo("mousemove", cur.x, cur.y);
  await sleep(700);
}

async function record(name, fn) {
  fs.mkdirSync(RAW, { recursive: true });
  const out = path.join(RAW, `${name}.mkv`);
  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30",
    "-video_size", `${size[0]}x${size[1]}`, "-i", DISPLAY, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8",
    "-pix_fmt", "yuv444p", out], { stdio: ["pipe", "inherit", "inherit"] });
  const t0 = Date.now();
  await sleep(500);
  await fn();
  await sleep(300);
  ff.stdin.write("q");
  await new Promise((r) => ff.on("close", r));
  console.log(`${name}: ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${out}`);
}

// Before recording: scroll src/server.js to the top of the window (no wheel noise in the clip).
async function scrollToServerDiff() {
  await serverDiff().locator("summary").evaluate((e) => window.scrollTo(0, e.getBoundingClientRect().top + window.scrollY - 64));
  await sleep(300);
}

const serverDiff = () => page.locator(".file-diff", { hasText: "src/server.js" });
const chip = (cat) => page.locator(`.chip[data-category="${cat}"]`);

// ---------------------------------------------------------------- scenes
const SCENES = {
  // Home page overview: paths, Compare, A/B links, Ctrl+S settings + exclusion, gaps, copy, unified.
  home: { size: [1280, 800], setup: {}, async run() {
    await click(page.locator("#folderA"), 650);
    await type(DIR_A, 22);
    await click(page.locator("#folderB"), 450);
    await type(DIR_B, 22);
    await sleep(200);
    await click(page.locator("#compare-btn"), 550);
    await page.waitForSelector(".file-diff");
    await sleep(1100);
    const link = page.locator(".file-diff summary").first().locator(".path-side-link.side-a");
    await hover(link, 600);
    await caption(page, "<kbd>Click</kbd> A or B: open the file &nbsp;&middot;&nbsp; <kbd>Right-click</kbd>: Open with");
    await sleep(2200);
    await caption(page, "<kbd>Ctrl</kbd> + <kbd>S</kbd> &nbsp;Settings");
    await sleep(500);
    xdo("key", "ctrl+s");
    await page.waitForSelector("#settings-dialog[open]");
    await sleep(800);
    await caption(page, "Exclude folders by name");
    await click(page.locator("#ignored-directories"), 500);
    xdo("key", "ctrl+End");
    await type("\nlegacy", 60);
    await page.waitForFunction(() => /Saved/.test(document.getElementById("settings-status").textContent));
    await sleep(900);
    await caption(page, "<kbd>Esc</kbd>");
    xdo("key", "Escape");
    await sleep(500);
    await caption(page, "");
    await click(page.locator("#compare-btn"), 600);
    await page.waitForFunction(() => document.querySelector('.chip[data-category="onlyInA"]')?.disabled);
    await sleep(900);
    const gap = serverDiff().locator(".gap-toggle", { hasText: "39 unchanged" }).first();
    await moveTo(size[0] / 2, size[1] * 0.62, 350);
    await wheelUntil(page, serverDiff().locator("summary"), 90);
    await sleep(400);
    await click(gap, 550);
    await sleep(900);
    const right = serverDiff().locator(".right-pane");
    const first = right.locator("tr", { hasText: "if (item.stock + delta < 0)" }).locator(".text-content").first();
    await wheelUntil(page, first, 380);
    await sleep(300);
    const last = right.locator("tr", { hasText: "return;" }).filter({ has: page.locator("td", { hasText: /^\s*57\s*$/ }) }).locator(".text-content").first();
    await dragSelect(page, first, last);
    await sleep(350);
    await moveTo(cur.x - 60, cur.y - 10, 250);
    xdo("click", 3);
    await page.waitForSelector(".diff-context-menu-item");
    await sleep(500);
    await click(page.locator(".diff-context-menu-item"), 350);
    await caption(page, "Copied exactly what you selected");
    await sleep(1400);
    await caption(page, "");
    await moveTo(size[0] / 2, 400, 250);
    await wheelToTop(page);
    await sleep(300);
    await click(page.locator('.toggle-btn[data-view="unified"]'), 550);
    await sleep(1800);
  } },

  // Guide: typing paths, the folder check, Compare, filtering by chip, only-in lists.
  compare: { size: [1024, 640], setup: {}, async run() {
    await click(page.locator("#folderA"), 600);
    await type(DIR_A);
    xdo("key", "Tab");
    await sleep(700);
    await type("C:\\Projects\\shop-v3");
    xdo("key", "Tab");
    await sleep(1500);
    await click(page.locator("#folderB"), 450);
    xdo("key", "BackSpace");
    await type("2");
    xdo("key", "Tab");
    await sleep(1000);
    await click(page.locator("#compare-btn"), 500);
    await page.waitForSelector(".summary");
    await sleep(1300);
    await click(chip("onlyInA"), 600);
    await sleep(1400);
    await click(chip("onlyInB"), 500);
    await sleep(1400);
    await click(chip("onlyInB"), 400);
    await sleep(1000);
  } },

  // Guide: Ctrl+S opens Settings, the whitespace checkbox, Esc, the pending star.
  shortcut: { size: [1024, 640], setup: { compare: true }, async run() {
    await hover(page.locator("#settings-open-btn"), 700);
    await sleep(1500);
    await moveTo(size[0] * 0.55, size[1] * 0.55, 450);
    await caption(page, "<kbd>Ctrl</kbd> + <kbd>S</kbd>");
    await sleep(600);
    xdo("key", "ctrl+s");
    await page.waitForSelector("#settings-dialog[open]");
    await sleep(1300);
    await caption(page, "");
    await click(page.locator("#ignore-whitespace"), 550);
    await sleep(1600);
    await caption(page, "<kbd>Esc</kbd>");
    await sleep(400);
    xdo("key", "Escape");
    await sleep(700);
    await caption(page, "");
    await hover(page.locator("#compare-pending-indicator"), 600);
    await sleep(1700);
    await click(page.locator("#ws-indicator"), 600);
    await sleep(1500);
  } },

  // Guide: add excluded folder names, re-run Compare, the only-in files disappear.
  exclude: { size: [1024, 640], setup: { compare: true }, async run() {
    await sleep(500);
    await click(page.locator("#settings-open-btn"), 600);
    await page.waitForSelector("#settings-dialog[open]");
    await sleep(600);
    await click(page.locator("#ignored-directories"), 500);
    xdo("key", "ctrl+End");
    await type("\nlegacy\ndocs", 70);
    await page.waitForFunction(() => /Saved/.test(document.getElementById("settings-status").textContent));
    await sleep(1500);
    await click(page.locator("#settings-close-btn"), 500);
    await sleep(400);
    await hover(page.locator("#compare-pending-indicator"), 500);
    await sleep(1300);
    await click(page.locator("#compare-btn"), 400);
    await page.waitForFunction(() => document.querySelector('.chip[data-category="onlyInA"]')?.disabled);
    await moveTo(size[0] * 0.5, 170, 500);
    await sleep(2000);
  } },

  // Guide: the whitespace-only list, Whitespace chars, the ¶ badge and a whitespace-aware compare.
  whitespace: { size: [1024, 640], setup: { compare: true }, async run() {
    await click(chip("whitespaceOnly"), 600);
    await sleep(1600);
    await click(chip("whitespaceOnly"), 400);
    await sleep(500);
    await click(page.locator("#whitespace-btn"), 550);
    await sleep(1600);
    await hover(page.locator("#ws-indicator"), 600);
    await sleep(900);
    xdo("click", 1);
    await sleep(900);
    await click(page.locator("#compare-btn"), 550);
    await page.waitForFunction(() => document.querySelector('.chip[data-category="whitespaceOnly"]')?.disabled);
    await sleep(600);
    const fmt = page.locator(".file-diff", { hasText: "src/format.js" });
    await moveTo(size[0] / 2, size[1] * 0.6, 350);
    await wheelUntil(page, fmt.locator("summary"), 70);
    await sleep(2200);
  } },

  // Guide: drag-select, the Copy menu, gutter line selection, Ctrl+A in one pane.
  copy: { size: [1024, 640], setup: { compare: true }, prep: scrollToServerDiff, async run() {
    const right = serverDiff().locator(".right-pane");
    await sleep(500);
    const first = right.locator("tr.replace .text-content").first();
    const last = right.locator("tr.replace, tr.insert").nth(2).locator(".text-content");
    await dragSelect(page, first, last);
    await sleep(500);
    await moveTo(cur.x - 50, cur.y - 8, 250);
    xdo("click", 3);
    await page.waitForSelector(".diff-context-menu-item");
    await sleep(700);
    await click(page.locator(".diff-context-menu-item"), 350);
    await caption(page, "Copied (only from the B side)");
    await sleep(1400);
    await caption(page, "Click a line number to select the whole line");
    const gutter = serverDiff().locator(".left-pane tbody > tr:not(.gap) td").first();
    await click(gutter, 500);
    await sleep(700);
    await caption(page, "Click in a side, then…");
    const text = serverDiff().locator(".left-pane tbody > tr.equal .text-content").nth(3);
    await click(text, 500);
    await sleep(600);
    await caption(page, "<kbd>Ctrl</kbd> + <kbd>A</kbd> selects that whole side");
    await sleep(400);
    xdo("key", "ctrl+a");
    await sleep(1600);
    await caption(page, "");
  } },

  // Guide: expand a collapsed gap in place, then collapse it again.
  gaps: { size: [1024, 640], setup: { compare: true }, prep: scrollToServerDiff, async run() {
    await sleep(500);
    const gap = serverDiff().locator(".left-pane .gap-toggle", { hasText: "39 unchanged" }).first();
    await click(gap, 600);
    await sleep(1300);
    await moveTo(cur.x, cur.y + 160, 500);
    xdo("click", "--repeat", "4", "--delay", "40", 5);
    await sleep(900);
    xdo("click", "--repeat", "4", "--delay", "40", 4);
    await sleep(400);
    const open = serverDiff().locator(".left-pane .gap-toggle", { hasText: "click to hide" }).first();
    await click(open, 600);
    await sleep(1500);
  } },

  // Guide: hover affordances of the folder path and the A/B file links (no clicks: OS windows).
  links: { size: [1024, 640], setup: { compare: true }, async run() {
    await hover(page.locator(".path-col-a .path-value"), 700, 0.35);
    await caption(page, "<kbd>Click</kbd> a folder path: opens it in Windows Explorer");
    await sleep(2600);
    const sum = page.locator(".file-diff summary").first();
    await hover(sum.locator(".path-side-link.side-a"), 600);
    await caption(page, "<kbd>Click</kbd> A or B: opens that copy in its default app");
    await sleep(2400);
    await hover(sum.locator(".path-side-link.side-b"), 400);
    await caption(page, "<kbd>Right-click</kbd> A or B: Windows \u201cOpen with\u201d (Just once / Always)");
    await sleep(2600);
    await caption(page, "");
    await sleep(300);
  } },

  // Guide: side-by-side vs unified, folding a file.
  views: { size: [1024, 640], setup: { compare: true }, async run() {
    await click(page.locator('.toggle-btn[data-view="unified"]'), 600);
    await sleep(1600);
    await click(page.locator('.toggle-btn[data-view="side-by-side"]'), 500);
    await sleep(1200);
    const sum = page.locator(".file-diff summary").first();
    await click(sum.locator(".name"), 500);
    await sleep(1100);
    xdo("click", 1);
    await sleep(1200);
  } },

  // Guide: Make B match A, the confirmation, the result toast.
  sync: { size: [1024, 640], setup: { compare: true }, async run() {
    await click(page.locator(".sync-btn", { hasText: "Make B match A" }), 700);
    await page.waitForSelector("#sync-confirm-dialog[open]");
    await sleep(1800);
    await click(page.locator("#sync-confirm-ok-btn"), 500);
    await page.waitForFunction(() => /Updated Folder B/.test(document.getElementById("info-toast-message").textContent));
    await moveTo(size[0] * 0.5, size[1] * 0.45, 400);
    await sleep(2600);
  } },
};

(async () => {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SCENES);
  for (const n of names) if (!SCENES[n]) throw new Error(`unknown scene ${n}; known: ${Object.keys(SCENES).join(", ")}`);
  await startServer();
  try {
    for (const n of names) {
      const scene = SCENES[n];
      await ensureBrowser(...scene.size);
      await freshState();
      await openApp(scene.setup);
      if (scene.prep) await scene.prep();
      try {
        await record(n, () => scene.run());
      } catch (e) {
        await page.screenshot({ path: path.join(WORK, `error-${n}.png`) }).catch(() => {});
        throw e;
      }
    }
  } finally {
    if (ctx) await ctx.close();
    if (server) server.kill();
    if (xvfb) xvfb.kill();
  }
})().catch((e) => { console.error(e); if (server) server.kill(); if (xvfb) xvfb.kill(); process.exit(1); });
