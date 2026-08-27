type SseAcc = { content: string; reasoning?: string };

function textFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.map((part) => {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object') return '';
    const item = part as { text?: unknown; content?: unknown };
    if (typeof item.text === 'string') return item.text;
    if (typeof item.content === 'string') return item.content;
    return '';
  }).join('');
}

function choiceText(choice: { delta?: Record<string, unknown>; message?: Record<string, unknown> } | undefined, key: 'content' | 'reasoning_content') {
  if (!choice) return '';
  return textFromContent(choice.delta?.[key]) || textFromContent(choice.message?.[key]);
}

export function applySseLine(line: string, acc: SseAcc): { error?: string } {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!trimmed || trimmed.startsWith(':')) return {};
  if (!trimmed.startsWith('data:')) return {};
  const data = trimmed.slice(5).trim();
  if (!data || data === '[DONE]') return {};
  try {
    const json = JSON.parse(data) as {
      error?: { message?: unknown } | string;
      choices?: Array<{ delta?: Record<string, unknown>; message?: Record<string, unknown> }>;
    };
    if (json.error) {
      const message = typeof json.error === 'string'
        ? json.error
        : typeof json.error.message === 'string'
          ? json.error.message
          : '模型流式返回错误。';
      return { error: message };
    }
    const choice = json.choices?.[0];
    acc.content += choiceText(choice, 'content');
    acc.reasoning = `${acc.reasoning ?? ''}${choiceText(choice, 'reasoning_content')}`;
  } catch {
    /* ignore malformed chunk */
  }
  return {};
}

const EMPTY_CONTENT_COPY = '模型没有返回正文。DeepSeek V4 默认会先思考，输出额度不够时正文就是空的。请改用 deepseek-v4-flash；若要用视觉模型，名称一般是 deepseek-v4-flash-vision-exp。';

export async function readSseContent(response: Response) {
  if (!response.body) throw new Error('模型没有返回内容。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const acc: SseAcc = { content: '', reasoning: '' };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const result = applySseLine(line, acc);
      if (result.error) throw new Error(result.error);
    }
  }
  if (buffer.trim()) {
    const result = applySseLine(buffer, acc);
    if (result.error) throw new Error(result.error);
  }
  const content = acc.content.trim() || ((acc.reasoning ?? '').includes('{') ? (acc.reasoning ?? '').trim() : '');
  if (!content) throw new Error(EMPTY_CONTENT_COPY);
  return content;
}
