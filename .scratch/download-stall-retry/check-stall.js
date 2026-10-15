/* eslint-disable */
// 下载卡住检测自检：验证 Downloader 的 10s 看门狗、传输中断报错、暂停静音、正常完成
// 运行：node .scratch/download-stall-retry/check-stall.js（需先 tsc 编译 dist/）
const http = require('http')
const os = require('os')
const path = require('path')
const fs = require('fs')
const Downloader = require('./dist/Downloader.js').default

const results = []
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lx-stall-check-'))

const once = (emitter, ev) => new Promise(resolve => emitter.once(ev, resolve))
const delay = ms => new Promise(r => setTimeout(r, ms))

function freshFile(name) {
  const file = path.join(tmpDir, name)
  try { fs.unlinkSync(file) } catch (_) {}
  return file
}

// A: 响应头后服务器停止发数据 → ~10s 内报 'download timeout'
async function testStallTimeout() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(1024 * 1024) })
    res.write(Buffer.alloc(64 * 1024))
    // 之后故意不发任何数据
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/a.mp3`
  const dl = new Downloader(url, tmpDir, 'stall.mp3', {})
  const start = Date.now()
  void dl.start()
  const err = await once(dl, 'error')
  const elapsed = Date.now() - start
  server.close()
  const ok = err.message === 'download timeout' && elapsed >= 9500 && elapsed <= 13000
  results.push(['A 10s看门狗', ok, `msg=${err.message} elapsed=${elapsed}ms`])
  try { fs.unlinkSync(path.join(tmpDir, 'stall.mp3')) } catch (_) {}
}

// B: 服务器提前断开（未传完）→ 必须报错而不是静默卡死
async function testTruncated() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(1024 * 1024) })
    res.write(Buffer.alloc(200 * 1024))
    setTimeout(() => { res.destroy() }, 100) // 掐断连接
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/b.mp3`
  const dl = new Downloader(url, tmpDir, 'trunc.mp3', {})
  const start = Date.now()
  void dl.start()
  const events = await new Promise(resolve => {
    const got = []
    const onErr = (...v) => { got.push(['error', v[0].message]); finish() }
    const finish = () => { dl.removeListener('error', onErr); resolve(got) }
    dl.on('error', onErr)
    setTimeout(finish, 8000) // 8s 无事件 = 旧 bug（静默卡死）
  })
  const elapsed = Date.now() - start
  server.close()
  const ok = events.some(([ev, msg]) => ev === 'error' && msg !== 'socket hang up') || elapsed < 8000 && events.length === 0 && false
  results.push(['B 传输中断报错', events.length > 0 && events[0][0] === 'error', JSON.stringify(events)])
  try { fs.unlinkSync(path.join(tmpDir, 'trunc.mp3')) } catch (_) {}
}

// C: 暂停（stop）→ 不允许外抛任何 error（守卫生效）
async function testPauseQuiet() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(20 * 1024 * 1024) })
    const timer = setInterval(() => {
      if (res.destroyed) { clearInterval(timer); return }
      res.write(Buffer.alloc(64 * 1024))
    }, 50)
    req.on('close', () => clearInterval(timer))
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/c.mp3`
  const dl = new Downloader(url, tmpDir, 'pause.mp3', {})
  const errors = []
  dl.on('error', e => errors.push(e.message))
  dl.start()
  await delay(800) // 让数据流动起来
  const stopP = once(dl, 'stop')
  await dl.stop()
  await stopP
  await delay(1500) // 等 destroy 产生的连带事件
  server.close()
  const ok = errors.length === 0
  results.push(['C 暂停静音', ok, errors.length ? `意外错误: ${errors.join('|')}` : '无错误外抛'])
  try { fs.unlinkSync(path.join(tmpDir, 'pause.mp3')) } catch (_) {}
}

// D: 正常下载 → completed，文件完整
async function testHappyPath() {
  const body = Buffer.alloc(300 * 1024, 7)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-length': String(body.length) })
    res.end(body)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${server.address().port}/d.mp3`
  const dl = new Downloader(url, tmpDir, 'happy.mp3', {})
  await new Promise((resolve, reject) => {
    dl.on('completed', resolve)
    dl.on('error', reject)
    dl.start()
  })
  server.close()
  const size = fs.statSync(path.join(tmpDir, 'happy.mp3')).size
  const ok = size === body.length
  results.push(['D 正常完成', ok, `size=${size}`])
  try { fs.unlinkSync(path.join(tmpDir, 'happy.mp3')) } catch (_) {}
}

(async () => {
  await testStallTimeout()
  await testTruncated()
  await testPauseQuiet()
  await testHappyPath()
  let failed = 0
  for (const [name, ok, detail] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`)
    if (!ok) failed++
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  process.exit(failed ? 1 : 0)
})()
