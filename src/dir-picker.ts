import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type OverlayHandle, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMessages, type Language } from "./i18n.ts";
import { REPEAT_RESET_AFTER, REPEAT_STEP_AFTER } from "./sidebar.ts";
import { displayText } from "./tree.ts";
import { overlayHeight } from "./frame.ts";
import { NameTooltip } from "./name-tooltip.ts";

const COL_WIDTH = 28, COL_GAP = 3;
interface Column {
  dir: string;
  entries: { name: string; directory: boolean }[];
  sel: number;
  top: number;
  loading: boolean;
  error?: { code?: string };
  generation: number;
  highlight?: string;
}

export function shortenPath(dir: string): string {
  const home = homedir();
  return displayText(dir === home ? "~" : dir.startsWith(`${home}${sep}`) ? `~${dir.slice(home.length)}` : dir);
}

// 只异步读取已进入的层级；不扫描后代、不跟随目录项中的链接。render 不做 I/O。
export class DirPicker implements Component {
  private columns: Column[] = [];
  private active = 0;
  private colOffset = 0;
  private rows = 10;
  private hidden = false;
  private disposed = false;
  private held?: { direction: number; since: number; last: number };
  private overlay?: OverlayHandle;
  private nameTip: NameTooltip;
  private mousePress?: { col: Column; generation: number; row: number } | null;
  private mouseLayout?: {
    width: number;
    colWidth: number;
    listTop: number;
    rows: number;
    columns: { col: Column; generation: number; top: number; loading: boolean; contentWidth: number }[];
  };

  constructor(private tui: TUI, private theme: () => Theme, private language: () => Language,
    private done: (dir: string | undefined) => void, private readonly initialDir: string,
    private reader: (dir: string) => Promise<Dirent[]> = (dir) => readdir(dir, { withFileTypes: true })) {
    this.nameTip = new NameTooltip(tui, theme, language, () => !this.disposed && this.overlay?.isFocused() === true);
    this.columns.push(this.createColumn(initialDir));
  }

  bindOverlay(handle: OverlayHandle): void {
    if (!this.disposed) { this.overlay = handle; this.tui.requestRender(); }
  }

  private createColumn(dir: string, highlight?: string): Column {
    const col: Column = { dir, entries: [], sel: 0, top: 0, loading: true, generation: 0 };
    void this.load(col, highlight);
    return col;
  }

  private async load(col: Column, highlight?: string) {
    const generation = ++col.generation, hidden = this.hidden;
    col.loading = true; col.error = undefined; col.highlight = highlight;
    try {
      const entries = await this.reader(col.dir);
      if (this.disposed || generation !== col.generation || !this.columns.includes(col)) return;
      col.entries = entries.filter((entry) => (entry.isDirectory() || entry.isFile())
        && (hidden || (!entry.name.startsWith(".") && entry.name !== "node_modules")))
        .map((entry) => ({ name: entry.name, directory: entry.isDirectory() }))
        .sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
      col.sel = col.highlight === undefined ? 0 : Math.max(0, col.entries.findIndex((entry) => entry.name === col.highlight) + 1);
    } catch (error) {
      if (this.disposed || generation !== col.generation || !this.columns.includes(col)) return;
      col.entries = []; col.sel = 0; col.error = { code: (error as NodeJS.ErrnoException).code };
    }
    col.loading = false; this.clamp(col); this.tui.requestRender();
  }

  private get col() { return this.columns[this.active]!; }
  // 文件可选中查看全名，但所有进入/确认路径共用目录检查，重读期间也不使用旧项。
  private rowDirectory(col: Column): string | undefined {
    if (col.sel === 0) return col.dir;
    const entry = !col.loading ? col.entries[col.sel - 1] : undefined;
    return entry?.directory ? join(col.dir, entry.name) : undefined;
  }
  private clamp(col: Column, revealSelection = true) {
    col.sel = Math.min(col.entries.length, Math.max(0, col.sel));
    if (revealSelection) {
      if (col.sel < col.top) col.top = col.sel;
      else if (col.sel >= col.top + this.rows) col.top = col.sel - this.rows + 1;
    }
    col.top = Math.max(0, Math.min(col.top, col.entries.length + 1 - this.rows));
  }
  // 与文件树相同：滚离顶部才显示位置条；至少留一列给内容，读取中不画旧位置。
  private contentWidth(col: Column, width: number): number {
    return width > 1 && !col.loading && col.top > 0 ? width - 1 : width;
  }
  private enter() {
    if (this.col.sel === 0) return;
    const dir = this.rowDirectory(this.col);
    if (dir === undefined) return;
    this.columns.length = this.active + 1;
    this.columns.push(this.createColumn(dir)); this.active++;
  }
  private leave() {
    if (this.active === 0) {
      const dir = this.col.dir, parent = dirname(dir);
      if (parent !== dir) this.columns.unshift(this.createColumn(parent, basename(dir)));
    } else {
      this.columns.length = this.active; this.active--;
    }
    this.clamp(this.col);
  }
  private returnToWorkspace() {
    this.nameTip.hide();
    const workspace = this.columns.find((col) => col.dir === this.initialDir) ?? this.createColumn(this.initialDir);
    workspace.sel = 0; workspace.top = 0; workspace.highlight = undefined;
    this.columns = [workspace]; this.active = 0; this.colOffset = 0;
    // 只返回浏览起点，保留隐藏项开关；被移除分栏的异步结果由 load 的身份检查丢弃。
  }
  private move(direction: -1 | 1, accelerate: boolean) {
    const now = performance.now(), held = this.held;
    const next = !accelerate || !held || held.direction !== direction || now - held.last > REPEAT_RESET_AFTER
      ? { direction, since: now, last: now } : { direction, since: held.since, last: now };
    this.held = accelerate ? next : undefined;
    this.col.sel += direction * (1 + REPEAT_STEP_AFTER.filter((threshold) => now - next.since >= threshold).length);
    this.clamp(this.col);
  }

