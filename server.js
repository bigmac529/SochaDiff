"use strict";

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const express = require("express");
const {
  compareFolders,
  hashFolder,
  syncFromComparison,
  setIgnoredDirectories,
  getIgnoredDirectories,
  DEFAULT_IGNORED_DIRECTORIES,
  setIgnoreWhitespace,
  getIgnoreWhitespace,
  DEFAULT_IGNORE_WHITESPACE,
} = require("./lib/compare");

const app = express();
const STATE_FILE = path.join(__dirname, ".socha-diff-state.json");
const SETTINGS_FILE = path.join(__dirname, ".socha-diff-settings.json");

// Normalize a user-entered folder path: trim whitespace and one matching pair
// of surrounding quotes (Windows "Copy as path" pastes "C:\path").
function normalizeFolderPath(value) {
  let folder = typeof value === "string" ? value.trim() : "";
  if (folder.length >= 2 && (folder[0] === '"' || folder[0] === "'") && folder[folder.length - 1] === folder[0]) {
    folder = folder.slice(1, -1).trim();
  }
  return folder;
}

// Resolve relPath against folder, rejecting traversal outside it, and confirm
// the result is an accessible file. Shared by the open-file endpoints below.
function resolveFileTarget(folder, relPath) {
  const resolvedFolder = path.resolve(folder);
  const target = path.resolve(resolvedFolder, relPath);
  if (target !== resolvedFolder && !target.startsWith(resolvedFolder + path.sep)) {
    return { error: "Invalid file path." };
  }
  try {
    if (!fs.statSync(target).isFile()) return { error: "The path is not a file." };
  } catch {
    return { error: "The file does not exist or is not accessible." };
  }
  return { target };
}

function applyDefaultSettings() {
  setIgnoredDirectories(DEFAULT_IGNORED_DIRECTORIES);
  setIgnoreWhitespace(DEFAULT_IGNORE_WHITESPACE);
}

function currentSettings() {
  return {
    ignoredDirectories: getIgnoredDirectories(),
    ignoreWhitespace: getIgnoreWhitespace(),
  };
}

function loadSettings() {
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    setIgnoredDirectories(
      Array.isArray(settings.ignoredDirectories) ? settings.ignoredDirectories : DEFAULT_IGNORED_DIRECTORIES
    );
    setIgnoreWhitespace(
      typeof settings.ignoreWhitespace === "boolean" ? settings.ignoreWhitespace : DEFAULT_IGNORE_WHITESPACE
    );
    return;
  } catch {
    // Use defaults when settings have not been saved or cannot be read.
  }
  applyDefaultSettings();
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + "\n");
}

loadSettings();

function loadLastComparison() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    return {
      folderA: typeof state.folderA === "string" ? state.folderA : "",
      folderB: typeof state.folderB === "string" ? state.folderB : "",
    };
  } catch {
    return { folderA: "", folderB: "" };
  }
}

function saveLastComparison(folderA, folderB) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ folderA, folderB }, null, 2) + "\n");
  } catch (e) {
    console.error(`Could not save last comparison paths: ${e.message}`);
  }
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/last-comparison", (_req, res) => {
  res.json(loadLastComparison());
});

app.get("/api/settings", (_req, res) => {
  res.json(currentSettings());
});

// Lightweight existence check used by the folder inputs on blur. Resolved on
// the server's OS, so Windows paths work when the server runs on Windows.
// Always 200 with { exists, isDirectory }; permission problems add `error`.
app.get("/api/dir-exists", async (req, res) => {
  const folder = normalizeFolderPath(req.query.path);
  if (!folder) return res.status(400).json({ error: "Please provide a folder path." });
  try {
    const st = await fs.promises.stat(path.resolve(folder));
    res.json({ exists: true, isDirectory: st.isDirectory() });
  } catch (e) {
    const missing = ["ENOENT", "ENOTDIR", "EINVAL", "ENAMETOOLONG"].includes(e.code);
    const result = { exists: false, isDirectory: false };
    if (!missing) {
      result.error = e.code === "EACCES" || e.code === "EPERM" ? "EACCES" : e.code || "UNKNOWN";
    }
    res.json(result);
  }
});

app.get("/api/open-folder", (req, res) => {
  const folder = normalizeFolderPath(req.query.path);
  if (!folder) return res.status(400).json({ error: "Please provide a folder path." });
  if (process.platform !== "win32") {
    return res.status(400).json({ error: "Opening folders in Windows Explorer is only supported on Windows." });
  }

  try {
    if (!fs.statSync(folder).isDirectory()) {
      return res.status(400).json({ error: "The path is not a directory." });
    }
  } catch {
    return res.status(400).json({ error: "The folder does not exist or is not accessible." });
  }

  // explorer.exe routinely exits with a non-zero code even when it opens the
  // folder successfully, so its exit status isn't a reliable error signal.
  execFile("explorer.exe", [folder]);
  res.json({ ok: true });
});

