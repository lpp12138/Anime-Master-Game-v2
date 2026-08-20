import assert from "node:assert/strict";
import test from "node:test";

import {
  BangumiApiError,
  getBangumiAnimeSubject,
  getBangumiSubjectCharacters,
  searchBangumiAnime,
} from "../worker/bangumiApi";

class MemoryCache {
  private readonly responses = new Map<string, Response>();

  async match(request: RequestInfo | URL) {
    const key = request instanceof Request ? request.url : String(request);
    return this.responses.get(key)?.clone();
  }

  async put(request: RequestInfo | URL, response: Response) {
    const key = request instanceof Request ? request.url : String(request);
    this.responses.set(key, response.clone());
  }
}

function asCache(cache = new MemoryCache()) {
  return cache as unknown as Cache;
}

test("Bangumi anime search uses the official v0 API, compliant User-Agent, and server cache", async () => {
  const cache = asCache();
  const requests: Request[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({
      total: 2,
      data: [
        {
          id: 160209,
          type: 2,
          name: "君の名は。",
          name_cn: "你的名字。",
          date: "2016-08-26",
          images: { grid: "https://lain.bgm.tv/pic/cover/g/test.jpg" },
          rating: { score: 8.1 },
        },
        { id: 999, type: 1, name: "不是动画" },
      ],
    }), { headers: { "content-type": "application/json" } });
  };

  const first = await searchBangumiAnime(cache, "你的名字", "anime", fetcher as typeof fetch);
  const second = await searchBangumiAnime(cache, "你的名字", "anime", async () => {
    throw new Error("cache miss");
  });

  assert.deepEqual(second, first);
  assert.deepEqual(first, [{
    id: 160209,
    name: "君の名は。",
    nameCn: "你的名字。",
    subjectType: 2,
    imageUrl: "https://lain.bgm.tv/pic/cover/g/test.jpg",
    date: "2016-08-26",
    score: 8.1,
  }]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.bgm.tv/v0/search/subjects?limit=12&offset=0");
  assert.equal(requests[0].method, "POST");
  assert.match(requests[0].headers.get("user-agent") ?? "", /lpp12138\/Anime-Master-Game-v2/);
  assert.deepEqual(await requests[0].json(), {
    keyword: "你的名字",
    sort: "match",
    filter: { type: [2] },
  });
});

test("Bangumi search supports anime/game/all scopes with strict type filters and isolated caches", async () => {
  const cache = asCache();
  const requests: Request[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push(new Request(input, init));
    return new Response(JSON.stringify({
      data: [
        { id: 101, type: 2, name: "动画作品", name_cn: "动画中文名" },
        { id: 102, type: 4, name: "游戏作品", name_cn: "游戏中文名" },
        { id: 103, type: 3, name: "音乐作品", name_cn: "音乐中文名" },
        { id: 104, type: 2, name: "另一部动画" },
      ],
    }), { headers: { "content-type": "application/json" } });
  };

  const anime = await searchBangumiAnime(cache, "隔离测试", "anime", fetcher as typeof fetch);
  assert.deepEqual(anime, [
    { id: 101, name: "动画作品", nameCn: "动画中文名", subjectType: 2, imageUrl: null, date: null, score: null },
    { id: 104, name: "另一部动画", nameCn: null, subjectType: 2, imageUrl: null, date: null, score: null },
  ]);
  assert.deepEqual(await requests[0].json(), {
    keyword: "隔离测试",
    sort: "match",
    filter: { type: [2] },
  });

  const game = await searchBangumiAnime(cache, "隔离测试", "game", fetcher as typeof fetch);
  assert.deepEqual(game, [
    { id: 102, name: "游戏作品", nameCn: "游戏中文名", subjectType: 4, imageUrl: null, date: null, score: null },
  ]);
  assert.deepEqual(await requests[1].json(), {
    keyword: "隔离测试",
    sort: "match",
    filter: { type: [4] },
  });

  const all = await searchBangumiAnime(cache, "隔离测试", "all", fetcher as typeof fetch);
  assert.deepEqual(all, [
    { id: 101, name: "动画作品", nameCn: "动画中文名", subjectType: 2, imageUrl: null, date: null, score: null },
    { id: 102, name: "游戏作品", nameCn: "游戏中文名", subjectType: 4, imageUrl: null, date: null, score: null },
    { id: 104, name: "另一部动画", nameCn: null, subjectType: 2, imageUrl: null, date: null, score: null },
  ]);
  assert.deepEqual(await requests[2].json(), {
    keyword: "隔离测试",
    sort: "match",
    filter: { type: [2, 4] },
  });
  assert.equal(requests.length, 3);

  // 每个范围各自的缓存键互不串用；重复查询不再访问上游。
  const missFetcher = async () => { throw new Error("cache miss"); };
  assert.deepEqual(
    await searchBangumiAnime(cache, "隔离测试", "anime", missFetcher as typeof fetch),
    anime,
  );
  assert.deepEqual(
    await searchBangumiAnime(cache, "隔离测试", "game", missFetcher as typeof fetch),
    game,
  );
  assert.deepEqual(
    await searchBangumiAnime(cache, "隔离测试", "all", missFetcher as typeof fetch),
    all,
  );
  assert.equal(requests.length, 3);

  await assert.rejects(
    searchBangumiAnime(cache, "隔离测试", "book" as never, fetcher as typeof fetch),
    (error: unknown) => error instanceof BangumiApiError && error.status === 400 && /搜索范围无效/.test(error.message),
  );
  assert.equal(requests.length, 3);
});

