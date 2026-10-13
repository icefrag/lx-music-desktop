# 0003 - 酷狗取链走网页端通道（encode_album_audio_id 两步取链）

日期：2026-10-13 ｜ 状态：Accepted

## 背景

酷狗账号音源上线真机验证时，登录状态正常但解析全部失败。逐层排查（诊断日志 + 登录分区请求抓包对比网页播放器真实请求）定位出四层叠加问题：

1. **cookie 捕获键写错**：酷狗网页登录实际写入 `KugooID`（注意大小写）与复合 cookie `KuGoo`（`&` 分隔的 k=v 串，内含 `t`=登录令牌、`KugooID`、`NickName` 等），而非预设的 `KuGooID`/`token` → 登录后应用一直判定「未登录」。
2. **通道平台错配**：网页登录凭证配 Android 端 `trackercdn v5/url` 通道（appid 1005）时，酷狗一律返回 `error_code 20018`（token 与 appid 平台不匹配，见 KuGouMusicApi `login_qr_authorize.js` 注释）。
3. **网页端通道参数语义**：`wwwapi.kugou.com/play/songinfo` 的真实参数形态（逆向自网页播放器 `playbyAudio.js` + `getBaseInfo.min.js`）：`clienttime` 为**毫秒**；`uuid` 参数取值就是 `mid`；token 来自 `KuGoo` cookie 的 `t` 字段且需与 `userid` 成对提交。
4. **决定性差异**：网页播放器只用 `encode_album_audio_id`（base36 形态的编码 ID）定位歌曲；用 `hash`+数字 `album_id`/`album_audio_id` 形态请求时，签名与身份校验都通过（`status:1`），但 `has_privilege:false`、`play_url` 为空——酷狗在这种形态下不结算会员权限。`hash` 形态响应的 `data.encode_album_audio_id` 会回传该编码 ID。

## 决策

酷狗解析器（`resolvers/kg.ts`）主通道为网页端 `play/songinfo`：

1. 凭证从分区 cookie 解析：`KuGoo` 复合 cookie 解出 `t`/`KugooID`（`parseKuGooCookie`），设备 `mid` 用 `kg_mid` 原值，`dfid` 用 `kg_dfid`。
2. 第一步按 `hash`+`album_id`+`album_audio_id` 请求；若 `play_url` 为空，取响应里的 `encode_album_audio_id` **原样重发一次**（仅带编码 ID，与浏览器请求完全同形态）——此形态服务端才按登录账号权限结算并返回直链。
3. Android 端 `v5/url` 保留为最后兜底（当前对网页凭证恒报 20018，实际不可用，留作平台后续开放时的占位）。
4. 登录捕获键为 `['t', 'KugooID']`。

## 排查方法论（复用价值）

- 主进程解析器加 `[account-source:<platform>]` 前缀日志，真机重试即可看到平台原始响应。
- 疑难平台在登录分区（`persist:account_source_<platform>`）上挂 `webRequest.onBeforeSendHeaders` 抓包，让用户在登录窗口里正常操作，即可获得平台官方前端的真实请求（URL + Cookie），与本方请求逐项 diff。
- 本轮问题没有一个单一「原因」：cookie 键、通道平台、参数语义、参数形态四层各自都能造成失败，必须逐层消除并用抓包对照验证。

## 后果

- 酷狗取链依赖网页播放器行为（`encode_album_audio_id` 两步取链），平台前端若变更参数形态需同步调整。
- `clienttime` 必须为毫秒：秒级时间戳会通过签名校验但被服务端静默视为过期请求、降权处理——此类「校验通过但静默降级」的行为无法从错误码察觉，只能靠对照抓包发现。
- 诊断日志（解析失败原因、平台原始响应）保留一条精简失败日志于 `requestUrl`，便于后续过期/风控问题定位。
