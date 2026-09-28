"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Diff = require("diff");
const { CASE_INSENSITIVE_PATHS, foldCase, pathKey } = require("./path-case");

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
// paths (actual on-disk casing) so the two folders can be compared regardless
// of OS path separators. Pairing uses indexByKey below, which applies the
// platform's case rule.
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

// Index walked files by pathKey (the platform case rule). With case-insensitive
// paths, two files in one folder can share a key (a tree created on *nix or a
// case-sensitive NTFS directory); those keys are returned in `conflicts` and
// left out of `byKey` so they are never paired, overwritten or deleted.
function indexByKey(files) {
  const byKey = new Map();
  const conflicts = new Map();
  for (const [rel, info] of files) {
    const key = pathKey(rel);
    if (conflicts.has(key)) {
      conflicts.get(key).push(rel);
    } else if (byKey.has(key)) {
      conflicts.set(key, [byKey.get(key).rel, rel]);
      byKey.delete(key);
    } else {
      byKey.set(key, { ...info, rel });
    }
  }
  for (const rels of conflicts.values()) rels.sort((x, y) => x.localeCompare(y));
  return { byKey, conflicts };
}

// Result entry names for a paired file. `path` stays A's name; when the two
// sides' names differ (only possible by case, with case-insensitive paths),
// pathA/pathB carry each side's real on-disk name for display and file links.
function pairNames(relA, relB) {
  return relA === relB ? { path: relA } : { path: relA, pathA: relA, pathB: relB };
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

function compareFile(names, aInfo, bInfo, result) {
  let aBuf;
  let bBuf;
  try {
    aBuf = fs.readFileSync(aInfo.abs);
  } catch (e) {
    result.errors.push({ ...names, message: `Cannot read file in A: ${e.message}` });
    return;
  }
  try {
    bBuf = fs.readFileSync(bInfo.abs);
  } catch (e) {
    result.errors.push({ ...names, message: `Cannot read file in B: ${e.message}` });
    return;
  }

  const binary = isBinary(aBuf) || isBinary(bBuf);
  const tooBig = aBuf.length > MAX_TEXT_BYTES || bBuf.length > MAX_TEXT_BYTES;

  if (binary || tooBig) {
    if (aBuf.equals(bBuf)) {
      result.identicalCount++;
      result.identical.push({ ...names });
    } else {
      result.binaryDiffering.push({
        ...names,
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
    result.identical.push({ ...names });
    return;
  }

  // Authoritative test for a non-whitespace difference: strip every whitespace
  // character from each file and compare. If the remaining content matches, the
  // files differ only in whitespace (indentation, spacing, blank lines, line
  // endings) and are not reported as a difference.
  if (ignoreWhitespace && normalize(aText) === normalize(bText)) {
    result.whitespaceOnly.push({ ...names });
    return;
  }

  const aRecords = splitLineRecords(aText);
  const bRecords = splitLineRecords(bText);
  const rawRows = buildRows(aRecords.contents, bRecords.contents);
  if (rawRows === null) {
    result.binaryDiffering.push({
      ...names,
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

  if (!ignoreWhitespace) {
    // Whitespace-sensitive mode: a line whose contents match but whose ending
    // differs (CRLF vs LF, or a missing final newline) is a change. Promote it
    // whether or not the file has other content changes so the client can
    // highlight the ending instead of folding it into an unchanged gap.
    for (const row of rows) {
      if (row.type === "equal" && (row.leftEnding || "") !== (row.rightEnding || "")) row.type = "replace";
    }
  }

  const changed = rows.some((r) => r.type !== "equal");
  if (!changed && ignoreWhitespace) {
    // Content matches once whitespace is ignored — a whitespace-only difference.
    result.whitespaceOnly.push({ ...names });
    return;
  }

  const stats = { added: 0, removed: 0, changed: 0 };
  for (const r of rows) {
    if (r.type === "insert") stats.added++;
    else if (r.type === "delete") stats.removed++;
    else if (r.type === "replace") stats.changed++;
  }

  result.differing.push({
    ...names,
    kind: "text",
    rows: collapseContext(rows),
    stats,
    // Exact original per-side text: when ignoring whitespace, blank-only
    // insert/delete rows are filtered out of `rows` above and can't be
    // reconstructed from it, so "copy whole file" needs the source text directly.
    fullTextA: aText,
    fullTextB: bText,
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
    pathCase: CASE_INSENSITIVE_PATHS ? "insensitive" : "sensitive",
    caseConflicts: [],
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

  const aIndex = indexByKey(aFiles);
  const bIndex = indexByKey(bFiles);
  reportCaseConflicts(aIndex, bIndex, result);

  const allKeys = new Set([...aIndex.byKey.keys(), ...bIndex.byKey.keys()]);
  for (const c of result.caseConflicts) allKeys.delete(c.key);
  const displayName = (key) => (aIndex.byKey.get(key) || bIndex.byKey.get(key)).rel;
  const sorted = [...allKeys].sort((x, y) => displayName(x).localeCompare(displayName(y)));

  for (const key of sorted) {
    const a = aIndex.byKey.get(key);
    const b = bIndex.byKey.get(key);
    if (a && !b) {
      result.onlyInA.push({ path: a.rel, size: a.size });
    } else if (!a && b) {
      result.onlyInB.push({ path: b.rel, size: b.size });
    } else {
      compareFile(pairNames(a.rel, b.rel), a, b, result);
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
    caseConflicts: result.caseConflicts.length,
  };

  return result;
}

// Report keys that name several files in one folder when case is ignored.
// The whole key is skipped on BOTH sides: pairing the other side's file with
// either variant (or listing it as only-in and letting Make-match delete it)
// could destroy data. Each affected file gets an entry in `errors`.
function reportCaseConflicts(aIndex, bIndex, result) {
  const keys = new Set([...aIndex.conflicts.keys(), ...bIndex.conflicts.keys()]);
  for (const key of keys) {
    const sides = {};
    for (const [label, index] of [["A", aIndex], ["B", bIndex]]) {
      sides[label] = index.conflicts.get(key) || (index.byKey.has(key) ? [index.byKey.get(key).rel] : []);
    }
    result.caseConflicts.push({ key, A: sides.A, B: sides.B });
  }
  result.caseConflicts.sort((x, y) => (x.A[0] || x.B[0]).localeCompare(y.A[0] || y.B[0]));
  for (const conflict of result.caseConflicts) {
    for (const label of ["A", "B"]) {
      const rels = conflict[label];
      for (const rel of rels) {
        const message =
          rels.length > 1
            ? `Folder ${label} has ${rels.length} files whose names differ only by letter case (${rels.join(", ")}). ` +
              "Names are matched case-insensitively here, so they were skipped: not compared, and Make match leaves them alone."
            : `Skipped: Folder ${label === "A" ? "B" : "A"} has several files whose names differ only by letter case ` +
              `(${conflict[label === "A" ? "B" : "A"].join(", ")}). Not compared, and Make match leaves it alone.`;
        result.errors.push({ path: rel, side: label, message });
      }
    }
  }
}

// Map a source-relative path onto the target's existing on-disk casing, one
// segment at a time, when paths are case-insensitive. Windows would resolve
// Docs/new.md into an existing docs/ folder anyway; doing it explicitly keeps the
// behavior identical on case-sensitive NTFS directories and in the Linux tests
// (which simulate the mode), instead of creating a sibling "Docs" folder.
// Segments that don't exist yet keep the source's casing. `listings` caches
// directory listings for one sync; the caller drops entries it changes.
function resolveTargetCase(targetRoot, rel, listings) {
  if (!CASE_INSENSITIVE_PATHS) return rel;
  const out = [];
  let dir = targetRoot;
  let exists = true;
  for (const segment of rel.split("/")) {
    let name = segment;
    if (exists) {
      let entries = listings.get(dir);
      if (!entries) {
        try {
          entries = fs.readdirSync(dir);
          listings.set(dir, entries);
        } catch {
          exists = false;
        }
      }
      if (exists && !entries.includes(segment)) {
        const matches = entries.filter((entry) => pathKey(entry) === pathKey(segment));
        if (matches.length > 1) {
          throw new Error(
            `Target folder has several entries whose names differ only by letter case (${matches.join(", ")}).`
          );
        }
        if (matches.length === 1) name = matches[0];
        else exists = false;
      }
    }
    out.push(name);
    dir = path.join(dir, name);
  }
  return out.join("/");
}

// Stable file identity (device + inode / NTFS file index) or null when the
// filesystem doesn't provide one.
function fileId(absPath) {
  try {
    const st = fs.statSync(absPath, { bigint: true });
    return st.ino === 0n ? null : `${st.dev}:${st.ino}`;
  } catch {
    return null;
  }
}

// True when every segment of `rel` appears with exactly that spelling in its
// parent directory's listing. False means the filesystem resolved the name
// case-insensitively onto an entry spelled differently (e.g. writing
// Readme.md on a case-insensitive volume updated the existing README.md).
// Unreadable directories count as listed (no evidence of aliasing).
function isExactlyListed(root, rel) {
  let dir = root;
  for (const segment of rel.split("/")) {
    try {
      if (!fs.readdirSync(dir).includes(segment)) return false;
    } catch {
      return true;
    }
    dir = path.join(dir, segment);
  }
  return true;
}

// Apply only the changes reflected in a comparison result: overwrite differing
// and binary-differing files, create source-only files, and delete target-only
// files. Files ignored by the comparison (e.g. whitespace-only) are untouched.
//
// Case handling: a paired file whose names differ only by case is overwritten
// in place under the TARGET's existing name (its content becomes the source's;
// its casing is kept, like a normal Windows copy, and consistent with identical
// and whitespace-only pairs, which are never touched). A target-only file is
// never deleted when it could be the file just written: same pathKey, or (on
// any platform, e.g. a case-insensitive macOS volume in sensitive mode) a
// case-only name variant of a written file that the filesystem aliased (the
// written spelling isn't listed on disk) or that has the same file identity.
// On a case-sensitive filesystem neither holds, so deletions are unchanged.
function syncFromComparison(result, folderA, folderB, direction) {
  const fromA = direction === "A";
  const sourceRoot = fromA ? folderA : folderB;
  const targetRoot = fromA ? folderB : folderA;
  const sourceSide = fromA ? "pathA" : "pathB";
  const targetSide = fromA ? "pathB" : "pathA";
  const out = { created: [], updated: [], deleted: [], unchanged: [], errors: [] };

  const jobs = [];
  const seen = new Set();
  const addJob = (sourceRel, targetRel) => {
    const key = pathKey(sourceRel);
    if (seen.has(key)) return;
    seen.add(key);
    jobs.push({ sourceRel, targetRel });
  };
  for (const f of [...(result.differing || []), ...(result.binaryDiffering || [])]) {
    addJob(f[sourceSide] || f.path, f[targetSide] || f.path);
  }
  for (const f of (fromA ? result.onlyInA : result.onlyInB) || []) addJob(f.path, null);
  const targetOnly = ((fromA ? result.onlyInB : result.onlyInA) || []).map((f) => f.path);

  const writtenKeys = new Set();
  const writtenByFold = new Map(); // foldCase(target rel) -> target rels written
  const listings = new Map();

  for (const job of jobs) {
    const rel = job.sourceRel;
    let targetRel;
    try {
      targetRel = job.targetRel || resolveTargetCase(targetRoot, rel, listings);
    } catch (e) {
      out.errors.push({ path: rel, message: `Cannot sync file: ${e.message}` });
      continue;
    }
    const sourcePath = path.join(sourceRoot, rel.split("/").join(path.sep));
    const targetPath = path.join(targetRoot, targetRel.split("/").join(path.sep));
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
      (targetStat ? out.updated : out.created).push(targetRel);
      writtenKeys.add(pathKey(targetRel));
      const fold = foldCase(targetRel);
      writtenByFold.set(fold, [...(writtenByFold.get(fold) || []), targetRel]);
      if (!targetStat) {
        // A new file (and maybe new folders) changed these listings.
        for (let dir = path.dirname(targetPath); dir.length >= targetRoot.length; dir = path.dirname(dir)) {
          listings.delete(dir);
          if (dir === path.dirname(dir)) break;
        }
      }
    } catch (e) {
      out.errors.push({ path: rel, message: `Cannot sync file: ${e.message}` });
    }
  }

  for (const rel of targetOnly) {
    const targetPath = path.join(targetRoot, rel.split("/").join(path.sep));
    if (writtenKeys.has(pathKey(rel))) {
      out.errors.push({
        path: rel,
        message: "Not deleted: its name matches a file that was just written when letter case is ignored.",
      });
      continue;
    }
    // Case-only variants of written files are rare; check them lazily.
    const variants = writtenByFold.get(foldCase(rel));
    if (variants) {
      const id = fileId(targetPath);
      const writtenPath = (w) => path.join(targetRoot, w.split("/").join(path.sep));
      const aliased = variants.some((w) => !isExactlyListed(targetRoot, w));
      if (aliased || (id && variants.some((w) => fileId(writtenPath(w)) === id))) {
        out.errors.push({
          path: rel,
          message:
            "Not deleted: it is the same file on disk as one that was just written (the filesystem ignores letter case).",
        });
        continue;
      }
    }
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
  CASE_INSENSITIVE_PATHS,
  pathKey,
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
