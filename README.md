# pi-file-sidebar

**[English](README.md)** | [简体中文](README.ZH.md)

A native left-side file tree for Pi 1.4.0 fullscreen mode. The Pi main UI, editor, and native conversation scrolling stay on the right; the extension never overlays the conversation and never runs a second renderer.

The feature set is fully implemented, but formal TUI acceptance on a real terminal is not yet complete. Automated regressions pass, but they do not substitute for acceptance testing of the formal extension.

## Installation

### Remote installation (two options)

**Option A: git source (standard Pi flow)**

```bash
pi install git:github.com/llc2214926/pi-file-sidebar
```

Pi clones the whole repository to `~/.pi/agent/git/github.com/llc2214926/pi-file-sidebar` (or the `PI_CODING_AGENT_DIR` equivalent) and registers it in `settings.json`. The directory keeps `.git`, `scripts/`, `tsconfig.json`, `package-lock.json`, etc. — everything from a normal `git clone` — which is why updates work: `pi update git:github.com/llc2214926/pi-file-sidebar` fetches and reconciles the checkout. Requires git and an npm package manager to install (the runtime itself has zero dependencies; only host peerDependencies).

**Option B: remote-install.sh (clean package from the GitHub Release)**

```bash
curl -fsSL https://raw.githubusercontent.com/llc2214926/pi-file-sidebar/refs/heads/master/scripts/remote-install.sh | bash
# or with an explicit version
bash remote-install.sh 0.1.3
```

The script downloads the released `pi-file-sidebar-<version>.tgz` (the `npm pack` whitelist: only `extensions/`, `src/`, `package.json`, `README*`, `LICENSE`), registers the same git source via `pi install`, then atomically replaces the clone directory with the clean package. The final directory contains only the files the extension actually needs — no `.git`, no `scripts/`, no `tsconfig.json`.

**Differences at a glance**

| | A: `pi install git:…` | B: `remote-install.sh` |
|---|---|---|
| Install directory content | Full repository clone | Clean packed files only |
| Disk footprint | Repository + `.git` (~420 KiB) | Package files only (~180 KiB) |
| `pi update` | Works (fetches the configured ref) | **Does not work** — no `.git`; re-run the script with a new version to upgrade |
| Needs a GitHub Release tgz | No | Yes (`v<version>` release asset) |
| Other steps | None | Checks `curl`/`tar`/`node`/`pi`, verifies Pi 1.4.0 and package content, atomic replace with rollback on failure |

Both register the identical source string `git:github.com/llc2214926/pi-file-sidebar` in Pi settings, so they occupy the same slot: installing one after the other replaces the previous copy. After either installation, run `/reload` in the current Pi or restart Pi. Both write only Pi's own `settings.json` packages entry; neither touches keybindings or project settings.

### Local publishing (from the source repository)

Local publishing uses `npm pack` to build a versioned package, unpacks it into Pi's standalone install directory, and registers it as a global package. Run from the source repository:

```bash
./scripts/publish-install.sh

# Validate and pack only; do not modify the Pi install or settings
./scripts/publish-install.sh --pack-only
```

The script requires the development dependencies to be installed (run `npm install --ignore-scripts` first), runs the type check, then packs. It does not upload to npm, commit code, or auto-reload Pi.

- The version is read from `package.json` and never auto-incremented; packages and manifests go to `artifacts/releases/<version>/`, the npm cache lives in `artifacts/npm-cache/`, and neither is committed.
- By default it installs to `~/.pi/agent/local-packages/pi-file-sidebar/<version>`; if `PI_CODING_AGENT_DIR` is set, that directory is used instead. Automatic installation only accepts Pi 1.4.0.
- An existing version directory with identical content is reused; differing content or a symlinked target is never overwritten. **After changing published content, bump the `package.json` version before publishing.**
- Old registrations under the same install root are only removed after the new version is registered and the registration is confirmed to be persisted; old version files are kept, and installs in other locations or project-level registrations are not touched. Sidebar registrations with custom resource filters must be switched manually — the script never overwrites them.
- On failure the script stops and preserves diagnostics; it does not change directory ownership or force-delete live locks. If old-registration cleanup fails, both old and new registrations may remain; resolve the issue and rerun the script, and do not `/reload` Pi until it succeeds.

An unpacked version can also be registered manually:

```bash
pi install ~/.pi/agent/local-packages/pi-file-sidebar/0.1.3
```

