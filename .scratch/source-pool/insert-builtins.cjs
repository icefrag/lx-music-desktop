// 一次性脚本：把 3 个池内置源条目插入 src/main/modules/userApi/config/index.ts（gz_ 压缩，单引号风格）
const fs = require('fs')
const target = 'src/main/modules/userApi/config/index.ts'
let src = fs.readFileSync(target, 'utf8')
const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"
const defs = [
  ['changqing', '长青SVIP音源', '音源更新，关注微信公众号: 元力菌', 'SVIP', '1.3.0'],
  ['huanyin', '幻音音源', '', '竹佀', 'v3'],
  ['qdy', '全豆要[聚合音源]', '迭代9.3版本，聚合 星海/溯音/念心/长青/歌一刀专属汽水音乐，多链路...', '全豆要 and Gemini优化 Toskysun去混淆 TZB679兼容性处理', '9.3 93特供版 DeepSeek优化'],
]
const EOL = '\r\n'
const entries = defs.map(([id, name, desc, author, version]) => {
  const gz = fs.readFileSync('.scratch/source-pool/builtin_' + id + '.txt', 'utf8')
  return [
    '  {',
    '    id: ' + q('user_api_builtin_' + id) + ',',
    '    name: ' + q(name) + ',',
    '    description: ' + q(desc) + ',',
    '    script: ' + q(gz) + ',',
    '    allowShowUpdateAlert: false,',
    '    author: ' + q(author) + ',',
    "    homepage: '',",
    '    version: ' + q(version) + ',',
    '  },',
  ].join(EOL)
}).join(EOL)
const anchor = src.lastIndexOf('},\r\n]')
if (anchor < 0) { console.error('anchor not found'); process.exit(1) }
src = src.slice(0, anchor + 3) + entries + EOL + ']' + src.slice(anchor + 6)
fs.writeFileSync(target, src)
console.log('inserted, size:', src.length, '| double quotes remaining:', (src.match(/"/g) || []).length)
