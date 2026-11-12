# pi-file-sidebar

**[English](README.md)** | [简体中文](README.ZH.md)

A native left-side file tree for Pi >=1.5.0 fullscreen mode (verified on 1.5.0 and 1.5.2), backward-compatible with Pi 1.4.0. Wide windows keep the Pi main UI, editor, and native conversation scrolling on the right. In narrow windows the tree stays hidden until opened manually, then temporarily overlays the left part of the conversation and retracts when you return to the editor. It uses the host renderer.

Version 0.3.2 targets Pi >=1.5.0 with a minimum host version of **>=1.4.0**. Working-directory switching now belongs to the independent **pi-cd-workspace** extension; this package only provides the file sidebar. Formal TUI acceptance on a real terminal is not yet complete.

## Installation

### Git source (standard Pi installation)

```bash
pi install git:github.com/llc2214926/pi-file-sidebar
```

Pi clones the whole repository to `~/.pi/agent/git/github.com/llc2214926/pi-file-sidebar` (or the `PI_CODING_AGENT_DIR` equivalent) and registers it in `settings.json`. The directory keeps `.git`, `scripts/`, `tsconfig.json`, etc. — everything from a normal `git clone` — which is why updates work: `pi update git:github.com/llc2214926/pi-file-sidebar` fetches and reconciles the checkout. Requires git and an npm package manager to install (the runtime itself has zero dependencies; only host peerDependencies).

After installation, run `/reload` in the current Pi or restart Pi. The standard flow registers the package in Pi's `settings.json`; it does not change keybindings or project settings.

### Local publishing (from the source repository)

Local publishing uses `npm pack` to build a versioned package, unpacks it into Pi's standalone install directory, and registers it as a global package. Run from the source repository:

```bash
./scripts/publish-install.sh

# Validate and pack only; do not modify the Pi install or settings
./scripts/publish-install.sh --pack-only
```

The script requires the development dependencies to be installed (run `npm install --ignore-scripts` first), runs the type check, then packs. It does not upload to npm, commit code, or auto-reload Pi.

- The version is read from `package.json` and never auto-incremented; packages and manifests go to `artifacts/releases/<version>/`, the npm cache lives in `artifacts/npm-cache/`, and neither is committed.
- By default it installs to `~/.pi/agent/local-packages/pi-file-sidebar/<version>`; if `PI_CODING_AGENT_DIR` is set, that directory is used instead. Automatic installation accepts stable Pi versions >=1.4.0 (build metadata is allowed; prereleases and malformed versions are rejected).
- An existing version directory with identical content is reused; differing content or a symlinked target is never overwritten. **After changing published content, bump the `package.json` version before publishing.**
- Old registrations under the same install root are only removed after the new version is registered and the registration is confirmed to be persisted; old version files are kept, and installs in other locations or project-level registrations are not touched. Sidebar registrations with custom resource filters must be switched manually — the script never overwrites them.
- On failure the script stops and preserves diagnostics; it does not change directory ownership or force-delete live locks. If old-registration cleanup fails, both old and new registrations may remain; resolve the issue and rerun the script, and do not `/reload` Pi until it succeeds.

An unpacked version can also be registered manually:

```bash
pi install ~/.pi/agent/local-packages/pi-file-sidebar/0.3.2
```

The install directory is generated from the local versioned package. After installing, run `/reload` in the current Pi or restart Pi. Runtime uses the standalone installed copy, does not depend on the source repository, and needs no npm account.

The entry point is `extensions/index.ts`. The package only declares peerDependencies on the host and never ships a second copy of the Pi SDK.

The development baseline is Pi **1.5.0**, with Pi **1.4.0** retained as the backward-compatibility target, on Node **24.22.2**, macOS Apple Silicon. Runtime and installation version checks accept stable **>=1.4.0** versions, with no upper-version pin; build metadata is allowed and prereleases/malformed versions are rejected. A passing version check is not a claim that every later host, platform, or terminal is verified: native layout and focus capability checks remain in place. Formal real-terminal acceptance is still pending. The tree is hidden in regular mode; RPC/print/JSON sessions never create a sidebar runtime or emit UI/ANSI. If the host's layout or focus capabilities are incompatible, or another extension takes over the root, this extension does not override its layout; use `status` to see the reason.

