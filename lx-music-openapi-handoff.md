# 交接文档：lx-music-desktop 开放 API 新增「歌单获取」「歌单下载」「单曲下载」「打开歌单」端点（v2）

- 生成时间：2026-10-12（v2，**取代 v1**；v1 仅含「打开歌单 + 单曲下载」，尚未实现，工作区干净）
- 仓库：`D:\script-workspace\lx-music-desktop`（master @ `ad95d509`，v2.12.6）
- 本文档自包含全部调查结论，接手方无需重新考古，按第 3 节改动清单直接实现即可。
- 术语以根目录 `CONTEXT.md` 为准；数据通道选型决策见 `docs/adr/0001-openapi-songlist-data-via-renderer-roundtrip.md`。

---

## 0. 任务一句话

在现有开放 API HTTP 服务上新增/保留四个端点：

| 端点 | 语义 | 响应 |
|---|---|---|
| `GET /songlist?source=kw&id=<歌单ID或链接>` | **歌单获取**：返回歌单信息 + **全量曲目 JSON**（含每首唯一 `songmid` 及下载所需全部字段） | 200 JSON；缺参 400；超时 504；源报错 500 |
| `GET /download-songlist?source=kw&id=<歌单ID>&songmids=a,b,c&quality=320k&limit=200&dir=D:\Music` | **歌单下载**：应用拉全量曲目，按 `songmids` 过滤（不传则整单，`limit` 截断前 N），批量建下载任务，可指定下载目录 | fire-and-forget，200 = 已受理 |
| `GET /download-music?source=&name=&singer=&songmid=&quality=&dir=` | **单曲下载**：按歌曲元数据建下载任务（v1 设计 + `dir`） | fire-and-forget |
| `GET /open-songlist?source=kw&id=<歌单ID或链接>` | **打开歌单**：应用界面跳转到歌单详情页（v1 设计，不变） | fire-and-forget |

调用方典型流程（用户的另一软件）：调 `/songlist` 拿到 1000 首 → 自己挑出 200 个 `songmid` → 调 `/download-songlist` 带 `songmids` + `dir` 一次下完。

---

## 1. 已定设计决策（不要再讨论，直接执行）

| 决策点 | 结论 |
|---|---|
| `/songlist` 返回范围 | **全量**（内部 `getListDetailAll` 逐页拉完去重），不做分页参数 |
| 下载的「唯一 id」契约 | **`songmid`**（每源内部唯一；`/songlist` 响应已平铺该字段）。`/download-songlist` 按 `meta.songId` 过滤 |
| `songmids` 与 `limit` 关系 | 互斥语义：传 `songmids` → 精确下这些（未命中的忽略）；不传 → 整单 + 可选 `limit` 截断前 N |
| 下载目录 `dir` | 可选绝对路径；**逐任务 `metadata.savePath`**，不改全局设置 `download.savePath`；目录不存在自动创建（worker 已有 recursive mkdir）；**需持久化到下载记录库**（重启后不回退全局目录） |
| `quality` | 可选，默认 `'320k'`；实际可用性由下载 worker 自动降级（兜底 128k） |
| `/songlist` 数据通道 | 新增 requestKey 往返 IPC（照抄 userApi 模式，20s 超时），见 ADR-0001；**这是本任务唯一新增的 IPC** |
| 指令类端点传输通道 | 复用 deeplink 桥 `global.lx.event_app.deeplink(...)`，不新增其它 IPC |
| 端点命名 | 跟随现有 kebab-case：`/songlist`、`/download-songlist`、`/download-music`、`/open-songlist` |
| 鉴权 / method | 不新增（沿用现状：无鉴权、只解析 query） |

---

## 2. 代码考古结论（可直接信赖的事实）

### 2.1 开放 API 服务本体

文件：`src/main/modules/openApi/index.ts`（单文件 297 行）。

- 主进程 `node:http` 服务，所有端点写在 `handleStartServer` 内 `http.createServer` 回调的一个大 `switch (endUrl)`（约 87-211 行）。
- 只解析 query（`querystring.parse`），不解析 body、不检查 `req.method`。
- `endUrl` 取 URL 最后一个路径段（`:88`）。
- 无鉴权；未知路径 401 `'Forbidden'`。
- 返回 JSON 的先例：`/status` 用独立 handler（`handleSendStatus`）+ 提前 `return`，`sendResponse(res, 200, obj, 'application/json; charset=utf-8')`——`/songlist` 照此办理。
- 服务开关：设置键 `openAPI.enable`/`openAPI.port`（默认 `'23330'`）/`openAPI.bindLan`（`src/common/defaultSetting.ts:148-150`）；启用链路 `useOpenAPI.ts` → IPC `open_api_action` → `src/main/modules/winMain/rendererEvent/openAPI.ts` → `startServer/stopServer`。

