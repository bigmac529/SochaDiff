"use strict";

/**
 * Platform path-case rule: case-insensitive matching on Windows, exact on *nix.
 *
 * Run:  npm run test:pathcase
 *
 * Both modes are exercised on any OS through SOCHA_PATH_CASE=insensitive|sensitive:
 *   1. lib checks (pairing, only-in lists, whitespace-only, case clashes, Make
 *      match in both directions, delete guards) run in one child process per mode,
 *      since the mode is fixed when lib/path-case.js loads;
 *   2. HTTP checks start `node server.js` per mode and drive compare/sync;
 *   3. a browser check (Playwright) confirms both real names are displayed and
 *      each A/B link opens its own side's name. Soft-skipped when Playwright or
 *      its browsers are missing, like the other suites.
 *
 * Limits: on a case-sensitive filesystem (Linux), "insensitive" mode checks the
 * app's decisions (pairing, which on-disk path is written, what is never deleted)
 * but cannot make the filesystem alias Readme.md and README.md. The alias itself
 * is simulated with a hard link where a check needs the "same file under another
 * name" behavior.
 *
 * On a case-insensitive temp filesystem (Windows, default macOS) the suite runs
 * against real aliasing instead: checks that need two names differing only by
 * case in one folder (clashes, hard-link alias) are skipped, and sensitive-mode
 * Make match is checked for "no data lost" rather than an exact mirror.
 */

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const MODES = ["sensitive", "insensitive"];

// Does the temp filesystem treat names that differ only by case as one file?
function probeCaseInsensitiveFs() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "socha-pathcase-probe-"));
  try {
    fs.writeFileSync(path.join(dir, "probe"), "");
    return fs.existsSync(path.join(dir, "PROBE"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
const FS_INSENSITIVE = probeCaseInsensitiveFs();

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

// ---------- fixtures ----------

function write(root, rel, content) {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function read(root, rel) {
  try {
    return fs.readFileSync(path.join(root, ...rel.split("/")), "utf8");
  } catch {
    return null;
  }
}

function exists(root, rel) {
  return fs.existsSync(path.join(root, ...rel.split("/")));
}

// Exact directory listing (case-sensitive, unlike existsSync on Windows/macOS).
function listed(root, rel) {
  const parts = rel.split("/");
  const name = parts.pop();
  try {
    return fs.readdirSync(path.join(root, ...parts)).includes(name);
  } catch {
    return false;
  }
}

const BIN_A = Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]);
const BIN_B = Buffer.from([0x89, 0x50, 0x00, 0x09, 0x09]);

// Main fixture: names that differ only by case across A and B, plus ordinary
// entries that must behave the same in both modes.
function makeMainFixture(base) {
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  write(a, "Readme.md", "hello\n");
  write(b, "README.md", "world\n");
  write(a, "Same.txt", "same\n");
  write(b, "same.txt", "same\n");
  write(a, "Notes.md", "a b\n");
  write(b, "NOTES.md", "a  b\r\n");
  write(a, "Docs/guide.md", "one\n");
  write(b, "docs/guide.md", "two\n");
  write(a, "Docs/new.md", "new doc\n");
  write(a, "Logo.bin", BIN_A);
  write(b, "logo.BIN", BIN_B);
  write(a, "common.txt", "left\n");
  write(b, "common.txt", "right\n");
  write(a, "only-a.txt", "only a\n");
  write(b, "only-b.txt", "only b\n");
  return { a, b };
}

// Two files in one folder whose names differ only by case (possible on *nix
// trees or case-sensitive NTFS directories), plus a directory-level clash.
function makeClashFixture(base) {
  const a = path.join(base, "a");
  const b = path.join(base, "b");
  write(a, "dup.txt", "one\n");
  write(a, "DUP.txt", "two\n");
  write(b, "Dup.txt", "three\n");
  write(a, "Lib/x.js", "x1\n");
  write(a, "lib/x.js", "x2\n");
  write(a, "ok.txt", "ok A\n");
  write(b, "ok.txt", "ok B\n");
  return { a, b };
}

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `socha-pathcase-${prefix}-`));
}

