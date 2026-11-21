import { load } from "cheerio"

// Full article page fields from Yuki BiliQuery (MIT). Only public embedded data are read.
interface OpusParagraph {
  para_type?: unknown
  text?: { nodes?: { rich?: { text?: unknown; emoji?: { text?: unknown } }; word?: { words?: unknown } }[] }
  pic?: { pics?: { url?: unknown }[] }
}

export function articleContent(html: string) {
  const opus = /"module_content"\s*:\s*([\s\S]+?)\s*,\s*"module_type"\s*:\s*"MODULE_TYPE_CONTENT"/u.exec(html)
  const old = /"readInfo":([\s\S]+?),"readViewInfo":/u.exec(html)
  try {
    if (opus?.[1]) {
      const { paragraphs }: { paragraphs?: OpusParagraph[] } = JSON.parse(opus[1])
      if (!Array.isArray(paragraphs)) return
      const content: string[] = []
      const images: unknown[] = []
      for (const paragraph of paragraphs) {
        if (paragraph.para_type === 1 && Array.isArray(paragraph.text?.nodes)) {
          content.push(paragraph.text.nodes.map(node=>node?.rich?.text || node?.rich?.emoji?.text || node?.word?.words || "").join(""))
        }
        if (paragraph.para_type === 2 && Array.isArray(paragraph.pic?.pics)) {
          images.push(...paragraph.pic.pics.map(item=>item?.url))
        }
      }
      return { content:content.join("\n"),images }
    }
    if (old?.[1]) {
      const { content }: { content?: unknown } = JSON.parse(old[1])
      if (typeof content !== "string") return
      const $ = load(content,{},false)
      $("script, style").remove()
      $("br, p, div").after("\n")
      return { content:$.root().text().trim(),images:$("img").toArray().map(item=>$(item).attr("data-src") || $(item).attr("src")) }
    }
  } catch { return }
}
