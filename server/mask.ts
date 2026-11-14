/**
 * 唯一的 key 掩码实现点。
 * 形态：前 5 字符 + `…` + 后 5 字符；不足 12 字符时全部替换为 `*`。
 */
export function mask(key: string): string {
  if (!key) return '***';
  if (key.length < 12) return '*'.repeat(key.length);
  return `${key.slice(0, 5)}…${key.slice(-5)}`;
}

export function maskKeyInRecord<T extends Record<string, unknown>>(
  obj: T,
  keyField = 'key',
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...obj };
  if (typeof result[keyField] === 'string') {
    result[keyField] = mask(result[keyField] as string);
  }
  return result;
}
