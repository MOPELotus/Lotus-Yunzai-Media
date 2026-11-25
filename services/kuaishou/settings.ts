import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { createPublicShareSettings } from "../public-share/settings.ts"

export const kuaishouFields = [["enable", $t("services.kuaishou.settings.text_fa7744e684")], ["private", $t("services.kuaishou.settings.text_d9df9cd7c9")]] as const

export function createKuaishouSettings(directory?: string, root?: string) {
  return createPublicShareSettings("kuaishou", $t("services.kuaishou.settings.text_b210af9eae"), directory, root)
}
