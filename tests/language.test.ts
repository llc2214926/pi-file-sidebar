import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { SidebarError } from "../src/i18n.ts";
import { loadLanguage, saveLanguage } from "../src/language.ts";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pi-sidebar-language-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent"), path = join(agentDir, "file-sidebar.json");
  return { root, agentDir, path };
}

test("首次默认中文且只读；保存后可跨新加载记忆，不触碰 Pi 设置", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "zh" });
  await assert.rejects(lstat(f.agentDir), { code: "ENOENT" });
  await mkdir(f.agentDir);
  const sentinel = "{\"sentinel\":true}\n";
  for (const name of ["settings.json", "keybindings.json"]) await writeFile(join(f.agentDir, name), sentinel);

  await saveLanguage("en", f.agentDir);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { language: "en" });
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "en" });
  if (process.platform !== "win32") assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  for (const name of ["settings.json", "keybindings.json"]) assert.equal(await readFile(join(f.agentDir, name), "utf8"), sentinel);
  assert.deepEqual((await readdir(f.agentDir)).sort(), ["file-sidebar.json", "keybindings.json", "settings.json"]);

  await saveLanguage("zh", f.agentDir);
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "zh" });
});

test("仅更新语言字段，保留未知字段；缺省值不自动写回，非法语言可显式修正", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agentDir);
  const extra = { nested: ["保留", 123], enabled: true };
  const original = JSON.stringify({ extra });
  await writeFile(f.path, original);
  assert.deepEqual(await loadLanguage(f.agentDir), { language: "zh" });
  assert.equal(await readFile(f.path, "utf8"), original);
  await writeFile(f.path, JSON.stringify({ language: "fr", extra }));
  const invalid = await loadLanguage(f.agentDir);
  assert.equal(invalid.language, "zh");
  assert.ok(invalid.error instanceof SidebarError);
  await saveLanguage("en", f.agentDir);
  assert.deepEqual(JSON.parse(await readFile(f.path, "utf8")), { language: "en", extra });
});

test("损坏 JSON、非对象和无效 UTF-8 回退中文并报错，保存不覆盖坏文件", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agentDir);
  for (const content of ["{bad", "[]", "null", "true", Buffer.from([0xff, 0xfe])]) {
    await writeFile(f.path, content);
    const before = await readFile(f.path), result = await loadLanguage(f.agentDir);
    assert.equal(result.language, "zh");
    assert.ok(result.error instanceof SidebarError);
    assert.equal(result.error.code, "languageSettingsInvalid");
    await assert.rejects(saveLanguage("en", f.agentDir), (error: unknown) => error instanceof SidebarError && error.code === "languageSettingsInvalid");
    assert.deepEqual(await readFile(f.path), before);
    assert.deepEqual(await readdir(f.agentDir), ["file-sidebar.json"]);
  }
});

test("语言配置拒绝符号链接、目录和过大文件，不跟随目标或遗留临时文件", async (t) => {
  const f = await fixture(t);
  await mkdir(f.agentDir);
  const target = join(f.root, "target.json"), original = '{"language":"en"}';
  await writeFile(target, original);
  await symlink(target, f.path);
  let result = await loadLanguage(f.agentDir);
  assert.ok(result.error instanceof SidebarError);
  assert.equal(result.error.code, "languageSettingsNotFile");
  await assert.rejects(saveLanguage("zh", f.agentDir), SidebarError);
  assert.equal(await readFile(target, "utf8"), original);
  assert.equal((await lstat(f.path)).isSymbolicLink(), true);
  await rm(f.path);

  await mkdir(f.path);
  result = await loadLanguage(f.agentDir);
  assert.ok(result.error instanceof SidebarError);
  assert.equal(result.error.code, "languageSettingsNotFile");
  await assert.rejects(saveLanguage("en", f.agentDir), SidebarError);
  await rm(f.path, { recursive: true });

  const large = " ".repeat(16 * 1024 + 1);
  await writeFile(f.path, large);
  result = await loadLanguage(f.agentDir);
  assert.ok(result.error instanceof SidebarError);
  assert.equal(result.error.code, "languageSettingsLarge");
  await assert.rejects(saveLanguage("en", f.agentDir), SidebarError);
  assert.equal(await readFile(f.path, "utf8"), large);
  assert.deepEqual(await readdir(f.agentDir), ["file-sidebar.json"]);
});

test("原子替换期间读取只看到完整旧值或新值", async (t) => {
  const f = await fixture(t);
  await saveLanguage("zh", f.agentDir);
  for (const language of ["en", "zh", "en"] as const) {
    const [_, ...reads] = await Promise.all([saveLanguage(language, f.agentDir), ...Array.from({ length: 12 }, () => loadLanguage(f.agentDir))]);
    for (const result of reads) {
      assert.ok(result);
      assert.equal(result.error, undefined);
      assert.ok(result.language === "zh" || result.language === "en");
    }
    assert.deepEqual(await loadLanguage(f.agentDir), { language });
  }
  assert.deepEqual(await readdir(f.agentDir), ["file-sidebar.json"]);
});
