"use strict";

// Platform rule for relative-path identity: Windows filesystems are
// case-insensitive, so Readme.md and README.md name the same file there and
// must be paired; *nix keeps exact (case-sensitive) matching.
// SOCHA_PATH_CASE=insensitive|sensitive overrides the platform default (tests
// use it to exercise both modes on Linux; macOS users with a case-insensitive
// volume can opt in with it too).
function resolveCaseInsensitive(env = process.env, platform = process.platform) {
  const override = String(env.SOCHA_PATH_CASE || "").trim().toLowerCase();
  if (override === "insensitive") return true;
  if (override === "sensitive") return false;
  if (override) {
    console.warn(`Ignoring SOCHA_PATH_CASE="${env.SOCHA_PATH_CASE}" (use "insensitive" or "sensitive").`);
  }
  return platform === "win32";
}

const CASE_INSENSITIVE_PATHS = resolveCaseInsensitive();

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

// Key used wherever relative paths are matched or compared. Identity on *nix.
function pathKey(rel) {
  return CASE_INSENSITIVE_PATHS ? foldCase(rel) : rel;
}

function pathsEqual(a, b) {
  return pathKey(a) === pathKey(b);
}

module.exports = { CASE_INSENSITIVE_PATHS, resolveCaseInsensitive, foldCase, pathKey, pathsEqual };
