import { assertPublicHttps, endpointFor, errorMessage } from './aiErrors.ts';
import { applySseLine } from './aiStream.ts';

const network = errorMessage(new TypeError('Failed to fetch'));
if (network === 'Failed to fetch') {
  console.error('RED: still showing Failed to fetch');
  process.exit(1);
}
if (!network.includes('无法连上模型转发服务')) {
  console.error('RED: expected Chinese network copy, got', network);
  process.exit(1);
}

const timeout = errorMessage(new Error('模型接口返回 504：<html> <head><title>504 Gateway Time-out</title></head>'));
if (timeout.includes('<html') || timeout.includes('Failed to fetch')) {
  console.error('RED: still showing HTML timeout', timeout);
  process.exit(1);
}
if (!timeout.includes('转发网关超时')) {
  console.error('RED: expected gateway timeout copy, got', timeout);
  process.exit(1);
}

const upstream = errorMessage(new Error('模型接口超时，请稍后重试。'));
if (!upstream.includes('超过等待时间仍未返回')) {
  console.error('RED: expected upstream timeout copy, got', upstream);
  process.exit(1);
}

let blocked = false;
try {
  assertPublicHttps('http://127.0.0.1/v1/chat/completions');
} catch {
  blocked = true;
}
if (!blocked) {
  console.error('RED: localhost http should be rejected');
  process.exit(1);
}

const deepseek = endpointFor('https://api.deepseek.com');
if (deepseek !== 'https://api.deepseek.com/v1/chat/completions') {
  console.error('RED: deepseek host should gain /v1', deepseek);
  process.exit(1);
}
const openai = endpointFor('https://api.openai.com/v1');
if (openai !== 'https://api.openai.com/v1/chat/completions') {
  console.error('RED: openai /v1 should append completions', openai);
  process.exit(1);
}
const full = endpointFor('https://api.deepseek.com/v1/chat/completions');
if (full !== 'https://api.deepseek.com/v1/chat/completions') {
  console.error('RED: full path should stay', full);
  process.exit(1);
}

const acc = { content: '' };
applySseLine('data: {"choices":[{"delta":{"content":"你好"}}]}', acc);
applySseLine(': ping', acc);
applySseLine('data: [DONE]', acc);
if (acc.content !== '你好') {
  console.error('RED: SSE delta not concatenated', acc.content);
  process.exit(1);
}
const parts = { content: '' };
applySseLine('data: {"choices":[{"delta":{"content":[{"type":"text","text":"hello"}]}}]}', parts);
if (parts.content !== 'hello') {
  console.error('RED: content array not parsed', parts.content);
  process.exit(1);
}
const reasoned = { content: '', reasoning: '' };
applySseLine('data: {"choices":[{"delta":{"reasoning_content":"think"}}]}', reasoned);
if (reasoned.reasoning !== 'think') {
  console.error('RED: reasoning_content not parsed', reasoned);
  process.exit(1);
}
const failed = applySseLine('data: {"error":{"message":"Authentication Fails"}}', { content: '' });
if (failed.error !== 'Authentication Fails') {
  console.error('RED: SSE error not parsed', failed);
  process.exit(1);
}

console.log('GREEN');
