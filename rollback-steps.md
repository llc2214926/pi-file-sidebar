# 0.2.1 deployment rollback / 部署回滚

**操作手册，不是已执行记录。源代码开发不自动安装、改注册或停用旧扩展。**

**Runbook, not an execution record. Source development does not install packages, change registrations, or disable the standalone extension.**

## 中文

### 部署前

1. 完成 README 中尚未勾选的实机验收；保留可恢复的原会话文件，记录 `/session` 的 ID、cwd、消息数和路径。
2. 用 `pi list` 确认实际注册源，备份该安装目录、独立 `cd-picker.ts` 及个人设置。尊重 `PI_CODING_AGENT_DIR`，不要假设仍使用 git 安装路径。
3. 本次开发发现的现役目录是 `~/.pi/agent/local-packages/pi-file-sidebar/0.1.3`；计划里的 git 目录不存在。备份位于计划旁的 `backup-v0.1.3-clean/original/0.1.3/` 和 `backup-cd-picker-original.ts`。使用前再次核对内容，后续运行环境可能不同。
4. 只有部署时才执行 `./scripts/publish-install.sh`，并在成功注册后停用旧 `cd-picker.ts`。若注册失败或同时存在两个版本，不要 reload；先核对实际注册状态。

### 回退本地安装

停止正在进行的目录切换/编辑器动作。确认 0.1.3 目录还完整，以下命令针对默认本地版本目录；**若 `pi list` 显示不同路径或资源过滤配置，按实际源处理，不要照抄**。

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
test -f "$agent_dir/local-packages/pi-file-sidebar/0.1.3/package.json"
# 上一步不成功则停止，先从核实过的备份恢复到一个空的独立目录。
pi remove "$agent_dir/local-packages/pi-file-sidebar/0.2.1"
pi install "$agent_dir/local-packages/pi-file-sidebar/0.1.3"
pi list
```

逐条核对执行结果；不要删除新旧安装目录，也不要用递归覆盖把两个版本混在一起。git/远程纯净包安装应恢复对应的已验证版本和原注册源，不改动无关包或项目设置。

确认新包不再加载后，恢复独立扩展（仅当 `.ts` 不存在且 `.disabled` 是已核实的备份时）：

```bash
# 检查存在性后再执行；不覆盖现有 cd-picker.ts。
mv -n "$agent_dir/extensions/cd-picker.ts.disabled" "$agent_dir/extensions/cd-picker.ts"
```

如果停用文件不存在，从备份复制到不存在的目标，而不是覆盖现役文件。重启 Pi，或在仍有效的交互会话内输入 `/reload`（不是在 shell 执行 `pi /reload`）。确认无重复 `/cd`，检查旧版 `/cd` 和侧栏能打开；在一次性会话中做切换冒烟后才判定回退成功。

### 会话恢复不等于包回退

- 切换失败且原文件还在：`pi --session '/原文件绝对路径.jsonl'`，或重启后 `/resume` 选择原会话。
- 原文件已经归档：保留 `.cd-backup`，可将它复制到一个**不存在的** `.jsonl` 恢复路径，再用 `--session` 明确打开该副本。不覆盖活动会话文件。
- `.cd-abandoned` / 残留目标 `.jsonl`：先核对 header、cwd 和实际活动会话，确认无人使用后再手动归档。不要通配删除会话文件；不要同时在两个 Pi 中续写相同会话。
- Pi 1.4.0 致命错误可能直接退出；扩展无法保证 UI 恢复或 `.cd-abandoned` 自动改名。切换前提示的两路径是恢复线索，不是备份成功证明。

## English

### Before deployment

1. Complete the pending real-terminal acceptance in README. Keep a recoverable original session and record `/session` ID, cwd, message count and path.
2. Run `pi list` to identify the actual registration. Back up that installation, standalone `cd-picker.ts`, and personal settings. Honor `PI_CODING_AGENT_DIR`; do not assume a git installation.
3. Development found `~/.pi/agent/local-packages/pi-file-sidebar/0.1.3`, not the git directory named in the plan. Backups beside the plan are `backup-v0.1.3-clean/original/0.1.3/` and `backup-cd-picker-original.ts`. Verify their contents again before using them; later environments may differ.
4. Only at deployment run `./scripts/publish-install.sh`, then disable the standalone extension after successful registration. If registration fails or two versions remain registered, resolve that state before reloading.

### Revert a local installation

Finish any directory switch/editor operation first. Verify the old 0.1.3 directory is intact. The commands above remove the default local 0.2.1 registration, register the old version, and list registrations. Stop if any command fails. If `pi list` shows another source or resource filters, use that actual source instead. Do not delete installation directories or recursively overlay different versions. Git/clean-package installs need the corresponding verified old package and original registration, without changing unrelated packages or project settings.

Once the new package will no longer load, restore `cd-picker.ts.disabled` with the no-overwrite `mv -n` command above, only if the destination does not exist and the source is verified. If needed, copy the backup to an absent destination rather than overwriting a live extension. Restart Pi or enter `/reload` in a valid interactive Pi session (not `pi /reload` in a shell). Check for duplicate `/cd` registrations, open the old picker/sidebar, and smoke-test a disposable session before declaring rollback successful.

### Recover sessions separately

- If the original `.jsonl` remains, use `pi --session '/absolute/path/to/original.jsonl'` or choose it with `/resume` after restarting.
- If archived, retain the `.cd-backup`; copy it to a **nonexistent** `.jsonl` recovery path and explicitly open that copy with `--session`. Never overwrite a live session.
- Inspect headers/cwd and the active session before manually archiving an unused `.cd-abandoned` or leftover target `.jsonl`. Do not use wildcard deletion or continue the same file in two Pi instances.
- Pi 1.4.0 fatal errors may exit immediately; neither UI restoration nor automatic `.cd-abandoned` renaming is guaranteed. The paths shown before switching are recovery clues, not proof that archival succeeded.
