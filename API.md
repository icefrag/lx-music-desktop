# LX Music 开放 API 接口文档

适用于本仓库构建的 lx-music-desktop（含歌单获取 / 歌单下载 / 单曲下载 / 打开歌单扩展端点）。

## 启用服务

应用内 `设置 → 开放 API → 启用开放 API 服务`。

- 默认地址：`http://127.0.0.1:23330`（端口可在设置中修改；勾选「允许来自局域网的访问」后监听 `0.0.0.0`）
- 无鉴权，仅建议在可信网络环境使用
- 所有响应带 `Access-Control-Allow-Origin: *`，可从网页直接调用
- 只解析 URL query 参数，不解析请求体；`GET`/`POST` 均可（不区分）

## 下载调度模型（统一供给池）——对接方必读

应用自 v2.12.7+（ADR 0005→0007）起，下载链接的获取由**统一供给池**自动调度，调用方**不选择、也无法指定**由哪个音源出链：

- **账号供给源**：应用内登录的平台会员账号（酷狗/QQ/网易），支持全部音质；受平台风控冷却保护（冷却期间自动跳过，恢复点自动回归）。
- **脚本供给源**：内置「野花」「野草」+ 用户导入的全部自定义源脚本，仅服务 **128k**；每个脚本按（脚本 × 平台）独立熔断，连败自动隔离、按指数退避重探，恢复后自动回归。
- 每个下载任务按「歌曲平台 × 请求音质」过滤能力匹配的供给源，取当前空闲者；失败自动转移下一个，全部不可用则排队等待恢复。
- 实际出链方记录在任务上，可通过 `/download-status` 的 **`sourceChannel`** 字段对账（`account`=账号 / 野花沿用旧标识 `yehua` / 其他脚本为成员名 / `null`=尚未解析）。

**对接结论**：

1. **128k 下载不需要（也不应该）做「切源 → 下单」编排**——供给池自动分发，切生效音源不影响下载路由。
2. `320k`/`flac` 只有账号供给源能服务：**对应平台账号必须已登录**（用 `/account-source-status` 检查），否则任务大概率失败（`errorCode: url_failed`）。无人值守的自动化建议显式传 `quality=128k`。
3. `/api-source` 切换生效音源只影响**播放**与「供给池全灭时的最后兜底」，与下载路由基本无关（详见该端点章节）。

## 通用约定

| 语义 | 说明 |
|---|---|
| **指令类端点**（播放控制、下载、打开歌单） | fire-and-forget：`200 OK` 只代表指令已派发，不代表执行结果。失败会体现在应用界面（错误弹窗 / 下载列表任务状态），HTTP 侧仍返回 200 |
| **数据类端点**（`/songlist`、`/status`、`/download-status` 等） | 响应体返回 JSON，出错时返回对应错误码 |

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

## 歌单与下载端点

### GET /songlist —— 歌单获取

拉取在线歌单的**全部曲目**，返回 JSON。这是下载流程的第一步：先拿数据、再挑歌。

```
GET /songlist?source=kw&id=<歌单ID或完整链接>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 音乐源代码，见「参数取值参考」 |
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
- 大歌单内部会分页拉全后合并去重；单请求最长等待 60 秒（超时返回 `504`，拉取会在应用侧继续并缓存，重试很快）
- 结果存在应用内存缓存中，应用重启后失效

### GET /download-songlist —— 歌单下载

对歌单曲目批量创建下载任务，支持按 `songmid` 精确筛选和指定下载目录。

```
GET /download-songlist?source=kw&id=<歌单ID>&songmids=a,b,c&quality=320k&limit=200&dir=D:\Music\pick
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `source` | 是 | 音乐源代码 |
| `id` | 是 | 歌单 ID（应用会自行拉取全量曲目） |
| `songmids` | 否 | 逗号分隔的曲目唯一 id（来自 `/songlist` 响应的 `songmid`）。**提供后精确下载这些曲目**，未命中的静默忽略 |
| `limit` | 否 | 正整数。仅在**未提供** `songmids` 时生效：整单下载时取前 N 首 |
| `quality` | 否 | 音质，默认 `320k`，见「参数取值参考」。自动化建议显式传 `128k`（320k/flac 需要对应平台账号已登录） |
| `dir` | 否 | 下载目录，**绝对路径**。目录不存在会自动创建；不改变应用全局下载目录设置；应用重启后未完成任务仍保持该目录 |

行为说明：

- `songmids` 与 `limit` 互斥，`songmids` 优先
- 重复任务：在途任务（排队/下载中/暂停）重复提交被静默忽略；终态任务（失败/完成）被同 id 新任务替换（重新下载 = 重试）
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
| `quality` | 否 | 默认 `320k`；自动化建议 `128k` |
| `dir` | 否 | 同 `/download-songlist` 的 `dir` |
| `albumName` `interval` | 否 | 补充元数据（可用于文件名外的信息与匹配） |
| `hash` | kg 源必填 | 酷狗歌曲 hash |
| `strMediaMid` | tx 源必填 | 企鹅源媒体 id |
| `copyrightId` | mg 源必填 | 咪咕版权 id |

