const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FIRST_BYTE_MS = 25_000;
const IDLE_MS = 45_000;
const FIRST_BYTE_COPY = '模型超过 25 秒没有返回内容。请确认接口可从公网访问，或换一个响应更快的模型。';
const IDLE_COPY = '模型输出中断超过 45 秒。请稍后重试，或减少输入后再分析。';

function json(status: number, body: Record<string, unknown>) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function isPrivateHost(host: string) {
  const hostname = host.toLowerCase().replace(/\.$/, '');
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.lan') ||
    hostname === 'metadata.google.internal' ||
    hostname === '::1' ||
    hostname.startsWith('[')
  ) {
    return true;
  }
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const a = Number(ipv4[1]);
  const b = Number(ipv4[2]);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function assertPublicHttps(rawUrl: string) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') throw new Error('只允许 https 模型接口。');
  if (parsed.username || parsed.password) throw new Error('接口地址里不要包含账号密码。');
  if (isPrivateHost(parsed.hostname)) throw new Error('不能使用内网或本机地址作为模型接口。');
  if (!parsed.pathname.endsWith('/chat/completions')) throw new Error('接口路径必须是 OpenAI 兼容的 /chat/completions。');
}

function errorMessageFromBody(status: number, text: string) {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown };
    if (typeof parsed.error === 'string' && parsed.error.trim()) return parsed.error.trim();
    if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
      return parsed.error.message.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) return parsed.message.trim();
  } catch { /* keep fallback */ }
  if (/gateway time-?out|<\s*html[\s>]/i.test(text)) return '模型生成时间过长，转发网关超时。';
  return `模型接口返回 ${status}`;
}

function tokenLimitOf(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 4096;
  return Math.min(Math.max(Math.round(parsed), 256), 8192);
}

Deno.serve((req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json(405, { error: '只接受 POST' });

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (chunk: string | Uint8Array) => {
        if (closed) return;
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const ping = setInterval(() => send(': ping\n\n'), 8_000);
      let abortReason = '';

      try {
        const payload = await req.json() as {
          targetUrl?: unknown;
          apiKey?: unknown;
          model?: unknown;
          messages?: unknown;
          maxTokens?: unknown;
        };
        const targetUrl = String(payload.targetUrl ?? '').trim();
        const apiKey = String(payload.apiKey ?? '').trim();
        const model = String(payload.model ?? '').trim();
        const messages = payload.messages;
        const maxTokens = tokenLimitOf(payload.maxTokens);
        if (!targetUrl || !apiKey || !model || !Array.isArray(messages)) {
          send(`data: ${JSON.stringify({ error: { message: '缺少 targetUrl、apiKey、model 或 messages。' } })}\n\n`);
          close();
          return;
        }
        assertPublicHttps(targetUrl);
        send(': connected\n\n');

        const abort = new AbortController();
        let firstByteTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
          abortReason = 'first-byte';
          abort.abort();
        }, FIRST_BYTE_MS);
        let idleTimer: ReturnType<typeof setTimeout> | undefined;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            abortReason = 'idle';
            abort.abort();
          }, IDLE_MS);
        };

        try {
          const postChat = (extras: Record<string, unknown>) => fetch(targetUrl, {
            method: 'POST',
            redirect: 'error',
            signal: abort.signal,
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              stream: true,
              messages,
              ...extras,
            }),
          });

          let upstream = await postChat({ max_tokens: maxTokens, thinking: { type: 'disabled' } });
          if (!upstream.ok) {
            const text = await upstream.text();
            if (/thinking|max_tokens|max_completion|unknown|unexpected/i.test(text)) {
              upstream = await postChat({ max_tokens: maxTokens });
            } else {
              send(`data: ${JSON.stringify({ error: { message: errorMessageFromBody(upstream.status, text) } })}\n\n`);
              close();
              return;
            }
          }
          if (!upstream.ok) {
            const text = await upstream.text();
            if (/max_tokens|max_completion/i.test(text)) upstream = await postChat({});
            else {
              send(`data: ${JSON.stringify({ error: { message: errorMessageFromBody(upstream.status, text) } })}\n\n`);
              close();
              return;
            }
          }
          if (firstByteTimer) {
            clearTimeout(firstByteTimer);
            firstByteTimer = undefined;
          }
          if (!upstream.ok || !upstream.body) {
            const text = await upstream.text();
            send(`data: ${JSON.stringify({ error: { message: errorMessageFromBody(upstream.status, text) } })}\n\n`);
            close();
            return;
          }

          armIdle();
          const reader = upstream.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              armIdle();
              send(value);
            }
          }
          close();
        } finally {
          if (firstByteTimer) clearTimeout(firstByteTimer);
          if (idleTimer) clearTimeout(idleTimer);
        }
      } catch (error) {
        const copy = abortReason === 'idle'
          ? IDLE_COPY
          : abortReason === 'first-byte' || /timeout|timed out|abort/i.test(error instanceof Error ? error.message : '')
            ? FIRST_BYTE_COPY
            : error instanceof Error ? error.message : '转发模型请求失败。';
        send(`data: ${JSON.stringify({ error: { message: copy } })}\n\n`);
        close();
      } finally {
        clearInterval(ping);
      }
    },
  });

  return new Response(body, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});
