# 媒体解析

Lotus-Yunzai 的 B 站、抖音、动态订阅和点歌模块。直接发送视频链接或 QQ 分享卡即可查看信息。插件依赖由 Lotus-Yunzai 初始化脚本安装。

## B 站

支持视频长链、b23.tv/哔哩哔哩短链、BV 号、av 号与直播间链接。b23.tv 短链可以省略 https://。视频先发信息卡，再根据配置下载。直播间发送信息卡和独立播放器链接。

视频信息卡无法生成时，会发出文字预览，包含已有的稿件、UP 主、简介、统计和原视频链接。

荷花面板「旧锅巴配置」的「视频链接解析」读取原 `bilibili.parseVideoLink` 开关。关闭后，聊天里的视频链接、编号和未展开的短链会跳过自动解析。直播间直链和显式搜看、下载指令仍可使用。

- `#搜视频 关键词` 搜索视频，随后在两分钟内发送 `#看1` 等序号。
- `#点B站视频 关键词` 可用 `#B站上一页`、`#B站下一页` 翻页，或用 `#看B站视频 1` 选择当前页的一条结果。
- `#看视频 关键词` 直接查看首条结果。
- `#B站下载 BV号或链接` 或 `#B站下视频 BV号或链接` 直接下载。
- `#B站登录` 由机器人主人在已绑定的私聊扫码。TuneWeave 保存会话，本模块在 `data/bilibili/account.yaml` 中保存账号引用。
- `#初始化环境` 由机器人主人检查 FFmpeg、FFprobe 和 TuneWeave，按需安装。也可自行部署 TuneWeave 1.0.0-beta.3 或更新版本，配置地址后启动服务。

宿主接管后尝试恢复已安装并留有托管记录的本机 TuneWeave。使用自建地址时由部署方维护服务。

## 抖音

支持普通视频、图集、图文与视频混排、动态图片和文章。发送作品分享文案、短链、长链或 QQ 分享卡后会显示信息卡。文章正文和图片按原顺序分页，也可发送 `#抖音下载 链接` 直接下载。

公开作品使用平台访客会话。主接口受限时会尝试分享页面，可能只获得部分统计或清晰度。图集和文章下载支持逐项发送、发送首项或 ZIP。动态图片的原图和视频按一项处理。

## 点歌

发送 `#点歌 歌名` 或 `#搜歌 歌名` 搜索默认平台，也可以指定网易、网易云、QQ、QQ音乐、酷狗、酷我、咪咕或汽水，例如 `#QQ点歌 歌名`。搜索后两分钟内回复数字或 `#听1` 选歌。`#下一页` 翻页，`#取消` 结束。本次搜索归发起人在当前机器人和会话使用。

选歌后，先发送音乐卡片或图片信息卡，再发送完整语音。播放可以在平台之间查找完整备用音源，卡片保留搜索时选择的平台。试听片段和长度不足的文件会提示完整音源不可用。

机器人主人可以私聊发送 `#音乐登录`。选择平台后，按提示继续选择扫码方式。网易云沿用合伙人账号别名，只有一条已关联的旧账号记录时会自动接续。账号引用和平台凭据保存在宿主的 `data/music/accounts.yaml`，网易云合伙人引用同步到 `data/netease/accounts.yaml`。

在已绑定的主人会话中，`#TuneWeave状态` 检查网易云登录和扩展接口，`#初始化TuneWeave` 检查或初始化 TuneWeave。合伙人账号可以在主人私聊直接发送 `#合伙人登录`，等待时间和轮询间隔沿用 `netease_partner.login_timeout_ms` 与 `login_poll_ms`。这些指令沿用 `permissions.scopes.netease.partner`，扫码只更新账号记录。

主人可发送 `#合伙人测试` 或 `#合伙人测试（执行）` 手动执行合伙人任务。任务核对已登录账号后按原偏好提交评分与乐评，保存当次报告和评分回执。上游结果未确认的作品先等待平台确认，同一天的后续运行不会再次提交。

在 `config/global.yaml` 的 `netease_partner` 段设置 `enable: true` 开启自动任务。默认每天 00:05，使用同一份评分回执和旧 `last_run_date` 防止重复。可用 `schedule` 指定时间，用 `auto_catch_up: true` 在启动错过当天时间时等一分钟后补跑。默认私聊通知已绑定的主人好友，可用 `notify_master: false` 关闭。

主人可私聊发送 `#合伙人日志`，查看保存在 `data/logs` 的最近合伙人报告。优先读取 `nep-latest.json`，也兼容按时间命名的旧报告。日志入口沿用 `permissions.scopes.netease.partner`，展示账号汇总及逐首结果。本地报告保留错误摘要。

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

## B 站动态与微博订阅

发送 `#媒体帮助` 或 `/媒体帮助` 查看动态订阅指令图卡。图卡可读取本机旧 `plugins/yuki-plugin/resources` 或迁移到 `data/yuki-plugin/resources` 的原底、图标和字体，并沿用原素材的授权范围。

在目标群或私聊发送 `#添加B站推送 图文 UID` 或 `#添加微博推送 UID`，由机器人主人设置。省略分类时添加全部动态。可按视频、图文、文章、转发订阅，B 站还支持直播。删除某类时在 `#删除B站推送` 或 `#删除微博推送` 后填写分类和 UID，省略分类时删除该账号订阅。指令可以用 `#` 或 `/` 开头。

B 站公开资料接口明确拒绝访问时，添加指令会按填写的 UID 保存订阅并提示尚未校验。待公开动态可以读取时，订阅即可参与推送。

