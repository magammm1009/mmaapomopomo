// 🔧 리로용 설정 파일
// POMO_APP_URL에는 Apps Script 웹앱 배포 주소(/exec)를 넣어 주세요.
// Google이 iframe 표시를 막는 날에는 GitHub PWA 외피가 자동으로 같은 창에서 뽀모를 열도록 보정합니다.

window.POMO_APP_CONFIG = {
  APP_NAME: '마끝마 뽀모',
  APP_SHORT_NAME: '뽀모',
  POMO_APP_URL: 'https://script.google.com/macros/s/AKfycbxNSpdWtv-rBcX__AFgFbdWEIWOQEM-4s0GHJCQKyw96w-0Q63K3zZzN2lzXSiQoNat/exec',
  THEME_COLOR: '#ffd1e8',

  // auto: iframe으로 먼저 열고, 차단되면 같은 창으로 자동 이동
  // redirect: 처음부터 같은 창으로 이동
  // iframe: iframe만 사용
  POMO_OPEN_MODE: 'auto',
  IFRAME_FALLBACK_MS: 2800
};
