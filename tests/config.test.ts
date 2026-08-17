import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config";

const dirs: string[] = [];
function tmpHome(): string {
  const dir = mkdtempSync(join(tmpdir(), "vcli-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("ConfigStore", () => {
  it("文件不存在时 get 返回空对象", () => {
    const store = ConfigStore.fromHome(tmpHome());
    expect(store.get()).toEqual({});
  });

  it("set 惰性创建目录与文件，读写回环", () => {
    const home = tmpHome();
    const store = ConfigStore.fromHome(home);
    store.set((cfg) => ({ ...cfg, theme: "dark" }));
    const file = join(home, "config.json");
    expect(existsSync(file)).toBe(true);
    expect(store.get()).toEqual({ theme: "dark" });
    // 文件内容本身也是合法 JSON
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ theme: "dark" });
  });

  it("损坏的 JSON 返回空对象而不是抛异常", () => {
    const home = tmpHome();
    const store = ConfigStore.fromHome(home);
    store.set((cfg) => ({ ...cfg, a: 1 }));
    writeFileSync(join(home, "config.json"), "{broken", "utf-8");
    expect(store.get()).toEqual({});
  });
});
