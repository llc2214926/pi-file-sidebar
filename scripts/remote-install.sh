#!/usr/bin/env bash
# 远程安装：从 GitHub Release 下载 pi-file-sidebar 版本包并安装到 Pi。
# 用法：curl -fsSL <raw-url>/scripts/remote-install.sh | bash
# 或：bash remote-install.sh [版本号]   # 默认 0.1.3
set -euo pipefail

repo="llc2214926/pi-file-sidebar"
version="${1:-0.1.3}"
expected_pi="1.4.0"

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

for cmd in curl tar pi; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令：$cmd"
done
[[ "$(pi --version)" == "$expected_pi" ]] || fail "此扩展仅验证 Pi $expected_pi，当前为 $(pi --version)"

url="https://github.com/${repo}/releases/download/v${version}/pi-file-sidebar-${version}.tgz"
work=""
cleanup() { [[ -z "$work" ]] || rm -rf -- "$work"; }
trap cleanup EXIT

work=$(mktemp -d "${TMPDIR:-/tmp}/pi-file-sidebar.XXXXXX")
printf '下载 %s…\n' "$url"
curl -fsSL --retry 2 -o "$work/package.tgz" "$url" || fail "下载失败，请确认 Release v${version} 已存在该 tgz 附件"

mkdir -p "$work/pkg"
tar -xzf "$work/package.tgz" -C "$work/pkg" || fail "解包失败"
[[ -f "$work/pkg/package/package.json" ]] || fail "包结构不符合预期（缺少 package/package.json）"

printf '安装到 Pi…\n'
pi install "$work/pkg/package"
printf '完成。重启 Pi 或在会话内执行 /reload 生效。\n'
