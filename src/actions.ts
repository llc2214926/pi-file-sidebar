import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { copyToClipboard, getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { isWithin } from "./tree.ts";

/** 动作前重新验证路径与普通文件；不跟随根内部的文件/目录链接。 */
export async function validateFile(root: string, path: string): Promise<string> {
  const base = resolve(root), absolute = resolve(path);
  if (!isWithin(base, absolute)) throw new Error("目标不在当前工作目录内");
  const parts = relative(base, absolute).split(sep).filter(Boolean);
  if (!parts.length) throw new Error("此动作只支持普通文件");
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw new Error("符号链接不支持此动作；可以复制链接路径");
    if (index === parts.length - 1 ? !info.isFile() : !info.isDirectory()) throw new Error("目标不是普通文件");
  }
  const actualRoot = await realpath(base), actual = await realpath(absolute);
  if (!isWithin(actualRoot, actual)) throw new Error("目标已移出当前工作目录");
  return actual;
}

export function formatReference(path: string): string {
  if (!path || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(path)) throw new Error("路径含控制字符，不能可靠插入引用；请复制路径");
  return `@${/^[\p{L}\p{N}\p{M}._/-]+$/u.test(path) ? path : JSON.stringify(path)}`;
}

export async function copyPath(root: string, path: string, absolute: boolean, isCurrent: () => boolean,
  clipboard: (text: string) => Promise<void> = copyToClipboard): Promise<boolean> {
  if (!isWithin(resolve(root), resolve(path))) throw new Error("目标不在当前工作目录内");
  await lstat(path); // 链接本身可以复制，不跟随目标。
  if (!isCurrent()) return false;
  await clipboard(absolute ? path : relative(root, path) || ".");
  return true;
}

/** 只解析 argv；不执行 shell、变量插值、管道或重定向。 */
export function parseEditorCommand(command: string): string[] {
  if (/[\r\n\0]/.test(command)) throw new Error("编辑器命令不能包含换行或 NUL");
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
    else if (/[|&;<>$`()]/.test(char)) throw new Error("编辑器命令不支持 shell 操作符或插值");
    else { word += char; started = true; }
  }
  if (quote || escaped) throw new Error("编辑器命令的引号或转义不完整");
  flush();
  if (!args[0]) throw new Error("编辑器命令不能为空");
  if (args[0].startsWith("~/")) args[0] = join(homedir(), args[0].slice(2));
  return args;
}

export async function readEditorCommand(cwd: string, projectTrusted: boolean, agentDir = getAgentDir()): Promise<string> {
  const read = async (path: string) => {
    try { return await readFile(path, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("无法读取编辑器设置"); }
  };
  const [global, project] = await Promise.all([read(join(agentDir, "settings.json")),
    projectTrusted ? read(join(cwd, ".pi/settings.json")) : Promise.resolve(undefined)]);
  const snapshot = { global, project };
  // 用公开 SettingsManager 解析只读快照，既保留 Pi 优先级，也不创建用户配置锁/迁移写入。
  const settings = SettingsManager.fromStorage({ withLock(scope, fn) { fn(snapshot[scope]); } }, { projectTrusted });
  if (settings.drainErrors().length) throw new Error("编辑器设置无效，请检查 Pi settings.json");
  return settings.getExternalEditorCommand();
}
