# SDK 项目代码根与数据根

`PROJECT_STORAGE_ROOT_VERSION === 1` 表示 SDK 支持独立代码根和数据根。
宿主应先检查该标志，再传入双根；旧 SDK 无法满足这一合同，不能静默丢弃 `storageRoot`。

```ts
const anchor = resolveProjectRoot(devCheckout, undefined, { storageRoot: projectDirectory });
initProjectConfig(anchor, providers, bindings);
const loaded = loadProjectConfig(anchor, providers);
const result = await runCapability(registry, {
  capabilityId,
  projectRoot: devCheckout,
  storageRoot: projectDirectory,
  operationId,
  input,
});
```

`root` / `realRoot` 始终是当前业务 checkout。`storageRoot` / `realStorageRoot`
只承载宿主管理的 `.vant` 数据。两者都必须是已有目录，并分别取得 realpath 锚点。
省略数据根时，两个根相同。

`resolveInsideProject` 对普通业务路径使用代码根；`.vant` 及其子路径使用数据根，
其中 `.vant/rules.md` 和 `.vant/rules/` 是代码输入，仍使用代码根。
绝对路径、穿越路径和逃逸锚点的符号链接仍被拒绝。

配置、配置备份、操作记录、默认 `.vant/art` 和视频数据因此持续位于数据根。
`art.workspace` / `output` / `cache` 若配置为 `Arts` 等业务路径，则解析到当前 checkout；
输入、计划、导出路径也按同一规则解析。后端进程的 cwd 始终是代码根。

新操作的 input、result 和 handle 都记录原始 `codeRoot` 与 `storageRoot`。
句柄校验从当前数据根读取原操作证据，核对存储身份和原句柄身份，并返回 `originProject`。
历史单根句柄以原 `project.root` 作为其存储身份；恢复不会重写原代码根，
也不会让当前调用获得原 checkout 的业务文件路径。
另一个数据根不能恢复该句柄。未知操作仍占用原 operationId，不会通过换根重放。

双根解析是路径路由合同，宿主仍须独立落实文件访问授权。
SDK 路径选择不会扩大 DSH 原生会话的读写权限。
