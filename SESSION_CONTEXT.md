# Session Context — Socha Diff app

Handoff notes for continuing development in another IDE. Everything below reflects
the current, working state of the project.

## Current snapshot (verified 2026-09-12)

- Workspace root: `C:\Source\socha-diff`.
- The app is a local-only Node/Express web tool with a vanilla HTML/CSS/JS client.
- The comparison engine and sync behavior live in `lib/compare.js`; HTTP endpoints,
  settings persistence, and startup live in `server.js`.
- The browser UI is served directly from `public/`; there is no build step, bundler,
  framework, or generated frontend output.
- The active branch is `initial`, pushed to `origin/initial` at commit `2e722e8`
  (`Initial folder diff app`), based on the original `main` README commit.
- Current uncommitted user fixture changes are present in `sample/folder-a/README.md`,
  `sample/folder-a/src/util.js`, `sample/folder-b/README.md`, plus untracked `.vs/`.
  Preserve them; do not reset or revert them.

## 1. What this project is

A local web app that shows **every non-whitespace difference between two folders**.
The user enters two folder paths in a web form, clicks **Compare**, and gets a
categorized report with diffs. Whitespace-only changes (indentation, spacing,
blank lines, CRLF vs LF) are intentionally ignored.

Status: **complete and verified** (see §7). No known bugs outstanding.

## 2. Location & environment

- Project root: `C:\Source\socha-diff`
- OS developed on: Windows. Paths in examples use backslashes.
- Node.js: developed on **v22.21.1** (needs 18+). npm 10.
- Git is initialized. The published development snapshot is on `initial`; the worktree
  may contain fixture edits that are intentionally not committed yet.

## 3. Tech stack & dependencies

- **Node.js + Express** (`express` ^4.19.2) — static hosting + one JSON API route.
- **jsdiff** (`diff` ^5.2.0) — sequence diffing (`Diff.diffArrays` with a custom
  comparator).
- Vanilla HTML/CSS/JS front end (no build step, no framework, no bundler).

Install with `npm install` (creates `node_modules/`, already present locally).

## 4. How to run

```sh
cd C:\Source\socha-diff
npm install      # first time only
npm start        # => node server.js
```

Open http://127.0.0.1:3000. Override port with the `PORT` env var.
Server binds to `127.0.0.1` only (it reads arbitrary local paths, so it must not
be network-exposed).

Deep-link / auto-run query params on `/`:
- `a` = Folder A path, `b` = Folder B path
- `run=1` = compare automatically on load
- `view=unified` = start in unified view (default is side-by-side)

## 5. File layout

```
socha-diff/
  server.js            Express app: static files, comparison, settings, and sync APIs
  lib/compare.js       Walking, classification, line diffing, settings, and scoped sync
  public/
    index.html         Comparison form and in-page Settings dialog
    styles.css         Dark responsive layout, diff tables, whitespace marks, and controls
    app.js             Fetch/render logic, filtering, views, selection, settings, and session restore
  sample/
    folder-a/, folder-b/   Demo fixtures covering the comparison categories (see §8)
  .socha-diff-state.json     Git-ignored last successful paths, created at runtime
  .socha-diff-settings.json  Git-ignored persisted settings, created at runtime
  .gitignore             Runtime state, dependencies, and npm logs excluded from Git
  package.json           Dependencies and `npm start` script
  README.md            User-facing docs
  SESSION_CONTEXT.md   This file
```

## 6. Architecture & key design decisions

### Comparison flow (`lib/compare.js`)
1. `compareFolders(folderA, folderB)` validates both are directories, then
   `walkDir` recursively lists regular files in each (symlinks skipped; keys are
   POSIX-style relative paths for cross-OS comparison).
2. Union of relative paths is iterated (sorted). For each path:
   - present in only one side -> `onlyInA` / `onlyInB`
   - present in both -> `compareFile`
3. `compareFile`:
   - Reads both as Buffers. If either is **binary** (null byte in first 8000 bytes)
     or **too big** (> 5 MB), compares byte-for-byte -> identical or `binaryDiffering`.
   - Else decodes UTF-8. Exact match -> identical.
   - **Authoritative non-whitespace test:** `normalize(text)` strips *all*
     whitespace (`/\s+/g` -> ""). If stripped A === stripped B, the files differ
     only in whitespace -> `whitespaceOnly` (ignored). This is the core rule and
     also ignores added/removed blank lines (stricter than plain `git diff -w`).
   - Otherwise build display rows and record in `differing`.

### Line diff (`buildRows`)
- `Diff.diffArrays(aLines, bLines, { comparator: (l, r) => normalize(l) === normalize(r), maxEditLength })`.
- The comparator makes lines that differ only in whitespace count as equal, so
  they render as unchanged context.
- Adjacent removed+added runs are zipped into `replace` rows so side-by-side lines
  up. Leftover unmatched lines become `delete` / `insert`.
- Returns `null` if `maxEditLength` (8000) is exceeded -> file reported under
  `binaryDiffering` with note "too many changes to display a line diff".

### Context collapsing (`collapseContext`)
- Keeps `CONTEXT = 3` unchanged lines around each change; longer unchanged runs
  become a single `{ type: "gap", count }` row.

### Rendering (`public/app.js`)
- Server sends structured rows; the client renders both views from the same rows,
  so the **view toggle needs no re-fetch** (state in `lastResult` + `viewMode`).
- Side-by-side: 6 columns (numL, signL, textL, numR, signR, textR).
- Unified: 4 columns (numL, numR, sign, text); `replace` expands to a `-` row then
  a `+` row.
- All file content is inserted via `textContent` (no HTML injection).

## 7. Data contracts (so a new client/consumer can rely on them)

### `POST /api/compare`
Request JSON: `{ "folderA": "<path>", "folderB": "<path>" }`
Success 200 -> result object. Failure 400 -> `{ "error": "<message>" }`.

### Result object
```jsonc
{
  "folderA": "...", "folderB": "...", "generatedAt": "ISO-8601",
  "onlyInA":  [ { "path": "rel/path", "size": 123 } ],
  "onlyInB":  [ { "path": "rel/path", "size": 123 } ],
  "differing":[ { "path": "rel/path", "kind": "text",
                  "rows": [ /* row objects, see below */ ],
                  "stats": { "added": 1, "removed": 0, "changed": 2 } } ],
  "binaryDiffering": [ { "path": "...", "note": "...", "sizeA": 7, "sizeB": 7 } ],
  "whitespaceOnly":  [ { "path": "..." } ],
  "errors":          [ { "path": "...", "message": "..." } ],
  "identicalCount": 1,
  "summary": { "filesInA": 5, "filesInB": 5, "onlyInA": 1, "onlyInB": 1,
               "differing": 1, "binaryDiffering": 1, "whitespaceOnly": 1,
               "identical": 1, "errors": 0 }
}
```

