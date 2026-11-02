import { VERSION, type CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { HStack, isViewportTUI, type Component, type TUI } from "@earendil-works/pi-tui";

type NativeTUI = TUI & { layoutRoot?: Component; getFocusedComponent(): Component | null };
export type HostReason = "disposed" | "incompatible" | "closed" | "regular" | "waiting" | "small" | "external" | "mounted" | "takenOver";
const PROBE = "pi-file-sidebar:host";
export const ACTIVATE = "ctrl+shift+e";

// Pi 1.4.0 的布局 getter 尚非公共契约；必要内部读取集中在本模块。
function contains(root: Component | undefined, target: Component | null): boolean {
  if (!root || !target) return false;
  const pending = [root], seen = new Set<Component>();
  while (pending.length) {
    const item = pending.pop()!;
    if (item === target) return true;
    if (seen.has(item)) continue;
    seen.add(item);
    const children = (item as Component & { children?: Component[] }).children;
    if (Array.isArray(children)) pending.push(...children);
  }
  return false;
}

export class SidebarHost {
  private raw?: NativeTUI;
  private main?: Component;
  private wrapper?: HStack;
  private editor: Component | null = null;
  private enabled = true;
  private disposed = false;
  private retired?: "incompatible" | "takenOver";
  private candidate = 32;
  private original?: number;
  private blocked = 0;
  private paused = false;
  private pending?: NodeJS.Immediate;
  private unsubscribe?: () => void;
  private binding = 0;
  private signature = "";

  constructor(private ctx: ExtensionContext, private panel: Component, private target: Component, private onChange: () => void) {
    ctx.ui.setWidget(PROBE, (tui) => {
      const binding = ++this.binding;
      this.raw = tui as NativeTUI;
      this.queue();
      return { render: () => { this.queue(); return []; }, invalidate() {},
        dispose: () => { if (binding === this.binding) this.detach(); } };
    }, { placement: "belowEditor" });
    this.unsubscribe = ctx.ui.onTerminalInput(() => { this.queue(); return undefined; });
  }

  get width() { return this.candidate; }
  get confirmedWidth() { return this.original ?? this.candidate; }
  get resizing() { return this.original !== undefined; }
  get maxWidth() { return Math.min(48, (this.raw?.terminal.columns ?? 0) - 65); }
  get focused() { return this.raw?.getFocusedComponent?.() === this.target; }
  get alive() { return !this.disposed && !this.retired; }
  get visible() {
    return this.alive && this.enabled && !!this.wrapper && this.raw?.layoutRoot === this.wrapper
      && this.raw.mode === "fullscreen" && this.raw.terminal.rows >= 8 && this.maxWidth >= this.width;
  }
  get canInteract() {
    const focus = this.raw?.getFocusedComponent?.();
    return this.visible && !this.blocked && !this.paused && (focus === this.target || (focus === this.editor && !!this.editor));
  }
  get reason(): HostReason {
    if (this.disposed) return "disposed";
    if (this.retired) return this.retired;
    if (!this.enabled) return "closed";
    if (this.raw?.mode !== "fullscreen") return "regular";
    if (!this.main || !this.wrapper) return "waiting";
    if (this.raw.terminal.rows < 8 || this.maxWidth < this.width) return "small";
    return this.paused ? "external" : "mounted";
  }
  get tui(): TUI | undefined { return this.alive ? this.raw : undefined; }

  private queue() {
    if (this.pending || this.disposed || this.paused) return;
    this.pending = setImmediate(() => { this.pending = undefined; this.inspect(); });
  }

  private rememberEditor() {
    const focus = this.raw?.getFocusedComponent?.();
    if (!focus || focus === this.target || focus === this.editor) return;
    const input = focus as Partial<CustomEditor>;
    if (contains(this.main, focus) && typeof input.getText === "function" && typeof input.setText === "function"
      && typeof input.onAction === "function" && (input.getExpandedText?.() ?? input.getText()) === this.ctx.ui.getEditorText()) this.editor = focus;
  }

  inspect() {
    const tui = this.raw;
    if (!tui || this.disposed || this.paused) return;
    if (VERSION !== "1.4.0" || typeof tui.getFocusedComponent !== "function") {
      this.retired = "incompatible";
    }
    if (this.retired) { this.emit(); return; }
    if (tui.mode !== "fullscreen" || !isViewportTUI(tui)) {
      this.finishResize(false); this.release(); this.wrapper = undefined; this.main = undefined;
      this.emit(); return;
    }
    if (this.wrapper && tui.layoutRoot !== this.wrapper) {
      this.finishResize(false); this.release();
      if (tui.layoutRoot) this.retired = "takenOver";
      this.wrapper = undefined; this.main = undefined;
      if (this.retired) { tui.requestRender(); this.emit(); return; }
    }
    if (!this.wrapper && this.enabled) {
      this.main = tui.layoutRoot;
      if (this.main && typeof this.main.render === "function") { this.rememberEditor(); this.rebuild(); }
    }
    this.rememberEditor();
    if (this.resizing && (!this.visible || !this.focused || this.blocked)) this.finishResize(false);
    if (!this.visible) this.release();
    this.emit();
  }

  private rebuild() {
    const tui = this.raw;
    if (!tui || !this.main || !this.alive || !isViewportTUI(tui) || tui.mode !== "fullscreen") return;
    if (this.wrapper && tui.layoutRoot !== this.wrapper) return;
    const visible = (v: { width: number; height?: number }) => this.alive && this.enabled && tui.mode === "fullscreen"
      && v.height !== undefined && v.height < Number.MAX_SAFE_INTEGER && v.height >= 8 && v.width >= this.width + 65;
    const divider: Component = { render: () => Array.from({ length: tui.terminal.rows }, () => this.ctx.ui.theme.fg("border", "│")), invalidate() {} };
    this.wrapper = new HStack([
      { component: this.panel, basis: this.width, shrink: 0, visible },
      { component: divider, basis: 1, shrink: 0, visible },
      { component: this.main, basis: 0, grow: 1, minSize: 1 },
    ]);
    tui.setLayoutRoot(this.wrapper);
  }

  private emit(force = false) {
    const state = [this.reason, this.width, this.resizing, this.visible, this.focused, this.blocked].join("|");
    if (!force && state === this.signature) return;
    this.signature = state;
    this.panel.invalidate();
    this.raw?.requestRender();
    this.onChange();
  }

  enter(toggle = false): boolean {
    if (!this.alive) return false;
    this.enabled = true; this.inspect();
    if (!this.canInteract) return false;
    if (toggle && this.focused) this.leave();
    else { this.raw!.setFocus(this.target); this.emit(); }
    return true;
  }

  private release() {
    if (this.focused && this.raw) {
      this.raw.setFocus(contains(this.raw.layoutRoot ?? this.raw, this.editor) ? this.editor : null);
    }
  }
  leave() { this.finishResize(false); this.release(); this.emit(); }

  beginResize(): boolean {
    this.inspect();
    if (!this.canInteract || !this.focused || this.maxWidth < 24 || this.resizing) return false;
    this.original = this.width; this.emit(); return true;
  }
  resizeBy(delta: number) {
    if (!this.resizing || !this.canInteract || !this.focused) return;
    const next = Math.max(24, Math.min(this.maxWidth, this.width + delta));
    if (next === this.width) return;
    this.candidate = next; this.rebuild(); this.emit();
  }
  finishResize(commit: boolean) {
    if (this.original === undefined) return;
    const before = this.width;
    if (!commit) this.candidate = this.original;
    this.original = undefined;
    if (before !== this.width) this.rebuild();
    this.emit();
  }
  setWidth(width: number): boolean {
    if (!Number.isInteger(width) || width < 24 || width > 48 || !this.alive) return false;
    this.original = undefined;
    if (this.width !== width) { this.candidate = width; this.rebuild(); }
    this.inspect(); this.emit(); return true;
  }
  setEnabled(enabled: boolean) {
    if (!this.alive) return;
    this.finishResize(false); this.enabled = enabled;
    if (!enabled) { this.release(); this.detach(); }
    else this.inspect();
    this.emit();
  }
  prompt(start: boolean) {
    this.blocked = Math.max(0, this.blocked + (start ? 1 : -1));
    if (start) this.finishResize(false);
    this.queue(); this.emit();
  }
  setPaused(paused: boolean) {
    this.paused = paused;
    if (paused) this.finishResize(false); else this.queue();
    this.emit();
  }
  redraw() { this.panel.invalidate(); this.raw?.requestRender(); }

  private detach() {
    this.release();
    if (this.wrapper && this.raw && isViewportTUI(this.raw) && this.raw.layoutRoot === this.wrapper) this.raw.setLayoutRoot(this.main);
    this.wrapper = undefined; this.main = undefined;
  }
  dispose() {
    if (this.disposed) return;
    this.finishResize(false); this.detach(); this.disposed = true; this.enabled = false;
    if (this.pending) clearImmediate(this.pending);
    this.pending = undefined; this.unsubscribe?.(); this.unsubscribe = undefined;
    this.ctx.ui.setWidget(PROBE, undefined);
    this.emit();
  }
}
