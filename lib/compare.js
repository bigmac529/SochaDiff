"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Diff = require("diff");

// Number of unchanged context lines to keep around each change.
const CONTEXT = 3;
// Files larger than this are compared byte-for-byte only (no line diff).
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
// How many bytes to sniff when guessing whether a file is binary.
const BINARY_SNIFF_BYTES = 8000;
// Abort the line diff if the edit distance grows beyond this (keeps huge,
// wildly different files from being pathologically slow).
const MAX_EDIT_LENGTH = 8000;
const DEFAULT_IGNORED_DIRECTORIES = [
  ".git",
  ".github",
  ".vs",
  ".vscode",
  "bin",
  "dist",
  "node_modules",
  "obj"
];
let ignoredDirectories = new Set(DEFAULT_IGNORED_DIRECTORIES);

function setIgnoredDirectories(names) {
  ignoredDirectories = new Set(
    names
      .filter((name) => typeof name === "string")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

function getIgnoredDirectories() {
  return [...ignoredDirectories].sort();
}

const DEFAULT_IGNORE_WHITESPACE = true;
let ignoreWhitespace = DEFAULT_IGNORE_WHITESPACE;

function setIgnoreWhitespace(value) {
  ignoreWhitespace = value !== false;
}

function getIgnoreWhitespace() {
  return ignoreWhitespace;
}

// Compare two lines honoring the current whitespace mode.
function linesEqual(a, b) {
  return ignoreWhitespace ? normalize(a) === normalize(b) : a === b;
}

// Collapse every run of whitespace to nothing. Two lines are considered equal
// when their non-whitespace content matches, so purely whitespace differences
// (indentation, spacing, blank-line padding, CRLF vs LF) are ignored.
function normalize(line) {
  return line.replace(/\s+/g, "");
}

// Split text into lines without inventing a trailing empty line for files that
// end in a newline.
function splitLines(text) {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "" && /\r?\n$/.test(text)) {
    lines.pop();
  }
  return lines;
}

// Split text into line contents plus the ending ("crlf"/"lf"/"") for each line.
function splitLineRecords(text) {
  const contents = splitLines(text);
  const endings = [];
  const re = /\r\n|\n/g;
  const eols = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    eols.push(m[0] === "\r\n" ? "crlf" : "lf");
  }
  for (let i = 0; i < contents.length; i++) {
    endings.push(i < eols.length ? eols[i] : "");
  }
  return { contents, endings };
}

// Recursively list regular files under `root`. Keys are POSIX-style relative
// paths so the two folders can be compared regardless of OS path separators.
function walkDir(root, errors) {
  const files = new Map();
  const stack = [""];
  while (stack.length) {
    const relDir = stack.pop();
    const absDir = relDir === "" ? root : path.join(root, relDir.split("/").join(path.sep));
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (e) {
      errors.push({ path: relDir || ".", message: `Cannot read directory: ${e.message}` });
      continue;
    }
    for (const dirent of entries) {
      const rel = relDir === "" ? dirent.name : `${relDir}/${dirent.name}`;
      if (dirent.isSymbolicLink()) continue; // don't follow symlinks
      if (dirent.isDirectory()) {
        if (ignoredDirectories.has(dirent.name.toLowerCase())) continue;
        stack.push(rel);
      } else if (dirent.isFile()) {
        const abs = path.join(root, rel.split("/").join(path.sep));
        let size = 0;
        try {
          size = fs.statSync(abs).size;
        } catch {
          /* size stays 0 */
        }
        files.set(rel, { abs, size });
      }
    }
  }
  return files;
}