### Row objects (in `differing[].rows`)
- `{ "type": "equal",   "leftNum": n, "leftText": "...", "rightNum": n, "rightText": "..." }`
- `{ "type": "delete",  "leftNum": n, "leftText": "...", "rightNum": null, "rightText": null }`
- `{ "type": "insert",  "leftNum": null, "leftText": null, "rightNum": n, "rightText": "..." }`
- `{ "type": "replace", "leftNum": n, "leftText": "...", "rightNum": n, "rightText": "..." }`
- `{ "type": "gap",     "count": n }`  // collapsed unchanged lines

### `lib/compare.js` exports
`compareFolders`, `buildRows`, `collapseContext`, `splitLines`, `normalize`.

### Tunable constants (top of `lib/compare.js`)
`CONTEXT=3`, `MAX_TEXT_BYTES=5MB`, `BINARY_SNIFF_BYTES=8000`, `MAX_EDIT_LENGTH=8000`.

## 8. Verification already done (all passing)

- Unit-ran `compareFolders` against `sample/` — correct bucketing.
- `POST /api/compare` returns expected summary; bad paths return 400 with a clear
  message (`Folder A not found or not accessible: ...`).
- Headless-Chrome screenshots of both **side-by-side** and **unified** views
  rendered correctly.

Sample fixtures deliberately cover: identical file (`README.md`), whitespace-only
diff (`src/util.js` — spacing + an extra blank line), real diff (`src/app.js`),
`only-a.txt`, `only-b.txt`, and a differing binary (`assets/logo.bin`).

Quick manual re-check from the project root:
```sh
node -e "console.log(require('./lib/compare').compareFolders('sample/folder-a','sample/folder-b').summary)"
```

## 9. Known limitations

- Replacement rows also have character-level highlighting; extremely large lines
  use a cheaper fallback instead of a full character-level matrix.
- Text assumed **UTF-8**; other encodings may mis-render (still safe — binary
  files are detected and skipped).
- Symlinks are skipped (no following, avoids cycles).
- No automated test suite yet — verification has been manual/ad-hoc.
- No auth/rate limiting by design (localhost-only tool).

## 10. Suggested next steps

- Add **word-level highlighting** within `replace` rows (e.g., `Diff.diffWords`
  ignoring whitespace; compute on the server and send highlight spans).
- Add a **file tree / jump-to-file** navigation sidebar for large result sets.
- Options UI: toggle "ignore blank lines", configurable context size, and
  include/exclude glob filters.
- **Export** the report (HTML/JSON) and/or a "copy path" affordance.
- Add an automated test suite (`node --test` against `lib/compare.js`), plus a
  Playwright/Puppeteer smoke test for the two views.
- Optionally a native folder picker (would require the File System Access API and
  moving comparison client-side, or an Electron shell).

## 12. How the app was created (session-derived process)

The implementation was built incrementally around the smallest useful vertical
slice, then expanded after each behavior was manually checked:

1. **Scaffold the local tool.** Create a CommonJS Node project with Express and
  `diff`, add `npm start`, bind the server to `127.0.0.1`, and serve `public/`.
2. **Build the comparison core.** Add recursive regular-file walking, POSIX-style
  relative paths, symlink skipping, missing-file buckets, identical detection,
  binary/large-file handling, and the authoritative whitespace normalization rule.
3. **Add readable diffs.** Use `Diff.diffArrays` with a line comparator, zip nearby
  delete/add runs into replacements, collapse distant context into expandable gap
  rows, and return a structured JSON result for the client.
4. **Create the first browser workflow.** Add folder-path inputs, the compare request,
  categorized result sections, side-by-side and unified renderers, safe
  `textContent` rendering, deep-link parameters, and sample fixtures for manual checks.
5. **Make comparison policy configurable.** Add runtime settings for ignored directory
  names and whitespace sensitivity, persist them in `.socha-diff-settings.json`, and
  expose load/save/reset endpoints. This also required explicit line-ending tracking
  so CRLF/LF changes appear when whitespace ignoring is disabled.
6. **Add safe synchronization.** Replace whole-folder mirroring with comparison-scoped
  sync: copy differing/binary files, create source-only files, delete target-only
  files, and leave identical or whitespace-only files untouched. Refuse directory or
  symlink replacement.
7. **Harden the UI for real comparisons.** Add filterable summary chips, the settings
  dialog and whitespace indicator, visible whitespace marks, bounded text selection
  and copy behavior, per-pane horizontal scrolling, click-to-expand gaps, lazy diff
  rendering, responsive wrapping, and small-result `sessionStorage` restoration.
8. **Verify each slice.** Use `node --check` for changed JavaScript, temporary Node
  scripts for settings/line-ending/gap/sync behavior, API checks for valid and invalid
  paths, and live browser checks for both views, the settings modal, large-result
  rendering, selection/overflow behavior, and the 480px layout.

### Runtime request flow

1. The browser loads saved paths from `/api/last-comparison`; URL parameters `a`, `b`,
  `run`, and `view` can override them.
2. Compare submits `{ folderA, folderB }` to `POST /api/compare`.
3. `server.js` calls `compareFolders`, saves successful paths, and returns the result.
4. `compareFolders` walks both trees, classifies every relative path, and delegates
  shared files to `compareFile`.
5. `app.js` stores the result in `lastResult`, renders the selected category/view,
  and can re-render without another request when only the view/filter changes.
6. Settings changes update the in-memory comparison policy and persist it for the next
  request. Sync recomputes before and after applying only comparison-scoped changes.

---

# 11. Session changelog (LATEST STATE — supersedes earlier sections on conflict)

> Sections §1–§10 above describe the ORIGINAL app. Many behaviors were extended or
> changed after that. Where they conflict, **this section is authoritative.** The
> app remains vanilla Node/Express + static HTML/CSS/JS, no build step.

## 11.1 New/changed files & artifacts

- `public/settings.html` and `public/settings.js` were **created then removed** —
  Settings is now an in-page modal (`<dialog>`) on `index.html`. Do not recreate them.
- Local, git-ignored state files (added to `.gitignore`):
  - `.socha-diff-state.json` — last successful comparison paths `{ folderA, folderB }`.
  - `.socha-diff-settings.json` — `{ ignoredDirectories: string[], ignoreWhitespace: boolean }`.
- `.vscode/settings.json` — sets `"cSpell.enabled": false` (disabled the Code Spell Checker for this workspace).

## 11.2 Server (`server.js`) — endpoints now

- `POST /api/compare` — `{ folderA, folderB }` → result object (see §11.6).
- `GET  /api/last-comparison` → `{ folderA, folderB }` (empty strings if none). Saved
  after each successful compare; the client restores these into the inputs on load.
- `GET  /api/settings` → `{ ignoredDirectories, ignoreWhitespace }`.
- `POST /api/settings` — body `{ ignoredDirectories: string[], ignoreWhitespace?: boolean }`.
  Validates names (must be dir names, not paths), lowercases + dedupes, persists, applies live.
