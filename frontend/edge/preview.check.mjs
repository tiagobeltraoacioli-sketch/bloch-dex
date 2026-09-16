import test from 'node:test';
import assert from 'node:assert/strict';
import {createPreviewWorker} from './preview-handler.mjs';
const assets={'index.html':{type:'text/html',base64:btoa('<main>Preview</main>')},'assets/app.js':{type:'text/javascript',base64:btoa('/* preview */')}};
test('preview serves only packaged assets, rejects writes and sets isolated CSP',async()=>{
 const worker=createPreviewWorker({fetch(){throw Error('Unexpected origin')}},assets);
 const request=(path,method='GET')=>new Request('https://blochdex.com'+path,{method});
 assert.equal((await worker.fetch(request('/preview'))).status,308);
 const page=await worker.fetch(request('/preview/'));assert.match(page.headers.get('content-security-policy'),/connect-src 'none'/);assert.equal(await page.text(),'<main>Preview</main>');
 assert.equal((await worker.fetch(request('/preview/src/wallet.ts'))).status,404);
 assert.equal((await worker.fetch(request('/preview/','POST'))).status,405);
 assert.equal(await(await worker.fetch(request('/preview/assets/app.js','HEAD'))).text(),'');
});
test('preview preserves existing API responses and only marks the verified shell',async()=>{
 for(const path of ['/rpc','/deployment.json','/assets/current.js','/l1/']){
  const response=new Response('existing');const worker=createPreviewWorker({fetch(){return response}},assets);
  assert.equal(await worker.fetch(new Request('https://blochdex.com'+path)),response);
 }
 const base={fetch(){return new Response('<head></head><body>existing</body>',{headers:{'X-Postern-Mobile-Hotfix':'1','Content-Type':'text/html'}})}};
 const response=await createPreviewWorker(base,assets).fetch(new Request('https://blochdex.com/'));
 assert.match(await response.text(),/postern-preview-page/);
});
