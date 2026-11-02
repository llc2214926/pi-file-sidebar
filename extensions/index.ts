import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVATE } from "../src/host.ts";
import { FileSidebar } from "../src/sidebar.ts";
import { describeError, getMessages } from "../src/i18n.ts";
import { loadLanguage, saveLanguage } from "../src/language.ts";
import { displayText } from "../src/tree.ts";

export default function fileSidebarExtension(pi: ExtensionAPI) {
  let runtime: FileSidebar | undefined;
  let generation = 0, disposal: Promise<void> = Promise.resolve();
  const stop = () => {
    const previous = runtime; runtime = undefined;
    if (previous) disposal = Promise.all([disposal, previous.dispose()]).then(() => {});
    return disposal;
  };
  pi.on("session_start", async (_event, ctx) => {
    const current = ++generation;
    await stop();
    if (current !== generation || ctx.mode !== "tui") return;
    const agentDir = getAgentDir(), settings = await loadLanguage(agentDir);
    if (current !== generation) return;
    runtime = new FileSidebar(ctx, settings.language, (language) => saveLanguage(language, agentDir));
    if (settings.error !== undefined) {
      ctx.ui.notify(displayText(getMessages(settings.language).languageLoadFailed(describeError(settings.error, settings.language))), "warning");
    }
  });
  pi.on("session_shutdown", async () => { generation++; await stop(); });
  pi.on("tool_result", (event) => { runtime?.toolResult(event); });
  pi.on("ui_prompt_start", () => runtime?.host.prompt(true));
  pi.on("ui_prompt_end", () => runtime?.host.prompt(false));
  pi.registerCommand("file-sidebar", {
    description: "文件树 / File sidebar: focus/on/off/refresh/width/lang/status",
    handler: async (args, ctx) => { if (ctx.mode === "tui") await runtime?.command(args); },
  });
  pi.registerShortcut(ACTIVATE, {
    description: "进入/离开文件树 / Toggle file tree focus",
    handler: (ctx) => { if (ctx.mode === "tui") runtime?.host.enter(true); },
  });
}
