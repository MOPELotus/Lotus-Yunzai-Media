import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { registerLanguage, setLanguage } from "../../../packages/i18n/index.ts";
import chinese from "../i18n/zh-CN.json";
registerLanguage("en", { media: Object.fromEntries(Object.keys(chinese.messages).map(key => [key, "rewritten"])) });
setLanguage("en");
const root = await mkdtemp(join(tmpdir(), "media-i18n-"));
try {
  await mkdir(join(root, "plugins/rconsole-plugin/config"), { recursive: true });
  await writeFile(join(root, "plugins/rconsole-plugin/config/tools.yaml"), "globalBlackList: [小红书]\n");
  const { loadPublicShareConfig, publicShareSiteNames } = await import("../core/config/global.ts");
  const { MUSIC_QR_TYPES } = await import("../services/music/service.ts");
  const { biliTypes, biliTypesLabels } = await import("../services/subscriptions/bilibili/index.ts");
  console.log(JSON.stringify({ enabled: (await loadPublicShareConfig("xhs", pathToFileURL(root + "/"))).enable, site: publicShareSiteNames.xhs,
    qrType: MUSIC_QR_TYPES.qq[1]!.type, qrName: MUSIC_QR_TYPES.qq[1]!.name, commandLabel: biliTypes.DYNAMIC_TYPE_AV, displayLabel: biliTypesLabels.DYNAMIC_TYPE_AV }));
} finally { await rm(root, { recursive: true, force: true }); }
