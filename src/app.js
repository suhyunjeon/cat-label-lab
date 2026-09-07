const dataset = await fetch(`/data/cat-foods.json?v=${Date.now()}`).then((response) => {
  if (!response.ok) throw new Error("데이터를 불러오지 못했습니다.");
  return response.json();
});

const metrics = {
  phosphorus: { label: "인", unit: "%", help: "국내 상품 라벨의 보장성분 표기값입니다. 낮은 인을 찾을 때 먼저 보는 항목이에요." },
  protein: { label: "조단백", unit: "%", help: "국내 상품 라벨의 조단백 보장성분입니다. 습식은 수분이 많아 건식과 직접 비교하면 안 됩니다." },
  fat: { label: "조지방", unit: "%", help: "국내 상품 라벨의 조지방 보장성분입니다. 체중 관리 중이면 낮은 지방 후보도 함께 보세요." }
};

const dataStats = {
  total: dataset.foods.length,
  staple: dataset.foods.filter((food) => food.mealType === "주식").length,
  snack: dataset.foods.filter((food) => food.mealType === "간식").length,
  unknown: dataset.foods.filter((food) => food.mealType === "확인필요").length,
  lowPhos: dataset.foods.filter((food) => food.phosphorus <= 0.1).length,
  maxPhos: Math.ceil(Math.max(...dataset.foods.map((food) => food.phosphorus)) * 100) / 100,
  minProtein: Math.floor(Math.min(...dataset.foods.map((food) => food.protein)) * 10) / 10,
  maxProtein: Math.ceil(Math.max(...dataset.foods.map((food) => food.protein)) * 10) / 10,
  maxFat: Math.ceil(Math.max(...dataset.foods.map((food) => food.fat)) * 10) / 10
};

const state = {
  metric: "phosphorus",
  direction: "asc",
  query: "",
  checkerQuery: "",
  selectedFoodKey: "",
  mealType: "all",
  typeFilter: "all",
  originFilter: "all",
  formatFilter: "all",
  renalOnly: false,
  maxPhos: dataStats.maxPhos,
  minProtein: dataStats.minProtein,
  maxFat: dataStats.maxFat
};

const fmt = (value, digits = 2) => (Number.isFinite(value) ? Number(value).toFixed(digits).replace(/\.?0+$/, "") : "-");
const fmtLabel = (value, digits = 1) => (Number.isFinite(value) ? `${fmt(value, digits)}%` : "미공개");

const packageGrams = (food) => {
  if (Number.isFinite(food.weightGrams)) return food.weightGrams;
  const match = `${food.product} ${food.line}`.match(/(\d+(?:\.\d+)?)\s*g\b/i);
  return match ? Number(match[1]) : null;
};

const caloriesPer100g = (food) => {
  const explicit = food.kcalPer100g ?? food.caloriesPer100g ?? food.calorieDensity ?? food.energyKcalPer100g;
  if (Number.isFinite(explicit)) return explicit;
  const totalCalories = food.calories ?? food.kcal ?? food.energyKcal;
  const grams = packageGrams(food);
  if (!Number.isFinite(totalCalories) || !Number.isFinite(grams) || grams <= 0) return null;
  return (totalCalories / grams) * 100;
};

const fmtCalories = (food) => {
  const value = caloriesPer100g(food);
  return Number.isFinite(value) ? `${fmt(value, 0)} kcal/100g` : "미공개";
};

const fmtCaloriesBasis = (food) => {
  const totalCalories = food.calories ?? food.kcal ?? food.energyKcal;
  const grams = packageGrams(food);
  if (Number.isFinite(totalCalories) && Number.isFinite(grams)) return `${fmt(totalCalories, 0)} kcal/${fmt(grams, 0)}g`;
  if (Number.isFinite(totalCalories)) return `${fmt(totalCalories, 0)} kcal`;
  return "열량 미공개";
};

const dryMatter = (food, key) => {
  if (!Number.isFinite(food[key]) || !Number.isFinite(food.moisture) || food.moisture >= 100) return null;
  return (food[key] / (100 - food.moisture)) * 100;
};

const fmtDm = (food, key, digits = 1) => {
  const dm = dryMatter(food, key);
  if (!Number.isFinite(food[key])) return "미공개";
  return Number.isFinite(dm) ? `${fmt(dm, digits)}% DM` : "DM 계산 불가";
};