const paths = (list) => list.map((f) => f.path);
const byPath = (list, p) => list.find((f) => f.path === p);

// ---------- lib checks (child process, one mode) ----------

function runLibChecks(mode) {
  const insensitive = mode === "insensitive";
  const pc = require("../lib/path-case");
  const compare = require("../lib/compare");
  const { compareFolders, syncFromComparison, hashFolder } = compare;
  const t = (name) => `[${mode}] ${name}`;
  const cleanup = [];

  try {
    assert(t("mode resolved from SOCHA_PATH_CASE"), pc.CASE_INSENSITIVE_PATHS === insensitive);
    assert(t("pathKey folds only in insensitive mode"), pc.pathKey("Docs/Readme.md") === (insensitive ? "DOCS/README.MD" : "Docs/Readme.md"));
    assert(t("pathsEqual follows the mode"), pc.pathsEqual("a/B.txt", "A/b.TXT") === insensitive);

    // ---- comparison ----
    let base = tmp("cmp");
    cleanup.push(base);
    let { a, b } = makeMainFixture(base);
    let r = compareFolders(a, b);
    assert(t("result.pathCase"), r.pathCase === mode, r.pathCase);
    assert(t("no case clashes in main fixture"), Array.isArray(r.caseConflicts) && r.caseConflicts.length === 0);
    assert(t("errors empty"), r.errors.length === 0, JSON.stringify(r.errors));
    assert(t("exact-name pair unchanged"), (() => {
      const f = byPath(r.differing, "common.txt");
      return f && !("pathA" in f) && !("pathB" in f);
    })());
    assert(t("plain only-in entries unchanged"),
      paths(r.onlyInA).includes("only-a.txt") && paths(r.onlyInB).includes("only-b.txt"));
    assert(t("new file under case-differing dir is only in A"), paths(r.onlyInA).includes("Docs/new.md"));

    if (insensitive) {
      const readme = byPath(r.differing, "Readme.md");
      assert(t("Readme.md/README.md paired as differing"), !!readme && readme.pathA === "Readme.md" && readme.pathB === "README.md", JSON.stringify(readme && { pathA: readme.pathA, pathB: readme.pathB }));
      const guide = byPath(r.differing, "Docs/guide.md");
      assert(t("case-differing directory paired"), !!guide && guide.pathB === "docs/guide.md");
      const same = byPath(r.identical, "Same.txt");
      assert(t("identical pair keeps both names"), !!same && same.pathB === "same.txt");
      const ws = byPath(r.whitespaceOnly, "Notes.md");
      assert(t("whitespace-only pair keeps both names"), !!ws && ws.pathB === "NOTES.md");
      const bin = byPath(r.binaryDiffering, "Logo.bin");
      assert(t("binary pair keeps both names"), !!bin && bin.pathB === "logo.BIN");
      assert(t("only-in lists hold only real one-sided files"),
        JSON.stringify(paths(r.onlyInA)) === JSON.stringify(["Docs/new.md", "only-a.txt"]) &&
        JSON.stringify(paths(r.onlyInB)) === JSON.stringify(["only-b.txt"]),
        JSON.stringify({ A: paths(r.onlyInA), B: paths(r.onlyInB) }));
      assert(t("summary counts"),
        r.summary.differing === 3 && r.summary.binaryDiffering === 1 && r.summary.identical === 1 &&
        r.summary.whitespaceOnly === 1 && r.summary.onlyInA === 2 && r.summary.onlyInB === 1,
        JSON.stringify(r.summary));
    } else {
      assert(t("case variants stay unpaired (only in A)"),
        ["Readme.md", "Same.txt", "Notes.md", "Docs/guide.md", "Logo.bin"].every((p) => paths(r.onlyInA).includes(p)),
        JSON.stringify(paths(r.onlyInA)));
      assert(t("case variants stay unpaired (only in B)"),
        ["README.md", "same.txt", "NOTES.md", "docs/guide.md", "logo.BIN"].every((p) => paths(r.onlyInB).includes(p)),
        JSON.stringify(paths(r.onlyInB)));
      assert(t("no pathA/pathB fields anywhere"),
        [...r.differing, ...r.identical, ...r.whitespaceOnly, ...r.binaryDiffering].every((f) => !("pathB" in f)));
      assert(t("summary counts"),
        r.summary.differing === 1 && r.summary.onlyInA === 7 && r.summary.onlyInB === 6 &&
        r.summary.whitespaceOnly === 0 && r.summary.identical === 0,
        JSON.stringify(r.summary));
    }

    // Whitespace-aware mode: the whitespace-only pair becomes a real difference.
    compare.setIgnoreWhitespace(false);
    r = compareFolders(a, b);
    compare.setIgnoreWhitespace(true);
    if (insensitive) {
      const notes = byPath(r.differing, "Notes.md");
      assert(t("whitespace-aware: pair moves to differing"), !!notes && notes.pathB === "NOTES.md" && r.whitespaceOnly.length === 0);
    } else {
      assert(t("whitespace-aware: still unpaired"), paths(r.onlyInA).includes("Notes.md") && paths(r.onlyInB).includes("NOTES.md"));
    }

    // A case-only rename changes the content hash (the Match safety check sees it).
    const before = hashFolder(b);
    fs.renameSync(path.join(b, "README.md"), path.join(b, "ReadMe.md"));
    assert(t("case-only rename changes the folder hash"), hashFolder(b) !== before);
    fs.renameSync(path.join(b, "ReadMe.md"), path.join(b, "README.md"));
    assert(t("renaming back restores the hash"), hashFolder(b) === before);

    // ---- Make B match A ----
    base = tmp("syncA");
    cleanup.push(base);
    ({ a, b } = makeMainFixture(base));
    r = compareFolders(a, b);
    let changes = syncFromComparison(r, a, b, "A");
    if (!insensitive && FS_INSENSITIVE) {
      // Real case-insensitive volume, exact matching (e.g. default macOS): the
      // copy lands on the existing case variant; the delete guard must keep it.
      // Read through the spelling that was written: FUSE volumes with unstable
      // inode numbers (exfat-fuse) can serve a stale page cache for the other one.
      assert(t("B match A (case-insensitive fs): README.md keeps A's content"),
        listed(b, "README.md") && read(b, "Readme.md") === "hello\n" && listed(b, "docs/guide.md") && read(b, "Docs/guide.md") === "one\n",
        JSON.stringify([read(b, "README.md"), read(b, "Readme.md"), read(b, "docs/guide.md"), read(b, "Docs/guide.md")]));
      assert(t("B match A (case-insensitive fs): variants not deleted, reported"),
        changes.errors.length === 5 && changes.errors.every((e) => /^Not deleted/.test(e.message)) &&
        JSON.stringify(changes.deleted) === JSON.stringify(["only-b.txt"]), JSON.stringify(changes));
      log("  - [sensitive] exact-mirror and Make A match B checks skipped: temp filesystem is case-insensitive");
    } else {
      assert(t("Make B match A: no errors"), changes.errors.length === 0, JSON.stringify(changes.errors));
      if (insensitive) {
        assert(t("B match A: README.md gets A's content"), read(b, "README.md") === "hello\n", JSON.stringify(read(b, "README.md")));
        assert(t("B match A: README.md keeps its casing (no Readme.md created)"), listed(b, "README.md") && !listed(b, "Readme.md"));
        assert(t("B match A: nothing deleted except the real B-only file"), JSON.stringify(changes.deleted) === JSON.stringify(["only-b.txt"]), JSON.stringify(changes.deleted));
        assert(t("B match A: updated lists target names"),
          ["README.md", "docs/guide.md", "logo.BIN", "common.txt"].every((p) => changes.updated.includes(p)) && changes.updated.length === 4,
          JSON.stringify(changes.updated));
        assert(t("B match A: docs/guide.md overwritten in place"), read(b, "docs/guide.md") === "one\n" && !listed(b, "Docs"));
        assert(t("B match A: new file lands in existing docs/"), read(b, "docs/new.md") === "new doc\n" && changes.created.includes("docs/new.md"), JSON.stringify(changes.created));
        assert(t("B match A: binary overwritten in place"), fs.readFileSync(path.join(b, "logo.BIN")).equals(BIN_A) && !listed(b, "Logo.bin"));
        assert(t("B match A: whitespace-only pair untouched"), read(b, "NOTES.md") === "a  b\r\n" && !listed(b, "Notes.md"));
        assert(t("B match A: identical pair untouched"), listed(b, "same.txt") && !listed(b, "Same.txt"));
      } else {
        assert(t("B match A: exact mirror of A's names (as before)"),
          read(b, "Readme.md") === "hello\n" && !listed(b, "README.md") && read(b, "Docs/guide.md") === "one\n" &&
          !listed(b, "docs/guide.md") && read(b, "Notes.md") === "a b\n" && !listed(b, "NOTES.md") && listed(b, "Same.txt") && !listed(b, "same.txt"));
        assert(t("B match A: deletes the case variants (as before)"),
          ["README.md", "same.txt", "NOTES.md", "docs/guide.md", "logo.BIN", "only-b.txt"].every((p) => changes.deleted.includes(p)) && changes.deleted.length === 6,
          JSON.stringify(changes.deleted));
      }
      assert(t("B match A: only-a.txt created, only-b.txt removed"), read(b, "only-a.txt") === "only a\n" && !exists(b, "only-b.txt"));
      r = compareFolders(a, b);
      assert(t("B match A: re-compare shows no remaining differences"),
        r.differing.length === 0 && r.binaryDiffering.length === 0 && r.onlyInA.length === 0 && r.onlyInB.length === 0,
        JSON.stringify(r.summary));
      if (insensitive) {
        const readme = byPath(r.identical, "Readme.md");
        assert(t("B match A: re-compare lists Readme.md/README.md as identical"), !!readme && readme.pathB === "README.md");
        assert(t("B match A: whitespace-only pair still whitespace-only"), r.whitespaceOnly.length === 1);
      }
    }

    // ---- Make A match B ----
    if (!insensitive && FS_INSENSITIVE) return;
    base = tmp("syncB");
    cleanup.push(base);
    ({ a, b } = makeMainFixture(base));
    r = compareFolders(a, b);
    changes = syncFromComparison(r, a, b, "B");
    assert(t("Make A match B: no errors"), changes.errors.length === 0, JSON.stringify(changes.errors));
    if (insensitive) {
      assert(t("A match B: Readme.md gets B's content, keeps its casing"), read(a, "Readme.md") === "world\n" && !listed(a, "README.md"));
      assert(t("A match B: Docs/guide.md overwritten in place"), read(a, "Docs/guide.md") === "two\n" && !listed(a, "docs"));
      assert(t("A match B: deletes only the A-only files"),
        JSON.stringify([...changes.deleted].sort()) === JSON.stringify(["Docs/new.md", "only-a.txt"]), JSON.stringify(changes.deleted));
    } else {
      assert(t("A match B: exact mirror of B's names (as before)"),
        read(a, "README.md") === "world\n" && !listed(a, "Readme.md") && read(a, "docs/guide.md") === "two\n");
    }
    r = compareFolders(a, b);
    assert(t("A match B: re-compare shows no remaining differences"),
      r.differing.length === 0 && r.binaryDiffering.length === 0 && r.onlyInA.length === 0 && r.onlyInB.length === 0,
      JSON.stringify(r.summary));

    // ---- case clashes inside one folder ----
    if (FS_INSENSITIVE) {
      log(`  - [${mode}] clash, alias and hard-link checks skipped: temp filesystem is case-insensitive`);
      return;
    }
    base = tmp("clash");
    cleanup.push(base);
    ({ a, b } = makeClashFixture(base));
    r = compareFolders(a, b);
    if (insensitive) {
      assert(t("clash: two conflicts reported"), r.caseConflicts.length === 2 && r.summary.caseConflicts === 2, JSON.stringify(r.caseConflicts));
      const dup = r.caseConflicts.find((c) => c.A.includes("dup.txt"));
      assert(t("clash: lists every name on both sides"), !!dup && JSON.stringify(dup.A) === JSON.stringify(["dup.txt", "DUP.txt"]) && JSON.stringify(dup.B) === JSON.stringify(["Dup.txt"]), JSON.stringify(dup));
      const errs = r.errors.map((e) => `${e.side}:${e.path}`).sort();
      assert(t("clash: one error per affected file, with its side"),
        JSON.stringify(errs) === JSON.stringify(["A:DUP.txt", "A:Lib/x.js", "A:dup.txt", "A:lib/x.js", "B:Dup.txt"]), JSON.stringify(errs));
      assert(t("clash: messages explain the skip"), r.errors.every((e) => /letter case/.test(e.message) && /Make match leaves/.test(e.message)));
      const all = [...r.onlyInA, ...r.onlyInB, ...r.differing, ...r.identical, ...r.whitespaceOnly, ...r.binaryDiffering];
      assert(t("clash: clashing names are in no category"), all.every((f) => !/^dup\.txt$|^lib\/x\.js$/i.test(f.path)), JSON.stringify(paths(all)));
      assert(t("clash: other files still compared"), !!byPath(r.differing, "ok.txt"));
    } else {
      assert(t("clash: none in sensitive mode"), r.caseConflicts.length === 0 && r.errors.length === 0);
      assert(t("clash: variants are ordinary only-in files"),
        ["dup.txt", "DUP.txt", "Lib/x.js", "lib/x.js"].every((p) => paths(r.onlyInA).includes(p)) && paths(r.onlyInB).includes("Dup.txt"));
    }
    for (const direction of ["A", "B"]) {
      ({ a, b } = makeClashFixture(fs.mkdtempSync(path.join(base, `d${direction}-`))));
      r = compareFolders(a, b);
      let threw = null;
      try {
        changes = syncFromComparison(r, a, b, direction);
      } catch (e) {
        threw = e;
      }
      assert(t(`clash: Make ${direction === "A" ? "B match A" : "A match B"} does not crash`), !threw && changes.errors.length === 0, threw ? threw.message : JSON.stringify(changes.errors));
      if (insensitive) {
        assert(t(`clash: direction ${direction} leaves clashing files alone`),
          read(a, "dup.txt") === "one\n" && read(a, "DUP.txt") === "two\n" && read(b, "Dup.txt") === "three\n" &&
          read(a, "Lib/x.js") === "x1\n" && read(a, "lib/x.js") === "x2\n" && !exists(b, "Lib") && !exists(b, "lib") &&
          !listed(b, "dup.txt") && !listed(b, "DUP.txt") && !listed(a, "Dup.txt"));
        assert(t(`clash: direction ${direction} still syncs other files`), read(a, "ok.txt") === read(b, "ok.txt"));
      }
    }

    // Source folders spelled two ways (distinct keys, so no clash) end up in ONE
    // target folder in insensitive mode, as they would on Windows.
    base = tmp("dirs");
    cleanup.push(base);
    a = path.join(base, "a");
    b = path.join(base, "b");
    write(a, "New/a.md", "a\n");
    write(a, "new/b.md", "b\n");
    fs.mkdirSync(b);
    changes = syncFromComparison(compareFolders(a, b), a, b, "A");
    assert(t("new folders: created without errors"), changes.errors.length === 0 && changes.created.length === 2, JSON.stringify(changes));
    assert(t(insensitive ? "new folders: both files share the first spelling" : "new folders: both spellings mirrored"),
      insensitive
        ? JSON.stringify(fs.readdirSync(b)) === JSON.stringify(["New"]) && read(b, "New/a.md") === "a\n" && read(b, "New/b.md") === "b\n"
        : JSON.stringify(fs.readdirSync(b).sort()) === JSON.stringify(["New", "new"]),
      JSON.stringify(fs.readdirSync(b)));

    // ---- delete guards ----
    // Simulate a case-insensitive volume (e.g. macOS APFS in sensitive mode): B's
    // "Readme.md" is another name for its README.md (a hard link here), and the
    // comparison lists only README.md, as a real case-insensitive listing would.
    base = tmp("alias");
    cleanup.push(base);
    a = path.join(base, "a");
    b = path.join(base, "b");
    write(a, "Readme.md", "hello\n");
    write(b, "README.md", "world\n");
    fs.linkSync(path.join(b, "README.md"), path.join(b, "Readme.md"));
    const synthetic = {
      differing: [], binaryDiffering: [], whitespaceOnly: [], identical: [],
      onlyInA: [{ path: "Readme.md" }], onlyInB: [{ path: "README.md" }],
    };
    changes = syncFromComparison(synthetic, a, b, "A");
    assert(t("alias guard: the aliased file is not deleted"), changes.deleted.length === 0 && listed(b, "README.md"), JSON.stringify(changes));
    assert(t("alias guard: target keeps the source content"), read(b, "README.md") === "hello\n");
    assert(t("alias guard: skip is reported as an error"), changes.errors.length === 1 && /Not deleted/.test(changes.errors[0].message), JSON.stringify(changes.errors));

    // Control: hard-linked files with unrelated names are still deleted as before.
    base = tmp("hardlink");
    cleanup.push(base);
    a = path.join(base, "a");
    b = path.join(base, "b");
    write(a, "x.txt", "new\n");
    write(b, "x.txt", "old\n");
    fs.linkSync(path.join(b, "x.txt"), path.join(b, "y.txt"));
    r = compareFolders(a, b);
    changes = syncFromComparison(r, a, b, "A");
    assert(t("hard link control: unrelated name deleted as before"),
      JSON.stringify(changes.deleted) === JSON.stringify(["y.txt"]) && changes.errors.length === 0 && read(b, "x.txt") === "new\n",
      JSON.stringify(changes));
  } finally {
    for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------- HTTP helpers ----------

function request(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      { host: "localhost", port, path: urlPath, method, timeout: 10000,
        headers: data ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } : {} },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(text) });
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