The install directory is generated from the local versioned package. After installing, run `/reload` in the current Pi or restart Pi. Runtime uses the standalone installed copy, does not depend on the source repository, and needs no npm account.

The entry point is `extensions/index.ts`. The package only declares peerDependencies on the host and never ships a second copy of the Pi SDK.

The current development/testing baseline is Pi **1.4.0**, Node **24.22.2**, macOS Apple Silicon. No compatibility matrix has been completed for other versions, platforms, or terminals; do not claim support based on this project. The tree is hidden in regular mode; RPC/print/JSON sessions never create a sidebar runtime or emit UI/ANSI. If the host's layout or focus capabilities are incompatible, or another extension takes over the root, this extension does not override its layout; use `status` to see the reason.

## Commands

| Command | Behavior |
|---|---|
| `/file-sidebar`, `/file-sidebar focus` | Show the tree and enter tree focus |
| `/file-sidebar on` | Show without taking focus |
| `/file-sidebar off` | Close, cancel unconfirmed actions/modals, and restore the main UI |
| `/file-sidebar refresh` | Refresh loaded, visible, expanded directories; other dirty directories are handled when re-expanded |
| `/file-sidebar width 32` | Set this runtime's width; integers 24–48; temporarily hidden when the window is too small |
| `/file-sidebar lang zh`, `/file-sidebar lang en` | Switch the whole sidebar between Chinese and English and save the choice |
| `/file-sidebar lang` | Show the current language and switching usage |
| `/file-sidebar status` | Mode/mount or hide reason, width, focus, cache, pending reads, and current language |

The default activation key is **Ctrl+Shift+E**. User keybindings are never modified; if your terminal cannot distinguish that key or another extension conflicts with it, use the commands. The same shortcut inside the tree returns to the Pi input box.

## Keyboard and Mouse

| Input in tree | Behavior |
|---|---|
| ↑ / ↓, Home / End | Move selection |
| → / ← | Expand directory; collapse directory or go to parent |
| Ctrl+U / Ctrl+D | Half-page movement inside the tree |
| Enter | Expand/collapse directories; read-only preview for regular files |
| Space | Native action menu, selectable via keyboard and mouse |
| y | Copy the relative path; the absolute path is in the menu |
| a | Insert a file reference, return to the main input box, do not send |
| e | Launch the external editor for the selected file when Pi is idle |
| r | Manual refresh |
| . | Show/hide dot entries and node_modules |
| w | Enter keyboard width adjustment |
| h | Open the full key help |
| l | Toggle sidebar Chinese/English and save the choice (also works in help) |
| Esc / Ctrl+C | Return to the original Pi input object; drafts are kept and the agent is not interrupted |

Single clicks only select; double-clicking the same file previews it. Directory expansion markers are clickable. The mouse wheel only scrolls the sidebar, never steals focus on hover, and wheel events at the edge never leak to the main conversation. The native scrollbar handles scroll dragging; files and the divider are not draggable.

**PageUp/PageDown policy:** with normal tree focus, Pi's main conversation paging is preserved; the tree uses Ctrl+U/Ctrl+D. In the preview or help panel that captures focus, PageUp/PageDown control that panel, not the main conversation. The original behavior of Tab, Ctrl+B, etc. in the main input box is unchanged; undefined plain keys inside the tree are never written to the main draft.

## Interface Language

First use defaults to **Chinese**, with full sidebar Chinese/English switching:

```text
/file-sidebar lang en   Switch to English
/file-sidebar lang zh   Switch to Chinese
/file-sidebar lang      Show the current language
```

Press lowercase `l` while the tree has focus or inside the `h` help for a quick toggle; the extended key protocol is supported. `l:EN` / `l:ZH` in the title indicates the key and the target language. Width adjustment, the action menu, preview, and other blocking modals do not capture that single key; `l` in the main input box remains ordinary input, and Pi keybindings are never modified.

- Translation scope: tree title and status, bottom hint, width hints, action menu, help table, preview hints, command feedback, and errors defined by this extension. Command/shortcut registration descriptions use fixed bilingual text; the Pi main UI does not switch along.
- **File names, paths, and file contents are never translated**; copy, reference, and external editor actions still use the raw path. Low-level system/third-party errors keep their original diagnostics, sanitized for display.
- Switching redraws immediately without rebuilding the tree, ScrollView, or main editor, without re-reading directories or file contents, and without changing tree selection, confirmed width, focus, or drafts. The help table re-wraps in the new language; the scroll offset is kept and clamped to the valid range.