If required host capabilities disappear after mounting, the sidebar cancels width adjustment, closes its own overlays and yields the layout. It restores the original editor only when focus can still be read and set. If the layout setter is unavailable, its owned wrapper becomes a main-UI-only pass-through instead of calling the missing method; an explicit `off` can retry restoration after the capability returns. Foreign layouts/focus are not overwritten. The retired sidebar stays disabled until reload; if the host also loses its focus APIs, automatic focus restoration cannot be guaranteed.

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
| `/file-sidebar status` | Mode/mount or hide reason, width, focus, cache, pending reads, and current language |

The default activation key is **Ctrl+Shift+E**. User keybindings are never modified; if your terminal cannot distinguish that key or another extension conflicts with it, use the commands. The same shortcut inside the tree returns to the Pi input box.

Below the docked display threshold (97 columns at the default width), `/file-sidebar`, `/file-sidebar focus`, and Ctrl+Shift+E open a temporary overlay on the left. The conversation keeps its full layout width behind it. Esc, Ctrl+C, the activation key, or inserting a reference returns to the editor and removes the overlay. Menus, previews, and help return to the tree first. Enlarging the window restores the usual side-by-side layout. A focused docked tree switches to the temporary overlay when the window shrinks; an unfocused docked tree hides until you open it manually again. If help, the action menu, or a preview is open while the window shrinks, the modal is not cancelled: the tree becomes a temporary overlay that stays hidden until the modal closes, then reappears (or re-docks once the window is wide again). If the window drops below **26 columns × 8 rows**, the overlay closes and an open modal is still cancelled. The overlay clamps its displayed width to leave a divider and at least one conversation column visible, without changing the confirmed width.

## Independent Workspace Extension

Directory switching has moved entirely to **pi-cd-workspace**. This sidebar no longer registers `/cd`, `/cd-new`, `/cd-resume`, or the `/file-sidebar cd` alias, and directory menus no longer offer switching actions. Use `/cd` (picker) or `/cd <URI-encoded-path>` in the new extension instead. There is no command forwarding or dependency between the packages.

Either package can be installed alone, or both together. The sidebar owns `/file-sidebar`, Ctrl+Shift+E, its tree/layout and `file-sidebar.json`; the workspace extension owns the cd commands, its temporary picker and `cd-workspace.json`. Language settings are independent. Closing or changing the language of one does not close or reconfigure the other. A successful directory switch replaces the Pi session runtime normally; when installed, the sidebar is recreated from the new `ctx.cwd`, with its default width and its own saved language.

**Upgrade the sidebar installation to this split source before enabling pi-cd-workspace.** Older installed sidebar copies and legacy `cd-picker.ts` still register `/cd`; do not leave either active with the new extension. Editing source does not update an installed copy. No migration automatically edits global settings, session files, or old language preferences. For local co-loading without registering packages:

```bash
pi --no-extensions -e ./extensions/index.ts -e ../pi-cd-workspace/extensions/index.ts --tui-mode fullscreen
```

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

Once the file/directory action menu is open, **Enter or Space** executes the highlighted action through the same checks; clicking still works. This Space-to-confirm alias applies **only to this action menu**. In the tree, Space still opens the menu; the main editor, preview, help, width adjustment and Pi's own dialogs keep their existing key behavior. No global keybindings are changed.

Single clicks only select; double-clicking the same file previews it. Directory expansion markers are clickable. The mouse wheel only scrolls the sidebar, never steals focus on hover, and wheel events at the edge never leak to the main conversation. In both docked and floating trees, the position scrollbar stays visible while the list is scrolled away from the top: it no longer fades after a pause. Returning to the top restores the host's short auto-hide delay; the bar hides immediately when all rows fit. Hovering/dragging can still reveal it at the top. The scrollbar supports dragging; files and the divider are not draggable.