const nutrientCell = (food, key, digits = 1, toneClass = "") => {
  const badgeClass = toneClass ? `badge ${toneClass}` : "badge";
  return `
    <div class="nutrientCell">
      <span class="${badgeClass}">${fmtDm(food, key, digits)}</span>
      <small>라벨 ${fmtLabel(food[key], digits)}</small>
    </div>
  `;
};

const scoreFood = (food) => {
  const proteinDm = dryMatter(food, "protein") ?? food.protein * 4;
  const fatDm = dryMatter(food, "fat") ?? food.fat * 4;
  const phosScore = Math.max(0, 1 - (food.phosphorus - 0.05) / 0.2) * 36;
  const proteinScore = Math.min(proteinDm / 55, 1) * 34;
  const fatScore = Math.max(0, 1 - Math.abs(fatDm - 18) / 22) * 18;
  const mealScore = food.mealType === "주식" ? 12 : food.mealType === "확인필요" ? 6 : 0;
  return Math.round(phosScore + proteinScore + fatScore + mealScore);
};

const phosTone = (value) => {
  if (value <= 0.1) return "good";
  if (value <= 0.18) return "ok";
  return "watch";
};

const phosphorusDm = (food) => dryMatter(food, "phosphorus");

const isRenalCandidate = (food) => {
  const dm = phosphorusDm(food);
  return food.phosphorus <= 0.1 && (!Number.isFinite(dm) || dm <= 1);
};

const textKey = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/\s+/g, "");

const classifyFood = (food) => {
  const proteinDm = dryMatter(food, "protein");
  const phosphorusDm = dryMatter(food, "phosphorus");
  const stapleLikeSnack =
    food.mealType === "간식" &&
    Number.isFinite(proteinDm) &&
    Number.isFinite(phosphorusDm) &&
    proteinDm >= 35 &&
    phosphorusDm <= 1.5;

  if (food.mealType === "주식") {
    return { label: "주식", tone: "staple", detail: "AAFCO/주식 기준" };
  }
  if (stapleLikeSnack) {
    return { label: "간식 · 성분 양호", tone: "bridge", detail: "간식 표기 · 성분 양호" };
  }
  if (food.mealType === "간식") {
    return { label: "간식", tone: "snack", detail: "간식 표기" };
  }
  return { label: "유형 미확인", tone: "unknown", detail: "주식/간식 표기 미확인" };
};

const checkerMatches = () => {
  const query = textKey(state.checkerQuery);
  if (!query) return [];
  return dataset.foods
    .map((food) => {
      const haystack = textKey(`${food.brand}${food.line}${food.product}`);
      const brand = textKey(food.brand);
      const product = textKey(food.product);
      let rank = 0;
      if (product === query || haystack === query) rank += 80;
      if (product.includes(query)) rank += 40;
      if (haystack.includes(query)) rank += 28;
      if (query.includes(product) && product.length > 4) rank += 22;
      if (brand && query.includes(brand)) rank += 8;
      return { ...food, score: scoreFood(food), matchRank: rank, classification: classifyFood(food) };
    })
    .filter((food) => food.matchRank > 0)
    .sort((a, b) => b.matchRank - a.matchRank || b.score - a.score)
    .slice(0, 6);
};

const foodId = (food) => `${food.brand}-${food.line}-${food.product}`;

const foodKey = (food) => encodeURIComponent(food.sourceUrl || foodId(food));

const foodByKey = (key) => dataset.foods.find((food) => foodKey(food) === key);

const formatLabel = (format) => (format === "pouch" ? "파우치" : format === "can" ? "캔" : "기타");

const typeFilterValue = (food) => {
  const classification = classifyFood(food);
  if (classification.tone === "bridge") return "goodSnack";
  if (classification.tone === "unknown") return "unknown";
  return food.mealType === "주식" ? "staple" : food.mealType === "간식" ? "snack" : "unknown";
};

const uniqueOptions = (values) =>
  [...new Set(values.filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, "ko"))
    .map((value) => `<option value="${value}">${value}</option>`)
    .join("");

const originOptions = uniqueOptions(dataset.foods.map((food) => food.origin || "미공개"));

