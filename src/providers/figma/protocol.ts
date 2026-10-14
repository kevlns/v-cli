/**
 * figma-to-uprefab CLI 输出解释层（保守、只认证据）。
 *
 * 协议解释见 docs/provider-protocols.md，字段依据真实工具输出与协议测试。
 * - `contract`：stdout 文本。正例一行 `Contract valid: N root(s).`（exit 0）；
 *   反例逐行 `contract: <CON_x> @ <path>: <message>`（exit 1）。
 * - `doctor`：stdout 逐行 `[ok]   name: message` / `[FAIL] name: message`（exit 0=全 ok，1=有 FAIL）。
 * - 工具级错误：stderr 行 `[figma-to-uprefab] <CODE>: <message>`（CFG_/SCH_/PAT_ 等机器码族）。
 *
 * 无法解释的形态（无有效行、无 issue、无工具码）不通过（unknown），不编造字段；
 * issue 消息的物理续行并入上一条 issue（消息完整进入证据）。
 */

export interface ContractIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ContractOutput {
  /** `Contract valid: N root(s).` 命中时的 N */
  validRoots: number | null;
  issues: ContractIssue[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  message: string;
}

export interface ToolError {
  code: string;
  message: string;
}

/** 工具输出统一带 `[figma-to-uprefab] ` 前缀（log() 形态） */
const VALID_LINE = /^(?:\[figma-to-uprefab\] )?Contract valid: (\d+) root\(s\)\.$/;
const ISSUE_LINE = /^(?:\[figma-to-uprefab\] )?contract: ([A-Z_]+)(?: @ (.+?))?: (.*)$/;
const DOCTOR_LINE = /^(?:\[figma-to-uprefab\] )?\[(ok|FAIL)\]\s+(.+?): (.*)$/;
const TOOL_ERROR_LINE = /^\[figma-to-uprefab\] ([A-Z_]+): (.*)$/;

/**
 * 解析 contract 输出。真实分流（2026-10-12 实测）：`Contract valid: N root(s).`
 * 走 stdout（log），issue 行走 stderr（logError）——按流各司其职，不合并。
 * 不匹配的行忽略并计数，供调用方判断协议完整性。
 */
export function parseContractOutput(stdout: string, stderr: string): ContractOutput & { unrecognized: number } {
  let validRoots: number | null = null;
  const issues: ContractIssue[] = [];
  let unrecognized = 0;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const valid = VALID_LINE.exec(line);
    if (valid) {
      validRoots = Number(valid[1]);
      continue;
    }
    unrecognized += 1;
  }
  for (const rawLine of stderr.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const issue = ISSUE_LINE.exec(line);
    if (issue) {
      issues.push({ code: issue[1]!, message: issue[3]!, ...(issue[2] ? { path: issue[2] } : {}) });
      continue;
    }
    if (TOOL_ERROR_LINE.test(line)) continue; // 工具级 CFG 等机器码行由 parseToolError 负责
    // issue 消息内嵌真实换行（如 SyntaxError 引用文件内容）时，续行并入上一条 issue
    if (issues.length > 0 && !VALID_LINE.test(line)) {
      issues[issues.length - 1]!.message += `
${line}`;
      continue;
    }
    unrecognized += 1;
  }
  return { validRoots, issues, unrecognized };
}

/** 解析 doctor 输出（[ok]/[FAIL] 行） */
export function parseDoctorOutput(stdout: string): { checks: DoctorCheck[]; unrecognized: number } {
  const checks: DoctorCheck[] = [];
  let unrecognized = 0;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const match = DOCTOR_LINE.exec(line);
    if (match) {
      checks.push({ name: match[2]!, ok: match[1] === "ok", message: match[3]! });
      continue;
    }
    unrecognized += 1;
  }
  return { checks, unrecognized };
}

/** 从 stderr 提取工具级机器码错误（CFG_/SCH_/PAT_ 等码族）；无则 null */
export function parseToolError(stderr: string): ToolError | null {
  for (const rawLine of stderr.split(/\r?\n/)) {
    const match = TOOL_ERROR_LINE.exec(rawLine.trim());
    if (match) return { code: match[1]!, message: match[2]! };
  }
  return null;
}
