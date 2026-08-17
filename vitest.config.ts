import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // forks 池在真实子进程中跑测试，动态 import 外部 .mjs 插件与运行时行为一致
    pool: "forks",
  },
});