test("Bangumi subject detail is canonicalized, carries subjectType, and allows type 2 or 4", async () => {
  const cache = asCache();
  let calls = 0;
  const fetcher = async (input: RequestInfo | URL) => {
    calls += 1;
    assert.equal(String(input), "https://api.bgm.tv/v0/subjects/160209");
    return new Response(JSON.stringify({ id: 160209, type: 2, name: "君の名は。", name_cn: "你的名字。" }));
  };

  const subject = await getBangumiAnimeSubject(cache, 160209, fetcher as typeof fetch);
  assert.deepEqual(subject, { id: 160209, name: "君の名は。", nameCn: "你的名字。", subjectType: 2 });
  assert.deepEqual(await getBangumiAnimeSubject(cache, 160209, async () => {
    throw new Error("cache miss");
  }), subject);
  assert.equal(calls, 1);

  const gameSubject = await getBangumiAnimeSubject(asCache(), 114514, (async () => new Response(JSON.stringify({
    id: 114514,
    type: 4,
    name: "Steins;Gate 游戏",
    name_cn: "命运石之门（游戏）",
  }))) as typeof fetch);
  assert.deepEqual(gameSubject, {
    id: 114514,
    name: "Steins;Gate 游戏",
    nameCn: "命运石之门（游戏）",
    subjectType: 4,
  });

  await assert.rejects(
    getBangumiAnimeSubject(asCache(), 114515, (async () => new Response(JSON.stringify({
      id: 114515,
      type: 1,
      name: "不是作品",
    }))) as typeof fetch),
    (error: unknown) => error instanceof BangumiApiError && error.status === 400 && /不是动画或游戏/.test(error.message),
  );
});

test("Bangumi subject characters are normalized, relation-sorted, and cached as one list", async () => {
  const cache = asCache();
  const calls: string[] = [];
  const fetcher = async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/v0/subjects/160209/characters")) {
      return new Response(JSON.stringify([
        {
          id: 17529,
          type: 1,
          name: "モブキャラクター",
          relation: "闲角",
          images: { grid: "https://lain.bgm.tv/pic/crt/g/mob.jpg" },
        },
        {
          id: 37242,
          type: 1,
          name: "宮水三葉",
          relation: "主角",
          images: { grid: "https://lain.bgm.tv/pic/crt/g/mitsuha.jpg" },
        },
        { id: 2, type: 2, name: "不是角色", relation: "客串" },
      ]));
    }
    return new Response("not found", { status: 404 });
  };

  const characters = await getBangumiSubjectCharacters(cache, 160209, fetcher as typeof fetch);
  assert.deepEqual(characters, [
    {
      id: 37242,
      name: "宮水三葉",
      relation: "主角",
      imageUrl: "https://lain.bgm.tv/pic/crt/g/mitsuha.jpg",
    },
    {
      id: 17529,
      name: "モブキャラクター",
      relation: "闲角",
      imageUrl: "https://lain.bgm.tv/pic/crt/g/mob.jpg",
    },
  ]);
  const cachedCharacters = await getBangumiSubjectCharacters(cache, 160209, async () => {
    throw new Error("cache miss");
  });
  assert.deepEqual(cachedCharacters, characters);
  assert.equal(calls.filter((url) => url.endsWith("/v0/subjects/160209/characters")).length, 1);
});

test("Bangumi search rejects punctuation-only cache keys before contacting upstream", async () => {
  let calls = 0;
  await assert.rejects(
    searchBangumiAnime(asCache(), "！！", "anime", (async () => {
      calls += 1;
      return new Response(JSON.stringify({ data: [] }));
    }) as typeof fetch),
    /必须包含文字或数字/,
  );
  assert.equal(calls, 0);
});

test("Bangumi upstream timeout and HTTP failures are normalized", async () => {
  const timeoutFetcher = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  await assert.rejects(
    searchBangumiAnime(asCache(), "超时测试", "anime", timeoutFetcher, 5),
    (error: unknown) => error instanceof BangumiApiError && error.status === 504 && /超时/.test(error.message),
  );

  await assert.rejects(
    getBangumiAnimeSubject(asCache(), 12345, (async () => new Response("rate limited", { status: 429 })) as typeof fetch),
    (error: unknown) => error instanceof BangumiApiError && error.status === 503 && /频繁/.test(error.message),
  );
  await assert.rejects(
    getBangumiAnimeSubject(asCache(), 54321, (async () => new Response("missing", { status: 404 })) as typeof fetch),
    (error: unknown) => error instanceof BangumiApiError && error.status === 404,
  );
});

test("Bangumi responses are rejected at the 4 MiB boundary before parsing", async () => {
  await assert.rejects(
    getBangumiAnimeSubject(asCache(), 101, (async () => new Response("{}", {
      headers: { "content-length": String(4 * 1024 * 1024 + 1) },
    })) as typeof fetch),
    /数据过大/,
  );

  const oversizedBytes = new Uint8Array(4 * 1024 * 1024 + 1);
  oversizedBytes.fill(0x20);
  await assert.rejects(
    getBangumiAnimeSubject(asCache(), 102, (async () => new Response(oversizedBytes)) as typeof fetch),
    /数据过大/,
  );
});

test("Bangumi character normalization remains bounded while covering known large casts", async () => {
  const payload = Array.from({ length: 1_205 }, (_, index) => ({
    id: index + 1,
    type: 1,
    name: `角色 ${index + 1}`,
    relation: "闲角",
  }));
  const characters = await getBangumiSubjectCharacters(
    asCache(),
    975,
    (async () => new Response(JSON.stringify(payload))) as typeof fetch,
  );
  assert.equal(characters.length, 1_200);
  assert.equal(characters[1_199].id, 1_200);
});
