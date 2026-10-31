import { Box, sliceByColumn, truncateToWidth, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";

export function overlayHeight(rows: number): number {
  return Math.max(1, Math.floor(rows * 0.9));
}

// 复用原生 Box 的留白与鼠标坐标转换，只将外圈留白换成双线边框。
export class DoubleBorder implements Component {
  private box: Box;
  constructor(private content: Component, private border: (text: string) => string) {
    this.box = new Box(2, 1);
    this.box.addChild(content);
  }

  handleInput(data: string) { this.content.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent) {
    // 框线与留白上的滚轮也要消费，避免滚动到弹窗背后的主对话。
    return this.box.handleMouse(event) ?? (event.type === "wheel" ? { handled: true, render: false } : undefined);
  }
  invalidate() { this.box.invalidate(); }

  render(width: number): string[] {
    const lines = this.box.render(width);
    if (!lines.length || width < 5) return lines.map((line) => truncateToWidth(line, width, ""));
    const innerWidth = width - 2, side = this.border("║");
    return [
      this.border(`╔${"═".repeat(innerWidth)}╗`),
      ...lines.slice(1, -1).map((line) => `${side}${sliceByColumn(line, 1, innerWidth, true)}${side}`),
      this.border(`╚${"═".repeat(innerWidth)}╝`),
    ];
  }
}
