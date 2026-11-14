import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type OverlayHandle, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { getMessages, type Language } from "./i18n.ts";
import { displayText } from "./tree.ts";

export interface NameTipTarget {
  key: string;
  name: string;
  // 终端绝对坐标：选中行及容器右沿，不受侧栏/分栏宽度限制。
  anchor: () => { row: number; col: number } | undefined;
}
interface TipLayout { row: number; col: number; width: number; height: number; lines: string[]; pageSize: number; title: boolean; paged: boolean }
interface TipMount { layout: TipLayout; handle?: OverlayHandle }

// 仅呈现已知名称，不读文件、不注册计时器；所有调用方共用非捕获原生 overlay。
export class NameTooltip implements Component {
  private target?: NameTipTarget;
  private mount?: TipMount;
  private layout?: TipLayout;
  private offset = 0;
  private signature = "";
  private queued = false;
  private disposed = false;

  constructor(readonly tui: TUI, private theme: () => Theme, private language: () => Language,
    private active: () => boolean) {}

  update(target: NameTipTarget | undefined): void {
    if (this.disposed) return;
    if (!target) { this.hide(); return; }
    if (this.target?.key !== target.key || this.target?.name !== target.name) this.offset = 0;
    this.target = target;
    if (this.queued) return;
    this.queued = true;
    // 显示/布局更新推迟到合成结束；同步收起时由挂载快照保护宿主仍持有的 entry。
    queueMicrotask(() => {
      this.queued = false;
      if (!this.disposed) this.sync();
    });
  }

  private sync() {
    const target = this.target, anchor = target?.anchor();
    const columns = this.tui.terminal.columns, rows = this.tui.terminal.rows;
    if (!target || !anchor || !this.active() || columns < 10 || rows < 6) { this.hide(); return; }
    const name = displayText(target.name);
    const width = Math.min(columns - 2, Math.max(24, Math.min(80, visibleWidth(name) + 4)));
    const lines = wrapTextWithAnsi(name, width - 4);
    const maxHeight = Math.min(12, rows - 2), title = maxHeight >= 5;
    const capacity = maxHeight - 2 - Number(title), paged = lines.length > capacity;
    const pageSize = paged ? capacity - 1 : lines.length;
    this.offset = Math.max(0, Math.min(this.offset, lines.length - pageSize));
    const height = pageSize + 2 + Number(title) + Number(paged);
    const col = Math.max(1, Math.min(anchor.col, columns - width - 1));
    const preferredRow = anchor.row + height + 1 < rows ? anchor.row + 1 : anchor.row - height;
    const row = Math.max(1, Math.min(preferredRow, rows - height - 1));
    const signature = JSON.stringify([target.key, name, row, col, width, height, this.offset]);
    this.layout = { row, col, width, height, lines, pageSize, title, paged };
    if (this.mount) this.mount.layout = this.layout;
    else {
      const mount: TipMount = { layout: this.layout };
      this.mount = mount;
      // Pi 1.5.0 仍先快照可见 entry；下层 render 收起气泡后，本帧仍可能读取旧 getter。
      // 每次挂载保留自己的有效布局，旧组件退休后不绘制、不接管新一轮气泡的事件。
      mount.handle = this.tui.showOverlay({
        render: (width) => this.mount === mount ? this.render(width) : [],
        handleMouse: (event) => this.mount === mount ? this.handleMouse(event) : { handled: true },
        invalidate: () => { if (this.mount === mount) this.invalidate(); },
      }, {
        nonCapturing: true, anchor: "top-left", margin: 0,
        get row() { return mount.layout.row; }, get col() { return mount.layout.col; },
        get width() { return mount.layout.width; }, get maxHeight() { return mount.layout.height; },
        visible: (columns, rows) => this.mount === mount && columns >= 10 && rows >= 6
          && !this.disposed && !!this.target && this.active(),
      });
    }
    if (signature !== this.signature) { this.signature = signature; this.tui.requestRender(); }
  }

  hide(): void {
    const mount = this.mount; this.mount = undefined;
    this.target = undefined; this.layout = undefined; this.offset = 0; this.signature = "";
    mount?.handle?.hide();
  }
  dispose(): void { this.disposed = true; this.hide(); }
  invalidate(): void { /* 文案和主题由 getter 即时读取。 */ }

  // 不占用 PageUp/PageDown，普通树焦点下仍由主对话处理。
  handleInput(data: string): boolean {
    if (!this.mount?.handle || !this.active() || !this.layout?.paged) return false;
    if (matchesKey(data, "[")) this.scroll(-this.layout.pageSize);
    else if (matchesKey(data, "]")) this.scroll(this.layout.pageSize);
    else return false;
    return true;
  }
  private scroll(delta: number) {
    if (!this.layout) return;
    const next = Math.max(0, Math.min(this.layout.lines.length - this.layout.pageSize, this.offset + delta));
    if (next !== this.offset) { this.offset = next; this.tui.requestRender(); }
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel" && this.active()) this.scroll(event.wheelDelta ?? 0);
    return { handled: true }; // 不夺焦点，也不把滚轮/点击传给背后的主对话。
  }

  render(width: number): string[] {
    const layout = this.layout;
    if (!layout || this.disposed || !this.active() || width < 4) return [];
    const theme = this.theme(), text = getMessages(this.language()).tooltip;
    const content: string[] = [];
    if (layout.title) content.push(theme.fg("muted", `${text.fullName}${layout.paged ? ` ${this.offset + 1}–${this.offset + layout.pageSize}/${layout.lines.length}` : ""}`));
    content.push(...layout.lines.slice(this.offset, this.offset + layout.pageSize).map((line) => theme.fg("text", line)));
    if (layout.paged) content.push(theme.fg("dim", text.footer));
    const side = theme.fg("border", "│");
    return [theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
      ...content.map((line) => `${side} ${truncateToWidth(line, width - 4, "", true)} ${side}`),
      theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`)];
  }
}
