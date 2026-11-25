import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { createPublicShareSettings } from "../public-share/settings.ts"

export const jikeFields = [["enable", $t("services.jike.settings.text_d952813c1e")], ["private", $t("services.jike.settings.text_e8f6140553")]] as const

export function createJikeSettings(directory?: string, root?: string) {
  return createPublicShareSettings("jike", $t("services.jike.settings.text_61528bef0f"), directory, root)
}
