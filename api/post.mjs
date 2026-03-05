import { connect } from "framer-api"

/**
 * POST /api/post
 *
 * Posts a micro-blog entry to a Framer CMS collection,
 * publishes the site to production, then syndicates
 * directly to Bluesky, Mastodon, and Threads.
 *
 * One request does everything. No RSS. No cron. No delays.
 *
 * Body (JSON):
 *   body       (string, required)  – The post text content
 *   category   (string, optional)  – Enum value matching your CMS field (e.g., "Update", "Link", "Note")
 *   slug       (string, optional)  – Custom URL slug; auto-generated from body if omitted
 *   date       (string, optional)  – ISO date; defaults to now in your configured timezone
 *   image      (string, optional)  – URL to an image
 *   imageAlt   (string, optional)  – Alt text for the image
 *   draft      (boolean, optional) – If true, adds to CMS but won't publish or syndicate
 *
 * Headers:
 *   Authorization: Bearer <AUTH_TOKEN>
 */

// =============================================
// Configuration
// =============================================

const CONFIG = {
  // Your timezone — used when no date is provided.
  // Framer displays date values as-is without timezone conversion,
  // so we send local time with a Z suffix to get correct display.
  // See formatLocalDate() for details.
  timezone: process.env.TIMEZONE || "America/New_York",

  // CMS collection name — matched case-insensitively.
  // The function searches for collections containing these strings.
  collectionSearchTerms: ["micro", "post", "note"],

  // Field name mappings — how your CMS fields are named.
  // These are matched case-insensitively against your collection's fields.
  fields: {
    body: ["body", "content", "text"],
    date: ["date", "publishedat", "published at", "created"],
    category: ["category", "type", "mood", "vibes"],
    image: ["image", "photo", "media"],
  },

  // Hashtag appended to all syndicated posts.
  // Set to null to disable.
  globalHashtag: null,

  // Threads uses a text label instead of a hashtag for the category.
  // e.g., "Category: Update" instead of "#Update"
  threadsCategoryLabel: "Category",
}

// =============================================
// Handler
// =============================================

