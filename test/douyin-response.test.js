import { expect, test } from "bun:test"
import { fetchWebDetail } from "../services/douyin/api.ts"
import { normalizeDouyinWork } from "../services/douyin/model.ts"
import { detailFromRouter } from "../services/douyin/ssr.ts"
import { DouyinService } from "../services/douyin/service.ts"

const id = "7656832159801511209"
const other = "7681200077788977514"
const image = "https://fixture.douyinpic.com/image.png"
const clip = "https://fixture.douyincdn.com/clip.mp4"

test("抖音作品回包只接受完整对象及对应的精确编号", async () => {
  const read = payload => fetchWebDetail(id, "", {
    sign: () => "fixture",
    fetch: async () => Response.json(payload),
  })
  for (const payload of [null, [], false, "text", { status_code: 0, aweme_detail: { aweme_id: other } },
    { status_code: 0, aweme_detail: { aweme_id: Number(id) } }]) {
    await expect(read(payload)).rejects.toMatchObject({ code: "api_empty" })
  }
  await expect(read({ status_code: 0, aweme_detail: { aweme_id: id } })).resolves.toMatchObject({ aweme_id: id })
  const calls = []
  const service = new DouyinService({ visitor: { get: async () => "" }, sign: () => "fixture",
    fetch: async input => {
      calls.push(new URL(input).pathname)
      return Response.json({ status_code: 2, status_msg: "该作品为私密作品" })
    },
  })
  await expect(service.getInfo({ id })).rejects.toMatchObject({ code: "unavailable" })
  expect(calls).toEqual(["/aweme/v1/web/aweme/detail/"])
})

test("分享页跳过错作品和畸形列表，保留同稿件的明确不可见结果", () => {
  const matched = { aweme_id: id, desc: "正确作品" }
  const rows = {
    malformed: { videoInfoRes: { item_list: { field: "not a list" } } },
    wrong: { itemId: other, videoInfoRes: { status_msg: "私密", item_list: [{ aweme_id: other }] } },
    same: { itemId: id, videoInfoRes: { item_list: [null, Number(id), { aweme_id: Number(id) }, matched] } },
  }
  expect(detailFromRouter({ loaderData: rows }, id)).toEqual(matched)
  expect(() => detailFromRouter({ loaderData: { ...rows, denial: { itemId: id, videoInfoRes: { status_msg: "不可见" } } } }, id))
    .toThrow("不可见")
  expect(() => detailFromRouter({ loaderData: { malformed: rows.malformed, wrong: rows.wrong } }, id)).toThrow("没有可用")
})

test("抖音混合图组和清晰度缺项保留有效项、原编号和实际统计", () => {
  const work = normalizeDouyinWork({ aweme_id: id, desc: "实况", preview_title: {}, author: { nickname: {} },
    statistics: { digg_count: 0, comment_count: false, collect_count: [], share_count: "12", play_count: 2.5 },
    images: [null, { clip_type: 5, url_list: [image], video: { bit_rate: [null, false], play_addr_h264: { url_list: [clip] } } }],
  }, { expectedId: id })
  expect(work).toMatchObject({ type: "live_photo", title: "实况", owner: "", cover: image,
    stat: { like: 0, reply: undefined, favorite: undefined, share: 12, view: undefined },
    media: [
      { index: 1, type: "image", urls: [], sources: [] },
      { index: 2, type: "live_photo", urls: [image], sources: [{ urls: [clip], codec: "h264" }] },
    ],
  })
  expect(work.warnings).toEqual(["第 1 项缺少媒体地址"])
  expect(() => normalizeDouyinWork({ aweme_id: Number(id), images: [{ url_list: [image] }] })).toThrow("ID 不匹配")
})

test("抖音文章保留实际可读正文及图片，空文章不会生成只有标题的附件", () => {
  const work = normalizeDouyinWork({ aweme_id: id, aweme_type: 163, article_info: {
    article_title: "有效文章",
    article_content: { markdown: "前文 ![封面](" + image + ") 后文" },
    fe_data: { image_list: [null, false, { markdown_url: image, high_image_url: image + "?quality=high" }] },
  } })
  expect(work.article.blocks).toEqual([{ type: "text", text: "前文" }, { type: "image", urls: [image + "?quality=high", image], caption: "封面" },
    { type: "text", text: "后文" }])
  expect(normalizeDouyinWork({ aweme_id: id, aweme_type: 163, desc: "只有可读简介" }).article.blocks)
    .toEqual([{ type: "text", text: "只有可读简介" }])
  expect(() => normalizeDouyinWork({ aweme_id: id, aweme_type: 163, article_info: { article_title: "无内容" } }))
    .toThrow("缺少可用的文章正文")
  expect(normalizeDouyinWork({ aweme_id: id, article_info: [], video: { play_addr: { url_list: [clip] } } }).type)
    .toBe("video")
})