kw / wy 源只需基础字段。

### GET /download-status —— 下载任务状态查询

查询下载任务的状态、失败原因、**实际出链供给源**与落盘路径，供调用方**轮询对账**。数据来自应用内实时落库的下载记录，无需渲染进程参与。

```
GET /download-status?songmids=7214800,228908&source=kw
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `songmids` | 否 | 逗号分隔的曲目唯一 id，只返回这批任务；不传返回全部下载任务 |
| `source` | 否 | 进一步按音乐源收窄（不同源的 songmid 理论上可能重号，跨源查询时建议带上） |

响应示例（截断）：

```json
{
  "list": [
    {
      "songmid": "7214800", "source": "kw", "name": "小半", "singer": "陈粒",
      "status": "completed", "statusText": "下载完成",
      "sourceChannel": "聆澜音源", "apiSource": "user_api_436_1791810254714",
      "fileName": "小半 - 陈粒.mp3", "filePath": "D:\\Music\\pick\\小半 - 陈粒.mp3",
      "quality": "320k", "ext": "mp3", "progress": 100, "downloaded": 8493462, "total": 8493462
    },
    {
      "songmid": "228908", "source": "kw", "name": "晴天", "singer": "周杰伦",
      "status": "error", "statusText": "获取音乐链接失败", "errorCode": "url_failed", "sourceChannel": null,
      "apiSource": "user_api_436_1791810254714",
      "fileName": "晴天 - 周杰伦.mp3", "filePath": "",
      "quality": "128k", "ext": "mp3", "progress": 0, "downloaded": 0, "total": 0
    }
  ]
}
```

- `status` 取值：`run`（下载中）/ `waiting`（排队）/ `pause`（暂停）/ `error`（失败）/ `completed`（完成）；`statusText` 是人类可读状态/失败原因
- **`sourceChannel`（实际出链供给源）**：`account` = 账号供给源；`yehua` = 内置野花（历史标识，兼容已持久化任务）；其他非空值 = 脚本供给源成员名；`null` = 尚未解析（排队中）或升级前的旧任务。对接方**不要对任何具体值硬编码特殊逻辑**，按「`account` / 非空脚本名 / null」三类处理即可
- `apiSource` 与 `sourceChannel` 是两回事：前者是任务创建时钉住的**生效音源**（影响排队任务何时启动，见 `/api-source`），后者是**实际出链方**
- `errorCode` 是与 `statusText` 并存的结构化错误码，供程序化归类：

| errorCode | 含义 |
|---|---|
| `url_failed` | 获取音乐链接失败（含歌曲下架、无可分发供给源——应用层无法进一步区分） |
| `account_expired` | 账号凭据已过期，需重新登录（用 `/account-source-status` 定位平台） |
| `risk_control` | 账号风控冷却（任务会自动等待恢复，反复出现说明风控窗口长） |
| `stalled` | 下载断流/卡死，自动重试阶梯耗尽（同 URL 重连 → 换链 → 失败） |
| `file_exists` | 「跳过已存在文件」命中，文件已存在 |
| `check_path` | 保存目录检查失败 |
| `response` | 下载中网络/响应错误 |
| `write` | 文件写入失败 |
| `unknown` | 其他未分类错误（含供给源反复恢复失败的超时） |
- **查不到的 songmid 不会出现在响应里** = 没有对应任务（例如 songmid 未命中歌单被忽略）
- 同一 `songmid` 可能对应多条记录（同一首歌以不同音质建过多个任务），对账时可结合 `quality` 区分
- 任务长期 `waiting` 的两种可能：并发排队（正常）；供给源全在恢复期（账号冷却/脚本熔断），恢复点自动唤醒，反复超过 3 轮才报 `unknown`
- 轮询建议：发起下载后每 1~2 秒查询一次，直到目标 songmid 全部到达终态（completed / error）即结束
- 用户在应用内删除/清空下载列表后对应任务即查不到——看到终态后请调用方自行记录结果

### GET /account-source-status —— 账号登录态查询

查询单位供给源（酷狗/QQ/网易）的登录与凭据状态，用于下载 `320k`/`flac` 前的前置检查与 `errorCode: account_expired` 的归因。

```
GET /account-source-status
```

响应（截断）：

```json
{
  "kg": { "login": true, "status": "normal", "updatedAt": 1760412345678 },
  "tx": { "login": true, "status": "normal", "updatedAt": 1760412345678 },
  "wy": { "login": false, "status": "unknown", "updatedAt": 0 }
}
```

- `status` 取值：`normal`（正常）/ `expired`（已过期，需重新登录）/ `unknown`（未登录）
- 只有 `login=true` 且 `status != 'expired'` 的平台，其账号供给源才会参与下载调度

### GET /api-source —— 生效音源查询/切换/别名绑定

查询/切换应用**当前生效的音源（User API 脚本）**，或管理别名绑定。

> **注意（ADR 0007 后语义变化）**：生效音源**不再决定下载路由**——128k 下载由统一供给池自动分发（内置 + 导入的全部脚本共同参与）。切换生效音源现在只影响：① 播放链路取链；② 供给池全灭时的最后兜底；③ 排队任务的钉源挂起逻辑（见下）。**「切源 → 下单」编排对 128k 下载已无意义，请勿再使用。**

```
GET /api-source                                  # 查询
GET /api-source?set=<别名或音源id>                 # 切换
GET /api-source?alias=<别名>[&id=<音源id或别名>]    # 绑定/重绑别名（id 缺省为当前音源）
```

应用**内置**「野花」「野草」两个脚本（随安装包分发、升级自动更新、不可删除），新装即激活野花并已预绑枚举：

| 别名（枚举） | 音源 | 现阶段的实际用途 |
|---|---|---|
| `yehua` | 野花（内置） | 播放取链；作为供给池成员参与 128k 下载调度（自动，无需切换） |
| `yecao` | 野草（内置） | 同上（仅 kw 平台） |

仅当你**另外导入自定义音源脚本**并想用固定枚举引用它时才需要绑定（音源原始 `id` 导入时随机生成、重导入会变，不要写死在调用方）：

```bash
curl "http://127.0.0.1:23330/api-source?alias=<别名>&id=<该音源的id>"
# id 从 GET /api-source 的 list 里查（按 name 匹配）；音源重导入后重新绑定
```

响应示例：

```json
{
  "current": "user_api_436_1791810254714",
  "ready": true,
  "list": [
    { "id": "user_api_436_1791810254714", "name": "野花🌷", "version": "1", "description": "", "alias": "yehua" },
    { "id": "user_api_026_1791819889933", "name": "野草🌾", "version": "1", "description": "", "alias": "yecao" }
  ]
}
```

- `set` / `alias` 的 id 参数既接受原始 id 也接受已绑定的别名；未知的 set 返回 400
- 切换经应用标准链路（重载脚本窗口，秒级），端点最多等 15s，超时返回 `ready: false`（切换仍会在后台完成）
- **任务钉源**：每个下载任务创建时会记住当时的生效音源（`/download-status` 的 `apiSource`）。切换生效音源后，钉住旧音源的**排队中任务自动挂起**（保持 waiting，不失败），切回后自动续跑。**因此自动化期间频繁切源会造成队列假死——无人值守场景请保持生效音源不动**
- 切换全局生效——若此实例同时在人工使用（播放歌曲），播放取链也会走新音源

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
# 3. 一次调用批量下载到指定目录（无人值守建议 quality=128k，供给池全脚本可服务）
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=3713111889&songmids=7214800,228908,386305156&quality=128k&dir=D%3A%5CMusic%5Cpick"

# 4. 轮询任务结果，直到全部到达终态（completed / error）；sourceChannel 可对账实际出链方
curl "http://127.0.0.1:23330/download-status?songmids=7214800,228908,386305156&source=kw"

# 整单下载前 200 首
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=3713111889&limit=200&quality=128k"
```

