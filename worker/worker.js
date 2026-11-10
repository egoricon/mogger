/**
 * Cloudflare Worker — прокси для загрузки фото в GitHub-репозиторий.
 * Контракт с фронтом прежний: POST { imageBase64, filename } → файл в uploads/.
 *
 * Отличия от первой версии: принимает запросы только со своего сайта и режет слишком большие файлы,
 * чтобы посторонние не могли заваливать репозиторий мусором.
 *
 * Переменные окружения (Settings → Variables and Secrets):
 * - GITHUB_TOKEN  : fine-grained токен с правом Contents: Read & Write
 * - GITHUB_OWNER  : логин на GitHub
 * - GITHUB_REPO   : имя репозитория
 * - GITHUB_BRANCH : ветка (по умолчанию "main")
 */

const ALLOWED_ORIGINS = ["https://egoricon.github.io"];
const MAX_BASE64_LENGTH = 3_000_000; // ≈ 2.2 МБ JPEG; фронт сжимает фото до ~300 КБ

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin || ALLOWED_ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      Vary: "Origin",
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin");
    if (!ALLOWED_ORIGINS.includes(origin)) return json({ error: "Forbidden origin" }, 403);
    if (request.method === "OPTIONS") return json(null, 200, origin);

    // ── вызов на баттл: фото живёт в KV 7 дней и доступно по случайной ссылке ──
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/challenge")) {
      if (!env.CHALLENGES) return json({ error: "Challenges not configured" }, 500, origin);
      if (request.method === "GET") {
        const id = pathname.split("/")[2] || "";
        if (!/^[a-z0-9]{10}$/.test(id)) return json({ error: "Bad id" }, 400, origin);
        const data = await env.CHALLENGES.get(id);
        return data ? json(JSON.parse(data), 200, origin) : json({ error: "Not found" }, 404, origin);
      }
      if (request.method === "POST") {
        try {
          const { name, hash, imageBase64 } = await request.json();
          const content = String(imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
          if (content.length > MAX_BASE64_LENGTH || !/^[A-Za-z0-9+/]+={0,2}$/.test(content) || !content.startsWith("/9j/")) {
            return json({ error: "Bad image" }, 400, origin);
          }
          if (!Number.isInteger(hash)) return json({ error: "Bad hash" }, 400, origin);
          const bytes = crypto.getRandomValues(new Uint8Array(10));
          const id = [...bytes].map((b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
          const record = { name: String(name || "").slice(0, 14), hash, image: content };
          await env.CHALLENGES.put(id, JSON.stringify(record), { expirationTtl: 7 * 24 * 3600 });
          return json({ ok: true, id }, 201, origin);
        } catch (error) {
          return json({ error: "Internal Worker Error" }, 500, origin);
        }
      }
      return json({ error: "Method Not Allowed" }, 405, origin);
    }

    if (request.method !== "POST") return json({ error: "Method Not Allowed. Use POST." }, 405, origin);

    try {
      const { GITHUB_TOKEN: token, GITHUB_OWNER: owner, GITHUB_REPO: repo } = env;
      const branch = env.GITHUB_BRANCH || "main";
      if (!token || !owner || !repo) return json({ error: "Missing Worker secrets" }, 500, origin);

      const { imageBase64, filename } = await request.json();
      if (typeof imageBase64 !== "string" || !imageBase64) return json({ error: "Missing imageBase64" }, 400, origin);

      const content = imageBase64.replace(/^data:image\/\w+;base64,/, "");
      if (content.length > MAX_BASE64_LENGTH) return json({ error: "Image too large" }, 413, origin);
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(content) || !content.startsWith("/9j/")) {
        return json({ error: "Not a JPEG" }, 400, origin);
      }

      const name = String(filename || "scan.jpg").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]+$/, "").slice(0, 60);
      const path = `uploads/${Date.now()}_${name}.jpg`;

      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "MOG-Scanner-Cloudflare-Worker",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message: `upload: ${path}`, content, branch }),
      });
      if (!res.ok) return json({ error: "GitHub API commit failed", status: res.status }, 502, origin);

      const result = await res.json();
      return json({ ok: true, path, sha: result.content?.sha || null }, 201, origin);
    } catch (error) {
      return json({ error: "Internal Worker Error", message: error.message }, 500, origin);
    }
  },
};