### 2.2 deeplink 桥（指令类端点用）

主进程任意位置：`global.lx.event_app.deeplink('lxmusic://...')`（`src/main/event/AppEvent.ts:52`）→ IPC `deeplink` → 渲染进程 `src/renderer/core/useApp/useDeeplink/index.ts:53` `onDeeplink` → `handleLinkAction(link)`。

- `handleLinkAction`（`index.ts:19-51`）解析 `lxmusic://<type>/<action>[/<path...>][?<query>]`，`?data=` 值会做 `JSON.parse(decodeURIComponent(data))`；**普通 query 值不解码**——所以复杂参数一律走 `?data=<encodeURIComponent(JSON.stringify(obj))>`（与 `music/play` 现有用法一致）。
- 渲染进程未初始化完成时 deeplink 被静默丢弃（`index.ts:55` `if (!isInited) return`）。
- deeplink 动作失败弹应用内错误对话框（`index.ts:60` `showErrorDialog`），HTTP 侧仍 200——fire-and-forget 的既定行为。

### 2.3 requestKey 往返模式（`/songlist` 数据通道，照抄对象）

原型：自定义源 userApi 请求链。

- 主进程 `request()`（`src/main/modules/userApi/rendererEvent/rendererEvent.ts:124-143`）：`new Promise`，`[resolve, reject]` 按 `requestKey` 存入 `requestQueue` Map，20s 超时清理，`sendEvent` → `mainSend` 发给目标窗口。
- 回执：对端回 `response` 事件，主进程 `handleResponse`（`rendererEvent.ts:51-61`）按 `requestKey` resolve/reject。
- IPC 基础设施：通道名 `src/common/ipcNames.ts`（模块名_事件名拼接，`:175-180`）；主进程封装 `mainHandle`/`mainSend`/`mainOn`（`src/common/mainIpc.ts:31-54`）；渲染端 `rendererInvoke`/`rendererOn`/`rendererSend`（`src/common/rendererIpc.ts`）。
- 对主窗口发送可参考 `src/main/modules/winMain/main.ts:166` 的 `sendEvent`。

### 2.4 歌单加载链路（渲染进程，现成可复用）

- 路由 `/songList/detail` → `views/songList/Detail/index.vue` → `getAndSetListDetail`（`src/renderer/store/songList/action.ts:187-204`）→ `getListDetail`（`:131-140`）→ `musicSdk[source].songList.getListDetail(id, page)`。
- `getListDetail` 内部经 `toNewMusicInfo`（`src/common/utils/tools.ts:3-16`）把原始曲目转成 `LX.Music.MusicInfoOnline`（`{ id: source_songmid, name, singer, source, interval, meta: { songId, albumName, picUrl, qualitys, _qualitys, albumId } }`）并去重；**`songmid` 即 `meta.songId`**。有缓存（key `sdetail__${source}__${id}__${page}`）。
- **`getListDetailAll(id, source[, isRefresh])`**（`action.ts:149-177`）：先拉第 1 页拿 `total`，`total > limit` 时递归拉完所有页合并去重，返回全量曲目列表。「收藏歌单」（`views/songList/Detail/action.ts:12-36` 的 `addSongListDetail`）就用它整单导入，是成熟路径。
- `id` 参数支持歌单 ID（含 kw 的 `digest-N__id` 前缀形态）和完整链接。
- 各源歌单曲目自带下载/取链接所需附加字段（已逐一确认）：**kg → `hash`**（`musicSdk/kg/songList.js:803`）、**tx → `strMediaMid`**（`tx/songList.js:376`）、**mg → `copyrightId`**（`mg/musicInfo.js:139`）——即歌单数据天然满足下载所需，无需二次查询。

### 2.5 下载任务与保存目录管道

