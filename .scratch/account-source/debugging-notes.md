# 账号音源排障笔记（避免重复踩坑）

> 生成：2026-10-14。来源：酷狗「待校验/下载失败」排障过程。协议事实均为当日实测。

## 最大的坑：dev 与正式版数据目录不同

| 目录 | 归属 |
|---|---|
| `%APPDATA%/Electron` | **dev 模式**（`npm run dev`）。runner 用 `electron.exe dist/main.js` 直接跑脚本文件，应用名是 Electron 默认名 |
| `%APPDATA%/lx-music-desktop` | **正式安装版** |

后果与教训：

- 登录态、应用设置（音源、Open API 开关、下载目录）、`Partitions/` 分区 cookie 全在 `%APPDATA%/Electron` 下。**排障第一步：确认目标实例用的是哪个 userData**。
- 两边设置互不同步：正式版 Open API 关、音源野花；dev 版 Open API 开、音源野草。看到「config 和运行行为矛盾」先怀疑目录搞错。
- 确认运行实例真实 userData 的办法：连 `--inspect` 调试口执行 `app.getPath('userData')`；或看 `%APPDATA%/Electron/Partitions/*` 的 mtime。不要靠猜。
- 历史：2026-10-13 夜间排障在正式版目录里找 dev 的登录态，误判「酷狗从未登录 / 重启丢登录」，让用户重复登录多次。实际 dev 的分区 cookie 一直正常落盘在 `%APPDATA%/Electron/Partitions/account_source_kg`。

## 酷狗协议事实（2026-10-14 实测，对应代码 resolvers/kg.ts）

1. 网页登录的登录态写在**复合 cookie `KuGoo`**（& 分隔的 k=v 串，内含 t=令牌、KugooID、UserName）。独立的 `t`/`KugooID` cookie 只在部分登录方式下才写入。登录检测必须认 KuGoo 并校验值（`const.ts` 的 `checkLoginCookieValue`），否则出现「页面已登录但应用检测不到」。
2. **网页 token 过不了安卓网关**：usercenter `get_my_info`（appid 1005）对网页 token 恒报 20018（平台不符）；叠加时间戳单位错误时报 20006。校验凭证不要走安卓网关——validate 已改用网页 songinfo 探针（`VALIDATE_PROBE_SONG`）。
3. `play/songinfo`（网页通道，盐 `NVPh5oo7...`）**匿名请求一律 err 30020**（免费歌也一样），有登录态才返回 status=1 + play_url。它是可靠的凭证探针：status=1 有效；30020/301 = 凭证失效。
4. clienttime 单位：安卓通道（gateway.kugou.com，盐 `OIlwieks...`）一律**秒**；网页通道（wwwapi.kugou.com）**毫秒**。参考实现 MakcRe/KuGouMusicApi。
5. songinfo 带 `hash` + `album_audio_id=0` 可能只回元数据不给 play_url；用响应里的 `encode_album_audio_id` 重试一次能拿到（resolver 已内置此重试）。

## 诊断手段速查

- 主进程日志：`npm run dev` 终端，`[account-source:kg]` 前缀的诊断日志（token 只打前 6 位）。
- Open API（dev 版默认开启，端口 23330）：`/account-source-status`（**含被设置 UI 吞掉的 message 字段**）、`/download-music`、`/download-status`、`/status`。
- 设置 UI 不显示 `status.message`——校验失败的具体原因只能从 `/account-source-status` 或日志看。
- 运行中主进程调试：`--inspect=5858`。注意 CDP `Runtime.evaluate` 上下文里 `require` 不可用，要用 `process.mainModule.require('electron')`（直接用 `require` 会静默得到空结果，极具误导性）。

## tx 通道事实（2026-10-14 实测，对应代码 resolvers/tx.ts）

1. 经典明文 vkey 通道（`vkey.GetVkeyServer` + musicu.fcg GET `data=` 形态）正被 QQ 大范围风控：`req_0.code=500003 subcode=860100005`、req_0 无 data 字段。GET/POST、TLS 指纹、请求形态均无关（全部实测排除）。
2. **现行方案（已实测可用）**：`POST https://u.y.qq.com/cgi-bin/musics.fcg`，query `sign=zzc...`（算法见 resolver 的 `zzcSign`：SHA1 摘要下标重排 + 扰码表异或 + base64 去符号 + 小写），body `{"comm":{ct:24,cv:0,uin,format,authst:qm_keyst,tmeLoginType},"req_0":{module:"music.vkey.GetVkey",method:"UrlGetVkey",param:{...}}}`。签名必须与发送的 JSON 字节完全一致。参考实现：L-1124/QQMusicApi（zzc_sign + VersionProfile）。
3. **直链文件名必须用真实 media_mid**（`music.pf_song_detail_svr/get_song_detail_yqq` 可查）。media_mid ≠ songmid 时用 songmid 拼文件名：vkey 照常发放（msg 仍 fnameHitCache_200），但 CDN 实际 404——msg 不可信，别用它判断文件名对错。
4. purl 是相对路径，前缀 `http://isure.stream.qqmusic.qq.com/`；vkey 有效期 7200 秒。
5. 500003 → RiskControlError（队列冷却指数退避）；其余非零 code 归为接口异常。
6. 野花/野草等免费自定义源是**纯服务端代理**（客户端脚本只是拼作者服务器的 URL 加 md5 签名，如 http://97.64.37.235/url/{源}/{id}/{音质}），QQ 协议在作者服务器上，源失效只能等作者修。

## 待办

- （无）tx 风控问题已修复（issues/02，resolved）。