const thumbnailMarkup = (food) =>
  food.thumbnailUrl
    ? `<img class="foodThumb" src="${food.thumbnailUrl}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('isMissing')" />`
    : `<span class="foodThumb empty" aria-hidden="true"></span>`;

const renalBadge = (food) => (isRenalCandidate(food) ? `<span class="renalBadge">신장 관리 후보</span>` : "");

const nutrientDetail = (food, key, label, digits = 1, toneClass = "") => {
  return `
    <div class="detailMetric ${toneClass}">
      <span>${label}</span>
      <strong>${fmtDm(food, key, digits)}</strong>
      <small>라벨 ${fmtLabel(food[key], digits)}</small>
    </div>
  `;
};

const calorieCell = (food) => `
  <div class="nutrientCell">
    <span class="badge">${fmtCalories(food)}</span>
    <small>${fmtCaloriesBasis(food)}</small>
  </div>
`;

const calorieDetail = (food) => `
  <div class="detailMetric">
    <span>단위칼로리</span>
    <strong>${fmtCalories(food)}</strong>
    <small>${fmtCaloriesBasis(food)}</small>
  </div>
`;

const insightList = (food) => {
  const proteinDm = dryMatter(food, "protein");
  const fatDm = dryMatter(food, "fat");
  const phosDm = dryMatter(food, "phosphorus");
  return [
    Number.isFinite(phosDm) && phosDm <= 1 ? `건물 기준 인 ${fmt(phosDm)}%로 낮은 편입니다.` : `건물 기준 인 ${fmt(phosDm)}%입니다.`,
    Number.isFinite(proteinDm) && proteinDm >= 45 ? `건물 기준 단백질 ${fmt(proteinDm, 1)}%로 단백 비중이 높은 제품입니다.` : `건물 기준 단백질 ${fmt(proteinDm, 1)}%입니다.`,
    Number.isFinite(fatDm) ? `건물 기준 지방 ${fmt(fatDm, 1)}%로 함께 비교해볼 수 있습니다.` : "지방 DM 값은 수분 정보가 있어야 계산됩니다.",
    classifyFood(food).detail
  ];
};

const detailPanelMarkup = (food) => {
  if (!food) {
    return `
      <div class="detailEmpty">
        ${icon.lab}
        <p>제품을 누르면 라벨 기준값과 DM(건물 기준) 환산값을 자세히 볼 수 있습니다.</p>
      </div>
    `;
  }
  const classification = classifyFood(food);
  const score = scoreFood(food);
  return `
    <div class="detailHeader">
      ${thumbnailMarkup(food)}
      <div>
        <span class="typeBadge ${classification.tone}">${classification.label}</span>
        <h2>${food.brand}</h2>
        <p>${food.line} · ${food.product}</p>
      </div>
    </div>
    <div class="detailActions">
      ${renalBadge(food)}
      <span>${formatLabel(food.format)}</span>
      <span>${food.origin || "원산지 미공개"}</span>
      <span>${score}점</span>
    </div>
    <div class="detailMetrics">
      ${nutrientDetail(food, "phosphorus", "인", 2, phosTone(food.phosphorus))}
      ${nutrientDetail(food, "protein", "조단백", 1)}
      ${nutrientDetail(food, "fat", "조지방", 1)}
      ${nutrientDetail(food, "sodium", "나트륨", 3)}
      ${calorieDetail(food)}
      <div class="detailMetric">
        <span>수분</span>
        <strong>${fmt(food.moisture, 1)}%</strong>
        <small>라벨 기준</small>
      </div>
    </div>
    <dl class="detailSpecs">
      <div><dt>조섬유</dt><dd>${fmt(food.fiber, 1)}%</dd></div>
      <div><dt>조회분</dt><dd>${fmt(food.ash, 1)}%</dd></div>
      <div><dt>칼슘</dt><dd>${fmt(food.calcium, 3)}%</dd></div>
      <div><dt>제조사</dt><dd>${food.maker || "미공개"}</dd></div>
    </dl>
    <ul class="detailInsights">
      ${insightList(food)
        .map((item) => `<li>${item}</li>`)
        .join("")}
    </ul>
    <p class="detailNotice">국내 상품 페이지의 보장성분 표기값 기준입니다. 질환 관리와 처방식 판단은 수의사 상담을 우선하세요.</p>
  `;
};

