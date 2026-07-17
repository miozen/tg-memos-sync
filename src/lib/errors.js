export class ApiError extends Error {
  constructor(service, status, message, retryable = false) {
    super(`${service}: ${message}`);
    this.name = "ApiError";
    this.service = service;
    this.status = status;
    this.retryable = retryable;
  }
}

export function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

export function formatPublicError(error) {
  if (error instanceof ApiError) return `HTTP ${error.status}: ${error.message.replace(/^\w+:\s*/, "").slice(0, 160)}`;
  return "临时服务异常";
}
