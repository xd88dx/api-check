import { describe, expect, it } from 'vitest';
import { mask, maskKeyInRecord } from './mask';

describe('mask', () => {
  it('长度 >= 12：前5 + … + 后5', () => {
    expect(mask('sk-84abcdEFGVEQJ')).toBe('sk-84…GVEQJ');
  });

  it('正好 12 字符', () => {
    expect(mask('123456789012')).toBe('12345…89012');
  });

  it('长度 < 12：全掩码，长度保持一致', () => {
    expect(mask('sk-test')).toBe('*******');
  });

  it('空字符串返回 ***', () => {
    expect(mask('')).toBe('***');
  });

  it('占位符 sk-test-xxxxxxxxxxxxx 正确掩码', () => {
    expect(mask('sk-test-abcdefghijklmnop')).toBe('sk-te…lmnop');
  });
});

describe('maskKeyInRecord', () => {
  it('对对象的 key 字段掩码', () => {
    expect(maskKeyInRecord({ key: 'sk-test-abcdefghijklmnop', label: 'x' })).toEqual({
      key: 'sk-te…lmnop',
      label: 'x',
    });
  });

  it('key 非字符串时原样返回', () => {
    expect(maskKeyInRecord({ key: 123 } as never)).toEqual({ key: 123 });
  });
});