const rows = () =>
  dataset.foods
    .map((food) => ({ ...food, score: scoreFood(food) }))
    .filter((food) => state.mealType === "all" || food.mealType === state.mealType)
    .filter((food) => state.typeFilter === "all" || typeFilterValue(food) === state.typeFilter)
    .filter((food) => state.originFilter === "all" || (food.origin || "미공개") === state.originFilter)
    .filter((food) => state.formatFilter === "all" || food.format === state.formatFilter)
    .filter((food) => !state.renalOnly || isRenalCandidate(food))
    .filter((food) => `${food.brand} ${food.line} ${food.product} ${food.origin}`.toLowerCase().includes(state.query.toLowerCase()))
    .filter((food) => food.phosphorus <= state.maxPhos && food.protein >= state.minProtein && food.fat <= state.maxFat)
    .sort((a, b) => {
      const delta = a[state.metric] - b[state.metric];
      return state.direction === "asc" ? delta : -delta;
    });

const recommended = dataset.foods
  .map((food) => ({ ...food, score: scoreFood(food) }))
  .filter((food) => food.mealType === "주식" && food.phosphorus <= 0.2 && food.protein >= 7)
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);

const icon = {
  cat: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 9 3.5 3.5 9 6h6l5.5-2.5L19 9v4.5A7 7 0 0 1 12 20a7 7 0 0 1-7-6.5V9Z"/><path d="M9 13h.01M15 13h.01M10 16c1.1.7 2.9.7 4 0"/></svg>`,
  award: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="5"/><path d="m8.5 12.5-1.2 7 4.7-2.6 4.7 2.6-1.2-7"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h3M11 17h9"/><circle cx="16" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>`,
  search: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m16.5 16.5 4 4"/></svg>`,
  lab: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3h6M10 3v6l-5 8a3 3 0 0 0 2.6 4.5h8.8A3 3 0 0 0 19 17l-5-8V3"/><path d="M8 15h8"/></svg>`,
  external: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"/><path d="M20 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4"/></svg>`
};

const app = document.querySelector("#root");

