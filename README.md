# 媒体解析

Lotus-Yunzai 的 B 站、抖音和点歌模块。直接发送视频链接或 QQ 分享卡即可查看信息。插件依赖由 Lotus-Yunzai 初始化脚本安装。

## B 站

支持视频长链、b23.tv/哔哩哔哩短链、BV 号、av 号与直播间链接。视频先发信息卡，再根据配置下载。直播间发送信息卡和独立播放器链接。

- `#搜视频 关键词` 或 `#荷花搜视频 关键词` 搜索视频，随后在两分钟内发送 `#看1` 等序号。
- `#看视频 关键词` 或 `#荷花看视频 关键词` 直接查看首条结果。
- `#B站下载 BV号或链接` 或 `#荷花下载 BV号或链接` 直接下载。也支持 `下视频` 写法。
- `#B站登录` 由机器人主人在已绑定的私聊扫码。TuneWeave 保存会话，本模块在 `data/bilibili/account.yaml` 中保存账号引用。
- `#初始化环境` 由机器人主人检查 FFmpeg、FFprobe 和 TuneWeave，按需安装。也可自行部署 TuneWeave 1.0.0-beta.3 或更新版本，配置地址后启动服务。

## 抖音

支持普通视频、图集、图文与视频混排、动态图片和文章。发送作品分享文案、短链、长链或 QQ 分享卡后会显示信息卡。文章正文和图片按原顺序分页，也可发送 `#抖音下载 链接` 直接下载。

公开作品使用平台访客会话。主接口受限时会尝试分享页面，可能只获得部分统计或清晰度。图集和文章下载支持逐项发送、发送首项或 ZIP。动态图片的原图和视频按一项处理。

## 点歌

发送 `#点歌 歌名` 或 `#搜歌 歌名` 搜索默认平台，也可以指定网易、网易云、QQ、QQ音乐、酷狗、酷我、咪咕或汽水，例如 `#QQ点歌 歌名`。搜索后两分钟内回复数字或 `#听1` 选歌。`#下一页` 翻页，`#取消` 结束。本次搜索归发起人在当前机器人和会话使用。

选歌后，先发送音乐卡片或图片信息卡，再发送完整语音。播放可以在平台之间查找完整备用音源，卡片保留搜索时选择的平台。试听片段和长度不足的文件会提示完整音源不可用。

机器人主人可以私聊发送 `#音乐登录`。选择平台后，按提示继续选择扫码方式。网易云沿用合伙人账号别名，只有一条已关联的旧账号记录时会自动接续。账号引用和平台凭据保存在宿主的 `data/music/accounts.yaml`，网易云合伙人引用同步到 `data/netease/accounts.yaml`。

`config/global.yaml` 的 `music` 配置支持以下字段。

| 字段 | 默认值 |
| --- | --- |
| `enable` | `true` |
| `default_platform` | `netease`，还可选 `qq/kugou/kuwo/migu/soda` |
| `quality` | `standard` |
| `search_limit` | `10` |
| `session_timeout_ms` | `120000` |
| `download_timeout_ms` | `180000` |
| `max_size_mb` | `128` |

## 配置

配置使用宿主的 `config/global.yaml`。常用字段如下。

| 字段 | 默认值 |
| --- | --- |
| `tuneweave.api_url` | `http://127.0.0.1:7832` |
| `tuneweave.request_timeout_ms` | `30000` |
| `bilibili.search_limit` | `10` |
| `bilibili.download.resolution` | `64` |
| `bilibili.download.concurrency` | `4` |
| `douyin.enable` | `true` |
| `douyin.request_timeout_ms` | `15000` |
| `douyin.download.quality` | `adapt`，也可选 `4k/2k/1080p/720p/540p/360p` |

两个平台各自的 `download` 配置支持以下字段。

| 字段 | 默认值和作用 |
| --- | --- |
| `enable` | `true`，允许下载 |
| `multi_page_policy` | `zip`，可改为 `all` 或 `first` |
| `tools_path` | `data/tools/bin`，FFmpeg 和 FFprobe 的可选位置 |
| `duration_limit_seconds` | `3600`，视频时长限制 |
| `video_size_limit_mb` | `100`，以视频发送的大小阈值，超限则转为附件 |
| `max_estimated_size_mb` | `0`，下载大小不限。正数用于限制下载体积 |
| `timeout_ms` | `600000`，下载和处理的超时设置 |

下载权限沿用 `permissions.scopes` 的 `bilibili.download` 和 `douyin.download`。每次下载有独立任务目录，完成发送或处理失败后清理。账号档案和工具状态位于宿主的 `data/`。

## 来源

解析、媒体及工具服务、指令和 Skia 卡片以 Lotus-ReFactor 的 [eaf76753](https://github.com/MOPELotus/Lotus-ReFactor/tree/eaf7675324dae64e51652bf9669ef93247d02b42) 为基线。保留 [原许可](LICENSE)。视频信息卡沿用原 `core/render/source-cards.js` 的 genshin `mysNews` 布局，从宿主已有的 `data/passport/resources` 或 `data/atlas/theme` 读取 Miao 主题和字体。Bun 环境的 SM3 哈希使用 [sm-crypto](https://github.com/JuneAndGreen/sm-crypto) 的 MIT 许可实现。
