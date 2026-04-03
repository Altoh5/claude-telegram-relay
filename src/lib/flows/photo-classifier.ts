import { sendTelegramMessage } from "../telegram";

export type PhotoCategory = "receipt" | "food_place" | "product" | "general";

/**
 * Classify a photo using keyword matching on the vision description.
 * No API key required — works with Claude subprocess vision output.
 */
export async function classifyPhoto(opts: {
  caption: string;
  visionDescription: string;
}): Promise<PhotoCategory> {
  const text = `${opts.caption} ${opts.visionDescription}`.toLowerCase();

  if (/receipt|invoice|bill|payment\s*confirmation|total.*[\$£€]|total.*sgd|total.*rm|subtotal|amount\s*due|paid|transaction/i.test(text)) return "receipt";
  if (/restaurant|café|cafe|food|dish|meal|menu|dining|bakery|hawker|kopitiam/i.test(text)) return "food_place";
  if (/product|package|box|brand|label|price\s*tag|shopping|unbox/i.test(text)) return "product";
  return "general";
}

export async function lookupVenueAndNotify(opts: {
  botToken: string;
  chatId: string;
  venueName: string;
  assetId?: string;
}): Promise<void> {
  const { botToken, chatId, venueName, assetId } = opts;

  if (!process.env.GOOGLE_MAPS_API_KEY) {
    await sendTelegramMessage(botToken, chatId, `📍 Looks like: *${venueName}*. (Google Maps API not configured — set GOOGLE_MAPS_API_KEY to get reviews.)`, { parseMode: "Markdown" });
    return;
  }

  let placeSummary = "";
  let rating = "";

  try {
    const mapsRes = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
        "X-Goog-FieldMask": "places.displayName,places.rating,places.userRatingCount,places.formattedAddress,places.editorialSummary,places.reviews",
      },
      body: JSON.stringify({ textQuery: `${venueName} Singapore` }),
    });

    if (mapsRes.ok) {
      const data = await mapsRes.json();
      const place = data.places?.[0];
      if (place) {
        rating = place.rating ? `${place.rating}★ (${place.userRatingCount} reviews)` : "";
        const editorial = place.editorialSummary?.text || "";
        const topReview = place.reviews?.[0]?.text?.text?.slice(0, 120) || "";
        placeSummary = [editorial, topReview].filter(Boolean).join(" — ");
      }
    }
  } catch (err) {
    console.warn(`Maps API lookup failed: ${err}`);
  }

  const ratingLine = rating ? `\n${rating}` : "";
  const summaryLine = placeSummary ? `\n_"${placeSummary}"_` : "";

  const keyboard = {
    inline_keyboard: [[
      { text: "Add Note", callback_data: `ph:note:${assetId || "x"}` },
      { text: "Skip", callback_data: `ph:skip:${assetId || "x"}` },
    ]],
  };

  const msg = `📍 *${venueName}*${ratingLine}${summaryLine}\n\nWant to add your own note?`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });
}

export async function lookupProductAndNotify(opts: {
  botToken: string;
  chatId: string;
  productName: string;
  assetId?: string;
}): Promise<void> {
  const { botToken, chatId, productName, assetId } = opts;

  let reviewSummary = "";

  try {
    const { spawnSync } = await import("child_process");
    const result = spawnSync(
      "firecrawl",
      ["search", `${productName} review price Singapore`, "--limit", "3", "--json"],
      { encoding: "utf-8", timeout: 15000 }
    );
    if (result.status === 0 && result.stdout) {
      const results = JSON.parse(result.stdout);
      const snippets = results?.data?.web?.slice(0, 2).map((r: any) => r.description || "").filter(Boolean);
      reviewSummary = snippets?.join(" — ").slice(0, 200) || "";
    }
  } catch {
    reviewSummary = "";
  }

  const reviewLine = reviewSummary ? `\n_${reviewSummary}_` : "";

  const keyboard = {
    inline_keyboard: [[
      { text: "Save for Later", callback_data: `ph:save:${assetId || "x"}` },
      { text: "Skip", callback_data: `ph:skip:${assetId || "x"}` },
    ]],
  };

  const msg = `🛍️ *${productName}*${reviewLine}\n\nSave this to come back to?`;

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: msg,
      parse_mode: "Markdown",
      reply_markup: keyboard,
    }),
  });
}

export async function saveMemoryEntry(content: string): Promise<void> {
  try {
    const { addFact } = await import("../memory");
    await addFact(content);
  } catch (err) {
    console.warn(`Memory save failed: ${err}`);
  }
}
