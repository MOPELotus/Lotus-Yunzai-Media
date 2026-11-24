import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadGlobalConfig } from "../../core/config/global.ts";
import { ToolInstallerService, type ToolsConfig } from "./installer.ts";
import { TuneWeaveService } from "../tuneweave/service.ts";
import type { TaskProgressHandler } from "../progress.ts";

/** Only explicit environment initialization installs or updates binaries. */
export async function prepareMediaEnvironment(root: URL, signal: AbortSignal, onTaskProgress?: TaskProgressHandler) {
  const config = await loadGlobalConfig(root);
  const tools = config.tools as ToolsConfig;
  const directory = fileURLToPath(root);
  const checked = await new ToolInstallerService({ config: { ...tools,
    dir: resolve(directory, tools.dir || "data/tools"), bin_dir: resolve(directory, tools.bin_dir || "data/tools/bin") },
  }).ensureAll({ signal, onTaskProgress });
  if (!checked.ok) throw new Error(checked.items.filter(item => !item.ok).map(item => item.reason).join("；"));
  signal.throwIfAborted();
  const tune = new TuneWeaveService({ root: resolve(directory, "data/tuneweave"), config: config.tuneweave });
  const result = await tune.initialize({ signal, platform: "netease", onTaskProgress });
  if (!result.ok) throw new Error(result.message || "TuneWeave 初始化未完成");
}