- `POST /api/settings/reset` — reapplies defaults, deletes the settings file, returns current settings.
- `POST /api/sync` — `{ folderA, folderB, direction: "A"|"B" }`. Recomputes the comparison
  (honoring current settings), performs a **comparison-scoped** sync (§11.4), returns
  `{ changes, result }` where `result` is a fresh comparison.
- Settings load on startup via `loadSettings()`; helpers `applyDefaultSettings()`,
  `currentSettings()`, `saveSettings(settings)`.
- `GET  /api/dir-exists?path=...` → `{ exists, isDirectory }` via `fs.promises.stat`
  (resolved on the server's OS). ENOENT/ENOTDIR/EINVAL/ENAMETOOLONG → `exists:false`;
  EACCES/EPERM add `error:"EACCES"`, other failures add `error:<code>`. Empty path → 400.
- Browser auto-open: `npm start` runs `node server.js --open`; the `listen` callback opens
  `http://localhost:<actual port>` via the platform opener (`cmd /c start "" url`, `open`,
  `xdg-open`), spawned detached with errors ignored. Opt-in only (`--open` or
  `SOCHA_OPEN_BROWSER=1`); `--no-open` / `SOCHA_NO_OPEN=1` always win. Plain `node server.js`,
  embedded hosts and the test suites (which set `SOCHA_NO_OPEN=1`) never open a browser.
- `GET  /api/health` → `{ ok: true, app: "socha-diff", pid }`. Readiness probe for the
  desktop host (§14); `pid` lets the host confirm it reached its own child.
- `SOCHA_HOST` (optional) overrides the listen host (default `localhost`, unchanged). Only
  loopback values (`localhost`, `127.x.x.x`, `::1`) are accepted; anything else makes
  the server exit(1). The desktop host sets `127.0.0.1`.
- `normalizeFolderPath()` (trim + one matching pair of surrounding `"`/`'`) is applied to
  folder inputs in compare, sync, sync/check, open-folder and dir-exists, so pasted
  `"C:\path"` works everywhere.

## 11.3 Configurable exclusions & whitespace mode (`lib/compare.js`)

- **Excluded directories** are runtime-configurable. `walkDir` skips any dir whose
  lowercased name is in the active set. `DEFAULT_IGNORED_DIRECTORIES` currently:
  `.git .github .vs .vscode bin dist node_modules obj` (user trimmed the original
  longer list). Setters/getters: `setIgnoredDirectories(names)`, `getIgnoredDirectories()`.
- **Ignore-whitespace is a setting** (default `true`), not hardcoded.
  - `setIgnoreWhitespace(v)`, `getIgnoreWhitespace()`, `DEFAULT_IGNORE_WHITESPACE=true`.
  - `linesEqual(a,b)` = `ignoreWhitespace ? normalize(a)===normalize(b) : a===b`; used as the
    `buildRows` comparator.
  - `compareFile`: the whitespace-only shortcut (`normalize(aText)===normalize(bText) → whitespaceOnly`)
    is **guarded by `ignoreWhitespace`**. When whitespace is NOT ignored and line CONTENTS match but
    only line endings differ (CRLF vs LF / trailing newline), those rows are marked `replace` and the
    file goes to `differing` (previously it wrongly fell into `whitespaceOnly`).

## 11.4 "Make A/B match" buttons — comparison-scoped sync

- Old `syncFolders(source,target)` (full filesystem mirror) was **replaced** by
  `syncFromComparison(result, folderA, folderB, direction)`.
- It only touches files reflected in the comparison result:
  - overwrite `differing ∪ binaryDiffering` (source→target),
  - create source-only files (`onlyInA` for direction "A", else `onlyInB`),
  - delete target-only files (the opposite only-in set).
- **Never** touches `whitespaceOnly` or `identical`. So with ignore-whitespace ON,
  whitespace-only files are left alone; turn it OFF and they become `differing` and are included.
- Returns `{ created, updated, deleted, unchanged, errors }`. Refuses to overwrite a target
  that is a directory/symlink.

## 11.5 Per-line endings (CRLF vs LF)

- `splitLineRecords(text)` returns `{ contents, endings }` where each ending is
  `"crlf" | "lf" | ""`. `compareFile` attaches `leftEnding` / `rightEnding` to each row
  (indexed by `leftNum-1` / `rightNum-1`) before `collapseContext`.
- Rendered only when **Show whitespace** is on: LF → `↓` (U+2193), CRLF → `↵` (U+21B5),
  no trailing newline → no marker.
- **Differing endings are changes (whitespace-aware mode only).** `compareFile` promotes any
  equal-content row whose `leftEnding !== rightEnding` to `replace` whenever whitespace is
  NOT ignored, even when the file has other content changes (previously only when the
  whole file differed solely in endings, so mixed files folded EOL-only lines into gaps).
- Client: `eolDiffers(row)` (replace row, endings differ, `!currentIgnoreWhitespace`) adds
  `.eol-changed` to that row's EOL cell (see Newline below) on both views: under the
  `↵`/`↓` glyph with whitespace chars on, otherwise as the blank 1ch cell. It uses the changed-word
  emphasis (A red `rgba(255,120,120,.4)`, B green `rgba(112,224,145,.55)`; unified targets
  `tr.delete` / `tr.insert`). A side with no ending (missing final newline) gets no cell.
  Fixtures: `sample/eol-a|eol-b` (`crlf-vs-lf.txt`, `mixed.txt`), kept byte-exact by
  `.gitattributes` (`-text`).
- Tests: `tests/newline-selection.js` (run by `npm run test:selection` after the chaotic
  suite). All suites start `server.js` with a temp `SOCHA_DATA_DIR` so they use default
  settings and never rewrite the checkout's `.socha-diff-*.json`.

## 11.6 Result object — additions vs §7

- Now includes `identical: [ { path } ]` (a real list) **in addition to** `identicalCount`.
  The client renders an "Identical" section and the identical count chip is filterable.
- `differing[].rows` gap objects now carry the omitted lines:
  `{ type:"gap", count, rows:[ ...equal row objects... ] }` — used for click-to-expand.
- Row objects may include `leftEnding` / `rightEnding`.
- `result.differing`/etc. are initialized as arrays; the client also defensively
  normalizes them.
- `lib/compare.js` exports now: `compareFolders, syncFromComparison,
  setIgnoredDirectories, getIgnoredDirectories, DEFAULT_IGNORED_DIRECTORIES,
  setIgnoreWhitespace, getIgnoreWhitespace, DEFAULT_IGNORE_WHITESPACE, buildRows,
  collapseContext, splitLines, normalize` (note: `splitLineRecords` is internal).

## 11.7 Front-end (`public/index.html`, `app.js`, `styles.css`)

**Header**
- Left-of-Settings **whitespace indicator** (`#ws-indicator`, pilcrow `¶` badge):
  reads `/api/settings`; label "Whitespace ignored" (green) / "Whitespace aware" (amber);
  tooltip; **click or Enter/Space toggles** the setting (`toggleWhitespaceSetting`,
  `applyWhitespaceIndicator`, `refreshWhitespaceIndicator`).
- **Settings** is a `<button id="settings-open-btn">` opening a modal `<dialog id="settings-dialog">`.

**Settings modal**
- Contents: "Ignore whitespace differences" checkbox (`#ignore-whitespace`), a gap
  (`.settings-section-label { margin-top:16px }`), "Excluded folder names" textarea
  (`#ignored-directories`, one name per line), a status line, and **Reset to default**.
- **No Save button** — settings **auto-save**: checkbox on `change` (immediate), textarea
  on `input` (600 ms debounce) and on `change` (immediate). `populateSettings` fills fields
  on open; auto-save does NOT rewrite the textarea mid-edit. Closes via ×, backdrop click, or Esc.

**Folder path validation (blur)**
- `setupPathValidation` on `#folderA`/`#folderB`: on blur a non-empty (normalized) value
  calls `/api/dir-exists`; missing → `.path-invalid` + "Folder not found", file → "Not a
  folder", EACCES → "Access denied"; a directory gets a subtle `.path-valid` border.
  Messages render in `#folderX-status` on the label row (no layout shift). Typing clears
  the state; a per-input token drops stale responses. Advisory only: never blocks Compare.
- Test: `npm run test:paths` (`tests/path-validation.js`, own server on an ephemeral port).

**Count chips / filtering**
- Summary chips are buttons (`chip(className, category, n, label)`), `activeCategory`
  state; clicking filters to one category, clicking again clears; zero-count chips disabled.
  Categories: `differing, onlyInA, onlyInB, whitespaceOnly, binaryDiffering, identical, errors`.

**Diff rendering & views**
- Side-by-side is rendered as **two separate `<table>` panes** inside `.side-by-side-view`
  (grid `minmax(0,1fr) minmax(0,1fr)`), left pane `.diff-pane.left-pane.select-scope`,
  right `.right-pane.select-scope`. Panes share the same `rows` so line indices align.
- Uniform row height (`.diff-table { line-height:1.5 }`, `.text-content { min-height:1.5em }`)
  keeps empty placeholder rows the same height as text rows so both panes and the
  "… N unchanged lines …" gap boxes line up exactly.
- **Non-wrapping** text (`white-space:pre`). Long lines are panned by a per-pane bottom
  scrollbar (`.diff-pan-scroll` + `.diff-pan-content` spacer). The spacer width = max
  `scrollWidth-clientWidth`; scrolling applies one uniform `translateX(-offset)` to every
  `.text-content` in that pane (whole-pane pan, not per-line). Side-by-side has TWO
  independent bars aligned under each pane (grid `64px minmax(0,1fr) 64px minmax(0,1fr)`,
  bars in cols 2 & 4); a bar hides when its pane has no overflow. Scrollbars are minimal/
  translucent, reserved space, thumb visible on hover.
- Unified view (`.diff-table.unified-diff`) has **text selection disabled**.

**Selection & copy**
- Selection is constrained to the `.select-scope` where the drag began
  (`selectionScope`, `scopeOf`, `selectionchange` clamp) — cannot cross A/B or files or page.
- Copy handler writes `text/plain`; line terminators follow the Newline rules below; whitespace is verbatim (whitespace glyphs are CSS
  `::before/::after`, not real text).
- **Auto-scroll while selecting**: dragging near a pane edge advances that pane's bar and
  extends the selection via `caretRangeFromPoint` (`autoScrollStep`, `EDGE=24`, `MAX_STEP=6`,
  `SPEED=0.15` — intentionally slow).

**Newline as a selectable character** (supersedes "copy always appends the EOL")
- Every line with a CRLF/LF ends in `span.eol` holding one real NBSP (`appendEolCell`,
  cloned from `eolCellProto`), in side-by-side, unified and gap-expanded rows. With
  whitespace chars on it is also `.ws-eol` and the glyph is `::after`, absolutely
  positioned over the NBSP so the cell stays 1ch. A line with no final newline has no
  cell. `lineTextFromContent` / `eolCellOf` strip the cell; never read `.text-content`
  `textContent` directly for line text.
- Because the cell is real text, native caret hit-testing and `::selection` paint treat
  the newline like any character: drag to the end of the text (left half of the cell)
  → no newline; onto the cell's right half, past it, or onto the next line → newline.
  `isEolSelected` = both boundary points of the cell's NBSP are inside the range
  (`Range.comparePoint`).
- Copy (`copyDiffSelection`): a line's terminator is emitted exactly when its cell is
  selected, using that line's own ending from `tr.dataset.ending` (`\r\n` or `\n`, the
  existing `eolString` convention; never normalized). Single visible row →
  `singleRowCopyText` (selected character offsets + optional terminator). Multi-row keeps
  the whole-line convention for text, with the terminator per selected cell (so only the
  last row can lack it). Whole-pane manual drags use `fullSideText` but
  `trimUnselectedFinalEol` drops the last line's terminator when its cell is unselected
  and no trailing gap follows. Gutter click/drag and triple-click select the cell (line +
  newline); double-click a word does not. Ctrl+A / right-click whole pane unchanged.