app.innerHTML = `
  <main>
    <header class="appHeader">
      <div class="headerInner">
        <div>
          <div class="brand">${icon.cat} 캣라벨랩</div>
          <h1>한국 판매 습식 성분 랭커</h1>
          <p>국내 판매 고양이 습식 제품의 보장성분을 한눈에 비교합니다.</p>
        </div>
        <div class="summaryStats" aria-label="데이터 요약">
          <span><strong>${dataStats.total}</strong>습식 캔</span>
          <span><strong>${dataStats.staple}</strong>주식</span>
          <span><strong>${dataStats.snack}</strong>간식</span>
          <span><strong>${dataStats.unknown}</strong>유형 미확인</span>
        </div>
      </div>
    </header>

    <section class="recommend">
      <div class="sectionTitle">${icon.award}<h2>추천 후보</h2></div>
      <p class="recommendCriteria">추천 후보는 주식 제품 중 인 0.20% 이하, 조단백 7.0% 이상인 제품을 대상으로 인 낮음, 건물 기준 단백질, 지방 균형, 주식 여부를 점수화해 상위 5개를 보여줍니다.</p>
      <div class="recommendGrid">
        ${recommended
          .map(
            (food, index) => `
              <article class="pick" data-food-key="${foodKey(food)}" role="button" tabindex="0" aria-label="${foodId(food)} 상세 보기">
                <div class="pickTop">
                  ${thumbnailMarkup(food)}
                  <div class="rank">${index + 1}</div>
                </div>
                <h3>${food.brand}</h3>
                <p>${food.product}</p>
                <div class="pillRow">
                  <span class="${phosTone(food.phosphorus)}">인 ${fmtDm(food, "phosphorus", 2)} · 라벨 ${fmt(food.phosphorus)}%</span>
                  <span>단백 ${fmtDm(food, "protein", 1)} · 라벨 ${fmt(food.protein, 1)}%</span>
                  <span>지방 ${fmtDm(food, "fat", 1)} · 라벨 ${fmt(food.fat, 1)}%</span>
                  <span>${food.mealType}</span>
                  ${renalBadge(food)}
                  <span>${food.score}점</span>
                </div>
              </article>
            `
          )
          .join("")}
      </div>
    </section>

    <section class="workspace">
      <aside class="controls">
        <div class="sectionTitle">${icon.sliders}<h2>필터</h2></div>
        <label class="searchBox">
          ${icon.search}
          <input id="query" placeholder="브랜드, 제품명, 원산지 검색" />
        </label>
        <div class="field">
          <span>급여유형</span>
          <div class="segments" id="mealButtons">
            <button class="active" data-meal-type="all">전체</button>
            <button data-meal-type="주식">주식</button>
            <button data-meal-type="간식">간식</button>
            <button data-meal-type="확인필요">유형 미확인</button>
          </div>
          <p class="typeHelp">주식은 상품 페이지의 AAFCO 또는 주식 기준 표기를 우선해 분류합니다. 성분 양호 표시는 간식으로 판매되지만 단백질과 인 수치가 비교적 좋은 제품입니다.</p>
        </div>
        <label class="toggleField">
          <input id="renalOnly" type="checkbox" />
          <span>신장 관리 후보만</span>
        </label>
        <p class="typeHelp">신장 관리 후보는 인 0.10% 이하, 수분 정보가 있으면 건물 기준 인 1.0% 이하인 저인 습식입니다. 처방식 대체 판단은 수의사 상담이 우선입니다.</p>
        <div class="checker">
          <div class="sectionTitle">${icon.search}<h2>상품명 검색</h2></div>
          <label class="searchBox">
            ${icon.search}
            <input id="checkerQuery" placeholder="예: 쉐지애 참치 브로스" />
          </label>
          <div id="checkerResults" class="checkerResults"></div>
        </div>
        <div class="note">${icon.lab}<p>모든 수치는 국내 상품 페이지의 라벨 기준입니다. 처방식이나 질환 관리는 반드시 수의사 기준을 우선하세요.</p></div>
      </aside>

      <section class="tablePanel">
        <div class="toolbar">
          <div>
            <h2>성분 정렬</h2>
            <p id="rowCount"></p>
          </div>
          <div class="sorters" id="sorters">
            <button class="active" data-metric="phosphorus">인</button>
            <button data-metric="protein">조단백</button>
            <button data-metric="fat">조지방</button>
            <button class="iconButton" id="direction" aria-label="정렬 방향 바꾸기" title="정렬 방향 바꾸기">↓</button>
          </div>
        </div>
        <div class="metricHelp" id="metricHelp"></div>
        <div class="tableRanges">
          <label class="field">
            <span id="maxPhosLabel">최대 인: ${fmt(state.maxPhos)}%</span>
            <input id="maxPhos" type="range" min="0.01" max="${dataStats.maxPhos}" step="0.01" value="${state.maxPhos}" />
          </label>
          <label class="field">
            <span id="minProteinLabel">최소 조단백: ${fmt(state.minProtein, 1)}%</span>
            <input id="minProtein" type="range" min="${dataStats.minProtein}" max="${dataStats.maxProtein}" step="0.1" value="${state.minProtein}" />
          </label>
          <label class="field">
            <span id="maxFatLabel">최대 조지방: ${fmt(state.maxFat, 1)}%</span>
            <input id="maxFat" type="range" min="0" max="${dataStats.maxFat}" step="0.1" value="${state.maxFat}" />
          </label>
        </div>
        <div class="tableFilters" aria-label="성분 정렬 필터">
          <label class="tableSearch">
            ${icon.search}
            <input id="tableQuery" placeholder="검색어" />
          </label>
          <label class="selectField">
            <span>유형</span>
            <select id="typeFilter">
              <option value="all">전체</option>
              <option value="staple">주식</option>
              <option value="snack">간식</option>
              <option value="goodSnack">간식 · 성분 양호</option>
              <option value="unknown">유형 미확인</option>
            </select>
          </label>
          <label class="selectField">
            <span>원산지</span>
            <select id="originFilter">
              <option value="all">전체</option>
              ${originOptions}
            </select>
          </label>
          <label class="selectField">
            <span>형태</span>
            <select id="formatFilter">
              <option value="all">전체</option>
              <option value="can">캔</option>
              <option value="pouch">파우치</option>
              <option value="wet">기타</option>
            </select>
          </label>
        </div>
        <div class="tableWrap">
          <table>
            <thead>
              <tr>
                <th>제품</th>
                <th>형태</th>
                <th>유형</th>
                <th>원산지</th>
                <th>인</th>
                <th>조단백</th>
                <th>조지방</th>
                <th>나트륨</th>
                <th>단위칼로리</th>
                <th>수분</th>
                <th>추천점수</th>
                <th>출처</th>
              </tr>
            </thead>
            <tbody id="foodRows"></tbody>
          </table>
        </div>
      </section>
    </section>

    <div class="detailOverlay" id="detailOverlay" aria-hidden="true">
      <button class="detailScrim" id="detailScrim" type="button" aria-label="상세 닫기"></button>
      <aside class="detailPanel" aria-label="제품 상세 정보" aria-live="polite">
        <button class="detailClose" id="detailClose" type="button" aria-label="상세 닫기">x</button>
        <div id="detailContent">${detailPanelMarkup(null)}</div>
      </aside>
    </div>

    <button class="topButton" id="topButton" type="button" aria-label="맨 위로 이동">↑ TOP</button>

    <footer class="siteFooter">
      <p>애봉·봉순·순애 고양이 집사가 만들었어요. <a href="https://blog.naver.com/colbi_orda/" target="_blank" rel="noreferrer">블로그 보기</a></p>
      <p>본 서비스는 고양이 습식 제품의 보장성분 비교를 돕기 위한 무료 참고 도구이며, 수의사의 진료·처방을 대체하지 않습니다.</p>
    </footer>
  </main>
`;