**PageUp/PageDown policy:** with normal tree focus, Pi's main conversation paging is preserved; the tree uses Ctrl+U/Ctrl+D. In the preview or help panel that captures focus, PageUp/PageDown control that panel, not the main conversation. The original behavior of Tab, Ctrl+B, etc. in the main input box is unchanged; undefined plain keys inside the tree are never written to the main draft.

## Full-name Bubbles

The focused file tree uses a name-tooltip component. When the focused selection's name is truncated, a **non-focus-stealing rounded bubble** automatically shows the full name. It can be wider than the sidebar and temporarily cover part of the conversation, without changing either layout. Bubble width is capped at 80 columns and height at 12 rows, further constrained to fit inside the terminal.

Names wrap by terminal display width. If a narrow/short terminal cannot show all lines at once, use **`[` / `]`** to page, or scroll the mouse wheel over the bubble; every line remains reachable. These inputs only scroll the bubble, not the tree selection or conversation. Normal tree PageUp/PageDown still belongs to the conversation. The bubble does not capture keyboard focus; Esc retains the tree's existing exit behavior.

Changing to a name that fits, leaving tree focus, opening a modal, resizing the sidebar, hiding/disposal, or scrolling the selected row out of view retracts the tree's bubble. Window resizing repositions and wraps the tooltip inside terminal bounds. File names are sanitized but never translated; displaying a tip performs no file-content reads, directory rescan, timer-driven marquee, or polling.

## Interface Language

First use defaults to **Chinese**, with full sidebar Chinese/English switching:

```text
/file-sidebar lang en   Switch to English
/file-sidebar lang zh   Switch to Chinese
/file-sidebar lang      Show the current language
```

Press lowercase `l` while the tree has focus or inside the `h` help for a quick toggle; the extended key protocol is supported. `l:EN` / `l:ZH` in the title indicates the key and the target language. Width adjustment, the action menu, preview, and other blocking modals do not capture that single key. `l` in the main input box remains ordinary input, and Pi keybindings are never modified.

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

Press `h` while the tree has focus to show the full reference as a two-column “Key | Action” table, grouped by tree navigation, file actions, width adjustment, action menu, and read-only preview; the action menu and main conversation paging keys show the current Pi configuration, with the menu-only Space confirmation alias listed alongside the configured confirm keys. At the default width, the bottom shows these two hint rows below the selected path (each row is **32 display columns**, in both languages):

```text
Enter View · Space Menu · h Help
y Copy path · a Ref · e External
```

The Chinese rows are `Enter 预览 · Space 操作 · h 帮助` and `y 复制路径 · a 引用 · e 外部打开`. Narrow sidebars use shorter labels on both rows, retain all six keys, and pad the shorter row to the same display width without wrapping. `y` copies the relative path, `a` inserts a reference without sending, and `e` opens the external editor subject to the existing file/idle checks; `w` remains for width adjustment.

The footer reserves **three rows** (selected path + two hint rows) in both docked and floating trees. Together with the two header rows, this leaves `terminal rows − 5` for file rows: 19 at 24 rows, or 3 at the 8-row minimum. Scrolling, selection reveal, scrollbar dragging, tooltip bounds and mouse hit areas use this reduced tree area. Width adjustment temporarily replaces the footer with width/confirmation hints plus a blank row, keeping the tree height stable.

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

The read-only preview, Space action menu, and `h` key help all use a double-line border whose color follows the current theme; the main file tree and main conversation layout are unchanged.

### Read-only Preview

File contents are only read on an explicit Enter, double-click, or menu choice. UTF-8 is supported, showing the path, line numbers, syntax highlighting, scrolling, and truncation notes. Reads are capped at **512 KiB** and display at **5000 lines**; a UTF-8 character truncated at the end never turns into mojibake. Empty files, binaries, non-UTF-8, permission, and missing-file errors have explanations. The preview never writes files or modifies drafts. Esc or clicking the bottom hint line closes it and returns to the original tree selection.

### Copy and Reference

