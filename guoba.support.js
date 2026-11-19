import { lockFile } from "../../lib/file-lock.ts"
import { dataPath } from "./core/path.js"
import { createSubscriptionConfig } from "./services/subscriptions/config.js"

const fields = [
  { key: "pushMsgMode", setting: "picture", label: "B站推送消息模式", options: ["文字模式", "图片模式"] },
  { key: "mergeTextPic", setting: "merge", label: "文字图片合并发送", options: ["分开发送", "合并发送"],
    help: "仅在文字模式下生效。" },
  { key: "forwardSendDynamic", setting: "mergeForward", label: "合并转发动态", options: ["关闭", "开启"],
    help: "同一会话本次待推送的图片总数或文字总长度超过阈值时使用合并转发。" },
  { key: "maxPicsForSingleMsg", setting: "forwardPictureThreshold", label: "图片总数阈值", max: 100 },
  { key: "maxTextLengthForSingleMsg", setting: "forwardTextThreshold", label: "文字总长度阈值", max: 50_000 },
]

export function supportGuoba(directory = dataPath) {
  const config = createSubscriptionConfig(directory, lockFile)
  return {
    pluginInfo: { name: "media", title: "媒体", isV3: true, isV2: false },
    configInfo: {
      schemas: [
        { component: "SOFT_GROUP_BEGIN", label: "B站动态推送" },
        ...fields.map(({ key, label, options, max, help }) => ({
          field: `bilibili.${key}`,
          label,
          bottomHelpMessage: help,
          component: options ? "Select" : "InputNumber",
          componentProps: options ? { options: options.map((label, value) => ({ label, value })) } : { min: 0, max, step: 1 },
        })),
      ],
      async getConfigData() {
        const settings = await config.settings("bilibili")
        return { bilibili: Object.fromEntries(fields.map(({ key, setting }) => [key, Number(settings[setting])])) }
      },
      async setConfigData(values, { Result }) {
        const selected = []
        for (const field of fields) {
          const name = `bilibili.${field.key}`
          if (!Object.hasOwn(values, name)) continue
          const value = values[name]
          const number = typeof value === "string" && value.trim() ? Number(value) : value
          if (!Number.isSafeInteger(number) || number < 0 || number > (field.max ?? 1)) {
            return Result.error("请填写有效的 B 站动态推送设置。", 422)
          }
          selected.push({ ...field, number })
        }
        await config.editSettings("bilibili", (settings) => Object.fromEntries(selected
          .filter(({ setting, number }) => Number(settings[setting]) !== number)
          .map(({ key, number }) => [key, number])))
        return Result.ok()
      },
    },
  }
}