export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*")
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS")
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")

  if (req.method === "OPTIONS") return res.status(200).end()
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" })

  // Auth
  const authHeader = req.headers.authorization
  const expectedToken = process.env.AUTH_TOKEN
  if (!expectedToken || authHeader !== `Bearer ${expectedToken}`) {
    return res.status(401).json({ error: "Unauthorized" })
  }

  // Parse body
  const { body, category, slug, date, image, imageAlt, draft } = req.body || {}

  if (!body || typeof body !== "string" || body.trim().length === 0) {
    return res.status(400).json({ error: "body is required and must be a non-empty string" })
  }

  const itemSlug = slug || generateSlug(body)
  const itemDate = date || formatLocalDate(CONFIG.timezone)
  const isDraft = draft === true

  // =============================================
  // STEP 1: Post to Framer CMS + Publish
  // =============================================

  let framer
  let publishResult = null

  try {
    framer = await connect(
      process.env.FRAMER_PROJECT_URL,
      process.env.FRAMER_API_KEY
    )

    // Find the target collection by searching for matching names
    const collections = await framer.getCollections()
    const targetCollection = collections.find((c) => {
      const name = c.name.toLowerCase()
      return CONFIG.collectionSearchTerms.some((term) => name.includes(term))
    })

    if (!targetCollection) {
      const names = collections.map((c) => c.name).join(", ")
      await framer.disconnect()
      return res.status(404).json({
        error: "Could not find target collection",
        availableCollections: names,
      })
    }

    // Discover field IDs dynamically — no hardcoded IDs needed.
    // This means you can rename fields in Framer and the function
    // will still work as long as the names match CONFIG.fields.
    const fields = await targetCollection.getFields()
    const fieldMap = {}
    for (const field of fields) {
      fieldMap[field.name.toLowerCase()] = { id: field.id, type: field.type }
    }

    console.log("Field map:", JSON.stringify(fieldMap, null, 2))

    const fieldData = {}

    // Body field
    const bodyField = findField(fieldMap, CONFIG.fields.body)
    if (bodyField) {
      fieldData[bodyField.id] = { type: bodyField.type, value: body.trim() }
    }

    // Date field
    const dateField = findField(fieldMap, CONFIG.fields.date)
    if (dateField) {
      fieldData[dateField.id] = { type: dateField.type, value: itemDate }
    }

    // Category field (enum) — needs case ID resolution
    if (category) {
      const categoryField = findField(fieldMap, CONFIG.fields.category)
      if (categoryField) {
        const categoryFieldDef = fields.find((f) => f.id === categoryField.id)
        let enumCaseId = category

        // Framer enum fields store cases with IDs.
        // We match by name to find the correct ID.
        if (categoryFieldDef && categoryFieldDef.cases) {
          const matchingCase = categoryFieldDef.cases.find(
            (c) => c.name.toLowerCase() === category.toLowerCase()
          )
          if (matchingCase) enumCaseId = matchingCase.id
        }

        fieldData[categoryField.id] = { type: "enum", value: enumCaseId }
      }
    }

    // Image field — upload to Framer's asset system, then reference in CMS
    if (image) {
      const imageField = findField(fieldMap, CONFIG.fields.image)
      if (imageField) {
        try {
          console.log("Uploading image to Framer...")
          const imageAsset = await framer.uploadImage({
            image: image,
            name: `post-${itemSlug}`,
          })
          console.log("Image uploaded:", imageAsset.url)

          fieldData[imageField.id] = {
            type: "image",
            value: imageAsset.url,
            alt: imageAlt || generateAltText(body),
          }
        } catch (imgError) {
          console.error("Image upload failed (non-fatal):", imgError.message)
        }
      }
    }

    // Add the CMS item
    const newItem = { slug: itemSlug, draft: isDraft, fieldData }
    console.log("Adding item:", JSON.stringify(newItem, null, 2))
    await targetCollection.addItems([newItem])

    // Publish + deploy (unless draft)
    // Non-fatal — CMS item exists even if publish fails.
    if (!isDraft) {
      try {
        console.log("Publishing...")
        publishResult = await framer.publish()
        console.log("Publish result:", JSON.stringify(publishResult, null, 2))

        if (publishResult?.deployment?.id) {
          console.log("Deploying to production...")
          await framer.deploy(publishResult.deployment.id)
        }
      } catch (publishError) {
        console.error("Publish failed (non-fatal):", publishError.message)
      }
    }

    await framer.disconnect()
  } catch (error) {
    console.error("Error posting to Framer:", error)
    if (framer) {
      try { await framer.disconnect() } catch {}
    }
    return res.status(500).json({
      error: "Failed to post to Framer",
      details: error.message,
    })
  }

  // =============================================
  // STEP 2: Syndicate to social platforms
  // =============================================
  //
  // Only runs for non-drafts. Each platform is independent —
  // failures are logged but don't block other platforms.
  // The post is already live on your site at this point.

  const syndication = { bluesky: null, mastodon: null, threads: null }

  if (!isDraft) {
    const syndicationItem = { text: body.trim(), category: category || null }

    // Bluesky
    if (process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD) {
      try {
        await postToBluesky(syndicationItem)
        syndication.bluesky = "success"
      } catch (error) {
        syndication.bluesky = `error: ${error.message}`
        console.error("→ Bluesky error:", error.message)
      }
    }

    // Mastodon
    if (process.env.MASTODON_INSTANCE_URL && process.env.MASTODON_ACCESS_TOKEN) {
      try {
        await postToMastodon(syndicationItem)
        syndication.mastodon = "success"
      } catch (error) {
        syndication.mastodon = `error: ${error.message}`
        console.error("→ Mastodon error:", error.message)
      }
    }

    // Threads
    if (process.env.THREADS_USER_ID && process.env.THREADS_ACCESS_TOKEN) {
      try {
        await postToThreads(syndicationItem)
        syndication.threads = "success"
      } catch (error) {
        syndication.threads = `error: ${error.message}`
        console.error("→ Threads error:", error.message)
      }
    }
  }

  // =============================================
  // Response
  // =============================================

  return res.status(200).json({
    success: true,
    slug: itemSlug,
    body: body.trim(),
    category: category || null,
    date: itemDate,
    draft: isDraft,
    published: !isDraft,
    deployment: publishResult?.deployment?.id || null,
    syndication: isDraft ? null : syndication,
  })
}


// =============================================
// Bluesky
// =============================================

async function postToBluesky(item) {
  const handle = process.env.BLUESKY_HANDLE
  const appPassword = process.env.BLUESKY_APP_PASSWORD

  // Authenticate
  const sessionRes = await fetch(
    "https://bsky.social/xrpc/com.atproto.server.createSession",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: handle, password: appPassword }),
    }
  )

  if (!sessionRes.ok) {
    throw new Error(`Bluesky auth failed: ${await sessionRes.text()}`)
  }

  const session = await sessionRes.json()
  const postText = formatHashtagText(item)

  // Build facets for clickable hashtags
  const facets = []
  const hashtagRegex = /#(\w+)/g
  let match
  while ((match = hashtagRegex.exec(postText)) !== null) {
    const byteStart = Buffer.byteLength(postText.slice(0, match.index), "utf8")
    const byteEnd = byteStart + Buffer.byteLength(match[0], "utf8")
    facets.push({
      index: { byteStart, byteEnd },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag: match[1] }],
    })
  }

  const record = {
    $type: "app.bsky.feed.post",
    text: postText,
    createdAt: new Date().toISOString(),
  }
  if (facets.length > 0) record.facets = facets

  const postRes = await fetch(
    "https://bsky.social/xrpc/com.atproto.repo.createRecord",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.accessJwt}`,
      },
      body: JSON.stringify({
        repo: session.did,
        collection: "app.bsky.feed.post",
        record,
      }),
    }
  )

  if (!postRes.ok) {
    throw new Error(`Bluesky post failed: ${await postRes.text()}`)
  }

  return await postRes.json()
}


// =============================================
// Mastodon
// =============================================

async function postToMastodon(item) {
  const instanceUrl = process.env.MASTODON_INSTANCE_URL
  const accessToken = process.env.MASTODON_ACCESS_TOKEN

  const postText = formatHashtagText(item)

  const res = await fetch(`${instanceUrl}/api/v1/statuses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ status: postText, visibility: "public" }),
  })

  if (!res.ok) {
    throw new Error(`Mastodon post failed: ${await res.text()}`)
  }

  return await res.json()
}


