import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isLanguage, SidebarError, type Language } from "./i18n.ts";

const MAX_SETTINGS_BYTES = 16 * 1024;
const SETTINGS_FILE = "file-sidebar.json";

async function readSettings(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    if (!(await lstat(path)).isFile()) throw new SidebarError("languageSettingsNotFile");
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new SidebarError("languageSettingsNotFile");
      if (info.size > MAX_SETTINGS_BYTES) throw new SidebarError("languageSettingsLarge");
      // 即使读取期间文件增长，也只读取上限加一个判定字节。
      const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > MAX_SETTINGS_BYTES) throw new SidebarError("languageSettingsLarge");
      let settings: unknown;
      try { settings = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { throw new SidebarError("languageSettingsInvalid"); }
      if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new SidebarError("languageSettingsInvalid");
      return settings as Record<string, unknown>;
    } finally { await file.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw new SidebarError("languageSettingsNotFile");
    throw error;
  }
}

export async function loadLanguage(agentDir = getAgentDir()): Promise<{ language: Language; error?: unknown }> {
  try {
    const settings = await readSettings(join(resolve(agentDir), SETTINGS_FILE));
    const language = settings?.language === undefined ? "zh" : settings.language;
    if (!isLanguage(language)) throw new SidebarError("languageSettingsInvalid");
    return { language };
  } catch (error) { return { language: "zh", error }; }
}

export async function saveLanguage(language: Language, agentDir = getAgentDir()): Promise<void> {
  if (!isLanguage(language)) throw new SidebarError("languageSettingsInvalid");
  const directory = resolve(agentDir), path = join(directory, SETTINGS_FILE);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const settings = await readSettings(path);
  const content = `${JSON.stringify({ ...settings, language }, null, 2)}\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_SETTINGS_BYTES) throw new SidebarError("languageSettingsLarge");
  // 只写本扩展的偏好文件；不读取/写入 Pi settings.json，也不改安装副本。
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    try { await file.writeFile(content, "utf8"); await file.sync(); }
    finally { await file.close(); }
    const target = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (target && !target.isFile()) throw new SidebarError("languageSettingsNotFile");
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
  }
}
