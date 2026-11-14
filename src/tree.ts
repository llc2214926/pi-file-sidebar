import type { Dirent } from "node:fs";
import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export type NodeKind = "directory" | "file" | "symlink" | "other";
export interface TreeNode {
  path: string;
  name: string;
  kind: NodeKind;
  state: "unloaded" | "loading" | "loaded" | "error";
  children: string[];
  error?: { code?: string };
}
export interface TreeRow { node: Readonly<TreeNode>; depth: number }
type Reader = (path: string) => Promise<Dirent[]>;

export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export function displayText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,
    (char) => `\\u{${char.codePointAt(0)!.toString(16)}}`);
}
async function readDirectory(root: string, path: string): Promise<Dirent[]> {
  const rootPath = resolve(root), child = relative(rootPath, path);
  let current = rootPath;
  for (const part of child.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Object.assign(new Error("目录链接"), { code: "ELOOP" });
  }
  const actualRoot = await realpath(rootPath), actual = await realpath(path);
  if (!isWithin(actualRoot, actual) || actual !== resolve(actualRoot, child)) throw Object.assign(new Error("目录路径已变化"), { code: "ELOOP" });
  return readdir(actual, { withFileTypes: true });
}

export class FileTree {
  readonly root: string;
  readonly expanded = new Set<string>();
  private nodes = new Map<string, TreeNode>();
  private flights = new Map<string, Promise<void>>();
  private dirty = new Set<string>();
  private timer?: NodeJS.Timeout;
  private cachedRows?: TreeRow[];
  private active = false;
  private disposed = false;
  private generation = 0;
  private current: string;
  private hidden = false;
  revision = 0;
  reads = 0;

  constructor(root: string, private onChange: (reveal: boolean) => void, private read: Reader = (path) => readDirectory(root, path)) {
    this.root = resolve(root); this.current = this.root; this.expanded.add(this.root);
    this.nodes.set(this.root, { path: this.root, name: basename(this.root) || this.root, kind: "directory", state: "unloaded", children: [] });
  }
  get selected() { return this.current; }
  get showHidden() { return this.hidden; }
  get pending() { return this.flights.size + (this.timer ? 1 : 0); }
  get dirtyCount() { return this.dirty.size; }
  get size() { return this.nodes.size; }
  node(path = this.current): Readonly<TreeNode> | undefined { return this.nodes.get(path); }

