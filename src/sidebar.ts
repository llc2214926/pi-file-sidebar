import { spawn, type ChildProcess } from "node:child_process";
import { basename, dirname, relative, resolve } from "node:path";
import { getSelectListTheme, type ExtensionContext, type ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { Container, ScrollView, SelectList, Text, VStack, matchesKey, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { copyPath, formatReference, parseEditorCommand, readEditorCommand, validateFile } from "./actions.ts";
import { ACTIVATE, SidebarHost } from "./host.ts";
import { FileTree, displayText, isWithin } from "./tree.ts";
import { readPreview, TextPreview } from "./preview.ts";

export class FileSidebar {
  readonly host: SidebarHost;
  readonly tree: FileTree;
  private rows: Component & { focused: boolean };
  private scroll: ScrollView;
  private panel: VStack;
  private cache?: { key: string; lines: string[] };
  private frame: { path: string; marker: number }[] = [];
  private pressed?: string;
  private clickedPath?: string;
  private wasFocused = false;
  private disposed = false;
  private acting = false;
  private actionGeneration = 0;
  private closeModal?: () => void;
  private externalRunning = false;
  private child?: ChildProcess;
  private externalDone?: Promise<number | null>;

  constructor(private ctx: ExtensionContext) {
    this.tree = new FileTree(ctx.cwd, (reveal) => {
      this.cache = undefined;
      if (reveal) this.revealSelection();
      this.host?.redraw();
    });
    this.rows = { focused: false, render: (width) => this.renderRows(width),
      invalidate: () => { this.cache = undefined; }, handleInput: (data) => this.input(data), handleMouse: (event) => this.mouse(event) };
    this.scroll = new ScrollView(this.rows, { follow: "none", overscroll: "contain", scrollbar: "auto" });
    // 1.4.0 的 contain 仍会将边界残余量回退到主对话；只在自己的组件消费 wheel。
    this.scroll.handleMouse = (event) => this.wheel(event, this.scroll);
    const text = (lines: () => string[]): Component => ({ render: (width) => lines().map((line) => truncateToWidth(line, width)), invalidate() {} });
    this.panel = new VStack([
      { component: text(() => [this.ctx.ui.theme.fg("accent", `Files${this.tree.showHidden ? " · 隐藏项可见" : ""}`), displayText(basename(this.tree.root) || this.tree.root)]), basis: 2, shrink: 0 },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: text(() => this.host?.resizing
        ? [`宽度：${this.host.width} 列 · 24–${this.host.maxWidth}`, "←→ Enter确认 Esc取消"]
        : [displayText(relative(this.tree.root, this.tree.selected) || "."), "Enter 预览 · Space 操作 · w 调宽"]), basis: 2, shrink: 0 },
    ]);
    this.panel.handleMouse = (event) => this.wheel(event, this.panel);
    this.host = new SidebarHost(ctx, this.panel, this.rows, () => this.hostChanged());
  }

  get scrollTop() { return this.scroll.scrollTop; }
  private hostChanged() {
    if (this.disposed) return;
    const visible = this.host?.visible ?? false, focused = this.host?.focused ?? false;
    if (!visible) this.cancelActions();
    this.tree.setActive(visible && !this.externalRunning);
    this.scroll.setScrollbar(visible && !this.externalRunning ? "auto" : "hidden");
    if (focused && !this.wasFocused) {
      const loaded = this.tree.loadedDirectories().filter((path) => this.tree.node(path)?.state !== "loading");
      void this.tree.refresh(loaded);
    }
    this.wasFocused = focused;
  }
  private renderRows(width: number): string[] {
    const key = `${width}:${this.tree.revision}:${this.host?.focused}`;
    if (this.cache?.key === key) return this.cache.lines;
    const data = this.tree.rows();
    this.frame = data.map(({ node, depth }) => ({ path: node.path, marker: 2 + depth * 2 }));
    const lines = data.map(({ node, depth }) => {
      const selected = node.path === this.tree.selected;
      const icon = node.kind === "directory" ? (this.tree.expanded.has(node.path) ? "▾" : "▸") : node.kind === "symlink" ? "↗" : " ";
      const state = node.state === "loading" ? "（加载中）" : node.error ? `（${node.error}）`
        : node.kind === "directory" && node.state === "loaded" && !node.children.length ? "（空目录）" : "";
      const label = `${selected ? ">" : " "} ${"  ".repeat(depth)}${icon} ${displayText(node.name)}${state}`;
      return truncateToWidth(this.ctx.ui.theme.fg(selected && this.host?.focused ? "accent" : node.error ? "error" : "text", label), width);
    });
    this.cache = { key, lines }; return lines;
  }
  private revealSelection() {
    if (!this.host?.visible) return;
    const rows = this.tree.rows(), index = rows.findIndex((row) => row.node.path === this.tree.selected);
    const height = Math.max(1, (this.host.tui?.terminal.rows ?? 8) - 4);
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

  command(args: string) {
    const [name = "focus", value, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (name === "focus" && !value) this.host.enter();
    else if (name === "on" && !value) this.host.setEnabled(true);
    else if (name === "off" && !value) this.host.setEnabled(false);
    else if (name === "refresh" && !value) void this.tree.refresh();
    else if (name === "width" && !rest.length && value && /^\d+$/.test(value) && this.host.setWidth(Number(value))) return;
    else if (name !== "status" || value) {
      this.ctx.ui.notify("用法：/file-sidebar [focus|on|off|refresh|width 24…48|status]", "warning"); return;
    }
    if (name === "status" || (name === "focus" && !this.host.focused)) {
      this.ctx.ui.notify(`${this.host.reason}；宽度 ${this.host.width}；焦点 ${this.host.focused ? "文件树" : "Pi"}；缓存 ${this.tree.size} 项；读取中 ${this.tree.pending}`, "info");
    }
  }

  private currentAction(id: number) { return id === this.actionGeneration && !this.disposed && this.host.alive && this.host.visible; }
  private cancelActions() {
    if (!this.acting && !this.closeModal) return;
    this.actionGeneration++; this.acting = false;
    const close = this.closeModal; this.closeModal = undefined; close?.();
    this.child?.kill();
    if ((!this.host.visible || this.disposed) && this.host.focused) this.host.leave();
  }
  private report(error: unknown) {
    if (!this.disposed && this.host.alive) this.ctx.ui.notify(displayText(error instanceof Error ? error.message : String(error)), "warning");
  }
  private async runAction(work: (id: number) => Promise<void>) {
    if (this.acting || !this.host.canInteract || !this.host.focused || this.host.resizing) return;
    this.acting = true; const id = ++this.actionGeneration;
    try { await work(id); }
    catch (error) { if (this.currentAction(id)) this.report(error); }
    finally {
      if (id === this.actionGeneration) { this.acting = false; this.closeModal = undefined; if (!this.disposed) this.host.inspect(); }
    }
  }
  private ready(id: number) { return this.currentAction(id) && this.host.canInteract && this.host.focused; }
  private preview(path = this.tree.selected) {
    return this.runAction(async (id) => {
      if (this.tree.node(path)?.kind !== "file") throw new Error("此动作仅支持普通文件；链接可以复制路径");
      const data = await readPreview(this.tree.root, path);
      if (!this.ready(id)) return;
      await this.ctx.ui.custom<void>((tui, _theme, _keys, done) => {
        this.closeModal = done;
        return new TextPreview(data, () => this.ctx.ui.theme, tui, done);
      }, { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%" } });
    });
  }
  private copy(absolute = false, path = this.tree.selected) {
    return this.runAction(async (id) => {
      if (await copyPath(this.tree.root, path, absolute, () => this.ready(id))) {
        if (this.currentAction(id)) this.ctx.ui.notify(`已复制${absolute ? "绝对" : "相对"}路径`, "info");
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
      if (!this.ctx.isIdle()) throw new Error("Pi 正在工作，不能启动外部编辑器；请等待空闲");
      const [actual, command] = await Promise.all([validateFile(this.tree.root, path), readEditorCommand(this.ctx.cwd, this.ctx.isProjectTrusted())]);
      const argv = parseEditorCommand(command);
      if (!this.ready(id)) return;
      if (!this.ctx.isIdle()) throw new Error("Pi 已开始工作，取消编辑器启动");
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
          tui.start(); this.host.setPaused(false); this.host.redraw(); void this.tree.refresh([dirname(path)]);
        }
      }
      if (!this.currentAction(id)) return;
      if (code !== 0) throw new Error(code === null ? "编辑器进程已被终止" : `编辑器退出码：${code}`);
      this.ctx.ui.notify("编辑器进程已结束；GUI 启动器没有等待参数时，不代表文件已编辑完毕", "info");
    });
  }
  private async menu() {
    const path = this.tree.selected, kind = this.tree.node(path)?.kind;
    let choice: string | undefined;
    await this.runAction(async (id) => {
      const items = [
        ...(kind === "directory" ? [{ value: "toggle", label: "展开 / 折叠目录" }] : []),
        ...(kind === "file" ? [{ value: "preview", label: "只读文本预览" }] : []),
        { value: "relative", label: "复制相对路径" }, { value: "absolute", label: "复制绝对路径" },
        ...(kind === "file" ? [{ value: "reference", label: "插入 @引用（不发送）" },
          { value: "external", label: this.ctx.isIdle() ? "外部编辑器打开" : "外部编辑器（Pi 忙碌，不可用）" }] : []),
        { value: "cancel", label: "取消" },
      ];
      const result = await this.ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
        this.closeModal = () => done(undefined);
        const list = new SelectList(items, Math.max(1, Math.min(8, tui.terminal.rows - 5)), getSelectListTheme());
        list.onCancel = () => done(undefined);
        list.onSelect = (item) => {
          if (item.value === "external" && !this.ctx.isIdle()) { this.report("Pi 正在工作，外部编辑器不可用"); return; }
          done(item.value);
        };
        const component: Container & Component = new Container();
        component.addChild(new Text(displayText(relative(this.tree.root, path) || "."), 0, 0));
        component.addChild(list); component.addChild(new Text("↑↓ Enter / 点击选择 · Esc 返回", 0, 0));
        component.handleInput = (data) => list.handleInput(data);
        return component;
      }, { overlay: true, overlayOptions: { width: "80%", maxHeight: "90%" } });
      if (this.currentAction(id)) choice = result;
    });
    if (choice === "preview") await this.preview(path);
    else if (choice === "relative" || choice === "absolute") await this.copy(choice === "absolute", path);
    else if (choice === "reference") await this.reference(path);
    else if (choice === "external") await this.external(path);
    else if (choice === "toggle" && !this.disposed && this.host.canInteract) await this.tree.toggle(path);
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
    if (matchesKey(data, "escape")) { this.cancelActions(); this.host.leave(); }
    else if (data === "w") this.host.beginResize();
    else if (matchesKey(data, "up")) this.tree.move(-1);
    else if (matchesKey(data, "down")) this.tree.move(1);
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
    else if (data === ".") this.tree.toggleHidden();
    else if (data === "r") void this.tree.refresh();
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
      this.disposed = true; this.cancelActions(); this.tree.dispose(); this.scroll.setScrollbar("hidden"); this.host.dispose();
      this.frame = []; this.cache = undefined; this.pressed = undefined; this.clickedPath = undefined;
    }
    // 会话替换先等待已交接的进程结束；旧进程不能与新 renderer 同时占用 TTY。
    return pending ? pending.then(() => {}, () => {}) : Promise.resolve();
  }
}
