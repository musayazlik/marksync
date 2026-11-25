import { describe, expect, it } from 'vitest';
import { formatUsd, parseKeyUsage, parseModels, searchModels, usageGauge } from '../src/core/openrouter-data';

const list = {
  data: [
    {
      id: 'anthropic/claude-opus-5.5',
      name: 'Anthropic: Claude Opus 5.5',
      created: 300,
      context_length: 200000,
      pricing: { prompt: '0.000015', completion: '0.000075' },
      architecture: { output_modalities: ['text'] },
      supported_parameters: ['tools', 'temperature'],
    },
    {
      id: 'google/gemini-3.5-flash-lite',
      name: 'Google: Gemini 3.5 Flash Lite',
      created: 200,
      context_length: 1048576,
      pricing: { prompt: '0.0000001', completion: '0.0000004' },
      supported_parameters: ['tools'],
    },
    { id: 'meta/llama-free:free', name: 'Meta: Llama (free)', created: 100, pricing: { prompt: '0', completion: '0' } },
    { id: 'openai/image-gen', name: 'OpenAI: Image', created: 400, architecture: { output_modalities: ['image'] } },
    { id: 'openrouter/auto', name: 'Auto Router', created: 50, pricing: { prompt: '-1', completion: '-1' } },
    { id: 'not a model', name: 'bad' },
    { id: 'anthropic/claude-opus-5.5', name: 'duplicate' },
    'junk',
  ],
};

describe('model list', () => {
  const models = parseModels(list);

  it('keeps text models, newest first, without duplicates or bad IDs', () => {
    expect(models.map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5.5',
      'google/gemini-3.5-flash-lite',
      'meta/llama-free:free',
      'openrouter/auto',
    ]);
    expect(parseModels(undefined)).toEqual([]);
  });

  it('converts prices to USD per million tokens and reads tool support', () => {
    expect(models[0]).toMatchObject({ prompt: 15, completion: 75, tools: true, context: 200000, free: false });
    expect(models[1]!.prompt).toBeCloseTo(0.1);
    expect(models[2]).toMatchObject({ free: true, tools: false });
    // Variable pricing (-1) is unknown, not free.
    expect(models[3]!.prompt).toBeUndefined();
    expect(models[3]!.free).toBe(false);
  });

  it('searches every word in the ID or name and ranks prefix matches first', () => {
    expect(searchModels(models, 'opus').map((m) => m.id)).toEqual(['anthropic/claude-opus-5.5']);
    expect(searchModels(models, 'flash google').map((m) => m.id)).toEqual(['google/gemini-3.5-flash-lite']);
    expect(searchModels(models, 'gemini')[0]!.id).toBe('google/gemini-3.5-flash-lite');
    expect(searchModels(models, 'nothing-like-this')).toEqual([]);
    expect(searchModels(models, '')).toHaveLength(4);
  });

  it('filters free models and models with tools', () => {
    expect(searchModels(models, '', 'free').map((m) => m.id)).toEqual(['meta/llama-free:free']);
    expect(searchModels(models, '', 'tools').map((m) => m.id)).toEqual([
      'anthropic/claude-opus-5.5',
      'google/gemini-3.5-flash-lite',
    ]);
  });
});

describe('key usage', () => {
  it('uses the key limit when the key has one', () => {
    const u = parseKeyUsage(
      {
        data: {
          label: 'marksync',
          limit: 10,
          limit_remaining: 6.5,
          limit_reset: 'monthly',
          usage: 3.5,
          usage_daily: 0.2,
          usage_weekly: 1,
          usage_monthly: 3.5,
          is_free_tier: false,
        },
      },
      { data: { total_credits: 50, total_usage: 20 } },
      1000,
    );
    expect(u).toMatchObject({ label: 'marksync', limit: 10, remaining: 6.5, reset: 'monthly', daily: 0.2, checkedAt: 1000 });
    expect(u.account).toEqual({ total: 50, used: 20 });
    expect(usageGauge(u)).toEqual({ source: 'key', left: 6.5, total: 10, used: 3.5 });
  });

  it('falls back to the account balance, then to spending only', () => {
    const unlimited = { data: { limit: null, limit_remaining: null, usage: 4, is_free_tier: false } };
    expect(usageGauge(parseKeyUsage(unlimited, { data: { total_credits: 25, total_usage: 30 } }))).toEqual({
      source: 'account',
      left: 0,
      total: 25,
      used: 30,
    });
    const u = parseKeyUsage(unlimited, undefined);
    expect(u.limit).toBeUndefined();
    expect(u.account).toBeUndefined();
    expect(usageGauge(u)).toEqual({ source: 'none', used: 4 });
  });

  it('ignores malformed answers', () => {
    const u = parseKeyUsage({ data: { limit: 'x', usage: -3, limit_reset: 'yearly' } }, 'nope');
    expect(u).toMatchObject({ usage: 0, freeTier: false, label: '' });
    expect(u.limit).toBeUndefined();
    expect(u.reset).toBeUndefined();
  });
});

describe('formatUsd', () => {
  it('keeps small amounts visible', () => {
    expect(formatUsd(0, 'en-US')).toBe('$0');
    expect(formatUsd(12.5, 'en-US')).toBe('$12.50');
    expect(formatUsd(15, 'en-US')).toBe('$15');
    expect(formatUsd(0.42, 'en-US')).toBe('$0.42');
    expect(formatUsd(0.3, 'en-US')).toBe('$0.30');
    expect(formatUsd(0.0031, 'en-US')).toBe('$0.0031');
    expect(formatUsd(250, 'en-US')).toBe('$250');
  });
});
