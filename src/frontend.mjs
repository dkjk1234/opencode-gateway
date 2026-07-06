export function renderLoginPage({
  publicBaseUrl,
  oauth,
  userCode = "",
  error = "",
  devApprovalEnabled = false,
}) {
  const normalizedCode = normalizeUserCode(userCode)
  const oauthEnabled = Boolean(oauth?.enabled)
  const startUrl = `${publicBaseUrl}/auth/oauth/start?user_code=${encodeURIComponent(normalizedCode)}`
  const activateUrl = `${publicBaseUrl}/activate`
  const manualForm = devApprovalEnabled
    ? `<details class="dev-approval">
        <summary>개발용 토큰으로 승인</summary>
        <form method="post" action="${activateUrl}${normalizedCode ? `?user_code=${encodeURIComponent(normalizedCode)}` : ""}" class="manual-form">
          <input type="hidden" name="user_code" value="${escapeHtml(normalizedCode)}" />
          <label>
            <span>Account token</span>
            <input name="token" value="" placeholder="dev-token" autocomplete="off" />
          </label>
          <button type="submit" class="secondary-button">수동 승인</button>
        </form>
      </details>`
    : ""

  return pageShell({
    title: "CodexShare 로그인",
    body: `
      <section class="hero-card">
        <div class="brand-row">
          <div class="brand-mark">C</div>
          <div>
            <p class="eyebrow">OpenCode Gateway</p>
            <h1>CodexShare에 로그인</h1>
          </div>
        </div>

        <p class="lede">
          Google 계정으로 로그인하면 OpenCode 데스크톱의 기기 코드가 승인되고,
          이후 요청은 이 gateway에서 크레딧 기준으로 처리됩니다.
        </p>

        ${error ? `<div class="alert">${escapeHtml(error)}</div>` : ""}

        <form method="get" action="${activateUrl}" class="code-form">
          <label for="user_code">OpenCode에 표시된 승인 코드</label>
          <div class="code-row">
            <input id="user_code" name="user_code" value="${escapeHtml(normalizedCode)}" placeholder="예: ABCD-EFGH" autocomplete="one-time-code" />
            <button type="submit" class="secondary-button">코드 확인</button>
          </div>
          <p class="hint">데스크톱 앱에서 로그인/연결을 누르면 이 코드가 자동으로 들어온 링크가 열립니다.</p>
        </form>

        <div class="oauth-panel">
          ${
            oauthEnabled && normalizedCode
              ? `<a class="google-button" href="${startUrl}" aria-label="Google로 계속하기">
                  <span class="google-icon" aria-hidden="true">${googleIcon()}</span>
                  <span>Google로 계속하기</span>
                </a>`
              : `<button class="google-button disabled" type="button" disabled>
                  <span class="google-icon" aria-hidden="true">${googleIcon()}</span>
                  <span>${oauthEnabled ? "승인 코드를 먼저 입력하세요" : "Google OAuth 설정 필요"}</span>
                </button>`
          }
          <p class="hint">
            Google OAuth 콜백:
            <code>${escapeHtml(oauth?.redirect_uri || `${publicBaseUrl}/auth/oauth/callback`)}</code>
          </p>
        </div>

        ${manualForm}
      </section>

      <section class="side-card">
        <h2>유지보수 원칙</h2>
        <ul>
          <li>OpenCode 데스크톱 UI는 최대한 원본 유지</li>
          <li>로그인/계정/크레딧 화면은 gateway 웹 프론트에서 관리</li>
          <li>결제사는 나중에 Toss/PortOne/수동충전 adapter로 교체 가능</li>
        </ul>
      </section>
    `,
  })
}

export function renderOAuthSuccessPage({ publicBaseUrl, email }) {
  return pageShell({
    title: "로그인 완료",
    body: `
      <section class="hero-card centered">
        <div class="success-mark">✓</div>
        <p class="eyebrow">Google OAuth 승인 완료</p>
        <h1>OpenCode 연결이 완료됐습니다</h1>
        <p class="lede">
          ${escapeHtml(email || "Google 계정")} 계정이 CodexShare에 연결됐습니다.
          이제 OpenCode 데스크톱으로 돌아가면 자동으로 토큰을 받아옵니다.
        </p>
        <div class="actions">
          <a class="secondary-link" href="${publicBaseUrl}/login">다른 기기 코드로 로그인</a>
        </div>
      </section>
    `,
  })
}

export function renderOAuthErrorPage({ publicBaseUrl, code, message }) {
  return pageShell({
    title: "로그인 실패",
    body: `
      <section class="hero-card centered">
        <div class="error-mark">!</div>
        <p class="eyebrow">Google OAuth 오류</p>
        <h1>로그인을 완료하지 못했습니다</h1>
        <p class="lede">${escapeHtml(message || "OAuth 처리 중 오류가 발생했습니다.")}</p>
        ${code ? `<p class="hint">오류 코드: <code>${escapeHtml(code)}</code></p>` : ""}
        <div class="actions">
          <a class="google-button compact" href="${publicBaseUrl}/login">로그인 다시 시도</a>
        </div>
      </section>
    `,
  })
}

export function renderBillingReturnPage({ title, message, sessionID }) {
  return pageShell({
    title,
    body: `
      <section class="hero-card centered">
        <p class="eyebrow">Billing</p>
        <h1>${escapeHtml(title)}</h1>
        <p class="lede">${escapeHtml(message)}</p>
        ${sessionID ? `<p class="hint">Checkout session: <code>${escapeHtml(sessionID)}</code></p>` : ""}
      </section>
    `,
  })
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char])
}

function normalizeUserCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
}

function pageShell({ title, body }) {
  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)} · CodexShare</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7fb;
      --card: rgba(255,255,255,.88);
      --text: #121316;
      --muted: #667085;
      --line: #e5e7eb;
      --accent: #1f5eff;
      --accent-strong: #1649cf;
      --danger: #c2410c;
      --ok: #0f9f6e;
      --shadow: 0 24px 80px rgba(15,23,42,.12);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      min-height: 100vh;
      margin: 0;
      color: var(--text);
      background:
        radial-gradient(circle at 20% 20%, rgba(31,94,255,.16), transparent 28rem),
        radial-gradient(circle at 85% 10%, rgba(15,159,110,.13), transparent 24rem),
        var(--bg);
    }
    main {
      width: min(1060px, calc(100% - 32px));
      min-height: 100vh;
      margin: 0 auto;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 320px;
      gap: 24px;
      align-items: center;
      padding: 48px 0;
    }
    .hero-card, .side-card {
      background: var(--card);
      border: 1px solid rgba(255,255,255,.75);
      border-radius: 28px;
      box-shadow: var(--shadow);
      backdrop-filter: blur(18px);
    }
    .hero-card { padding: clamp(28px, 5vw, 56px); }
    .side-card { padding: 28px; }
    .centered { max-width: 680px; margin: 0 auto; text-align: center; grid-column: 1 / -1; }
    .brand-row { display: flex; align-items: center; gap: 16px; margin-bottom: 28px; }
    .brand-mark {
      width: 48px; height: 48px; border-radius: 14px;
      display: grid; place-items: center;
      background: linear-gradient(135deg, #ff7a1a, #ffb86b);
      color: #1b1006; font-weight: 800;
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.35);
    }
    .eyebrow {
      margin: 0 0 6px;
      color: var(--accent);
      font-size: 13px;
      font-weight: 700;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    h1 { margin: 0; font-size: clamp(32px, 5vw, 54px); line-height: 1.02; letter-spacing: -.04em; }
    h2 { margin: 0 0 14px; font-size: 18px; }
    .lede { margin: 22px 0 0; color: var(--muted); font-size: 17px; line-height: 1.7; }
    .code-form { margin-top: 34px; }
    label { display: block; margin-bottom: 10px; color: #344054; font-size: 14px; font-weight: 700; }
    .code-row { display: flex; gap: 10px; }
    input {
      width: 100%;
      height: 48px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0 15px;
      background: #fff;
      color: var(--text);
      font: inherit;
      outline: none;
    }
    input:focus { border-color: var(--accent); box-shadow: 0 0 0 4px rgba(31,94,255,.12); }
    .secondary-button, .secondary-link {
      height: 48px;
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 0 18px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #fff;
      color: var(--text);
      font-weight: 700;
      text-decoration: none;
      white-space: nowrap;
      cursor: pointer;
    }
    .oauth-panel {
      margin-top: 22px;
      padding: 18px;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(248,250,252,.8);
    }
    .google-button {
      width: 100%;
      height: 54px;
      border: 0;
      border-radius: 15px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 12px;
      background: var(--accent);
      color: white;
      font-weight: 800;
      text-decoration: none;
      cursor: pointer;
      box-shadow: 0 12px 26px rgba(31,94,255,.24);
    }
    .google-button:hover { background: var(--accent-strong); }
    .google-button.disabled { background: #cbd5e1; color: #64748b; box-shadow: none; cursor: not-allowed; }
    .google-button.compact { width: auto; padding: 0 22px; }
    .google-icon {
      width: 22px;
      height: 22px;
      border-radius: 999px;
      display: grid;
      place-items: center;
      background: white;
    }
    .hint { margin: 10px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
    code {
      padding: 2px 6px;
      border-radius: 7px;
      background: #eef2ff;
      color: #3442a8;
      word-break: break-all;
    }
    .alert {
      margin-top: 22px;
      padding: 12px 14px;
      border: 1px solid #fed7aa;
      border-radius: 14px;
      background: #fff7ed;
      color: var(--danger);
      font-weight: 700;
    }
    .dev-approval { margin-top: 18px; color: var(--muted); }
    .dev-approval summary { cursor: pointer; font-weight: 700; }
    .manual-form { margin-top: 14px; display: grid; gap: 10px; }
    .success-mark, .error-mark {
      width: 66px; height: 66px; margin: 0 auto 20px; border-radius: 22px;
      display: grid; place-items: center; color: #fff; font-size: 36px; font-weight: 900;
    }
    .success-mark { background: var(--ok); }
    .error-mark { background: var(--danger); }
    .actions { margin-top: 26px; }
    ul { margin: 0; padding-left: 20px; color: var(--muted); line-height: 1.8; }
    @media (max-width: 860px) {
      main { grid-template-columns: 1fr; align-items: start; padding-top: 28px; }
      .side-card { order: 2; }
      .code-row { flex-direction: column; }
      .secondary-button { width: 100%; }
    }
  </style>
</head>
<body>
  <main>${body}</main>
</body>
</html>`
}

function googleIcon() {
  return `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
    <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"/>
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38z"/>
  </svg>`
}
