import { VERSION, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DirPicker, shortenPath } from "./dir-picker.ts";
import { describeError, getMessages, SidebarError, type Language } from "./i18n.ts";
import { abandonDestination, archiveSource, isCurrentDirectory, persistentManager, prepareEmptySession, prepareSessionMove, requireIdle, SessionPreparationError, validateTarget } from "./switch.ts";
import { openNativeResume } from "./host.ts";
import { displayText } from "./tree.ts";
import { DoubleBorder } from "./frame.ts";

export function decodeCdTarget(args: string): string | undefined {
  const encoded = args.trim();
  if (!encoded) return undefined;
  try {
    if (/\s/.test(encoded)) throw new Error();
    const target = decodeURIComponent(encoded);
    if (!target || target.includes("\0")) throw new Error();
    return target;
  } catch { throw new SidebarError("invalidCdPath"); }
}

export type DirectoryMode = "keep" | "new" | "resume";

// 所有替换后的 ctx 副作用必须在 withSession 中；抛错后只能生成数据错误交给宿主报告。
export async function performSwitch(ctx: ExtensionCommandContext, picked: string,
  options: { captureDraft: boolean; language: Language; mode?: DirectoryMode }): Promise<"switched" | "cancelled"> {
  const language = options.language, text = getMessages(language).switch, mode = options.mode ?? "keep";
  if (!requireIdle(ctx)) throw new SidebarError("agentBusy");
  const target = validateTarget(picked, ctx.cwd, { allowCurrent: mode !== "keep" });
  if (isCurrentDirectory(target, ctx.cwd)) {
    if (mode === "resume") { openNativeResume(ctx); return "switched"; }
    // 同目录与 /new 相同，不建立目录切换快照，也不设置父会话或恢复草稿。
    const result = await ctx.newSession();
    return result.cancelled ? "cancelled" : "switched";
  }
  const manager = persistentManager(ctx), source = manager.getSessionFile()!;
  let sessionId = manager.getSessionId();
  const draft = mode === "keep" && options.captureDraft ? ctx.ui.getEditorText() : undefined;
  let destination: string;
  try {
    if (mode === "keep") { ({ destination } = prepareSessionMove(manager, target)); }
    else { ({ destination, sessionId } = prepareEmptySession(manager, target)); }
  }
  catch (error) {
    if (error instanceof SessionPreparationError) {
      throw new Error(displayText(`${text.failed(describeError(error.cause, language))}\n${text.recovery(source, error.destination)}${
        error.cleanupError ? `\n${text.abandonFailed(error.destination, describeError(error.cleanupError, language))}` : ""}`), { cause: error });
    }
    throw error;
  }
  let takenOver = false, sourceRecovery = source, recoveryPath = destination;
  let abandonmentAttempted = false;
  try {
    // Pi 的交互层遇到致命 runtime 错误可能直接 exit；提前显示恢复路径，不能承诺 catch 总能执行。
    ctx.ui.notify(displayText(mode === "keep" ? text.switching(source, destination) : text.starting(source, destination)), "info");
    const result = await ctx.switchSession(destination, {
      withSession: async (fresh) => {
        if (fresh.cwd !== target || fresh.sessionManager.getSessionFile() !== destination
          || fresh.sessionManager.getSessionId() !== sessionId) throw new SidebarError("sessionTakeoverFailed");
        takenOver = true;
        // 回调只捕获数据和独立辅助函数；不能访问旧 runtime、pi 或 ctx。
        if (mode === "keep") {
          try {
            const archive = archiveSource(source);
            sourceRecovery = archive.backup ?? source;
            if (archive.sourceRetained) fresh.ui.notify(displayText(text.sourceRetained(source, archive.backup!)), "warning");
          } catch (error) { fresh.ui.notify(displayText(text.archiveFailed(source, describeError(error, language))), "warning"); }
        }
        if (draft !== undefined) {
          try { fresh.ui.setEditorText(draft); }
          catch (error) { fresh.ui.notify(displayText(text.draftFailed(describeError(error, language))), "warning"); }
        }
        fresh.ui.notify(mode === "keep" ? text.done(shortenPath(target)) : text.started(shortenPath(target)), "info");
        if (mode === "resume") {
          // 接管后打开列表失败不应让宿主按致命 runtime 错误退出；保留新会话并提示手动恢复。
          try {
            if (!requireIdle(fresh)) throw new SidebarError("agentBusy");
            openNativeResume(fresh);
          } catch (error) { fresh.ui.notify(displayText(describeError(error, language)), "warning"); }
        }
      },
    });
    if (result.cancelled) {
      abandonmentAttempted = true;
      recoveryPath = abandonDestination(destination);
      // cancelled 表示旧 runtime 未被替换，此处旧 ctx 仍有效。
      ctx.ui.notify(displayText(`${text.cancelled}\n${text.abandoned(recoveryPath)}`), "info");
      return "cancelled";
    }
    if (!takenOver) throw new SidebarError("sessionTakeoverFailed");
    return "switched";
  } catch (error) {
    let cleanup = "";
    // 接管后的异常不能移动正在使用的新会话文件；失败的归档也不盲目重试。
    if (!takenOver && !abandonmentAttempted) {
      try { recoveryPath = abandonDestination(destination); }
      catch (failure) { cleanup = `\n${text.abandonFailed(destination, describeError(failure, language))}`; }
    } else if (abandonmentAttempted && recoveryPath === destination) {
      cleanup = `\n${text.abandonFailed(destination, describeError(error, language))}`;
    }
    throw new Error(displayText(`${text.failed(describeError(error, language))}\n${text.recovery(sourceRecovery, recoveryPath)}${cleanup}`), { cause: error });
  }
}

