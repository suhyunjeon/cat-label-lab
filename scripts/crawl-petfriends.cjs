const { readFile, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const CATEGORY_COMPONENT_URL = "https://bff.api.pet-friends.co.kr/category/component/2";
const DETAIL_URL = "https://m.pet-friends.co.kr/product/detail/";
const OUT = path.join(__dirname, "../data/cat-foods.json");
const URLS_OUT = path.join(__dirname, "../data/petfriends-product-urls.json");
const SKIPPED_OUT = path.join(__dirname, "../data/petfriends-skipped-products.json");
const MAX_CONCURRENCY = 4;
const EXCLUDED_BRANDS = [/네츄럴\s*코어/i, /내추럴\s*코어/i, /natural\s*core/i];

const CATEGORIES = [
  { productGroup2Id: 4, productGroup3Id: 17, mealType: "주식", label: "주식캔" },
  { productGroup2Id: 5, productGroup3Id: 20, mealType: "간식", label: "간식캔" }
];

const decode = (value) =>
  String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, "\"")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const numberAfter = (text, label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(text || "").match(new RegExp(`${escaped}\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
  return match ? Number(match[1]) : null;
};

const caloriesAfter = (text) => {
  const match = String(text || "").match(/(?:대사에너지|열량|칼로리|calorie)[^\d]{0,30}(\d+(?:\.\d+)?)\s*kcal/i);
  return match ? Number(match[1]) : null;
};

const textAfterLabel = (text, label) => {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const index = lines.findIndex((line) => line === label || line.startsWith(`${label} `));
  if (index === -1) return null;
  const sameLine = lines[index].slice(label.length).trim();
  return sameLine || lines[index + 1] || null;
};

const cleanProductTitle = (value) =>
  String(value || "")
    .replace(/\[[^\]]+]/g, " ")
    .replace(/【[^】]+】/g, " ")
    .replace(/\s*\*\s*\d+\s*(?:개입|개|입|p|팩|묶음|캔|e\.?\s*a\.?)/gi, " ")
    .replace(/\s+\d+\s*(?:개입|개|입|p|팩|묶음|캔|e\.?\s*a\.?)/gi, " ")
    .replace(/\s+\d+\s*종\s*(?:콤보|버라이어티)?/g, " ")
    .replace(/\s+버라이어티/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const hasUnknownFlavor = (product) =>
  /^(?:주식|간식)?\s*(?:캔|파우치|주식캔|간식캔)(?:\s*\d+\s*g)?$/i.test(cleanProductTitle(product));

const findFirst = (value, predicate) => {
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
};

const absoluteUrl = (value, baseUrl) => {
  if (!value || typeof value !== "string") return null;
  const normalized = value.trim().replace(/&amp;/g, "&");
  if (!/\.(?:avif|webp|png|jpe?g)(?:[?#]|$)/i.test(normalized)) return null;
  try {
    return new URL(normalized, baseUrl).href;
  } catch {
    return null;
  }
};

const imageScore = (key, value) => {
  const scoped = `${key} ${value}`;
  let score = 0;
  if (/thumbnail|thumb|main|대표|image|img|url|path/i.test(key)) score += 2;
  if (/product|goods|상품|cdn|image/i.test(scoped)) score += 2;
  if (/detail|desc|banner|review|brand|icon|logo/i.test(scoped)) score -= 2;
  return score;
};

const collectImageCandidates = (value, baseUrl, key = "", candidates = []) => {
  if (!value) return candidates;
  if (typeof value === "string") {
    const url = absoluteUrl(value, baseUrl);
    if (url) candidates.push({ url, score: imageScore(key, url) });
    return candidates;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageCandidates(item, baseUrl, key, candidates));
    return candidates;
  }
  if (typeof value === "object") {
    for (const [childKey, childValue] of Object.entries(value)) {
      collectImageCandidates(childValue, baseUrl, childKey, candidates);
    }
  }
  return candidates;
};

const thumbnailFromDetail = (detail, html, url) => {
  const fromJson = collectImageCandidates(detail, url)
    .sort((a, b) => b.score - a.score)
    .map((candidate) => candidate.url)[0];
  if (fromJson) return fromJson;

  const fromMeta =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  return absoluteUrl(fromMeta, url);
};

const isExcludedBrand = (...values) =>
  EXCLUDED_BRANDS.some((pattern) => values.some((value) => pattern.test(String(value || ""))));

async function fetchText(url, options = {}) {
  const headers = {
    accept: options.headers?.accept || "text/html,application/json",
    "user-agent": "Mozilla/5.0 compatible; WetRankKorea/1.0",
    ...options.headers
  };
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  const response = await fetch(url, {
    ...options,
    headers
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.text();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchJson(url, body) {
  return JSON.parse(
    await fetchText(url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { accept: "application/json", "content-type": "application/json" }
    })
  );
}

async function discoverCategoryProducts(category) {
  const products = [];
  let page = 0;
  let totalPages = 1;
  let memoryToken = null;

  while (page < totalPages) {
    const body = {
      mobileDeviceId: "wet-rank-korea",
      mobileOsCode: "M",
      orderTypeCode: "EXPRESS",
      productGroup1Id: 2,
      productGroup2Id: category.productGroup2Id,
      productGroup3Id: category.productGroup3Id,
      page,
      size: 30,
      filters: [{ order_by: ["product_score"] }],
      isAd: page <= 2,
      ...(memoryToken ? { memoryToken } : {})
    };
    const json = await fetchJson(CATEGORY_COMPONENT_URL, body);
    const data = json.data?.data || {};
    const contents = data.contents || [];
    products.push(...contents.map((product) => ({ ...product, mealType: category.mealType })));
    totalPages = data.totalPages || totalPages;
    memoryToken = data.memoryToken || memoryToken;
    page += 1;
  }

  return products;
}

async function discoverProductUrls() {
  const all = [];
  for (const category of CATEGORIES) {
    const products = await discoverCategoryProducts(category);
    console.log(`펫프렌즈 ${category.label} ${products.length}개 발견`);
    all.push(...products);
  }

  const byId = new Map();
  for (const product of all) {
    if (!byId.has(product.productId)) byId.set(product.productId, product);
  }

  const urls = [...byId.values()].map((product) => ({
    url: `${DETAIL_URL}${product.productId}`,
    productId: product.productId,
    mealType: product.mealType
  }));
  await mkdir(path.dirname(URLS_OUT), { recursive: true });
  await writeFile(URLS_OUT, JSON.stringify(urls, null, 2));
  return urls;
}

const extractNextData = (html) => {
  const raw = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
  return raw ? JSON.parse(raw) : null;
};

const parseProduct = async ({ url, mealType }) => {
  let detail = null;
  let html = "";
  for (let attempt = 0; attempt < 3 && !detail; attempt += 1) {
    html = await fetchText(url);
    const nextData = extractNextData(html);
    detail = findFirst(
      nextData,
      (item) => item.info?.productName && item.static
    );
    if (!detail) await sleep(300 * (attempt + 1));
  }

  if (!detail) {
    return { skipped: true, reason: "상세 데이터 없음", url };
  }

  const title = cleanProductTitle(decode(detail.info.productName));
  const staticData = detail.static;
  const attrs = staticData.attribute || {};
  const explanation = staticData.explanation || "";
  const composition = textAfterLabel(explanation, "성분구성") || attrs.attr11 || explanation;
  const brand = decode(staticData.brandName || detail.metadata?.brandName || title.split(/\s+/)[0]);
  if (isExcludedBrand(brand, title)) {
    return { skipped: true, reason: "제외 브랜드", url, title, brand };
  }

  const product = cleanProductTitle(title.replace(brand, "")) || title;
  if (hasUnknownFlavor(product)) {
    return { skipped: true, reason: "맛 정보 없는 일반 상품명", url, title, brand, product };
  }

  const categoryName = staticData.category?.productGroup3Name || "";
  const localText = decode(`${title} ${categoryName} ${staticData.relationSearch || ""} ${explanation} ${Object.values(attrs).join(" ")}`);
  const thumbnailUrl = thumbnailFromDetail(detail, html, url);

  const food = {
    brand,
    line: product.split(/\s+/).slice(0, 3).join(" "),
    product,
    format: /트레이|tray/i.test(localText) ? "tray" : /캔|can/i.test(localText) || /캔/.test(categoryName) ? "can" : /파우치|pouch/i.test(localText) ? "pouch" : "wet",
    mealType,
    origin: textAfterLabel(explanation, "원산지") || "미공개",
    maker: textAfterLabel(explanation, "제조사") || textAfterLabel(explanation, "제조사/수입사") || "미공개",
    protein: numberAfter(composition, "조단백") ?? numberAfter(composition, "조단백질"),
    fat: numberAfter(composition, "조지방"),
    fiber: numberAfter(composition, "조섬유"),
    ash: numberAfter(composition, "조회분"),
    calcium: numberAfter(composition, "칼슘"),
    phosphorus: numberAfter(composition, "인"),
    moisture: numberAfter(composition, "수분"),
    calories: caloriesAfter(localText) ?? caloriesAfter(composition),
    thumbnailUrl,
    sourceUrl: url
  };

  const isWetProduct =
    ["can", "pouch", "tray"].includes(food.format) &&
    !/\d+(?:\.\d+)?\s*kg/i.test(localText) &&
    (Number.isFinite(food.moisture) ? food.moisture >= 50 : /습식|캔|파우치|트레이|그레이비|무스|스튜|파테|테린|수분/.test(localText));

  if (!isWetProduct) {
    return { skipped: true, reason: "지원 습식 형태 아님", url, title, format: food.format, moisture: food.moisture };
  }

  if (!Number.isFinite(food.protein) || !Number.isFinite(food.fat) || !Number.isFinite(food.phosphorus)) {
    return { skipped: true, reason: "필수 성분 누락", url, title };
  }

  return { food };
};

async function mapLimit(items, limit, mapper) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (index < items.length) {
      const current = index;
      index += 1;
      try {
        results[current] = await mapper(items[current], current);
      } catch (error) {
        results[current] = { skipped: true, reason: error.message, url: items[current].url };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

const mergeFoods = (existingFoods, newFoods) => {
  const uniqueFoods = new Map();
  for (const food of [...existingFoods, ...newFoods].filter((item) => !isExcludedBrand(item.brand, item.product, item.line) && !hasUnknownFlavor(item.product))) {
    const key = [
      food.brand,
      food.product,
      food.protein,
      food.fat,
      food.phosphorus,
      food.moisture
    ].join("|");
    if (!uniqueFoods.has(key)) uniqueFoods.set(key, food);
  }
  return [...uniqueFoods.values()].sort((a, b) => {
    const brandCompare = a.brand.localeCompare(b.brand, "ko");
    return brandCompare || a.product.localeCompare(b.product, "ko");
  });
};

async function main() {
  const existing = JSON.parse(await readFile(OUT, "utf-8"));
  const baseFoods = existing.foods.filter((food) => !String(food.sourceUrl || "").includes("pet-friends.co.kr"));
  const baseSources = (existing.sources || [existing.source].filter(Boolean)).filter(
    (source) => !String(source.name || "").includes("펫프렌즈")
  );
  const urls = await discoverProductUrls();
  console.log(`펫프렌즈 상품 URL ${urls.length}개 확인 시작`);

  const results = await mapLimit(urls, MAX_CONCURRENCY, async (item, index) => {
    if ((index + 1) % 100 === 0) console.log(`${index + 1}/${urls.length}개 확인 중`);
    return parseProduct(item);
  });

  const petfriendsFoods = results.map((result) => result.food).filter(Boolean);
  const skipped = results.filter((result) => result?.skipped);
  if (petfriendsFoods.length === 0) {
    await writeFile(SKIPPED_OUT, JSON.stringify(skipped, null, 2));
    throw new Error("펫프렌즈 습식 제품 데이터가 0개라 기존 데이터 파일을 덮어쓰지 않았습니다.");
  }

  const foods = mergeFoods(baseFoods, petfriendsFoods);
  const petfriendsSource = {
    name: "펫프렌즈 공개 상품 페이지",
    url: "https://m.pet-friends.co.kr/category/2/4/17",
    retrievedAt: new Date().toISOString().slice(0, 10),
    totalProductUrlsChecked: urls.length,
    skippedProducts: skipped.length
  };
  const sources = [...baseSources, petfriendsSource];
  await writeFile(
    OUT,
    JSON.stringify(
      {
        source: {
          name: "고양이대통령 + 펫프렌즈 공개 상품 페이지",
          url: "https://catpre.com/sitemap.xml, https://m.pet-friends.co.kr/category/2/4/17",
          notes: "고양이대통령 사이트맵과 펫프렌즈 고양이 주식캔/간식캔 공개 상품 페이지를 순회해 대한민국에서 판매되는 고양이 습식 캔/파우치/트레이를 자동 수집했습니다. 조단백, 조지방, 인, 수분은 국내 라벨의 보장성분 표기값 기준입니다.",
          retrievedAt: new Date().toISOString().slice(0, 10),
          totalProductUrlsChecked: sources.reduce((total, source) => total + (source.totalProductUrlsChecked || 0), 0),
          skippedProducts: sources.reduce((total, source) => total + (source.skippedProducts || 0), 0)
        },
        sources,
        foods
      },
      null,
      2
    )
  );
  await writeFile(SKIPPED_OUT, JSON.stringify(skipped, null, 2));

  console.log(`펫프렌즈 습식 제품 ${petfriendsFoods.length}개 추가 후보 저장`);
  console.log(`병합 후 전체 ${foods.length}개`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
