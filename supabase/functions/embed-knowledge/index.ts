import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

/**
 * Edge function: Generate an OpenAI embedding for a knowledge entry
 * and store it in the knowledge table.
 *
 * Requires OPENAI_API_KEY set as a Supabase secret.
 * If not set, returns success with embedded: false (knowledge still saved,
 * just without semantic search capability).
 */
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { knowledge_id, text } = await req.json();

    if (!knowledge_id || !text) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing knowledge_id or text" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (!openaiKey) {
      // No OpenAI key — knowledge is saved but without embedding
      return new Response(
        JSON.stringify({ ok: true, embedded: false, reason: "OPENAI_API_KEY not set" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Generate embedding
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${openaiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      return new Response(
        JSON.stringify({ ok: false, error: `OpenAI error: ${errText}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const data = await res.json();
    const embedding = data.data[0].embedding;

    // Store embedding in the knowledge table
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { error } = await supabase
      .from("knowledge")
      .update({ embedding })
      .eq("id", knowledge_id);

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: `Supabase update error: ${error.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, embedded: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
