---
status: accepted
---

# 开放 API 的在线歌单数据经渲染进程 requestKey 往返获取

主进程开放 API 服务需要返回在线歌单数据（`GET /songlist`），但全部在线音源请求能力（musicSdk，五源实现 + needle 网络层）只存在于渲染进程 bundle，主进程为零。决定新增一条「主进程发请求 → 渲染进程拉数据 → 带 requestKey 回执」的往返 IPC，照抄自定义源（userApi）已有的 Promise 队列模式（20s 超时），复用渲染进程现成的 `getListDetailAll`；而不是把 musicSdk 移植进主进程，或在主进程另写一套精简请求。

## Considered Options

- **移植/共享 musicSdk 到主进程**：一次大重构（needle 依赖、五源实现、自定义源体系），收益仅省一次 IPC 往返，否决。
- **主进程另写精简歌单请求**：与 musicSdk 五源实现重复、双份维护，否决。
- **requestKey 往返（选定）**：约 45 行，模式在 userApi 链路已长期验证。

## Consequences

- `/songlist` 依赖主窗口渲染进程存活且完成初始化；单请求最长等待 20s（超时 HTTP 504）。
- 后续任何「主进程要在线数据」的开放 API 需求都应扩展这条通道，而不是再开新的。
