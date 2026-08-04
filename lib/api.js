'use strict';

const { parseXml } = require('./xml');

const DEFAULT_ENDPOINT = 'https://apis.data.go.kr/5690000/sjRoadSign';
const DEFAULT_OPERATION = 'sj_00000270';

/**
 * 공공데이터포털 인증키 처리.
 * 포털은 Encoding 키(%2B, %3D 포함)와 Decoding 키(+, = 포함)를 함께 준다.
 * 쿼리스트링에는 인코딩된 형태가 정확히 한 번만 들어가야 한다.
 */
function encodeServiceKey(key) {
  const trimmed = String(key || '').trim();
  if (!trimmed) throw new Error('SERVICE_KEY가 비어 있습니다.');
  // 이미 퍼센트 인코딩된 키로 보이면 그대로 쓴다. 다시 인코딩하면 %가 %25로 이중 인코딩된다.
  if (/%[0-9A-Fa-f]{2}/.test(trimmed)) return trimmed;
  return encodeURIComponent(trimmed);
}

function buildUrl({ endpoint, operation, serviceKey, pageNo, numOfRows, type, extra }) {
  const params = [
    `serviceKey=${encodeServiceKey(serviceKey)}`,
    `pageNo=${encodeURIComponent(pageNo)}`,
    `numOfRows=${encodeURIComponent(numOfRows)}`,
    `type=${encodeURIComponent(type)}`,
  ];
  for (const [key, value] of Object.entries(extra || {})) {
    if (value === undefined || value === null || value === '') continue;
    params.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
  }
  const base = `${endpoint.replace(/\/+$/, '')}/${operation}`;
  return `${base}?${params.join('&')}`;
}

async function fetchWithRetry(url, { timeoutMs = 15000, retries = 3 } = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json, text/xml;q=0.9, */*;q=0.5' },
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
      return body;
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 2 ** attempt * 1000));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** 어디에 담겨 오든 레코드 배열을 찾아낸다. (item / row / record / data …) */
function extractItems(payload) {
  const seen = new Set();
  const queue = [payload];
  const candidates = [];

  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);

    for (const [key, value] of Object.entries(node)) {
      if (!value || typeof value !== 'object') continue;
      const isRecordKey = /^(item|row|record|data|list)s?$/i.test(key);
      if (Array.isArray(value)) {
        const objects = value.filter((v) => v && typeof v === 'object' && !Array.isArray(v));
        if (objects.length) candidates.push({ key, items: objects, score: isRecordKey ? 2 : 1 });
      } else if (isRecordKey) {
        // 결과가 1건이면 배열이 아니라 객체 하나로 올 수 있다.
        const values = Object.values(value);
        const looksLikeRecord = values.some((v) => typeof v !== 'object');
        if (looksLikeRecord) candidates.push({ key, items: [value], score: 2 });
      }
      queue.push(value);
    }
  }

  if (!candidates.length) return [];
  candidates.sort((a, b) => b.score - a.score || b.items.length - a.items.length);
  return candidates[0].items;
}

/** totalCount / resultCode / resultMsg 를 위치에 상관없이 찾는다. */
function findScalar(payload, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const seen = new Set();
  const queue = [payload];
  while (queue.length) {
    const node = queue.shift();
    if (!node || typeof node !== 'object' || seen.has(node)) continue;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) {
      if (value && typeof value === 'object') {
        queue.push(value);
        continue;
      }
      if (wanted.includes(key.toLowerCase())) return value;
    }
  }
  return null;
}

function parseBody(body) {
  const trimmed = body.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    return { payload: JSON.parse(trimmed), format: 'json' };
  }
  if (trimmed.startsWith('<')) {
    return { payload: parseXml(trimmed), format: 'xml' };
  }
  throw new Error(`알 수 없는 응답 형식입니다: ${trimmed.slice(0, 200)}`);
}

/**
 * 한 페이지를 가져온다. JSON을 먼저 시도하고, 실패하거나 비어 있으면 XML로 재시도한다.
 * (지자체 API는 type=json을 무시하고 XML 오류를 돌려주는 경우가 있다.)
 */
