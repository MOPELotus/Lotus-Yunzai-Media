import { Job } from "node-schedule"
import { lockFile } from "../../lib/file-lock.ts"
import { dataPath } from "./core/path.js"
import { createSubscriptionConfig } from "./services/subscriptions/config.js"

const sharedFields = [
  { key: "pushMsgMode", setting: "picture", label: "推送消息模式", options: ["文字模式", "图片模式"] },
  { key: "mergeTextPic", setting: "merge", label: "文字图片合并发送", options: ["分开发送", "合并发送"],
    help: "仅在文字模式下生效。" },
  { key: "forwardSendDynamic", setting: "mergeForward", label: "合并转发动态", options: ["关闭", "开启"],
    help: "同一会话本次待推送的图片总数或文字总长度超过阈值时使用合并转发。" },
  { key: "maxPicsForSingleMsg", setting: "forwardPictureThreshold", label: "图片总数阈值", max: 100 },
  { key: "maxTextLengthForSingleMsg", setting: "forwardTextThreshold", label: "文字总长度阈值", max: 50_000 },
  { key: "pushStatus", setting: "enable", label: "定时推送", options: ["关闭", "开启"],
    help: "重启后生效。机器人主人仍可手动执行任务。" },
  { key: "checkDynamicCD", setting: "cron", label: "定时推送周期", component: "EasyCron",
    help: "支持五段或六段 Cron 表达式，按北京时间执行，重启后生效。" },
  { key: "pushTransmit", setting: "forwards", label: "推送转发动态", options: ["关闭", "开启"],
    help: "关闭后，此平台的所有订阅都跳过转发动态。" },
  { key: "dynamicTimeRange", setting: "horizon", label: "动态时间范围（秒）", min: 1, max: 259_200,
    help: "只推送此时间范围内发布的动态。" },
  { key: "banWords", setting: "blacklist", label: "屏蔽关键词", tags: true,
    help: "每行一个关键词。正文或标题包含关键词时跳过推送。" },
  { key: "isSplit", setting: "split", label: "分片截图模式", options: ["单张图卡", "分片截图"],
    help: "仅在图片模式下生效。开启后，较长的动态可分成多张图卡。" },
  { key: "boxGrid", setting: "grid", label: "九宫格样式", options: ["逐图排列", "宫格排列"],
    help: "仅在图片模式下生效。多张图片可放在同一行。" },
]
const platforms = [
  { id: "bilibili", label: "B站", fields: [...sharedFields, {
    key: "parseVideoLink", setting: "parseVideoLink", label: "视频链接解析", options: ["关闭", "开启"],
    help: "控制聊天中的视频链接、视频编号和短链自动解析。搜看和下载指令仍可使用。",
  }] },
  { id: "weibo", label: "微博", fields: sharedFields },
]

function fieldValue(field, settings) {
  const value = settings[field.setting]
  return field.component === "EasyCron" || field.tags ? value : Number(value)
}

function submittedValue(field, value) {
  if (field.tags) {
    if (!Array.isArray(value) || !value.every(word => typeof word === "string")) return
    return value.map(word => word.trim()).filter(Boolean)
  }
  if (field.component === "EasyCron") {
    if (typeof value !== "string" || value.length > 128) return
    const cron = value.trim()
    if (!/^[\w*,/?#-]+(?:[ \t]+[\w*,/?#-]+){4,5}$/u.test(cron)) return
    const job = new Job(() => {})
    try {
      if (job.schedule({ rule: cron, tz: "Asia/Shanghai" }) && !job.isOneTimeJob) return cron
    } finally {
      job.cancel()
    }
    return
  }
  const number = typeof value === "string" && value.trim() ? Number(value) : value
  if (Number.isSafeInteger(number) && number >= (field.min ?? 0) && number <= (field.max ?? 1)) return number
}

function changed(field, value, settings) {
  const before = fieldValue(field, settings)
  if (field.tags) return before.length !== value.length || before.some((word, index) => word !== value[index])
  return before !== value
}

export function supportGuoba(directory = dataPath) {
  const config = createSubscriptionConfig(directory, lockFile)
  return {
    pluginInfo: { name: "media", title: "媒体", isV3: true, isV2: false },
    configInfo: {
      schemas: platforms.flatMap(({ id, label: platform, fields }) => [
        { component: "SOFT_GROUP_BEGIN", label: `${platform}动态推送` },
        ...fields.map(({ key, label, options, min, max, help, component, tags }) => ({
          field: `${id}.${key}`,
          label: key === "pushMsgMode" ? platform + label : label,
          bottomHelpMessage: help,
          component: component ?? (options || tags ? "Select" : "InputNumber"),
          componentProps: tags ? { mode: "tags" } : options ? { options: options.map((label, value) => ({ label, value })) }
            : max !== undefined ? { min: min ?? 0, max, step: 1 } : undefined,
        })),
      ]),
      async getConfigData() {
        const entries = await Promise.all(platforms.map(async ({ id, fields }) => {
          const settings = await config.settings(id)
          return [id, Object.fromEntries(fields.map(field => [field.key, fieldValue(field, settings)]))]
        }))
        return Object.fromEntries(entries)
      },
      async setConfigData(values, { Result }) {
        const changes = new Map()
        for (const { id, label, fields } of platforms) {
          const selected = []
          for (const field of fields) {
            const name = `${id}.${field.key}`
            if (!Object.hasOwn(values, name)) continue
            const value = submittedValue(field, values[name])
            if (value === undefined) {
              return Result.error(`请填写有效的${label}动态推送设置。`, 422)
            }
            selected.push({ field, value })
          }
          if (selected.length) changes.set(id, selected)
        }
        for (const [id, selected] of changes) {
          await config.editSettings(id, (settings) => Object.fromEntries(selected
            .filter(({ field, value }) => changed(field, value, settings))
            .map(({ field, value }) => [field.key, value])))
        }
        return Result.ok()
      },
    },
  }
}