The language preference is stored separately in **`<agent-dir>/file-sidebar.json`**, by default `~/.pi/agent/file-sidebar.json`; it honors `PI_CODING_AGENT_DIR` and never touches Pi's `settings.json`, `keybindings.json`, project settings, or installed copies. For example:

```json
{ "language": "en" }
```

It is remembered across projects, sessions, and `/reload` within the same agent directory; off/on does not reset it. Startup is read-only; only an explicit switch writes. Saves go through a serialized queue using an atomic same-directory temp-file replace, preserving other JSON fields. Normal reload/session replacement waits for in-flight saves. There is no watcher or polling: other running Pi instances do not follow automatically; among multiple processes the last successful save wins and is read at the next startup or reload.

A missing configuration defaults to Chinese without auto-creating the file. An invalid configuration warns and temporarily uses Chinese; symlinks, non-regular files, and configs over 16 KiB are rejected. On save failure, a warning is shown, the interface keeps the chosen language for this session, but the next load follows the disk contents; a corrupted JSON is never overwritten for the sake of saving — fix this extension's config first and retry.

## Key Help

Press `h` while the tree has focus to show the full reference as a two-column “Key | Action” table, grouped by tree navigation, file actions, width adjustment, action menu, and read-only preview; the action menu and main conversation paging keys show the current Pi configuration. At the default width the compact bottom hint is `Enter View · Space Menu · h Help` (Chinese: `Enter 预览 · Space 操作 · h 帮助`); narrow sidebars compress the Enter/Space hints to keep the `h` help entry. `w` remains for width adjustment.

The help overlay resizes with the terminal (85% of the window), and the table fills the available overlay width. The key column is sized by content while leaving room for the action column; the two columns wrap independently. Column widths are recalculated on window resize; long key names and Chinese descriptions are never horizontally truncated. The header stays fixed; scrolling affects only the group and action rows.

Help supports ↑/↓ scrolling, Ctrl+U/Ctrl+D half-pages, PageUp/PageDown paging, Home/End jumps, and the mouse wheel. Press `l` inside the panel to switch language instantly without closing help; press `h`, Esc, Ctrl+C, or click the bottom hint to close and return to the original tree selection without touching the main input draft. In short windows, scroll to see all entries; help is not opened during width adjustment or other blocking modals.

## Keyboard Width Adjustment

The default is 32 columns with a 1-column divider, keeping at least 64 columns for the main UI; the default show threshold is **97 columns** and the minimum height is **8 rows**.

- With tree focus and no blocking modal, `w` enters width adjustment.
- ←/→ adjust by 1 column; terminals supporting the extended key protocol can use Shift+←/→ for 4 columns.
- The candidate range is `24 … min(48, terminal columns − 65)`; if the upper bound is below 24, entry is not allowed.
- The live preview rebuilds only the extension's own HStack, preserving the main root, editor, tree, and ScrollView, and never reads directories.
- Enter confirms; Esc restores the width from before entry; both return to tree navigation.
- Ctrl+C or the activation key cancels and returns to the Pi input box.
- Unconfirmed values are canceled when leaving the tree, on blocking modals, off, reload, session/mode replacement, or host invalidation.
- If shrinking the window makes the candidate invisible, the original width is restored first; if the original width still fits, tree focus is kept, otherwise the tree hides and releases focus.
- off/on keeps the confirmed width, selection, and expansions; reload/new runtime resets to the default 32. Width is never written to persistent config (unlike the language preference).

## File Actions and Security Boundaries

The read-only preview, the Space action menu, and the `h` key help all use a double-line border whose color follows the current theme; the main file tree and main conversation layout are unchanged.

### Read-only Preview

File contents are only read on an explicit Enter, double-click, or menu choice. UTF-8 is supported, showing the path, line numbers, syntax highlighting, scrolling, and truncation notes. Reads are capped at **512 KiB** and display at **5000 lines**; a UTF-8 character truncated at the end never turns into mojibake. Empty files, binaries, non-UTF-8, permission, and missing-file errors have explanations. The preview never writes files or modifies drafts. Esc or clicking the bottom hint line closes it and returns to the original tree selection.

### Copy and Reference

