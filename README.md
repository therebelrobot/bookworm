# Library Media Search API

A unified API for searching both physical and digital media from library sources. This service combines results from a legacy library system (physical media) and the YCL digital assets service (ebooks, etc.).

## Features

- **Combined Search**: Search across both physical and digital media in a single API call
- **Filtering**: Filter results by media type (physical/digital/combined)
- **Sorting**: Sort results by relevance, availability, title, or author
- **Unified Pagination**: Consistent pagination across combined results
- **Backward Compatibility**: Maintains the legacy API endpoint for existing clients
- **Graceful Degradation**: Falls back to available services if one is unavailable

## Getting Started

### Prerequisites

- Node.js (v18 or higher) with npm
- A Cloudflare account on the **Workers Paid** plan (Browser Rendering is required for scraping)
- Access credentials for the legacy library system (sent per request as query params)
- Access to the YCL digital assets service (optional)

### Installation

1. Clone the repository:
   ```
   git clone <repository-url>
   cd api
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Create the KV namespace that caches login cookies, and copy the id it prints:
   ```
   npx wrangler kv namespace create COOKIE_CACHE
   ```

4. Paste that id into `wrangler.jsonc` (`kv_namespaces[0].id`), then store every
   environment-specific value as a secret (they are never committed):
   ```
   npx wrangler secret put LEGACY_SITE_URL     # base URL of your Legacy Library site
   npx wrangler secret put YCL_HOST            # digital assets host
   npx wrangler secret put YCL_PROTOCOL        # https | http (optional; defaults to https)
   npx wrangler secret put YCL_LIBRARY_SLUG    # your digital library slug
   npx wrangler secret put YCL_AUTH_URL        # digital auth URL
   ```
   Configuration is no longer read from a `.env` file at runtime; for local dev,
   put the same values in a gitignored `.dev.vars` file, which `wrangler dev`
   loads automatically.

### Running Locally

Create your local secrets file from the template (it is gitignored):
```
cp .dev.vars.example .dev.vars   # then fill in real values
```

Start the Worker dev server (uses a real browser via the Browser Rendering binding,
so run `npx wrangler login` first):
```
npm run dev        # wrangler dev
```

The API will be available at http://localhost:8787.

Type-check the project with:
```
npm run typecheck
```

### Deploying to Cloudflare Workers

```
npm run deploy     # wrangler deploy
```

### npm scripts

| Script | Description |
| --- | --- |
| `npm run dev` | Start the local dev server (`wrangler dev`) at http://localhost:8787 |
| `npm run build` | Bundle and validate without uploading (`wrangler deploy --dry-run`, output in `dist/`) |
| `npm run deploy` | Build and deploy the Worker (`wrangler deploy`) |
| `npm run tail` | Stream live logs from the deployed Worker |
| `npm run check` | Run `typecheck` then `build` (handy in CI) |
| `npm run typecheck` | Type-check with `tsc --noEmit` |
| `npm run cf-typegen` | Regenerate `worker-configuration.d.ts` from your bindings |
| `npm run login` / `logout` / `whoami` | Cloudflare authentication helpers |
| `npm run secrets:list` | List the Worker's secrets |
| `npm run secrets:put -- <NAME>` | Create or update one secret (prompts for the value) |
| `npm run secrets:push` | Upload every key in `.dev.vars` (`wrangler secret bulk`) |
| `npm run secrets:delete -- <NAME>` | Delete a secret |
| `npm run kv:create` | Create the `COOKIE_CACHE` KV namespace |
| `npm run kv:list` | List KV namespaces |

## API Endpoints

### Health Check

```
GET /health
```

Returns the operational status of the server and its services.

### Legacy Search (Backward Compatibility)

```
GET /api/scrape
```

Parameters:
- `search` (required): The search term
- `username` (required): Legacy system username
- `password` (optional): Legacy system password
- `page` (optional, default: 1): Page number

Returns search results from the legacy system only (physical media).

### Combined Search

```
GET /api/search
```

Parameters:
- `search` (required): The search term
- `username` (required): Legacy system username
- `password` (optional): Legacy system password
- `librarySlug` (optional): YCL library identifier. Defaults to the Worker's
  `YCL_LIBRARY_SLUG` secret; digital search is only skipped when neither is set.
- `page` (optional, default: 1): Page number for unified pagination
- `pageSize` (optional, default: 10): Number of results per page
- `mediaType` (optional, default: "combined"): Filter type - "physical", "digital", or "combined"
- `sortBy` (optional, default: "relevance"): Sort order - "relevance", "availability", "title", "author", "date"
- `version` (optional, default: "v2"): API response version - "v1" for legacy format, "v2" for new format

Returns combined search results from both physical and digital sources.

> **Pagination note:** the legacy (physical) source is paged by the upstream
> catalogue. The digital (YCL) source ignores `offset`/`limit` and returns its
> entire result set, so the Worker applies `page`/`pageSize` to the digital
> results itself before merging. Combined ordering is therefore approximate —
> see the follow-up note in the code for details.

## Response Format

### v1 Format (Legacy)

```json
{
  "meta": {
    "currentPage": 1,
    "pageSize": 10,
    "totalResults": 100,
    "totalPages": 10
  },
  "results": [
    {
      "bookJacketUrl": "https://example.com/image.jpg",
      "googlePreviewUrl": "https://books.google.com/...",
      "title": "Book Title",
      "expandedAuthor": "Author Name",
      "author": "Author Name",
      "extraFields": {
        "Publisher": "Example Publisher",
        "ISBN": "1234567890"
      },
      "description": "Book description...",
      "availability": "Available",
      "copies": 2,
      "mediaType": "digital" // Only present for digital items
    }
  ]
}
```

### v2 Format (New)

```json
{
  "meta": {
    "currentPage": 1,
    "pageSize": 10,
    "totalResults": 100,
    "totalPages": 10,
    "mediaTypeCounts": {
      "physical": 40,
      "digital": 60
    }
  },
  "results": [
    {
      "id": "unique-id",
      "title": "Book Title",
      "author": "Author Name",
      "description": "Book description...",
      "mediaType": "physical|digital",
      "imageUrl": "https://example.com/image.jpg",
      "availability": "Available",
      "copies": 2,
      "format": "Book|eBook|Audiobook",
      "source": "legacy|ycl",
      "sourceId": "original-id-in-source-system",
      "additionalDetails": {
        "isbn": "1234567890",
        "publisher": "Example Publisher"
      }
    }
  ]
}
```

## Development

### Project Structure

```
wrangler.jsonc                # Worker name, bindings (BROWSER, COOKIE_CACHE) and vars
src/
├── server.ts                 # Worker entry point (Hono app; replaces the Express server)
├── env.ts                    # Worker binding/config types
├── lw/                       # Legacy system client
│   └── client.ts             # Legacy scraping via Browser Rendering
├── ycl/                      # YCL digital assets client
│   ├── client.ts             # YCL API client
│   ├── constants.ts          # YCL constants
│   ├── enums.ts              # YCL enums
│   └── getRedirectSetCookie.ts # YCL authentication helper
├── models/
│   └── unifiedResult.ts      # Unified result model
├── services/
│   ├── legacyService.ts      # Legacy service
│   ├── yclService.ts         # YCL service
│   └── searchService.ts      # Combined search service
```

### Cloudflare Workers notes

This service was ported from a long-running Node/Express process to a Cloudflare Worker:

- **Scraping** uses Cloudflare Browser Rendering through `@cloudflare/puppeteer`
  (`puppeteer.launch(env.BROWSER)`), not a remote Chrome WebSocket endpoint.
- **Digital-media HTTP** uses the platform `fetch` instead of `got`. HTTP/2
  pseudo-headers are dropped, and compression is handled by `fetch`.
- **Login cookies** are cached in the `COOKIE_CACHE` KV namespace instead of on disk.
- **Credential hashing** uses WebCrypto (`crypto.subtle`) instead of Node's `crypto`.
- **Routing/CORS** use [Hono](https://hono.dev) instead of Express.
- `process.env` is replaced by Worker bindings and secrets (`src/env.ts`). All
  environment-specific values are stored via `wrangler secret put`, not in config.

The former `Dockerfile`/`.dockerignore` were removed since deployment is now handled by `wrangler`.

### API Documentation

The API is documented using the OpenAPI specification. You can view the full API documentation by:

1. Opening the `openapi.json` file in a Swagger UI viewer
2. Using a tool like [Swagger Editor](https://editor.swagger.io/)

## License

This project is licensed under the ISC License - see the LICENSE file for details.
