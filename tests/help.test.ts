import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type Component, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DoubleBorder, overlayHeight } from "../src/frame.ts";
import { SidebarHelp } from "../src/help.ts";
import { FileSidebar } from "../src/sidebar.ts";
import type { Language } from "../src/i18n.ts";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const tableRows = (lines: string[]) => plain(lines).filter((line) => line.includes(" │ "))
  .map((line) => line.replace(/^║ /, "").replace(/ ║$/, "").split(" │ ").map((cell) => cell.trim()));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(rows = 24, language: Language = "zh") {
  const terminal = { rows, columns: 120 };
  const state = { closed: 0, renders: 0, color: 34, language };
  const theme = { fg: (_color: string, text: string) => `\x1b[${state.color}m${text}\x1b[39m` } as Theme;
  const tui = { terminal, requestRender() { state.renders++; } } as unknown as TUI;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const help = new SidebarHelp(() => theme, tui, keys, () => { state.closed++; }, () => state.language,
    () => { state.language = state.language === "zh" ? "en" : "zh"; });
  const frame = new DoubleBorder(help, (text) => theme.fg("border", text));
  return { terminal, state, theme, tui, keys, help, frame };
}

function progress(frame: DoubleBorder, width = 102): [number, number, number] {
  const match = plain(frame.render(width)).at(-2)!.match(/(\d+)–(\d+)\/(\d+)/);
  assert.ok(match);
  return match.slice(1).map(Number) as [number, number, number];
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, width: number, height: number, wheelDelta?: number): TuiMouseEvent {
  return { type, button: type === "wheel" ? "none" : "left", x, y, screenX: x + 10, screenY: y + 3,
    width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

test("帮助表格包含全部侧栏键位、上下文分组和当前 Pi 菜单键位", () => {
  const f = fixture(120), lines = f.frame.render(160), text = plain(lines).join("\n"), rows = tableRows(lines);
  for (const label of ["树内导航", "文件动作", "键盘调宽", "操作菜单", "只读预览", "本帮助面板", "不发送", "不中断 agent"]) {
    assert.ok(text.includes(label), `缺少帮助项：${label}`);
  }
  for (const [key, action] of [
    ["Ctrl+Shift+E", "进入 / 离开文件树"], ["↑ / ↓", "上下移动选择"], ["Home / End", "选择首项 / 末项"],
    ["→ / ←", "展开目录"], ["Ctrl+U / Ctrl+D", "树内向上"], ["pageUp / pageDown", "主对话翻页"],
    ["r", "手动刷新"], [".", "显示 / 隐藏"], ["w", "进入键盘调宽"], ["h", "打开完整按键帮助"], ["l", "切换侧栏中英文"],
    ["Esc / Ctrl+C", "返回 Pi 输入框"], ["Enter", "目录展开"], ["Space", "打开操作菜单"], ["y", "复制相对路径"],
    ["a", "插入文件路径引用"], ["e", "Pi 空闲"], ["适用范围", "预览、引用和外部编辑仅支持普通文件"],
    ["← / →", "缩窄 / 加宽 1 列"], ["Shift+← / Shift+→", "缩窄 / 加宽 4 列"],
    ["Enter", "确认宽度"], ["Esc", "恢复原宽度"], ["Ctrl+C / Ctrl+Shift+E", "取消调宽"],
    ["up / down", "上下选择操作"], ["enter", "执行选中操作"], ["escape / ctrl+c", "关闭菜单"],
    ["↑ / ↓", "上下滚动一行"], ["PageUp / PageDown", "向上 / 向下翻页"], ["Home / End", "跳到开头 / 结尾"],
    ["Esc", "关闭预览"], ["Ctrl+U / Ctrl+D", "滚动半页"], ["滚轮", "滚动帮助"], ["h / Esc / Ctrl+C", "关闭帮助"],
  ]) assert.ok(rows.some(([left, right]) => left === key && right.startsWith(action)), `缺少表格行：${key} | ${action}`);
  f.keys.setUserBindings({ "tui.select.up": ["ctrl+k", "k"], "tui.select.cancel": [], "tui.altScreen.pageUp": "alt+u" });
  f.frame.invalidate();
  const custom = tableRows(f.frame.render(160));
  assert.ok(custom.some(([key, action]) => key === "ctrl+k / k / down" && action === "上下选择操作"));
  assert.ok(custom.some(([key, action]) => key === "未绑定" && action.startsWith("关闭菜单")));
  assert.ok(custom.some(([key, action]) => key === "alt+u / pageDown" && action.startsWith("主对话翻页")));
});

test("表格占满可用宽度、跨组列对齐，长键名和中文缩放换行不丢内容", () => {
  const f = fixture(1000);
  f.keys.setUserBindings({ "tui.select.up": ["ctrl+shift+alt+k", "ctrl+shift+alt+j", "ctrl+shift+alt+l", "|"] });
  const columns = (lines: string[]) => {
    const rows = tableRows(lines).slice(1);
    assert.ok(rows.every((row) => row.length === 2));
    return [0, 1].map((index) => rows.map((row) => row[index]).join("").replace(/\s+/g, ""));
  };
  const full = f.help.render(240), expected = columns(full);
  let previousDivider = 0;
  for (const width of [24, 32, 48, 73, 102, 160, 240]) {
    const lines = f.help.render(width), text = plain(lines);
    const header = text[1], divider = visibleWidth(header.slice(0, header.indexOf("│")));
    assert.ok(divider >= previousDivider, "可用宽度增加时，按键列不应变窄");
    previousDivider = divider;
    assert.deepEqual(tableRows(lines)[0], ["按键", "功能"]);
    for (const line of text.filter((line) => line.includes(" │ "))) {
      assert.equal(visibleWidth(line), width, "表格行应占满可用宽度");
      assert.equal(visibleWidth(line.slice(0, line.indexOf("│"))), divider, "分组之间列线应对齐");
    }
    assert.deepEqual(columns(lines), expected, "窄列换行不能截掉按键或功能说明");
    assert.ok(lines.length >= full.length, "窄表格应通过增加行数保留完整内容");
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  assert.ok(f.help.render(32).length > full.length, "缩窗应重新换行而非继续使用宽窗布局");
});

test("英文帮助覆盖全部分组，长说明和自定义键位在 24–240 列不丢字", () => {
  const f = fixture(1000, "en");
  f.keys.setUserBindings({ "tui.select.up": ["ctrl+shift+alt+k", "ctrl+shift+alt+j", "|"], "tui.select.cancel": [] });
  const full = f.help.render(240), text = plain(full).join("\n");
  for (const label of ["Tree navigation", "File actions", "Keyboard resizing", "Action menu", "Read-only preview", "This help panel", "Unbound", "/file-sidebar lang zh|en"]) {
    assert.ok(text.includes(label), label);
  }
  assert.ok(!/\p{Script=Han}/u.test(text));
  assert.equal(tableRows(full).filter(([key]) => key === "l").length, 2);
  const columns = (lines: string[]) => [0, 1].map((index) => tableRows(lines).slice(1).map((row) => row[index]).join("").replace(/\s+/g, ""));
  const expected = columns(full);
  for (const width of [24, 32, 48, 73, 102, 160, 240]) {
    const lines = f.help.render(width), rows = plain(lines).filter((line) => line.includes(" │ "));
    assert.deepEqual(tableRows(lines)[0], ["Key", "Action"]);
    assert.deepEqual(columns(lines), expected);
    const divider = visibleWidth(rows[0].split("│")[0]);
    for (const line of rows) {
      assert.equal(visibleWidth(line), width);
      assert.equal(visibleWidth(line.split("│")[0]), divider);
    }
  }
  for (const width of [13, 14, 16, 18]) assert.deepEqual(tableRows(f.help.render(width))[0], ["Key", "Action"]);
});

test("帮助内 l 切换不关闭或丢失滚动状态，中英文短窗均保留固定表头和关闭提示", () => {
  const f = fixture(12);
  f.frame.render(160); f.frame.handleInput("\x1b[F");
  const before = progress(f.frame, 160);
  f.frame.handleInput("l");
  assert.equal(f.state.language, "en");
  assert.equal(f.state.closed, 0);
  const after = progress(f.frame, 160);
  assert.ok(after[0] > 1 && after[0] <= after[1] && after[1] <= after[2]);
  assert.equal(after[0], Math.min(before[0], after[2] - (after[1] - after[0])));
  assert.deepEqual(tableRows(f.frame.render(160))[0], ["Key", "Action"]);
  const colorsBefore = f.frame.render(160);
  f.state.color = 35; f.frame.invalidate();
  assert.deepEqual(plain(f.frame.render(160)), plain(colorsBefore));
  assert.notDeepEqual(f.frame.render(160), colorsBefore);
  for (const language of ["en", "zh"] as const) {
    if (f.state.language !== language) f.frame.handleInput("\x1b[108u");
    f.terminal.rows = 8;
    for (const width of [24, 32, 73, 102, 160]) {
      const lines = f.frame.render(width), text = plain(lines);
      assert.ok(lines.length <= overlayHeight(8));
      assert.deepEqual(tableRows(lines)[0], language === "en" ? ["Key", "Action"] : ["按键", "功能"]);
      assert.ok(text.at(-2)?.includes(language === "en" ? "h/Esc Close" : "h/Esc 返回"));
      assert.ok(lines.every((line) => visibleWidth(line) === width));
    }
  }
  assert.equal(f.state.closed, 0);
  assert.ok(f.state.renders > 0);
  f.frame.handleInput("h");
  assert.equal(f.state.closed, 1);
});

test("滚动时表头固定，窗口缩放后重排列宽且滚动范围合法", () => {
  const f = fixture(8), width = 73, header = plain(f.frame.render(width)).slice(2, 4);
  for (const key of ["\x1b[6~", "\x1b[F", "\x1b[A", "\x1b[H"]) {
    f.frame.handleInput(key);
    assert.deepEqual(plain(f.frame.render(width)).slice(2, 4), header);
  }
  f.terminal.rows = 24;
  f.frame.render(width);
  f.frame.handleInput("\x1b[F");
  const narrow = progress(f.frame, width), wide = progress(f.frame, 160);
  assert.equal(narrow[1], narrow[2]);
  assert.equal(wide[1], wide[2]);
  assert.ok(wide[2] < narrow[2], "扩窗后多行单元格应合并，内容总行数减少");
  assert.deepEqual(tableRows(f.frame.render(160))[0], ["按键", "功能"]);
  f.terminal.rows = 8;
  const small = f.frame.render(width);
  assert.ok(small.length <= overlayHeight(8));
  assert.deepEqual(tableRows(small)[0], ["按键", "功能"]);
  assert.ok(plain(small).at(-2)?.includes("h/Esc 返回"));
});

test("短窗口、窄列和中文换行始终保留表头、双线框及关闭提示", () => {
  const f = fixture();
  for (const rows of [8, 9, 12, 24, 50, 120, 8]) {
    f.terminal.rows = rows;
    for (const width of [24, 32, 73, 102, 160]) {
      const lines = f.frame.render(width), text = plain(lines);
      assert.ok(lines.length <= overlayHeight(rows));
      assert.equal(text[0], `╔${"═".repeat(width - 2)}╗`);
      assert.equal(text.at(-1), `╚${"═".repeat(width - 2)}╝`);
      assert.deepEqual(tableRows(lines)[0], ["按键", "功能"]);
      assert.ok(text.at(-2)?.includes("h/Esc 返回"));
      for (const line of lines) assert.equal(visibleWidth(line), width);
    }
  }
});

test("方向键、半页、整页及首尾导航可滚动全部说明，缩放后偏移合法", () => {
  const f = fixture(), initial = progress(f.frame), page = initial[1];
  f.frame.handleInput("\x1b[B");
  assert.equal(progress(f.frame)[0], 2);
  f.frame.handleInput("\x1b[A");
  assert.equal(progress(f.frame)[0], 1);
  f.frame.handleInput("\x1b[6~");
  assert.equal(progress(f.frame)[0], page + 1);
  f.frame.handleInput("\x1b[5~");
  assert.equal(progress(f.frame)[0], 1);
  f.frame.handleInput("\x04");
  assert.equal(progress(f.frame)[0], Math.floor(page / 2) + 1);
  f.frame.handleInput("\x15");
  assert.equal(progress(f.frame)[0], 1);
  f.frame.handleInput("\x1b[F");
  const end = progress(f.frame);
  assert.equal(end[1], end[2]);
  assert.equal(end[0], end[2] - page + 1);
  assert.ok(plain(f.frame.render(102)).some((line) => line.includes("h / Esc / Ctrl+C")));
  f.frame.handleInput("\x1b[B");
  assert.deepEqual(progress(f.frame), end);
  f.frame.handleInput("\x1b[H");
  assert.deepEqual(progress(f.frame), initial);
  f.frame.handleInput("\x1b[F");
  f.terminal.rows = 120;
  assert.equal(progress(f.frame)[0], 1);
  assert.ok(f.state.renders > 0);
});

test("滚轮及边界事件不泄漏，点击页脚关闭但点击框线不关闭", () => {
  const f = fixture(), width = 102, height = f.frame.render(width).length;
  const wheel = (delta: number) => f.frame.handleMouse(mouse("wheel", 2, 2, width, height, delta));
  assert.equal(wheel(-1)?.handled, true);
  assert.equal(progress(f.frame)[0], 1);
  assert.equal(wheel(3)?.handled, true);
  assert.equal(progress(f.frame)[0], 4);
  f.frame.handleInput("\x1b[F");
  const end = progress(f.frame);
  const boundary = wheel(1);
  assert.equal(boundary?.handled, true);
  assert.ok(!boundary || !("focus" in boundary) || !boundary.focus);
  assert.deepEqual(progress(f.frame), end);
  assert.equal(f.frame.handleMouse(mouse("wheel", 0, 0, width, height, -1))?.handled, true);
  assert.deepEqual(progress(f.frame), end);
  f.frame.handleMouse(mouse("click", 2, height - 1, width, height));
  assert.equal(f.state.closed, 0);
  f.frame.handleMouse(mouse("click", 2, height - 2, width, height));
  assert.equal(f.state.closed, 1);
});

test("h、Esc、Ctrl+C 和扩展键协议 h 关闭帮助，普通动作键不执行", () => {
  for (const close of ["h", "\x1b", "\x03", "\x1b[104u"]) {
    const f = fixture();
    f.frame.render(102);
    for (const key of ["w", "a", "e", "y", "r", ".", " ", "\r", "H"]) f.frame.handleInput(key);
    assert.equal(f.state.closed, 0);
    f.frame.handleInput(close);
    assert.equal(f.state.closed, 1);
  }
});

test("主题失效重绘不保留旧颜色或改变帮助内容", () => {
  const f = fixture(), before = f.frame.render(102);
  f.state.color = 35;
  f.frame.invalidate();
  const after = f.frame.render(102);
  assert.notDeepEqual(after, before);
  assert.deepEqual(plain(after), plain(before));
});

test("正式侧栏 h 接线、底部提示、w 保留及 off/dispose 取消（模拟宿主）", async (t) => {
  const f = fixture();
  let opened = 0, closed = 0, resized = 0, modal: Component | undefined;
  const host = {
    visible: true, alive: true, canInteract: true, focused: true, resizing: false, width: 32, maxWidth: 48,
    inspect() {}, redraw() {},
    beginResize() { resized++; this.resizing = true; },
    finishResize() { this.resizing = false; },
    leave() { this.focused = false; },
    setEnabled(enabled: boolean) { this.visible = enabled; runtime.hostChanged(); },
    dispose() { this.alive = false; this.focused = false; },
  };
  const ctx = {
    cwd: "/virtual-sidebar-help",
    ui: {
      theme: f.theme,
      setWidget() {}, onTerminalInput() { return () => {}; },
      notify(message: string) { assert.fail(message); },
      setEditorText() { assert.fail("帮助不能重写草稿"); },
      pasteToEditor() { assert.fail("帮助不能插入草稿"); },
      custom(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: () => void) => Component, options: unknown) {
        assert.deepEqual(options, { overlay: true, overlayOptions: { width: "85%", maxHeight: "90%" } });
        opened++;
        return new Promise<void>((resolve) => {
          modal = factory(f.tui, f.theme, f.keys, () => {
            closed++; modal = undefined;
            host.focused = host.visible; host.canInteract = host.visible;
            resolve();
          });
          host.focused = false; host.canInteract = false;
        });
      },
    },
  } as unknown as ExtensionContext;
  const sidebar = new FileSidebar(ctx), originalHost = sidebar.host;
  // 只替换宿主边界，不启动 renderer、不读取目录；构造器、输入路由和动作生命周期使用正式实现。
  Object.assign(sidebar, { host });
  const runtime = sidebar as unknown as { input(data: string): void; hostChanged(): void; panel: Component; acting: boolean };
  t.after(async () => { await sidebar.dispose(); originalHost.dispose(); });
  assert.ok(plain(runtime.panel.render(32)).at(-1)?.includes("h 帮助"));
  const selected = sidebar.tree.selected;

  host.focused = false;
  runtime.input("h");
  assert.equal(opened, 0);
  host.focused = true; host.resizing = true;
  runtime.input("h");
  assert.equal(opened, 0);
  host.resizing = false;
  runtime.input("\x1b[104u");
  assert.equal(opened, 1);
  assert.ok(modal instanceof DoubleBorder);
  assert.ok(plain(modal.render(102)).some((line) => line.includes("按键帮助")));
  runtime.input("h");
  assert.equal(opened, 1, "阻塞模态期间不得再打开帮助");
  modal.handleInput("h");
  await tick();
  assert.equal(runtime.acting, false);
  assert.equal(host.focused, true);
  assert.equal(sidebar.tree.selected, selected);
  assert.equal(sidebar.tree.node()?.state, "unloaded");

  runtime.input("w");
  assert.equal(resized, 1);
  assert.equal(host.resizing, true);
  runtime.input("\x1b");
  assert.equal(host.resizing, false);
  runtime.input("h");
  sidebar.command("off");
  await tick();
  assert.equal(modal, undefined);
  assert.equal(closed, 2);
  assert.equal(runtime.acting, false);
  assert.equal(host.focused, false);

  host.visible = true; host.canInteract = true; host.focused = true;
  runtime.input("h");
  await sidebar.dispose();
  await tick();
  assert.equal(modal, undefined);
  assert.equal(closed, 3);
  assert.equal(host.alive, false);
});