- Gap gate (`isGapNeighborFullySelected`): the line ABOVE a collapsed gap is "fully
  selected" only with its text plus its newline (hidden lines start after it); the line
  BELOW only needs its text from column 0. Used by arming, spanned inclusion, clamp and
  prune. Arming still needs the pointer on the gap, so fully selecting the last line
  (with or without its newline) never pulls in the adjacent gap.
- Blank lines are just their newline: the cell doubles as the selection pad (no
  `.sel-pad`), the content gets `.eol-only`, and the `ws-line-selected` 1ch `::after`
  strip is skipped for it, so its paint is the native cell paint (only when the newline
  is selected). `.ws-line-selected > .eol::selection` re-enables cell paint on
  whitespace-only rows. Placeholder rows keep `.sel-pad`.
- Cost: one extra span per line; ~1200-line gap expand ~6ms → ~10.5ms, 4-line toggle in
  a 3000-line file unchanged (~1.5ms).

**Show-whitespace toggle** (`#whitespace-btn`, `showWhitespace`)
- Renders whitespace/control chars as visible marks while keeping real chars for copy:
  space `·`, tab `→`, other control chars via Unicode "control pictures" (`controlGlyph`),
  plus the per-line EOL marker (§11.5). `appendDecorated` builds spans; empty placeholder
  cells get no EOL marker.

