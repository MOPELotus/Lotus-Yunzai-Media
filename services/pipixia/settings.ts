import { createTranslator as createTextTranslator } from "../../../../packages/i18n/index.ts";
import messageCatalog from "../../i18n/zh-CN.json";
const $t = createTextTranslator("media", messageCatalog.messages);
import { createPublicShareSettings, type PublicShareSettings } from "../public-share/settings.ts"

export const pipixiaFields = [["enable", $t("services.pipixia.settings.text_14fd0bb041")], ["private", $t("services.pipixia.settings.text_30e7012fb6")]] as const
export type PipixiaSettings = PublicShareSettings

export function createPipixiaSettings(directory?: string, root?: string) {
  return createPublicShareSettings("pipixia", $t("services.pipixia.settings.text_13618d1860"), directory, root)
}