- 入口：`createDownloadTasks(list: MusicInfoOnline[], quality, listId?)`（`src/renderer/store/download/action.ts:357-366`）→ 渲染进程 web worker `window.lx.worker.download.createDownloadTasks`（`worker/download/download.ts:40-56`，只生成 `fileName`）→ `filterTask` 去重 → `addTasks` 持久化入列表 → `checkStartTask`。
- **目录决定点**：任务每次启动时（含暂停后续传）`handleStartTask`（`action.ts:258-310`）第 270 行调 `buildSavePath(downloadInfo)`——`src/renderer/store/download/utils.ts:7-27`，实时读全局设置 `download.savePath`（+可选 `download.isSavePathGroupByListName` 按歌单名分子目录），拼好 `filePath` 后把 `savePath` 作为**独立参数**传给 worker（`action.ts:276`）。
- worker 写文件：`startTask`（`worker/download/download.ts:245-283`）→ `createTask`（`:58-225`）先 `checkAndCreateDir(savePath)`（`src/common/utils/nodejs.ts:39-50`，recursive mkdir，**目录不存在自动建**）→ `Downloader`（`src/common/utils/download/Downloader.ts:55` `path.join(savePath, filename)`）。主窗口 `nodeIntegrationInWorker: true`（`winMain/main.ts:105`）。
- 任务对象 `LX.Download.ListItem`（`src/common/types/download_list.d.ts:45-64`）：顶层进度/状态字段 + `metadata: { musicInfo, url, quality, ext, fileName, filePath, listId? }`。**目前没有逐任务路径字段**；worker 收到的是完整任务对象（Comlink 结构化克隆），加字段能自然流到写文件处。
- 持久化坑（前车之鉴）：`listId` 就没持久化——`toDBDownloadInfo`（`src/main/worker/dbService/modules/download/index.ts:12-30`）、回读 `initDownloadList`（`:32-55`）、表 DDL（`src/main/worker/dbService/tables.ts:203-219`）均无该字段。`savePath` 要持久化就得三处同步加列。
- 文件名：设置模板 `download.fileName`（默认 `歌名 - 歌手`）→ `formatMusicName` + 长度截断 + `filterFileName` 剔非法字符（`tools.ts:139-156`、`common.ts:127-128`）。同名文件：`skipExistFile` 开（默认）→ 已存在则任务报错跳过；关 → 覆盖重下。
- 批量语义：一次传几百首没问题——任务创建是同步 map，实际并发受 `download.maxDownloadNum` 限制，超出排队 WAITING。

### 2.6 单曲下载的构造管线（`/download-music` 用）

`music/play` 动作（`useDeeplink/useMusicAction.js:55-161`）已有：`filterInfoByPlayMusic` 按源校验老格式必填字段（kw/wy：name/singer/source/songmid/types；kg 另需 `hash`；tx 另需 `strMediaMid`；mg 另需 `copyrightId`）→ `toNewMusicInfo` 转新格式。下载动作直接复用这条管线，把播放调用换成 `createDownloadTasks`。

---

## 3. 改动清单（7 个文件，约 200 行，除 3.7 外全部纯新增）

### 3.1 `src/common/ipcNames.ts` —— +2 通道名

在 winMain 渲染进程事件命名对象里加（命名风格按现有条目调整）：

```ts
open_api_songlist_request: 'open_api_songlist_request',    // 主 → 渲染：请求数据 { requestKey, source, id }
open_api_songlist_response: 'open_api_songlist_response',  // 渲染 → 主：回执 { requestKey, data? , error? }
```

### 3.2 `src/main/modules/winMain/rendererEvent/openAPI.ts` —— requestKey 往返（约 45 行）

仿 userApi 的 `request()`（§2.3）：模块级 `Map<requestKey, [resolve, reject]>`；`mainOn(open_api_songlist_response)` 按 key resolve/reject；导出

```ts
export const requestSonglist = (source: string, id: string): Promise<{ info: unknown, total: number, list: unknown[] }> =>
  new Promise((resolve, reject) => {
    const requestKey = `openapi__${Date.now()}__${Math.random().toString().slice(2)}`
    requestQueue.set(requestKey, [resolve, reject])
    setTimeout(() => { if (requestQueue.delete(requestKey)) reject(new Error('timeout')) }, 20_000)
    sendEvent(mainWindow, NAMES.open_api_songlist_request, { requestKey, source, id })
  })
```

（`sendEvent`/窗口句柄取法参考 `src/main/modules/winMain/main.ts:166` 与 userApi 同名文件。）

### 3.3 `src/main/modules/openApi/index.ts` —— 2 个新 case + 1 处小改（约 40 行）

`/songlist` 用独立 async handler + 提前 return（`/status` 同款）：

