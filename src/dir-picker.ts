import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, type OverlayHandle, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { getMessages, type Language } from "./i18n.ts";
import { REPEAT_RESET_AFTER, REPEAT_STEP_AFTER } from "./sidebar.ts";
import { displayText } from "./tree.ts";
import { overlayHeight } from "./frame.ts";
import { NameTooltip } from "./name-tooltip.ts";

const COL_WIDTH = 28, COL_GAP = 3;
interface Column {
  dir: string;
  names: string[];
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
    const col: Column = { dir, names: [], sel: 0, top: 0, loading: true, generation: 0 };
    void this.load(col, highlight);
    return col;
  }

  private async load(col: Column, highlight?: string) {
    const generation = ++col.generation, hidden = this.hidden;
    col.loading = true; col.error = undefined; col.highlight = highlight;
    try {
      const entries = await this.reader(col.dir);
      if (this.disposed || generation !== col.generation || !this.columns.includes(col)) return;
      col.names = entries.filter((entry) => entry.isDirectory()
        && (hidden || (!entry.name.startsWith(".") && entry.name !== "node_modules")))
        .map((entry) => entry.name).sort((a, b) => a.localeCompare(b));
      col.sel = col.highlight === undefined ? 0 : Math.max(0, col.names.indexOf(col.highlight) + 1);
    } catch (error) {
      if (this.disposed || generation !== col.generation || !this.columns.includes(col)) return;
      col.names = []; col.sel = 0; col.error = { code: (error as NodeJS.ErrnoException).code };
    }
    col.loading = false; this.clamp(col); this.tui.requestRender();
  }

  private get col() { return this.columns[this.active]!; }
  private rowPath(col: Column) { return col.sel === 0 ? col.dir : join(col.dir, col.names[col.sel - 1]!); }
  private clamp(col: Column) {
    col.sel = Math.min(col.names.length, Math.max(0, col.sel));
    if (col.sel < col.top) col.top = col.sel;
    else if (col.sel >= col.top + this.rows) col.top = col.sel - this.rows + 1;
    col.top = Math.max(0, Math.min(col.top, col.names.length + 1 - this.rows));
  }
  private enter() {
    if (this.col.loading || this.col.sel === 0) return;
    const dir = this.rowPath(this.col);
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
      const picked = this.rowPath(this.col);
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
      else if (matchesKey(data, ".")) {
        this.hidden = !this.hidden;
        for (const col of this.columns) void this.load(col, col.sel > 0 ? col.names[col.sel - 1] : undefined);
      } else return;
    }
    this.tui.requestRender();
  }

  invalidate(): void { /* 主题和语言通过 getter 即时呈现，不重读目录。 */ }
  dispose(): void { this.disposed = true; this.held = undefined; this.nameTip.dispose(); }

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
    this.rows = Math.max(1, height - chrome - (showGaps ? 2 : 0));
    for (const col of this.columns) this.clamp(col);
    const maxCols = Math.max(1, Math.floor((width + COL_GAP) / (COL_WIDTH + COL_GAP)));
    this.colOffset = Math.max(0, Math.min(this.colOffset, this.active));
    if (this.active >= this.colOffset + maxCols) this.colOffset = this.active - maxCols + 1;
    const cells = this.columns.slice(this.colOffset, this.colOffset + maxCols).map((col) =>
      Array.from({ length: this.rows }, (_, row) => {
        const idx = col.top + row;
        const label = idx === 0 ? text.self : col.loading ? (idx === 1 ? text.loading : "")
          : idx <= col.names.length ? `${displayText(col.names[idx - 1]!)}/`
          : idx === 1 ? (col.error ? text.directoryError(col.error.code) : text.emptyDirectory) : "";
        const line = truncateToWidth(`${label ? (idx === col.sel ? "▶ " : "  ") : ""}${displayText(label)}`, colWidth, "…");
        return theme.fg(idx === col.sel ? "accent" : "text", line) + " ".repeat(Math.max(0, colWidth - visibleWidth(line)));
      }));
    const lines: string[] = [];
    if (showTitle) lines.push(theme.fg("accent", `${text.title}  ${shortenPath(this.col.dir)}${this.hidden ? text.hidden : ""}`));
    if (showGaps) lines.push("");
    const separator = ` ${theme.fg("border", "│")} `;
    for (let row = 0; row < this.rows; row++) lines.push(cells.map((col) => col[row]!).join(separator).trimEnd());
    if (showGaps) lines.push("");
    const name = !this.col.loading && this.col.sel > 0 ? this.col.names[this.col.sel - 1] : undefined;
    const selectedRow = 1 + Number(showTitle) + Number(showGaps) + this.col.sel - this.col.top;
    const columnRight = 2 + (this.active - this.colOffset) * (COL_WIDTH + COL_GAP) + colWidth;
    this.nameTip.update(name !== undefined && visibleWidth(`▶ ${displayText(name)}/`) > colWidth ? {
      key: this.rowPath(this.col), name,
      anchor: () => {
        const bounds = this.overlay?.getBounds();
        return bounds && { row: bounds.row + selectedRow, col: bounds.col + columnRight };
      },
    } : undefined);
    lines.push(...footer.map((line) => theme.fg("dim", line)));
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }
}
