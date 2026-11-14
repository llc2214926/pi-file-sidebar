import type { BigIntStats } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { copyToClipboard, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isWithin } from "./tree.ts";
import { SidebarError } from "./i18n.ts";

/** 动作前重新验证路径与普通文件；不跟随根内部的文件/目录链接。 */
export async function validateFile(root: string, path: string): Promise<{ path: string; dev: bigint; ino: bigint }> {
  const base = resolve(root), absolute = resolve(path);
  if (!isWithin(base, absolute)) throw new SidebarError("outsideRoot");
  const child = relative(base, absolute), parts = child.split(sep).filter(Boolean);
  if (!parts.length) throw new SidebarError("fileOnly");
  let current = base, info: BigIntStats | undefined;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    info = await lstat(current, { bigint: true });
    if (info.isSymbolicLink()) throw new SidebarError("symlink");
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new SidebarError("notFile");
  }
  const actualRoot = await realpath(base), actual = await realpath(absolute);
  if (!isWithin(actualRoot, actual)) throw new SidebarError("movedOutsideRoot");
  if (actual !== resolve(actualRoot, child)) throw new SidebarError("fileChanged");
  return { path: actual, dev: info!.dev, ino: info!.ino };
}

/** 与 Pi 1.5 工具保持相同的纯路径规范化；不读文件、不跟随链接。 */
export function resolveToolPath(root: string, path: string): string {
  let normalized = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !normalized.includes("\\")) {
    const drive = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(normalized);
    if (drive) normalized = `${drive[1]!.toUpperCase()}:\\${drive[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (normalized === "~") normalized = homedir();
  else if (normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))) normalized = join(homedir(), normalized.slice(2));
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(root, normalized);
}

export function formatReference(path: string): string {
  if (!path || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw new SidebarError("referenceControl");
  return `@${/^[\p{L}\p{N}\p{M}._/-]+$/u.test(path) ? path : JSON.stringify(path)}`;
}

export async function copyPath(root: string, path: string, absolute: boolean, isCurrent: () => boolean,
  clipboard: (text: string) => Promise<void> = copyToClipboard): Promise<boolean> {
  if (!isWithin(resolve(root), resolve(path))) throw new SidebarError("outsideRoot");
  await lstat(path); // 链接本身可以复制，不跟随目标。
  if (!isCurrent()) return false;
  await clipboard(absolute ? path : relative(root, path) || ".");
  return true;
}

/** 只解析 argv；不执行 shell、变量插值、管道或重定向。 */
export function parseEditorCommand(command: string): string[] {
  if (/[\r\n\0]/.test(command)) throw new SidebarError("editorControl");
  const args: string[] = [];
  let word = "", quote = "", escaped = false, started = false;
  const flush = () => { if (started) args.push(word); word = ""; started = false; };
  for (const char of command) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (quote === "'") { if (char === "'") quote = ""; else word += char; continue; }
    if (char === "\\") { escaped = true; started = true; continue; }
    if (quote === '"') { if (char === '"') quote = ""; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; started = true; }
    else if (/\s/.test(char)) flush();
    else if (/[|&;<>$`()]/.test(char)) throw new SidebarError("editorShell");
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new SidebarError("editorIncomplete");
  flush();
  if (!args[0]) throw new SidebarError("editorEmpty");
  if (args[0].startsWith("~/")) args[0] = join(homedir(), args[0].slice(2));
  return args;
}

export async function readEditorCommand(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): Promise<string> {
  const read = async (path: string) => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new SidebarError("editorSettingsRead"); }
  };
  const [global, project] = await Promise.all([read(join(agentDir, "settings.json")),
    projectTrusted ? read(join(cwd, ".pi/settings.json")) : Promise.resolve(undefined)]);
  const snapshot = { global, project };
  // 用公开 SettingsManager 解析只读快照，既保留 Pi 优先级，也不创建用户配置锁/迁移写入。
  const settings = SettingsManager.fromStorage({ withLock(scope, fn) { fn(snapshot[scope]); } }, { projectTrusted });
  if (settings.drainErrors().length) throw new SidebarError("editorSettingsInvalid");
  return settings.getExternalEditorCommand();
}
