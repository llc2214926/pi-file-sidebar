import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { relative } from "node:path";
import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { validateFile } from "./actions.ts";
import { displayText } from "./tree.ts";
import { overlayHeight } from "./frame.ts";

export const MAX_PREVIEW_BYTES = 512 * 1024;
export const MAX_PREVIEW_LINES = 5000;
export interface PreviewData {
  path: string;
  text: string;
  lines: string[];
  bytesRead: number;
  truncated: boolean;
  message?: string;
}

export async function readPreview(root: string, path: string): Promise<PreviewData> {
  const actual = await validateFile(root, path);
  const file = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("目标已不是普通文件");
    const bytes = Buffer.alloc(Math.min(MAX_PREVIEW_BYTES, info.size));
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const read = await file.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!read.bytesRead) break;
      bytesRead += read.bytesRead;
    }
    const source = bytes.subarray(0, bytesRead), truncated = info.size > bytesRead;
    const result: PreviewData = { path: relative(root, path), text: "", lines: [], bytesRead, truncated };
    if (source.includes(0)) return { ...result, message: "二进制文件，不能文本预览。Esc 返回后可用外部编辑器打开。" };
    let text: string;
    try {
      // 达到字节上限时丢弃末尾不完整的 UTF-8 字符，而非制造替换字符。
      text = new TextDecoder("utf-8", { fatal: true }).decode(source, { stream: truncated });
    } catch { return { ...result, message: "文件不是有效 UTF-8 文本。Esc 返回后可用外部编辑器打开。" }; }
    const lines = text ? text.replace(/\r\n/g, "\n").split("\n") : [];
    if (text.endsWith("\n")) lines.pop();
    return { ...result, text, lines: lines.slice(0, MAX_PREVIEW_LINES), truncated: truncated || lines.length > MAX_PREVIEW_LINES };
  } finally { await file.close(); }
}

export class TextPreview implements Component {
  private offset = 0;
  private pageSize = 1;
  private footerY = 0;
  private colored?: string[];
  private cache?: { key: string; lines: string[] };
  constructor(private data: PreviewData, private theme: () => Theme, private tui: TUI, private done: () => void) {}

  render(width: number): string[] {
    // 预览标题、统计、页脚和双线框共占 5 行，始终保留底边及关闭提示。
    this.pageSize = Math.max(1, Math.min(30, overlayHeight(this.tui.terminal.rows)) - 5);
    this.offset = Math.max(0, Math.min(this.offset, this.data.lines.length - this.pageSize));
    const key = `${width}:${this.pageSize}:${this.offset}`;
    if (this.cache?.key === key) return this.cache.lines;
    const theme = this.theme(), digits = String(Math.max(1, this.data.lines.length)).length;
    if (!this.colored) this.colored = highlightCode(this.data.lines.map((line) => displayText(line.replace(/\t/g, "    "))).join("\n"), getLanguageFromPath(this.data.path));
    const body = this.data.message ? wrapTextWithAnsi(this.data.message, width).slice(0, this.pageSize)
      : this.data.lines.length ? this.colored.slice(this.offset, this.offset + this.pageSize).map((line, i) => `${theme.fg("dim", String(this.offset + i + 1).padStart(digits) + " ")} ${line}`)
      : [theme.fg("dim", "（空文件）")];
    const lines = [theme.fg("accent", `只读 · ${displayText(this.data.path)}`),
      `${this.data.bytesRead} 字节 · ${this.data.lines.length} 行${this.data.truncated ? " · 已截断（512 KiB / 5000 行上限）" : ""}`,
      ...body,
      theme.fg("dim", `${this.data.lines.length ? this.offset + 1 : 0}/${this.data.lines.length} · ↑↓ PgUp/PgDn · Esc/点击关闭`),
    ].map((line) => truncateToWidth(line, width));
    this.footerY = lines.length - 1;
    this.cache = { key, lines }; return lines;
  }
  private move(delta: number) {
    const next = Math.max(0, Math.min(Math.max(0, this.data.lines.length - this.pageSize), this.offset + delta));
    if (next === this.offset) return;
    this.offset = next; this.cache = undefined; this.tui.requestRender();
  }
  handleInput(data: string) {
    if (matchesKey(data, "escape")) this.done();
    else if (matchesKey(data, "up")) this.move(-1);
    else if (matchesKey(data, "down")) this.move(1);
    else if (matchesKey(data, "pageUp")) this.move(-this.pageSize);
    else if (matchesKey(data, "pageDown")) this.move(this.pageSize);
    else if (matchesKey(data, "home")) this.move(-Infinity);
    else if (matchesKey(data, "end")) this.move(Infinity);
  }
  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") { this.move(event.wheelDelta ?? 0); return { handled: true }; }
    if (event.type === "click" && event.button === "left" && event.y === this.footerY) { this.done(); return { handled: true }; }
    return undefined;
  }
  invalidate() { this.colored = undefined; this.cache = undefined; }
}
