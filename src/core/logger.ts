/** 双通道 logger：结果走 stdout（可管道），诊断/警告走 stderr */
export class Logger {
  constructor(private jsonMode = false) {}

  /** 命令结果输出：--json 时输出结构化 JSON，否则原样输出 */
  result(data: unknown): void {
    if (this.jsonMode) {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    } else if (typeof data === "string") {
      process.stdout.write(data + "\n");
    } else {
      process.stdout.write(JSON.stringify(data, null, 2) + "\n");
    }
  }

  info(msg: string): void {
    process.stderr.write(`[vcli] ${msg}\n`);
  }

  warn(msg: string): void {
    process.stderr.write(`[vcli] 警告: ${msg}\n`);
  }

  error(msg: string): void {
    process.stderr.write(`[vcli] 错误: ${msg}\n`);
  }
}