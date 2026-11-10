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
      "Access-Control-Allow-Methods": "POST, OPTIONS",
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
