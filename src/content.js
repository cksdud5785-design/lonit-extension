/**
 * Content Script — 무신사 페이지에서 실행
 * 현재 페이지 정보를 background로 전달
 */

// 현재 페이지가 무신사인지 확인하고 URL 정보 전달
chrome.runtime.sendMessage({
  type: 'PAGE_INFO',
  url: window.location.href,
  title: document.title,
});