Copying uses Pi's public `copyToClipboard()` with the raw path characters, never reusing sanitized UI strings. Directories and links can be copied.

References re-validate the regular file before the action, insert at the current cursor via `pasteToEditor()`, and add boundary spaces on both sides. For example `@src/a.ts`, `@"docs/design notes.md"`. Paths containing quotes or backslashes are JSON-string encoded, reversibly; paths with control characters are explicitly rejected for reference — use copy instead. Directories and symlinks are never inserted as file references.

A reference is draft text only, not an attachment upload; file actions never read contents into context or submit the draft. No `sendUserMessage` bridge or model API is used.

### External Editor

Priority matches Pi: trusted project/user `externalEditor`, then `$VISUAL`, `$EDITOR`, and finally the platform default (nano on this machine). Settings are read-only; project trust is respected; no config locks are created and no settings are migrated or written back.

The command is parsed into a program and separate argv; quotes and backslash escapes are supported, but shell pipes, redirection, and variable interpolation are not executed. Files open as a standalone absolute-path argument, and no prompt temp copy is created.

Pi must be idle; state is re-checked right before launch. The TUI is stopped first, the process is launched asynchronously, and the TUI is restored with an explicit full redraw on the normal, non-zero, and launch-failure paths. No extra Esc is needed to bring the screen back; the original tree selection and main editor draft/cursor are preserved. Closing/replacing a session first waits for the terminated old editor process; old results never start a renderer on a new context.

**GUI wait semantics:** configure waiting commands such as `code --wait` or `open -W -n -a TextEdit`. `open -W` waits for the app to exit; without a wait flag, the process exiting only means the launch command finished, not that editing is done. Closing Pi never forcibly closes GUI document windows that were launched independently.

## Refresh and Directory Boundaries

`ctx.cwd` is the fixed root, read asynchronously layer by layer; unexpanded descendants are never scanned. Dot entries, `.git`, and `node_modules` are hidden by default. Symlinks are never auto-expanded or previewed; directory loads and file actions re-check links/root scope.

Refresh sources: first show/expand, manual refresh, re-entering the tree, successful write/edit/bash, and returning from the external editor. Tool events only mark dirty with a 40ms debounce; per-directory single-flight; new dirty marks during a read are never lost. Hidden or collapsed directories pause active reads; results from stale runtimes or removed nodes are discarded.

**There is no watcher.** External changes are not guaranteed to appear immediately; use r or re-enter the sidebar to refresh. The sidebar itself never creates, renames, moves, deletes, or saves project files; only the external editor the user explicitly launched can modify target files. Language switching writes only the extension's dedicated preference file above. The only writes owned by the sidebar are its language preference; it does not write or archive Pi session files.

## Development

The formal sources, dependencies, and project configuration are kept as-is. Type check:

```bash
npm run typecheck
./node_modules/.bin/tsc -p tests/tsconfig.json
node --import tsx --test tests/*.test.ts
```

The automated regressions cover sidebar command registration, menus, language, and host renderer/input routing with an in-memory terminal. Run the same checks against Pi 1.5.0 (development baseline), 1.5.2 (current host), and Pi 1.4.0 (backward compatibility) in isolated dependency trees when changing host compatibility. All three pass source/test type checks and 58 local regressions. A real InteractiveMode with an in-memory terminal also passes four-extension co-loading in two orders, focus restoration, reload, and session replacement on all three versions. They also cover retiring a name bubble after the host has captured its current-frame overlay list: detached getters remain valid and retired components cannot render a later bubble. They do not replace real-terminal acceptance.

### Live Acceptance for Independent Extensions (Not Yet Done)

Split validation passes on Pi 1.4.0 and 1.5.0: source/test type checks, local regressions, and unpacked-package loading. The companion workspace tests exercise both load orders, fullscreen/regular modes, separate language preferences, and modal/focus isolation with real host components and an in-memory terminal. The background PTY attempt was blocked before Pi started (`os.openpty`: `Operation not permitted`), so real-terminal session replacement/reload remains unverified after the split.

