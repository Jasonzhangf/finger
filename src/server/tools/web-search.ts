/**
 * Web Search Tool - 多搜索引擎搜索工具
 * 
 * 支持的搜索引擎:
 * 1. DuckDuckGo (HTML 抓取)
 * 2. Bing (通过 jina.ai 代理)
 * 3. Google (通过 jina.ai 代理)
 */

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
}

export interface WebSearchOptions {
  maxResults?: number;
  timeoutMs?: number;
  providers?: string[]; // 优先使用的搜索引擎顺序
}

export interface WebSearchResponse {
  success: boolean;
  results: WebSearchResult[];
  provider?: string;
  attemptedProviders?: string[];
  error?: string;
}

const DEFAULT_PROVIDERS = ['bing', 'duckduckgo'];

/**
 * 通过 jina.ai 代理搜索 (支持 Bing/Google)
 */
async function searchViaJina(
  query: string,
  engine: 'bing' | 'google',
  timeoutMs: number
): Promise<WebSearchResponse> {
  const baseUrl = engine === 'bing'
    ? `https://r.jina.ai/http://www.bing.com/search?q=${encodeURIComponent(query)}`
    : `https://r.jina.ai/http://www.google.com/search?q=${encodeURIComponent(query)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(baseUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FingerBot/1.0)',
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { success: false, results: [], error: `HTTP ${response.status}` };
    }

    const text = await response.text();
    const results = parseMarkdownResults(text, query);
    return { success: true, results, provider: `jina:${engine}` };
  } catch (err) {
    clearTimeout(timeoutId);
    const errorMsg = err instanceof Error ? err.message : String(err);
    return { success: false, results: [], error: errorMsg };
  }
}

/**
 * 通过 DuckDuckGo HTML 搜索
 */
async function searchViaDuckDuckGo(
  query: string,
  timeoutMs: number
): Promise<WebSearchResponse> {
  const https = await import('https');
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      resolve({ success: false, results: [], error: 'Request timeout' });
    }, timeoutMs);

    https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += String(chunk); });
      res.on('end', () => {
        clearTimeout(timeoutId);
        const results = parseDuckDuckGoHtml(data, query);
        resolve({ success: results.length > 0, results, provider: 'duckduckgo' });
      });
    }).on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({ success: false, results: [], error: err.message });
    });
  });
}

/**
 * 解析 jina.ai 返回的 Markdown 格式结果
 */
function parseMarkdownResults(markdown: string, _query: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const lines = markdown.split('\n');

  for (const line of lines) {
    // 匹配格式: [标题](URL)
    const linkMatch = line.match(/\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch && linkMatch[2].startsWith('http')) {
      const title = linkMatch[1].replace(/\*\*/g, '').trim();
      // 过滤掉导航链接和重复链接
      if (title.length > 3 && !results.some(r => r.url === linkMatch[2])) {
        results.push({
          title,
          url: linkMatch[2],
        });
      }
    }
    if (results.length >= 10) break;
  }

  return results;
}

/**
 * 解析 DuckDuckGo HTML 结果
 */
function parseDuckDuckGoHtml(html: string, _query: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const regex = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let match: RegExpExecArray | null = regex.exec(html);

  while (match && results.length < 10) {
    const href = match[1]
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"');
    const title = match[2]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();

    if (title && href.startsWith('http')) {
      results.push({ title, url: href });
    }
    match = regex.exec(html);
  }

  return results;
}

/**
 * 执行网络搜索
 * 按优先级尝试多个搜索引擎，直到成功获取结果
 */
export async function performWebSearch(
  query: string,
  options: WebSearchOptions = {}
): Promise<WebSearchResponse> {
  const {
    maxResults = 5,
    timeoutMs = 15000,
    providers = DEFAULT_PROVIDERS,
  } = options;

  const attemptedProviders: string[] = [];
  let lastError: string | undefined;

  for (const provider of providers) {
    attemptedProviders.push(provider);

    let response: WebSearchResponse;

    if (provider === 'bing' || provider === 'google') {
      response = await searchViaJina(query, provider, timeoutMs);
    } else if (provider === 'duckduckgo') {
      response = await searchViaDuckDuckGo(query, timeoutMs);
    } else {
      continue;
    }

    if (response.success && response.results.length > 0) {
      return {
        ...response,
        results: response.results.slice(0, maxResults),
        attemptedProviders,
      };
    }

    lastError = response.error;
  }

  // 所有引擎都失败
  return {
    success: false,
    results: [],
    attemptedProviders,
    error: lastError || 'All search providers failed',
  };
}
