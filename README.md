# framer-micro-poster

A single Vercel serverless function that posts micro-blog entries to your Framer CMS, publishes the site to production, and syndicates to Bluesky, Mastodon, and Threads. One request does everything.

No RSS feeds. No cron jobs. No polling. No third-party syndication services.

---

## Why This Exists

Framer is a powerful site builder with a capable CMS, but it doesn't have a native API for creating content programmatically. The [Framer Server API](https://www.framer.com/developers/server-api-quick-start) (via the `framer-api` npm package) opens that door — you can connect to your project, discover collections, add items, and trigger publishes from code.

This project uses that API to build a micro-blogging pipeline: write a short post, hit one endpoint, and it shows up on your site and across your social accounts within seconds.

The syndication layer is deliberately simple. Each platform (Bluesky, Mastodon, Threads) has its own posting function. Failures are isolated — if Threads goes down, your Bluesky and Mastodon posts still go through. Every platform is optional; just leave the env vars empty and it gets skipped.

---

## Architecture

```
POST /api/post
  │
  ├─ 1. Validate + authenticate (Bearer token)
  │
  ├─ 2. Connect to Framer Server API
  │     ├─ Discover collection by name
  │     ├─ Discover field IDs dynamically
  │     ├─ Build fieldData (body, date, category, image)
  │     └─ Add CMS item
  │
  ├─ 3. Publish + deploy to production (non-fatal)
  │
  └─ 4. Syndicate (non-fatal, parallel-ish)
        ├─ Bluesky  (AT Protocol)
        ├─ Mastodon (ActivityPub)
        └─ Threads  (Meta Graph API)
```

### Key Design Decisions

**Dynamic field discovery.** The function never hardcodes Framer field IDs. Instead, it fetches field definitions at runtime and matches by name. You can rename fields in Framer's UI and the function adapts — as long as the names match the `CONFIG.fields` mapping.

**Enum resolution.** Framer enum fields (like a "Category" dropdown) store internal case IDs. The function matches your human-readable category string against the enum cases to find the correct ID. You send `"category": "Update"` and it figures out the rest.

**Non-fatal publish and syndication.** The CMS write is the critical operation. If publishing fails, you still have the item in your CMS — publish manually from Framer. If any syndication platform fails, the others still execute and the response tells you exactly what happened.

**Timezone handling.** Framer displays date values as-is without timezone conversion. If you send UTC, your 2pm local post shows as 7pm. The `formatLocalDate()` function calculates your local time and sends it with a `Z` suffix, which is a deliberate trick — Framer treats it as the literal display value, so your timestamps show correctly.

**Bearer token auth.** Simple but effective for a personal API. No OAuth complexity, no session management. Generate a UUID, set it as an env var, include it in every request.

---

## Setup

### 1. Create a Framer CMS Collection

In your Framer project, create a CMS collection for your micro posts. At minimum, you need:

| Field Name | Type        | Notes |
|-----------|-------------|-------|
| Body      | Plain Text  | The post content |
| Date      | Date        | Publish timestamp |

Optional fields:

| Field Name | Type   | Notes |
|-----------|--------|-------|
| Category  | Enum   | Add whatever values make sense for you |
| Image     | Image  | For posts with media |

The field names are flexible — the function matches against configurable name lists (see `CONFIG.fields` in `api/post.mjs`).

### 2. Get Your Framer API Key

Open your Framer project → **Site Settings** → **General** → **Create API Key**.

Copy both the API key and your project URL (it looks like `https://framer.com/projects/Sites--aabbccdd1122`).

### 3. Deploy to Vercel

```bash
git clone https://github.com/YOUR_USERNAME/framer-micro-poster.git
cd framer-micro-poster
npm install
npx vercel
```

### 4. Set Environment Variables

At minimum (Framer only, no syndication):

```bash
npx vercel env add FRAMER_PROJECT_URL
npx vercel env add FRAMER_API_KEY
npx vercel env add AUTH_TOKEN
```

Generate a token:
```bash
node -e "console.log(crypto.randomUUID())"
```

For syndication, add the platform-specific vars. See `.env.example` for the full list.

### 5. Deploy to Production

```bash
npx vercel --prod
```

---

## Usage

### Post from Terminal

```bash
curl -X POST https://your-app.vercel.app/api/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "body": "Your micro post text here.",
    "category": "Note"
  }'
```

### Draft Mode (No Publish, No Syndication)

```bash
curl -X POST https://your-app.vercel.app/api/post \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
  -d '{
    "body": "Testing the pipeline.",
    "category": "Note",
    "draft": true
  }'
```

### Request Body