const renderRows = () => {
  const currentRows = rows();
  document.querySelector("#rowCount").textContent = `${currentRows.length}개 제품 표시 중`;
  document.querySelector("#metricHelp").textContent = `${metrics[state.metric].label}: ${metrics[state.metric].help} 표시는 라벨 기준값과 DM(건물 기준) 환산값을 함께 보여줍니다.`;
  document.querySelector("#direction").textContent = state.direction === "asc" ? "↓" : "↑";
  document.querySelector("#query").value = state.query;
  document.querySelector("#tableQuery").value = state.query;
  document.querySelector("#typeFilter").value = state.typeFilter;
  document.querySelector("#originFilter").value = state.originFilter;
  document.querySelector("#formatFilter").value = state.formatFilter;
  document.querySelector("#maxFat").value = state.maxFat;
  document.querySelector("#foodRows").innerHTML = currentRows
    .map(
      (food) => `
        <tr data-food-key="${foodKey(food)}" tabindex="0" aria-label="${foodId(food)} 상세 보기">
          <td>
            <div class="productCell">
              ${thumbnailMarkup(food)}
              <div>
                <strong>${food.brand}</strong>
                <span>${food.line} · ${food.product}</span>
              </div>
            </div>
          </td>
          <td>${formatLabel(food.format)}</td>
          <td>
            <span class="typeBadge ${classifyFood(food).tone}">${classifyFood(food).label}</span>
            ${renalBadge(food)}
          </td>
          <td>${food.origin}</td>
          <td>${nutrientCell(food, "phosphorus", 2, phosTone(food.phosphorus))}</td>
          <td>${nutrientCell(food, "protein", 1)}</td>
          <td>${nutrientCell(food, "fat", 1)}</td>
          <td>${nutrientCell(food, "sodium", 3)}</td>
          <td>${calorieCell(food)}</td>
          <td>${fmt(food.moisture, 1)}%</td>
          <td>${food.score}</td>
          <td><a href="${food.sourceUrl}" target="_blank" rel="noreferrer" aria-label="${foodId(food)} 출처 열기">${icon.external}</a></td>
        </tr>
      `
    )
    .join("");
};

const renderChecker = () => {
  const resultBox = document.querySelector("#checkerResults");
  const matches = checkerMatches();
  if (!state.checkerQuery.trim()) {
    resultBox.innerHTML = "";
    return;
  }
  if (!matches.length) {
    resultBox.innerHTML = `<p class="emptyResult">일치 상품 없음</p>`;
    return;
  }
  resultBox.innerHTML = matches
    .map(
      (food) => `
        <article class="checkerItem" data-food-key="${foodKey(food)}" role="button" tabindex="0" aria-label="${foodId(food)} 상세 보기">
          ${thumbnailMarkup(food)}
          <div>
            <div class="checkerItemTop">
              <strong>${food.brand}</strong>
              <span class="typeBadge ${food.classification.tone}">${food.classification.label}</span>
            </div>
            <p>${food.product}</p>
            <div class="miniFacts">
              <span>${food.classification.detail}</span>
              <span>인 ${fmtDm(food, "phosphorus", 2)} · 라벨 ${fmt(food.phosphorus)}%</span>
              <span>단백 ${fmtDm(food, "protein", 1)} · 라벨 ${fmt(food.protein, 1)}%</span>
            </div>
          </div>
        </article>
      `
    )
    .join("");
};

