// Re-records the download page demo (site/assets/demo.*) from a REAL Socha Diff session.
// Linux only: needs Xvfb, xdotool, ffmpeg and Playwright Chromium (npx playwright install chromium).
//
//   Xvfb :77 -screen 0 1280x800x24 -nolisten tcp &
//   SOCHA_NO_OPEN=1 SOCHA_DATA_DIR=/tmp/socha-demo-data PORT=3917 node server.js &
//   node desktop/scripts/record-demo.js          # -> /tmp/socha-demo/raw.mkv (x11grab, 30 fps)
//   # encode (crop the 1px window edge; GIF 960px/12fps/64 colours; see desktop/README.md):
//   ffmpeg -ss 0.4 -i raw.mkv -vf "crop=1278:798:0:0,format=yuv420p" -c:v libvpx-vp9 -crf 38 -b:v 0 -an demo.webm
//   ffmpeg -ss 0.4 -i raw.mkv -vf "crop=1278:798:0:0,format=yuv420p" -c:v libx264 -preset veryslow -crf 28 -tune stillimage -movflags +faststart -an demo.mp4
//   ffmpeg -ss 0.4 -i raw.mkv -vf "crop=1278:798:0:0,fps=12,scale=960:-2:flags=lanczos,palettegen=max_colors=64:stats_mode=diff" pal.png
//   ffmpeg -ss 0.4 -i raw.mkv -i pal.png -lavfi "crop=1278:798:0:0,fps=12,scale=960:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 demo.gif
//
// Real X input via xdotool (so the real cursor shows); Playwright only launches the browser
// and reads element positions (kiosk window at 0,0, so page CSS px == screen px).
const path = require("path");
const fs = require("fs");
const REPO = path.resolve(__dirname, "..", "..");
const { chromium } = require(path.join(REPO, "node_modules", "playwright"));
const { execFileSync, spawn } = require("child_process");
const DISPLAY = process.env.DEMO_DISPLAY || ":77";
const URL = process.env.DEMO_URL || "http://127.0.0.1:3917/";
const WORK = process.env.DEMO_WORK || "/tmp/socha-demo";
const OUT = process.env.DEMO_OUT || path.join(WORK, "raw.mkv");
const STATE = path.join(process.env.DEMO_DATA_DIR || "/tmp/socha-demo-data", ".socha-diff-state.json");
const ROOT = path.join(REPO, "sample");
const env = { ...process.env, DISPLAY };
const xdo = (...args) => execFileSync("xdotool", args.map(String), { env });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cur = { x: 900, y: 560 };

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
async function box(page, locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("no box for " + locator);
  return b;
}
async function clickAt(x, y, ms) { await moveTo(x, y, ms); await sleep(120); xdo("click", 1); }
async function clickLoc(page, locator, ms = 500) {
  const b = await box(page, locator);
  await clickAt(b.x + b.width / 2, b.y + b.height / 2, ms);
}
async function wheelUntil(page, locator, targetTop, dir) {
  for (let i = 0; i < 60; i++) {
    const b = await locator.boundingBox();
    if (b && (dir > 0 ? b.y <= targetTop : b.y >= targetTop)) return;
    xdo("click", dir > 0 ? 5 : 4);
    await sleep(45);
  }
}
async function wheelToTop(page) {
  for (let i = 0; i < 80; i++) {
    if ((await page.evaluate(() => window.scrollY)) <= 0) return;
    xdo("click", "--repeat", "3", "--delay", "15", 4);
    await sleep(30);
  }
}

