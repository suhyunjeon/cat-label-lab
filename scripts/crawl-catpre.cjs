const { readFile, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");

const SITEMAP_URL = "https://catpre.com/sitemap.xml";
const SEED_URLS_FILE = path.join(__dirname, "../data/catpre-product-urls.json");
const OUT = path.join(__dirname, "../data/cat-foods.json");
const SKIPPED_OUT = path.join(__dirname, "../data/catpre-skipped-products.json");
const MAX_CONCURRENCY = 8;
const EXCLUDED_BRANDS = [/네츄럴\s*코어/i, /내추럴\s*코어/i, /natural\s*core/i];

const decode = (value) =>
  value
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
  const match = text.match(new RegExp(`${escaped}\\s*(\\d+(?:\\.\\d+)?)\\s*%`, "i"));
  return match ? Number(match[1]) : null;
};

const valueAfterHeading = (html, heading) => {
  const pattern = new RegExp(`<h5[^>]*>\\s*${heading}\\s*<\\/h5>\\s*<p[^>]*>([\\s\\S]*?)<\\/p>`, "i");
  const match = html.match(pattern);
  return match ? decode(match[1]) : null;
};

const titleFromHtml = (html) => {
  const explicit = html.match(/item_name:\s*"([^"]+)"/)?.[1] || html.match(/title:\s*'([^']+?)\s*\|\s*고양이대통령'/)?.[1];
  if (explicit) return decode(explicit);
  const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)?.[1];
  return h2 ? decode(h2) : null;
};