  handleInput(data: string): void {
    if (this.disposed) return;
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.dispose(); this.done(undefined); return;
    }
    if (matchesKey(data, Key.enter)) {
      this.held = undefined;
      const picked = this.rowDirectory(this.col);
      if (picked === undefined) return;
      this.dispose(); this.done(picked); return;
    }
    if (this.nameTip.handleInput(data)) { this.held = undefined; return; }
    if (matchesKey(data, Key.up)) this.move(-1, true);
    else if (matchesKey(data, Key.down)) this.move(1, true);
    else {
      this.held = undefined;
      if (matchesKey(data, "k")) this.move(-1, false);
      else if (matchesKey(data, "j")) this.move(1, false);
      else if (matchesKey(data, Key.left)) this.leave();
      else if (matchesKey(data, Key.right) || matchesKey(data, "l")) this.enter();
      else if (matchesKey(data, "r")) this.returnToWorkspace();
      else if (matchesKey(data, ".") || data === "。") {
        this.hidden = !this.hidden;
        for (const col of this.columns) void this.load(col, col.sel > 0 ? col.entries[col.sel - 1]?.name : undefined);
      } else return;
    }
    this.tui.requestRender();
  }

  private mouseColumn(event: TuiMouseEvent) {
    const layout = this.mouseLayout;
    if (!layout || event.width !== layout.width || event.x < 0 || event.x >= layout.width
      || event.y < layout.listTop || event.y >= layout.listTop + layout.rows) return;
    const slot = Math.floor(event.x / (COL_WIDTH + COL_GAP)), cell = layout.columns[slot];
    // Box 已将坐标转换到正文；分隔线不属于任何栏，位置条上的滚轮仍属于本栏。
    if (!cell || event.x - slot * (COL_WIDTH + COL_GAP) >= layout.colWidth) return;
    if (!this.columns.includes(cell.col) || cell.loading || cell.col.loading || cell.generation !== cell.col.generation) return;
    return cell;
  }

  private mouseRow(event: TuiMouseEvent) {
    const cell = this.mouseColumn(event);
    // 点击用最近一帧的滚动偏移，旧帧或位置条不能当作项目；连续滚轮不受此限制。
    if (!cell || event.x % (COL_WIDTH + COL_GAP) >= cell.contentWidth || cell.top !== cell.col.top) return;
    const row = cell.top + event.y - this.mouseLayout!.listTop;
    return row <= cell.col.entries.length ? { col: cell.col, generation: cell.generation, row } : undefined;
  }

  private scrollColumn(event: TuiMouseEvent): TuiMouseEventResult {
    this.held = undefined; this.mousePress = null;
    const cell = this.mouseColumn(event), delta = event.wheelDelta ?? 0;
    if (!cell || !Number.isFinite(delta)) return { handled: true, render: false };
    const { col } = cell, before = col.top;
    col.top += Math.trunc(delta);
    this.clamp(col, false);
    // 仅滚动视口，不改选择、活动栏或后续分栏；到底/到顶也不能穿透到主对话。
    const changed = col.top !== before;
    if (changed) this.tui.requestRender();
    return { handled: true, render: changed };
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (this.disposed) return;
    if (event.type === "wheel") return this.scrollColumn(event);
    if (event.type === "drag") this.mousePress = null;
    if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return;
    this.held = undefined;
    const ignored = { handled: true, render: false }, target = this.mouseRow(event);
    // 只在 click 时导航；press 先消费并记住项目，读取/换栏后不能误点同坐标的新行。
    if (event.type === "press") { this.mousePress = target ?? null; return ignored; }
    const pressed = this.mousePress; this.mousePress = undefined;
    if (!target || pressed === null || (pressed && (pressed.col !== target.col
      || pressed.generation !== target.generation || pressed.row !== target.row))) return ignored;
    const { col, row } = target, index = this.columns.indexOf(col);
    this.nameTip.hide();
    this.active = index; this.columns.length = index + 1;
    col.sel = row; this.clamp(col);
    // 与键盘共用目录检查；文件和 . 只选中，目录才打开下一级，均不确认切换会话。
    this.enter();
    this.mouseLayout = undefined;
    this.tui.requestRender();
    return { handled: true, render: true };
  }

  invalidate(): void { this.mouseLayout = undefined; /* 主题和语言通过 getter 即时呈现，不重读目录。 */ }
  dispose(): void {
    this.disposed = true; this.held = undefined; this.mousePress = undefined; this.mouseLayout = undefined; this.nameTip.dispose();
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    const text = getMessages(this.language()).picker, theme = this.theme();
    // 与预览相同：外框最多 30 行/90% 窗高，先扣掉上下边框，避免页脚被宿主裁切。
    const height = Math.max(1, Math.min(30, overlayHeight(this.tui.terminal.rows || 24)) - 2);
    const colWidth = Math.min(COL_WIDTH, Math.max(1, width));
    const showTitle = height >= 2;
    const footerBudget = height >= 3 ? Math.max(0, height - Number(showTitle) - 1) : 0;
    const fullFooter = wrapTextWithAnsi(text.footer(this.hidden), Math.max(1, width));
    const footer = footerBudget ? (fullFooter.length <= footerBudget ? fullFooter
      : wrapTextWithAnsi(text.compactFooter, Math.max(1, width)).slice(-footerBudget)) : [];
    const chrome = Number(showTitle) + footer.length;
    const showGaps = height >= chrome + 3;
    const previousRows = this.rows;
    this.rows = Math.max(1, height - chrome - (showGaps ? 2 : 0));
    // 缩窗时保住原本可见的选择；滚轮已将其滚出视口时，重绘不强行拉回。
    for (const col of this.columns) this.clamp(col, col.sel >= col.top && col.sel < col.top + previousRows);
    const maxCols = Math.max(1, Math.floor((width + COL_GAP) / (COL_WIDTH + COL_GAP)));
    this.colOffset = Math.max(0, Math.min(this.colOffset, this.active));
    if (this.active >= this.colOffset + maxCols) this.colOffset = this.active - maxCols + 1;
    this.mouseLayout = {
      width, colWidth, listTop: Number(showTitle) + Number(showGaps), rows: this.rows,
      columns: this.columns.slice(this.colOffset, this.colOffset + maxCols).map((col) => ({
        col, generation: col.generation, top: col.top, loading: col.loading, contentWidth: this.contentWidth(col, colWidth),
      })),
    };
    const cells = this.mouseLayout.columns.map(({ col, contentWidth }) => {
      const showScrollbar = contentWidth < colWidth;
      const total = col.entries.length + 1;
      const size = Math.min(this.rows, Math.max(2, Math.round(this.rows * this.rows / total)));
      const top = showScrollbar ? Math.round(col.top / (total - this.rows) * (this.rows - size)) : 0;
      return Array.from({ length: this.rows }, (_, row) => {
        const idx = col.top + row, entry = !col.loading ? col.entries[idx - 1] : undefined;
        const label = idx === 0 ? text.self : col.loading ? (idx === 1 ? text.loading : "")
          : entry ? `${displayText(entry.name)}${entry.directory ? "/" : ""}`
          : idx === 1 ? (col.error ? text.directoryError(col.error.code) : text.emptyDirectory) : "";
        const line = truncateToWidth(`${label ? (idx === col.sel ? "▶ " : "  ") : ""}${displayText(label)}`, contentWidth, "…");
        const color = entry && !entry.directory ? "dim" : idx === col.sel ? "accent" : "text";
        const thumb = row >= top && row < top + size;
        return theme.fg(color, line) + " ".repeat(Math.max(0, contentWidth - visibleWidth(line)))
          + (showScrollbar ? theme.fg(thumb ? "scrollbarThumb" : "scrollbarTrack", thumb ? "┃" : "│") : "");
      });
    });
    const lines: string[] = [];
    if (showTitle) lines.push(theme.fg("accent", `${text.title}  ${shortenPath(this.col.dir)}${this.hidden ? text.hidden : ""}`));
    if (showGaps) lines.push("");
    const separator = ` ${theme.fg("border", "│")} `;
    for (let row = 0; row < this.rows; row++) lines.push(cells.map((col) => col[row]!).join(separator).trimEnd());
    if (showGaps) lines.push("");
    const selected = !this.col.loading && this.col.sel > 0 && this.col.sel >= this.col.top && this.col.sel < this.col.top + this.rows
      ? this.col.entries[this.col.sel - 1] : undefined;
    const selectedRow = 1 + Number(showTitle) + Number(showGaps) + this.col.sel - this.col.top;
    const columnRight = 2 + (this.active - this.colOffset) * (COL_WIDTH + COL_GAP) + colWidth;
    this.nameTip.update(selected && visibleWidth(`▶ ${displayText(selected.name)}${selected.directory ? "/" : ""}`) > this.contentWidth(this.col, colWidth) ? {
      key: join(this.col.dir, selected.name), name: selected.name,
      anchor: () => {
        const bounds = this.overlay?.getBounds();
        return bounds && { row: bounds.row + selectedRow, col: bounds.col + columnRight };
      },
    } : undefined);
    lines.push(...footer.map((line) => theme.fg("dim", line)));
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }
}
