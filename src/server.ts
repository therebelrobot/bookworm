import { Hono } from 'hono';
import { cors } from 'hono/cors';
import puppeteer from '@cloudflare/puppeteer';
import loggers from './utils/logger';
import type { Env } from './env';

const { server: logger } = loggers;

import { scrapeLegacySite } from './lw/client';
import { performCombinedSearch } from './services/searchService';
import {
  SearchParams,
  MediaTypeFilter,
  SortOption,
  ApiVersion
} from './models/unifiedResult';

// ------------------------
// Hono app (replaces the Express server)
// ------------------------

const app = new Hono<{ Bindings: Env }>();

// Enable CORS for all origins
app.use('*', cors());

// Configuration for services (read from Worker bindings/vars instead of process.env)
const getLegacyConfig = (env: Env) => ({
  legacySiteUrl: env.LEGACY_SITE_URL || 'http://example.com'
});

const getYclConfig = (env: Env, librarySlug: string | undefined) => {
  if (!env.YCL_HOST) return null;
  // A per-request slug wins; otherwise fall back to the Worker's configured
  // slug. Both the auth URL and the search itself must use the same slug.
  const slug = librarySlug || env.YCL_LIBRARY_SLUG || '';
  return {
    host: env.YCL_HOST,
    protocol: (env.YCL_PROTOCOL || 'https') as 'https' | 'http',
    librarySlug: slug,
    authUrl: env.YCL_AUTH_URL ? `${env.YCL_AUTH_URL}/${slug}/featured` : ''
  };
};

// Health check endpoint
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    services: {
      legacy: true,
      ycl: !!getYclConfig(c.env, ''),
    }
  });
});

