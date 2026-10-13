/** 平台服务端判定登录凭证失效时抛出，用于驱动状态标记与 errorCode 归类 */
export class AuthExpiredError extends Error {
  constructor(message = '登录凭证已过期') {
    super(message)
    this.name = 'AuthExpiredError'
  }
}

/** 凭证有效但该歌曲未返回可用音源（如无版权）时抛出，触发静默复核而非误标过期 */
export class NoSourceError extends Error {
  constructor(message = '未返回可用音源') {
    super(message)
    this.name = 'NoSourceError'
  }
}
