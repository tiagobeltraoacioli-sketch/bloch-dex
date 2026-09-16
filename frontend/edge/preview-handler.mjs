// Publish the latest preview without replacing the existing EVM app or APIs.
export function createPreviewWorker(base, assets) {
  return { async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!['blochdex.com','www.blochdex.com'].includes(url.hostname)) return base.fetch(request,env,ctx);
    if (url.pathname === '/preview' || url.pathname.startsWith('/preview/')) {
      if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
      if (url.pathname === '/preview') return new Response(null,{status:308,headers:{Location:'/preview/'}});
      const path = url.pathname === '/preview/' ? 'index.html' : url.pathname.slice('/preview/'.length);
      if (!Object.hasOwn(assets,path)) return new Response('Not found',{status:404});
      const asset=assets[path];
      const headers={'Content-Type':asset.type,'Cache-Control':path==='index.html'?'no-store':'public, max-age=31536000, immutable','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
      if(path==='index.html') headers['Content-Security-Policy']="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
      return new Response(request.method==='HEAD'?null:Uint8Array.from(atob(asset.base64),c=>c.charCodeAt(0)),{headers});
    }
    const response=await base.fetch(request,env,ctx);
    if(request.method!=='GET'||!['/','/index.html'].includes(url.pathname)||response.headers.get('X-Postern-Mobile-Hotfix')!=='1')return response;
    const headers=new Headers(response.headers);
    for(const key of ['Content-Length','Content-Encoding','ETag'])headers.delete(key);
    return new Response((await response.text()).replace('</head>','<meta name="postern-preview-page" content="/preview/">\n</head>'),{status:response.status,headers});
  }};
}
