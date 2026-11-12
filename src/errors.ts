/**
 * 上游错误（反代层按 Anthropic 错误体返回给客户端，保留上游状态码）。
 */
export class UpstreamError extends Error {
  override readonly name = 'UpstreamError';
  constructor(
    message: string,
    readonly status?: number,
    readonly rawBody?: string,
  ) {
    super(message);
  }
}

/** 凭证类错误（启动 / doctor / max-cache 锁定用：提示用户跑 login，而不是抛栈）。 */
export class CredentialError extends Error {
  override readonly name = 'CredentialError';
  constructor(message: string) {
    super(message);
  }
}
