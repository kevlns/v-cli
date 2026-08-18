#!/usr/bin/env node
// 测试 fixture：回显 argv 与 v-cli 注入环境（供 runner / 集成测试断言）。
// - 载荷写入 V_CLI_TEST_OUTPUT_FILE（JSON：{ argv, env }）
// - env 只摘取 v-cli 注入的三个键（runner 测试断言精确相等）
// - --exit-42 → 退出码 42（退出码原样传播测试）
import fs from "node:fs";

const payload = {
  argv: process.argv.slice(2),
  env: {
    V_CLI_HOST_VERSION: process.env.V_CLI_HOST_VERSION,
    V_CLI_PLUGIN_API: process.env.V_CLI_PLUGIN_API,
    V_CLI_INVOKED_BY: process.env.V_CLI_INVOKED_BY,
  },
};
if (process.env.V_CLI_TEST_OUTPUT_FILE) {
  fs.writeFileSync(process.env.V_CLI_TEST_OUTPUT_FILE, JSON.stringify(payload), "utf-8");
}
if (payload.argv.includes("--exit-42")) process.exit(42);