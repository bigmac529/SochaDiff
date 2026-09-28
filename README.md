# Socha Diff

A small web app that shows **every non-whitespace difference between two folders**.
Whitespace-only changes — indentation, spacing, blank lines, and line endings
(CRLF vs LF) — are ignored, so you only see differences that actually change the
content.

## Features

- Enter two folder paths in a web form and click **Compare**.
- Recursively walks both folder trees.
- Ignores common version-control, dependency, cache, and build output folders
  by default, including `.git`, `bin`, `obj`, `node_modules`, `dist`, and
  `build`.
- Remembers the paths from the last successful comparison and restores them
  when the app starts.
- Classifies every file:
  - **Differing** — real, non-whitespace content differences (shown as a diff).
  - **Only in A / Only in B** — files present in just one folder.
  - **Whitespace-only (ignored)** — files that differ solely in whitespace.
  - **Binary / non-text that differ** — compared byte-for-byte.
  - **Identical** — same content.
- Switch each diff between **side-by-side** and **unified** views.
- Line-level highlighting: removals in red, additions in green; unchanged
  regions are collapsed with a context marker.

## How "non-whitespace difference" is decided

For two text files, all whitespace characters are stripped from each file and
the remainder compared. If the stripped content matches, the files differ only
in whitespace and are **not** reported as a difference (equivalent to
`git diff -w`, and also ignoring added/removed blank lines). The displayed line
diff uses a whitespace-insensitive comparator, so lines that differ only in
spacing are treated as unchanged.

## File name case

Socha Diff checks how each compared folder's filesystem treats letter case,
without writing to it. If **either** folder ignores case (Windows NTFS, macOS
APFS, exFAT/FAT drives), `Readme.md` in A and `README.md` in B are compared as
one file, and B's real name is shown next to A's. If both folders are case-sensitive
(typical Linux, case-sensitive NTFS directories), names are matched exactly.
**Make A/B match** overwrites such a pair in place, keeping the target's name
casing, and never deletes a file that is the one it just wrote. Set
`SOCHA_PATH_CASE=insensitive` or `sensitive` to override the detection
(default `auto`).

## Requirements

- Node.js 18+ (developed on Node 22).

## Install & run

```sh
cd socha-diff-app
npm install
npm start
```

`npm start` opens <http://localhost:3000> in your default browser once the
server is listening. Use `npm start -- --no-open` or set `SOCHA_NO_OPEN=1` to
skip that; plain `node server.js` never opens a browser.

The server binds to `127.0.0.1` only. It reads arbitrary local paths you type
in, so it is intentionally not exposed to the network. Set the `PORT`
environment variable to use a different port.

The last successful comparison paths are stored locally in
`.socha-diff-state.json` beside `server.js`. The file is ignored by Git and
is not served publicly.

## Try the included sample

The `sample/` folder contains `folder-a` and `folder-b` with one real
difference, one whitespace-only difference, files unique to each side, and a
differing binary file. Paste their full paths into the form, or open:

```
http://127.0.0.1:3000/?a=<full-path-to-sample/folder-a>&b=<full-path-to-sample/folder-b>&run=1
```

## Deep links

You can prefill and auto-run a comparison via query parameters:

- `a` — Folder A path
- `b` — Folder B path
- `run=1` — compare automatically on load
- `view=unified` — start in unified view (default is side-by-side)


## Selection smoke tests

Chaotic drag-path coverage for side-by-side selection (no cross-pane bleed, gap arming, blank rows, reverse drags):

```sh
npm run test:selection
```

Requires Playwright Chromium once (`npx playwright install chromium`). If browsers are missing, the script soft-skips with install instructions instead of failing the run. The harness starts `server.js` on an ephemeral port and uses `sample/sel-*` and `sample/blank-*` fixtures.

## Path case tests

```sh
npm run test:pathcase
```

Covers detection and every A/B combination (both case-sensitive, both
case-insensitive, mixed): pairing, the only-in lists, whitespace-only pairs, case
clashes and both Make match directions. Optional real-volume checks run when
`SOCHA_PATHCASE_INSENSITIVE_DIR` points to a folder on a case-insensitive volume
(and `SOCHA_PATHCASE_EMPTY_MOUNT` to an empty dedicated mount for the fallback
probe). The browser part soft-skips without Playwright.

## Project layout

```
socha-diff-app/
  server.js          Express server + /api/compare endpoint
  lib/compare.js     Folder walk + whitespace-insensitive diff logic
  public/
    index.html       Form and results container
    styles.css       Styling
    app.js            Client: fetch results, render diffs, toggle view
  sample/            Example folders to try
```