Run the live-acceptance sections on **Pi 1.5.0, Pi 1.5.2, and Pi 1.4.0**. Automated tests and background PTY smoke checks do not replace human real-terminal acceptance. Use disposable projects and an isolated `PI_CODING_AGENT_DIR`.

- Load each extension alone and both together in either order. Commands must be unambiguous; directory menus must not contain cd actions.
- Open/cancel `/cd` at 80 and 120 columns: keep the sidebar root, selection, width, language, editor draft and focus unchanged. The picker must not allow Ctrl+Shift+E to steal focus or leak wheel events to the conversation.
- Independently change both languages, disable/re-enable the sidebar, and reload. A sidebar `off` must not cancel the workspace picker; picker shutdown must not close sidebar-owned UI.
- Switch directories using all three workspace commands and verify that Pi rebuilds the sidebar from the target cwd. Sidebar settings and resources remain its own; switching/cancellation must not add command text to model context.
- Exercise sidebar help/preview/width adjustment and external-editor blocking; cd must refuse to take over another component's focus. Detailed cd acceptance belongs in pi-cd-workspace.

### Live Acceptance for Narrow Windows (Not Yet Done)

- At 80×24, confirm the tree starts hidden. Open it with the command and shortcut; check the conversation remains full width behind the left overlay. Esc, Ctrl+C, and the shortcut must retract it and preserve the original draft/cursor.
- In both docked and floating trees, verify the selected path plus two complete hint rows at widths 24/31/32/48, in Chinese and English. The two full hint rows each use 32 display columns; narrower widths keep all six keys. At terminal heights 8/12/24, check that exactly height − 5 file rows fit, End/arrow movement reveals the last row, footer clicks do not select hidden files, and footer wheel events never scroll the conversation. Width adjustment must not change the tree height or trigger directory reads.
- Open help, the menu, and a file preview; close each back to the same tree selection, then leave the tree. Insert a reference and confirm it returns to the unobstructed editor without sending.
- In file and directory action menus, confirm with both Enter and Space (including extended terminal key sequences); verify identical selection/cancel behavior and rejection of a busy external editor. Check the bilingual footer/help. Space must still only open the menu from the tree, and must not close preview/help, confirm width adjustment, or change Pi's own dialogs.
- Scroll, click after scrolling, double-click a file, drag the scrollbar, and check wheel boundaries. In both docked and floating trees, move below the first visible page and wait at least 5 seconds: the thumb must remain visible. Arrow back to the top or press Home: the bar must auto-hide after the host's short delay unless hovered/dragged. Also test collapse, resize until all rows fit, off/on, and focus changes without losing the scroll position. PageUp/PageDown must still page the conversation under ordinary tree focus.
- Test 26/40/80/96/97/120 columns, short windows, width confirmation/cancel, off/on, reload, and another extension taking over the root. Enlarging restores the docked layout; a focused docked tree shrinks into the floating overlay, an unfocused one hides. Test both languages and wide file names.
- In the file tree, repeatedly shrink from 120 columns through 97/96/80/40/26, then enlarge again. At each width, use ↑/↓ to alternate between a truncated long name and a short name. The bubble must appear/disappear without a `name-tooltip` geometry exception, stale content or lost focus. Also close/disable the sidebar with a bubble visible and confirm no overlay remains.
- With help, the menu, or a preview open, shrink and then enlarge the window: the modal must not be cancelled, and closing it returns to the floating tree or the docked layout.

### Live Acceptance for the External Editor (Not Yet Done)

- At 80 and 120 columns, launch using both tree `e` and menu Enter/Space. After exit, press no keys: the conversation and tree must repaint automatically with selection, width, draft and cursor preserved.
- With isolated settings, cover normal exit, non-zero exit, a missing command, a GUI launcher that returns immediately, and waiting commands such as `code --wait`. A paused TUI while a waiting GUI editor is running is expected; a blank screen after its process exits is not.
- Check rejection while Pi is busy and reload/session replacement during editing: replacement must wait for old child cleanup, and old completions must not restart a renderer or notify a new session.

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
