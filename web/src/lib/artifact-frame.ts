/*
 * Prepares a published HTML artifact for the sandboxed preview iframe. Adapted from vercel-labs/fx0
 * (lib/design-artifact.ts: embedded CSP + bootstrap), Copyright Vercel, Inc. — Apache License 2.0
 * (see agents/html-designer/NOTICE).
 *
 * Isolation: the iframe gets sandbox="allow-scripts" without allow-same-origin, so the page runs on an
 * opaque origin with no access to the console's storage, cookies or DOM. The embedded CSP below blocks
 * every network request. The bootstrap reports heartbeats (a page that navigated itself away stops
 * sending them and is restored) and turns clicks on https links into requests the console confirms.
 */

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "manifest-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const DOCTYPE = "<!doctype html>";

export type FrameMessage =
  | { type: "heartbeat" | "ready" | "painted"; token: string }
  | { type: "open"; token: string; url: string };

function bootstrap(token: string): string {
  const heartbeat =
    `const token=${JSON.stringify(token)};const send=type=>parent.postMessage({type,token},"*");send("heartbeat");setInterval(()=>send("heartbeat"),500);` +
    `addEventListener("load",()=>{send("ready");requestAnimationFrame(()=>requestAnimationFrame(()=>send("painted")))},{once:true});` +
    `addEventListener("click",event=>{const link=event.target instanceof Element&&event.target.closest("a[href]");const url=link?link.getAttribute("href")||"":"";if(/^https:/i.test(url)){event.preventDefault();parent.postMessage({type:"open",token,url},"*")}},true);`;
  return `<script>(()=>{for(const name of ["RTCPeerConnection","webkitRTCPeerConnection","RTCIceGatherer"]){try{Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false})}catch{}}${heartbeat}})()</script>`;
}

function escapeAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** The CSP and bootstrap go right after the doctype, first in <head>. Without a doctype: not rendered. */
export function prepareArtifactHtml(html: string, token: string): string | null {
  const document = html.trim().replace(/^<!doctype\s+html\s*>/i, DOCTYPE);
  if (!document.startsWith(DOCTYPE)) return null;
  const csp = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(ARTIFACT_CSP)}">`;
  return DOCTYPE + csp + bootstrap(token) + document.slice(DOCTYPE.length);
}

/** Only plain https URLs may be opened, and only after the user confirms. */
export function safeLinkUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
