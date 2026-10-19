/* ================================================================================================
 *  ycl/client.ts
 *
 *  HTTP client for the YCL online e-book catalogue, running on Cloudflare Workers.
 *  ────────────────────────────────────────────────────────────────────────────────────────────────
 *  Contains **two** helpers:
 *    • catalogSearch  – endpoint that lists items (search/filters)
 *    • catalogDetail  – endpoint that returns metadata for one item
 *
 *  This is a Workers port of the original `got`-based client. Changes:
 *    • Uses the platform `fetch` (Workers have no raw sockets / `got`).
 *    • Drops HTTP/2 pseudo-headers (`:path`, `:authority`, …) — `fetch` derives them from the URL.
 *    • Drops `accept-encoding` and manual gzip/br decompression — `fetch` negotiates and decodes.
 * ==============================================================================================*/

import loggers from '../utils/logger';

const { ycl: logger } = loggers;

/** Plain header map. Pseudo-headers (`:`-prefixed) are not supported by `fetch`. */
export type HeaderMap = Record<string, string>;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  CONSTANTS
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

const STATIC_HEADERS: HeaderMap = {
  accept: '*/*',
  'accept-language': 'en-US,en;q=0.9',
  'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'sec-ch-ua': '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
  priority: 'u=1, i',
};

const DEFAULT_QUERY_PARAMS = {
  format: '',
  available: 'any',
  language: '',
  sort: '',
  orderBy: 'relevence',
  owned: 'yes',
} as const;

const REQUEST_TIMEOUT_MS = 30000;

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  TYPES
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

export interface CatalogClientOptions {
  host: string;
  protocol?: 'https' | 'http';
  librarySlug: string;
  cookie: string;
  headers?: HeaderMap;
}

export interface SearchOptions extends CatalogClientOptions {
  /** Optional plain-text search term */
  searchText?: string;
  /** Optional additional / overriding query-string filters */
  extraParams?: Record<string, string>;
}

export interface DetailOptions extends CatalogClientOptions {
  itemId: string;
}

export interface CatalogResponse<T = unknown> {
  rawBody: Uint8Array;
  json?: T;
  headers: HeaderMap;
  status: number;
}

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  INTERNAL HELPERS
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

/** Encode search term: `+` inside query-string, `%20` inside Referer */
const encodeSearchText = (txt: string) => {
  const uri = encodeURIComponent(txt);
  return { forQuery: uri.replace(/%20/g, '+'), forReferer: uri };
};

/**
 * Sanitize cookie string to remove invalid characters
 * that might cause header validation to fail.
 */
const sanitizeCookie = (cookie: string | string[]): string => {
  if (Array.isArray(cookie)) {
    return cookie
      .filter(c => typeof c === 'string')
      .map(c => c.replace(/[^\x20-\x7E]/g, ''))
      .join('; ');
  }

  // Handle multi-line cookies by splitting on newlines
  if (cookie.includes('\n')) {
    const cookieLines = cookie.split('\n');

    // Look specifically for the __config_PROD cookie which is known to work
    const configCookieLine = cookieLines.find(line => line.startsWith('__config_PROD='));

    if (configCookieLine) {
      const parts = configCookieLine.split(';');
      return parts[0].trim();
    }

    const validCookieLines = cookieLines.filter(line => !line.startsWith('__session_PROD=;'));
    const cookiePairs = validCookieLines.map(line => {
      const parts = line.split(';');
      return parts[0].trim();
    });

    return cookiePairs.join('; ').replace(/[^\x20-\x7E]/g, '');
  }

  if (cookie.startsWith('__config_PROD=')) {
    const parts = cookie.split(';');
    return parts[0].trim();
  }

  // Remove control characters, non-ASCII chars, and other problematic characters
  return cookie.replace(/[^\x20-\x7E]/g, '');
};

/**
 * Merge static, caller and per-request headers into a `fetch`-compatible header map.
 * Any `:`-prefixed pseudo-headers in the overrides are dropped.
 */
const buildHeaders = (overrides: HeaderMap, referer: string, cookie: string): HeaderMap => {
  const safeOverrides: HeaderMap = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (!key.startsWith(':') && typeof value === 'string') {
      safeOverrides[key] = value;
    }
  }

  return {
    ...STATIC_HEADERS,
    referer,
    cookie: sanitizeCookie(cookie),
    ...safeOverrides,
  };
};

