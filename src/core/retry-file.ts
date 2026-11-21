// Copyright © 2026 Vant <sl_kevln@163.com>
export async function retryFile<T>(action: () => T): Promise<T> {
  const deadline = Date.now() + 3000;
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (
        !["EPERM", "EBUSY", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        ) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
}
