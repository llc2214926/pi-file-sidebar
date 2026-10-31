import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ACTIVATE } from "../src/host.ts";
import { FileSidebar } from "../src/sidebar.ts";

export default function fileSidebarExtension(pi: ExtensionAPI) {
  let runtime: FileSidebar | undefined;
  pi.on("session_start", async (_event, ctx) => {
    const previous = runtime; runtime = undefined; await previous?.dispose();
    if (ctx.mode === "tui") runtime = new FileSidebar(ctx);
  });
  pi.on("session_shutdown", async () => { const previous = runtime; runtime = undefined; await previous?.dispose(); });
  pi.on("tool_result", (event) => { runtime?.toolResult(event); });
  pi.on("ui_prompt_start", () => runtime?.host.prompt(true));
  pi.on("ui_prompt_end", () => runtime?.host.prompt(false));
  pi.registerCommand("file-sidebar", {
    description: "左侧文件树：focus/on/off/refresh/width/status",
    handler: async (args, ctx) => { if (ctx.mode === "tui") runtime?.command(args); },
  });
  pi.registerShortcut(ACTIVATE, {
    description: "进入/离开左侧文件树",
    handler: (ctx) => { if (ctx.mode === "tui") runtime?.host.enter(true); },
  });
}