```ts
const handleSonglist = async(res, source: string, id: string) => {
  try {
    const data = await requestSonglist(source, id)
    sendResponse(res, 200, data, 'application/json; charset=utf-8')
  } catch (err) {
    sendResponse(res, err.message === 'timeout' ? 504 : 500, { error: err.message }, 'application/json; charset=utf-8')
  }
}
// switch 内：
case '/songlist': {
  const { source, id } = querystring.parse(query ?? '')
  if (!source || !id) { code = 400; msg = 'Invalid params: source and id required'; break }
  void handleSonglist(res, source, id)
  return
}
case '/download-songlist': {
  const { source, id, songmids, quality, limit, dir } = querystring.parse(query ?? '')
  if (!source || !id) { code = 400; msg = 'Invalid params: source and id required'; break }
  const data: Record<string, unknown> = { source, id, quality: quality ?? '320k' }
  if (songmids) data.songmids = (songmids as string).split(',')
  if (limit && Number.parseInt(limit) > 0) data.limit = Number.parseInt(limit)
  if (dir) data.dir = dir
  global.lx.event_app.deeplink(`lxmusic://songlist/download?data=${encodeURIComponent(JSON.stringify(data))}`)
  break
}
```

`/download-music` case 按 v1 §3.1 原样（`types: [{ type: quality ?? '320k', size: null }]` 等映射），另把 `dir` 透传进 data JSON。`/open-songlist` case 按 v1 原样（path 段传 id：`lxmusic://songlist/open/${source}/${encodeURIComponent(id)}`）。

### 3.4 渲染端监听（新文件，约 30 行）

新建 `src/renderer/core/useApp/useOpenApiData.ts`（在 `useApp` 主流程与 `useDeeplink` 相同时机注册，保证初始化后可用）：

```ts
rendererOn(NAMES.open_api_songlist_request, async({ requestKey, source, id }) => {
  try {
    const detail = await getListDetail(id, source, 1)      // 拿 info / total（ListDetailInfo）
    const list = await getListDetailAll(id, source)         // 全量曲目（MusicInfoOnline[]）
    rendererSend(NAMES.open_api_songlist_response, {
      requestKey,
      data: {
        source, id, info: detail.info, total: detail.total,
        list: list.map(m => ({ ...m, songmid: m.meta.songId })),   // 平铺 songmid 作为下载契约字段
      },
    })
  } catch (err: any) {
    rendererSend(NAMES.open_api_songlist_response, { requestKey, error: err.message })
  }
})
```

（`getListDetail`/`getListDetailAll` 从 `@renderer/store/songList/action` 导入；两者返回形态以 `store/songList/action.ts:131-177` 实际代码为准微调。）

### 3.5 `useDeeplink/useSonglistAction.js` —— 新增 `download` 动作（约 30 行）

在 `export default () => { switch (action) }` 里加：

```js
case 'download': {
  const { source, id, quality = '320k', songmids, limit, dir } = params.data
  if (!sourceVerify(source) || !id) return   // 校验风格仿同文件 open 动作
  const list = await getListDetailAll(id, source)
  const target = songmids?.length
    ? list.filter(m => songmids.includes(m.meta.songId))
    : list.slice(0, limit ?? list.length)
  if (target.length) await createDownloadTasks(target, quality, undefined, dir)
  focusWindow()
  break
}
```

（imports：`getListDetailAll` ← `@renderer/store/songList/action`；`createDownloadTasks` ← `@renderer/store/download/action`；`focusWindow` ← `@renderer/utils`。`open` 动作保持零改动。）

### 3.6 `useDeeplink/useMusicAction.js` —— 新增 `download` 动作（约 35 行，v1 设计）

复用 `filterInfoByPlayMusic` + `toNewMusicInfo` 管线（§2.6），把 `addTempPlayList/playNext` 换成 `void createDownloadTasks([musicInfo], quality, undefined, dir) ; focusWindow()`；`quality`/`dir` 从 `params.data` 提取（quality 默认 `'320k'`）；switch 加 `case 'download'`。

### 3.7 下载目录支持（4 处小改，共约 25 行）

