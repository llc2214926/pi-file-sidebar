import assert from "node:assert/strict";
import type { Dirent } from "node:fs";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { initTheme, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, stripTerminalSequences, visibleWidth, type Component, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import { copyPath, formatReference, parseEditorCommand, validateFile } from "../src/actions.ts";
import { DoubleBorder } from "../src/frame.ts";
import type { HostReason } from "../src/host.ts";
import { describeError, getMessages, SidebarError, type Language } from "../src/i18n.ts";
import { MAX_PREVIEW_LINES, readPreview, TextPreview, type PreviewData } from "../src/preview.ts";
import { FileSidebar } from "../src/sidebar.ts";

initTheme("dark", false);
const plain = (lines: string[]) => lines.map(stripTerminalSequences);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function entry(name: string, kind = "file"): Dirent {
  return { name, isDirectory: () => kind === "directory", isFile: () => kind === "file", isSymbolicLink: () => kind === "symlink" } as Dirent;
}

interface Runtime {
  input(data: string): void;
  hostChanged(): void;
  runAction(work: (id: number) => Promise<void>): Promise<void>;
  rows: Component;
  panel: Component;
  scroll: ScrollView;
  languageSave: Promise<void>;
}

function fixture(t: TestContext, options: {
  language?: Language;
  save?: (language: Language) => Promise<void>;
  read?: (path: string) => Promise<Dirent[]>;
} = {}) {
  const state = {
    modal: undefined as Component | undefined, opened: 0, closed: 0, renders: 0, idle: true, starts: 0, stops: 0,
    notifications: [] as { message: string; level: string }[], writes: [] as Language[], saved: [] as Language[],
  };
  const terminal = { rows: 24, columns: 120 };
  const theme = { fg: (_color: string, text: string) => text } as Theme;
  const keys = new KeybindingsManager(TUI_KEYBINDINGS);
  const tui = { terminal, requestRender() { state.renders++; }, start() { state.starts++; }, stop() { state.stops++; } } as unknown as TUI;
  let runtime: Runtime;
  const host = {
    visible: true, alive: true, canInteract: true, focused: true, resizing: false, width: 32, maxWidth: 48,
    reason: "mounted" as HostReason, tui,
    inspect() {}, redraw() { state.renders++; runtime?.panel.invalidate(); },
    beginResize() { this.resizing = true; }, finishResize() { this.resizing = false; },
    leave() { this.focused = false; },
    setEnabled(enabled: boolean) {
      this.visible = enabled; this.canInteract = enabled; this.reason = enabled ? "mounted" : "closed";
      if (!enabled) this.focused = false;
      runtime.hostChanged();
    },
    dispose() { this.alive = false; this.focused = false; this.canInteract = false; },
  };
  const ctx = {
    cwd: "/virtual-sidebar-i18n", isIdle: () => state.idle, isProjectTrusted: () => false,
    ui: {
      theme, setWidget() {}, onTerminalInput() { return () => {}; },
      getEditorText: () => "unchanged draft",
      setEditorText() { assert.fail("切换语言不得重写草稿"); },
      pasteToEditor() { assert.fail("切换语言不得插入草稿"); },
      notify(message: string, level: string) { state.notifications.push({ message, level }); },
      custom<T>(factory: (tui: TUI, theme: Theme, keys: KeybindingsManager, done: (value: T) => void) => Component) {
        state.opened++;
        return new Promise<T>((resolve) => {
          let closed = false;
          state.modal = factory(tui, theme, keys, (value) => {
            if (closed) return;
            closed = true; state.closed++; state.modal = undefined;
            host.focused = host.visible && host.alive; host.canInteract = host.visible && host.alive;
            resolve(value);
          });
          host.focused = false; host.canInteract = false;
        });
      },
    },
  } as unknown as ExtensionContext;
  const sidebar = new FileSidebar(ctx, options.language ?? "zh", async (language) => {
    state.writes.push(language);
    await options.save?.(language);
    state.saved.push(language);
  });
  const originalHost = sidebar.host;
  runtime = sidebar as unknown as Runtime;
  // 仅替换宿主和目录 I/O 边界；正式树、组件、键路由、缓存与生命周期保持不变。
  Object.assign(sidebar, { host });
  Object.assign(sidebar.tree, { read: options.read ?? (async () => []) });
  t.after(async () => { await sidebar.dispose(); originalHost.dispose(); });
  return { sidebar, runtime, host, state, terminal, tui, theme };
}

test("树内 l 和扩展键协议切换语言，只重绘 UI，保留对象、选择、滚动和宽度", async (t) => {
  const f = fixture(t), tree = f.sidebar.tree, scroll = f.runtime.scroll, rows = f.runtime.rows, panel = f.runtime.panel;
  const selected = tree.selected, expanded = [...tree.expanded], revision = tree.revision;
  scroll.updateLayout(100, 8, () => f.host.redraw()); scroll.scrollTo(12);
  assert.ok(plain(panel.render(32))[0].includes("文件 · l:EN"));
  for (const width of [24, 32, 48]) assert.ok(plain(panel.render(width)).at(-1)?.includes("h 帮助"));

  f.host.focused = false; f.runtime.input("l");
  f.host.focused = true; f.host.resizing = true; f.runtime.input("l");
  f.host.resizing = false; f.runtime.input("L");
  assert.equal(f.sidebar.currentLanguage, "zh");
  assert.equal(f.state.writes.length, 0);
  f.runtime.input("l");
  assert.equal(f.sidebar.currentLanguage, "en", "语言切换不必等待磁盘写入");
  await f.runtime.languageSave;
  for (const width of [24, 32, 48]) {
    const lines = plain(panel.render(width));
    assert.ok(lines[0].includes("Files · l:ZH"));
    assert.ok(lines.at(-1)?.includes("h Help"));
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
  f.runtime.input("\x1b[108u");
  await f.runtime.languageSave;
  assert.equal(f.sidebar.currentLanguage, "zh");
  assert.deepEqual(f.state.saved, ["en", "zh"]);
  assert.equal(f.sidebar.tree, tree); assert.equal(f.runtime.scroll, scroll);
  assert.equal(f.runtime.rows, rows); assert.equal(f.runtime.panel, panel);
  assert.equal(tree.selected, selected); assert.deepEqual([...tree.expanded], expanded);
  assert.equal(tree.revision, revision); assert.equal(tree.reads, 0); assert.equal(scroll.scrollTop, 12);
  assert.equal(f.host.width, 32); assert.equal(f.host.focused, true); assert.equal(f.state.opened, 0);
});

test("命令校验参数，状态与调宽提示随语言变化；隐藏时切换不重新显示或夺焦点", async (t) => {
  const f = fixture(t);
  for (const args of ["lang fr", "lang EN", "lang en extra", "lang zh en"]) await f.sidebar.command(args);
  assert.equal(f.state.writes.length, 0);
  assert.equal(f.sidebar.currentLanguage, "zh");
  assert.ok(f.state.notifications.every((item) => item.level === "warning" && item.message.includes("用法")));
  await f.sidebar.command("lang en");
  await f.sidebar.command("status");
  assert.ok(f.state.notifications.at(-1)?.message.includes("Mounted; width 32; focus file tree"));
  assert.ok(f.state.notifications.at(-1)?.message.includes("English (en)"));
  f.host.resizing = true;
  assert.ok(plain(f.runtime.panel.render(32)).at(-2)?.includes("Width: 32"));
  f.host.resizing = false;
  await f.sidebar.command("off");
  const reads = f.sidebar.tree.reads;
  await f.sidebar.command("lang zh");
  assert.equal(f.host.visible, false); assert.equal(f.host.focused, false);
  assert.equal(f.sidebar.tree.reads, reads);
  await f.sidebar.command("status");
  assert.ok(f.state.notifications.at(-1)?.message.includes("用户已关闭"));
  assert.ok(f.state.notifications.at(-1)?.message.includes("语言 中文（zh）"));
  await f.sidebar.dispose();
  await f.sidebar.command("lang en");
  assert.equal(f.sidebar.currentLanguage, "zh");
});

test("加载中、已缓存目录错误和异步动作错误按当前语言呈现，不重读目录", async (t) => {
  const read = deferred<Dirent[]>(), action = deferred<void>();
  const f = fixture(t, { read: () => read.promise });
  f.sidebar.tree.setActive(true);
  assert.ok(plain(f.runtime.rows.render(160)).join("\n").includes("加载中"));
  await f.sidebar.command("lang en");
  assert.ok(plain(f.runtime.rows.render(160)).join("\n").includes("(loading)"));
  read.reject(Object.assign(new Error("不应直接显示的底层错误"), { code: "EACCES" }));
  await tick();
  f.sidebar.tree.setActive(false);
  assert.deepEqual(f.sidebar.tree.node()?.error, { code: "EACCES" });
  assert.ok(plain(f.runtime.rows.render(160)).join("\n").includes("Permission denied"));
  const reads = f.sidebar.tree.reads;
  await f.sidebar.command("lang zh");
  assert.ok(plain(f.runtime.rows.render(160)).join("\n").includes("没有读取权限"));
  assert.equal(f.sidebar.tree.reads, reads);

  const pending = f.runtime.runAction(async () => { await action.promise; throw new SidebarError("fileOnly"); });
  await f.sidebar.command("lang en");
  action.resolve();
  await pending;
  assert.equal(f.state.notifications.at(-1)?.message, "This action only supports regular files");
  f.state.idle = false;
  f.runtime.input("e");
  await tick();
  assert.ok(f.state.notifications.at(-1)?.message.startsWith("Pi is working"));
  assert.equal(f.state.starts, 0); assert.equal(f.state.stops, 0);
});

test("帮助内 l 即时切换且保持模态；关闭、off 和销毁后旧帮助不能再保存", async (t) => {
  const f = fixture(t), selected = f.sidebar.tree.selected;
  f.runtime.input("h");
  const modal = f.state.modal;
  assert.ok(modal instanceof DoubleBorder);
  const text = () => plain(modal.render(102)).join("\n");
  assert.ok(text().includes("按键帮助"));
  f.runtime.input("l");
  assert.equal(f.sidebar.currentLanguage, "zh", "被模态阻塞的树不能切换语言");
  modal.handleInput("l");
  await f.runtime.languageSave;
  assert.ok(text().includes("File tree · Key help"));
  assert.equal(f.state.modal, modal); assert.equal(f.host.focused, false);
  modal.handleInput("\x1b[108u");
  await f.runtime.languageSave;
  assert.ok(text().includes("按键帮助"));
  assert.equal(f.sidebar.tree.selected, selected); assert.equal(f.sidebar.tree.reads, 0);
  await f.sidebar.command("off");
  await tick();
  const writes = f.state.writes.length;
  modal.handleInput("l");
  await f.sidebar.dispose();
  modal.handleInput("l");
  await tick();
  assert.equal(f.state.writes.length, writes); assert.equal(f.state.modal, undefined);
});

test("操作菜单即时翻译并保留选中动作；文件名和预览以外的动作边界不变", async (t) => {
  const f = fixture(t, { read: async () => [entry("文稿\u202e.ts")] });
  f.sidebar.tree.setActive(true); await tick(); f.sidebar.tree.setActive(false);
  const path = join(f.sidebar.tree.root, "文稿\u202e.ts");
  f.sidebar.tree.select(path);
  f.runtime.input(" ");
  const modal = f.state.modal;
  assert.ok(modal instanceof DoubleBorder);
  assert.ok(plain(modal.render(120)).some((line) => line.includes("只读文本预览")));
  modal.handleInput("\x1b[B");
  const reads = f.sidebar.tree.reads;
  await f.sidebar.command("lang en");
  const text = plain(modal.render(120)).join("\n");
  for (const label of ["Read-only text preview", "Copy relative path", "Copy absolute path", "Insert @reference (do not send)", "Open in external editor", "Cancel"]) {
    assert.ok(text.includes(label), label);
  }
  assert.ok(text.includes("→ Copy relative path"));
  assert.ok(text.includes("文稿\\u{202e}.ts"));
  assert.ok(!text.includes("\u202e"));
  assert.equal(f.sidebar.tree.selected, path); assert.equal(f.sidebar.tree.reads, reads);
  const writes = f.state.writes.length;
  modal.handleInput("l"); await tick();
  assert.equal(f.state.writes.length, writes, "菜单不接管未定义的 l 键");
  modal.handleInput("\x1b"); await tick();
  assert.equal(f.host.focused, true); assert.equal(f.state.closed, 1);
});

test("语言写入按选择顺序串行，dispose 等待全部写入且禁止旧完成通知", async (t) => {
  const first = deferred<void>(), second = deferred<void>();
  let attempts = 0;
  const f = fixture(t, { save: () => (++attempts === 1 ? first.promise : second.promise) });
  try {
    const en = f.sidebar.command("lang en"), zh = f.sidebar.command("lang zh");
    await tick();
    assert.deepEqual(f.state.writes, ["en"]);
    assert.equal(f.sidebar.currentLanguage, "zh");
    let disposed = false;
    const disposing = f.sidebar.dispose().then(() => { disposed = true; });
    const renders = f.state.renders;
    await tick(); assert.equal(disposed, false);
    first.resolve(); await tick();
    assert.deepEqual(f.state.writes, ["en", "zh"]);
    assert.equal(disposed, false);
    second.resolve(); await Promise.all([en, zh, disposing]);
    assert.deepEqual(f.state.saved, ["en", "zh"]);
    assert.equal(f.state.notifications.length, 0);
    assert.equal(f.state.renders, renders);
  } finally { first.resolve(); second.resolve(); }
});

test("保存失败保留本次语言、清洗错误，并允许后续再次保存", async (t) => {
  let attempts = 0;
  const f = fixture(t, { save: async () => { if (++attempts === 1) throw new Error("EACCES\u001b[31m\u202e"); } });
  await f.sidebar.command("lang en");
  assert.equal(f.sidebar.currentLanguage, "en");
  const notice = f.state.notifications.at(-1)!;
  assert.equal(notice.level, "warning");
  assert.ok(notice.message.startsWith("Could not save sidebar language"));
  assert.ok(notice.message.includes("\\u{1b}")); assert.ok(notice.message.includes("\\u{202e}"));
  assert.ok(!/[\u001b\u202e]/u.test(notice.message));
  await f.sidebar.command("lang zh");
  assert.deepEqual(f.state.saved, ["zh"]);
  assert.equal(f.state.notifications.at(-1)?.message, "侧栏语言：中文（已保存）");
});

test("预览标题、统计、空文件、二进制及 UTF-8 提示翻译；缓存正文和路径保持原样", async (t) => {
  const f = fixture(t), root = await mkdtemp(join(tmpdir(), "pi-sidebar-preview-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "文稿\u202e.txt", path = join(root, name), source = "中文正文\u001b[31m\nsecond line\n";
  await writeFile(path, source);
  const data = await readPreview(root, path), original = structuredClone(data);
  let language: Language = "zh";
  const preview = new TextPreview(data, () => f.theme, f.tui, () => {}, () => language);
  assert.ok(plain(preview.render(120))[0].includes("只读"));
  await rm(path); // 切换后仍可呈现已读取的正文，无需文件再次存在。
  language = "en";
  const rendered = plain(preview.render(120));
  assert.ok(rendered[0].includes("Read-only · 文稿\\u{202e}.txt"));
  assert.ok(rendered[1].includes("bytes · 2 lines"));
  assert.ok(rendered.some((line) => line.includes("中文正文\\u{1b}[31m")));
  assert.ok(rendered.at(-1)?.includes("Esc/click to close"));
  assert.deepEqual(data, original);

  for (const [name, content, expected] of [
    ["empty", Buffer.alloc(0), "(empty file)"],
    ["binary", Buffer.from([0, 1]), "Binary file"],
    ["encoding", Buffer.from([0xff]), "not valid UTF-8"],
  ] as const) {
    const path = join(root, name); await writeFile(path, content);
    const data = await readPreview(root, path);
    const view = new TextPreview(data, () => f.theme, f.tui, () => {}, () => language);
    assert.ok(plain(view.render(120)).join("\n").includes(expected));
    assert.ok(!/\p{Script=Han}/u.test(plain(view.render(120)).join("\n")));
  }
  const long = join(root, "long.txt"); await writeFile(long, "line\n".repeat(MAX_PREVIEW_LINES + 1));
  const limited: PreviewData = await readPreview(root, long);
  assert.equal(limited.lines.length, MAX_PREVIEW_LINES); assert.equal(limited.truncated, true);
  const limitedView = new TextPreview(limited, () => f.theme, f.tui, () => {}, () => language);
  assert.ok(plain(limitedView.render(120))[1].includes("Truncated (512 KiB / 5000 line limit)"));
});

test("所有内置错误都有英文文案；文件验证、引用和 argv 安全规则未放宽", async (t) => {
  const messages = getMessages("en");
  for (const code of Object.keys(messages.errors) as (keyof typeof messages.errors)[]) {
    const text = describeError(new SidebarError(code), "en");
    assert.equal(text, messages.errors[code]); assert.ok(!/\p{Script=Han}/u.test(text));
  }
  const root = await mkdtemp(join(tmpdir(), "pi-sidebar-action-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "文稿 file.txt"), link = join(root, "link.txt");
  await writeFile(path, "unchanged"); await symlink(path, link);
  for (const [target, code] of [[root, "fileOnly"], [join(root, "..", "outside.txt"), "outsideRoot"], [link, "symlink"]]) {
    await assert.rejects(validateFile(root, target), (error: unknown) => error instanceof SidebarError && error.code === code);
  }
  const copied: string[] = [];
  assert.equal(await copyPath(root, link, false, () => true, async (text) => { copied.push(text); }), true);
  assert.deepEqual(copied, ["link.txt"]);
  assert.equal(formatReference("文稿 file.txt"), '@"文稿 file.txt"');
  assert.throws(() => formatReference("bad\u202e.txt"), SidebarError);
  assert.deepEqual(parseEditorCommand('code --wait "a b"'), ["code", "--wait", "a b"]);
  for (const command of ["", "code | cat", "code $HOME", 'code "broken', "code\n--wait"]) assert.throws(() => parseEditorCommand(command), SidebarError);
  assert.equal(await readFile(path, "utf8"), "unchanged");
});