// Hash sorted relative paths and file bytes while using the same walk exclusions.
function hashFiles(files) {
  const hash = crypto.createHash("sha256");
  for (const [rel, info] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(rel);
    hash.update("\0");
    hash.update(fs.readFileSync(info.abs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function hashFolder(root) {
  const errors = [];
  const files = walkDir(root, errors);
  if (errors.length) throw new Error(`Could not hash folder ${root}: ${errors[0].message}`);
  return hashFiles(files);
}

function isBinary(buffer) {
  const n = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

// Align two arrays of lines using a whitespace-insensitive comparator and turn
// the result into display rows. Consecutive delete+insert runs are zipped into
// "replace" rows so side-by-side output lines up nicely.
function buildRows(aLines, bLines) {
  const parts = Diff.diffArrays(aLines, bLines, {
    comparator: (l, r) => linesEqual(l, r),
    maxEditLength: MAX_EDIT_LENGTH,
  });
  if (!parts) return null; // edit distance exceeded

  const rows = [];
  let ai = 0;
  let bi = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part.added && !part.removed) {
      for (let k = 0; k < part.value.length; k++) {
        rows.push({
          type: "equal",
          leftNum: ai + 1,
          leftText: aLines[ai],
          rightNum: bi + 1,
          rightText: bLines[bi],
        });
        ai++;
        bi++;
      }
    } else if (part.removed) {
      const next = parts[i + 1];
      if (next && next.added) {
        const dels = part.value.length;
        const adds = next.value.length;
        const paired = Math.min(dels, adds);
        for (let k = 0; k < paired; k++) {
          rows.push({
            type: "replace",
            leftNum: ai + 1,
            leftText: aLines[ai],
            rightNum: bi + 1,
            rightText: bLines[bi],
          });
          ai++;
          bi++;
        }
        for (let k = paired; k < dels; k++) {
          rows.push({ type: "delete", leftNum: ai + 1, leftText: aLines[ai], rightNum: null, rightText: null });
          ai++;
        }
        for (let k = paired; k < adds; k++) {
          rows.push({ type: "insert", leftNum: null, leftText: null, rightNum: bi + 1, rightText: bLines[bi] });
          bi++;
        }
        i++; // consumed the following "added" part
      } else {
        for (let k = 0; k < part.value.length; k++) {
          rows.push({ type: "delete", leftNum: ai + 1, leftText: aLines[ai], rightNum: null, rightText: null });
          ai++;
        }
      }
    } else if (part.added) {
      for (let k = 0; k < part.value.length; k++) {
        rows.push({ type: "insert", leftNum: null, leftText: null, rightNum: bi + 1, rightText: bLines[bi] });
        bi++;
      }
    }
  }
  return rows;
}

// Replace long runs of unchanged lines that are far from any change with a
// single "gap" marker, keeping CONTEXT lines on either side of each change.
function collapseContext(rows, context = CONTEXT) {
  const keep = new Array(rows.length).fill(false);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].type !== "equal") {
      const from = Math.max(0, i - context);
      const to = Math.min(rows.length - 1, i + context);
      for (let j = from; j <= to; j++) keep[j] = true;
    }
  }
  const out = [];
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === "equal" && !keep[i]) {
      let j = i;
      while (j < rows.length && rows[j].type === "equal" && !keep[j]) j++;
      out.push({ type: "gap", count: j - i, rows: rows.slice(i, j) });
      i = j;
    } else {
      out.push(rows[i]);
      i++;
    }
  }
  return out;
}

function compareFile(rel, aInfo, bInfo, result) {
  let aBuf;
  let bBuf;
  try {
    aBuf = fs.readFileSync(aInfo.abs);
  } catch (e) {
    result.errors.push({ path: rel, message: `Cannot read file in A: ${e.message}` });
    return;
  }
  try {
    bBuf = fs.readFileSync(bInfo.abs);
  } catch (e) {
    result.errors.push({ path: rel, message: `Cannot read file in B: ${e.message}` });
    return;
  }

  const binary = isBinary(aBuf) || isBinary(bBuf);
  const tooBig = aBuf.length > MAX_TEXT_BYTES || bBuf.length > MAX_TEXT_BYTES;

  if (binary || tooBig) {
    if (aBuf.equals(bBuf)) {
      result.identicalCount++;
      result.identical.push({ path: rel });
    } else {
      result.binaryDiffering.push({
        path: rel,
        note: tooBig ? "large file — compared byte-for-byte" : "binary file — compared byte-for-byte",
        sizeA: aBuf.length,
        sizeB: bBuf.length,
      });
    }
    return;
  }

  const aText = aBuf.toString("utf8");
  const bText = bBuf.toString("utf8");
  if (aText === bText) {
    result.identicalCount++;
    result.identical.push({ path: rel });
    return;
  }

  // Authoritative test for a non-whitespace difference: strip every whitespace
  // character from each file and compare. If the remaining content matches, the
  // files differ only in whitespace (indentation, spacing, blank lines, line
  // endings) and are not reported as a difference.
  if (ignoreWhitespace && normalize(aText) === normalize(bText)) {
    result.whitespaceOnly.push({ path: rel });
    return;
  }

  const aRecords = splitLineRecords(aText);
  const bRecords = splitLineRecords(bText);
  const rawRows = buildRows(aRecords.contents, bRecords.contents);
  if (rawRows === null) {
    result.binaryDiffering.push({
      path: rel,
      note: "too many changes to display a line diff",
      sizeA: aBuf.length,
      sizeB: bBuf.length,
    });
    return;
  }

  const rows = ignoreWhitespace
    ? rawRows.filter((row) => {
        if (row.type === "delete") return normalize(row.leftText) !== "";
        if (row.type === "insert") return normalize(row.rightText) !== "";
        return true;
      })
    : rawRows;

  for (const row of rows) {
    if (row.leftNum != null) row.leftEnding = aRecords.endings[row.leftNum - 1] || "";
    if (row.rightNum != null) row.rightEnding = bRecords.endings[row.rightNum - 1] || "";
  }

  let changed = rows.some((r) => r.type !== "equal");
  if (!changed && ignoreWhitespace) {
    // Content matches once whitespace is ignored — a whitespace-only difference.
    result.whitespaceOnly.push({ path: rel });
    return;
  }
  if (!changed) {
    // Whitespace-sensitive mode: line contents match, so the only differences
    // are line endings; highlight those lines instead of hiding the file.
    for (const row of rows) {
      if ((row.leftEnding || "") !== (row.rightEnding || "")) row.type = "replace";
    }
    changed = rows.some((r) => r.type !== "equal");
  }

  const stats = { added: 0, removed: 0, changed: 0 };
  for (const r of rows) {
    if (r.type === "insert") stats.added++;
    else if (r.type === "delete") stats.removed++;
    else if (r.type === "replace") stats.changed++;
  }

  result.differing.push({
    path: rel,
    kind: "text",
    rows: collapseContext(rows),
    stats,
  });
}