| Field      | Type    | Required | Description |
|-----------|---------|----------|-------------|
| `body`     | string  | Yes      | The post text |
| `category` | string  | No       | Must match an enum value in your CMS field |
| `slug`     | string  | No       | URL slug; auto-generated from body if omitted |
| `date`     | string  | No       | ISO 8601 date; defaults to now in your timezone |
| `image`    | string  | No       | URL to an image to upload to Framer |
| `imageAlt` | string  | No       | Alt text for the image |
| `draft`    | boolean | No       | If true, adds to CMS without publishing or syndicating |

### Response

```json
{
  "success": true,
  "slug": "your-micro-post-text-here-x7k2",
  "body": "Your micro post text here.",
  "category": "Note",
  "date": "2026-02-28T14:30:00.000Z",
  "draft": false,
  "published": true,
  "deployment": "deploy-abc123",
  "syndication": {
    "bluesky": "success",
    "mastodon": "success",
    "threads": "success"
  }
}
```

---

## Syndication Details

### Bluesky (AT Protocol)

Uses app passwords for authentication — no OAuth flow needed. Creates a session, builds the post with rich text facets for clickable hashtags, and publishes via `com.atproto.repo.createRecord`.

**Setup:** Go to Settings → App Passwords in Bluesky and create one.

### Mastodon (ActivityPub)

Posts via the standard Mastodon API (`/api/v1/statuses`). Works with any Mastodon-compatible instance.

**Setup:** Go to Preferences → Development → New Application on your instance. Grant `write:statuses` scope.

### Threads (Meta Graph API)

Uses the three-step Threads publishing flow: create container → poll for readiness → publish. The container polling adds a few seconds but is required by Meta's API.

**Setup:** Create a Meta developer app, add the Threads product, and generate a long-lived access token. This is the most involved setup of the three platforms.

### Text Formatting

Bluesky and Mastodon get hashtags appended:
```
Your post text here.

#YourGlobalTag #CategoryName
```

Threads gets a text label instead (hashtags behave differently there):
```
Your post text here.

Category: Note

#YourGlobalTag
```

Customize this in the `CONFIG` object at the top of `api/post.mjs`.

---

## Configuration

The `CONFIG` object at the top of `api/post.mjs` controls behavior without env vars:

```javascript
const CONFIG = {
  // Timezone for default dates
  timezone: process.env.TIMEZONE || "America/New_York",

  // Collection name search terms (case-insensitive)
  collectionSearchTerms: ["micro", "post", "note"],

  // CMS field name mappings (tries each in order)
  fields: {
    body: ["body", "content", "text"],
    date: ["date", "publishedat", "published at", "created"],
    category: ["category", "type", "mood", "vibes"],
    image: ["image", "photo", "media"],
  },

  // Global hashtag for all syndicated posts (null to disable)
  globalHashtag: null,

  // Threads category label prefix
  threadsCategoryLabel: "Category",
}
```

---

## Gotchas and Lessons Learned

**Framer Server API connections can timeout.** The WebSocket connection that `framer-api` uses can expire on Vercel's hobby plan (10s default). The `vercel.json` in this repo sets `maxDuration: 60` to give it room. If you still get timeouts, retrying once usually works — the second connection tends to be faster.

**Framer dates don't convert timezones.** Whatever you send as the date value, Framer displays it literally. If you send `14:30:00.000Z`, it shows "2:30 PM" regardless of the visitor's timezone. This is why `formatLocalDate()` sends your local time as if it were UTC — it's a hack, but it's the correct hack for this context.

**Framer enum fields need case IDs, not names.** You can't just send `"category": "Note"` to an enum field — Framer expects the internal case ID. The function handles this by fetching the field definition and matching case names at runtime.

**Threads requires a polling step.** Unlike Bluesky and Mastodon (which are immediate), Threads requires creating a "container," waiting for it to process, then publishing it in a separate call. Budget an extra 2-5 seconds for Threads.

**Syndication platforms are optional.** If you only want Bluesky, just set those env vars and leave Mastodon/Threads empty. The function checks for credentials before attempting each platform.

---

## Extending This

**Add a new syndication target.** Write a `postToX(item)` function that takes `{ text, category }` and add it to the syndication block in the handler. Follow the same try/catch pattern.

**Use with an AI assistant.** This was originally built to be called from Claude (Anthropic) as part of a conversational posting workflow. Any AI assistant that can make HTTP requests can use this endpoint — just give it the URL, auth token, and the request format.

**Connect to a shortcut or automation.** iOS Shortcuts, Raycast scripts, Alfred workflows — anything that can POST JSON works. No SDK needed.

**Add more CMS fields.** Add entries to `CONFIG.fields` and follow the pattern in the handler for building `fieldData`. The dynamic field discovery means you don't need Framer field IDs in your code.

---

## License

MIT