1. `src/common/types/download_list.d.ts`：`metadata` 加 `savePath?: string`。
2. `src/renderer/store/download/utils.ts:7` `buildSavePath` 开头：`if (downloadInfo.metadata.savePath) return downloadInfo.metadata.savePath`（自定义目录时跳过 `isSavePathGroupByListName` 分组）。
3. `src/renderer/store/download/action.ts:357` `createDownloadTasks` 加第 4 个可选参 `savePath?: string`：worker 返回任务列表后、`addTasks` 前，`metadata.savePath = savePath` 回填。
4. 持久化（避免重启后目录回退全局设置）：`src/main/worker/dbService/tables.ts` DDL、`modules/download/index.ts` 的 `toDBDownloadInfo`/`initDownloadList` 加 `savePath` 列。**注意**：先查 dbService 对已存在库的 DDL 变更机制（migration/版本号先例），照仓库惯例加列。

### 3.8 明确不改的东西

- `useSonglistAction.js` 的 `open` 动作、UI、下载 worker 核心、`Downloader`。
- `src/common/types/player.d.ts`、`usePlayStatus.ts`、taskbar 桥。
- 官方 OpenAPI 文档在独立仓库 `lyswhut/lx-music-doc`，同步另提 PR，不在本次范围。

---

## 4. 验证清单

项目没有测试框架，用 lint + 手动 curl：

```bash
npm run lint && npm run dev
```

应用内 `设置 → 开放 API` 启用（默认端口 23330）后：

```bash
# 1) 歌单获取：返回 JSON，含 info/total/list，每首有平铺 songmid（id 换真实值）
curl "http://127.0.0.1:23330/songlist?source=kw&id=1386974461"
# 2) 从上一步响应挑 3 个 songmid，指定目录批量下载；检查 D:/test-dl 出现文件、下载列表 3 个任务
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=1386974461&songmids=id1,id2,id3&quality=320k&dir=D:%5Ctest-dl"
# 3) 整单 + limit 截断（前 2 首）
curl "http://127.0.0.1:23330/download-songlist?source=kw&id=1386974461&limit=2"
# 4) dir 缺省 → 落全局设置目录；带 dir 的任务重启应用后续传仍落原目录（持久化生效）
# 5) 单曲下载 + dir
curl "http://127.0.0.1:23330/download-music?source=kw&name=%E6%99%B4%E5%A4%A9&singer=xxx&songmid=xxx&dir=D:%5Ctest-dl"
# 6) 打开歌单（v1 回归）
curl "http://127.0.0.1:23330/open-songlist?source=kw&id=1386974461"
# 7) 错误路径：缺参 400；不存在的歌单 → /songlist 返回 5xx JSON（应用内不崩）
curl "http://127.0.0.1:23330/songlist?source=kw"
curl "http://127.0.0.1:23330/download-songlist?source=kw"
```

注意（Windows/GitBash）：路径一律正斜杠；URL 里的 `dir` 参数值必须 URL 编码（`\` → `%5C`）。

---

## 5. 坑与注意事项（实现前通读）

1. **deeplink query 值不解码**：复杂参数一律走 `?data=` JSON（本方案已如此）；`/open-songlist` 的链接形态 id 走 path 段。
2. **`/songlist` 依赖渲染进程就绪**：渲染端监听注册晚于请求到达 → 20s 超时 504，可接受，不做排队。
3. **URL 长度**：`songmids` 200 个约 2~6KB，Node 请求头上限 16KB；更大批量让调用方分次调，HTTP 层不做分包。
4. **fire-and-forget 端点的错误表现**：失败弹应用内对话框，HTTP 仍 200，不要加回传机制。
5. **DDL 加列**：`savePath` 持久化需确认 dbService 对老库的 migration 惯例，别只改 CREATE TABLE 导致老用户库缺列报错。
6. **缓存**：`getListDetail` 有 `sdetail__` 缓存；如需强制刷新用 `isRefresh` 参数。`/download-songlist` 用默认缓存即可。
7. **`buildSavePath` 每次启动重算**：自定义目录走 `metadata.savePath` 分支后天然支持暂停续传与重启续传（前提是第 5 条持久化做好）。
8. **`songmids` 未命中静默忽略**：过滤后为空则不建任务、不报错（fire-and-forget 语义）。
9. 提交信息：`feat: 开放 API 新增歌单获取与歌单/单曲下载端点`。
10. 改完只跑 `npm run lint` 和手动 curl，不要引入测试框架。

---

## 6. Suggested skills（若接手方是 ZCode/带 skill 的 agent）

- `implement` —— 按第 3 节落地代码
- `verification-before-completion` —— 宣称完成前先跑完第 4 节并留存输出
