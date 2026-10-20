// The tiny built-in page behind `aos-orch login-link`. GET /auth/login never consumes the code (prefetch/CSRF safe): this page
// reads the code from the query string, removes it from the address bar, POSTs it to /auth/exchange (same origin) and then either
// redirects to the dashboard with the session token in the URL FRAGMENT (never the query, never a cookie) or shows it for manual use.
import crypto from 'node:crypto';

export function loginPage(dashboardUrl) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const dash = JSON.stringify(dashboardUrl).replace(/</g, '\\u003c');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>AOS control login</title>
<style nonce="${nonce}">body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#222;background:#fafafa}
code{background:#eee;padding:.1rem .3rem;border-radius:3px;word-break:break-all}@media(prefers-color-scheme:dark){body{color:#ddd;background:#181818}code{background:#333}}</style></head>
<body><h1>AOS control login</h1><p id="msg">Signing in&hellip;</p><p id="manual" hidden></p>
<script nonce="${nonce}">
(function(){
var msg=document.getElementById('msg'),manual=document.getElementById('manual'),dash=${dash};
var code=new URLSearchParams(location.search).get('code')||'';
try{history.replaceState(null,'',location.pathname)}catch(e){}
if(!/^[0-9a-f]{32}$/.test(code)){msg.textContent='This login link is missing its code. Run "aos-orch login-link" again.';return}
fetch('/auth/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code}),cache:'no-store',credentials:'omit'})
.then(function(r){return r.json().then(function(j){return{ok:r.ok,j:j}})})
.then(function(x){
 if(!x.ok||!x.j.token){msg.textContent='This login link is invalid, expired (2 minutes) or was already used. Run "aos-orch login-link" again.';return}
 var target=dash.replace(/#.*$/,'')+'#aos_token='+encodeURIComponent(x.j.token);
 msg.textContent='Signed in. Redirecting to the dashboard\\u2026';
 manual.hidden=false;manual.textContent='If nothing happens, open the dashboard and paste this session token (valid 12 hours, kept in memory by the server): ';
 var c=document.createElement('code');c.textContent=x.j.token;manual.appendChild(c);
 location.replace(target);
}).catch(function(){msg.textContent='Could not reach the control server.'});
})();
</script></body></html>`;
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return { html, csp };
}
