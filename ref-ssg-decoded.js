// SSF샵 상품 링크 수집 Content Script
// 버전: 2.0.0 - 새 수집 시작 시 모든 수집처 데이터 초기화

const SSFSHOP_COLLECTOR_VERSION = '2.0.0';

// 모든 수집처의 저장된 데이터 초기화
async function clearAllCollectorData() {
  const allStorageKeys = [
    'collectedLinks', 'isCollecting', 'lastPage', 'totalProducts',
    'abcmartLinks', 'abcmartIsCollecting', 'abcmartLastPage', 'abcmartTotalProducts',
    'wconceptLinks', 'wconceptIsCollecting', 'wconceptLastPage', 'wconceptTotalProducts',
    'grandstageLinks', 'grandstageIsCollecting', 'grandstageLastPage', 'grandstageTotal',
    'folderLinks', 'folderIsCollecting', 'folderLastPage', 'folderTotalProducts',
    'thehyundaiLinks', 'thehyundaiIsCollecting', 'thehyundaiLastPage', 'thehyundaiTotalProducts',
    'ssfshopLinks', 'ssfshopIsCollecting', 'ssfshopLastPage', 'ssfshopTotalProducts',
    'lotteimallLinks', 'lotteimallIsCollecting', 'lotteimallLastPage', 'lotteimallTotalProducts',
    'gsshopLinks', 'gsshopIsCollecting', 'gsshopLastPage', 'gsshopTotalProducts',
    'pendingMangoUpload', 'pendingMangoSource', 'pendingMangoLinks'
  ];
  return new Promise((resolve) => {
    chrome.storage.local.remove(allStorageKeys, () => {
      console.log('[SSF샵] 모든 수집처 데이터 초기화 완료');
      resolve();
    });
  });
}

class SSFShopCollector {
  constructor() {
    this.collectedLinks = [];
    this.isCollecting = false;
    this.currentPage = 1;
    this.totalProducts = 0;
    this.collectionLimit = 0; // 0 = 전체 수집, 양수 = 해당 수량만큼만 수집
    this.collectionDelay = 500;
    this.pageTransitionDelay = 1000;
    this.scrollStabilizationDelay = 300;
    this.maxRetries = 2;
    this.expectedProductsPerPage = 60; // SSF 기본 60개씩
    console.log(`[SSF샵] 수집기 버전: ${SSFSHOP_COLLECTOR_VERSION}`);
  }

  // 수량 제한에 도달했는지 확인
  hasReachedLimit() {
    if (this.collectionLimit <= 0) return false;
    return this.collectedLinks.length >= this.collectionLimit;
  }

  // 남은 수집 가능 수량
  getRemainingCount() {
    if (this.collectionLimit <= 0) return Infinity;
    return Math.max(0, this.collectionLimit - this.collectedLinks.length);
  }

  // 상품 코드 추출 (URL에서 상품번호 추출)
  extractProductId(href) {
    // SSF 상품 URL 패턴: /브랜드명/GPV225101300536/good
    const match = href.match(/\/([A-Z0-9]{15,20})\/good/i);
    return match ? match[1] : null;
  }

  // 현재 페이지에서 상품 링크 추출 (상품 ID 기준으로 중복 제거)
  extractProductLinks() {
    const links = [];
    const seenProductIds = new Set();

    // SSF샵 실제 구조: div.god-lists > ul.list-col-6 > li.god-item[view-godno]
    // 메인 상품 목록에서 링크 추출 (추천 섹션 제외)
    const productContainerSelectors = [
      '.god-lists > ul',           // SSF샵 메인 구조
      'ul.list-col-6',             // SSF샵 상품 리스트
      '.search-result ul',         // 검색 결과
      '#searchList',
      '.goods-list',
      '.product-list'
    ];

    let mainContainer = null;
    for (const selector of productContainerSelectors) {
      const container = document.querySelector(selector);
      if (container) {
        mainContainer = container;
        console.log(`[SSF샵] 메인 상품 컨테이너: ${selector}`);
        break;
      }
    }

    // view-godno 속성은 li.god-item 태그에 있음
    // li[view-godno] 또는 li.god-item 를 찾아서 그 안의 a 태그에서 링크 추출
    let productItems;
    if (mainContainer) {
      // li[view-godno] 또는 li.god-item 찾기
      productItems = mainContainer.querySelectorAll('li[view-godno], li.god-item');
      console.log(`[SSF샵] 메인 컨테이너에서 상품 아이템 ${productItems.length}개 발견`);
    } else {
      // 폴백: 전체 페이지에서 li[view-godno] 찾기 (추천 영역 제외)
      const allItems = document.querySelectorAll('li[view-godno], li.god-item');
      productItems = Array.from(allItems).filter(item => {
        // 추천 상품 영역 제외 (슬라이더, 관련상품 등)
        const excludeSelectors = [
          '[class*="recommend"]',
          '[class*="relation"]',
          '[class*="slide"]',
          '.footer',
          '[class*="footer"]'
        ];
        for (const excludeSelector of excludeSelectors) {
          if (item.closest(excludeSelector)) {
            return false;
          }
        }
        return true;
      });
      console.log(`[SSF샵] 폴백 모드: ${productItems.length}개 상품 아이템 발견`);
    }

    productItems.forEach(item => {
      // li 태그에서 view-godno 속성 추출
      let productId = item.getAttribute('view-godno');

      // li 안의 a 태그에서 href 추출
      const linkElement = item.querySelector('a[href*="/good"]');
      if (!linkElement) return;

      const href = linkElement.href;

      if (!productId) {
        productId = this.extractProductId(href);
      }

      if (productId && !seenProductIds.has(productId)) {
        seenProductIds.add(productId);
        // 원본 href 사용 (쿼리 파라미터 제거)
        const cleanUrl = href.split('?')[0];
        if (cleanUrl.includes('/good')) {
          links.push(cleanUrl);
        }
      }
    });

    console.log(`[SSF샵] 추출된 상품: ${links.length}개 (원본 아이템: ${productItems.length}개)`);
    return links;
  }

