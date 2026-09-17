import type { WalletOption, Provider } from './wallet';
import type SignClientType from '@walletconnect/sign-client';
const projectId = 'e263eead656b6d61ecdee75a71e100bb';
let client: SignClientType | undefined;
let appkit: Awaited<ReturnType<typeof createModal>> | undefined;
async function createModal() {
  const { createAppKit } = await import('@reown/appkit/core');
  const { defineChain } = await import('@reown/appkit/networks');
  return createAppKit({
    projectId, manualWCControl: true,
    networks: [defineChain({ id: 84001, chainNamespace:'eip155', caipNetworkId:'eip155:84001', name: 'Bloch L2 experimental testnet', nativeCurrency: {name:'Test Ether',symbol:'ETH',decimals:18}, rpcUrls:{default:{http:['https://blochdex.com/rpc']}}, testnet:true })],
    metadata: {name:'Postern DEX',description:'Connect an account to the DEX preview',url:location.origin,icons:[]},
    themeMode:'dark', themeVariables:{'--w3m-accent':'#c6f779','--w3m-border-radius-master':'3px'},
    features:{analytics:false,email:false,socials:false,swaps:false,onramp:false},
  });
}
export async function connectQrWallet(signal: AbortSignal): Promise<WalletOption> {
  const { default: SignClient } = await import('@walletconnect/sign-client');
  if(signal.aborted) throw Error('Connection cancelled');
  client ??= await SignClient.init({projectId,metadata:{name:'Postern DEX',description:'Account connection only; trading preview',url:location.origin,icons:[]},telemetryEnabled:false,logger:'silent'});
  const c=client;
  appkit ??= await createModal();
  if(signal.aborted) throw Error('Connection cancelled');
  const {uri,approval} = await c.connect({requiredNamespaces:{eip155:{chains:['eip155:84001'],methods:['eth_accounts','eth_chainId'],events:['accountsChanged','chainChanged']}}});
  if(!uri) throw Error('No pairing QR returned');
  await appkit.open({uri});
  let cancelled: boolean=Boolean(signal.aborted);
  let rejectCancelled: (error:Error)=>void = ()=>{};
  const cancellation = new Promise<never>((_,reject)=>{rejectCancelled=reject;});
  const cancel=()=>{cancelled=true;rejectCancelled(Error('Connection cancelled'));void appkit?.close();};
  signal.addEventListener('abort',cancel,{once:true});
  const unsubscribe=appkit.subscribeState(state=>{if(!state.open)cancel();});
  const approved=approval();
  void approved.then(session=>{if(cancelled)void c.disconnect({topic:session.topic,reason:{code:6000,message:'Connection cancelled'}}).catch(()=>{});},()=>{});
  try {
    const session=await Promise.race([approved,cancellation]);
    unsubscribe();
    if(cancelled || signal.aborted) {await c.disconnect({topic:session.topic,reason:{code:6000,message:'Connection cancelled'}});throw Error('Connection cancelled');}
    const caip=session.namespaces.eip155?.accounts.find(a=>/^eip155:84001:0x[a-fA-F0-9]{40}$/.test(a));
    if(!caip) {await c.disconnect({topic:session.topic,reason:{code:6000,message:'Unsupported account'}});throw Error('Wallet returned an unsupported account');}
    const address=caip.split(':')[2];
    let active=true;
    const listeners=new Map<string,Set<(...args:unknown[])=>void>>();
    const emit=(event:string,...args:unknown[])=>listeners.get(event)?.forEach(fn=>fn(...args));
    const deleted=({topic}:{topic:string})=>{if(topic===session.topic){active=false;emit('disconnect');}};
    c.on('session_delete',deleted);c.on('session_expire',deleted);
    const provider:Provider={
      async request({method}) {
        if(!active || session.expiry*1000<=Date.now())throw Error('Session expired');
        if(method==='eth_requestAccounts'||method==='eth_accounts')return [address];
        if(method==='eth_chainId')return '0x14821';
        throw Error('This DEX preview requests account access only. Transactions require a verified deployment.');
      },
      on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},
      removeListener(event,fn){listeners.get(event)?.delete(fn);},
      disconnect(){active=false;c.off('session_delete',deleted);c.off('session_expire',deleted);void c.disconnect({topic:session.topic,reason:{code:6000,message:'User disconnected'}}).catch(()=>{});}
    };
    await appkit.close();
    return {id:'postern-walletconnect',name:session.peer.metadata.name.slice(0,60)||'Mobile wallet',provider};
  } finally {unsubscribe();signal.removeEventListener('abort',cancel);await appkit.close();}
}
