# lx-music-desktop 开放 API

lx-music-desktop 主进程内置的本地 HTTP 服务（默认端口 23330），供外部脚本控制播放器。本词汇表围绕「开放 API 扩展：歌单与下载」工作沉淀。

## Language

### 歌单

**歌单获取（Fetch Songlist）**:
读接口：按在线源与歌单 ID 返回歌单信息与曲目列表（每首含唯一 songmid），供调用方软件挑选曲目。
_Avoid_: 与「打开歌单」混用（那是纯界面动作）

**打开歌单（Open Songlist）**:
纯界面动作：应用跳转到该在线歌单详情页并加载曲目，HTTP 响应不回传歌单数据。
_Avoid_: 获取歌单

**歌单下载（Download Songlist）**:
写指令：按调用方提供的曲目唯一 ID（songmid）列表批量创建下载任务，可指定逐任务的下载目录；不提供列表则整单下载，可用 limit 截断。
_Avoid_: 下单（易与电商语义混淆）、一键下载

**单曲下载（Download Music）**:
调用方直接传入一首歌的元数据（name/singer/songmid 等）创建下载任务，不依赖歌单。

### 音源与音乐源

**音乐源（Music Source）**:
在线平台 kw / kg / tx / wy / mg，歌曲数据（歌单、搜索、曲目信息）的来源。
_Avoid_: 源、平台

**音源（User API）**:
自定义源脚本（如「野花」「Huibq」），把一首歌解析成可播放/可下载链接的提供方；每个音源声明自己支持哪些音乐源与音质。应用同一时刻只有一个音源生效。
_Avoid_: 下载源、API 源、与「音乐源」混用

**换源（Toggle Source）**:
同一首歌在所属音乐源拿不到链接时，在其他音乐源搜索匹配同曲并改用其链接。
_Avoid_: 换音源（那是切换 User API 脚本）

### 通道

**deeplink 桥**:
主进程经 `global.lx.event_app.deeplink()` 派发 `lxmusic://` 链接到渲染进程既有动作体系的单向通道。开放 API 的指令类端点统一走此桥，不新增 IPC。
