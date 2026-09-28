"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

// Whether relative paths are matched ignoring letter case is decided per
// comparison from the REAL filesystem behavior of each compare root, not from
// the OS: macOS volumes are usually case-insensitive, Linux can mount exFAT/FAT
// volumes, and Windows can mark NTFS directories case-sensitive.
//
// SOCHA_PATH_CASE=auto (default) | insensitive | sensitive. A fixed value wins
// over detection for both roots.
function pathCaseSetting(env = process.env) {
  const value = String(env.SOCHA_PATH_CASE || "").trim().toLowerCase();
  if (value === "insensitive" || value === "sensitive" || value === "auto") return value;
  if (value) console.warn(`Ignoring SOCHA_PATH_CASE="${env.SOCHA_PATH_CASE}" (use auto, insensitive or sensitive).`);
  return "auto";
}

const PATH_CASE_SETTING = pathCaseSetting();

// Last-resort guess when nothing on disk can be probed.
function platformDefault(platform = process.platform) {
  return platform === "win32" || platform === "darwin" ? "insensitive" : "sensitive";
}

const ASCII_LETTER = /[A-Za-z]/;

function swapAsciiCase(name) {
  return name.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
}

function lstatBig(p) {
  return fs.lstatSync(p, { bigint: true });
}

// Probe one directory without writing: take an existing entry whose name has
// ASCII letters and look up its case-swapped spelling. Returns "insensitive",
// "sensitive", or null when no entry gives an answer.
//  - swapped spelling missing              -> sensitive
//  - both spellings listed as entries      -> sensitive (an insensitive folder can't hold both)
//  - swapped spelling resolves, not listed -> insensitive (the lookup ignored case).
//    Checked by listing rather than inode alone because some filesystems
//    (e.g. exfat-fuse) hand out a new inode number per lookup.
function probeDirectory(dir, preferName) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const listed = new Set(names);
  const candidates = [...new Set([...(preferName ? [preferName] : []), ...names.slice().sort()])].filter(
    (name) => ASCII_LETTER.test(name) && listed.has(name)
  );
  for (const name of candidates) {
    const swapped = swapAsciiCase(name);
    if (listed.has(swapped)) return "sensitive";
    let original;
    let alternate;
    try {
      original = lstatBig(path.join(dir, name));
    } catch {
      continue; // vanished or unreadable; try another entry
    }
    try {
      alternate = lstatBig(path.join(dir, swapped));
    } catch (e) {
      if (e.code === "ENOENT" || e.code === "ENOTDIR") return "sensitive";
      continue;
    }
    const sameId = original.ino !== 0n && original.dev === alternate.dev && original.ino === alternate.ino;
    const sameShape =
      original.isDirectory() === alternate.isDirectory() &&
      original.isFile() === alternate.isFile() &&
      original.size === alternate.size;
    if (sameId || sameShape) return "insensitive";
  }
  return null;
}

// Write probe in a fresh folder under the OS temp directory (never in a compare
// root). Only meaningful when that temp folder is on the same volume.
function writeProbe(baseDir) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(baseDir, "socha-case-probe-"));
    fs.writeFileSync(path.join(dir, "probe"), "");
    return fs.existsSync(path.join(dir, "PROBE")) ? "insensitive" : "sensitive";
  } catch {
    return null;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Detect how the folder at `root` treats letter case. Scope: the root folder
// itself (subfolders on another mount or with a different NTFS per-directory
// flag are not probed separately; the sync guards check real aliasing on disk
// for every file they touch, so a mismatch there can't lose data).
//   1. an entry of `root`;
//   2. `root`'s own name via its parent, then further ancestors, as long as
//      they are on the same volume (same st.dev);
//   3. a write probe under os.tmpdir() when it is on the same volume;
//   4. the platform default (win32/darwin insensitive, others sensitive).
function detectPathCase(root, options = {}) {
  const setting = options.setting || PATH_CASE_SETTING;
  if (setting === "insensitive" || setting === "sensitive") return { mode: setting, method: "override" };

  const direct = probeDirectory(root);
  if (direct) return { mode: direct, method: "entry" };

  let rootDev = null;
  try {
    rootDev = fs.statSync(root, { bigint: true }).dev;
  } catch {
    /* unknown volume: skip the volume-bound fallbacks */
  }
  if (rootDev !== null) {
    let dir = path.resolve(root);
    for (;;) {
      const parent = path.dirname(dir);
      if (parent === dir) break;
      let parentDev;
      try {
        parentDev = fs.statSync(parent, { bigint: true }).dev;
      } catch {
        break;
      }
      if (parentDev !== rootDev) break;
      const answer = probeDirectory(parent, path.basename(dir));
      if (answer) return { mode: answer, method: "parent" };
      dir = parent;
    }
    const tmp = options.tmpdir || os.tmpdir();
    try {
      if (fs.statSync(tmp, { bigint: true }).dev === rootDev) {
        const answer = writeProbe(tmp);
        if (answer) return { mode: answer, method: "temp" };
      }
    } catch {
      /* no usable temp folder */
    }
  }
  return { mode: platformDefault(options.platform), method: "platform" };
}

// Uppercase with 1:1 (simple) mappings only, like NTFS's upcase table: a
// character whose full uppercase form expands (e.g. "ß" -> "SS") is kept, so
// "straße" and "STRASSE" are not treated as the same name.
function foldCase(value) {
  const upper = value.toUpperCase();
  if (upper.length === value.length) return upper;
  let out = "";
  for (const ch of value) {
    const u = ch.toUpperCase();
    out += u.length === ch.length ? u : ch;
  }
  return out;
}

// Key function used to match relative paths for one comparison.
function makePathKey(insensitive) {
  return insensitive ? foldCase : (rel) => rel;
}

module.exports = {
  PATH_CASE_SETTING,
  pathCaseSetting,
  platformDefault,
  swapAsciiCase,
  probeDirectory,
  detectPathCase,
  foldCase,
  makePathKey,
};
