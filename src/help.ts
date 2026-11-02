import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component, type Keybinding, type KeybindingsManager, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { overlayHeight } from "./frame.ts";
import { displayText } from "./tree.ts";
import { getMessages, type Language } from "./i18n.ts";

interface HelpSection {
  title: string;
  rows: [key: string, action: string][];
}

export class SidebarHelp implements Component {
  private scroll: ScrollView;
  private footerY = 0;

  constructor(private theme: () => Theme, private tui: TUI, private keys: KeybindingsManager, private done: () => void,
    private language: () => Language = () => "zh", private toggleLanguage?: () => void) {
    this.scroll = new ScrollView({ render: (width) => this.content(width), invalidate() {} }, { follow: "none", overscroll: "contain", scrollbar: "hidden" });
  }

  private sections(): HelpSection[] {
    const text = getMessages(this.language()).help;
    const binding = (id: Keybinding) => displayText(this.keys.getKeys(id).join(" / ") || text.unbound);
    return [
      { title: text.tree, rows: [
        ["Ctrl+Shift+E", text.activate],
        ["↑ / ↓", text.select],
        ["Home / End", text.firstLast],
        ["→ / ←", text.expandCollapse],
        ["Ctrl+U / Ctrl+D", text.halfPage],
        [`${binding("tui.altScreen.pageUp")} / ${binding("tui.altScreen.pageDown")}`, text.conversationPage],
        ["r", text.refresh],
        [".", text.hidden],
        ["w", text.resize],
        ["h", text.open],
        ["l", text.language],
        ["Esc / Ctrl+C", text.leave],
      ] },
      { title: text.files, rows: [
        ["Enter", text.enter],
        ["Space", text.menu],
        ["y", text.copy],
        ["a", text.reference],
        ["e", text.external],
        [text.scope, text.fileScope],
      ] },
      { title: text.resizing, rows: [
        ["← / →", text.oneColumn],
        ["Shift+← / Shift+→", text.fourColumns],
        ["Enter", text.confirmWidth],
        ["Esc", text.cancelWidth],
        ["Ctrl+C / Ctrl+Shift+E", text.leaveResize],
      ] },
      { title: text.menuKeys, rows: [
        [`${binding("tui.select.up")} / ${binding("tui.select.down")}`, text.selectAction],
        [binding("tui.select.confirm"), text.runAction],
        [binding("tui.select.cancel"), text.closeMenu],
      ] },
      { title: text.preview, rows: [
        ["↑ / ↓", text.scrollLine],
        ["PageUp / PageDown", text.scrollPage],
        ["Home / End", text.startEnd],
        ["Esc", text.closePreview],
      ] },
      { title: text.help, rows: [
        ["↑ / ↓", text.scrollLine],
        ["Ctrl+U / Ctrl+D", text.scrollHalfPage],
        ["PageUp / PageDown", text.scrollPage],
        ["Home / End", text.startEnd],
        [text.wheel, text.scrollHelp],
        ["l", text.language],
        ["h / Esc / Ctrl+C", text.closeHelp],
      ] },
    ];
  }

  private content(width: number): string[] {
    const sections = this.sections(), theme = this.theme(), text = getMessages(this.language()).help;
    const minimumKeyWidth = Math.max(4, visibleWidth(text.key)), minimumActionWidth = visibleWidth(text.action);
    // 极窄宽度放不下两列表头时退为上下排布；正常可见侧栏不走此分支。
    if (width < minimumKeyWidth + 3 + minimumActionWidth) return [
      truncateToWidth(`${text.key} / ${text.action}`, width), theme.fg("border", "─".repeat(Math.max(0, width))),
      ...sections.flatMap((section) => [section.title, ...section.rows.map(([key, action]) => `${key}: ${action}`)])
        .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width))),
    ];
    const available = width - 3; // 两列之间的 " │ " 占 3 列。
    const naturalKeyWidth = Math.max(minimumKeyWidth, ...sections.flatMap((section) => section.rows.map(([key]) => visibleWidth(key))));
    const keyWidth = Math.min(naturalKeyWidth, Math.max(minimumKeyWidth, Math.floor(available * 0.4)), available - minimumActionWidth);
    const actionWidth = available - keyWidth;
    const row = (key: string, action: string, header = false): string[] => {
      const left = wrapTextWithAnsi(key, keyWidth), right = wrapTextWithAnsi(action, actionWidth);
      return Array.from({ length: Math.max(left.length, right.length) }, (_, i) =>
        theme.fg("accent", truncateToWidth(left[i] ?? "", keyWidth, "", true)) + theme.fg("border", " │ ")
        + theme.fg(header ? "accent" : "text", truncateToWidth(right[i] ?? "", actionWidth, "", true)));
    };
    const separator = theme.fg("border", `${"─".repeat(keyWidth)}─┼─${"─".repeat(actionWidth)}`);
    const lines = [...row(text.key, text.action, true), separator];
    for (const [index, section] of sections.entries()) {
      if (index) lines.push(separator);
      lines.push(...wrapTextWithAnsi(theme.fg("accent", section.title), width));
      for (const [key, action] of section.rows) lines.push(...row(key, action));
    }
    return lines;
  }

  render(width: number): string[] {
    // 表头固定，仅滚动分组与操作行；每次 render 都按当前窗口可用宽度重新分列、换行。
    const [header = "", separator = "", ...content] = this.scroll.render(width);
    // 标题、表头、分隔线、页脚和双线框共占 6 行，短窗口也保留关闭提示。
    const height = Math.max(1, overlayHeight(this.tui.terminal.rows) - 6);
    this.scroll.updateLayout(content.length, height, () => this.tui.requestRender());
    const start = this.scroll.scrollTop, end = Math.min(content.length, start + height);
    const text = getMessages(this.language()).help;
    const lines = [
      this.theme().fg("accent", text.title),
      header, separator,
      ...content.slice(start, end),
      this.theme().fg("dim", `${text.footer} · ${start + 1}–${end}/${content.length}`),
    ].map((line) => truncateToWidth(line, width));
    this.footerY = lines.length - 1;
    return lines;
  }

  handleInput(data: string) {
    if (matchesKey(data, "h") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.done();
    else if (matchesKey(data, "l") && this.toggleLanguage) { this.toggleLanguage(); this.invalidate(); this.tui.requestRender(); }
    else if (matchesKey(data, "up")) this.scroll.scrollBy(-1);
    else if (matchesKey(data, "down")) this.scroll.scrollBy(1);
    else if (matchesKey(data, "pageUp")) this.scroll.scrollBy(-this.scroll.viewportHeight);
    else if (matchesKey(data, "pageDown")) this.scroll.scrollBy(this.scroll.viewportHeight);
    else if (matchesKey(data, "ctrl+u")) this.scroll.scrollBy(-Math.max(1, Math.floor(this.scroll.viewportHeight / 2)));
    else if (matchesKey(data, "ctrl+d")) this.scroll.scrollBy(Math.max(1, Math.floor(this.scroll.viewportHeight / 2)));
    else if (matchesKey(data, "home")) this.scroll.scrollToStart();
    else if (matchesKey(data, "end")) this.scroll.scrollToEnd();
  }

  handleMouse(event: TuiMouseEvent) {
    if (event.type === "wheel") {
      const before = this.scroll.scrollTop;
      this.scroll.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: this.scroll.scrollTop !== before };
    }
    if (event.type === "click" && event.button === "left" && event.y === this.footerY) { this.done(); return { handled: true }; }
    return undefined;
  }
  invalidate() { this.scroll.invalidate(); }
}