const doRequest = async <T = unknown>(url: string, headers: HeaderMap): Promise<CatalogResponse<T>> => {
  try {
    // Log headers for debugging (but redact cookie value for security)
    const debugHeaders = { ...headers };
    if (debugHeaders.cookie) {
      debugHeaders.cookie = debugHeaders.cookie.substring(0, 15) + '...';
    }
    logger.debug(`Request: ${url}`);

    const rsp = await fetch(url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    logger.debug(`Response status: ${rsp.status}`);
    return await processResponse<T>(rsp);
  } catch (err) {
    logger.error('Request failed:', {
      url,
      error: err instanceof Error ? err.message : String(err),
    });

    throw new Error(`catalog-client error: ${String(err)}`);
  }
};

// Helper function to process response
const processResponse = async <T = unknown>(rsp: Response): Promise<CatalogResponse<T>> => {
  const raw = new Uint8Array(await rsp.arrayBuffer());

  const headers: HeaderMap = {};
  rsp.headers.forEach((value, key) => {
    headers[key] = value;
  });
  // `set-cookie` is not exposed through forEach; read it explicitly.
  const setCookie = rsp.headers.get('set-cookie');
  if (setCookie) headers['set-cookie'] = setCookie;

  let json: T | undefined;
  if ((headers['content-type'] ?? '').startsWith('application/json')) {
    try {
      json = JSON.parse(new TextDecoder().decode(raw));
    } catch (jsonError) {
      logger.error('Error parsing JSON response:', jsonError);
      logger.debug('Raw response preview:', new TextDecoder().decode(raw).substring(0, 200) + '...');
    }
  }

  return { rawBody: raw, json, headers, status: rsp.status };
};

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  SEARCH
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

/**
 * Perform a search or browse request.
 *
 * `searchText` *and* `extraParams.query` are optional: you may call this with
 * category filters (e.g. `author`, `subject`, etc.) only, which mimics how the
 * site behaves when you browse without a free-text query.
 */
export const catalogSearch = async <T = unknown>({
  host,
  protocol = 'https',
  librarySlug,
  searchText,
  extraParams,
  cookie,
  headers = {},
}: SearchOptions): Promise<CatalogResponse<T>> => {
  const enc = searchText?.trim() ? encodeSearchText(searchText) : null;

  const paramsObj = {
    ...DEFAULT_QUERY_PARAMS,
    ...extraParams,
    ...(enc ? { query: enc.forQuery } : {})
  };

  // Add the _data parameter directly to the query string to avoid double-encoding
  const params = new URLSearchParams(paramsObj).toString();
  const dataParam = '_data=routes%2Flibrary.%24name.search';
  const fullParams = params ? `${params}&${dataParam}` : dataParam;

  const PATH = `/library/${librarySlug}/search?${fullParams}`;
  // Referer mirrors the visible URL the user would have in the address bar
  const REFERER =
    enc
      ? `${protocol}://${host}/library/${librarySlug}/search?query=${enc.forReferer}`
      : `${protocol}://${host}/library/${librarySlug}/search${params ? `?${params}` : ''}`;

  const URL_FULL = `${protocol}://${host}${PATH}`;
  const hdrs = buildHeaders(headers, REFERER, cookie);
  return doRequest(URL_FULL, hdrs);
};

/* ════════════════════════════════════════════════════════════════════════════════════════════════
 *  DETAIL
 * ════════════════════════════════════════════════════════════════════════════════════════════════*/

export const catalogDetail = async <T = unknown>({
  host,
  protocol = 'https',
  librarySlug,
  itemId,
  cookie,
  headers = {},
}: DetailOptions): Promise<CatalogResponse<T>> => {
  const DATA_PARAM = '_data=routes%2Flibrary.%24name.detail.%24id';
  const PATH = `/library/${librarySlug}/detail/${itemId}?${DATA_PARAM}`;
  const REFERER = `${protocol}://${host}/library/${librarySlug}/detail/${itemId}`;
  const URL_FULL = `${protocol}://${host}${PATH}`;

  const hdrs = buildHeaders(headers, REFERER, cookie);
  return doRequest(URL_FULL, hdrs);
};
