// classify() 回归测试：大响应（>300 字符）截断后判 ok 迹象（E 组实锤：2xx 大响应误判 error）
import { describe, it, expect } from 'vitest';
import { classify, snippet } from './classify.js';

// 构造响应体：okMarker（choices/data/models）位于 300 字符之后，整串是合法 JSON
function bigBody(marker: 'choices' | 'data' | 'models', payload: unknown): string {
  const pad = 'x'.repeat(400);
  return JSON.stringify({ note: pad, [marker]: payload });
}

describe('classify 大响应回归（截断曾致 2xx 误判 error）', () => {
  it('chat 形态：2xx + choices 在 300 字符后 → ok', () => {
    const body = bigBody('choices', [{ message: { content: 'pong' } }]);
    expect(body.length).toBeGreaterThan(300);
    expect(body.indexOf('choices')).toBeGreaterThanOrEqual(300);
    expect(classify({ httpStatus: 200, body, timedOut: false, okMarkers: ['choices'] })).toBe('ok');
  });

  it('目录形态：2xx + data 在 300 字符后 → ok', () => {
    const body = bigBody('data', [{ id: 'gpt-4o-mini' }]);
    expect(body.length).toBeGreaterThan(300);
    expect(body.indexOf('data')).toBeGreaterThanOrEqual(300);
    expect(classify({ httpStatus: 200, body, timedOut: false, okMarkers: ['data'] })).toBe('ok');
  });

  it('gemini 目录形态：2xx + models 在 300 字符后 → ok', () => {
    const body = bigBody('models', [{ name: 'models/gemini-x' }]);
    expect(classify({ httpStatus: 200, body, timedOut: false, okMarkers: ['models'] })).toBe('ok');
  });

  it('对照：截断到 300 字符确实判 error（复现原始缺陷）', () => {
    const body = bigBody('data', [{ id: 'gpt-4o-mini' }]);
    expect(classify({ httpStatus: 200, body: snippet(body), timedOut: false, okMarkers: ['data'] })).toBe('error');
  });

  it('snippet 仍只截 300 字符（SPEC §6 展示规则不变）', () => {
    const body = bigBody('data', [{ id: 'gpt-4o-mini' }]);
    expect(snippet(body)).toBe(body.slice(0, 300));
  });
});