// Legacy endpoint for backward compatibility
app.get('/api/scrape', async (c) => {
  const searchQuery = c.req.query('search');
  const pageParam = c.req.query('page');
  const username = c.req.query('username') || '';
  const password = c.req.query('password') || '';
  const targetPage = pageParam && !isNaN(parseInt(pageParam, 10))
    ? parseInt(pageParam, 10)
    : 1;

  if (!searchQuery) {
    return c.json({ error: 'Search query is required' }, 400);
  }
  if (!username || username.trim() === '') {
    return c.json({ error: 'Username is required' }, 400);
  }

  const browser = await puppeteer.launch(c.env.BROWSER);

  try {
    const page = await browser.newPage();
    const legacyResult = await scrapeLegacySite({
      search: searchQuery,
      username,
      password,
      targetPage,
      page,
      legacySiteUrl: getLegacyConfig(c.env).legacySiteUrl,
      cookieCache: c.env.COOKIE_CACHE,
    });
    logger.info(`Scraping for ${username} with term "${searchQuery}" on page ${targetPage} completed. Found ${legacyResult.results.length} books.`);
    return c.json(legacyResult);
  } catch (error) {
    logger.error('Error scraping legacy site:', error);
    return c.json({ error: 'Scraping failed' }, 500);
  } finally {
    await browser.close().catch(err => {
      logger.warn(`Error closing browser (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    });
  }
});

// New combined search endpoint
app.get('/api/search', async (c) => {
  try {
    // Log incoming request for debugging
    logger.info(`Search request received: ${c.req.url}`);
    logger.debug('Request headers:', Object.fromEntries(c.req.raw.headers));

    // Extract and validate parameters
    const searchQuery = c.req.query('search');
    const username = c.req.query('username') || '';
    const password = c.req.query('password') || '';
    // Fall back to the Worker's configured slug so callers don't have to know it
    // and combined search isn't silently reduced to print-only when it's omitted.
    const librarySlug = c.req.query('librarySlug') || c.env.YCL_LIBRARY_SLUG || undefined;

    // Parse numeric parameters
    const pageParam = c.req.query('page');
    const pageSizeParam = c.req.query('pageSize');
    const page = pageParam && !isNaN(parseInt(pageParam, 10))
      ? parseInt(pageParam, 10)
      : 1;
    const pageSize = pageSizeParam && !isNaN(parseInt(pageSizeParam, 10))
      ? parseInt(pageSizeParam, 10)
      : 10;

    // Parse enum parameters
    const mediaType = (c.req.query('mediaType') as MediaTypeFilter) || 'combined';
    const sortBy = (c.req.query('sortBy') as SortOption) || 'relevance';
    const version = (c.req.query('version') as ApiVersion) || 'v2';

    logger.info('Search parameters:', {
      search: searchQuery,
      username,
      librarySlug,
      page,
      pageSize,
      mediaType,
      sortBy,
      version
    });

    // Validate required parameters
    if (!searchQuery) {
      return c.json({ error: 'Search query is required' }, 400);
    }
    if (!username || username.trim() === '') {
      return c.json({ error: 'Username is required' }, 400);
    }

    // Validate enum parameters
    const validMediaTypes: MediaTypeFilter[] = ['physical', 'digital', 'combined'];
    const validSortOptions: SortOption[] = ['relevance', 'availability', 'title', 'author', 'date'];
    const validVersions: ApiVersion[] = ['v1', 'v2'];

    if (mediaType && !validMediaTypes.includes(mediaType as MediaTypeFilter)) {
      return c.json({
        error: `Invalid mediaType. Must be one of: ${validMediaTypes.join(', ')}`
      }, 400);
    }

    if (sortBy && !validSortOptions.includes(sortBy as SortOption)) {
      return c.json({
        error: `Invalid sortBy. Must be one of: ${validSortOptions.join(', ')}`
      }, 400);
    }

    if (version && !validVersions.includes(version as ApiVersion)) {
      return c.json({
        error: `Invalid version. Must be one of: ${validVersions.join(', ')}`
      }, 400);
    }

    // Launch the Browser Rendering session with error handling
    let browser;
    try {
      logger.info('Launching browser...');
      browser = await puppeteer.launch(c.env.BROWSER).catch(err => {
        logger.error('Failed to connect to browser:', err);
        throw new Error(`Browser connection failed: ${err.message}`);
      });
      logger.info('Browser launched successfully');
    } catch (browserError) {
      logger.error('Browser setup error:', browserError);
      return c.json({
        error: 'Search failed',
        message: 'Failed to set up browser for search',
        details: browserError instanceof Error ? browserError.message : String(browserError)
      }, 500);
    }

    try {
      const puppeteerPage = await browser.newPage().catch(err => {
        logger.error('Failed to create new page:', err);
        throw new Error(`Failed to create browser page: ${err.message}`);
      });

      // Prepare search parameters
      const searchParams: SearchParams = {
        search: searchQuery as string,
        username: username as string,
        password: password as string,
        librarySlug,
        page,
        pageSize,
        mediaType: mediaType as MediaTypeFilter,
        sortBy: sortBy as SortOption,
        version: version as ApiVersion
      };

      // Get configurations
      const legacyConfig = getLegacyConfig(c.env);
      const yclConfig = getYclConfig(c.env, librarySlug);

      // Set a timeout for the entire search operation
      const searchPromise = performCombinedSearch(
        legacyConfig,
        yclConfig,
        searchParams,
        puppeteerPage,
        c.env.COOKIE_CACHE
      );

      // Add a timeout to prevent hanging
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Search operation timed out after 60 seconds')), 60000);
      });

      // Race the search against the timeout
      const searchResult = await Promise.race([searchPromise, timeoutPromise])
        .catch(err => {
          logger.error('Search operation failed or timed out:', err);
          // Return a partial result with just legacy results if available
          return {
            meta: {
              currentPage: page,
              pageSize: pageSize,
              totalResults: 0,
              totalPages: 0,
              mediaTypeCounts: {
                physical: 0,
                digital: 0
              }
            },
            results: [] as any[]
          };
        });

      // Format response based on version
      if (version === 'v1') {
        // For v1, format response to match legacy format
        const legacyFormat = {
          meta: {
            currentPage: searchResult.meta.currentPage,
            pageSize: searchResult.meta.pageSize,
            totalResults: searchResult.meta.totalResults,
            totalPages: searchResult.meta.totalPages
          },
          results: searchResult.results.map((item: any) => {
            if (item.mediaType === 'physical') {
              // Convert to legacy format for physical items
              return {
                bookJacketUrl: item.imageUrl,
                googlePreviewUrl: item.additionalDetails.googlePreviewUrl,
                title: item.title,
                expandedAuthor: item.author,
                author: item.author,
                extraFields: item.additionalDetails.extraFields || {},
                description: item.description,
                availability: item.availability,
                copies: item.copies
              };
            } else {
              // For digital items, include a mediaType field to distinguish them
              return {
                bookJacketUrl: item.imageUrl,
                title: item.title,
                author: item.author,
                extraFields: {},
                description: item.description,
                availability: item.availability,
                copies: item.copies,
                mediaType: 'digital'
              };
            }
          })
        };

        return c.json(legacyFormat);
      }

      // For v2, return the new format
      return c.json(searchResult);
    } catch (error) {
      logger.error('Error performing combined search:', error);

      // Enhanced error logging with more details
      logger.error('Search error details:', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        searchQuery,
        username,
        librarySlug,
        mediaType,
        page,
        pageSize
      });

      // Return a more specific error message if available
      if (error instanceof Error && error.message.includes('Invalid character in header')) {
        return c.json({
          error: 'Search failed due to invalid header characters',
          details: 'This is likely due to special characters in the cookie or other headers'
        }, 500);
      }

      return c.json({
        error: 'Search failed',
        message: error instanceof Error ? error.message : String(error)
      }, 500);
    } finally {
      // Safely close the browser
      if (browser) {
        try {
          await browser.close().catch(err => {
            logger.warn(`Error closing browser (non-fatal): ${err.message}`);
          });
        } catch (closeError) {
          logger.warn('Error in browser.close():', closeError);
        }
      }
    }
  } catch (error) {
    logger.error('Unexpected error in search endpoint:', error);
    logger.error('Error details:', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url: c.req.url,
      query: c.req.query()
    });

    // Send a detailed error response
    return c.json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error occurred',
      timestamp: new Date().toISOString()
    }, 500);
  }
});

// Global error handler (mirrors the Express unhandledRejection/uncaughtException guards)
app.onError((error, c) => {
  logger.error('Unhandled error:', error);
  return c.json({
    error: 'Internal server error',
    message: error instanceof Error ? error.message : 'Unknown error occurred'
  }, 500);
});

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
