import { ReadableStream } from 'node:stream/web';
import { describe, expect, it } from 'vitest';
import {
  aggregateAnthropicSseToMessage,
  cacheHitRate,
  collectAnthropicUsage,
  extractAnthropicJsonUsage,
  extractAnthropicMessageText,
  type StreamUsage,
} from './usage.js';

function streamFromStrings(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function drainText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

describe('Anthropic 用量采集与聚合', () => {
  it('collectAnthropicUsage 零修改透传字节流，并合并 message_start 与 message_delta 用量', async () => {
    const raw =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"m1","model":"MiniMax-M3","usage":{"input_tokens":43,"output_tokens":0,"cache_creation_input_tokens":64,"cache_read_input_tokens":128}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    let captured: StreamUsage | null = null;
    const collected = collectAnthropicUsage(streamFromStrings([raw.slice(0, 80), raw.slice(80)]), (u) => {
      captured = u;
    });
    const out = await drainText(collected);
    expect(out).toBe(raw);
    expect(captured).toEqual({
      promptTokens: 43 + 64 + 128,
      completionTokens: 17,
      cachedTokens: 128,
      totalTokens: 43 + 64 + 128 + 17,
    });
    expect(cacheHitRate(captured!.cachedTokens, captured!.promptTokens)).toBeCloseTo(128 / 235, 5);
  });

  it('无 usage 时不触发回调', async () => {
    let called = false;
    const raw = 'event: ping\ndata: {"type":"ping"}\n\n';
    const collected = collectAnthropicUsage(streamFromStrings([raw]), () => {
      called = true;
    });
    await drainText(collected);
    expect(called).toBe(false);
  });

  it('extractAnthropicJsonUsage 与 SSE 采集口径完全一致', () => {
    const usage = extractAnthropicJsonUsage({
      id: 'm1',
      type: 'message',
      usage: {
        input_tokens: 120,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 40,
        output_tokens: 30,
      },
    });
    expect(usage).toEqual({
      promptTokens: 180,
      completionTokens: 30,
      cachedTokens: 40,
      totalTokens: 210,
    });
  });

  it('aggregateAnthropicSseToMessage 将思考、文本、tool_use 与缓存字段完整聚合为 Message JSON', async () => {
    const raw =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"msg_9","model":"MiniMax-M3","usage":{"input_tokens":10,"output_tokens":0,"cache_read_input_tokens":50}}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"想一下"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"答案"}}\n\n' +
      'event: content_block_start\n' +
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tu_1","name":"get_weather","input":{}}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"city\\":\\"Beijing\\"}"}}\n\n' +
      'event: message_delta\n' +
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":12}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';

    const msg = await aggregateAnthropicSseToMessage(streamFromStrings([raw]), 'MiniMax-M3');
    expect(msg).toEqual({
      id: 'msg_9',
      type: 'message',
      role: 'assistant',
      model: 'MiniMax-M3',
      content: [
        { type: 'thinking', thinking: '想一下' },
        { type: 'text', text: '答案' },
        { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'Beijing' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 10,
        output_tokens: 12,
        cache_read_input_tokens: 50,
      },
    });

    const extracted = extractAnthropicMessageText(msg);
    expect(extracted.text).toBe('想一下答案');
    expect(extracted.toolCalls).toHaveLength(1);
    expect(extracted.finishReason).toBe('tool_use');
  });
});
