// M3/D8：i18n 审计脚本——扫描组件内裸英文文本与字典孤儿键。
// 用法：node scripts/i18n_audit.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const I18N = join(ROOT, 'web/src/i18n');
const SRC = join(ROOT, 'web/src');

function loadDict(file) {
  const raw = readFileSync(join(I18N, file), 'utf8');
  const keys = new Set();
  for (const m of raw.matchAll(/^\s*'([^']+)'\s*:/gm)) keys.add(m[1]);
  return keys;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx') || p.endsWith('.ts')) out.push(p);
  }
  return out;
}

const zh = loadDict('zh.ts');
const en = loadDict('en.ts');

// 1. 字典键一致性
const onlyZh = [...zh].filter((k) => !en.has(k));
const onlyEn = [...en].filter((k) => !zh.has(k));

// 2. 扫描组件：提取所有 t('...') 引用键，报告未定义键；检查 JSX 中的裸英文文本
const files = walk(SRC);
const usedKeys = new Set();
const dynamicPrefixes = [];
const bareTextHits = [];

for (const file of files) {
  const src = readFileSync(file, 'utf8');
  // t('key') / t("key") 静态引用；t(`prefix.${expr}`) 动态前缀引用
  for (const m of src.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) usedKeys.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*`([^`$]*)\$\{/g)) dynamicPrefixes.push(m[1]);
  // 检测 JSX 文本节点中包含英文单词的裸文本（粗扫：>...< 之间的内容）
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只扫 .tsx；跳过注释与明显的类型签名行
    if (!file.endsWith('.tsx')) continue;
    if (/^\s*\/\//.test(line)) continue;
    if (/\)\s*:\s*(Promise|void)/.test(line)) continue;
    for (const m of line.matchAll(/>([^<>]+)</g)) {
      const text = m[1].trim();
      if (!text) continue;
      // 代码类片段（泛型/箭头/三元/调用/联合类型）与单 token 跳过，只留疑似自然语言
      if (/[=>?:;(){}[\]|]/.test(text)) continue;
      if (!/\s/.test(text)) continue;
      if (/[A-Za-z]/.test(text)) {
        bareTextHits.push(`${file.replace(ROOT, '')}:${i + 1}: ${text}`);
      }
    }
  }
}

const usedUndefined = [...usedKeys].filter((k) => !zh.has(k) && !en.has(k));
const orphans = [...zh].filter(
  (k) => !usedKeys.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)),
);

console.log('=== i18n audit ===');
console.log(`zh keys: ${zh.size}, en keys: ${en.size}, used keys: ${usedKeys.size}`);
console.log(`\nonly in zh (${onlyZh.length}):`); onlyZh.forEach((k) => console.log('  ' + k));
console.log(`\nonly in en (${onlyEn.length}):`); onlyEn.forEach((k) => console.log('  ' + k));
console.log(`\nused but undefined (${usedUndefined.length}):`); usedUndefined.forEach((k) => console.log('  ' + k));
console.log(`\ndefined but unused (orphans, ${orphans.length}):`); orphans.forEach((k) => console.log('  ' + k));
console.log(`\nsuspected bare English text in JSX (${bareTextHits.length}):`);
bareTextHits.forEach((h) => console.log('  ' + h));

const issues = onlyZh.length + onlyEn.length + usedUndefined.length + bareTextHits.length;
console.log(`\n${issues === 0 ? 'CLEAN' : issues + ' issue(s) found'}`);
process.exit(issues === 0 ? 0 : 1);