  // 총 상품 수 확인
  getTotalProductCount() {
    // "1,432개 상품" 같은 텍스트에서 숫자 추출
    const countSelectors = [
      '.result-count',
      '.total-count',
      '[class*="count"]',
      '[class*="total"]'
    ];

    for (const selector of countSelectors) {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const match = el.textContent.match(/(\d{1,3}(?:,\d{3})*|\d+)\s*개/);
        if (match) {
          return parseInt(match[1].replace(/,/g, ''));
        }
      }
    }

    // 페이지 전체에서 찾기
    const text = document.body.textContent;
    const match = text.match(/(\d{1,3}(?:,\d{3})*)\s*개\s*상품/);
    if (match) {
      return parseInt(match[1].replace(/,/g, ''));
    }
    return 0;
  }

  // 현재 페이지 번호 확인
  getCurrentPageNumber() {
    // SSF샵 상품 목록 페이지네이션: .goods_container .page 또는 .list_Wrap .page
    // 여러 .page 요소가 있으므로 getQnaList를 사용하는 페이지네이션을 찾아야 함
    const productPaginationSelectors = [
      '.goods_container .page',
      '.list_Wrap .page',
      '.god-lists + .page',
      '#searchList + .page'
    ];

    // 1. 상품 목록 페이지네이션에서 활성 페이지 찾기
    for (const selector of productPaginationSelectors) {
      const pagination = document.querySelector(selector);
      if (pagination) {
        // getQnaList를 사용하는지 확인
        const hasGetQnaList = pagination.querySelector('a[href*="getQnaList"]');
        if (hasGetQnaList || pagination.closest('.goods_container')) {
          const activePage = pagination.querySelector('a.on');
          if (activePage) {
            const pageNum = parseInt(activePage.textContent.trim());
            if (!isNaN(pageNum) && pageNum > 0) {
              console.log(`[SSF샵] 현재 페이지: ${pageNum} (상품목록 페이지네이션: ${selector})`);
              return pageNum;
            }
          }
        }
      }
    }

    // 2. getQnaList 링크가 있는 .page 컨테이너에서 찾기
    const allPageContainers = document.querySelectorAll('.page');
    for (const container of allPageContainers) {
      const hasGetQnaList = container.querySelector('a[href*="getQnaList"]');
      if (hasGetQnaList) {
        const activePage = container.querySelector('a.on');
        if (activePage) {
          const pageNum = parseInt(activePage.textContent.trim());
          if (!isNaN(pageNum) && pageNum > 0) {
            console.log(`[SSF샵] 현재 페이지: ${pageNum} (getQnaList 페이지네이션)`);
            return pageNum;
          }
        }
      }
    }

    // 3. URL 파라미터에서 확인
    const urlParams = new URLSearchParams(window.location.search);
    const page = urlParams.get('page') || urlParams.get('pageNo') || urlParams.get('currentPage');
    if (page) {
      const pageNum = parseInt(page);
      if (!isNaN(pageNum) && pageNum > 0) {
        console.log(`[SSF샵] 현재 페이지: ${pageNum} (URL 파라미터)`);
        return pageNum;
      }
    }

    console.log('[SSF샵] 현재 페이지: 1 (기본값)');
    return 1;
  }

  // 다음 페이지로 이동
  async goToNextPage() {
    const nextPage = this.currentPage;
    console.log(`[SSF샵] ★★★ 페이지 ${nextPage}로 이동 시도 ★★★`);

    // 방법: URL 직접 변경 (가장 안정적인 방법)
    // SSF샵은 pageNo 파라미터로 페이지를 구분함
    const currentUrl = new URL(window.location.href);
    const currentParams = currentUrl.searchParams;

    // pageNo 파라미터 업데이트
    currentParams.set('pageNo', nextPage.toString());

    // 새 URL 생성
    const newUrl = currentUrl.toString();
    console.log(`[SSF샵] URL 변경: pageNo=${nextPage}`);
    console.log(`[SSF샵] 새 URL: ${newUrl}`);

    // 페이지 이동 (전체 새로고침)
    window.location.href = newUrl;

    return true;
  }

  // 페이지 변경 후 새 콘텐츠 로드 대기
  async waitForPageChange(expectedPage) {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 30; // 최대 15초 대기

      const checkPage = () => {
        attempts++;
        const currentPage = this.getCurrentPageNumber();

        console.log(`[SSF샵] 페이지 변경 확인 중... (시도 ${attempts}, 현재: ${currentPage}, 목표: ${expectedPage})`);

        if (currentPage === expectedPage) {
          console.log(`[SSF샵] ✓ 페이지 ${expectedPage} 로드 완료`);
          resolve(true);
          return;
        }

        if (attempts >= maxAttempts) {
          console.log(`[SSF샵] ⚠️ 페이지 변경 타임아웃`);
          resolve(false);
          return;
        }

        setTimeout(checkPage, 500);
      };

      // 약간의 지연 후 체크 시작 (AJAX 요청이 시작될 시간 확보)
      setTimeout(checkPage, 500);
    });
  }

  // 페이지 이동 처리 (URL 변경 방식 - 전체 새로고침)
  async navigateToNextPage() {
    const nextPage = this.currentPage;
    console.log(`[SSF샵] 페이지 이동: ${nextPage - 1} → ${nextPage} (URL 변경)`);

    // URL 변경으로 페이지 이동 (전체 새로고침 발생)
    await this.goToNextPage();

    // URL 변경 후 페이지가 새로고침되므로 여기서 false 반환
    // 새 페이지에서 initializeSSFShopCollector()가 호출되어 수집이 계속됨
    return false;
  }

  // 마지막 페이지인지 확인
  isLastPage() {
    const currentPage = this.getCurrentPageNumber();
    console.log(`[SSF샵] isLastPage() 확인 중... 현재 페이지: ${currentPage}`);

    // 상품 목록 페이지네이션 컨테이너 찾기 (getQnaList 사용하는 것)
    let productPagination = null;
    const allPageContainers = document.querySelectorAll('.page');
    for (const container of allPageContainers) {
      const hasGetQnaList = container.querySelector('a[href*="getQnaList"]');
      if (hasGetQnaList) {
        productPagination = container;
        console.log(`[SSF샵] 상품목록 페이지네이션 발견`);
        break;
      }
    }

    if (!productPagination) {
      // goods_container 내부에서 찾기
      productPagination = document.querySelector('.goods_container .page') ||
                          document.querySelector('.list_Wrap .page');
    }

    if (productPagination) {
      // 1. 다음 페이지 링크 확인
      const nextPageNum = currentPage + 1;
      const nextPageLink = productPagination.querySelector(`a[href*="getQnaList('${nextPageNum}')"]`);
      if (nextPageLink && !nextPageLink.classList.contains('disabled')) {
        console.log(`[SSF샵] 페이지 ${currentPage} - 다음 페이지(${nextPageNum}) 링크 있음 → 계속 수집`);
        return false;
      }

      // 2. "다음" 버튼 확인 (next 클래스)
      const nextBtn = productPagination.querySelector('a.next:not(.disabled)');
      if (nextBtn) {
        const href = nextBtn.getAttribute('href') || '';
        const match = href.match(/getQnaList\s*\(\s*['"]?(\d+)['"]?\s*\)/);
        if (match) {
          const targetPage = parseInt(match[1]);
          if (targetPage > currentPage) {
            console.log(`[SSF샵] 페이지 ${currentPage} - 다음 버튼 있음 (target: ${targetPage}) → 계속 수집`);
            return false;
          }
        }
      }

      // 3. 페이지네이션 내 모든 링크에서 현재 페이지보다 큰 번호 찾기
      const pageLinks = productPagination.querySelectorAll('a[href*="getQnaList"]');
      for (const link of pageLinks) {
        const href = link.getAttribute('href') || '';
        const match = href.match(/getQnaList\s*\(\s*['"]?(\d+)['"]?\s*\)/);
        if (match) {
          const pageNum = parseInt(match[1]);
          if (pageNum > currentPage) {
            console.log(`[SSF샵] 페이지 ${currentPage} - 더 큰 페이지(${pageNum}) 링크 있음 → 계속 수집`);
            return false;
          }
        }
      }
    }

    // 4. 전체 페이지에서 다음 페이지 getQnaList 링크 확인
    const nextPageNum = currentPage + 1;
    const globalNextLink = document.querySelector(`a[href="javascript:getQnaList('${nextPageNum}')"]`);
    if (globalNextLink) {
      console.log(`[SSF샵] 페이지 ${currentPage} - 전역에서 다음 페이지 링크 발견 → 계속 수집`);
      return false;
    }

    // 5. 총 상품 수로 예상 페이지 확인
    const totalProducts = this.getTotalProductCount();
    if (totalProducts > 0) {
      const expectedPages = Math.ceil(totalProducts / this.expectedProductsPerPage);
      if (currentPage < expectedPages) {
        console.log(`[SSF샵] 예상 페이지: ${expectedPages}, 현재: ${currentPage} - 아직 더 있을 수 있음`);
        // 예상보다 적으면 아직 더 있을 수 있으므로 false 반환
        return false;
      }
    }

    console.log(`[SSF샵] 페이지 ${currentPage} - 마지막 페이지로 판단됨`);
    return true;
  }

  // 마지막 페이지 확인 (백그라운드용)
  checkIsLastPage() {
    return this.isLastPage();
  }

  // 페이지 스크롤하여 모든 상품 로드
  async scrollToLoadAll() {
    return new Promise((resolve) => {
      let lastProductCount = 0;
      let stableCount = 0;
      let scrollAttempts = 0;
      const maxAttempts = 15;
      const requiredStable = 3;
      const minAttempts = 3;
      let scrollPosition = 0;
      const scrollStep = 800;

      console.log('[SSF샵] 스크롤 시작...');

      const countProducts = () => {
        // SSF샵 실제 구조: li.god-item[view-godno]
        const productItems = document.querySelectorAll('li[view-godno], li.god-item');
        const uniqueIds = new Set();
        productItems.forEach(item => {
          const id = item.getAttribute('view-godno');
          if (id) {
            uniqueIds.add(id);
          } else {
            const link = item.querySelector('a[href*="/good"]');
            if (link) {
              const extractedId = this.extractProductId(link.href);
              if (extractedId) uniqueIds.add(extractedId);
            }
          }
        });
        return uniqueIds.size;
      };

      const doScroll = () => {
        if (!this.isCollecting) {
          console.log('[SSF샵] 스크롤 중지됨 (수집 중지)');
          window.scrollTo(0, 0);
          resolve();
          return;
        }

        scrollAttempts++;
        const currentProductCount = countProducts();

        console.log(`[SSF샵] 스크롤 ${scrollAttempts}: ${currentProductCount}개`);

        if (currentProductCount >= this.expectedProductsPerPage) {
          console.log(`[SSF샵] ✓ ${currentProductCount}개 로드 완료`);
          resolve();
          return;
        }

        if (scrollAttempts >= minAttempts) {
          if (currentProductCount === lastProductCount && currentProductCount > 0) {
            stableCount++;
          } else {
            stableCount = 0;
          }

          if (stableCount >= requiredStable || scrollAttempts >= maxAttempts) {
            console.log(`[SSF샵] ✓ 스크롤 완료: ${currentProductCount}개`);
            resolve();
            return;
          }
        }
        lastProductCount = currentProductCount;

        scrollPosition += scrollStep;
        const maxScrollHeight = document.documentElement.scrollHeight;

        if (scrollPosition < maxScrollHeight) {
          window.scrollTo(0, scrollPosition);
        } else {
          window.scrollTo(0, 0);
          scrollPosition = 0;
        }

        setTimeout(doScroll, 500);
      };

      window.scrollTo(0, 0);
      setTimeout(doScroll, 300);
    });
  }

  // 상품이 로드될 때까지 대기
  async waitForProductsToLoad() {
    return new Promise((resolve) => {
      let attempts = 0;
      const maxAttempts = 10;

      const checkProducts = setInterval(() => {
        // SSF샵 실제 구조: li.god-item[view-godno]
        const products = document.querySelectorAll('li[view-godno], li.god-item');
        attempts++;

        if (products.length > 0 || attempts >= maxAttempts) {
          clearInterval(checkProducts);
          resolve(products.length);
        }
      }, 200);
    });
  }

  // 현재 페이지 수집
  async collectCurrentPage() {
    console.log(`[SSF샵] 페이지 ${this.currentPage} 수집 중...`);

    if (this.hasReachedLimit()) {
      console.log(`[SSF샵] 수량 제한(${this.collectionLimit}개)에 도달하여 수집 중단`);
      return 0;
    }

    await this.waitForProductsToLoad();

    const links = this.extractProductLinks();
    console.log(`[SSF샵] ${links.length}개 링크 발견`);

    // 중복 제거하며 추가
    const existingIds = new Set(this.collectedLinks.map(url => {
      const match = url.match(/\/([A-Z0-9]{15,20})\/good/i);
      return match ? match[1] : null;
    }));

    let newCount = 0;
    const remaining = this.getRemainingCount();

    for (const link of links) {
      if (this.collectionLimit > 0 && newCount >= remaining) {
        console.log(`[SSF샵] 수량 제한(${this.collectionLimit}개)에 도달`);
        break;
      }

      const match = link.match(/\/([A-Z0-9]{15,20})\/good/i);
      const productId = match ? match[1] : null;
      if (productId && !existingIds.has(productId)) {
        this.collectedLinks.push(link);
        existingIds.add(productId);
        newCount++;
      }
    }

    console.log(`[SSF샵] 새로 추가된 링크: ${newCount}개, 총 수집: ${this.collectedLinks.length}개`);
    if (this.collectionLimit > 0) {
      console.log(`[SSF샵] 수량 제한: ${this.collectionLimit}개, 남은 수량: ${this.getRemainingCount()}개`);
    }
    return newCount;
  }

  // 전체 수집 시작
  async continueCollection() {
    if (!this.isCollecting) {
      console.log('[SSF샵] 수집이 중지되었습니다.');
      this.hideCollectionStatus();
      return;
    }

    console.log(`[SSF샵] === 페이지 ${this.currentPage} 수집 시작 ===`);

    this.showCollectionStatus();

    await this.scrollToLoadAll();

    if (!this.isCollecting) {
      console.log('[SSF샵] 스크롤 후 수집 중지됨');
      this.hideCollectionStatus();
      return;
    }

    const beforeCount = this.collectedLinks.length;
    await this.collectCurrentPage();
    const collected = this.collectedLinks.length - beforeCount;

    if (!this.isCollecting) {
      console.log('[SSF샵] 수집 후 중지됨');
      this.hideCollectionStatus();
      return;
    }

    console.log(`[SSF샵] 페이지 ${this.currentPage}: ${collected}개 수집, 총 ${this.collectedLinks.length}개`);

    const isLast = this.isLastPage();

    this.showCollectionStatus();
    await this.saveProgress();

    // 수량 제한에 도달했는지 확인
    if (this.hasReachedLimit()) {
      console.log(`[SSF샵] === 수량 제한(${this.collectionLimit}개) 도달! 수집 완료 ===`);
      await this.verifyStorage();
      this.isCollecting = false;
      await this.saveProgress();

      chrome.storage.local.get(['instantRegisterSSFShop'], (result) => {
        const autoRegister = result.instantRegisterSSFShop || false;
        this.showCompletionMessage(autoRegister);
      });
      return;
    }

    // 다음 페이지가 있으면 이동
    if (!isLast) {
      const nextPage = this.currentPage + 1;
      console.log(`[SSF샵] 다음 페이지로 이동: ${this.currentPage} → ${nextPage}`);
      this.currentPage = nextPage;
      await this.saveProgress();

      // AJAX 페이지네이션 처리
      const isAjax = await this.navigateToNextPage();

      if (isAjax) {
        // AJAX로 페이지가 변경되었으면 계속 수집
        console.log(`[SSF샵] AJAX 페이지 변경 완료, 수집 계속...`);
        setTimeout(() => {
          this.continueCollection();
        }, 300);
      }
      // isAjax가 false면 전체 페이지 새로고침이 발생하여 initializeSSFShopCollector()가 호출됨
      return;
    }

    // 모든 페이지 수집 완료
    await this.verifyStorage();
    this.isCollecting = false;
    await this.saveProgress();

    console.log(`[SSF샵] === 전체 수집 완료! 총 ${this.collectedLinks.length}개 ===`);

    chrome.storage.local.get(['instantRegisterSSFShop'], (result) => {
      const autoRegister = result.instantRegisterSSFShop || false;
      this.showCompletionMessage(autoRegister);
    });
  }

  // 저장된 데이터 검증
  async verifyStorage() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['ssfshopLinks'], (result) => {
        const savedCount = result.ssfshopLinks ? result.ssfshopLinks.length : 0;
        console.log(`[SSF샵] 저장 검증: 메모리 ${this.collectedLinks.length}개, 스토리지 ${savedCount}개`);
        if (savedCount !== this.collectedLinks.length) {
          console.warn('[SSF샵] ⚠️ 저장된 데이터와 메모리 데이터가 일치하지 않음! 재저장...');
          chrome.storage.local.set({ ssfshopLinks: this.collectedLinks }, () => {
            console.log('[SSF샵] 재저장 완료');
            resolve();
          });
        } else {
          resolve();
        }
      });
    });
  }

  // 수집 시작
  async startCollection(limit = 0) {
    console.log('[SSF샵] === 수집 시작 ===');

    // 새 수집 시작 시 모든 수집처 데이터 초기화
    await clearAllCollectorData();

    this.isCollecting = true;
    this.collectionLimit = limit;
    this.currentPage = this.getCurrentPageNumber();
    this.totalProducts = this.getTotalProductCount();
    this.collectedLinks = [];

    console.log(`[SSF샵] 총 ${this.totalProducts}개 상품 예상, 현재 페이지: ${this.currentPage}`);
    if (limit > 0) {
      console.log(`[SSF샵] 수량 제한: ${limit}개`);
    } else {
      console.log('[SSF샵] 수량 제한 없음 (전체 수집)');
    }

    await this.continueCollection();
  }

  // 진행 상태 저장
  async saveProgress() {
    return new Promise((resolve) => {
      const keyword = new URLSearchParams(window.location.search).get('keyword') || '';
      const data = {
        ssfshopLinks: [...this.collectedLinks],
        ssfshopIsCollecting: this.isCollecting,
        ssfshopLastPage: this.currentPage,
        ssfshopTotalProducts: this.totalProducts,
        ssfshopKeyword: keyword,
        ssfshopCollectionLimit: this.collectionLimit
      };

      chrome.storage.local.set(data, () => {
        if (chrome.runtime.lastError) {
          console.error('[SSF샵] ❌ 저장 실패:', chrome.runtime.lastError);
        } else {
          console.log('[SSF샵] ✅ 저장 성공!');
        }
        resolve();
      });
    });
  }

  // 저장된 진행 상태 불러오기
  async loadProgress() {
    return new Promise((resolve) => {
      chrome.storage.local.get([
        'ssfshopLinks', 'ssfshopIsCollecting', 'ssfshopLastPage',
        'ssfshopKeyword', 'ssfshopTotalProducts', 'ssfshopCollectionLimit'
      ], (result) => {
        const currentKeyword = new URLSearchParams(window.location.search).get('keyword') || '';

        if (result.ssfshopKeyword === currentKeyword && result.ssfshopIsCollecting) {
          this.collectedLinks = result.ssfshopLinks || [];
          this.totalProducts = result.ssfshopTotalProducts || 0;
          this.collectionLimit = result.ssfshopCollectionLimit || 0;
          this.isCollecting = true;
          console.log(`[SSF샵] ✅ 상태 복원: ${this.collectedLinks.length}개 링크, 수량 제한: ${this.collectionLimit || '없음'}`);
        }

        resolve(result);
      });
    });
  }

  // 수집 데이터 초기화
  async resetCollection() {
    console.log('[SSF샵] 수집 중지 및 초기화...');
    this.isCollecting = false;
    this.collectedLinks = [];
    this.currentPage = 1;
    this.totalProducts = 0;
    this.collectionLimit = 0;

    this.hideCollectionStatus();

    return new Promise((resolve) => {
      chrome.storage.local.remove([
        'ssfshopLinks', 'ssfshopIsCollecting', 'ssfshopLastPage',
        'ssfshopKeyword', 'ssfshopTotalProducts', 'ssfshopCollectionLimit'
      ], () => {
        console.log('[SSF샵] 초기화 완료');
        resolve();
      });
    });
  }

  // 수집 상태 UI 숨기기
  hideCollectionStatus() {
    const statusDiv = document.getElementById('ssfshop-collector-status');
    if (statusDiv) {
      statusDiv.remove();
      console.log('[SSF샵] 상태 UI 제거됨');
    }
    window.scrollTo(0, 0);
  }

  // 수집 완료 메시지 표시
  showCompletionMessage(autoRegister = false) {
    const statusDiv = document.getElementById('ssfshop-collector-status');
    if (statusDiv) statusDiv.remove();

    const existingModal = document.getElementById('ssfshop-collector-complete');
    if (existingModal) existingModal.remove();

    // 즉시등록이면 바로 더망고로 이동
    if (autoRegister) {
      this.goToMangoAndRegister();
      return;
    }

    const message = document.createElement('div');
    message.id = 'ssfshop-collector-complete';
    message.innerHTML = `
      <style>
        @keyframes ssfshop-modal-appear {
          0% { opacity: 0; transform: translate(-50%, -50%) scale(0.9); }
          100% { opacity: 1; transform: translate(-50%, -50%) scale(1); }
        }
        @keyframes ssfshop-backdrop-appear {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
        .ssfshop-modal-backdrop {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background: linear-gradient(135deg, rgba(0, 0, 0, 0.3) 0%, rgba(0, 0, 0, 0.7) 100%);
          backdrop-filter: blur(8px);
          z-index: 999998;
          animation: ssfshop-backdrop-appear 0.3s ease-out;
        }
        .ssfshop-modal-container {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: linear-gradient(180deg, #ffffff 0%, #f5f5f5 100%);
          padding: 40px;
          border-radius: 28px;
          box-shadow: 0 50px 100px -20px rgba(0, 0, 0, 0.5);
          z-index: 999999;
          text-align: center;
          font-family: 'SF Pro Display', -apple-system, sans-serif;
          min-width: 380px;
          animation: ssfshop-modal-appear 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .ssfshop-success-icon {
          width: 80px;
          height: 80px;
          margin: 0 auto 24px;
          background: linear-gradient(135deg, #000 0%, #333 100%);
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 40px;
        }
        .ssfshop-modal-title {
          font-size: 28px;
          font-weight: 800;
          color: #1a1a1a;
          margin-bottom: 8px;
        }
        .ssfshop-modal-subtitle {
          font-size: 16px;
          color: #666;
          margin-bottom: 24px;
        }
        .ssfshop-count-display {
          background: #f0f0f0;
          border-radius: 20px;
          padding: 24px;
          margin-bottom: 28px;
        }
        .ssfshop-count-number {
          font-size: 56px;
          font-weight: 900;
          color: #000;
        }
        .ssfshop-count-label {
          font-size: 14px;
          color: #666;
          margin-top: 4px;
        }
        .ssfshop-primary-btn {
          width: 100%;
          padding: 18px 32px;
          background: linear-gradient(135deg, #000 0%, #333 100%);
          color: white;
          border: none;
          border-radius: 16px;
          font-size: 17px;
          font-weight: 700;
          cursor: pointer;
          margin-bottom: 16px;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          transition: all 0.3s ease;
        }
        .ssfshop-primary-btn:hover {
          transform: translateY(-3px);
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        .ssfshop-btn-group {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 12px;
        }
        .ssfshop-secondary-btn {
          padding: 14px 16px;
          background: #f1f1f1;
          color: #333;
          border: 1px solid #ddd;
          border-radius: 12px;
          font-size: 14px;
          font-weight: 600;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 6px;
          transition: all 0.2s ease;
        }
        .ssfshop-secondary-btn:hover {
          background: #e5e5e5;
          transform: translateY(-2px);
        }
        .ssfshop-secondary-btn .btn-icon { font-size: 20px; }
      </style>
      <div class="ssfshop-modal-backdrop" id="ssfshop-modal-backdrop"></div>
      <div class="ssfshop-modal-container">
        <div class="ssfshop-success-icon">🛍️</div>
        <div class="ssfshop-modal-title">수집 완료!</div>
        <div class="ssfshop-modal-subtitle">SSF샵에서 상품 링크를 성공적으로 수집했습니다</div>
        <div class="ssfshop-count-display">
          <div class="ssfshop-count-number">${this.collectedLinks.length}</div>
          <div class="ssfshop-count-label">수집된 상품 링크</div>
        </div>
        <button class="ssfshop-primary-btn" id="ssfshop-register-btn">
          <span>🚀</span> 더망고에 등록하기
        </button>
        <div class="ssfshop-btn-group">
          <button class="ssfshop-secondary-btn" id="ssfshop-copy-btn">
            <span class="btn-icon">📋</span>
            <span>복사</span>
          </button>
          <button class="ssfshop-secondary-btn" id="ssfshop-download-btn">
            <span class="btn-icon">💾</span>
            <span>다운로드</span>
          </button>
          <button class="ssfshop-secondary-btn" id="ssfshop-close-btn">
            <span class="btn-icon">✕</span>
            <span>닫기</span>
          </button>
        </div>
      </div>
    `;
    document.body.appendChild(message);

    document.getElementById('ssfshop-register-btn').addEventListener('click', () => {
      message.remove();
      this.goToMangoAndRegister();
    });

    document.getElementById('ssfshop-copy-btn').addEventListener('click', () => {
      const btn = document.getElementById('ssfshop-copy-btn');
      navigator.clipboard.writeText(this.collectedLinks.join('\n')).then(() => {
        btn.innerHTML = '<span class="btn-icon">✓</span><span>복사됨!</span>';
        setTimeout(() => {
          btn.innerHTML = '<span class="btn-icon">📋</span><span>복사</span>';
        }, 2000);
      });
    });

    document.getElementById('ssfshop-download-btn').addEventListener('click', () => {
      this.downloadLinks();
    });

    document.getElementById('ssfshop-close-btn').addEventListener('click', () => {
      message.remove();
    });

    document.getElementById('ssfshop-modal-backdrop').addEventListener('click', () => {
      message.remove();
    });
  }

  // 더망고 페이지로 이동하고 등록 준비
  goToMangoAndRegister() {
    const MANGO_URL = 'https://tmg4484.mycafe24.com/mall/admin/shop/getGoods2.php?tab_type=ssfshop';

    chrome.storage.local.set({
      pendingMangoUpload: true,
      pendingMangoSource: 'ssfshop',
      pendingMangoLinks: this.collectedLinks
    }, () => {
      console.log('[SSF샵] 더망고 자동 등록 준비 완료, 페이지 이동...');
      window.open(MANGO_URL, '_blank');
    });
  }

  // 링크 다운로드
  downloadLinks() {
    const blob = new Blob([this.collectedLinks.join('\n')], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `ssfshop_links_${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // 수집 상태 UI 표시
  showCollectionStatus() {
    let statusDiv = document.getElementById('ssfshop-collector-status');
    if (!statusDiv) {
      statusDiv = document.createElement('div');
      statusDiv.id = 'ssfshop-collector-status';
      document.body.appendChild(statusDiv);
    }

    statusDiv.innerHTML = `
      <style>
        @keyframes ssfshop-float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-5px); }
        }
        #ssfshop-collector-status {
          position: fixed;
          top: 24px;
          right: 24px;
          background: linear-gradient(135deg, #000 0%, #333 100%);
          color: white;
          padding: 20px 24px;
          border-radius: 20px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.4);
          z-index: 999999;
          font-family: 'SF Pro Display', -apple-system, sans-serif;
          min-width: 240px;
          animation: ssfshop-float 3s ease-in-out infinite;
        }
        .ssfshop-status-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 16px;
        }
        .ssfshop-status-icon {
          width: 44px;
          height: 44px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 12px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 22px;
        }
        .ssfshop-status-title {
          font-size: 16px;
          font-weight: 700;
        }
        .ssfshop-status-subtitle {
          font-size: 12px;
          opacity: 0.8;
          margin-top: 2px;
        }
        .ssfshop-stats-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
          margin-bottom: 16px;
        }
        .ssfshop-stat-card {
          background: rgba(255, 255, 255, 0.15);
          border-radius: 12px;
          padding: 12px;
          text-align: center;
        }
        .ssfshop-stat-value {
          font-size: 24px;
          font-weight: 800;
        }
        .ssfshop-stat-label {
          font-size: 11px;
          opacity: 0.8;
          margin-top: 4px;
        }
        .ssfshop-progress-container {
          height: 8px;
          background: rgba(255, 255, 255, 0.2);
          border-radius: 10px;
          overflow: hidden;
        }
        .ssfshop-progress-bar {
          height: 100%;
          background: white;
          border-radius: 10px;
          width: ${this.totalProducts > 0 ? Math.round((this.collectedLinks.length / this.totalProducts) * 100) : 100}%;
          transition: width 0.3s ease;
        }
      </style>
      <div class="ssfshop-status-header">
        <div class="ssfshop-status-icon">🛍️</div>
        <div>
          <div class="ssfshop-status-title">SSF샵 수집 중</div>
          <div class="ssfshop-status-subtitle">상품 링크를 추출하고 있습니다</div>
        </div>
      </div>
      <div class="ssfshop-stats-grid">
        <div class="ssfshop-stat-card">
          <div class="ssfshop-stat-value">${this.currentPage}</div>
          <div class="ssfshop-stat-label">현재 페이지</div>
        </div>
        <div class="ssfshop-stat-card">
          <div class="ssfshop-stat-value">${this.collectedLinks.length}</div>
          <div class="ssfshop-stat-label">수집된 링크</div>
        </div>
      </div>
      <div class="ssfshop-progress-container">
        <div class="ssfshop-progress-bar"></div>
      </div>
    `;
  }
}

// 글로벌 인스턴스 생성
const ssfshopCollector = new SSFShopCollector();

// 메시지 리스너
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ status: 'pong', site: 'ssfshop' });
    return true;
  }

  if (request.action === 'startCollection') {
    const limit = request.quantity || request.limit || 0;
    ssfshopCollector.startCollection(limit);
    sendResponse({ status: 'started', limit: limit });
  } else if (request.action === 'getStatus') {
    sendResponse({
      isCollecting: ssfshopCollector.isCollecting,
      collectedCount: ssfshopCollector.collectedLinks.length,
      currentPage: ssfshopCollector.currentPage
    });
  } else if (request.action === 'getLinks') {
    sendResponse({
      links: ssfshopCollector.collectedLinks
    });
  } else if (request.action === 'resetCollection') {
    ssfshopCollector.resetCollection().then(() => {
      sendResponse({ status: 'reset' });
    });
    return true;
  } else if (request.action === 'extractCurrentPage') {
    ssfshopCollector.collectCurrentPage().then((count) => {
      sendResponse({
        links: ssfshopCollector.collectedLinks,
        count: count
      });
    });
    return true;
  } else if (request.action === 'scrollAndLoad') {
    ssfshopCollector.scrollToLoadAll().then(() => {
      sendResponse({ status: 'scrolled' });
    });
    return true;
  } else if (request.action === 'extractLinks') {
    const links = ssfshopCollector.extractProductLinks();
    const isLastPage = ssfshopCollector.checkIsLastPage();
    sendResponse({
      links: links,
      isLastPage: isLastPage
    });
  } else if (request.action === 'showComplete') {
    ssfshopCollector.collectedLinks = [];
    chrome.storage.local.get(['ssfshopLinks'], (result) => {
      ssfshopCollector.collectedLinks = result.ssfshopLinks || [];
      ssfshopCollector.showCompletionMessage();
    });
    sendResponse({ status: 'shown' });
  }
  return true;
});

// 페이지 로드 시 수집 중이었다면 계속 진행
async function initializeSSFShopCollector() {
  console.log('[SSF샵] 링크 수집기 초기화...');

  const progress = await ssfshopCollector.loadProgress();

  if (progress.ssfshopIsCollecting && progress.ssfshopKeyword) {
    const currentKeyword = new URLSearchParams(window.location.search).get('keyword') || '';

    if (progress.ssfshopKeyword === currentKeyword) {
      ssfshopCollector.currentPage = ssfshopCollector.getCurrentPageNumber();
      console.log(`[SSF샵] 수집 이어서 진행 (페이지 ${ssfshopCollector.currentPage})...`);
      setTimeout(() => {
        ssfshopCollector.continueCollection();
      }, 800);
    }
  }
}

// DOM이 준비되면 초기화
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeSSFShopCollector);
} else {
  initializeSSFShopCollector();
}

console.log(`[SSF샵] 링크 수집기 로드됨 (버전: ${SSFSHOP_COLLECTOR_VERSION})`);