const absoluteUrl = (value, baseUrl) => {
  if (!value) return null;
  if (/\/static\/img\/catpre\/og\.jpg(?:[?#]|$)/i.test(value)) return null;
  if (!/\.(?:avif|webp|png|jpe?g)(?:[?#]|$)/i.test(value)) return null;
  try {
    return new URL(value.replace(/&amp;/g, "&"), baseUrl).href;
  } catch {
    return null;
  }
};

const imageScore = (value) => {
  let score = 0;
  if (/\/mobile\/catpre\/product\//i.test(value)) score += 6;
  if (/detailView/i.test(value)) score += 4;
  if (/\/mobile\/catpre\/event\/bundle\//i.test(value)) score -= 3;
  if (/desc|brand|icon|logo|empty|og\.jpg/i.test(value)) score -= 5;
  return score;
};

const thumbnailFromHtml = (html, url) => {
  const directCandidates = [
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1],
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1],
    html.match(/item_image:\s*["']([^"']+)["']/i)?.[1],
    html.match(/image:\s*["']([^"']+)["']/i)?.[1],
    html.match(/<img[^>]+(?:class|id)=["'][^"']*(?:goods|product|thumbnail|thumb)[^"']*["'][^>]+src=["']([^"']+)["']/i)?.[1],
    html.match(/<img[^>]+src=["']([^"']+)["'][^>]+(?:class|id)=["'][^"']*(?:goods|product|thumbnail|thumb)[^"']*["']/i)?.[1]
  ];
  const imgCandidates = [...html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi)].map((match) => match[1]);
  return [...directCandidates, ...imgCandidates]
    .map((candidate) => absoluteUrl(candidate, url))
    .filter(Boolean)
    .sort((a, b) => imageScore(b) - imageScore(a))[0] || null;
};

const brandFromTitle = (title) => title.split(/\s+/)[0] || "브랜드 미상";

const isExcludedBrand = (...values) =>
  EXCLUDED_BRANDS.some((pattern) => values.some((value) => pattern.test(String(value || ""))));

const inferFormat = (title, localText) => {
  const scoped = `${title} ${localText}`;
  if (scoped.includes("캔")) return "can";
  if (scoped.includes("파우치")) return "pouch";
  return "wet";
};

const inferMealType = (title, localText) => {
  const scoped = `${title} ${localText}`;
  const hasMeal = /주식|주식용|AAFCO|균형잡힌 영양|균형 잡힌 영양|영양 기준/.test(scoped);
  const hasSnack = /간식|스낵|토핑|트릿/.test(scoped);
  if (hasMeal) return "주식";
  if (hasSnack) return "간식";
  return "확인필요";
};

const isWetCan = (food, composition, localText) => {
  const scoped = `${food.product} ${food.line} ${localText}`;
  const isCan = food.format === "can";
  const looksWet = Number.isFinite(food.moisture) ? food.moisture >= 50 : /습식|캔|그레이비|무스|스튜|파테|테린|수분/.test(scoped);
  const notDryBulk = !/\d+(?:\.\d+)?\s*kg/.test(scoped) && !(Number.isFinite(food.moisture) && food.moisture <= 20);
  return isCan && looksWet && notDryBulk && composition.includes("조단백") && composition.includes("조지방") && composition.includes("인");
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

const normalizeProduct = (brand, title) => cleanProductTitle(title.replace(brand, ""));

const hasUnknownFlavor = (product) =>
  /^(?:주식|간식)?\s*(?:캔|파우치|주식캔|간식캔)(?:\s*\d+\s*g)?$/i.test(cleanProductTitle(product));

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "Mozilla/5.0 compatible; WetRankKorea/1.0"
    }
  });
  if (!response.ok) throw new Error(`${response.status}`);
  return response.text();
}

async function discoverProductUrls() {
  try {
    const sitemap = await fetchText(SITEMAP_URL);
    const urls = [...sitemap.matchAll(/<loc>(https:\/\/catpre\.com\/product\/[^<]+)<\/loc>/g)].map((match) => match[1].replace(/&amp;/g, "&"));
    return [...new Set(urls)];
  } catch (error) {
    console.warn(`사이트맵을 읽지 못해 seed URL을 사용합니다: ${error.message}`);
    return JSON.parse(await readFile(SEED_URLS_FILE, "utf-8"));
  }
}

async function parseProduct(url) {
  const html = await fetchText(url);
  const title = cleanProductTitle(titleFromHtml(html));
  const thumbnailUrl = thumbnailFromHtml(html, url);
  const composition = valueAfterHeading(html, "성분구성") || "";
  const origin = valueAfterHeading(html, "원산지") || "미공개";
  const maker = valueAfterHeading(html, "제조사/수입사") || "미공개";
  const compositionIndex = html.indexOf("성분구성");
  const titleIndex = title ? html.indexOf(title) : -1;
  const start = Math.max(0, Math.min(...[compositionIndex, titleIndex].filter((index) => index > -1)) - 3500);
  const end = compositionIndex > -1 ? compositionIndex + 1000 : start + 5000;
  const localText = decode(html.slice(start, end));

  if (!title || !composition) {
    return { skipped: true, reason: "상품명 또는 성분구성 없음", url };
  }

  const brand = brandFromTitle(title);
  if (isExcludedBrand(brand, title)) {
    return { skipped: true, reason: "제외 브랜드", url, title, brand };
  }

  const product = normalizeProduct(brand, title);
  if (hasUnknownFlavor(product)) {
    return { skipped: true, reason: "맛 정보 없는 일반 상품명", url, title, brand, product };
  }

  const food = {
    brand,
    line: product.split(/\s+/).slice(0, 3).join(" "),
    product,
    format: inferFormat(title, localText),
    mealType: inferMealType(title, localText),
    origin,
    maker,
    protein: numberAfter(composition, "조단백") ?? numberAfter(composition, "조단백질"),
    fat: numberAfter(composition, "조지방"),
    fiber: numberAfter(composition, "조섬유"),
    ash: numberAfter(composition, "조회분"),
    calcium: numberAfter(composition, "칼슘"),
    phosphorus: numberAfter(composition, "인"),
    moisture: numberAfter(composition, "수분"),
    thumbnailUrl,
    sourceUrl: url
  };

  if (!isWetCan(food, composition, localText)) {
    return { skipped: true, reason: "습식 캔 아님", url, title, format: food.format, moisture: food.moisture };
  }

  if (!Number.isFinite(food.protein) || !Number.isFinite(food.fat) || !Number.isFinite(food.phosphorus)) {
    return { skipped: true, reason: "필수 성분 누락", url, title };
  }

  return { food };
}

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
        results[current] = { skipped: true, reason: error.message, url: items[current] };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const urls = await discoverProductUrls();
  console.log(`상품 URL ${urls.length}개 발견`);
  const results = await mapLimit(urls, MAX_CONCURRENCY, async (url, index) => {
    if ((index + 1) % 100 === 0) console.log(`${index + 1}/${urls.length}개 확인 중`);
    return parseProduct(url);
  });

  const uniqueFoods = new Map();
  for (const food of results.map((result) => result.food).filter(Boolean)) {
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

  const foods = [...uniqueFoods.values()].sort((a, b) => {
    const brandCompare = a.brand.localeCompare(b.brand, "ko");
    return brandCompare || a.product.localeCompare(b.product, "ko");
  });
  const skipped = results.filter((result) => result?.skipped);

  if (foods.length === 0) {
    await writeFile(SKIPPED_OUT, JSON.stringify(skipped, null, 2));
    throw new Error("습식 캔 데이터가 0개라 기존 데이터 파일을 덮어쓰지 않았습니다.");
  }

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(
    OUT,
    JSON.stringify(
      {
        source: {
          name: "고양이대통령 공개 상품 페이지",
          url: "https://catpre.com/sitemap.xml",
          notes: "고양이대통령 사이트맵의 상품 상세 페이지를 순회해 대한민국에서 판매되는 고양이 습식 캔을 자동 수집했습니다. 조단백, 조지방, 인, 수분은 국내 라벨의 보장성분 표기값 기준입니다.",
          retrievedAt: new Date().toISOString().slice(0, 10),
          totalProductUrlsChecked: urls.length,
          skippedProducts: skipped.length
        },
        foods
      },
      null,
      2
    )
  );
  await writeFile(SKIPPED_OUT, JSON.stringify(skipped, null, 2));

  const mealCount = foods.reduce((acc, food) => {
    acc[food.mealType] = (acc[food.mealType] || 0) + 1;
    return acc;
  }, {});
  console.log(`${foods.length}개 습식 캔 저장`);
  console.log(`주식 ${mealCount["주식"] || 0}개, 간식 ${mealCount["간식"] || 0}개, 확인필요 ${mealCount["확인필요"] || 0}개`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
