import { OFFICIAL_PLUGINS, discoverOfficialPlugin } from "./core/official";
import type { CapabilityRegistry } from "./core/execution/registry";

/** 已发布命令清单与真实注册表逐项对照，不从命名猜测覆盖。 */
export function capabilityCoverage(registry: CapabilityRegistry) {
  const providers = OFFICIAL_PLUGINS.map((spec) => {
    const plugin = discoverOfficialPlugin(spec);
    const capabilities = registry
      .list()
      .filter((c) => c.provider.id === spec.command)
      .map((c) => registry.describe(c.id)!);
    const commands = (plugin.commands ?? []).map((command) => {
      const ids = capabilities
        .filter((c) =>
          c.commands?.some(
            (p) => JSON.stringify(p) === JSON.stringify(command.path),
          ),
        )
        .map((c) => c.id);
      return {
        command: command.path,
        capabilities: ids,
        covered: ids.length > 0,
      };
    });
    return {
      provider: spec.command,
      package: spec.package,
      version: plugin.version,
      state: plugin.status,
      commands,
      missing: commands.filter((c) => !c.covered).map((c) => c.command),
    };
  });
  return {
    ok: providers.every((p) => p.commands.length > 0 && p.missing.length === 0),
    providers,
  };
}
