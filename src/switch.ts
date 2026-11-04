import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager, type ExtensionContext, type FileEntry, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { SidebarError } from "./i18n.ts";

// 会话文件逻辑不操作 UI；宿主切换和新上下文副作用集中在 cd-command.ts。
export function validateTarget(picked: string, current: string, options: { allowCurrent?: boolean } = {}): string {
  const expanded = picked === "~" ? homedir() : picked.startsWith("~/") ? join(homedir(), picked.slice(2)) : picked;
  const target = fs.realpathSync(resolve(current, expanded));
  if (!fs.statSync(target).isDirectory()) throw new SidebarError("targetNotDirectory");
  fs.accessSync(target, fs.constants.R_OK | fs.constants.X_OK);
  if (!options.allowCurrent && isCurrentDirectory(target, current)) throw new SidebarError("sameDirectory");
  return target;
}

export function isCurrentDirectory(target: string, current: string): boolean {
  let actualCurrent = resolve(current);
  try { actualCurrent = fs.realpathSync(actualCurrent); }
  catch { /* 当前目录已消失时仍允许离开。 */ }
  return target === actualCurrent;
}

export function requireIdle(ctx: Pick<ExtensionContext, "isIdle" | "hasPendingMessages">): boolean {
  return ctx.isIdle() && !ctx.hasPendingMessages();
}

// Pi 1.4.0 的只读类型未暴露这两个查询，但实际提供的是 SessionManager。
export function persistentManager(ctx: Pick<ExtensionContext, "sessionManager">): SessionManager {
  const manager = ctx.sessionManager as SessionManager;
  if (typeof manager.isPersisted !== "function" || typeof manager.usesDefaultSessionDir !== "function"
    || !manager.isPersisted() || !manager.getSessionFile()) throw new SidebarError("sessionNotPersisted");
  return manager;
}

function availableName(source: string, suffix: "cd-backup" | "cd-abandoned"): string {
  let candidate = `${source}.${suffix}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { fs.lstatSync(candidate); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
    // lstat 而非 exists：悬空链接也视为冲突，不覆盖历史备份。
    candidate = `${source}.${randomUUID()}.${suffix}`;
  }
  throw new SidebarError("sessionNameCollision");
}

export function abandonDestination(destination: string): string {
  const abandoned = availableName(destination, "cd-abandoned");
  fs.renameSync(destination, abandoned);
  return abandoned;
}

// 写入期间的错误携带实际留下的路径；不删除部分文件，也不把它留在 /resume 列表中。
export class SessionPreparationError extends Error {
  constructor(readonly destination: string, cause: unknown, readonly cleanupError?: unknown) {
    super("Session snapshot could not be written", { cause });
  }
}

export function prepareSessionMove(manager: SessionManager, target: string): { destination: string } {
  const header = manager.getHeader();
  if (!header) throw new SidebarError("sessionHeaderMissing");
  const destinationManager = SessionManager.create(target,
    manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir(), { id: manager.getSessionId() });
  const marker: SessionEntry = {
    type: "custom", id: randomUUID(), parentId: manager.getLeafId(), timestamp: new Date().toISOString(),
    customType: "cd-picker", data: { from: manager.getCwd(), to: target },
  };
  // 保留全部分支；marker 挂在当前 leaf（包括 null），而不是最近写入的废弃分支。
  const entries: FileEntry[] = [{ ...header, cwd: target }, ...manager.getEntries(), marker];
  return writeSessionSnapshot(destinationManager, entries, manager.getSessionFile());
}

export function prepareEmptySession(manager: SessionManager, target: string): { destination: string; sessionId: string } {
  const destinationManager = SessionManager.create(target,
    manager.usesDefaultSessionDir() ? undefined : manager.getSessionDir());
  // 只写新宿主头部，不复制旧 ID、parentSession、消息、分支、名称或扩展状态。
  const header = destinationManager.getHeader()!;
  return { ...writeSessionSnapshot(destinationManager, [header], manager.getSessionFile()), sessionId: header.id };
}

function writeSessionSnapshot(manager: SessionManager, entries: FileEntry[], source?: string): { destination: string } {
  const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
  const timestamp = Date.now();
  for (let attempt = 0; attempt < 100; attempt++) {
    const fileTimestamp = new Date(timestamp + attempt).toISOString().replace(/[:.]/g, "-");
    const destination = join(manager.getSessionDir(), `${fileTimestamp}_${manager.getSessionId()}.jsonl`);
    if (destination === source) continue;
    let fd: number;
    try { fd = fs.openSync(destination, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    try {
      try { fs.writeFileSync(fd, content, "utf8"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      return { destination };
    } catch (error) {
      let abandoned: string;
      try { abandoned = abandonDestination(destination); }
      catch (cleanupError) { throw new SessionPreparationError(destination, error, cleanupError); }
      throw new SessionPreparationError(abandoned, error);
    }
  }
  throw new SidebarError("sessionNameCollision");
}

export function archiveSource(source: string): { backup?: string; sourceRetained: boolean } {
  try { fs.lstatSync(source); }
  catch (error) {
    // 尚未产生首条回复的持久化会话可能还未落盘。
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { sourceRetained: false };
    throw error;
  }
  const backup = availableName(source, "cd-backup");
  try { fs.renameSync(source, backup); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.copyFileSync(source, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, 0o600);
    return { backup, sourceRetained: true };
  }
  return { backup, sourceRetained: false };
}
