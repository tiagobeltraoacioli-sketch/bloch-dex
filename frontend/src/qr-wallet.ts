import { validAddress, walletDisplayName, type WalletOption, type Provider } from './wallet';
import type SignClientType from '@walletconnect/sign-client';
const projectId = 'e263eead656b6d61ecdee75a71e100bb';
let client: SignClientType | undefined;
let appkit: Awaited<ReturnType<typeof createModal>> | undefined;
const CHAIN = 'eip155:84001';
const CHAIN_HEX = '0x14821';
const METHODS = ['eth_accounts','eth_chainId'];
const EVENTS = ['accountsChanged','chainChanged'];

type SessionEvent = {topic?:unknown;params?:{chainId?:unknown;event?:{name?:unknown;data?:unknown}}};
type Namespace = {accounts?:unknown;chains?:unknown;methods?:unknown;events?:unknown};
type SessionUpdate = {topic?:unknown;params?:{namespaces?:{eip155?:Namespace}}};
function exactPermissionList(value:unknown,required:string[]) {
  return Array.isArray(value)&&value.length===required.length&&new Set(value).size===value.length&&required.every(item=>value.includes(item));
}
export function normalizeWalletNamespace(value:Namespace|undefined) {
  const accounts=value?.accounts,chains=value?.chains;
  if(!Array.isArray(accounts)||accounts.length<1||accounts.length>20||
    !accounts.every(account=>typeof account==='string'&&/^eip155:84001:0x[a-fA-F0-9]{40}$/.test(account))||
    (chains!==undefined&&(!Array.isArray(chains)||chains.length!==1||chains[0]!==CHAIN))||
    !exactPermissionList(value?.methods,METHODS)||!exactPermissionList(value?.events,EVENTS))return null;
  return {address:(accounts[0] as string).split(':')[2]};
}
export function normalizeWalletSessionEvent(message:SessionEvent,topic:string) {
  if(message?.topic!==topic)return null;
  const chain=message.params?.chainId,event=message.params?.event;
  if(chain!==CHAIN)return {disconnect:true,event:'chainChanged',value:chain};
  if(event?.name==='accountsChanged'){
    const accounts=event.data;
    if(!Array.isArray(accounts)||accounts.length<1||accounts.length>20||!accounts.every(validAddress))return {disconnect:true,event:'accountsChanged',value:[]};
    return {disconnect:false,event:'accountsChanged',value:[accounts[0]],address:accounts[0]};
  }
  if(event?.name==='chainChanged'){
    const value=event.data;
    let supported=false;
    try{supported=(typeof value==='string'&&value.length<=66&&/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)&&BigInt(value)===84001n);}catch{}
    return supported?{disconnect:false,event:'chainChanged',value:CHAIN_HEX}:{disconnect:true,event:'chainChanged',value};
  }
  return null;
}
export function normalizeWalletSessionUpdate(message:SessionUpdate,topic:string,currentAddress:string) {
  if(message?.topic!==topic)return null;
  const namespace=normalizeWalletNamespace(message.params?.namespaces?.eip155);
  if(!namespace)return {disconnect:true,event:'accountsChanged',value:[]};
  const {address}=namespace;
  return address.toLowerCase()===currentAddress.toLowerCase()?null:{disconnect:false,event:'accountsChanged',value:[address],address};
}
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
  const {uri,approval} = await c.connect({requiredNamespaces:{eip155:{chains:[CHAIN],methods:METHODS,events:EVENTS}}});
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
    const approvedNamespace=normalizeWalletNamespace(session.namespaces.eip155);
    const now=Math.floor(Date.now()/1000);
    if(!approvedNamespace||!Number.isSafeInteger(session.expiry)||session.expiry<=now||session.expiry>now+604800) {await c.disconnect({topic:session.topic,reason:{code:6000,message:'Unsupported session'}});throw Error('Wallet returned an unsupported session');}
    let address=approvedNamespace.address;
    let active=true;
    const listeners=new Map<string,Set<(...args:unknown[])=>void>>();
    const emit=(event:string,...args:unknown[])=>listeners.get(event)?.forEach(fn=>fn(...args));
    const deleted=({topic}:{topic:string})=>{if(topic===session.topic){active=false;emit('disconnect');}};
    const changed=(message:SessionEvent)=>{
      const update=normalizeWalletSessionEvent(message,session.topic);if(!update)return;
      if('address' in update&&typeof update.address==='string')address=update.address;
      if(update.disconnect)active=false;
      emit(update.event,update.value);
      if(update.disconnect)void c.disconnect({topic:session.topic,reason:{code:6000,message:'Unsupported session update'}}).catch(()=>{});
    };
    const updated=(message:SessionUpdate)=>{
      const update=normalizeWalletSessionUpdate(message,session.topic,address);if(!update)return;
      if('address' in update&&typeof update.address==='string')address=update.address;
      if(update.disconnect)active=false;
      emit(update.event,update.value);
      if(update.disconnect)void c.disconnect({topic:session.topic,reason:{code:6000,message:'Unsupported session update'}}).catch(()=>{});
    };
    c.on('session_delete',deleted);c.on('session_expire',deleted);
    c.on('session_event',changed);c.on('session_update',updated);
    const provider:Provider={
      async request({method}) {
        if(!active || session.expiry*1000<=Date.now())throw Error('Session expired');
        if(method==='eth_requestAccounts'||method==='eth_accounts')return [address];
        if(method==='eth_chainId')return CHAIN_HEX;
        throw Error('This DEX preview requests account access only. Transactions require a verified deployment.');
      },
      on(event,fn){if(!listeners.has(event))listeners.set(event,new Set());listeners.get(event)!.add(fn);},
      removeListener(event,fn){listeners.get(event)?.delete(fn);},
      disconnect(){active=false;c.off('session_delete',deleted);c.off('session_expire',deleted);c.off('session_event',changed);c.off('session_update',updated);void c.disconnect({topic:session.topic,reason:{code:6000,message:'User disconnected'}}).catch(()=>{});}
    };
    await appkit.close();
    return {id:'postern-walletconnect',name:walletDisplayName(session.peer.metadata.name,'Mobile wallet'),provider};
  } finally {unsubscribe();signal.removeEventListener('abort',cancel);await appkit.close();}
}