**Click-to-expand gaps**
- Gap rows carry `data-gap-index` + `.gap-toggle`; clicking expands the omitted `gap.rows`
  in place. `buildFileDiffBody` keeps an `expanded` Set. Initial open uses `effectiveRows()`;
  later toggles splice via `toggleGapInPlace` (prototype-cloned equal rows, left→right
  structural clone, detach-to-cache on collapse, lazy whitespace decorate after paint).
  A gap click is O(gap): registry lookup instead of walking the tbody, capture-phase
  mousedown returns before pane-wide row scans / selectionchange, and pan overflow is
  only remeasured when a newly inserted line is longer than the current max. Full
  rebuild remains a fallback if DOM targets are missing.

**Memory / performance (important for large comparisons, e.g. 216 diffs)**
- Diffs render **lazily on expand**. `renderFileDiff(file, autoOpen)` renders only a
  summary; `buildFileDiffBody` builds the tables/scrollbars on first `toggle` (or immediately
  if `autoOpen`). **Auto-open only when `differing.length <= 25`**; larger sets stay collapsed.
- Per-file resize listeners are tracked in `resizeHandlers` and removed at the start of every
  `renderResults()` (via `clearResizeHandlers()`); rebuilding a file's body swaps its handler.
- **Session persistence** of results across navigation uses `sessionStorage`
  (`SESSION_KEY="sochaDiffSession"`, `saveSession`/`restoreSession`, called from
  `renderResults` / init). It **skips large results** (`isResultTooLargeToPersist`:
  files > 150 or rows > 20000) to avoid memory/quota blowups.

**Layout / responsiveness**
- `.file-diff` full-bleed uses a **scrollbar-safe negative-margin breakout**
  (`width:auto; margin-left:-14px; margin-right:-14px` against the 24px page padding = ~10px
  visual inset) instead of `100vw` — fixes the divider drifting right when a vertical
  scrollbar appears on wide windows.
- No horizontal scrollbar at minimum width: `.file-list li` and `.file-diff > summary .name`
  use `overflow-wrap:anywhere` (long paths wrap); `.field`/`.field input` have `min-width:0`
  and `.actions`/`.view-controls` use `flex-wrap:wrap` so the form/controls shrink/wrap.
- The shared `#info-toast` (Comparing/Updating spinner and sync summary) is fixed at the
  **top** center (`top:16px`, over the header band) and uses `width:max-content` so long
  messages are not squeezed to half the viewport.
- Cosmetic: background `--bg` brightened `#0d1117 → #10151d`; Save button styling `.secondary-btn`.

## 11.8 Verification approach used this session

- `node --check` on changed JS files after each edit.
- Temporary Node scripts (created, run, then deleted) validated: settings reset, ignore-
  whitespace routing, CRLF/LF detection, gap `rows` payload, and comparison-scoped sync.
- Live browser checks via Playwright against `http://127.0.0.1:3000`: overflow/no-scrollbar
  at 480 px with the real 216-file comparison, settings modal open/close/auto-save.

## 11.9 Gotchas for the next session

- The dev server is often already running on **port 3000** (an old `node server.js`); a new
  `npm start` exits with code 1 ("port in use"). **Restart the existing process** to pick up
  server-side (`server.js` / `lib/compare.js`) changes. Static file edits (html/css/js) are
  served fresh on reload without restart.
- Large results are intentionally NOT persisted across nav (see 11.7). Small ones are.
- `identicalCount` is retained for back-compat but `identical[]` is the list the UI uses.

## 11.10 Path case rule (detected per folder; supersedes the platform rule of PR #13)

- `lib/path-case.js` `detectPathCase(root)` probes each compare root when a compare starts
  (so also for every compare inside `/api/sync`); the result lives for that compare only.
  Order: (1) **entry probe, no writes**: take a sorted entry of `root` whose name has ASCII
  letters, lstat its case-swapped spelling: missing -> sensitive; both spellings listed ->
  sensitive; resolves but not listed (or same dev+ino) -> insensitive. Listing is the main
  signal because exfat-fuse hands out a new inode per lookup. (2) `root`'s own name via its
  parent, then further ancestors, only while `st.dev` matches (never across a mount). (3) a
  write probe in a fresh folder under `os.tmpdir()`, only when it is on the same volume (never
  writes into a compare root). (4) platform default: win32/darwin insensitive, others sensitive.
- `SOCHA_PATH_CASE=auto` (default) | `insensitive` | `sensitive`; a fixed value wins for both
  roots (method `override`). Read once at load; invalid values warn and mean `auto`.
- Scope: per root. Subfolders with different behavior (another mount, NTFS per-directory
  flag) are not probed; the sync guards below look at real aliasing for each file they touch,
  so a mismatch there can change pairing/display but cannot lose data.
- A/B rule (`resolvePathCase` in compare.js): pairing ignores case if EITHER root is
  case-insensitive (a copy into that folder lands `Readme.md` on `README.md`, so they are one
  slot in both directions, and two spellings from a case-sensitive side could not both land;
  they are reported as a clash instead of one overwriting the other). Both sensitive -> exact.
  Result: `pathCase: { a, b, pairing, detection: { a, b } }` (detection = entry | parent | temp
  | platform | override). `compareFolders(a, b, { caseModes: { a, b } })` skips detection
  (tests only).
- `foldCase` uses simple 1:1 uppercase mappings (NTFS-like, `ß` is not `SS`); `makePathKey`.
- `walkDir` keys stay the real on-disk relative paths (hashes unchanged, so a case-only rename
  still counts as "folder changed" for the Match safety check). `indexByKey` pairs by key. A
  pair whose names differ carries `pathA`/`pathB` (`path` = A's name) in every category; the
  client shows `B: <name>` (`.path-case-alt`, only on such rows; tooltip names which folder
  ignores case) and each A/B link opens its own side's name.
- Case clashes (two files in ONE folder with the same key under case-insensitive pairing): the
  key is skipped on both sides (no category, never synced); each file gets an `errors[]` entry
  with `side`; the Errors list links only that side. Also `caseConflicts[]` /
  `summary.caseConflicts`.
- `syncFromComparison` (rule from `result.pathCase`): a case-differing pair is overwritten in
  place under the TARGET's existing name (content from source, target casing kept, like a
  Windows copy and consistent with identical/whitespace-only pairs, which are never touched).
  With insensitive pairing, new files go into existing target folders by their on-disk casing
  (`resolveTargetCase`). A new file is never copied onto a different file written in the same
  sync (target aliased the name). A target-only file is never deleted when: its pairing key
  matches a written file; or it is a case-only variant of a written file that the filesystem
  aliased (`isExactlyListed`, any mode); or the TARGET was detected insensitive and it has the
  same dev+ino as a written variant. On a case-sensitive target none fires (hard links are
  distinct entries there), so *nix behavior is unchanged. Skips are reported as errors.