(async () => {
  fs.mkdirSync(WORK, { recursive: true });
  fs.rmSync(STATE, { force: true });   // start with empty Folder A/B inputs
  fs.rmSync(path.join(WORK, "profile"), { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(path.join(WORK, "profile"), {
    headless: false,
    viewport: null,
    ignoreDefaultArgs: ["--enable-automation"],
    args: ["--kiosk", "--window-position=0,0", "--window-size=1280,800", "--no-first-run",
      "--force-device-scale-factor=1", "--disable-features=Translate,MediaRouter", "--password-store=basic"],
    env,
  });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new globalThis.URL(URL).origin });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(URL);
  await page.waitForLoadState("networkidle");
  console.log("viewport", await page.evaluate(() => [innerWidth, innerHeight]));
  xdo("mousemove", cur.x, cur.y);
  await sleep(800);

  const ff = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-draw_mouse", "1", "-framerate", "30",
    "-video_size", "1280x800", "-i", DISPLAY, "-c:v", "libx264", "-preset", "ultrafast", "-crf", "10", "-pix_fmt", "yuv444p", OUT],
    { stdio: ["pipe", "inherit", "inherit"] });
  const t0 = Date.now();
  const mark = (s) => console.log(((Date.now() - t0) / 1000).toFixed(1) + "s", s);
  await sleep(900);

  // 1. Folder paths
  mark("type folder A");
  await clickLoc(page, page.locator("#folderA"), 650);
  await sleep(150);
  xdo("type", "--delay", "18", `${ROOT}/demo-a`);
  await sleep(250);
  mark("type folder B");
  await clickLoc(page, page.locator("#folderB"), 500);
  await sleep(150);
  xdo("type", "--delay", "18", `${ROOT}/demo-b`);
  await sleep(350);

  // 2. Compare
  mark("compare");
  await clickLoc(page, page.locator("#compare-btn"), 600);
  await page.waitForSelector(".file-diff");
  await sleep(1400);

  // 3. Scroll to src/server.js and expand the 39-line gap
  const serverDiff = page.locator(".file-diff", { hasText: "src/server.js" });
  const gap = serverDiff.locator(".gap-toggle", { hasText: "39 unchanged" }).first();
  mark("scroll to server.js");
  await moveTo(640, 520, 400);
  await wheelUntil(page, serverDiff.locator("summary"), 90, +1);
  await sleep(600);
  mark("expand gap");
  await clickLoc(page, gap, 600);
  await sleep(1100);

  // 4. Drag-select three lines in the B pane, then the app's own right-click Copy menu
  const right = serverDiff.locator(".right-pane");
  const first = right.locator("tr", { hasText: "if (item.stock + delta < 0)" }).locator(".text-content").first();
  await wheelUntil(page, first, 360, +1);
  await sleep(400);
  const last = right.locator("tr", { hasText: "return;" }).filter({ has: page.locator("td", { hasText: /^\s*57\s*$/ }) }).locator(".text-content").first();
  const a = await box(page, first);
  const bText = await last.evaluate((n) => {
    const r = document.createRange();
    r.selectNodeContents(n);
    const rects = [...r.getClientRects()].filter((q) => q.width > 0);
    const endRect = rects[rects.length - 1];
    return { right: endRect.right, y: endRect.top + endRect.height / 2 };
  });
  mark("drag select");
  await moveTo(a.x + 2, a.y + a.height / 2, 700);
  await sleep(200);
  xdo("mousedown", 1);
  const sx = cur.x, sy = cur.y, ex = Math.round(bText.right + 2), ey = Math.round(bText.y);
  for (let i = 1; i <= 40; i++) {
    const t = i / 40;
    xdo("mousemove", Math.round(sx + (ex - sx) * t), Math.round(sy + (ey - sy) * t));
    await sleep(22);
  }
  cur = { x: ex, y: ey };
  xdo("mouseup", 1);
  await sleep(500);
  mark("right-click copy");
  await moveTo(ex - 60, ey - 10, 300);
  await sleep(150);
  xdo("click", 3);
  await page.waitForSelector(".diff-context-menu-item");
  await sleep(600);
  await clickLoc(page, page.locator(".diff-context-menu-item"), 400);
  await sleep(900);
  const copied = await Promise.race([
    page.evaluate(() => navigator.clipboard.readText().catch((e) => "clipboard read failed: " + e.message)),
    sleep(1500).then(() => "(clipboard read timed out)"),
  ]);
  console.log("clipboard:", JSON.stringify(copied));

  // 5. Unified view
  mark("to top + unified");
  await moveTo(640, 400, 300);
  await wheelToTop(page);
  await sleep(500);
  await clickLoc(page, page.locator('.toggle-btn[data-view="unified"]'), 600);
  await sleep(1100);
  await moveTo(640, 520, 300);
  await wheelUntil(page, page.locator(".file-diff", { hasText: "src/pricing.js" }).locator("summary"), 110, +1);
  await sleep(1800);
  mark("done");

  ff.stdin.write("q");
  await new Promise((r) => ff.on("close", r));
  await ctx.close();
})().catch((e) => { console.error(e); process.exit(1); });