app.get("/api/open-file", (req, res) => {
  const folder = typeof req.query.folder === "string" ? req.query.folder.trim() : "";
  const relPath = typeof req.query.relPath === "string" ? req.query.relPath.trim() : "";
  if (!folder || !relPath) return res.status(400).json({ error: "Please provide a folder and file path." });
  if (process.platform !== "win32") {
    return res.status(400).json({ error: "Opening files is only supported on Windows." });
  }

  const resolved = resolveFileTarget(folder, relPath);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  // cmd's `start` launches a file with its Windows-assigned default app, same
  // as double-clicking it in Explorer. The empty "" is the required window-title
  // placeholder so `start` doesn't mistake a quoted path for the title.
  execFile("cmd.exe", ["/c", "start", "", resolved.target]);
  res.json({ ok: true });
});

app.get("/api/open-file-with", (req, res) => {
  const folder = typeof req.query.folder === "string" ? req.query.folder.trim() : "";
  const relPath = typeof req.query.relPath === "string" ? req.query.relPath.trim() : "";
  if (!folder || !relPath) return res.status(400).json({ error: "Please provide a folder and file path." });
  if (process.platform !== "win32") {
    return res.status(400).json({ error: "Opening files is only supported on Windows." });
  }

  const resolved = resolveFileTarget(folder, relPath);
  if (resolved.error) return res.status(400).json({ error: resolved.error });

  // shell32's OpenAs_RunDLL entry point shows the native "Open With" picker.
  execFile("rundll32.exe", ["shell32.dll,OpenAs_RunDLL", resolved.target]);
  res.json({ ok: true });
});

app.post("/api/settings", (req, res) => {
  const names = req.body && req.body.ignoredDirectories;
  if (!Array.isArray(names) || names.some((name) => typeof name !== "string")) {
    return res.status(400).json({ error: "ignoredDirectories must be an array of folder names." });
  }

  const normalized = [...new Set(names.map((name) => name.trim().toLowerCase()).filter(Boolean))];
  if (normalized.some((name) => name.includes("/") || name.includes("\\") || name === "." || name === "..")) {
    return res.status(400).json({ error: "Excluded entries must be directory names, not paths." });
  }

  const ignoreWhitespace =
    typeof req.body.ignoreWhitespace === "boolean" ? req.body.ignoreWhitespace : getIgnoreWhitespace();

  try {
    setIgnoredDirectories(normalized);
    setIgnoreWhitespace(ignoreWhitespace);
    saveSettings(currentSettings());
    res.json(currentSettings());
  } catch (e) {
    res.status(500).json({ error: `Could not save settings: ${e.message}` });
  }
});

app.post("/api/settings/reset", (_req, res) => {
  try {
    applyDefaultSettings();
    fs.rmSync(SETTINGS_FILE, { force: true });
    res.json(currentSettings());
  } catch (e) {
    res.status(500).json({ error: `Could not reset settings: ${e.message}` });
  }
});

app.post("/api/compare", (req, res) => {
  const body = req.body || {};
  const folderA = normalizeFolderPath(body.folderA);
  const folderB = normalizeFolderPath(body.folderB);

  if (!folderA || !folderB) {
    return res.status(400).json({ error: "Please provide both folder paths." });
  }

  try {
    const result = compareFolders(folderA, folderB);
    saveLastComparison(folderA, folderB);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sync", (req, res) => {
  const body = req.body || {};
  const folderA = normalizeFolderPath(body.folderA);
  const folderB = normalizeFolderPath(body.folderB);
  const direction = body.direction === "A" || body.direction === "B" ? body.direction : "";
  const expectedHashes = body.contentHashes;

  if (!folderA || !folderB || !direction || !expectedHashes || typeof expectedHashes.A !== "string" || typeof expectedHashes.B !== "string") {
    return res.status(400).json({ error: "Please provide both folder paths and a valid sync direction." });
  }

  try {
    const currentHashes = { A: hashFolder(folderA), B: hashFolder(folderB) };
    if (currentHashes.A !== expectedHashes.A || currentHashes.B !== expectedHashes.B) {
      return res.status(409).json({ error: "The compared folders changed after the last comparison. Run Compare again before syncing." });
    }
    // Scope the sync to the current comparison categories so whitespace-ignored
    // (and identical) files are never modified.
    const result = compareFolders(folderA, folderB);
    const changes = syncFromComparison(result, folderA, folderB, direction);
    const updatedResult = compareFolders(folderA, folderB);
    res.json({ changes, result: updatedResult });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sync/check", (req, res) => {
  const body = req.body || {};
  const folderA = normalizeFolderPath(body.folderA);
  const folderB = normalizeFolderPath(body.folderB);
  const expectedHashes = body.contentHashes;

  if (!folderA || !folderB || !expectedHashes || typeof expectedHashes.A !== "string" || typeof expectedHashes.B !== "string") {
    return res.status(400).json({ error: "Please provide both folder paths and comparison hashes." });
  }

  try {
    const currentHashes = { A: hashFolder(folderA), B: hashFolder(folderB) };
    if (currentHashes.A !== expectedHashes.A || currentHashes.B !== expectedHashes.B) {
      return res.status(409).json({ error: "The compared folders changed after the last comparison. Run Compare again before syncing." });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
const HOST = "localhost";

app.listen(PORT, HOST, () => {
  // Bound to localhost only: the app reads arbitrary local paths, so it must
  // not be exposed to the network.
  console.log(`Socha Diff app running at http://${HOST}:${PORT}`);
});