  rows(): readonly TreeRow[] {
    if (this.cachedRows) return this.cachedRows;
    const result: TreeRow[] = [], stack = [{ path: this.root, depth: 0 }];
    while (stack.length) {
      const { path, depth } = stack.pop()!, node = this.nodes.get(path);
      if (!node) continue;
      if (path !== this.root && !this.hidden && (node.name.startsWith(".") || node.name === "node_modules")) continue;
      result.push({ node, depth });
      if (node.kind === "directory" && this.expanded.has(path)) {
        for (let i = node.children.length - 1; i >= 0; i--) stack.push({ path: node.children[i]!, depth: depth + 1 });
      }
    }
    return this.cachedRows = result;
  }
  private changed(reveal = false, structure = true) {
    if (this.disposed) return;
    if (structure) this.cachedRows = undefined;
    this.revision++; this.onChange(reveal);
  }
  select(path: string): boolean {
    if (this.disposed || !this.rows().some((row) => row.node.path === path)) return false;
    if (path !== this.current) { this.current = path; this.changed(true, false); }
    return true;
  }
  move(delta: number) {
    const rows = this.rows(), index = Math.max(0, rows.findIndex((row) => row.node.path === this.current));
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    if (next) this.select(next.node.path);
  }
  async expand(path = this.current) {
    if (this.nodes.get(path)?.kind !== "directory" || this.disposed || !this.rows().some((row) => row.node.path === path)) return;
    if (!this.expanded.has(path)) { this.expanded.add(path); this.changed(); }
    await this.load(path);
    this.resumeLoads();
  }
  collapse(path = this.current) {
    if (this.expanded.delete(path)) {
      const reveal = this.current !== path && isWithin(path, this.current);
      if (reveal) this.current = path;
      this.changed(reveal);
    } else this.select(dirname(path));
  }
  async toggle(path = this.current) {
    if (this.nodes.get(path)?.kind !== "directory") return;
    if (this.expanded.has(path)) this.collapse(path); else await this.expand(path);
  }
  toggleHidden() {
    this.hidden = !this.hidden; this.cachedRows = undefined;
    const visible = new Set(this.rows().map((row) => row.node.path));
    const previous = this.current;
    while (!visible.has(this.current) && this.current !== this.root) this.current = dirname(this.current);
    this.changed(this.current !== previous);
    this.resumeLoads();
  }
  setActive(active: boolean) {
    if (this.disposed || this.active === active) return;
    this.active = active;
    if (!active && this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (active) this.resumeLoads();
  }
  loadedDirectories(): string[] {
    return [...this.nodes.values()].filter((node) => node.kind === "directory" && node.state !== "unloaded").map((node) => node.path);
  }
  private resumeLoads() {
    if (!this.active || this.disposed) return;
    for (const { node } of this.rows()) if (node.kind === "directory" && this.expanded.has(node.path)) void this.load(node.path);
  }
  markDirty(paths: readonly string[] = this.loadedDirectories()) {
    if (this.disposed) return;
    for (const source of paths) {
      let path = resolve(this.root, source);
      // write 可以新建多层父目录；向上找到已加载的目录，之后仍由可见性决定是否读取。
      while (isWithin(this.root, path)) {
        const node = this.nodes.get(path);
        if (node?.kind === "directory" && node.state !== "unloaded") { this.dirty.add(path); break; }
        if (path === this.root) break;
        path = dirname(path);
      }
    }
    this.schedule();
  }
  private schedule() {
    if (this.disposed || !this.active || !this.dirty.size || this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.flush(); }, 40).unref();
  }
  private async flush() {
    if (this.disposed || !this.active) return;
    const visible = new Set(this.rows().map((row) => row.node.path));
    await Promise.all([...this.dirty].filter((path) => this.expanded.has(path) && visible.has(path)).map((path) => this.load(path)));
  }
  async refresh(paths: readonly string[] = this.loadedDirectories()) {
    this.markDirty(paths);
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    await this.flush();
  }
  private removeBranch(path: string) {
    const stack = [path];
    while (stack.length) {
      const current = stack.pop()!, node = this.nodes.get(current);
      if (node) stack.push(...node.children);
      this.nodes.delete(current); this.expanded.delete(current); this.dirty.delete(current);
    }
  }
  private load(path: string): Promise<void> {
    const node = this.nodes.get(path);
    if (!this.active || this.disposed || node?.kind !== "directory") return Promise.resolve();
    if (this.flights.has(path)) {
      if (node.state === "unloaded") this.dirty.add(path);
      return this.flights.get(path)!;
    }
    if ((node.state === "loaded" || node.state === "error") && !this.dirty.has(path)) return Promise.resolve();
    this.dirty.delete(path); node.state = "loading"; node.error = undefined; this.changed();
    const generation = this.generation;
    this.reads++;
    const promise = Promise.resolve().then(() => this.read(path)).then((entries) => {
      if (this.disposed || generation !== this.generation || this.nodes.get(path) !== node) return;
      const previousIndex = this.rows().findIndex((row) => row.node.path === this.current);
      const children = entries.map((entry) => {
        const childPath = resolve(path, entry.name);
        const kind: NodeKind = entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other";
        let child = this.nodes.get(childPath);
        if (!child || child.kind !== kind) {
          if (child) this.removeBranch(childPath);
          child = { path: childPath, name: entry.name, kind, state: "unloaded", children: [] };
          this.nodes.set(childPath, child);
        }
        return child;
      }).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.name.localeCompare(b.name));
      const paths = new Set(children.map((child) => child.path));
      for (const old of node.children) if (!paths.has(old)) this.removeBranch(old);
      node.children = children.map((child) => child.path); node.state = "loaded";
      this.cachedRows = undefined;
      const rows = this.rows(), previous = this.current;
      if (!rows.some((row) => row.node.path === this.current)) this.current = rows[Math.max(0, Math.min(rows.length - 1, previousIndex))]?.node.path ?? this.root;
      this.changed(this.current !== previous);
    }, (error: unknown) => {
      if (this.disposed || generation !== this.generation || this.nodes.get(path) !== node) return;
      const code = (error as NodeJS.ErrnoException)?.code;
      node.state = "error"; node.error = { code: typeof code === "string" ? code : undefined }; this.changed();
    }).finally(() => {
      if (this.flights.get(path) === promise) this.flights.delete(path);
      if (!this.disposed && this.active && this.dirty.has(path)) this.schedule();
    });
    this.flights.set(path, promise);
    return promise;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.active = false; this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.dirty.clear(); this.flights.clear(); this.nodes.clear(); this.expanded.clear(); this.cachedRows = [];
  }
}
