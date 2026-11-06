import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { getSelectListTheme, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, SelectList, TruncatedText, VStack, matchesKey, truncateToWidth, visibleWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { copyPath, formatReference, parseEditorCommand, readEditorCommand, validateFile } from "./actions.ts";
import { ACTIVATE, SidebarHost } from "./host.ts";
import { FileTree, displayText, isWithin } from "./tree.ts";
import { readPreview, TextPreview } from "./preview.ts";
import { DoubleBorder, overlayHeight } from "./frame.ts";
import { SidebarHelp } from "./help.ts";
import { describeError, getMessages, isLanguage, SidebarError, type Language } from "./i18n.ts";
import { saveLanguage } from "./language.ts";
import { requireIdle, validateTarget } from "./switch.ts";
import { NameTooltip } from "./name-tooltip.ts";

// 按住 ↑/↓ 的加速档位（毫秒）：1.1s 后每次跳 2 项，2.6s 后每次跳 3 项。
// 只依赖终端自动重复，不额外监听 timer；松开后下一次按键的间隔超出窗口即复位。
export const REPEAT_STEP_AFTER = [1100, 2600] as const;
export const REPEAT_RESET_AFTER = 450;
// 表头两行；页脚固定为路径一行和按键提示两行，调宽时也保留同样高度。
const HEADER_ROWS = 2, FOOTER_ROWS = 3;

// 保留原生 auto 的鼠标命中/拖动；滚离顶部后不再受闲置隐藏计时器影响。
class TreeScrollView extends ScrollView {
  override get isScrollbarVisible(): boolean {
    return super.isScrollbarVisible || (this.scrollbar === "auto" && this.viewportHeight > 0 && this.scrollTop > 0);
  }
}

export class FileSidebar {
  readonly host: SidebarHost;
  readonly tree: FileTree;
  private rows: Component & { focused: boolean };
  private scroll: ScrollView;
  private panel: VStack;
  private floatingScrollbar?: { top: number; size: number; travel: number; max: number };
  private scrollbarGrab?: number;
  private cache?: { key: string; lines: string[] };
  private frame: { path: string; marker: number }[] = [];
  private pressed?: string;
  private clickedPath?: string;
  private held?: { key: "up" | "down"; since: number; last: number };
  private wasFocused = false;
  private disposed = false;
  private acting = false;
  private actionGeneration = 0;
  private closeModal?: () => void;
  private externalRunning = false;
  private child?: ChildProcess;
  private externalDone?: Promise<number | null>;
  private languageSave: Promise<void> = Promise.resolve();
  private languageGeneration = 0;
  private nameTip?: NameTooltip;

  constructor(private ctx: ExtensionContext, private language: Language = "zh",
    private persistLanguage: (language: Language) => Promise<void> = saveLanguage,
    private sendCommand?: (command: string) => void) {
    this.tree = new FileTree(ctx.cwd, (reveal) => {
      this.cache = undefined;
      if (reveal) this.revealSelection();
      this.host?.redraw();
    });
    this.rows = { focused: false, render: (width) => this.renderRows(width),
      invalidate: () => { this.cache = undefined; }, handleInput: (data) => this.input(data), handleMouse: (event) => this.mouse(event) };
    this.scroll = new TreeScrollView(this.rows, { follow: "none", overscroll: "contain", scrollbar: "auto" });
    // 1.4.0 的 contain 仍会将边界残余量回退到主对话；只在自己的组件消费 wheel。
    this.scroll.handleMouse = (event) => this.wheel(event, this.scroll);
    const text = (lines: (width: number) => string[]): Component => ({ render: (width) => lines(width).map((line) => truncateToWidth(line, width)), invalidate() {} });
    this.panel = new VStack([
      { component: text(() => [this.ctx.ui.theme.fg("accent", `${this.texts.title} · ${this.texts.switchHint}${this.tree.showHidden ? this.texts.hidden : ""}`), displayText(basename(this.tree.root) || this.tree.root)]), basis: HEADER_ROWS, shrink: 0 },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: text((width) => this.renderFooter(width)), basis: FOOTER_ROWS, shrink: 0 },
    ]);
    this.panel.handleMouse = (event) => this.wheel(event, this.panel);
    this.host = new SidebarHost(ctx, this.panel, this.rows, () => this.hostChanged(), {
      render: (width) => this.renderFloating(width), invalidate: () => this.panel.invalidate(),
      handleMouse: (event) => this.floatingMouse(event),
    });
  }

  get scrollTop() { return this.scroll.scrollTop; }
  get currentLanguage() { return this.language; }
  get canSwitchDirectory() { return !this.disposed && !this.acting && !this.externalRunning && !this.host.resizing && this.host.canOpenModal; }
  leaveForDirectoryCommand() { this.cancelActions(); this.host.leave(); }
  private get texts() { return getMessages(this.language); }
  private get treeHeight() { return Math.max(1, (this.host?.tui?.terminal.rows ?? 8) - HEADER_ROWS - FOOTER_ROWS); }
  private renderFooter(width: number): string[] {
    const text = this.texts;
    if (this.host?.resizing) return [text.width(this.host.width, this.host.maxWidth), text.resizeHint, ""];
    const full = [text.footer, text.actionFooter];
    const hints = full.every((line) => visibleWidth(line) <= width) ? full : [text.compactFooter, text.compactActionFooter];
    // 两行按显示列数补齐到相同宽度；窄窗使用精简文案，不换行挤占目录区域。
    const hintWidth = Math.min(width, Math.max(...hints.map((line) => visibleWidth(line))));
    return [displayText(relative(this.tree.root, this.tree.selected) || "."),
      ...hints.map((line) => truncateToWidth(line, hintWidth, "", true))];
  }
  private hostChanged() {
    if (this.disposed) return;
    const visible = this.host?.visible ?? false, focused = this.host?.focused ?? false;
    if (!visible) this.cancelActions();
    if (!this.canShowNameTip) this.nameTip?.hide();
    if (!focused || this.host.resizing) this.held = undefined;
    if (!visible || !this.host.floating) {
      this.scrollbarGrab = undefined; this.floatingScrollbar = undefined; this.scroll.setScrollbarActive(false);
    }
    this.tree.setActive(visible && !this.externalRunning);
    this.scroll.setScrollbar(visible && !this.externalRunning ? "auto" : "hidden");
    if (focused && !this.wasFocused) {
      const loaded = this.tree.loadedDirectories().filter((path) => this.tree.node(path)?.state !== "loading");
      void this.tree.refresh(loaded);
    }
    this.wasFocused = focused;
  }
  private get canShowNameTip() {
    return !this.disposed && !this.acting && !this.externalRunning && !!this.host?.canInteract && this.host.focused && !this.host.resizing;
  }
  private updateNameTip(data: ReturnType<FileTree["rows"]>, width: number) {
    const tui = this.host?.tui, index = data.findIndex(({ node }) => node.path === this.tree.selected), selected = data[index];
    if (!tui || !this.canShowNameTip || !selected
      || visibleWidth(`> ${"  ".repeat(selected.depth)}  ${displayText(selected.node.name)}`) <= width) { this.nameTip?.hide(); return; }
    if (this.nameTip?.tui !== tui) {
      this.nameTip?.dispose();
      this.nameTip = new NameTooltip(tui, () => this.ctx.ui.theme, () => this.language, () => this.canShowNameTip && this.host.tui === tui);
    }
    this.nameTip.update({ key: selected.node.path, name: selected.node.name, anchor: () => {
      const row = HEADER_ROWS + index - this.scroll.scrollTop;
      return row >= HEADER_ROWS && row < tui.terminal.rows - FOOTER_ROWS
        ? { row, col: Math.min(this.host.width + 1, tui.terminal.columns - 1) } : undefined;
    } });
  }
  private renderRows(width: number): string[] {
    const data = this.tree.rows();
    this.updateNameTip(data, width); // 位置随滚动变化，即使文本缓存命中也要同步气泡。
    const key = `${width}:${this.tree.revision}:${this.host?.focused}:${this.language}`;
    if (this.cache?.key === key) return this.cache.lines;
    this.frame = data.map(({ node, depth }) => ({ path: node.path, marker: 2 + depth * 2 }));
    const lines = data.map(({ node, depth }) => {
      const selected = node.path === this.tree.selected;
      const icon = node.kind === "directory" ? (this.tree.expanded.has(node.path) ? "▾" : "▸") : node.kind === "symlink" ? "↗" : " ";
      const state = node.state === "loading" ? this.texts.loading : node.error ? ` (${displayText(this.texts.directoryError(node.error.code))})`
        : node.kind === "directory" && node.state === "loaded" && !node.children.length ? this.texts.emptyDirectory : "";
      const label = `${selected ? ">" : " "} ${"  ".repeat(depth)}${icon} ${displayText(node.name)}${state}`;
      return truncateToWidth(this.ctx.ui.theme.fg(selected && this.host?.focused ? "accent" : node.error ? "error" : "text", label), width);
    });
    this.cache = { key, lines }; return lines;
  }
  // Pi 1.4.0 的 overlay 只调用 render(width)，不分配 VStack/ScrollView 的视口高度。
  // 复用原树、表头/页脚和 ScrollView 状态，给临时浮层提供有界窗口。
  private renderFloating(width: number): string[] {
    const height = this.treeHeight;
    // 先为滚动条留一列，省略号和全名提示都按真正可见的内容宽度判断。
    const contentWidth = this.tree.rows().length > height ? Math.max(1, width - 1) : width;
    const lines = this.rows.render(contentWidth);
    this.scroll.updateLayout(lines.length, height, () => this.host.redraw());
    const size = Math.min(height, Math.max(2, Math.round(height * height / Math.max(1, lines.length))));
    const max = Math.max(0, lines.length - height), travel = height - size;
    const top = max ? Math.round(this.scroll.scrollTop / max * travel) : 0;
    this.floatingScrollbar = max ? { top, size, travel, max } : undefined;
    const body = Array.from({ length: height }, (_, row) => {
      const line = lines[row + this.scroll.scrollTop] ?? "";
      if (!this.scroll.isScrollbarVisible) return line;
      const thumb = row >= top && row < top + size;
      return truncateToWidth(line, width - 1, "", true) + (thumb
        ? this.scroll.scrollbarThumbStyle(this.scroll.isScrollbarActive ? "█" : "┃") : this.scroll.scrollbarTrackStyle("│"));
    });
    return [...this.panel.children[0]!.render(width), ...body, ...this.panel.children[2]!.render(width)];
  }

  private floatingMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") return this.wheel(event, this.panel);
    if (!this.host.canInteract || this.host.resizing) return { handled: true };
    const bar = this.floatingScrollbar, y = event.y - HEADER_ROWS;
    const overBar = !!bar && event.x === event.width - 1 && y >= 0 && y < this.scroll.viewportHeight;
    this.scroll.setScrollbarActive(overBar || this.scrollbarGrab !== undefined);
    if (bar && event.button === "left" && (overBar || this.scrollbarGrab !== undefined)) {
      if (event.type === "press") this.scrollbarGrab = y >= bar.top && y < bar.top + bar.size ? y - bar.top : Math.floor(bar.size / 2);
      if ((event.type === "press" || event.type === "drag") && this.scrollbarGrab !== undefined) {
        const position = Math.max(0, Math.min(bar.travel, y - this.scrollbarGrab));
        this.scroll.scrollTo(bar.travel ? Math.round(position / bar.travel * bar.max) : 0);
        return { handled: true, capture: true, render: true };
      }
      if (event.type === "release") { this.scrollbarGrab = undefined; return { handled: true, capture: false, render: true }; }
      return { handled: true };
    }
    if (y < 0 || y >= this.scroll.viewportHeight || event.x >= event.width) return { handled: true };
    return this.mouse({ ...event, y: y + this.scroll.scrollTop });
  }

  private revealSelection() {
    if (!this.host?.visible) return;
    const rows = this.tree.rows(), index = rows.findIndex((row) => row.node.path === this.tree.selected);
    const height = this.treeHeight;
    this.scroll.updateLayout(rows.length, height, () => this.host.redraw());
    if (index < this.scroll.scrollTop) this.scroll.scrollTo(index);
    else if (index >= this.scroll.scrollTop + height) this.scroll.scrollTo(index - height + 1);
  }

  toolResult(event: ToolResultEvent) {
    if (this.disposed || !this.host.alive || event.isError) return;
    if (event.toolName === "bash") this.tree.markDirty();
    else if (event.toolName === "write" || event.toolName === "edit") {
      const path = event.input.path;
      if (typeof path !== "string") return;
      const absolute = resolve(this.tree.root, path);
      if (isWithin(this.tree.root, absolute)) this.tree.markDirty([dirname(absolute)]);
    }
  }

  async command(args: string) {
    if (this.disposed) return;
    const [name = "focus", value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (name === "focus" && !value) this.host.enter();
    else if (name === "on" && !value) this.host.setEnabled(true);
    else if (name === "off" && !value) this.host.setEnabled(false);
    else if (name === "refresh" && !value) void this.tree.refresh();
    else if (name === "lang" && !rest.length && (!value || isLanguage(value))) {
      if (isLanguage(value)) await this.changeLanguage(value, true);
      else this.ctx.ui.notify(this.texts.languageStatus, "info");
      return;
    }
    else if (name === "width" && !rest.length && value && /^\d+$/.test(value) && this.host.setWidth(Number(value))) return;
    else if (name !== "status" || value) {
      this.ctx.ui.notify(this.texts.usage, "warning"); return;
    }
    if (name === "status" || (name === "focus" && !this.host.focused)) {
      this.ctx.ui.notify(this.texts.status(this.texts.host[this.host.reason], this.host.width, this.host.focused, this.tree.size, this.tree.pending), "info");
    }
  }

  private changeLanguage(language: Language, announce = false): Promise<void> {
    if (this.disposed || !this.host.alive || this.externalRunning) return Promise.resolve();
    this.language = language;
    const generation = ++this.languageGeneration;
    this.host.redraw(); // 仅使 UI 失效，不改变树模型、宽度、焦点或主编辑器。
    const current = () => generation === this.languageGeneration && !this.disposed && this.host.alive && !this.externalRunning;
    // 已明确选择的语言串行保存；dispose 等待队列，避免旧写入覆盖 reload 后的新选择。
    this.languageSave = this.languageSave.then(async () => {
      try { await this.persistLanguage(language); }
      catch (error) {
        if (current()) this.ctx.ui.notify(displayText(this.texts.languageSaveFailed(describeError(error, this.language))), "warning");
        return;
      }
      if (announce && current()) this.ctx.ui.notify(this.texts.languageSaved, "info");
    });
    return this.languageSave;
  }

  private currentAction(id: number) { return id === this.actionGeneration && !this.disposed && this.host.alive && this.host.visible; }
  private cancelActions() {
    this.held = undefined;
    if (!this.acting && !this.closeModal) return;
    this.actionGeneration++; this.acting = false;
    const close = this.closeModal; this.closeModal = undefined; close?.();
    this.child?.kill();
    if ((!this.host.visible || this.disposed) && this.host.focused) this.host.leave();
  }
  private report(error: unknown) {
    if (!this.disposed && this.host.alive) this.ctx.ui.notify(displayText(describeError(error, this.language)), "warning");
  }
  private async runAction(work: (id: number) => Promise<void>) {
    if (this.acting || !this.host.canInteract || !this.host.focused || this.host.resizing) return;
    this.acting = true; this.nameTip?.hide(); const id = ++this.actionGeneration;
    try { await work(id); }
    catch (error) { if (this.currentAction(id)) this.report(error); }
    finally {
      if (id === this.actionGeneration) { this.acting = false; this.closeModal = undefined; if (!this.disposed) this.host.inspect(); }
    }
  }
  private ready(id: number) { return this.currentAction(id) && this.host.canInteract && this.host.focused; }
  private help() {
    return this.runAction(async (id) => {
      await this.ctx.ui.custom<void>((tui, _theme, keys, done) => {
        this.closeModal = done;
        const help = new SidebarHelp(() => this.ctx.ui.theme, tui, keys, done, () => this.language, () => {
          if (this.acting && this.currentAction(id)) void this.changeLanguage(this.language === "zh" ? "en" : "zh");
        });
        return new DoubleBorder(help, (text) => this.ctx.ui.theme.fg("border", text));
      }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%" } });
    });
  }
  private preview(path = this.tree.selected) {
    return this.runAction(async (id) => {
      if (this.tree.node(path)?.kind !== "file") throw new SidebarError("fileOnlyCopyLink");
      const data = await readPreview(this.tree.root, path);
      if (!this.ready(id)) return;
      await this.ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        this.closeModal = done;
        return new DoubleBorder(new TextPreview(data, () => this.ctx.ui.theme, tui, done, () => this.language), (text) => this.ctx.ui.theme.fg("border", text));
      }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%" } });
    });
  }
  private copy(absolute = false, path = this.tree.selected) {
    return this.runAction(async (id) => {
      if (await copyPath(this.tree.root, path, absolute, () => this.ready(id))) {
        if (this.currentAction(id)) this.ctx.ui.notify(absolute ? this.texts.copiedAbsolute : this.texts.copiedRelative, "info");
      }
    });
  }
  private reference(path = this.tree.selected) {
    return this.runAction(async (id) => {
      await validateFile(this.tree.root, path);
      const text = ` ${formatReference(relative(this.tree.root, path))} `;
      if (!this.ready(id)) return;
      this.ctx.ui.pasteToEditor(text); this.host.leave();
    });
  }
  private external(path = this.tree.selected) {
    return this.runAction(async (id) => {
      if (!this.ctx.isIdle()) throw new SidebarError("editorBusy");
      const [actual, command] = await Promise.all([validateFile(this.tree.root, path), readEditorCommand(this.ctx.cwd, this.ctx.isProjectTrusted())]);
      const argv = parseEditorCommand(command);
      if (!this.ready(id)) return;
      if (!this.ctx.isIdle()) throw new SidebarError("editorBusyChanged");
      const tui = this.host.tui!;
      this.externalRunning = true; this.host.setPaused(true);
      let code: number | null = null;
      try {
        tui.stop();
        const completion = new Promise<number | null>((resolve, reject) => {
          const child = spawn(argv[0]!, [...argv.slice(1), actual], { cwd: this.ctx.cwd, stdio: "inherit", shell: false });
          this.child = child; child.once("error", reject); child.once("close", resolve);
        });
        this.externalDone = completion; code = await completion;
      } finally {
        this.child = undefined; this.externalDone = undefined; this.externalRunning = false;
        if (!this.disposed && this.host.alive && this.host.tui === tui) {
          tui.start(); this.host.setPaused(false); this.host.redraw();
          // Pi 1.4.0 的 stop() 取消帧任务却保留待绘标记；普通请求会被合并掉，必须强制排入恢复帧。
          tui.requestRender(true);
          void this.tree.refresh([dirname(path)]);
        }
      }
      if (!this.currentAction(id)) return;
      if (code === null) throw new SidebarError("editorTerminated");
      if (code !== 0) throw new Error(this.texts.editorExit(code));
      this.ctx.ui.notify(this.texts.editorFinished, "info");
    });
  }
  private async menu() {
    const path = this.tree.selected, kind = this.tree.node(path)?.kind;
    let choice: string | undefined;
    await this.runAction(async (id) => {
      const result = await this.ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
        this.closeModal = () => done(undefined);
        // 双线框、标题、页脚和列表滚动提示最多占 5 行。
        const visibleItems = () => Math.max(1, Math.min(8, overlayHeight(tui.terminal.rows) - 5));
        const createList = (maxVisible: number, selected?: string) => {
          const text = this.texts.menu;
          const items = [
            ...(kind === "directory" ? [{ value: "toggle", label: text.toggle },
              { value: "cd-here", label: text.cdHere }, { value: "cd-pick", label: text.cdPick }] : []),
            ...(kind === "file" ? [{ value: "preview", label: text.preview }] : []),
            { value: "relative", label: text.relative }, { value: "absolute", label: text.absolute },
            ...(kind === "file" ? [{ value: "reference", label: text.reference },
              { value: "external", label: this.ctx.isIdle() ? text.external : text.externalBusy }] : []),
            { value: "cancel", label: text.cancel },
          ];
          const list = new SelectList(items, maxVisible, getSelectListTheme());
          list.onCancel = () => done(undefined);
          list.onSelect = (item) => {
            if (item.value === "external" && !this.ctx.isIdle()) { this.report(new SidebarError("editorUnavailable")); return; }
            done(item.value);
          };
          if (selected) list.setSelectedIndex(items.findIndex((item) => item.value === selected));
          return list;
        };
        let maxVisible = visibleItems(), list = createList(maxVisible), listLanguage = this.language;
        const component: Container & Component = new Container();
        component.addChild(new TruncatedText(displayText(relative(this.tree.root, path) || ".")));
        component.addChild({
          render: (width) => {
            const next = visibleItems();
            if (next !== maxVisible || listLanguage !== this.language) {
              list = createList(next, list.getSelectedItem()?.value);
              maxVisible = next; listLanguage = this.language;
            }
            return list.render(width);
          },
          handleMouse: (event) => list.handleMouse(event),
          invalidate: () => list.invalidate(),
        });
        component.addChild({ render: (width) => [truncateToWidth(this.texts.menu.footer, width)], invalidate() {} });
        component.handleInput = (data) => {
          // 仅此操作菜单将空格作为确认别名，复用 Enter/鼠标的选择回调及忙碌检查。
          if (matchesKey(data, "space")) {
            const selected = list.getSelectedItem();
            if (selected) list.onSelect?.(selected);
          } else list.handleInput(data);
        };
        return new DoubleBorder(component, (text) => this.ctx.ui.theme.fg("border", text));
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "90%" } });
      if (this.currentAction(id)) choice = result;
    });
    if (choice === "cd-here" || choice === "cd-pick") this.sendCdBridgeCommand(choice === "cd-here" ? path : undefined);
    else if (choice === "preview") await this.preview(path);
    else if (choice === "relative" || choice === "absolute") await this.copy(choice === "absolute", path);
    else if (choice === "reference") await this.reference(path);
    else if (choice === "external") await this.external(path);
    else if (choice === "toggle" && !this.disposed && this.host.canInteract) await this.tree.toggle(path);
  }

  private sendCdBridgeCommand(target?: string) {
    if (this.disposed) return;
    try {
      if (!this.host.canInteract || !this.canSwitchDirectory || !this.sendCommand) throw new SidebarError("hostBusy");
      if (!requireIdle(this.ctx)) throw new SidebarError("agentBusy");
      if (target !== undefined) target = validateTarget(target, this.ctx.cwd);
      const command = `/file-sidebar cd${target === undefined ? "" : ` ${encodeURIComponent(target)}`}`;
      this.leaveForDirectoryCommand();
      this.sendCommand(command);
    } catch (error) { this.report(error); }
  }

  private input(data: string) {
    if (!this.host.canInteract || !this.host.focused) return;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, ACTIVATE)) { this.cancelActions(); this.host.leave(); return; }
    if (this.host.resizing) {
      if (matchesKey(data, "escape")) this.host.finishResize(false);
      else if (matchesKey(data, "enter")) this.host.finishResize(true);
      else if (matchesKey(data, "shift+left")) this.host.resizeBy(-4);
      else if (matchesKey(data, "shift+right")) this.host.resizeBy(4);
      else if (matchesKey(data, "left")) this.host.resizeBy(-1);
      else if (matchesKey(data, "right")) this.host.resizeBy(1);
      return;
    }
    if (this.nameTip?.handleInput(data)) { this.held = undefined; return; }
    if (matchesKey(data, "escape")) { this.cancelActions(); this.host.leave(); }
    else if (matchesKey(data, "h")) void this.help();
    else if (matchesKey(data, "l") && !this.acting) void this.changeLanguage(this.language === "zh" ? "en" : "zh");
    else if (data === "w") this.host.beginResize();
    else if (matchesKey(data, "up")) this.move(-1, "up");
    else if (matchesKey(data, "down")) this.move(1, "down");
    else if (matchesKey(data, "home")) this.tree.move(-Infinity);
    else if (matchesKey(data, "end")) this.tree.move(Infinity);
    else if (matchesKey(data, "ctrl+u")) this.tree.move(-Math.max(1, Math.floor(this.scroll.viewportHeight / 2)));
    else if (matchesKey(data, "ctrl+d")) this.tree.move(Math.max(1, Math.floor(this.scroll.viewportHeight / 2)));
    else if (matchesKey(data, "left")) this.tree.collapse();
    else if (matchesKey(data, "right")) void this.tree.expand();
    else if (matchesKey(data, "enter")) {
      if (this.tree.node()?.kind === "directory") void this.tree.toggle(); else void this.preview();
    }
    else if (matchesKey(data, "space")) void this.menu();
    else if (data === "y") void this.copy();
    else if (data === "a") void this.reference();
    else if (data === "e") void this.external();
    else if (matchesKey(data, ".") || data === "。") this.tree.toggleHidden();
    else if (data === "r") void this.tree.refresh();
  }

  // 只加速连续的同一方向按键；换向、间隔过长或离开侧栏都从 1 项重新开始。
  private move(direction: -1 | 1, key: "up" | "down") {
    const now = performance.now(), held = this.held;
    const next = !held || held.key !== key || now - held.last > REPEAT_RESET_AFTER
      ? { key, since: now, last: now } : { key, since: held.since, last: now };
    this.held = next;
    const duration = now - next.since;
    this.tree.move(direction * (1 + REPEAT_STEP_AFTER.filter((threshold) => duration >= threshold).length));
  }

  private wheel(event: TuiMouseEvent, target: Component) {
    if (event.type !== "wheel") return undefined;
    const before = this.scroll.scrollTop;
    if (this.host.canInteract && !this.host.resizing) this.scroll.scrollBy(event.wheelDelta ?? 0);
    return { handled: true as const, render: this.scroll.scrollTop !== before,
      target: { component: target, originX: event.screenX - event.x, originY: event.screenY - event.y, width: event.width, height: event.height } };
  }
  private mouse(event: TuiMouseEvent) {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
    if (!this.host.canInteract || this.host.resizing) return { handled: true, render: false };
    const row = this.frame[event.y]; // 原生 ScrollView 已把 y 转为内容坐标，不再加 scrollTop。
    if (event.type === "press") this.pressed = row?.path;
    if (event.type === "click") {
      const path = this.pressed ?? row?.path;
      const doubleClick = (event.clickCount ?? 1) >= 2 && this.clickedPath === path;
      this.pressed = undefined; this.clickedPath = path;
      if (path && this.tree.select(path) && row?.path === path) {
        if (event.x === row.marker && this.tree.node(path)?.kind === "directory") void this.tree.toggle(path);
        else if (doubleClick && this.tree.node(path)?.kind === "file") void this.preview(path);
      }
    }
    return { handled: true, focus: true };
  }
  dispose(): Promise<void> {
    const pending = this.externalDone;
    if (!this.disposed) {
      this.disposed = true; this.nameTip?.dispose(); this.cancelActions(); this.tree.dispose(); this.scroll.setScrollbar("hidden"); this.host.dispose();
      this.frame = []; this.cache = undefined; this.pressed = undefined; this.clickedPath = undefined; this.held = undefined;
    }
    // 会话替换等待旧编辑器和已确认的语言写入；旧结果不能操作新 renderer 或覆盖新偏好。
    return Promise.allSettled([this.languageSave, pending]).then(() => {});
  }
}