发送 `#B站订阅列表` 或 `#微博订阅列表` 查看当前会话。主人可用 `#B站全部订阅列表` 或 `#微博全部订阅列表` 查看当前机器人的所有订阅，授权的本机终端可查看所有机器人。主人用 `#执行B站任务` 或 `#执行微博任务` 手动检查订阅。另支持 `#B站UP主UID:UID`、`#B站UP主昵称:昵称`、`#微博博主UID:UID` 和 `#微博博主昵称:昵称`。

查人指令会展示公开响应中已有的粉丝和关注数，以及 B 站等级、微博认证等资料。B 站资料带有效直播间号时会附直播间链接。

沿用 `data/yuki-plugin/config/{bilibili,weibo}/` 下的 `config.yaml`、`push.yaml` 以及同名的 `*.guoba.support.yaml`，有锅巴文件时以该文件为准。可保留已有群、私聊、机器人账号、分类、关键词和定时设置。聊天指令写入当前使用的推送文件，保留其他会话与机器人配置、YAML 注释及文件权限。默认每 23 分钟检查，允许用旧 `checkDynamicCD` 修改，定时任务用北京时间。

动态读取沿用已有的 B 站本地 `data/yuki-plugin/biliCookie.yaml` 和旧 Valkey 会话。微博继续读取旧 Valkey 会话及同域校验字段。动态接口返回续签时保留新 Cookie 与有效期；凭据失效后尝试仍可用的会话或公开读取。

TuneWeave 支持 B 站动态读取时，主人在好友私聊用 `#B站登录` 扫码一次即可用于视频和动态。动态优先使用已有的本地 Cookie 和独立扫码会话。用 `#我的B站CK` 查看实际来源，或用 `#停用B站动态共用`、`#启用B站动态共用` 控制共用。

需要分开登录时使用 `#扫码B站动态登录`。旧 TuneWeave 仍可用 `#扫码B站登录` 独立扫码。 `#删除B站登录` 仅退出独立的动态扫码会话。手动绑定和移除分别使用 `#绑定B站本地CK <Cookie>`、`#删除B站本地CK`。微博使用 `#我的微博登录` 或 `#删除微博登录` 管理已有移动站会话。

动态支持原图卡和文字模式。按旧配置 `forwardSendDynamic`、`maxPicsForSingleMsg` 和 `maxTextLengthForSingleMsg`，同一会话超过两张图片或 300 字时默认合并转发。网关明确拒绝合并转发时改为分条发送。推送沿用原 Valkey 已发记录，结果未确认时保留记录以避免重复。机器人需在已连接的目标群内，或与私聊对象有好友关系。上游拒绝公开请求时，手动任务会明确报告异常，稍后成功获取后仍可进入推送。

B 站和微博的文字推送会附上响应已有的点赞、评论和转发数。B 站视频还会显示播放和弹幕数，直播会显示分区、开播时间、观看人数及直播间链接。

文字正文沿用 `pushContentLenLimit` 和 `pushContentLineLimit`。换行不计入字数，因字数限制截断一行时会显示 `...`，链接仍会保留。文字模式保留视频简介的完整分行，其中任一限制设为 0 时隐藏正文。

文字模式的白名单和屏蔽关键词也匹配推送链接，含转发中的原帖链接。

B 站直播可通过旧配置 `liveAtAll` 在 `liveAtAllGroupList` 指定的群里提醒全体成员。`liveAtAllCD` 为每群冷却时间，默认 1800 秒。荷花面板「旧锅巴配置」可编辑提醒开关和冷却时间。网关明确拒绝提醒时，按 `liveAtAllErrMsg` 决定是否提示，直播动态仍会发出。送达结果未知时保留冷却，避免重复提醒。

B 站和微博的文字转发推送先给转发帖链接，再显示原帖类别、作者、正文和链接。图卡也标明原帖类别、作者和发布时间，二维码指向转发帖。

在荷花面板的「旧锅巴配置」中选择「媒体」，可分别设置 B 站和微博的消息模式、文字与图片合并发送、合并转发开关及两个阈值。还可设置是否推送转发动态、动态时间范围和屏蔽关键词。关键词每行一个。图片模式可设置分片截图和宫格排列，保存时保留旧配置中的 `splitHeight` 和 `noSplitHeight`。修改写入对应平台原有的锅巴覆盖文件，下次推送时生效。定时推送开关和 Cron 周期在重启后生效，关闭定时推送后机器人主人仍可手动执行任务。

动态订阅使用匿名公开接口，上游拒绝时会报告读取失败。B 站和微博的官方开放平台凭据分别适用于其授权数据范围。视频解析的 B 站扫码账号用于 TuneWeave 视频服务。

微博列表标记为长文或超过九张图片时，会尝试从同一动态的公开详情补齐缺失的正文和图片。匿名详情无法读取时使用已取得的列表内容。

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

合伙人评分、乐评和逐首回执参考 Lotus-ReFactor 的 [e28c6df](https://github.com/MOPELotus/Lotus-ReFactor/tree/e28c6df5fd6212ce5943b4a9f7fba6e2bca32653)，沿用同一许可。

动态订阅和图卡结构来源于 [snowtafir/yuki-plugin main3](https://github.com/snowtafir/yuki-plugin/tree/b1d8fecf41d03f92746bb2404b0b0381a24103a5)，保留 [MIT 许可](LICENSES/yuki-plugin.txt)。
