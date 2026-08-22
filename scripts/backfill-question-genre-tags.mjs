// 一次性回填：为 question_image_index 中已有的带作品标签行，按作品 ID 去重后
// 从官方 Bangumi subject 详情获取属性标签与首播年份并写回。
//
// 用法（生产，Worker 停止后执行，结果写入 /tmp）：
//   node scripts/backfill-question-genre-tags.mjs --dry-run            # 只生成 SQL 与预览
//   node scripts/backfill-question-genre-tags.mjs --apply              # 生成并应用 SQL
//
// 幂等：已带属性标签或年份的作品会被跳过，可安全重跑。
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDirectory, "..");
const wranglerExecutable = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const databaseName = "anime_master_game";
const persistTo = process.env.D1_PERSIST_TO || "/var/lib/anime-master-game/wrangler";
const userAgent = "lpp12138/Anime-Master-Game-v2 (https://github.com/lpp12138/Anime-Master-Game-v2)";
const requestTimeoutMs = 8_000;
const responseMaxBytes = 4 * 1024 * 1024;
const genreTagMaxCount = 20;

function dirname(path) {
  return path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";
}

function parseArgs(argv) {
  const args = { dryRun: true };
  for (const value of argv) {
    if (value === "--apply") args.dryRun = false;
    else if (value === "--dry-run") args.dryRun = true;
    else throw new Error(`未知参数：${value}`);
  }
  return args;
}

function runWrangler(args, options = {}) {
  return execFileSync(process.execPath, [wranglerExecutable, ...args], {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "inherit"],
    maxBuffer: 32 * 1024 * 1024,
  });
}

function parseWranglerJson(output) {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("Wrangler 没有返回可解析的 JSON。");
  return JSON.parse(output.slice(start, end + 1));
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function cleanString(value, maxLength = 40) {
  if (typeof value !== "string") return null;
  const cleaned = value.trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxLength);
}

function positiveInteger(value) {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= 2147483647 ? Number(value) : null;
}

function releaseYearFromDate(value) {
  if (!value) return null;
  const year = Number(String(value).slice(0, 4));
  return Number.isInteger(year) && year >= 1950 && year <= 2100 ? year : null;
}

function normalizeGenreTags(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const tags = [];
  for (const item of value) {
    const name = cleanString(item?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    tags.push({ name, count: positiveInteger(item?.count) ?? 0 });
    if (tags.length >= genreTagMaxCount) break;
  }
  return tags;
}

async function fetchSubject(subjectId) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(`https://api.bgm.tv/v0/subjects/${subjectId}`, {
      headers: { accept: "application/json", "user-agent": userAgent },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`subject ${subjectId} HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > responseMaxBytes) throw new Error(`subject ${subjectId} 响应过大`);
    const text = await response.text();
    if (text.length > responseMaxBytes) throw new Error(`subject ${subjectId} 响应过大`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseWranglerJson(runWrangler([
    "d1", "execute", databaseName, "--local", "--persist-to", persistTo, "--json",
    "--command", `SELECT anime_subject_id, COUNT(*) AS question_count,
      SUM(anime_genre_tags_json IS NOT NULL AND anime_genre_tags_json != '[]') AS has_genre_tags,
      SUM(anime_release_year IS NOT NULL) AS has_year
      FROM question_image_index WHERE anime_subject_id IS NOT NULL
      GROUP BY anime_subject_id ORDER BY anime_subject_id`,
  ]))[0]?.results ?? [];
  if (rows.length === 0) {
    console.log("没有需要回填的作品。");
    return;
  }

  const subjects = [];
  const skipped = [];
  for (const row of rows) {
    const subjectId = Number(row.anime_subject_id);
    if (!Number.isInteger(subjectId) || subjectId <= 0) {
      skipped.push({ subjectId: row.anime_subject_id, reason: "invalid id" });
      continue;
    }
    // 幂等：该作品已有属性标签且已有年份时跳过。
    if (Number(row.has_genre_tags) > 0 && Number(row.has_year) > 0) {
      skipped.push({ subjectId, reason: "already backfilled" });
      continue;
    }
    subjects.push({ subjectId, questionCount: Number(row.question_count) });
  }
  console.log(`待回填作品 ${subjects.length} 个，跳过 ${skipped.length} 个。`);

  const updates = [];
  let failed = [];
  for (let index = 0; index < subjects.length; index += 1) {
    const { subjectId } = subjects[index];
    let payload;
    try {
      payload = await fetchSubject(subjectId);
    } catch (error) {
      failed.push({ subjectId, error: error instanceof Error ? error.message : String(error) });
      console.warn(`作品 ${subjectId} 获取失败：${error instanceof Error ? error.message : error}`);
      continue;
    }
    const genreTags = normalizeGenreTags(payload.tags);
    const releaseYear = releaseYearFromDate(payload.date);
    const genreJson = sqlString(JSON.stringify(genreTags));
    const yearSql = releaseYear == null ? "NULL" : String(releaseYear);
    updates.push(
      `UPDATE question_image_index SET anime_genre_tags_json=${genreJson}, anime_release_year=${yearSql} WHERE anime_subject_id=${subjectId};`,
    );
    if ((index + 1) % 25 === 0 || index === subjects.length - 1) {
      console.log(`进度 ${index + 1}/${subjects.length}，成功更新 ${updates.length}，失败 ${failed.length}。`);
    }
  }

  if (updates.length === 0) {
    console.log("没有任何可写回的作品。");
    if (failed.length > 0) process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replaceAll(":", "").replaceAll(".", "");
  const sqlPath = join("/tmp", `question-genre-tags-backfill-${stamp}.sql`);
  const sqlText = `${updates.join("\n")}\n`;
  writeFileSync(sqlPath, sqlText, { mode: 0o600 });
  console.log(`已生成 SQL：${sqlPath}（${updates.length} 条 UPDATE）`);

  if (args.dryRun) {
    console.log("dry-run 完成，未应用。");
    return;
  }
  const output = runWrangler([
    "d1", "execute", databaseName, "--local", "--persist-to", persistTo,
    "--file", sqlPath,
  ]);
  const applied = (() => {
    try {
      const parsed = parseWranglerJson(output);
      return parsed.length > 0 && parsed.every((entry) => entry.success === true);
    } catch {
      return /executed successfully|成功执行/i.test(output);
    }
  })();
  if (!applied) {
    throw new Error("回填 SQL 应用失败。");
  }
  console.log(`回填完成：${updates.length} 个作品，${failed.length} 个失败。`);
  if (failed.length > 0) {
    console.warn("失败明细：", JSON.stringify(failed, null, 2));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