function compareFolders(folderA, folderB) {
  const result = {
    folderA,
    folderB,
    generatedAt: new Date().toISOString(),
    onlyInA: [],
    onlyInB: [],
    differing: [],
    binaryDiffering: [],
    whitespaceOnly: [],
    identical: [],
    errors: [],
    identicalCount: 0,
  };

  for (const [label, folder] of [["A", folderA], ["B", folderB]]) {
    let st;
    try {
      st = fs.statSync(folder);
    } catch {
      throw new Error(`Folder ${label} not found or not accessible: ${folder}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`Folder ${label} is not a directory: ${folder}`);
    }
  }

  const aFiles = walkDir(folderA, result.errors);
  const bFiles = walkDir(folderB, result.errors);

  try {
    result.contentHashes = { A: hashFiles(aFiles), B: hashFiles(bFiles) };
  } catch (e) {
    result.errors.push({ path: ".", message: `Could not hash comparison folders: ${e.message}` });
  }

  const allPaths = new Set([...aFiles.keys(), ...bFiles.keys()]);
  const sorted = [...allPaths].sort((x, y) => x.localeCompare(y));

  for (const rel of sorted) {
    const a = aFiles.get(rel);
    const b = bFiles.get(rel);
    if (a && !b) {
      result.onlyInA.push({ path: rel, size: a.size });
    } else if (!a && b) {
      result.onlyInB.push({ path: rel, size: b.size });
    } else {
      compareFile(rel, a, b, result);
    }
  }

  result.summary = {
    filesInA: aFiles.size,
    filesInB: bFiles.size,
    onlyInA: result.onlyInA.length,
    onlyInB: result.onlyInB.length,
    differing: result.differing.length,
    binaryDiffering: result.binaryDiffering.length,
    whitespaceOnly: result.whitespaceOnly.length,
    identical: result.identicalCount,
    errors: result.errors.length,
  };

  return result;
}

// Apply only the changes reflected in a comparison result: overwrite differing
// and binary-differing files, create source-only files, and delete target-only
// files. Files ignored by the comparison (e.g. whitespace-only) are untouched.
function syncFromComparison(result, folderA, folderB, direction) {
  const sourceRoot = direction === "A" ? folderA : folderB;
  const targetRoot = direction === "A" ? folderB : folderA;
  const out = { created: [], updated: [], deleted: [], unchanged: [], errors: [] };

  const overwrite = [...(result.differing || []), ...(result.binaryDiffering || [])].map((f) => f.path);
  const sourceOnly = (direction === "A" ? result.onlyInA : result.onlyInB || []).map((f) => f.path);
  const targetOnly = (direction === "A" ? result.onlyInB : result.onlyInA || []).map((f) => f.path);

  for (const rel of new Set([...overwrite, ...sourceOnly])) {
    const relNative = rel.split("/").join(path.sep);
    const sourcePath = path.join(sourceRoot, relNative);
    const targetPath = path.join(targetRoot, relNative);
    let targetStat;
    try {
      targetStat = fs.lstatSync(targetPath);
    } catch (e) {
      if (e.code !== "ENOENT") {
        out.errors.push({ path: rel, message: `Cannot inspect target file: ${e.message}` });
        continue;
      }
    }

    if (targetStat && (targetStat.isDirectory() || targetStat.isSymbolicLink())) {
      out.errors.push({
        path: rel,
        message: "Target path is a directory or symbolic link; it was not replaced.",
      });
      continue;
    }

    try {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.copyFileSync(sourcePath, targetPath);
      (targetStat ? out.updated : out.created).push(rel);
    } catch (e) {
      out.errors.push({ path: rel, message: `Cannot sync file: ${e.message}` });
    }
  }

  for (const rel of targetOnly) {
    const targetPath = path.join(targetRoot, rel.split("/").join(path.sep));
    try {
      fs.unlinkSync(targetPath);
      out.deleted.push(rel);
    } catch (e) {
      out.errors.push({ path: rel, message: `Cannot delete file: ${e.message}` });
    }
  }

  return out;
}

module.exports = {
  compareFolders,
  hashFolder,
  syncFromComparison,
  setIgnoredDirectories,
  getIgnoredDirectories,
  DEFAULT_IGNORED_DIRECTORIES,
  setIgnoreWhitespace,
  getIgnoreWhitespace,
  DEFAULT_IGNORE_WHITESPACE,
  buildRows,
  collapseContext,
  splitLines,
  normalize,
};
