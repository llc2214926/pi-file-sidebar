#!/usr/bin/env bash
# 本地发布并安装；不会上传 npm、提交代码或自动重载 Pi。
set -euo pipefail

fail() { printf '错误：%s\n' "$*" >&2; exit 1; }
usage() {
  printf '用法：%s [--pack-only]\n' "${0##*/}"
  printf '默认校验、打包并安装到 Pi；--pack-only 仅生成版本包。\n'
}
pack_only=false
case "${1:-}" in
  "") ;;
  --pack-only) pack_only=true ;;
  -h|--help) usage; exit 0 ;;
  *) usage >&2; exit 2 ;;
esac
[[ $# -le 1 ]] || { usage >&2; exit 2; }

repo=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
cd -- "$repo"
for command in node npm tar diff cmp; do
  command -v "$command" >/dev/null || fail "缺少命令：$command"
done
version=$(node - <<'NODE'
const pkg = require("./package.json");
if (pkg.name !== "pi-file-sidebar" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(pkg.version)) {
  throw new Error("包名或版本号不合法");
}
process.stdout.write(pkg.version);
NODE
)
if ! $pack_only; then
  command -v pi >/dev/null || fail "未找到 pi，请先安装 Pi >=1.4.0 正式版"
  pi_version=$(pi --version) || fail "无法读取 Pi 版本"
  node --input-type=module - "$pi_version" <<'NODE' || fail "需要 Pi >=1.4.0 正式版，当前为 $pi_version"
import { isSupportedPiVersion } from "./src/compat.ts";
process.exit(isSupportedPiVersion(process.argv[2]) ? 0 : 1);
NODE
fi

work=""
stage=""
lock=""
cleanup() {
  local status=$?
  [[ -z "$stage" ]] || rm -rf -- "$stage"
  [[ -z "$work" ]] || rm -rf -- "$work"
  [[ -z "$lock" ]] || rmdir -- "$lock" || true
  return "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '校验 pi-file-sidebar %s…\n' "$version"
npm run typecheck
output="$repo/artifacts/releases/$version"
mkdir -p -- "$output"
work=$(mktemp -d "$output/.pack.XXXXXX")
# 使用仓库内缓存，避免改变用户 npm 缓存权限；不执行 npm 生命周期脚本。
npm --cache "$repo/artifacts/npm-cache" pack --ignore-scripts --pack-destination "$work" --json > "$work/pack.json"
filename=$(node - "$work/pack.json" "$version" <<'NODE'
const fs = require("node:fs");
const [file, version] = process.argv.slice(2);
const [pkg, ...extra] = JSON.parse(fs.readFileSync(file, "utf8"));
if (!pkg || extra.length || pkg.name !== "pi-file-sidebar" || pkg.version !== version || pkg.filename !== `pi-file-sidebar-${version}.tgz`) {
  throw new Error("npm pack 返回了非预期的版本包");
}
const paths = pkg.files.map((file) => file.path);
for (const path of paths) {
  if (path.split("/").some((part) => !part || part === "." || part === "..") ||
      !(["package.json", "README.md", "README.ZH.md", "LICENSE"].includes(path) || path.startsWith("src/") || path.startsWith("extensions/"))) {
    throw new Error(`发布文件超出白名单：${path}`);
  }
}
for (const required of ["package.json", "README.md", "README.ZH.md", "LICENSE", "extensions/index.ts"]) {
  if (!paths.includes(required)) throw new Error(`版本包缺少 ${required}`);
}
process.stdout.write(pkg.filename);
NODE
)
mkdir -- "$work/package"
tar -xzf "$work/$filename" -C "$work/package" --strip-components=1
cmp package.json "$work/package/package.json"
cmp README.md "$work/package/README.md"
cmp README.ZH.md "$work/package/README.ZH.md"
cmp LICENSE "$work/package/LICENSE"
diff -qr src "$work/package/src"
diff -qr extensions "$work/package/extensions"
archive="$output/$filename"
cp -- "$work/$filename" "$archive"
cp -- "$work/pack.json" "$output/pack.json"
printf '版本包：%s\n' "$archive"
if $pack_only; then
  printf '仅打包完成，未修改 Pi 安装或设置。\n'
  exit 0
fi

agent_dir=$(node - <<'NODE'
const os = require("node:os"), path = require("node:path");
const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
if (/[\x00-\x1f\x7f]/.test(dir)) throw new Error("Pi 目录不能包含控制字符");
process.stdout.write(path.resolve(dir.replace(/^~(?=\/|$)/, os.homedir())));
NODE
)
# 与 Pi CLI 使用同一个配置目录；只读解析设置，所有注册修改仍走 pi 命令。
export PI_CODING_AGENT_DIR="$agent_dir"
base="$agent_dir/local-packages/pi-file-sidebar"
target="$base/$version"
[[ ! -L "$base" && ! -L "$target" ]] || fail "安装目录不能是符号链接"
mkdir -p -- "$base"
if ! mkdir -- "$base/.publish-install.lock"; then
  fail "无法取得发布锁；请检查目录权限或其他发布进程，不要强制删除活动锁"
fi
lock="$base/.publish-install.lock"

registration() {
  node - "$agent_dir" "$base" "$target" "$1" <<'NODE'
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const [agent, base, target, mode] = process.argv.slice(2);
const settingsFile = path.join(agent, "settings.json");
const settings = fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {};
const packages = settings.packages ?? [];
if (!Array.isArray(packages)) throw new Error("全局 packages 不是数组");
const managed = [];
for (const entry of packages) {
  const source = typeof entry === "string" ? entry : entry?.source;
  if (typeof source !== "string") throw new Error("全局 packages 项格式不合法");
  const resolved = path.resolve(agent, source.replace(/^~(?=\/|$)/, os.homedir()));
  if (path.dirname(resolved) !== base || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(path.basename(resolved))) continue;
  if (typeof entry !== "string") throw new Error("侧栏有自定义资源过滤，请手动切换版本以保留过滤设置");
  managed.push(resolved);
}
if (mode === "old") {
  for (const source of new Set(managed)) if (source !== target) console.log(source);
} else {
  if (!managed.includes(target)) throw new Error("Pi 未实际保存新版注册；旧版不会因此被移除");
  if (mode === "final" && managed.some((source) => source !== target)) throw new Error("仍有旧版本注册，请勿重载 Pi；处理后重试脚本");
}
NODE
}
registration old > "$work/old-sources"
if [[ -e "$target" ]]; then
  [[ -d "$target" ]] || fail "同版本目标不是目录：$target"
  diff -qr "$work/package" "$target" || fail "同版本内容不一致，拒绝覆盖；请先提升 package.json 版本号"
  printf '同版本内容一致，复用：%s\n' "$target"
else
  stage=$(mktemp -d "$base/.stage-$version.XXXXXX")
  cp -R -- "$work/package/." "$stage/"
  # rename 不会把 stage 意外移入已存在的目标目录。
  node - "$stage" "$target" <<'NODE'
const fs = require("node:fs");
const [stage, target] = process.argv.slice(2);
if (fs.existsSync(target)) throw new Error("目标目录已出现，拒绝覆盖");
fs.renameSync(stage, target);
NODE
  stage=""
fi

if ! pi install "$target" --no-approve; then
  fail "新版注册失败，旧版注册未移除；检查权限后可重试，安装文件保留"
fi
registration new
while IFS= read -r old; do
  [[ -n "$old" ]] || continue
  if ! pi remove "$old" --no-approve; then
    fail "新版已注册，但旧版注册清理失败；请勿重载 Pi，处理后重试脚本：$old"
  fi
done < "$work/old-sources"
registration final
printf '发布并安装完成：%s\n' "$target"
printf '旧版本文件保留。请在 Pi 执行 /reload 或重启；脚本不会自动重载。\n'
