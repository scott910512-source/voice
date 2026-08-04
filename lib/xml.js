'use strict';

/**
 * 공공데이터포털 응답용 최소 XML 파서.
 * 외부 의존성 없이 동작해야 하므로 필요한 범위(요소/텍스트/CDATA/속성 무시)만 다룬다.
 */

const ENTITIES = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

function decodeEntities(text) {
  return text
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => ENTITIES[m])
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function assign(target, key, value) {
  if (!(key in target)) {
    target[key] = value;
    return;
  }
  if (Array.isArray(target[key])) {
    target[key].push(value);
    return;
  }
  target[key] = [target[key], value];
}

/**
 * XML 문자열을 평범한 객체로 변환한다.
 * 텍스트만 가진 요소는 문자열이 되고, 자식이 있는 요소는 객체가 된다.
 * 같은 이름이 반복되면 배열로 모인다.
 */
function parseXml(xml) {
  const cleaned = String(xml)
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '');

  const root = {};
  const stack = [{ node: root, text: '' }];
  const tokenPattern = /<([^>]+)>/g;
  let lastIndex = 0;
  let token;

  while ((token = tokenPattern.exec(cleaned)) !== null) {
    const between = cleaned.slice(lastIndex, token.index);
    if (between) stack[stack.length - 1].text += between;
    lastIndex = tokenPattern.lastIndex;

    let raw = token[1];

    if (raw.startsWith('![CDATA[')) {
      // 정규식이 ']]>' 앞에서 잘랐을 수 있으므로 원문에서 직접 끝을 찾는다.
      const start = token.index + '<![CDATA['.length;
      const end = cleaned.indexOf(']]>', start);
      const value = end === -1 ? cleaned.slice(start) : cleaned.slice(start, end);
      stack[stack.length - 1].text += value;
      tokenPattern.lastIndex = end === -1 ? cleaned.length : end + 3;
      lastIndex = tokenPattern.lastIndex;
      continue;
    }

    if (raw.startsWith('/')) {
      const frame = stack.pop();
      if (!frame || stack.length === 0) continue;
      const parent = stack[stack.length - 1];
      const text = decodeEntities(frame.text).trim();
      const hasChildren = Object.keys(frame.node).length > 0;
      assign(parent.node, frame.name, hasChildren ? frame.node : text);
      continue;
    }

    const selfClosing = raw.endsWith('/');
    if (selfClosing) raw = raw.slice(0, -1);
    const name = raw.trim().split(/[\s/]+/)[0];
    if (!name) continue;

    if (selfClosing) {
      assign(stack[stack.length - 1].node, name, '');
      continue;
    }
    stack.push({ node: {}, text: '', name });
  }

  return root;
}

module.exports = { parseXml };