async function startServer(mode) {
  const port = await getEphemeralPort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "socha-diff-test-"));
  const server = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), SOCHA_NO_OPEN: "1", SOCHA_DATA_DIR: dataDir, SOCHA_PATH_CASE: mode },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = Date.now();
  for (;;) {
    try {
      await request(port, "GET", "/api/settings");
      break;
    } catch {
      if (Date.now() - start > 15000) throw new Error(`Server did not start on ${port}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return {
    port,
    stop() {
      server.kill("SIGTERM");
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

async function runHttpChecks(mode) {
  const insensitive = mode === "insensitive";
  const t = (name) => `[${mode}] http: ${name}`;
  const base = tmp("http");
  const srv = await startServer(mode);
  try {
    const { a, b } = makeMainFixture(base);
    let r = await request(srv.port, "POST", "/api/compare", { folderA: a, folderB: b });
    assert(t("compare 200 with pathCase"), r.status === 200 && r.body.pathCase === mode, `${r.status} ${r.body.pathCase}`);
    const readme = byPath(r.body.differing || [], "Readme.md");
    assert(t(insensitive ? "Readme.md paired with README.md" : "Readme.md unpaired"),
      insensitive ? !!readme && readme.pathB === "README.md" : !readme && paths(r.body.onlyInB).includes("README.md"));
    const hashes = r.body.contentHashes;
    r = await request(srv.port, "POST", "/api/sync/check", { folderA: a, folderB: b, contentHashes: hashes });
    assert(t("sync/check ok"), r.status === 200 && r.body.ok === true, JSON.stringify(r.body));
    if (!insensitive && FS_INSENSITIVE) {
      log("  - sync checks skipped: temp filesystem is case-insensitive");
      return;
    }
    r = await request(srv.port, "POST", "/api/sync", { folderA: a, folderB: b, direction: "A", contentHashes: hashes });
    assert(t("sync 200 without errors"), r.status === 200 && r.body.changes.errors.length === 0, JSON.stringify(r.body.changes || r.body));
    assert(t("B's readme holds A's content afterwards"), read(b, insensitive ? "README.md" : "Readme.md") === "hello\n");
    assert(t("fresh result has nothing left to sync"),
      r.body.result.summary.differing === 0 && r.body.result.summary.onlyInA === 0 && r.body.result.summary.onlyInB === 0,
      JSON.stringify(r.body.result && r.body.result.summary));
    // Case-only rename after Compare trips the stale-folder check.
    r = await request(srv.port, "POST", "/api/compare", { folderA: a, folderB: b });
    const fresh = r.body.contentHashes;
    const from = insensitive ? "README.md" : "Readme.md";
    fs.renameSync(path.join(b, from), path.join(b, "rEADME.md"));
    r = await request(srv.port, "POST", "/api/sync/check", { folderA: a, folderB: b, contentHashes: fresh });
    assert(t("case-only rename after Compare is reported as changed (409)"), r.status === 409, String(r.status));
  } finally {
    srv.stop();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ---------- browser checks ----------

async function runUiChecks() {
  let chromium;
  try {
    ({ chromium } = require("playwright"));
  } catch {
    log("  Playwright is not installed; soft-skipping UI checks.");
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    if (/Executable doesn't exist|browserType\.launch/i.test(String(err && err.message))) {
      log("  Playwright browsers are not installed; soft-skipping UI checks. Run: npx playwright install chromium");
      return;
    }
    throw err;
  }
  try {
    for (const mode of MODES) {
      const t = (name) => `[${mode}] ui: ${name}`;
      const base = tmp("ui");
      const srv = await startServer(mode);
      try {
        const { a, b } = makeMainFixture(base);
        const clash = FS_INSENSITIVE ? null : makeClashFixture(path.join(base, "clash"));
        const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
        const open = async (fa, fb) => {
          await page.goto(`http://localhost:${srv.port}/?a=${encodeURIComponent(fa)}&b=${encodeURIComponent(fb)}&run=1`);
          await page.waitForSelector("#results .summary");
        };
        await open(a, b);
        const info = await page.evaluate(() => {
          const rel = (href) => new URL(href, location.href).searchParams.get("relPath");
          const rowFor = (text) =>
            [...document.querySelectorAll("#results .file-list li, #results .file-diff > summary")].find(
              (row) => row.querySelector(".path, .name")?.textContent === text
            );
          const describe = (text) => {
            const row = rowFor(text);
            if (!row) return null;
            return {
              alt: row.querySelector(".path-case-alt")?.textContent || null,
              a: row.querySelector(".path-side-link.side-a") ? rel(row.querySelector(".path-side-link.side-a").href) : null,
              b: row.querySelector(".path-side-link.side-b") ? rel(row.querySelector(".path-side-link.side-b").href) : null,
            };
          };
          return {
            readme: describe("Readme.md"),
            README: describe("README.md"),
            guide: describe("Docs/guide.md"),
            same: describe("Same.txt"),
            common: describe("common.txt"),
            altCount: document.querySelectorAll(".path-case-alt").length,
          };
        });
        if (mode === "insensitive") {
          assert(t("differing row shows B's real name"), info.readme && info.readme.alt === "B: README.md", JSON.stringify(info.readme));
          assert(t("A link opens Readme.md, B link opens README.md"), info.readme && info.readme.a === "Readme.md" && info.readme.b === "README.md", JSON.stringify(info.readme));
          assert(t("directory casing shown and linked per side"), info.guide && info.guide.alt === "B: docs/guide.md" && info.guide.b === "docs/guide.md" && info.guide.a === "Docs/guide.md", JSON.stringify(info.guide));
          assert(t("identical row shows B's real name"), info.same && info.same.alt === "B: same.txt" && info.same.b === "same.txt", JSON.stringify(info.same));
          assert(t("no separate README.md row"), info.README === null);
        } else {
          assert(t("no case annotations"), info.altCount === 0, String(info.altCount));
          assert(t("only-in rows link their own side"), info.readme && info.readme.a === "Readme.md" && info.readme.b === null && info.README && info.README.b === "README.md" && info.README.a === null, JSON.stringify(info));
        }
        assert(t("exact-name row unchanged"), info.common && info.common.alt === null && info.common.a === "common.txt" && info.common.b === "common.txt", JSON.stringify(info.common));

        if (mode === "insensitive" && clash) {
          await open(clash.a, clash.b);
          const errs = await page.evaluate(() =>
            [...document.querySelectorAll("#results .file-list li")]
              .filter((li) => li.querySelector(".badge") && /letter case/.test(li.querySelector(".badge").textContent))
              .map((li) => ({
                path: li.querySelector(".path").textContent,
                a: !!li.querySelector(".side-a"),
                b: !!li.querySelector(".side-b"),
              }))
          );
          const dupB = errs.find((e) => e.path === "Dup.txt");
          const dupA = errs.find((e) => e.path === "DUP.txt");
          assert(t("clash errors listed"), errs.length === 5, JSON.stringify(errs));
          assert(t("clash error links only its own side"), dupB && dupB.b && !dupB.a && dupA && dupA.a && !dupA.b, JSON.stringify({ dupA, dupB }));
        }
        await page.close();
      } finally {
        srv.stop();
        fs.rmSync(base, { recursive: true, force: true });
      }
    }
  } finally {
    await browser.close();
  }
}

