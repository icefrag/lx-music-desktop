# LX Music 开放 API 接口文档

适用于本仓库构建的 lx-music-desktop（含歌单获取 / 歌单下载 / 单曲下载 / 打开歌单扩展端点）。

## 启用服务

应用内 `设置 → 开放 API → 启用开放 API 服务`。

- 默认地址：`http://127.0.0.1:23330`（端口可在设置中修改；勾选「允许来自局域网的访问」后监听 `0.0.0.0`）
- 无鉴权，仅建议在可信网络环境使用
- 所有响应带 `Access-Control-Allow-Origin: *`，可从网页直接调用
- 只解析 URL query 参数，不解析请求体；`GET`/`POST` 均可（不区分）

## 通用约定

| 语义 | 说明 |
|---|---|
| **指令类端点**（播放控制、下载、打开歌单） | fire-and-forget：`200 OK` 只代表指令已派发，不代表执行结果。失败会体现在应用界面（错误弹窗 / 下载列表任务状态），HTTP 侧仍返回 200 |
| **数据类端点**（`/songlist`、`/status` 等） | 响应体返回 JSON，出错时返回对应错误码 |

错误码：`400` 参数缺失或非法；`401` 未知路径；`500` 音源报错（JSON 带 `error` 字段）；`504` 数据请求超时。

URL 中的中文、Windows 路径（`:\`）等特殊字符必须做 URL 编码（如 `D:\Music` → `D%3A%5CMusic`）。

## 播放器控制端点（原有）

| 端点 | 参数 | 说明 |
|---|---|---|
| `/status` | `filter`（可选，逗号分隔的字段名） | 当前播放状态 JSON（歌名/歌手/进度等） |
| `/lyric` | — | 当前句歌词（纯文本） |
| `/lyric-all` | — | 全部歌词 JSON（原文/翻译/罗马音） |
| `/play` `/pause` | — | 播放 / 暂停 |
| `/skip-next` `/skip-prev` | — | 下一首 / 上一首 |
| `/seek` | `offset`（秒，0 ~ 时长） | 跳转播放进度 |
| `/volume` | `volume`（0-100 整数） | 设置音量 |
| `/mute` | `mute=true\|false` | 静音开关 |
| `/collect` `/uncollect` | — | 收藏 / 取消收藏当前歌曲 |
| `/subscribe-player-status` | `filter`（可选） | SSE 订阅播放状态，按字段名推送事件 |

## 歌单与下载端点（本次新增）

### GET /songlist —— 歌单获取

拉取在线歌单的**全部曲目**，返回 JSON。这是下载流程的第一步：先拿数据、再挑歌。

```
GET /songlist?source=kw&id=<歌单ID或完整链接>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 音源代码，见「参数取值参考」 |
| `id` | 是 | 歌单 ID；酷我源也支持传完整歌单链接 |

响应示例（截断）：

```json
{
  "source": "kw",
  "id": "3713111889",
  "info": { "name": "那些被999w+人标记“喜欢”的歌", "img": "https://...", "desc": "...", "author": "...", "play_count": "..." },
  "total": 232,
  "limit": 1000,
  "list": [
    {
      "id": "kw_7214800",
      "songmid": "7214800",
      "name": "小半",
      "singer": "陈粒",
      "interval": "04:12",
      "meta": { "songId": "7214800", "albumName": "...", "picUrl": "...", "qualitys": [], "_qualitys": {}, "albumId": "..." }
    }
  ]
}
```

- 每首曲目平铺了 **`songmid`** 字段——这就是下载端点的筛选契约，请把它原样（或 `String()` 后）传给 `/download-songlist`
- `songmid` 可能是数字或字符串（取决于源），比较时建议统一转字符串
- 大歌单内部会分页拉全后合并去重；单请求最长等待 20 秒，超时返回 `504`
- 结果存在应用内存缓存中，应用重启后失效

### GET /download-songlist —— 歌单下载

对歌单曲目批量创建下载任务，支持按 `songmid` 精确筛选和指定下载目录。

