import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fileSidebarExtension from "../extensions/index.ts";
import { loadLanguage } from "../src/language.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

function harness(root: string) {
  const events = new Map<string, Handler>();
  const commands = new Map<string, { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }>();
  const shortcuts = new Map<string, { handler(ctx: ExtensionContext): void }>();
  const notifications: { owner: string; message: string; level: string }[] = [];
  const widgets: { owner: string; mounted: boolean }[] = [];
  let listeners = 0;
  const pi = {
    on(name: string, handler: Handler) { events.set(name, handler); return () => {}; },
    registerCommand(name: string, options: { description: string; handler(args: string, ctx: ExtensionContext): Promise<void> }) { commands.set(name, options); },
    registerShortcut(name: string, options: { handler(ctx: ExtensionContext): void }) { shortcuts.set(name, options); },
  } as unknown as ExtensionAPI;
  fileSidebarExtension(pi);
  const context = (mode: string, owner: string) => ({
    mode, cwd: join(root, "project"), isIdle: () => true, isProjectTrusted: () => false,
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setWidget(_key: string, component: unknown) { widgets.push({ owner, mounted: component !== undefined }); },
      onTerminalInput() { listeners++; return () => { listeners--; }; },
      notify(message: string, level: string) { notifications.push({ owner, message, level }); },
      getEditorText: () => "draft",
      setEditorText() { assert.fail("语言切换不得重写草稿"); },
      pasteToEditor() { assert.fail("语言切换不得插入草稿"); },
    },
  }) as unknown as ExtensionContext;
  const fire = async (name: string, ctx = context("tui", "cleanup")) => { await events.get(name)?.({}, ctx); };
  const command = async (args: string, ctx: ExtensionContext) => { await commands.get("file-sidebar")!.handler(args, ctx); };
  return { context, fire, command, notifications, widgets, commands, shortcuts, get listeners() { return listeners; } };
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-sidebar-extension-")), agentDir = join(root, "agent");
  const before = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const apps: ReturnType<typeof harness>[] = [];
  const create = () => { const app = harness(root); apps.push(app); return app; };
  t.after(async () => {
    try { for (const app of apps) await app.fire("session_shutdown"); }
    finally {
      if (before === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = before;
      await rm(root, { recursive: true, force: true });
    }
  });
  return { root, agentDir, create };
}

test("扩展工厂仅注册能力；非 TUI 启停和命令不创建运行时或输出 UI", async (t) => {
  const f = await fixture(t), app = f.create();
  assert.ok(app.commands.get("file-sidebar")?.description.includes("lang"));
  assert.equal(app.widgets.length, 0);
  assert.equal(app.listeners, 0);
  for (const mode of ["rpc", "print", "json"]) {
    const ctx = app.context(mode, mode);
    await app.fire("session_start", ctx);
    await app.command("lang en", ctx);
    app.shortcuts.get("ctrl+shift+e")!.handler(ctx);
    await app.fire("session_shutdown", ctx);
  }
  assert.deepEqual(app.notifications, []);
  assert.deepEqual(app.widgets, []);
  assert.equal(app.listeners, 0);
  await assert.rejects(readFile(join(f.agentDir, "file-sidebar.json")), { code: "ENOENT" });
});

test("会话替换等待已选择语言保存；新会话和 reload 工厂读取持久偏好", async (t) => {
  const f = await fixture(t), app = f.create();
  const first = app.context("tui", "first"), second = app.context("tui", "second");
  await app.fire("session_start", first);
  await app.command("lang", first);
  assert.ok(app.notifications.at(-1)?.message.includes("中文（zh）"));
  app.notifications.length = 0;

  const saving = app.command("lang en", first);
  const stopping = app.fire("session_shutdown", first);
  const starting = app.fire("session_start", second);
  await Promise.all([saving, stopping, starting]);
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "en" });
  assert.equal(app.notifications.length, 0, "旧保存完成不得向旧/新上下文发出通知");
  await app.command("lang", second);
  assert.ok(app.notifications.at(-1)?.message.includes("English (en)"));
  assert.deepEqual(app.widgets, [
    { owner: "first", mounted: true }, { owner: "first", mounted: false }, { owner: "second", mounted: true },
  ]);
  assert.equal(app.listeners, 1);

  await app.fire("session_shutdown", second);
  const reloaded = f.create(), third = reloaded.context("tui", "reload");
  await reloaded.fire("session_start", third);
  await reloaded.command("lang", third);
  assert.ok(reloaded.notifications.at(-1)?.message.includes("English (en)"));
  await reloaded.command("lang zh", third);
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "zh" });
});

test("语言加载中的旧 session_start 被 shutdown/替换淘汰，不挂载旧布局", async (t) => {
  const f = await fixture(t), app = f.create();
  await mkdir(f.agentDir);
  await writeFile(join(f.agentDir, "file-sidebar.json"), '{"language":"en"}');
  const first = app.context("tui", "stale"), second = app.context("tui", "current");
  const oldStart = app.fire("session_start", first);
  await Promise.resolve();
  const shutdown = app.fire("session_shutdown", first), newStart = app.fire("session_start", second);
  await Promise.all([oldStart, shutdown, newStart]);
  assert.deepEqual(app.widgets, [{ owner: "current", mounted: true }]);
  assert.equal(app.listeners, 1);
  assert.equal(app.notifications.length, 0);
  await app.command("lang", second);
  assert.equal(app.notifications.at(-1)?.owner, "current");
  assert.ok(app.notifications.at(-1)?.message.includes("English (en)"));
});

test("配置读取失败仅向当前 TUI 告警；保存失败仍切换本次界面且不破坏配置", async (t) => {
  const f = await fixture(t), app = f.create(), ctx = app.context("tui", "active");
  await mkdir(f.agentDir);
  const path = join(f.agentDir, "file-sidebar.json"), bad = "{broken";
  await writeFile(path, bad);
  await app.fire("session_start", ctx);
  assert.equal(app.widgets.length, 1);
  assert.ok(app.notifications.at(-1)?.message.includes("暂用中文"));
  await app.command("lang en", ctx);
  assert.equal(app.notifications.at(-1)?.level, "warning");
  assert.ok(app.notifications.at(-1)?.message.includes("Could not save sidebar language"));
  await app.command("lang", ctx);
  assert.ok(app.notifications.at(-1)?.message.includes("English (en)"));
  assert.equal(await readFile(path, "utf8"), bad);
});
