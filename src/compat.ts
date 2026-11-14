// 最低版本为 >=1.5.0，不设上限；与安装脚本一致，仅接受正式 SemVer（允许构建元数据）。
// 版本通过不替代 host.ts 中的原生布局和焦点能力检查。
export function isSupportedPiVersion(version: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match || match[0] !== version) return false;
  const major = BigInt(match[1]!), minor = BigInt(match[2]!);
  return major > 1n || (major === 1n && minor >= 5n);
}