// ---------- main ----------

function runResolveChecks() {
  const { resolveCaseInsensitive, foldCase } = require("../lib/path-case");
  const quiet = console.warn;
  console.warn = () => {};
  try {
    assert("platform default: win32 is case-insensitive", resolveCaseInsensitive({}, "win32") === true);
    assert("platform default: linux is case-sensitive", resolveCaseInsensitive({}, "linux") === false);
    assert("platform default: darwin follows *nix (case-sensitive)", resolveCaseInsensitive({}, "darwin") === false);
    assert("override insensitive on linux", resolveCaseInsensitive({ SOCHA_PATH_CASE: " Insensitive " }, "linux") === true);
    assert("override sensitive on win32", resolveCaseInsensitive({ SOCHA_PATH_CASE: "sensitive" }, "win32") === false);
    assert("invalid override falls back to platform", resolveCaseInsensitive({ SOCHA_PATH_CASE: "bogus" }, "win32") === true);
  } finally {
    console.warn = quiet;
  }
  assert("foldCase: simple mapping only (ß is not SS)", foldCase("straße") !== foldCase("STRASSE") && foldCase("Straße") === foldCase("STRAßE"));
  assert("foldCase: non-ASCII letters fold", foldCase("Ärger/Ölé.txt") === foldCase("äRGER/öLÉ.TXT"));
}