// =============================================
// Threads
// =============================================

async function postToThreads(item) {
  const userId = process.env.THREADS_USER_ID
  const accessToken = process.env.THREADS_ACCESS_TOKEN

  const postText = formatThreadsText(item)

  // Step 1: Create media container
  const createRes = await fetch(
    `https://graph.threads.net/v1.0/${userId}/threads?media_type=TEXT&text=${encodeURIComponent(postText)}&access_token=${accessToken}`,
    { method: "POST" }
  )

  if (!createRes.ok) {
    throw new Error(`Threads container creation failed: ${await createRes.text()}`)
  }

  const { id: containerId } = await createRes.json()

  // Step 2: Poll until container is ready
  let attempts = 0
  while (attempts < 10) {
    const statusRes = await fetch(
      `https://graph.threads.net/v1.0/${containerId}?fields=status&access_token=${accessToken}`
    )

    if (statusRes.ok) {
      const data = await statusRes.json()
      if (data.status === "FINISHED") break
      if (data.status === "ERROR") {
        throw new Error(`Threads container error: ${JSON.stringify(data)}`)
      }
    }

    await new Promise((r) => setTimeout(r, 1000))
    attempts++
  }

  if (attempts >= 10) {
    throw new Error("Threads container not ready after 10 seconds")
  }

  // Step 3: Publish
  const publishRes = await fetch(
    `https://graph.threads.net/v1.0/${userId}/threads_publish?creation_id=${containerId}&access_token=${accessToken}`,
    { method: "POST" }
  )

  if (!publishRes.ok) {
    throw new Error(`Threads publish failed: ${await publishRes.text()}`)
  }

  return await publishRes.json()
}


// =============================================
// Text Formatting
// =============================================

/**
 * Format post text for Bluesky and Mastodon.
 * Appends hashtags for the category and optional global tag.
 */
function formatHashtagText(item) {
  let text = item.text
  const hashtags = []

  if (CONFIG.globalHashtag) hashtags.push(CONFIG.globalHashtag)
  if (item.category) hashtags.push(`#${item.category.replace(/\s+/g, "")}`)

  if (hashtags.length > 0) {
    text = `${text}\n\n${hashtags.join(" ")}`
  }

  return text
}

/**
 * Format post text for Threads.
 * Uses a text label for the category instead of a hashtag.
 */
function formatThreadsText(item) {
  let text = item.text

  if (item.category) {
    text = `${text}\n\n${CONFIG.threadsCategoryLabel}: ${item.category}`
  }

  if (CONFIG.globalHashtag) {
    text = `${text}\n\n${CONFIG.globalHashtag}`
  }

  return text
}


// =============================================
// Utilities
// =============================================

/**
 * Find a CMS field by checking multiple possible names.
 * Returns the first match from the fieldMap.
 */
function findField(fieldMap, possibleNames) {
  for (const name of possibleNames) {
    if (fieldMap[name]) return fieldMap[name]
  }
  return null
}

/**
 * Generate a URL-friendly slug from the body text.
 * Takes the first ~8 words and appends a short random suffix.
 */
function generateSlug(text) {
  const words = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .join("-")

  const suffix = Math.random().toString(36).substring(2, 6)
  return `${words}-${suffix}`
}

/**
 * Generate an ISO 8601 date string in the given timezone.
 *
 * Framer's CMS displays date values as-is without converting
 * timezones. Sending UTC means your 2pm post shows as 7pm.
 * This function formats local time with a Z suffix so Framer
 * displays the correct local time.
 */
function formatLocalDate(timeZone) {
  const now = new Date()
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map(({ type, value }) => [type, value])
  )
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.000Z`
}

/**
 * Generate alt text from the post body when none is provided.
 */
function generateAltText(text) {
  const words = text.trim().split(/\s+/)
  const truncated = words.slice(0, 15).join(" ")
  return `Image accompanying: ${truncated}${words.length > 15 ? "..." : ""}`
}