- Excluded folder names stay case-insensitive everywhere (settings stored lowercased; applied
  to both sides equally, so they can't mis-pair or lose data).
- `resolveFileTarget` containment is an exact prefix test (the target is built from the folder
  string) and handles a drive-root folder.
- Test: `npm run test:pathcase` (`tests/path-case.js`): setting/fallback resolution, detection
  (entry, parent, platform, override) on the temp fs, lib checks for all four A/B combinations,
  HTTP with `sensitive`/`insensitive`/`auto`, Playwright UI. Optional real-volume checks:
  `SOCHA_PATHCASE_INSENSITIVE_DIR=<folder on a case-insensitive volume>` (detection there,
  mixed A/B pairing and both sync directions, clash, misdetected-target copy guard, HTTP auto)
  and `SOCHA_PATHCASE_EMPTY_MOUNT=<empty dedicated mount>` (temp write-probe fallback).
  Verified on Linux overlay, tmpfs and ext4 (sensitive) and exFAT via FUSE (insensitive,
  including a run with the whole temp folder on exFAT). Not yet run on Windows NTFS or macOS.

---

# 13. Conversation decisions and preferences (authoritative)

This section summarizes the complete product, structural, visual, and engineering
decisions established during the chat. Preserve these choices unless the user
explicitly changes them.

## 13.1 Product behavior

- The app compares arbitrary local Folder A and Folder B paths, stays localhost-only,
  and presents categorized results with side-by-side as the default and unified as
  an alternate client-side view.
- Ignore-whitespace defaults to enabled and removes all whitespace from the
  authoritative content comparison, including spaces, tabs, blank lines, and CRLF/LF.
  When enabled, unmatched whitespace-only line rows are also removed from the display;
  genuine content changes remain visible. When disabled, whitespace differences show.
- Settings are auto-saved to `.socha-diff-settings.json`; excluded directories are
  normalized, deduplicated, case-insensitive directory names. Last paths use the
  separate `.socha-diff-state.json` file.
- The header awareness indicator and Settings modal checkbox must always represent the
  same `ignoreWhitespace` value. The server-side settings file is authoritative after
  load; session restoration must not race or overwrite that value.
- Settings changes are compared with the settings snapshot used for the last Compare.
  The pending indicator over Compare appears only when values differ, survives small
  result session restoration, and disappears when values return to the last-run state
  or a successful Compare completes.

## 13.2 Diff display and interaction

- Replacement rows use character-level matching. Characters common to both sides keep
  the normal red (A) or green (B) line color; changed characters use a stronger,
  lighter translucent overlay. In ignore-whitespace mode, whitespace characters are
  common and must never receive the changed-character overlay.
- Side-by-side panes are separate selection scopes. Drag/copy cannot cross A and B,
  `Ctrl+A` selects all text in the clicked or focused pane, and copied text remains
  verbatim. Unified view uses the shared rows and disables text selection.
- The newline is a selectable, paintable one-character cell at each line end; copy
  includes a line's own CRLF/LF exactly when that cell is selected (see §11.7 Newline).
  A collapsed gap's upper neighbor counts as fully selected only with its newline.
- Differing line endings on changed pairs (whitespace-aware mode) use the changed-word
  red/green emphasis on the EOL cell, with or without whitespace chars shown.
- Gap markers stay at their original position when expanded. Expanded markers explain
  that they can be clicked to hide the unchanged lines again; clicking toggles them
  in both side-by-side and unified views.
- Side-by-side has independent horizontal bars. Unified reserves equivalent scrollbar
  space and reveals the scrollbar visually on hover. Long diff text does not wrap.
- Results render lazily for large sets, clean up per-file resize listeners, and skip
  session persistence for oversized result payloads.
- The A/B path header is a two-column grid aligned with the diff panes. A: and B: use
  the same 48px right-aligned gutter geometry as their line-number columns.

## 13.3 Settings, icons, tooltips, and motion

- The Settings button opens the in-page dialog by click or exact `Ctrl+S`. Its tooltip
  and the whitespace-awareness tooltip follow the mouse, sit 3px above and 20px left
  of the cursor, and support keyboard focus.
- The pending-settings indicator is a small four-point star over Compare's upper-right
  corner. It uses the same amber/panel shading as the whitespace-aware indicator. Its
  tooltip uses the same vertical offset and a 20px right-side cursor offset.
- The whitespace display button is labeled `Whitespace chars` with an eye icon. The
  eye is open when marks are shown and a wider, gently closed eye when hidden. Its
  painted glyph uses transform-only scaling so button dimensions and neighboring text
  alignment do not change. Both states share the same -1px Y position to avoid jumps.
  The eye transition is 0.8s; initial page/session restoration disables the transition
  and enables it after initialization so loading never animates.
- The stale-content dialog uses a red error `✖` icon and has only an OK button; it
  states that Match was aborted and requires a new Compare. The mirroring confirmation
  dialog uses an amber warning icon with explicit OK and Cancel buttons.
- Avoid transient “checking folder contents” text that shifts the page. Real errors,
  completion results, and settings status messages may use the existing status area.
  Settings status fades after five seconds with a brief, restrained multi-directional
  jitter; keep motion subtle and purposeful.

## 13.4 Mirroring safety

- Make A/B match is comparison-scoped: overwrite differing/binary files, create
  source-only files, delete target-only files, and never touch identical or
  whitespace-only files while whitespace is ignored.
- Compare results include deterministic SHA-256 content hashes for A and B, computed
  from sorted relative paths and file bytes using the same ignored-directory walker.
  Hashes persist with the session result.
- Match first calls `/api/sync/check`. If either folder changed, show the red-error
  OK-only modal and abort. If unchanged, show the amber OK/Cancel mirroring modal.
  The server rechecks hashes immediately before mutation to catch confirmation races.
- Native browser `alert`/`confirm` prompts are not used for these flows.

## 13.5 Engineering and design preferences

- Keep the vanilla Node/Express plus static HTML/CSS/JS architecture. No framework,
  bundler, build step, or broad redesign. Prefer existing helpers and local patterns.
- Preserve the dark, restrained operational-tool aesthetic and current color semantics:
  red for A/deletions/errors, green for B/additions, amber for awareness/warnings,
  and restrained blue for primary actions.
- Prefer compact, familiar controls and custom tooltips with deliberate viewport-safe
  positioning. Avoid layout shifts, clipped tooltips, nested decorative cards, and
  unrelated visual flourishes.
- Keep file content inert with `textContent`; preserve exact copied whitespace. Use
  `apply_patch` for edits, sparse comments, ASCII by default, and visible Unicode only
  when it is an intentional UI glyph.
- Preserve user edits and dirty worktrees; never reset or revert unrelated changes.
  Validate JavaScript with `node --check` and use focused Node/browser checks for
  behavior. Port 3000 may already be occupied by an older `node server.js`; restart
  that process when server-side edits need to be exercised.

## 13.6 Recent verification state

- Verified comparison hashes exclude ignored directories and change for visible-file
  edits. Stale Match operations are blocked before mutation.
- Verified OK-only stale-content and OK/Cancel mirroring dialogs, reversible gap
  expansion, side-by-side Ctrl+A selection, character-level contrast, whitespace-aware
  EOL rendering, and the eye icon's no-animation initial load.
- The `initial` branch was explicitly created and pushed to `origin/initial`; no new
  commit should be made unless requested.

---

# 14. Windows desktop host (`desktop/`)

Added on branch `feat/wpf-host`. Full details are in `desktop/README.md`.

> **Update 2026-09-27 (see §14.1): .NET 10, framework-dependent, Node.js is a prerequisite,
> download site in `site/`, CI publishing.** The bullets below describe the first version; where
> they conflict, §14.1 wins. §14.2: Debug builds run the web app from the repo (no prepare-bundle needed for F5).

- `desktop/SochaDiff.Desktop/`: a .NET 8 WPF app (`net8.0-windows`, win-x64,
  `Microsoft.Web.WebView2`) with `desktop/SochaDiff.sln`. It is a full-window WebView2
  over the unchanged web app. The web app stays vanilla; its only hooks are
  `/api/health` and `SOCHA_HOST` (§11.2).
- Bundled runtime: `desktop/scripts/prepare-bundle.ps1` (and `.sh`) stages the git-ignored
  `desktop/bundle/`, containing `node/node.exe` (pinned in `desktop/node-pin.json`, currently
  Node 24.21.0 LTS, SHA256 checked against the pin and `SHASUMS256.txt`) and `app/`
  (`server.js`, `lib/`, `public/`, package files, and `npm ci --omit=dev` node_modules).
  The csproj includes `bundle/**` as Content, so build and ClickOnce copy it. Never
  commit `node.exe` or `node_modules`. Re-run the script after web app changes before
  building the desktop app.
- Startup: free `127.0.0.1` port → `node app/server.js` with `PORT`, `SOCHA_HOST=127.0.0.1`,
  `SOCHA_NO_OPEN=1`, `SOCHA_DATA_DIR=%LOCALAPPDATA%\SochaDiff`, no console window.
  stdout/stderr go to `%LOCALAPPDATA%\SochaDiff\server.log`. The host polls `/api/health`
  (pid must match), then navigates. It shows a loading panel meanwhile and an error panel
  (message + log path + Retry) on failure.
- Lifecycle: node runs in a `KILL_ON_JOB_CLOSE` Job Object (with `SILENT_BREAKAWAY_OK`
  so apps opened via open-file/open-folder survive). Normal close also kills it.
- WebView2: user data in `%LOCALAPPDATA%\SochaDiff\WebView2`. Off-origin links go to the
  default browser. DevTools are enabled in Debug only. The browser-chrome items are
  filtered out of the default context menu. The diff panes keep the app's own Copy
  menu, since the page cancels `contextmenu` there. A missing WebView2 Runtime shows a
  friendly panel.
- Desktop settings/state live in `%LOCALAPPDATA%\SochaDiff`, not the repo folder, so they
  are separate from `npm start` runs and survive ClickOnce updates.
- ClickOnce: `Properties/PublishProfiles/ClickOnce.pubxml`, install URL
  `https://sochadiff.socha3.com/`, self-contained, update check before start. Signing is
  still TODO (the cert comes from Sissy Admin). Publish needs VS MSBuild
  (`msbuild /t:Publish /p:PublishProfile=ClickOnce`), not `dotnet publish`.
- Verified 2026-09-27 on the Home PC (Win 11): startup on a random port, real folder
  compare in WebView2, app Copy menu → clipboard, close and `Stop-Process -Force` both
  kill node, crash → Retry, error panels, and a local ClickOnce publish (manifest lists
  node/app files). Not yet done: publishing to the site, signing.

## 14.1 .NET 10, framework-dependent, prerequisites, site, CI (2026-09-27, authoritative)

- **.NET 10**: `net10.0-windows`, win-x64, `SelfContained=false` in the csproj and both
  publish profiles. WebView2 SDK stays 1.0.4191.47 (latest stable). Package XML docs are not
  published. Builds clean on the box with SDK 10.0.401 (`EnableWindowsTargeting`).
- **Prerequisites** (installed once by the user, listed on the site): .NET 10 Desktop
  Runtime x64, WebView2 Runtime, Node.js 20+. Node is no longer bundled.
  - `NodeLocator.cs`: `SOCHA_NODE` (alias `SOCHA_DESKTOP_NODE`) -> bundled `node\node.exe`
    (portable builds only) -> PATH (process + registry machine/user PATH, so Retry finds a
    fresh install) -> `%ProgramFiles%\nodejs`, `%ProgramFiles(x86)%\nodejs` -> nvm-windows, fnm,
    Volta, Scoop, Chocolatey. Probes `node -p "process.version+'|'+process.execPath"`, needs
    major >= 20 (`MinimumMajor`), launches the real execPath (shims would break the pid check).
  - Missing/old Node -> `NodeMissingException` -> panel "Node.js 20 or newer is required" with
    what was found, **Get Node.js** (nodejs.org/en/download), **All prerequisites**
    (sochadiff.socha3.com/#prerequisites), Retry. WebView2 panel also got All prerequisites.
  - .NET runtime: the framework-dependent apphost shows Windows' ".NET is required" dialog
    before app code runs; the host logs the runtime version.
- **Bundle**: `prepare-bundle.ps1/.sh` stage `bundle/app` only (npm ci with Node 20+ on PATH);
  `-IncludeNode` / `--include-node` adds the pinned `node.exe` for a portable build.
  `node-pin.json` has `minimumMajor` and is otherwise only for `-IncludeNode`. `package.json`
  has `engines.node >=20`.
- **Version**: `desktop/version.json` (major/minor, now 1.0) + `SochaBuildNumber` (CI run
  number) -> `ApplicationVersion` `<major>.<minor>.<build>.0`, assembly/file version, `Version`
  `<major>.<minor>.<build>`. ClickOnce: `UpdateMode=Foreground`, `UpdateRequired=true`,
  `MinimumRequiredVersion` = published version (every launch installs a newer release first).
- **setup.exe prerequisites** (HomeSite, not bundled): `Microsoft.NetCore.DesktopRuntime.10.0.x64`
  (VS 2026 package) and the repo's `desktop/bootstrapper/Socha3.WebView2Runtime` (VS has no
  WebView2 package; `publish-site.ps1 -InstallBootstrapperPackages` copies it into VS). Missing
  packages are dropped with a warning (`SochaPrereqDotNet` / `SochaPrereqWebView2=false`).
- **Size**: framework-dependent Folder publish 5,975,161 bytes / 615 files (node_modules
  3,062,028 bytes / 592 files; 2,913,133 without) vs 251,753,026 bytes (~240 MiB) for the old
  self-contained publish with node.exe. ClickOnce first install downloads about 6 MB.
- **Site** `site/`: vanilla static download page (dark animated hero, real demo recording
  `assets/demo.webm|mp4|gif` + poster in a faux "Socha Diff" window, features, Install =
  `SochaDiff.application`, `setup.exe`, separate Prerequisites section, requirements, removable
  `UNSIGNED-NOTICE` block, OG/favicon, `web.config` with ClickOnce MIME types and no-cache on the
  manifest). `<!--app-version-->` / `<!--app-size-->` markers and `version.json` are stamped by
  publish-site.ps1. Demo fixtures `sample/demo-a|demo-b`; recorder `desktop/scripts/record-demo.js`
  (Xvfb + xdotool + ffmpeg x11grab, real input and cursor).
- **Publishing**: `desktop/scripts/publish-site.ps1 -Version a.b.c.d` or `-Build N` (Windows, VS
  MSBuild; optional `-CertificateThumbprint` or `-PfxPath/-PfxPassword`) -> `desktop/out/site/`
  (git-ignored). The version goes into ApplicationVersion, MinimumRequiredVersion and the assembly
  versions; `SignManifests` also Authenticode-signs SochaDiff.exe/setup.exe before hashing.
  `.github/workflows/publish-desktop.yml`: push to main or manual run -> windows-latest, Node 24,
  .NET 10, npm ci + `test:selection` + `test:paths`, version `<major>.<minor>.<run_number>.0`,
  publish, artifact `sochadiff-site-<version>`. Concurrency group `publish-desktop`, never
  cancelled. actionlint 1.7.12 clean. Details: `desktop/README.md`.
- **Signing** (secrets `SIGNING_PFX_BASE64` + `SIGNING_PFX_PASSWORD` set): self-signed `CN=Socha3`,
  thumbprint `CF4137053F371F439BD420B02A51192C5DED6075` (expected via `vars.SIGNING_CERT_THUMBPRINT`
  or that default; mismatch = warning). The PFX's own thumbprint always wins; secrets present but
  unsigned output = build fails. ClickOnce updates need the same cert every time: a purchased
  trusted cert later means existing users reinstall unless a migration is planned.
- **Deploy** (replaced Web Deploy; no `DEPLOY_*` secrets): job `deploy` on the self-hosted runner
  `socha3-sochadiff` (`[self-hosted, Windows, X64, sochadiff]`, non-admin `.\gha-sochadiff`) on
  the IIS server (site `SochaDiff`, `C:\WebApps\SochaDiff`, Cloudflare in front); only push to
  main or dispatch from main, and `environment: production` (url https://sochadiff.socha3.com;
  deployment branch policy: `main` only; no required reviewers, so merges auto-deploy).
  `deploy-site.ps1` (PS 5.1 + 7, local/UNC target): artifact checks,
  version guard vs target/live `version.json` (`force`), backup to
  `C:\WebApps\_deploy-backups\SochaDiff\<timestamp>-<live version>` (keep 5; folder created if
  missing; pruning only touches that folder's own `<timestamp>-<version|unknown>` subfolders, no
  junctions), robocopy without deletes
  (folders + root files, then `SochaDiff.application`, `version.json`, `index.html` swapped in
  last; exit 0-7 ok), verify `version.json` + `SochaDiff.application` (200,
  `application/x-ms-application`) with a cache-busting query (stale Cloudflare cache = warning),
  job summary.
- **Public repo** (since 2026-09-27): fork-PR workflow runs from outside contributors need approval
  (`actions/permissions/fork-pr-contributor-approval` = `all_external_contributors`); `main` is
  PR-only (ruleset); `production` is limited to `main`. Runner `socha3-sochadiff` is repo-scoped,
  non-admin, logon-restricted `.\gha-sochadiff` (Modify on `C:\WebApps\SochaDiff` and
  `C:\WebApps\_deploy-backups\SochaDiff` only), job-completed workspace-cleanup hook. Signing
  secrets stay repo secrets (the `build` job has no environment). **Never approve a fork PR's
  workflow run without reading every workflow file change**: a fork's workflow can target the
  self-hosted runner's labels and run on the web server.
- Still open: the workflow only runs once merged to main (first real deploy + install/update test
  of a CI-published build on Windows); pruning old `Application Files` folders is manual.

## 14.2 Debug runs from the repo; `SOCHA_APP_DIR` (2026-09-27)

- F5 in Visual Studio used to fail with "The Socha Diff web app files are missing ... app\server.js"
  unless prepare-bundle had been run. Now `AppPaths.ResolveAppDir` (called on every start/Retry)
  picks: `SOCHA_APP_DIR` (alias `SOCHA_DESKTOP_APP_DIR`; developer-only, Debug and Release; a
  folder without server.js is an error) -> `app\` next to the exe (staged bundle; the only source in
  Release/ClickOnce/CI) -> **Debug only** (`#if DEBUG`) the repo root: AssemblyMetadata
  `SochaRepoRoot` baked by the csproj for `Configuration=Debug`, else walk up from the exe to a
  folder with `server.js` + `package.json` + `public/`. Node's working directory is that folder.
- Non-bundle folders must have every `package.json` dependency in `node_modules`; otherwise the
  panel "The web app's npm packages are not installed" says to run `npm install` there (npm is
  never run automatically). The Release missing-files message names prepare-bundle.ps1 and the
  Debug fallback. `NodeStartException` has an optional `Title` for the panel.
- Logged as `host: app folder <path> (<source>)` in server.log; in Debug, host lines also go to
  `Debug.WriteLine` (VS Output). `SOCHA001` now warns only for non-Debug builds; Debug prints a
  note. No MSBuild prepare-bundle target was added (would slow builds / need network).
- A staged bundle still wins in Debug (stale copy in `bin\Debug\...\app\` included); delete both
  or set `SOCHA_APP_DIR` to use the repo. Publish profiles and publish-site.ps1 use Release, so the
  ClickOnce payload and CI are unchanged (Release dll contains no repo path).

## 14.3 Site guide page and animated demos (2026-09-27)

- `site/guide.html`: full user guide (every control, TOC, lazy-loaded `<picture>` clips) sharing
  the home page's nav/styles. The home page's Tips section is a short summary linking to it.
- Demos are animated WebP with GIF fallbacks: `site/assets/home-demo.webp|gif` (+
  `home-demo-poster.webp` for `prefers-reduced-motion`) and `guide-<scene>.webp|gif`. The old
  `demo.webm|mp4|gif` and `demo-poster.webp` were removed (deploys never delete, so old copies
  may linger on the server). Recorded by `desktop/scripts/record-scenes.js`, encoded by
  `desktop/scripts/encode-demos.sh` (see desktop/README.md "Site demos"); `record-demo.js` is legacy.
- `web.config` already mapped `.webp`; `guide.html` got the same no-cache rule as `index.html`.