async function main() {
  const child = process.argv.indexOf("--lib-checks");
  if (child !== -1) {
    runLibChecks(process.argv[child + 1]);
    process.stdout.write(`@@RESULT ${JSON.stringify({ pass: PASS.length, fail: FAIL.length })}\n`);
    process.exitCode = FAIL.length ? 1 : 0;
    return;
  }

  log("Socha Diff - platform path case (Windows: insensitive, *nix: sensitive)");
  log(`temp filesystem: case-${FS_INSENSITIVE ? "insensitive" : "sensitive"} (${os.tmpdir()})`);
  log("\n-- mode resolution --");
  runResolveChecks();

  for (const mode of MODES) {
    log(`\n-- lib: SOCHA_PATH_CASE=${mode} --`);
    const res = spawnSync(process.execPath, [__filename, "--lib-checks", mode], {
      cwd: ROOT,
      env: { ...process.env, SOCHA_PATH_CASE: mode },
      encoding: "utf8",
    });
    const out = res.stdout || "";
    const match = out.match(/^@@RESULT (.*)$/m);
    process.stdout.write(out.replace(/^@@RESULT .*\n?/m, ""));
    if (res.stderr) process.stdout.write(res.stderr);
    if (!match) {
      FAIL.push(`[${mode}] lib checks crashed`);
      log(`  \u2717 [${mode}] lib checks crashed (exit ${res.status})`);
      continue;
    }
    const counts = JSON.parse(match[1]);
    for (let i = 0; i < counts.pass; i++) PASS.push(`[${mode}] lib`);
    for (let i = 0; i < counts.fail; i++) FAIL.push(`[${mode}] lib`);
  }

  for (const mode of MODES) {
    log(`\n-- http: SOCHA_PATH_CASE=${mode} --`);
    await runHttpChecks(mode);
  }

  log("\n-- ui --");
  await runUiChecks();

  log(`\npassed: ${PASS.length}`);
  log(`failed: ${FAIL.length}`);
  if (FAIL.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
