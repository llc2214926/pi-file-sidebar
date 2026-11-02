#!/usr/bin/env bash
# 远程安装 pi-file-sidebar 的“纯净版”：下载 Release tgz，直接覆盖 Pi 的 git 源安装目录，
# 只保留运行所需文件（extensions/ src/ package.json README LICENSE），不带 .git、scripts、tsconfig 等。
# 注册源固定为 git:github.com/llc2214926/pi-file-sidebar，settings 由 pi install 写入。
# 用法：curl -fsSL <raw-url>/scripts/remote-install.sh | bash
# 可选参数：版本号（默认 0.1.3）
# 注意：此目录被覆盖后不含 .git，`pi update` 对该包会失效；升级请重新执行本脚本。
set -euo pipefail

repo="llc2214926/pi-file-sidebar"
git_source="git:github.com/llc2214926/pi-file-sidebar"
version="${1:-0.1.3}"
expected_pi="1.4.0"

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }

for cmd in curl tar node pi; do
  command -v "$cmd" >/dev/null 2>&1 || fail "缺少命令：$cmd"
done
[[ "$(pi --version)" == "$expected_pi" ]] || fail "此扩展仅验证 Pi $expected_pi，当前为 $(pi --version)"

# 与 Pi CLI 使用同一配置目录
agent_dir=$(node - <<'NODE'
const os = require("node:os"), path = require("node:path");
const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
if (/[\x00-\x1f\x7f]/.test(dir)) throw new Error("Pi 目录不能包含控制字符");
process.stdout.write(path.resolve(dir.replace(/^~(?=\/|$)/, os.homedir())));
NODE
)
export PI_CODING_AGENT_DIR="$agent_dir"
target="$agent_dir/git/github.com/llc2214926/pi-file-sidebar"
[[ ! -L "$agent_dir/git" && ! -L "$target" ]] || fail "安装目录不能是符号链接"

url="https://github.com/${repo}/releases/download/v${version}/pi-file-sidebar-${version}.tgz"
work=""
cleanup() { [[ -z "$work" ]] || rm -rf -- "$work"; }
trap cleanup EXIT

work=$(mktemp -d "${TMPDIR:-/tmp}/pi-file-sidebar.XXXXXX")
printf '下载 %s…\n' "$url"
curl -fsSL --retry 2 -o "$work/package.tgz" "$url" || fail "下载失败，请确认 Release v${version} 已上传该 tgz 附件"

mkdir -p -- "$work/pkg"
tar -xzf "$work/package.tgz" -C "$work/pkg" || fail "解包失败"
[[ -f "$work/pkg/package/package.json" ]] || fail "包结构不符合预期（缺少 package/package.json）"
node - "$work/pkg/package" "$version" <<'NODE' || fail "包内容校验失败"
const fs = require("node:fs"), path = require("node:path");
const [root, version] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (pkg.name !== "pi-file-sidebar" || pkg.version !== version) throw new Error("包名或版本不符");
for (const f of ["extensions/index.ts", "src/sidebar.ts", "LICENSE", "README.md"]) {
  if (!fs.existsSync(path.join(root, f))) throw new Error(`缺少 ${f}`);
}
NODE

# 注册包（幂等）。若目标目录是已覆盖过的纯净目录（无 .git），pi install 的
# update 路径会失败，所以先清掉旧目录让它走全新克隆。
printf '注册 %s…\n' "$git_source"
if [[ -e "$target" && ! -d "$target/.git" ]]; then
  rm -rf -- "$target"
fi
pi install "$git_source"

# 原子替换：旧目录挪到临时位置，纯净包就位，再删除旧目录
printf '以纯净包覆盖 %s…\n' "$target"
mkdir -p -- "$(dirname -- "$target")"
backup="$work/old"
rm -rf -- "$backup"
if [[ -e "$target" ]]; then
  mv -- "$target" "$backup"
fi
if mv -- "$work/pkg/package" "$target"; then
  rm -rf -- "$backup"
else
  # 恢复现场，避免留下空目录
  if [[ -e "$backup" && ! -e "$target" ]]; then mv -- "$backup" "$target"; fi
  fail "覆盖失败"
fi

printf '完成（已安装 %s，目录仅含运行所需文件）。\n' "$version"
printf '重启 Pi 或在会话内执行 /reload 生效；后续升级请重新运行本脚本（该目录无 .git，pi update 不适用）。\n'