async function fetchPage(config, pageNo) {
  const attempts = [];
  for (const type of ['json', 'xml']) {
    const url = buildUrl({
      endpoint: config.endpoint,
      operation: config.operation,
      serviceKey: config.serviceKey,
      pageNo,
      numOfRows: config.numOfRows,
      type,
      extra: config.extraParams,
    });
    try {
      const body = await fetchWithRetry(url, { timeoutMs: config.timeoutMs, retries: config.retries });
      const { payload, format } = parseBody(body);
      const items = extractItems(payload);
      const resultCode = findScalar(payload, ['resultCode', 'errMsg', 'returnReasonCode']);
      const resultMsg = findScalar(payload, ['resultMsg', 'returnAuthMsg', 'errMsg']);

      if (!items.length && resultCode && !/^0*0$/.test(String(resultCode))) {
        throw new Error(`API 오류 (resultCode=${resultCode}): ${resultMsg || '메시지 없음'}`);
      }
      if (!items.length) {
        attempts.push(`${type}: 레코드 0건 (${resultMsg || '응답 본문에서 목록을 찾지 못함'})`);
        continue;
      }
      const totalCount = Number(findScalar(payload, ['totalCount', 'total', 'totCnt'])) || items.length;
      return { items, totalCount, format, requestedType: type, resultMsg: resultMsg || null };
    } catch (error) {
      attempts.push(`${type}: ${error.message}`);
    }
  }
  throw new Error(`페이지 ${pageNo} 조회 실패 → ${attempts.join(' | ')}`);
}

/**
 * 전체 페이지를 순회한다. maxRecords로 일일 트래픽(5,000건)을 넘지 않게 막는다.
 *
 * 페이지 수를 numOfRows로 계산하면 안 된다. 이 API는 numOfRows=500을 보내도
 * 페이지당 20건만 돌려주므로, 그렇게 계산하면 1페이지에서 멈춰 111건 중
 * 20건만 받는다. 실제로 받은 건수가 totalCount에 도달할 때까지 돌린다.
 */
async function fetchAll(config) {
  const startedAt = Date.now();
  const first = await fetchPage(config, 1);
  const items = [...first.items];
  const limit = Math.min(first.totalCount || items.length, config.maxRecords);
  // 페이지 크기가 0이면 무한 루프가 되므로 실제 수신 건수를 하한으로 쓴다.
  const maxPages = Math.min(config.maxPages, Math.ceil(limit / Math.max(items.length, 1)) + 2);

  // 2페이지부터는 재시도를 줄인다. 이 API는 뒤쪽 페이지에서 응답이 멎는
  // 일이 있는데, 1페이지와 같은 재시도/타임아웃을 주면 전체 조회가
  // 몇 분씩 매달린다. 여기서는 빨리 포기하고 받은 만큼 쓰는 편이 낫다.
  const pageConfig = { ...config, retries: Math.min(config.retries, 1), timeoutMs: Math.min(config.timeoutMs, 8000) };
  const notes = [];

  for (let page = 2; items.length < limit && page <= maxPages; page += 1) {
    if (Date.now() - startedAt > config.deadlineMs) {
      notes.push(`시간 상한(${Math.round(config.deadlineMs / 1000)}초) 초과로 ${page - 1}페이지에서 중단`);
      break;
    }
    let next;
    try {
      next = await fetchPage(pageConfig, page);
    } catch (error) {
      // 뒤쪽 페이지가 실패해도 앞에서 받은 것은 살린다.
      notes.push(`${page}페이지 실패: ${error.message}`);
      break;
    }
    if (!next.items.length) {
      notes.push(`${page}페이지가 비어 있어 중단`);
      break;
    }
    items.push(...next.items);
  }

  const fetchedCount = Math.min(items.length, limit);
  return {
    items: items.slice(0, limit),
    totalCount: first.totalCount,
    fetchedCount,
    pageSize: first.items.length,
    format: first.format,
    requestedType: first.requestedType,
    truncated: first.totalCount > fetchedCount,
    notes,
    elapsedMs: Date.now() - startedAt,
  };
}

module.exports = {
  DEFAULT_ENDPOINT,
  DEFAULT_OPERATION,
  buildUrl,
  encodeServiceKey,
  extractItems,
  fetchAll,
  fetchPage,
  parseBody,
};