const openDetail = (key) => {
  const food = foodByKey(key);
  if (!food) return;
  state.selectedFoodKey = key;
  document.querySelector("#detailContent").innerHTML = detailPanelMarkup(food);
  document.querySelector("#detailOverlay").classList.add("open");
  document.querySelector("#detailOverlay").setAttribute("aria-hidden", "false");
};

const closeDetail = () => {
  state.selectedFoodKey = "";
  document.querySelector("#detailOverlay").classList.remove("open");
  document.querySelector("#detailOverlay").setAttribute("aria-hidden", "true");
};

const updateTopButton = () => {
  document.querySelector("#topButton").classList.toggle("show", window.scrollY > 520);
};

document.querySelector("#query").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRows();
});

document.querySelector("#tableQuery").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderRows();
});

document.querySelector("#typeFilter").addEventListener("change", (event) => {
  state.typeFilter = event.target.value;
  state.mealType = "all";
  document.querySelectorAll("#mealButtons button").forEach((item) => item.classList.toggle("active", item.dataset.mealType === "all"));
  renderRows();
});

document.querySelector("#originFilter").addEventListener("change", (event) => {
  state.originFilter = event.target.value;
  renderRows();
});

document.querySelector("#formatFilter").addEventListener("change", (event) => {
  state.formatFilter = event.target.value;
  renderRows();
});

document.querySelector("#checkerQuery").addEventListener("input", (event) => {
  state.checkerQuery = event.target.value;
  renderChecker();
});

document.querySelector("#maxPhos").addEventListener("input", (event) => {
  state.maxPhos = Number(event.target.value);
  document.querySelector("#maxPhosLabel").textContent = `최대 인: ${fmt(state.maxPhos)}%`;
  renderRows();
});

document.querySelector("#minProtein").addEventListener("input", (event) => {
  state.minProtein = Number(event.target.value);
  document.querySelector("#minProteinLabel").textContent = `최소 조단백: ${fmt(state.minProtein, 1)}%`;
  renderRows();
});

document.querySelector("#maxFat").addEventListener("input", (event) => {
  state.maxFat = Number(event.target.value);
  document.querySelector("#maxFatLabel").textContent = `최대 조지방: ${fmt(state.maxFat, 1)}%`;
  renderRows();
});

document.querySelector("#renalOnly").addEventListener("change", (event) => {
  state.renalOnly = event.target.checked;
  renderRows();
});

document.querySelector("#mealButtons").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  state.mealType = button.dataset.mealType;
  state.typeFilter = "all";
  document.querySelectorAll("#mealButtons button").forEach((item) => item.classList.toggle("active", item === button));
  renderRows();
});

document.querySelector("#sorters").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.metric) {
    state.metric = button.dataset.metric;
    document.querySelectorAll("#sorters [data-metric]").forEach((item) => item.classList.toggle("active", item === button));
  } else {
    state.direction = state.direction === "asc" ? "desc" : "asc";
  }
  renderRows();
});

app.addEventListener("click", (event) => {
  if (event.target.closest("a, button, input, select")) return;
  const item = event.target.closest("[data-food-key]");
  if (!item) return;
  openDetail(item.dataset.foodKey);
});

app.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeDetail();
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") return;
  const item = event.target.closest("[data-food-key]");
  if (!item) return;
  event.preventDefault();
  openDetail(item.dataset.foodKey);
});

document.querySelector("#detailClose").addEventListener("click", closeDetail);
document.querySelector("#detailScrim").addEventListener("click", closeDetail);
document.querySelector("#topButton").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
window.addEventListener("scroll", updateTopButton, { passive: true });

updateTopButton();
renderRows();
renderChecker();
