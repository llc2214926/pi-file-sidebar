# pi-file-sidebar

**[English](README.md)** | [简体中文](README.ZH.md)

A native left-side file tree for Pi 1.4.0 fullscreen mode. Wide windows keep the Pi main UI, editor, and native conversation scrolling on the right. In narrow windows the tree stays hidden until opened manually, then temporarily overlays the left part of the conversation and retracts when you return to the editor. It uses the host renderer.

Version 0.2.0 also integrates `/cd`: switch the working directory while retaining the current session. Formal TUI acceptance on a real terminal is not yet complete.

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
pi install ~/.pi/agent/local-packages/pi-file-sidebar/0.2.0
```

The install directory is generated from the local versioned package. After installing, run `/reload` in the current Pi or restart Pi. Runtime uses the standalone installed copy, does not depend on the source repository, and needs no npm account.

The entry point is `extensions/index.ts`. The package only declares peerDependencies on the host and never ships a second copy of the Pi SDK.

The current development/testing baseline is Pi **1.4.0**, Node **24.22.2**, macOS Apple Silicon. No compatibility matrix has been completed for other versions, platforms, or terminals; do not claim support based on this project. The tree is hidden in regular mode; RPC/print/JSON sessions never create a sidebar runtime or emit UI/ANSI. If the host's layout or focus capabilities are incompatible, or another extension takes over the root, this extension does not override its layout; use `status` to see the reason.

## Commands

| Command | Behavior |
|---|---|
| `/file-sidebar`, `/file-sidebar focus` | Show the tree and enter tree focus; use a temporary left overlay in narrow windows |
| `/file-sidebar on` | Enable automatic display without taking focus; stays hidden in narrow windows |
| `/file-sidebar off` | Close, cancel unconfirmed actions/modals, and restore the main UI |
| `/file-sidebar refresh` | Refresh loaded, visible, expanded directories; other dirty directories are handled when re-expanded |
| `/file-sidebar width 32` | Set this runtime's width; integers 24–48; narrow windows hide the docked tree and clamp an open temporary overlay to fit |
| `/file-sidebar lang zh`, `/file-sidebar lang en` | Switch the whole sidebar between Chinese and English and save the choice |
| `/file-sidebar lang` | Show the current language and switching usage |
| `/cd`, `/file-sidebar cd` | Open the same centered floating directory picker; keep this session when switching |
| `/cd <encoded-path>`, `/file-sidebar cd <encoded-path>` | Switch directly; encode the whole path with `encodeURIComponent` |
| `/file-sidebar status` | Mode/mount or hide reason, width, focus, cache, pending reads, and current language |

The default activation key is **Ctrl+Shift+E**. User keybindings are never modified; if your terminal cannot distinguish that key or another extension conflicts with it, use the commands. The same shortcut inside the tree returns to the Pi input box.

Below the docked display threshold (97 columns at the default width), `/file-sidebar`, `/file-sidebar focus`, and Ctrl+Shift+E open a temporary overlay on the left. The conversation keeps its full layout width behind it. Esc, Ctrl+C, the activation key, or inserting a reference returns to the editor and removes the overlay. Menus, previews, and help return to the tree first. Enlarging the window restores the usual side-by-side layout. A focused docked tree switches to the temporary overlay when the window shrinks; an unfocused docked tree hides until you open it manually again. If help, the action menu, or a preview is open while the window shrinks, the modal is not cancelled: the tree becomes a temporary overlay that stays hidden until the modal closes, then reappears (or re-docks once the window is wide again). If the window drops below **26 columns × 8 rows**, the overlay closes and an open modal is still cancelled. The overlay clamps its displayed width to leave a divider and at least one conversation column visible, without changing the confirmed width.

## Switch Working Directory

With a directory selected, Space includes these additional actions (after expand/collapse and before copy):

| Directory action | Behavior |
|---|---|
| Switch to this directory, keep current session | Validate the selected directory and switch directly |
| Select different working directory… | Open the same picker as `/cd`, starting at the current working directory |

File and symlink menus do not contain these actions. No new global shortcut is added. The ordinary file tree stays rooted at `ctx.cwd`; only the separate picker can browse parents and sibling projects.

### Picker controls

Like file preview, the picker opens in a **centered, double-bordered floating window**, not a full-screen panel: 85% terminal width, at most 90% terminal height and 30 rows including the frame. The conversation remains visible around it. Directory columns have vertical separators; overlong names end in `…`. Selecting a truncated name opens the shared full-name bubble described below, which can extend beyond its column or the picker window without taking focus.

| Picker input | Behavior |
|---|---|
| ↑ / ↓, j / k | Select; only held arrow keys accelerate at ~1.1s / ~2.6s (2 / 3 rows per repeat) |
| ← | Go to the parent/previous column |
| → / l | Enter the highlighted child directory |
| . | Show/hide dot directories and `node_modules`, matching the file tree |
| r | Return to the current workspace (`ctx.cwd` when the picker opened), without switching sessions |
| [ / ] | Previous / next page of an overflowing full-name bubble; the selection stays put |
| Enter | Select the highlighted directory; the `.` row selects this column's directory |
| Esc / Ctrl+C | Cancel without a session snapshot or backup |

Press `r` from any browsed directory to return to the workspace: reset to one column, select its `.` row, clear scroll offsets and the name bubble, and keep the hidden-items toggle. The workspace column is reused when available; otherwise only that directory is read again. This is navigation only, not confirmation or refresh; the file tree's own `r` still refreshes and `h` still opens help. `h` no longer toggles hidden items in the picker.

The picker reads only entered directory levels asynchronously. It does not recurse, watch, or follow symlink entries. Loading, empty-directory and read-error states are distinct. It uses the sidebar language; `l` navigates here, not language switching. Names and paths are sanitized for display, not translated or changed on disk.

Direct arguments are **URI-encoded paths**, not shell-quoted arguments: `/file-sidebar cd %2FUsers%2Fme%2FMy%20Project`. Encode the whole path once with `encodeURIComponent`; malformed encoding is rejected. Relative paths resolve against the current `ctx.cwd`; `~` and `~/…` are supported. Explicit targets are resolved with `realpath` (including symlinks) and must be directories with read/execute access. Picking the current real directory gives a no-op notice. No shell is invoked.

### Session and failure semantics

- Requires **Pi 1.4.0 TUI**, persistence, idle processing, no queued messages, and no blocking modal/external editor/width adjustment. `/cd` also works in regular TUI mode, where the sidebar itself stays hidden. Non-TUI modes are silent. Repeated requests share one in-flight lock.
- The menu closes and returns focus before sending `/file-sidebar cd …` with explicit `expandPromptTemplates: true`. This is command dispatch, not a chat prompt; it neither submits the draft nor asks the model to change directories.
- A private, exclusively created JSONL snapshot retains the session ID, header metadata, all entries/branches, and active leaf. A non-model `cd-picker` marker records `{ from, to }`. Default session storage moves to the target's session directory; an explicitly configured session directory is retained. This does **not** resume the target project's previous session.
- Pi replaces the runtime and reloads cwd-bound resources (including AGENTS.md) under its normal trust rules. The old sidebar/editor runtime is disposed; the new tree uses the new root and width **32**. Successfully saved language preferences survive. This is different from leaving tree focus, which preserves the original editor object.
- Draft text is captured before replacement and restored only through the fresh `withSession` context. **Cursor position is not guaranteed**; a restoration error warns rather than pretending success.
- After verified takeover, the source file is renamed to `source.cd-backup`; existing backup names get a UUID suffix. A not-yet-flushed source need not have a file to archive. `EXDEV` falls back to exclusive copy and keeps the source, with a warning. Other archive failures warn and preserve the source; the new session remains active.
- A cancelled host switch or a catchable pre-takeover failure renames the target copy to `.cd-abandoned` (UUID on collision), never deletes it, and keeps the original. Failed partial writes are also quarantined if possible. If the rename fails, the surviving `.jsonl` path is reported for manual handling. `.cd-backup` and `.cd-abandoned` do not appear in `/resume`.
- **Host limitation:** Pi 1.4.0 may destroy the old runtime before creating the replacement; its interactive fatal-error handler can call `process.exit(1)` before this extension's catch runs. No UI recovery or automatic `.cd-abandoned` rename is promised on that path (or on process termination). Both paths are displayed before switching; the original is not archived before takeover, but the target may remain `.jsonl`. Restart Pi with `pi --session '/absolute/path/to/original.jsonl'` or select the original with `/resume`. Inspect and move the unused copy manually only after confirming it is not active. No process-exit interception or private host patch is installed.

### Upgrading from the standalone cd-picker

Do not load `~/.pi/agent/extensions/cd-picker.ts` alongside this version: both register `/cd`. First test source with `pi --no-extensions -e ./extensions/index.ts --tui-mode fullscreen`. After real-terminal acceptance, back up the standalone extension and current installation, install 0.2.0, move the old extension to `cd-picker.ts.disabled`, then `/reload` and check for command conflicts. Source development does not perform installation, disabling, or global configuration changes. See [rollback-steps.md](rollback-steps.md) in the source repository for rollback steps.

## Keyboard and Mouse

| Input in tree | Behavior |
|---|---|
| ↑ / ↓ | Move selection; holding ↑/↓ accelerates (2 rows per repeat after ~1.1s, 3 rows after ~2.6s) |
| Home / End | Select the first / last item |
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
| [ / ] | Page the full-name bubble when its content overflows; does not move the tree selection |
| Esc / Ctrl+C | Return to the original Pi input object and retract a temporary overlay; drafts are kept and the agent is not interrupted |

Single clicks only select; double-clicking the same file previews it. Directory expansion markers are clickable. The mouse wheel only scrolls the sidebar, never steals focus on hover, and wheel events at the edge never leak to the main conversation. The scrollbar supports dragging; files and the divider are not draggable.

**PageUp/PageDown policy:** with normal tree focus, Pi's main conversation paging is preserved; the tree uses Ctrl+U/Ctrl+D. In the preview or help panel that captures focus, PageUp/PageDown control that panel, not the main conversation. The original behavior of Tab, Ctrl+B, etc. in the main input box is unchanged; undefined plain keys inside the tree are never written to the main draft.

## Full-name Bubbles

The directory picker and the left file tree share the same name-tooltip component. When the focused selection's name is truncated, a **non-focus-stealing rounded bubble** automatically shows the full name. It can be wider than the sidebar or a picker column and temporarily cover part of the conversation, without changing either layout. Bubble width is capped at 80 columns and height at 12 rows, further constrained to fit inside the terminal.

Names wrap by terminal display width. If a narrow/short terminal cannot show all lines at once, use **`[` / `]`** to page, or scroll the mouse wheel over the bubble; every line remains reachable. These inputs only scroll the bubble, not the tree selection or conversation. Normal tree PageUp/PageDown still belongs to the conversation. The bubble does not capture keyboard focus; Esc retains the owning tree/picker's existing exit behavior.

Changing to a name that fits, leaving tree focus, opening a modal, resizing the sidebar, hiding/disposal, or scrolling the selected row out of view retracts the tree's bubble. Window resizing repositions and wraps the tooltip inside terminal bounds. File names are sanitized but never translated; displaying a tip performs no file-content reads, directory rescan, timer-driven marquee, or polling.

## Interface Language

First use defaults to **Chinese**, with full sidebar Chinese/English switching:

```text
/file-sidebar lang en   Switch to English
/file-sidebar lang zh   Switch to Chinese
/file-sidebar lang      Show the current language
```

Press lowercase `l` while the tree has focus or inside the `h` help for a quick toggle; the extended key protocol is supported. `l:EN` / `l:ZH` in the title indicates the key and the target language. Width adjustment, the action menu, preview, and other blocking modals do not capture that single key; the directory picker uses `l` to enter a child. `l` in the main input box remains ordinary input, and Pi keybindings are never modified.

- Translation scope: tree title and status, bottom hint, width hints, action menu, directory picker and switching feedback, help table, preview hints, command feedback, and errors defined by this extension. Command/shortcut registration descriptions use fixed bilingual text; the Pi main UI does not switch along.
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

The default is 32 columns with a 1-column divider. Docked display keeps at least 64 columns for the main UI; its default show threshold is **97 columns**. Both docked and temporary display require at least **8 rows**.

- With tree focus and no blocking modal, `w` enters width adjustment.
- ←/→ adjust by 1 column; terminals supporting the extended key protocol can use Shift+←/→ for 4 columns.
- The docked candidate range is `24 … min(48, terminal columns − 65)`; a temporary overlay uses `24 … min(48, terminal columns − 2)`. If the upper bound is below 24, entry is not allowed.
- The live preview preserves the main root, editor, tree, and ScrollView, and never reads directories. Docked layout changes rebuild only the extension's own HStack.
- Enter confirms; Esc restores the width from before entry; both return to tree navigation.
- Ctrl+C or the activation key cancels and returns to the Pi input box.
- Unconfirmed values are canceled when leaving the tree, on blocking modals, off, reload, session/mode replacement, or host invalidation.
- If shrinking the window makes a docked candidate invisible, the original width is restored first; if the original width still fits, tree focus is kept, otherwise the tree hides and releases focus. A temporary overlay cancels resizing if the candidate no longer fits; its display clamps to the window and closes below 26 columns or 8 rows.
- off/on keeps the confirmed width, selection, and expansions; reload/new runtime resets to the default 32. Width is never written to persistent config (unlike the language preference).

## File Actions and Security Boundaries

The read-only preview, directory picker, Space action menu, and `h` key help all use a double-line border whose color follows the current theme; the main file tree and main conversation layout are unchanged.

### Read-only Preview

File contents are only read on an explicit Enter, double-click, or menu choice. UTF-8 is supported, showing the path, line numbers, syntax highlighting, scrolling, and truncation notes. Reads are capped at **512 KiB** and display at **5000 lines**; a UTF-8 character truncated at the end never turns into mojibake. Empty files, binaries, non-UTF-8, permission, and missing-file errors have explanations. The preview never writes files or modifies drafts. Esc or clicking the bottom hint line closes it and returns to the original tree selection.

### Copy and Reference

Copying uses Pi's public `copyToClipboard()` with the raw path characters, never reusing sanitized UI strings. Directories and links can be copied.

References re-validate the regular file before the action, insert at the current cursor via `pasteToEditor()`, and add boundary spaces on both sides. For example `@src/a.ts`, `@"docs/design notes.md"`. Paths containing quotes or backslashes are JSON-string encoded, reversibly; paths with control characters are explicitly rejected for reference — use copy instead. Directories and symlinks are never inserted as file references.

A reference is draft text only, not an attachment upload; file actions never read contents into context or submit the draft. The only `sendUserMessage` call is the explicit directory-menu command bridge above, with command expansion enabled; no model API is called.

### External Editor

Priority matches Pi: trusted project/user `externalEditor`, then `$VISUAL`, `$EDITOR`, and finally the platform default (nano on this machine). Settings are read-only; project trust is respected; no config locks are created and no settings are migrated or written back.

The command is parsed into a program and separate argv; quotes and backslash escapes are supported, but shell pipes, redirection, and variable interpolation are not executed. Files open as a standalone absolute-path argument, and no prompt temp copy is created.

Pi must be idle; state is re-checked right before launch. The TUI is stopped first, the process is launched asynchronously, and the TUI is restored on the normal, non-zero, and launch-failure paths. Closing/replacing a session first waits for the terminated old editor process; old results never start a renderer on a new context.

**GUI wait semantics:** configure waiting commands such as `code --wait` or `open -W -n -a TextEdit`. `open -W` waits for the app to exit; without a wait flag, the process exiting only means the launch command finished, not that editing is done. Closing Pi never forcibly closes GUI document windows that were launched independently.

## Refresh and Directory Boundaries

`ctx.cwd` is the fixed root, read asynchronously layer by layer; unexpanded descendants are never scanned. Dot entries, `.git`, and `node_modules` are hidden by default. Symlinks are never auto-expanded or previewed; directory loads and file actions re-check links/root scope.

Refresh sources: first show/expand, manual refresh, re-entering the tree, successful write/edit/bash, and returning from the external editor. Tool events only mark dirty with a 40ms debounce; per-directory single-flight; new dirty marks during a read are never lost. Hidden or collapsed directories pause active reads; results from stale runtimes or removed nodes are discarded.

**There is no watcher.** External changes are not guaranteed to appear immediately; use r or re-enter the sidebar to refresh. The sidebar itself never creates, renames, moves, deletes, or saves project files; only the external editor the user explicitly launched can modify target files. Language switching writes only the extension's dedicated preference file above. Explicit `/cd` actions additionally write and archive Pi session files as described above; they do not move project files.

## Development

The formal sources, dependencies, and project configuration are kept as-is. Type check:

```bash
npm run typecheck
./node_modules/.bin/tsc -p tests/tsconfig.json
node --import tsx --test tests/*.test.ts
```

The automated regressions cover session snapshots, injected filesystem/replacement failures, picker navigation, command registration/encoding, and Pi 1.4.0's renderer/input routing with an in-memory terminal. They also cover retiring a name bubble after the host has captured its current-frame overlay list: detached getters remain valid and retired components cannot render a later bubble. They do not replace real-terminal acceptance.

### Live Acceptance for Directory Switching (Not Yet Done)

Use disposable projects and an isolated `PI_CODING_AGENT_DIR` for failure tests; never corrupt active session files to simulate errors.

- Test `/cd`, `/file-sidebar cd`, and both directory menu actions in 80- and 120-column windows, in Chinese and English. Include children, parent/sibling projects, `~/…`, Chinese names, spaces, quotes and `%`.
- Check that `/cd` is centered with the conversation visible around its frame; resize it and verify column separators, ellipses, footer and bottom border. Select long names in both the picker and file tree: the bubble may extend past the sidebar, but must stay on-screen and keep keyboard focus on the owner. Test tooltip paging/wheel without changing selection or scrolling the conversation, and modal/exit cleanup.
- Verify `.` toggles hidden items in both the tree and picker. In the picker, navigate to parents, siblings and descendants, then press `r`: it must return to the workspace's `.` row without confirming, preserve the hidden toggle, and discard late results from abandoned columns.
- Compare `/session` before/after: same ID and message history, new cwd; inspect the target root/status, target trust prompt and resource reload. Saved language must survive; sidebar width resets to 32.
- Leave a draft, switch via a menu, and verify its text survives (not necessarily its cursor). A subsequent reference must use the new root; the bridge must not add a user message to the transcript.
- Cancel the picker, choose the current directory, and try nonexistent/unreadable targets: no snapshot/backup should be created. Exercise rapid repeated requests, streaming, queued messages, help/preview and external-editor blocking, and reload while a picker/read/save is pending.
- Check `.cd-backup` on success and `.cd-abandoned` on a cancelled/catchable failed takeover; neither belongs in `/resume`. Inject archive errors only in disposable tests: the new session should remain active and the original survive.
- Exercise the documented fatal-runtime limitation: original session remains recoverable, but Pi may exit and leave an unclaimed `.jsonl`. Repeat source acceptance after installation and verify the old standalone extension is disabled and `/cd` is unambiguous.

### Live Acceptance for Narrow Windows (Not Yet Done)

- At 80×24, confirm the tree starts hidden. Open it with the command and shortcut; check the conversation remains full width behind the left overlay. Esc, Ctrl+C, and the shortcut must retract it and preserve the original draft/cursor.
- Open help, the menu, and a file preview; close each back to the same tree selection, then leave the tree. Insert a reference and confirm it returns to the unobstructed editor without sending.
- Scroll, click after scrolling, double-click a file, drag the scrollbar, and check wheel boundaries. PageUp/PageDown must still page the conversation under ordinary tree focus.
- Test 26/40/80/96/97/120 columns, short windows, width confirmation/cancel, off/on, reload, and another extension taking over the root. Enlarging restores the docked layout; a focused docked tree shrinks into the floating overlay, an unfocused one hides. Test both languages and wide file names.
- In both the file tree and `/cd`, repeatedly shrink from 120 columns through 97/96/80/40/26, then enlarge again. At each width, use ↑/↓ to alternate between a truncated long name and a short name. The bubble must appear/disappear without a `name-tooltip` geometry exception, stale content or lost focus. Also close/disable the sidebar with a bubble visible and confirm no overlay remains.
- With help, the menu, or a preview open, shrink and then enlarge the window: the modal must not be cancelled, and closing it returns to the floating tree or the docked layout.

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
