# Bilibili browser transport: video comments (W5)

`bili_send_comment` is a **write** action. Its transport opens the official video comment UI; it does not construct or replay a comment API request. Other transports do not fall back to Chromium automatically. Browser permission and normal service write authorization are both required. There is no login, CAPTCHA solver, stealth mode, risk-token generator, or video submission action.

| Parameter | Contract |
| --- | --- |
| `oid` | Required video **aid**, a positive decimal ID (not a BV identifier or URL). Use strings for IDs; unsafe JSON numbers are rejected. |
| `message` | Required nonblank plain text, at most 1,000 UTF-16 code units; LF allowed, CR/NUL rejected. |
| `root` | Optional top-level comment rpid. Omit to post a new top-level comment. |
| `parent` | Optional actual reply target rpid, defaults to `root`. To reply to a child, supply its thread's `root` and the child's `parent`. |

Examples of **parameter shapes only**: `{"oid":"10","message":"top level"}`, `{"oid":"10","root":"20","message":"reply to thread"}`, `{"oid":"10","root":"20","parent":"30","message":"reply to child"}`. Unsupported: live rooms, dynamics, articles, arbitrary page URLs, attachments, or guessing a missing child by visible username or row position.

**Success:** `{rpid, oid, root, parent}` as decimal strings (`"0"` for absent thread IDs). The transport verifies the logged-in account first. It allows at most one matching official submission from the page and pairs its response to that specific request. HTTP success, API code zero and a positive reply ID are required; echoed reply details, if present, must agree. A click or optimistic UI render is not a receipt. Acceptance does not imply public visibility or moderation approval.

**Failure:** absent/ambiguous controls, a hidden comment, changed markup, an unsupported submission encoding or unexpected target fail closed. Only a visible uniquely identifiable reply row/editor is supported; this implementation does not paginate through threads. Authentication errors and challenges require manual review. After dispatch, a missing or inconsistent receipt gives `outcome: "unknown"`; inspect the account independently and **do not resend automatically**. Fatal authentication/challenge errors stop future writes on that transport instance. An unknown result does not automatically replay the attempt or disable unrelated later actions.

## Optional deployment dependency

The default Node transport needs no browser. For the optional browser transport, install a trusted Playwright release supporting `routeWebSocket` and `locator.filter({visible:true})` (1.51+), and its compatible Chromium build. For example, install `playwright` in the deployment with `npm install --no-save --package-lock=false playwright`, then `npx playwright install chromium` if a browser is not already provisioned. These are operator setup commands, not steps performed by the offline test. Do not install/run an untrusted driver path or pass driver/executable paths as action parameters.

Service configuration: `BILI_SELF_ID` and `BILI_COOKIE` (existing authorized session, including `SESSDATA` and `bili_jct`); optional `BILI_BROWSER_DRIVER_PATH` (absolute path to trusted local Playwright JS module entry, **not** chromedriver), `BILI_BROWSER_EXECUTABLE_PATH` (absolute Chromium executable). The factory `createBiliBrowser({selfId,cookie,driverPath,executablePath,headless=true})` returns `{comment,close}`; it reads no environment or credentials itself. Do not put cookies into examples, command histories or logs.

Chromium starts on the first authorized comment. Its process, memory footprint and cold-start latency are not incurred by ordinary HTTP actions. Only one comment may run at once. Each attempt uses a new nonpersistent context, never a personal or shared profile, and closes it after the attempt. Login cookies are scoped to the official www/API hosts, not to CDN hosts; HTTP, arbitrary URLs, service workers, and WebSockets are not transports. A clean disconnect may start a fresh process on the next eligible request; the interrupted operation is never automatically replayed. `close()` ends the owned process and disables the instance. Normal browser sandbox support on the host is required.

## Offline evidence, not live verification

`node --test test/bili-browser-actions.test.mjs` always tests the action/factory contract. Set `BILI_BROWSER_TEST_EXECUTABLE_PATH` to an existing Chromium binary to run the real-browser UI fixtures; optionally set `BILI_BROWSER_TEST_DRIVER_PATH` to a local Playwright module entry. With no test executable the Chromium cases are explicitly skipped. Test cases use synthetic account data, local HTML/open shadow DOM, and locally fulfilled request/response fixtures, with network name resolution blocked. No real login or mutation is required. These tests verify the control path and receipt checks, **not** compatibility with today's live UI.