## 参数取值参考

**`source` 音乐源代码**（歌曲所属平台，决定从哪个平台的曲库解析；下载供给源由应用自动调度，调用方不可指定）：

| 代码 | 平台 | 应用内别名 |
|---|---|---|
| `kw` | 酷我音乐 | 小蜗音乐 |
| `kg` | 酷狗音乐 | 小枸音乐 |
| `tx` | QQ音乐（企鹅音乐） | 小秋音乐 |
| `wy` | 网易云音乐 | 小芸音乐 |
| `mg` | 咪咕音乐 | 小蜜音乐 |

**`quality` 音质**：`128k` / `320k` / `flac` / `flac24bit`（默认 `320k`，非法值回退 `320k`；实际以歌曲可用性自动降级，兜底 128k）。`320k` 及以上仅账号供给源可服务，需要对应平台账号已登录。

## 限制与注意事项

1. 指令类端点 `200` 不等于成功——下载是否真的完成请轮询 `/download-status` 对账。
2. 应用必须处于运行状态且已启用开放 API 服务；应用刚启动、渲染进程未就绪时，指令可能被丢弃、`/songlist` 会等到超时（504）。
3. 下载文件名由应用全局设置 `download.fileName` 模板生成（默认 `歌名 - 歌手`，支持 `歌名`/`歌手` 两个占位符），API 暂不支持逐请求自定义文件名；非法字符 `\ / : * ? # " < > |` 会被删除。
4. 同名文件行为由应用设置「跳过已存在文件」决定（默认开：已存在则任务报错跳过；关：覆盖重下）。
5. 供给池的脚本供给源有独立健康隔离（熔断）：某个脚本在某平台连败会被自动隔离几分钟，期间流量走其他供给源，调用方无感知；账号供给源受平台风控冷却保护，同理。极端情况下全部供给源不可用，任务停在 `waiting` 等待恢复（超 3 轮报 `unknown`）。
