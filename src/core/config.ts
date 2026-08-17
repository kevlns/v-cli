import fs from "node:fs";
import path from "node:path";

/** 用户级配置读写（<home>/config.json），惰性创建 */
export class ConfigStore {
  constructor(private readonly file: string) {}

  static fromHome(homeDir: string): ConfigStore {
    return new ConfigStore(path.join(homeDir, "config.json"));
  }

  get(): Record<string, unknown> {
    try {
      return JSON.parse(fs.readFileSync(this.file, "utf-8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  set(updater: (cfg: Record<string, unknown>) => Record<string, unknown>): Record<string, unknown> {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const cfg = updater(this.get());
    fs.writeFileSync(this.file, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
    return cfg;
  }
}