// 每个扩展 runtime 一把锁；dispose 取消选择器但不等待自身的 switchSession，避免 shutdown 死锁。
export class DirectoryCommands {
  private busy = false;
  private disposed = false;
  private closePicker?: () => void;
  private pickerGeneration = 0;

  constructor(private language: () => Language, private available: () => boolean, private leaveTree: () => void) {}

  async command(args: string, ctx: ExtensionCommandContext, mode: DirectoryMode = "keep"): Promise<void> {
    if (this.disposed || ctx.mode !== "tui") return;
    const warn = (error: unknown) => ctx.ui.notify(displayText(describeError(error, this.language())), "warning");
    if (VERSION !== "1.4.0" || !ctx.hasUI) { warn(new SidebarError("switchTuiOnly")); return; }
    if (this.busy) { warn(new SidebarError("switchBusy")); return; }
    this.busy = true;
    let switching = false, switchLanguage = this.language();
    try {
      if (!requireIdle(ctx)) throw new SidebarError("agentBusy");
      if (!this.available()) throw new SidebarError("hostBusy");
      if (mode === "keep") persistentManager(ctx);
      let target = decodeCdTarget(args);
      if (target === undefined) {
        this.leaveTree();
        const initialDir = ctx.cwd, generation = ++this.pickerGeneration;
        let picker: DirPicker | undefined;
        target = await ctx.ui.custom<string | undefined>((tui, _theme, _keys, done) => {
          if (this.disposed || generation !== this.pickerGeneration) { done(undefined); return { render: () => [], invalidate() {} }; }
          const component = new DirPicker(tui, () => ctx.ui.theme, this.language, done, initialDir);
          picker = component;
          this.closePicker = () => { component.dispose(); done(undefined); };
          return new DoubleBorder(component, (text) => ctx.ui.theme.fg("border", text));
        }, { overlay: true, overlayOptions: { anchor: "center", width: "85%", maxHeight: "90%" },
          onHandle: (handle) => picker?.bindOverlay(handle) });
        this.closePicker = undefined;
        if (this.disposed || generation !== this.pickerGeneration || target === undefined) return;
      }
      if (!requireIdle(ctx)) throw new SidebarError("agentBusy");
      if (!this.available()) throw new SidebarError("hostBusy");
      // 新命令允许同目录；此时交由宿主直接 new 或 resume，不迁移会话文件。
      target = validateTarget(target, ctx.cwd, { allowCurrent: mode !== "keep" });
      this.leaveTree();
      switchLanguage = this.language();
      switching = true;
      await performSwitch(ctx, target, { captureDraft: mode === "keep", language: switchLanguage, mode });
      // 不在这里通知，也不再读取 ctx；旧 runtime 已失效。
    } catch (error) {
      if (switching) throw new Error(displayText(describeError(error, switchLanguage)), { cause: error });
      if (!this.disposed) warn(error);
    } finally { this.busy = false; }
  }

  cancelPicker(): void {
    this.pickerGeneration++;
    const close = this.closePicker; this.closePicker = undefined; close?.();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPicker();
  }
}