Copying uses Pi's public `copyToClipboard()` with the raw path characters, never reusing sanitized UI strings. Directories and links can be copied.

References re-validate the regular file before the action, insert at the current cursor via `pasteToEditor()`, and add boundary spaces on both sides. For example `@src/a.ts`, `@"docs/design notes.md"`. Paths containing quotes or backslashes are JSON-string encoded, reversibly; paths with control characters are explicitly rejected for reference — use copy instead. Directories and symlinks are never inserted as file references.

A reference is draft text only, not an attachment upload; this extension never reads file contents into context and never invokes send or model APIs.

### External Editor

Priority matches Pi: trusted project/user `externalEditor`, then `$VISUAL`, `$EDITOR`, and finally the platform default (nano on this machine). Settings are read-only; project trust is respected; no config locks are created and no settings are migrated or written back.

The command is parsed into a program and separate argv; quotes and backslash escapes are supported, but shell pipes, redirection, and variable interpolation are not executed. Files open as a standalone absolute-path argument, and no prompt temp copy is created.

Pi must be idle; state is re-checked right before launch. The TUI is stopped first, the process is launched asynchronously, and the TUI is restored on the normal, non-zero, and launch-failure paths. Closing/replacing a session first waits for the terminated old editor process; old results never start a renderer on a new context.

**GUI wait semantics:** configure waiting commands such as `code --wait` or `open -W -n -a TextEdit`. `open -W` waits for the app to exit; without a wait flag, the process exiting only means the launch command finished, not that editing is done. Closing Pi never forcibly closes GUI document windows that were launched independently.

## Refresh and Directory Boundaries

`ctx.cwd` is the fixed root, read asynchronously layer by layer; unexpanded descendants are never scanned. Dot entries, `.git`, and `node_modules` are hidden by default. Symlinks are never auto-expanded or previewed; directory loads and file actions re-check links/root scope.

Refresh sources: first show/expand, manual refresh, re-entering the tree, successful write/edit/bash, and returning from the external editor. Tool events only mark dirty with a 40ms debounce; per-directory single-flight; new dirty marks during a read are never lost. Hidden or collapsed directories pause active reads; results from stale runtimes or removed nodes are discarded.

**There is no watcher.** External changes are not guaranteed to appear immediately; use r or re-enter the sidebar to refresh. The sidebar itself never creates, renames, moves, deletes, or saves project files; only the external editor the user explicitly launched can modify target files. Language switching writes only the extension's dedicated preference file above.

## Development

The formal sources, dependencies, and project configuration are kept as-is. Type check:

```bash
npm run typecheck
```

Targeted automated regressions for help and language switching (native component rendering, simulated host, and temp-directory file tests; not a substitute for real TUI acceptance):

```bash
./node_modules/.bin/tsc -p tests/tsconfig.json
node --import tsx --test tests/*.test.ts
```

Coverage includes the full key table, current Pi menu keys, the adaptive bilingual table with cross-group alignment, long key name/description wrapping without losing content, the fixed header, short windows, scrolling/close and theme redraw; plus `h`/`l` wiring, `w` preservation, bilingual menus/previews/errors, no directory re-reads, preference storage boundaries, serialized saves, off/dispose cancellation, reload/session-replacement races, and non-TUI silence. `tests/` uses its own type-check config and is not part of `npm run typecheck`; storage tests use temp directories and never change the actual language preference.

### Live Acceptance for Language Switching (Not Yet Done)

Temporarily load the source in a separate terminal (registers nothing and does not update the installed copy):

```bash
pi --no-extensions -e ./extensions/index.ts --tui-mode fullscreen
```

- Leave a draft in the main input box and move the cursor, enter the tree and press `l`, open `h` and press `l` again; confirm the tree/help switches instantly and the draft, cursor, and selection are unchanged after exiting.
- Check menus, width adjustment, preview, errors, and `/file-sidebar status` in both languages; confirm file names and contents are not translated.
- Resize the window, scroll the help, and check the fixed header, long English/Chinese description wrapping, the close hint, and that main conversation paging is unaffected.
- After quick toggles, run off/on, `/reload`, or a new session; confirm the last saved language is restored while width adjustment still resets by its own independent rules.
- Under an isolated `PI_CODING_AGENT_DIR`, check warnings for corrupted/unwritable configs; do not rewrite real Pi settings just to test. Language switching in a normal directory saves the preference — restore the original language afterwards if needed.