```
GET /download-songlist?source=kw&id=<歌单ID>&songmids=a,b,c&quality=320k&limit=200&dir=D:\Music\pick
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 音源代码 |
| `id` | 是 | 歌单 ID（应用会自行拉取全量曲目） |
| `songmids` | 否 | 逗号分隔的曲目唯一 id（来自 `/songlist` 响应的 `songmid`）。**提供后精确下载这些曲目**，未命中的静默忽略 |
| `limit` | 否 | 正整数。仅在**未提供** `songmids` 时生效：整单下载时取前 N 首 |
| `quality` | 否 | 音质，默认 `320k`，见「参数取值参考」 |
| `dir` | 否 | 下载目录，**绝对路径**。目录不存在会自动创建；不改变应用全局下载目录设置；应用重启后未完成任务仍保持该目录 |

行为说明：

- `songmids` 与 `limit` 互斥，`songmids` 优先
- 重复任务会被跳过（同一首歌 + 同音质 + 同扩展名的任务已存在时不再新建）
- 实际并发受应用「最大同时下载数」限制，超出的任务排队
- 音质不可用时自动降级到该歌曲可用音质，兜底 128k，扩展名随实际音质（mp3/flac 等）
- 批量大小受 URL 长度限制（约 16KB），单次建议不超过几百个 `songmid`，更大批量分多次调用

### GET /download-music —— 单曲下载

不经过歌单，直接用歌曲元数据创建一个下载任务。

```
GET /download-music?source=kw&name=晴天&singer=周杰伦&songmid=228908&quality=320k&dir=D:\Music
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` `name` `singer` `songmid` | 是 | 基础字段 |
| `quality` | 否 | 默认 `320k` |
| `dir` | 否 | 同 `/download-songlist` 的 `dir` |
| `albumName` `interval` | 否 | 补充元数据（可用于文件名外的信息与匹配） |
| `hash` | kg 源必填 | 酷狗歌曲 hash |
| `strMediaMid` | tx 源必填 |企鹅源媒体 id |
| `copyrightId` | mg 源必填 | 咪咕版权 id |

kw / wy 源只需基础字段。

### GET /open-songlist —— 打开歌单

让应用界面跳转到指定歌单详情页并加载内容（纯界面动作，不返回数据）。

```
GET /open-songlist?source=kw&id=<歌单ID或完整链接>
```

## 典型调用流程

```bash
# 1. 获取歌单全量曲目
curl "http://127.0.0.1:23330/songlist?source=kw&id=3713111889"

# 2. 从响应 list 中挑出想要的 songmid，例如 7214800、228908、386305156
# 3. 一次调用批量下载到指定目录
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=3713111889&songmids=7214800,228908,386305156&quality=320k&dir=D%3A%5CMusic%5Cpick"

# 整单下载前 200 首
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=3713111889&limit=200"
```

## 参数取值参考

**`source` 音源代码**：

| 代码 | 平台 | 应用内别名 |
|---|---|---|
| `kw` | 酷我音乐 | 小蜗音乐 |
| `kg` | 酷狗音乐 | 小枸音乐 |
| `tx` | QQ音乐（企鹅音乐） | 小秋音乐 |
| `wy` | 网易云音乐 | 小芸音乐 |
| `mg` | 咪咕音乐 | 小蜜音乐 |

**`quality` 音质**：`128k` / `320k` / `flac` / `flac24bit`（默认 `320k`，非法值回退 `320k`；实际以歌曲可用性自动降级）。

## 限制与注意事项

1. 指令类端点 `200` 不等于成功——下载是否真的完成请在应用「下载列表」中查看任务状态。
2. 应用必须处于运行状态且已启用开放 API 服务；应用刚启动、渲染进程未就绪时，指令可能被丢弃、`/songlist` 会等到超时（504）。
3. 下载文件名由应用全局设置 `download.fileName` 模板生成（默认 `歌名 - 歌手`，支持 `歌名`/`歌手` 两个占位符），API 暂不支持逐请求自定义文件名；非法字符 `\ / : * ? # " < > |` 会被删除。
4. 同名文件行为由应用设置「跳过已存在文件」决定（默认开：已存在则任务报错跳过；关：覆盖重下）。
5. 播放地址的获取依赖应用内配置的可用音源；音源不可用时任务会停在「获取音乐链接失败」。
