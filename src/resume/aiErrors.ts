const NETWORK_ERROR = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i;
const GATEWAY_TIMEOUT = /504|gateway time-?out|<\s*html[\s>]|<\s*head[\s>]|<\s*title[\s>]/i;
const GATEWAY_TIMEOUT_COPY = '模型生成时间过长，转发网关超时。请稍后重试；也可先减少已确认事实或缩短 JD。';
const UPSTREAM_TIMEOUT = /模型接口超时|超过 25 秒没有返回|输出中断超过 45 秒/i;
const UPSTREAM_TIMEOUT_COPY = '模型超过等待时间仍未返回内容。请确认接口可从公网访问，或换一个响应更快的模型；也可少勾几条事实后再试。';

export function endpointFor(baseUrl: string) {
  const clean = baseUrl.trim().replace(/\/+$/, '');
  if (!clean) return clean;
  if (/\/chat\/completions$/i.test(clean)) return clean;
  try {
    const parsed = new URL(clean);
    const path = parsed.pathname.replace(/\/+$/, '');
    if (!path || path === '/') {
      parsed.pathname = '/v1/chat/completions';
      return parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    return `${clean}/chat/completions`;
  }
  return `${clean}/chat/completions`;
}

export function assertPublicHttps(rawUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('接口地址不是合法 URL。请填写 https:// 开头的 OpenAI 兼容地址。');
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('当前页面只能转发 https 接口。请把接口地址改成 https:// 后重试。');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan') ||
    host === 'metadata.google.internal'
  ) {
    throw new Error('不能使用内网或本机地址作为模型接口。');
  }
  if (isPrivateHost(host)) {
    throw new Error('不能使用内网 IP 作为模型接口。');
  }
  if (parsed.username || parsed.password) {
    throw new Error('接口地址里不要包含账号密码。');
  }
}

function isPrivateHost(host: string) {
  if (host === '::1' || host.startsWith('[')) return true;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function errorMessage(error: unknown, fallback = '操作未完成，请检查配置后重试。') {
  const raw = error && typeof error === 'object' && 'message' in error && typeof (error as { message?: unknown }).message === 'string'
    ? (error as { message: string }).message
    : '';
  if (!raw) return fallback;
  if (NETWORK_ERROR.test(raw)) {
    return '无法连上模型转发服务。请确认当前页面来自本应用域名后刷新重试；接口地址须为 https。';
  }
  if (GATEWAY_TIMEOUT.test(raw)) return GATEWAY_TIMEOUT_COPY;
  if (UPSTREAM_TIMEOUT.test(raw)) return UPSTREAM_TIMEOUT_COPY;
  return raw;
}
